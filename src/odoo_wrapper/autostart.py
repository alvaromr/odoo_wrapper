"""Start the dashboard at login: what `odoo-dashboard --autostart on|off` registers on each system.

- Each system's own per-user mechanism, nothing that needs an administrator: a LaunchAgent on macOS, a
  `systemd --user` unit on Linux (any system that is neither of the other two), a value under HKCU's Run key
  on Windows. Only macOS has run it; Linux and Windows are supported by reading.
- The entry runs process.launch_command() with no arguments: the interpreter running now, so the same entry
  serves a copy of the repo and an install made with uv. On Windows it is the pythonw.exe beside it, so no
  console window opens. Running `on` again rewrites the entry, which follows the interpreter after a
  reinstall.
- `on` also starts the dashboard now, through the same mechanism (launchctl bootstrap, systemctl restart, a
  detached process on Windows). With another dashboard already listening the new one refuses the port and
  exits, as any second instance does; that is why nothing asks the system to keep it alive, which would
  relaunch it in a loop.
- A dashboard the entry already started is replaced, not left running: macOS boots the job out first and
  Linux restarts the unit. launchd may still be letting go of the job when bootout returns, and a bootstrap
  right then failed (seen switching installs: the old dashboard stopped, no new one, and `on` said it had
  started), so it is tried for up to BOOTSTRAP_TRIES × BOOTSTRAP_PAUSE seconds and a last failure is an error.
  `on` is also what moves the entry to a new install: it names the interpreter, and the source watcher only
  restarts the running process, with its old command line. Windows keeps no handle on the process it
  started, so there it only takes over at the next login.
- `off` only removes the entry: the dashboard running keeps going until it is stopped or the session ends.
- ExecStart in a systemd unit is not a shell line: quotes, backslashes, `%` and `$` mean something to systemd
  itself, hence SYSTEMD_ESCAPES on each argument.
"""

import os
import plistlib
import subprocess
import sys
import time
from contextlib import suppress

from .process import launch_command

LABEL = "com.github.alvaromr.odoo-dashboard"
UNIT = "odoo-dashboard.service"
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
RUN_VALUE = "odoo-dashboard"
SYSTEMD_ESCAPES = str.maketrans({"\\": "\\\\", '"': '\\"', "%": "%%", "$": "$$"})
BOOTSTRAP_TRIES = 20
BOOTSTRAP_PAUSE = 0.25


def command():
    quiet = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
    return launch_command(executable=quiet if sys.platform == "win32" and os.path.exists(quiet) else None)


def launch_agent():
    return os.path.join(os.path.expanduser("~"), "Library", "LaunchAgents", f"{LABEL}.plist")


def unit_file():
    config = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(config, "systemd", "user", UNIT)


def write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(content)


def remove(path):
    with suppress(FileNotFoundError):
        os.remove(path)


def systemctl(*args, check=True):
    subprocess.run(["systemctl", "--user", *args], check=check)


def mac_on():
    write(launch_agent(), plistlib.dumps({"Label": LABEL, "ProgramArguments": command(), "RunAtLoad": True}))
    session = f"gui/{os.getuid()}"
    subprocess.run(["launchctl", "bootout", f"{session}/{LABEL}"], capture_output=True)
    bootstrap = ["launchctl", "bootstrap", session, launch_agent()]
    for _ in range(BOOTSTRAP_TRIES - 1):
        if subprocess.run(bootstrap, capture_output=True).returncode == 0:
            return
        time.sleep(BOOTSTRAP_PAUSE)
    subprocess.run(bootstrap, capture_output=True, check=True)


def mac_off():
    remove(launch_agent())


def linux_on():
    exec_start = " ".join(f'"{arg.translate(SYSTEMD_ESCAPES)}"' for arg in command())
    write(unit_file(), (
        "[Unit]\nDescription=Odoo dashboard\n\n"
        f"[Service]\nExecStart={exec_start}\n\n"
        "[Install]\nWantedBy=default.target\n"
    ).encode())
    systemctl("daemon-reload")
    systemctl("enable", UNIT)
    systemctl("restart", UNIT)


def linux_off():
    if os.path.exists(unit_file()):
        systemctl("disable", UNIT, check=False)
        remove(unit_file())


def run_key(winreg):
    return winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE)


def windows_on():
    import winreg
    with run_key(winreg) as key:
        winreg.SetValueEx(key, RUN_VALUE, 0, winreg.REG_SZ, subprocess.list2cmdline(command()))
    subprocess.Popen(command(), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def windows_off():
    import winreg
    with run_key(winreg) as key, suppress(FileNotFoundError):
        winreg.DeleteValue(key, RUN_VALUE)


SYSTEMS = {"darwin": (mac_on, mac_off), "win32": (windows_on, windows_off)}


def set_autostart(enabled):
    on, off = SYSTEMS.get(sys.platform, (linux_on, linux_off))
    (on if enabled else off)()
