"""Whether a newer release of the package is out on GitHub, for the pages' update banner, and installing it.

- The version is __version__ in the package's __init__.py, the one place it is written (pyproject.toml reads
  it from there), so every copy knows its own whatever installed it: uv from GitHub, the editable install of
  AGENTS.md, or no install at all with the launchers in bin/. Reading what the installer recorded instead
  (direct_url.json) left the editable install and bin/ with nothing to compare.
- check() asks GitHub for the repository's latest release (drafts and pre-releases never are) and compares its
  tag, vX.Y.Z, with that version as numbers: only a higher one is an update, so a working copy ahead of the
  last release asks for nothing. uv installs main, not the release, which is why every push to main is a
  release (AGENTS.md § Releasing): a push without one reaches nobody's banner.
- GitHub allows 60 calls an hour per IP without a token, shared by every machine behind the same address,
  so an answer is kept CHECK_TTL and a forced check («Buscar ahora» in «Ajustes») reuses one younger than
  FRESH_MIN. Checks never overlap: a second request waits for the first one's answer.
- A failed check (no network, the rate limit, no release yet, a tag that is no version) is logged and comes
  back as the payload's error, never as "up to date": the banner shows only on a real answer, and «Ajustes»
  says why the check failed.

«Actualizar ahora» (install)
- It leaves the user's install as the README's, whatever it was before: `uv tool install --force` from
  GitHub's main (SOURCE), never `uv tool upgrade`, which follows whatever source the install came from (a
  folder, a branch). A uv tool install is replaced where it is: its receipt beside the interpreter
  (uv-receipt.toml) gives the tools folder (UV_TOOL_DIR) and where its commands went (UV_TOOL_BIN_DIR), so a
  tool installed with folders of its own, as the Windows report needed, is not duplicated in uv's default
  ones, which the login entry would not even have in its environment. A copy run from the launchers in bin/
  gets the README's install, in uv's default folders. The Python is the version running now, so nothing
  else changes under the user.
- how() tells the page what to offer: "auto", the button; "git", for the development install (an editable
  receipt), never replaced since that would leave the working copy; "manual", the commands, when uv is
  nowhere to be found.
- uv and claude are looked for on the PATH and then where their installers put them (HOMES under the home
  folder, then SYSTEM_BINS): the login entry starts the dashboard with the system's PATH, which lacks
  ~/.local/bin.
- The skills go with it: when claude is found and lists the plugin (PLUGIN), `claude plugin update` runs
  first, on every system (it touches no Python, so Windows needs no helper for it), and the answer carries
  its failure, if any, for the page to show with the command to retry. No claude or no plugin is no failure:
  there is nothing to update. If uv then fails, the skills stay a version ahead of the commands until the
  next try.
- Only the machine itself installs (the server answers 403 to the LAN, like pairing), and one install at a
  time. A failure says what uv printed and leaves the dashboard as it was.
- macOS and Linux install in place while the dashboard runs, its source watcher held (process.py): a running
  program keeps its files there even once replaced. Then it restarts into the new interpreter, which moves
  the login entry to itself if there is one (autostart.follow). Linux could not do this from a helper: the
  systemd unit's default KillMode stops every process it started when the dashboard exits.
- Windows cannot replace an interpreter that is running, so the dashboard hands the install to a helper and
  exits: the helper runs on the Python the install was built from (sys._base_executable, outside the tools
  folder), detached (WINDOWS_DETACHED) so it outlives it, waits for the port to free, runs uv and starts the
  new dashboard, or the old one if uv failed. It logs to dashboard.log. Untested on a real Windows machine.
- An install made by an agent inside the Claude desktop app on Windows lives in that app's private space
  (AGENTS.md, known limitations); updating from a dashboard started there installs there again.
"""

import json
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.request

from odoo_wrapper import __version__, process

REPO = "alvaromr/odoo_wrapper"
LATEST = f"https://api.github.com/repos/{REPO}/releases/latest"
SOURCE = f"git+https://github.com/{REPO}"
TOOL = "odoo-wrapper"
RECEIPT = "uv-receipt.toml"
INSTALL_PATH = re.compile(r"""install-path = (?:"((?:[^"\\]|\\.)*)"|'([^']*)')""")
PLUGIN = "odoo@odoo-wrapper"
HOMES = ((".local", "bin"), (".cargo", "bin"), (".claude", "local"))
SYSTEM_BINS = ("/opt/homebrew/bin", "/usr/local/bin")
CLAUDE_TIMEOUT = 120
USER_AGENT = "odoo-wrapper"
TIMEOUT = 10
INSTALL_TIMEOUT = 600
OUTPUT_TAIL = 600
RESTART_DELAY = 0.5
HANDOVER_GRACE = 30
WINDOWS_DETACHED = 0x00000008 | 0x00000200
CHECK_TTL = 6 * 3600
FRESH_MIN = 60
log = logging.getLogger(__name__)
_lock = threading.Lock()
_installing = threading.Lock()
_last: dict = {"at": None, "answer": None}


def numbers(version):
    """Return a version, with or without its v, as a tuple of numbers to compare."""
    return tuple(int(part) for part in version.removeprefix("v").split("."))


def latest():
    """Return the version and page of the latest release on GitHub."""
    request = urllib.request.Request(
        LATEST,
        headers={
            "Accept": "application/vnd.github+json",  # pragma: no mutate - names ignore case
            "User-Agent": USER_AGENT,  # pragma: no mutate - as above
        },
    )
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
        release = json.load(response)
    return release["tag_name"].removeprefix("v"), release["html_url"]


def ask():
    """Ask GitHub whether a newer release is out, and answer with what the banner needs or why it failed."""
    try:
        version, url = latest()
        newer = numbers(version) > numbers(__version__)
    except (OSError, ValueError, KeyError) as error:
        log.warning(f"No se pudo buscar actualizaciones en GitHub: {error!r}")
        return {
            "available": False,
            "current": __version__,
            "latest": None,
            "url": None,
            "error": f"No se pudo consultar GitHub: {error}",
        }
    return {"available": newer, "current": __version__, "latest": version, "url": url, "error": ""}


def check(fresh=False):
    """Return GitHub's last answer, asking again when it is older than CHECK_TTL, or FRESH_MIN when forced."""
    with _lock:
        age = time.monotonic() - _last["at"] if _last["at"] is not None else None
        if age is None or age >= (FRESH_MIN if fresh else CHECK_TTL):
            _last.update(at=time.monotonic(), answer=ask())
        return _last["answer"]


def find(program):
    """Return a program's path: on the PATH, then where its installer puts it, else None."""
    name = f"{program}.exe" if sys.platform == "win32" else program
    home = os.path.expanduser("~")
    places = [os.path.join(home, *folder, name) for folder in HOMES] + [os.path.join(f, name) for f in SYSTEM_BINS]
    return shutil.which(program) or next((place for place in places if os.path.isfile(place)), None)


def update_skills():
    """Update the Claude Code plugin when claude has it, and return why it failed, or nothing."""
    claude = find("claude")
    if not claude:
        return ""
    quiet: dict = {"capture_output": True, "text": True, "stdin": subprocess.DEVNULL, "timeout": CLAUDE_TIMEOUT}
    try:
        listed = subprocess.run([claude, "plugin", "list", "--json"], check=True, **quiet)
        if PLUGIN not in {plugin.get("id") for plugin in json.loads(listed.stdout)}:
            return ""
        done = subprocess.run([claude, "plugin", "update", PLUGIN], check=False, **quiet)
    except (OSError, ValueError, AttributeError, subprocess.SubprocessError) as error:
        failure = str(error)
    else:
        failure = "" if done.returncode == 0 else f"{done.stderr}\n{done.stdout}".strip()[-OUTPUT_TAIL:]
    if failure:
        log.warning(f"No se pudieron actualizar las skills de Claude Code: {failure}")
    return failure


def receipt():
    """Return the uv receipt of the install running now, or nothing outside a uv tool."""
    try:
        with open(os.path.join(sys.prefix, RECEIPT), encoding="utf-8") as f:  # pragma: no mutate - UTF-8 here too
            return f.read()
    except FileNotFoundError:
        return ""


def how():
    """Tell the page how this install is updated: auto, git or manual."""
    if "editable =" in receipt():
        return "git"
    return "auto" if find("uv") else "manual"


def placement(found):
    """Return the tools and commands folders a receipt names, for uv to install in the same place."""
    if not found:
        return {}
    commands = [json.loads(f'"{quoted}"') if quoted else literal for quoted, literal in INSTALL_PATH.findall(found)]
    folders = {"UV_TOOL_DIR": os.path.dirname(sys.prefix)}
    if commands:
        folders["UV_TOOL_BIN_DIR"] = os.path.dirname(commands[0])
    return folders


def interpreter(tools, windowed=False):
    """Return where uv puts the tool's interpreter in a tools folder, on this system."""
    if sys.platform == "win32":
        return os.path.join(tools, TOOL, "Scripts", "pythonw.exe" if windowed else "python.exe")
    return os.path.join(tools, TOOL, "bin", "python")


def run_uv(command, env, installed):
    """Run uv's install and return what it printed when it failed, or nothing."""
    try:
        done = subprocess.run(command, check=False, env=env, capture_output=True, text=True, timeout=INSTALL_TIMEOUT)
    except (OSError, subprocess.SubprocessError) as error:
        return str(error)
    if done.returncode != 0:
        return f"{done.stderr}\n{done.stdout}".strip()[-OUTPUT_TAIL:]
    return "" if os.path.exists(installed) else f"no aparece {installed}"


def install(args, port):
    """Install the latest release with uv, update the skills and restart into it; answer (status, payload)."""
    if how() != "auto":
        return 409, {"error": "Esta instalación no se actualiza desde aquí: pídeselo a tu agente"}
    free = _installing.acquire(blocking=False)  # pragma: no mutate - None does not block either
    if not free:
        return 409, {"error": "Ya se está instalando una actualización"}
    uv, folders = find("uv"), placement(receipt())
    env = {**os.environ, **folders}
    python = "{}.{}".format(*sys.version_info[:2])  # pragma: no mutate - format reads only the first two
    command = [uv, "tool", "install", "--force", "--python", python, SOURCE]
    try:
        tools = (
            folders.get("UV_TOOL_DIR")
            or subprocess.run(
                [uv, "tool", "dir"], env=env, capture_output=True, text=True, check=True, timeout=TIMEOUT
            ).stdout.strip()
        )
    except (OSError, subprocess.SubprocessError) as error:
        _installing.release()
        return 502, {"error": f"uv no responde: {error}"}
    skills = update_skills()
    if sys.platform == "win32":
        hand_over(command, folders, tools, args, port)
        return 202, {"ok": True, "skills": skills}
    process.hold()
    installed = interpreter(tools)
    failure = run_uv(command, env, installed)
    if failure:
        process.release()
        _installing.release()
        log.error(f"uv no pudo instalar la actualización: {failure}")
        return 502, {"error": f"uv no pudo instalarla: {failure}"}
    log.info(f"Actualización instalada en {installed}: reiniciando…")
    threading.Timer(RESTART_DELAY, process.restart, [args, installed]).start()
    return 200, {"ok": True, "skills": skills}


def hand_over(command, folders, tools, args, port):
    """On Windows, leave the install to a detached helper and exit so it can replace the interpreter."""
    plan = {
        "command": command,
        "env": folders,
        "port": port,
        "new": [interpreter(tools, windowed=True), "-c", process.INSTALLED_BOOTSTRAP, *args],
        "old": process.launch_command(args),
    }
    helper = (
        f"import json, sys; sys.path.insert(0, {os.path.dirname(process.HERE)!r}); "
        "from odoo_wrapper.updates import finish; finish(json.loads(sys.argv[1]))"
    )
    base = getattr(sys, "_base_executable", sys.executable)  # pragma: no mutate - CPython always sets it
    detach([base, "-c", helper, json.dumps(plan)], os.environ)
    log.info("Actualización en marcha: el panel se cierra para que uv pueda reemplazarlo")
    threading.Timer(RESTART_DELAY, os._exit, [0]).start()


def detach(command, env):
    """Start a process that outlives this one, with no console and no streams."""
    subprocess.Popen(
        command,
        env=env,
        creationflags=WINDOWS_DETACHED,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
    )


def finish(plan):
    """The Windows helper: wait for the port, run uv, and start the new dashboard, or the old one if uv failed."""
    process.own_the_output()
    process.port_taken(plan["port"], HANDOVER_GRACE)
    env = {**os.environ, **plan["env"]}
    failure = run_uv(plan["command"], env, plan["new"][0])
    if failure:
        log.error(f"uv no pudo instalar la actualización: {failure}. Vuelve a arrancar la versión anterior")
        detach(plan["old"], env)
        return
    log.info("Actualización instalada: arranca la versión nueva")
    detach(plan["new"], {**env, process.UPDATED_ENV: "1"})
