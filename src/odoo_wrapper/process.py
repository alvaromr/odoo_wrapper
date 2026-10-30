"""Process plumbing of the dashboard: its log, the self-restart on source or network changes, the port check.

- Editing any .py of the package restarts the server by itself: a watcher compares mtimes every
  WATCH_INTERVAL seconds and re-execs launch_command() with the same arguments (minus --open), same PID and
  ports. Never kill and relaunch it by hand; that is how duplicate stale instances appear. A file that
  vanishes counts as changed: switching an install to an editable one deletes the files it runs from, and
  the server kept running, answering every page with an error. On Windows execv
  cannot replace the process, so restart() spawns the child with ODOO_DASHBOARD_RESTART=1 and exits, and the
  child waits up to RESTART_GRACE seconds for the ports to free instead of refusing them as "another
  instance". Untested on a real Windows machine.
- launch_command() is how the dashboard is started from outside a launcher, here and by autostart.py: the
  interpreter running now with a one-line bootstrap that puts the package's folder first on sys.path, as the
  launchers in bin/ do. It runs the same from a copy of the repo and from an install made with uv, with no
  environment variable, which a login entry cannot always carry.
- The same watcher polls the network identity the caller hands it (name and LAN IP) every NET_INTERVAL
  seconds and restarts on a change, so the phone certificate follows DHCP changes and renames.
- It refuses to start when something already listens on the port. Never patch the ports to dodge that: a
  stale instance once survived 13 days on another port serving outdated code. Find the process holding the
  port instead (lsof -nP -iTCP:8931 -sTCP:LISTEN; ss -ltnp on Linux; netstat -ano on Windows). It may be an
  installed copy started at login (autostart.py), which follows its own files, not the repo's: its command
  line names the folder it runs from. Installing over it restarts it like an edit; AGENTS.md § Installing
  for development makes it run the working copy.
- Never pipe it into `python3 -`: a stdin heredoc breaks the self-restart, which re-execs an empty stdin.
- The log is the package's logger, which own_the_output() points at stdout: every message carries a timestamp
  and a level, INFO for what happens, WARNING for a failure the dashboard works around (no GitHub, no
  certificate), ERROR for one that leaves something undone, with the traceback of an unexpected one. What only
  answers a command (--help, --autostart) is printed, not logged.
- Started without a terminal it points stdout and stderr at ~/.odoo_dashboard/dashboard.log itself (set
  aside as .1 past LOG_MAX at the next start), so restarts, launchers and shells cannot decide the
  destination, and whatever a crash prints lands there too. Under pythonw.exe (Windows, started at login)
  there are no streams at all, so the log takes their place. A background launch once inherited a log path in
  another project's scratchpad and the restarts carried that descriptor for days.
- «Actualizar ahora» (updates.py) holds the watcher while uv replaces the install, so a half-written folder
  never restarts anything, and then restarts into the new install itself: its interpreter, with a bootstrap
  that imports the package installed there instead of putting this copy's folder first, and UPDATED_ENV,
  which tells the new process to move the login entry to itself (autostart.follow).
- source_version is the newest mtime across the package and its templates; a page on localhost polls it and
  reloads when it moves, so an edit needs no manual refresh.
"""

import logging
import os
import socket
import subprocess
import sys
import threading
import time

from odoo_wrapper.client import STATE_DIR

HERE = os.path.dirname(os.path.abspath(__file__))
INSTALLED_BOOTSTRAP = "from odoo_wrapper.dashboard import main; main()"
BOOTSTRAP = f"import sys; sys.path.insert(0, {os.path.dirname(HERE)!r}); {INSTALLED_BOOTSTRAP}"
TEMPLATES = os.path.join(HERE, "templates")
WATCHED = [os.path.join(HERE, name) for name in sorted(os.listdir(HERE)) if name.endswith(".py")]
SOURCES = WATCHED + sorted(os.path.join(folder, name) for folder, _, names in os.walk(TEMPLATES) for name in names)
LOG_FILE = os.path.join(STATE_DIR, "dashboard.log")
LOG_MAX = 1_000_000
LOG_FORMAT = "%(asctime)s %(levelname)s %(message)s"
LOG_DATE = "%Y-%m-%d %H:%M:%S"
WATCH_INTERVAL = 2
NET_INTERVAL = 30
RESTART_ENV = "ODOO_DASHBOARD_RESTART"
UPDATED_ENV = "ODOO_DASHBOARD_UPDATED"
RESTART_GRACE = 5
log = logging.getLogger(__name__)
_held = threading.Event()


def own_the_output():
    try:
        terminal = sys.stdout.isatty()
    except (AttributeError, ValueError):
        terminal = False  # pragma: no mutate - None is as false as False
    if not terminal:
        write_to_the_log_file()
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter(LOG_FORMAT, LOG_DATE))
    package = logging.getLogger(__package__)
    package.handlers = [handler]
    package.setLevel(logging.INFO)


def write_to_the_log_file():
    os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
    if os.path.exists(LOG_FILE) and os.path.getsize(LOG_FILE) > LOG_MAX:
        os.replace(LOG_FILE, LOG_FILE + ".1")
    file = open(LOG_FILE, "a", buffering=1)
    if sys.stdout is None:
        sys.stdout = sys.stderr = file
        return
    for stream in (sys.stdout, sys.stderr):
        os.dup2(file.fileno(), stream.fileno())


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
        if _held.is_set():
            continue
        current = stamps()
        changed = [p for p, t in initial.items() if current.get(p) != t]
        if changed:
            reason = f"Cambio en {', '.join(os.path.basename(p) for p in changed)}"
        else:
            if time.monotonic() - checked_net < NET_INTERVAL:
                continue
            checked_net = time.monotonic()
            if net_identity() == net:
                continue
            reason = "Cambio de red"
        log.info(f"{reason}: reiniciando…")
        restart(relaunch_args())


def relaunch_args():
    return [a for a in sys.argv[1:] if a != "--open"]


def launch_command(args=(), executable=None):
    return [executable or sys.executable, "-c", BOOTSTRAP, *args]


def hold():
    _held.set()


def release():
    _held.clear()


def restart(args, installed=None):
    command = [installed, "-c", INSTALLED_BOOTSTRAP, *args] if installed else launch_command(args)
    env = {**os.environ, **({UPDATED_ENV: "1"} if installed else {})}
    if sys.platform != "win32":
        os.execve(command[0], command, env)
    subprocess.Popen(command, env={**env, RESTART_ENV: "1"})
    os._exit(0)
