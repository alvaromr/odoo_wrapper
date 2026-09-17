"""Process plumbing of the dashboard: its log, the self-restart on source or network changes, the port check.

- Editing any .py of the package restarts the server by itself: a watcher compares mtimes every
  WATCH_INTERVAL seconds and re-execs `python -m odoo_wrapper.dashboard` with the same arguments (minus
  --open), same PID and ports. Never kill and relaunch it by hand; that is how duplicate stale instances
  appear. On Windows execv cannot replace the process, so restart() spawns the child with
  ODOO_DASHBOARD_RESTART=1 and exits, and the child waits up to RESTART_GRACE seconds for the ports to free
  instead of refusing them as "another instance". Untested on a real Windows machine.
- The same watcher polls the network identity the caller hands it (name and LAN IP) every NET_INTERVAL
  seconds and restarts on a change, so the phone certificate follows DHCP changes and renames.
- It refuses to start when something already listens on the port. Never patch the ports to dodge that: a
  stale instance once survived 13 days on another port serving outdated code. Find the process holding the
  port instead (lsof -nP -iTCP:8931 -sTCP:LISTEN; ss -ltnp on Linux; netstat -ano on Windows).
- Never pipe it into `python3 -`: a stdin heredoc breaks the self-restart, which re-execs an empty stdin.
- Started without a terminal it points stdout and stderr at ~/.odoo_dashboard/dashboard.log itself (set
  aside as .1 past LOG_MAX at the next start; every message carries a timestamp), so restarts, launchers and
  shells cannot decide the destination. A background launch once inherited a log path in another project's
  scratchpad and the restarts carried that descriptor for days.
- source_version is the newest mtime across the package and its templates; a page on localhost polls it and
  reloads when it moves, so an edit needs no manual refresh.
"""

import os
import socket
import subprocess
import sys
import time
from datetime import datetime

from .client import STATE_DIR

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATES = os.path.join(HERE, "templates")
WATCHED = [os.path.join(HERE, name) for name in sorted(os.listdir(HERE)) if name.endswith(".py")]
SOURCES = WATCHED + sorted(
    os.path.join(folder, name) for folder, _, names in os.walk(TEMPLATES) for name in names
)
LOG_FILE = os.path.join(STATE_DIR, "dashboard.log")
LOG_MAX = 1_000_000
WATCH_INTERVAL = 2
NET_INTERVAL = 30
RESTART_ENV = "ODOO_DASHBOARD_RESTART"
RESTART_GRACE = 5


def say(message):
    print(f"{datetime.now().astimezone():%Y-%m-%d %H:%M:%S} {message}", flush=True)


def own_the_output():
    try:
        if sys.stdout.isatty():
            return
    except (AttributeError, ValueError):
        pass
    os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
    if os.path.exists(LOG_FILE) and os.path.getsize(LOG_FILE) > LOG_MAX:
        os.replace(LOG_FILE, LOG_FILE + ".1")
    log = open(LOG_FILE, "a", buffering=1)
    for stream in (sys.stdout, sys.stderr):
        os.dup2(log.fileno(), stream.fileno())


def source_version():
    return max((os.path.getmtime(p) for p in SOURCES if os.path.exists(p)), default=0)


def stamps():
    marks = {}
    for path in WATCHED:
        try:
            marks[path] = os.path.getmtime(path)
        except OSError:
            pass
    return marks


def port_taken(port, grace=0, host="127.0.0.1"):
    deadline = time.monotonic() + grace
    while True:
        with socket.socket() as sock:
            sock.settimeout(0.3)
            taken = sock.connect_ex((host, port)) == 0
        if not taken or time.monotonic() >= deadline:
            return taken
        time.sleep(0.2)


def watch_sources(net_identity=lambda: ""):
    initial, net, checked_net = stamps(), net_identity(), time.monotonic()
    while True:
        time.sleep(WATCH_INTERVAL)
        changed = [p for p, t in stamps().items() if initial.get(p, t) != t]
        if changed:
            reason = f"Cambio en {', '.join(os.path.basename(p) for p in changed)}"
        else:
            if time.monotonic() - checked_net < NET_INTERVAL:
                continue
            checked_net = time.monotonic()
            if net_identity() == net:
                continue
            reason = "Cambio de red"
        say(f"{reason}: reiniciando…")
        restart([a for a in sys.argv[1:] if a != "--open"])


def restart(args):
    command = [sys.executable, "-m", "odoo_wrapper.dashboard", *args]
    if sys.platform != "win32":
        os.execv(sys.executable, command)
    subprocess.Popen(command, env={**os.environ, RESTART_ENV: "1"})
    os._exit(0)
