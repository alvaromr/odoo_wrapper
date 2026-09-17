# odoo_wrapper

<p align="center">
  <img src="https://img.shields.io/badge/python-3.9%2B-blue" alt="Python 3.9+">
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="No dependencies">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT"></a>
</p>

Clock in and out of an Odoo ERP from the terminal, plus a local web dashboard of your weekly hours. No
dependencies: Python 3.9+ and its standard library, nothing else.

```
bin/odoo             clock in / status / history
bin/odoo-dashboard   web dashboard at http://localhost:8931/
src/odoo_wrapper/    client.py (Odoo client), cli.py (the commands), dashboard.py (entry point) and the
                     server modules it wires: server.py, data.py, state.py, lan.py, process.py; qr.py;
                     templates/ (pages, style.css and the page's scripts in js/)
.ai/skills/          the agent skill odoo-attendance
```

## Features

- **CLI**: `login`, `status`, `checkin`, `checkout`, `toggle`, `break`, `resume`, `history` — see `bin/odoo`.
- **Dashboard**: local web UI with the week's hours, live timeline and self-restart on source changes.
- **Phone pairing**: HTTPS over the LAN with a one-shot QR that shares the browser's session, no password
  login off `localhost`.
- **Two-factor login**: asks for the authenticator code once and remembers the device for 90 days.
- **Breaks**: optional integration with `hr_attendance_reason` to punch and show "Descanso" sessions.
- **Nothing but the session is stored**: no password ever touches disk, everything lives in `~/.odoo_dashboard/`.

## Getting started

```bash
python3 bin/odoo-dashboard                  # then open http://localhost:8931/ and log in to Odoo once
python3 bin/odoo-dashboard --host 0.0.0.0   # also serves the LAN over HTTPS; pair your phone from the dashboard
python3 bin/odoo login                      # the CLI keeps its own session, asked for once too
python3 bin/odoo status
```

The first login asks for the Odoo URL, database, user and password. Only the session Odoo returns is kept —
in the browser for the dashboard, in `~/.odoo_dashboard/cli_session` for the CLI — never the password. URL,
database and user go to `~/.odoo_dashboard/config.json`. Nothing of this is ever committed.

With two-factor authentication enabled in Odoo, the login also asks for the code from your authenticator app
and then remembers the browser or machine as a trusted device for 90 days (a cookie in the browser,
`~/.odoo_dashboard/cli_device` for the CLI), so the next login within that time needs no code.

On Windows, run the same launchers with `py bin\odoo-dashboard` (or `python`). The phone mode needs the
`openssl` command to create its certificate: Git for Windows ships it and is found automatically; Linux
distributions have it installed. Windows will ask once whether to let Python accept connections on the
network — answer yes for the phone to reach it.

Nothing to install. If you would rather have the commands on your PATH, `pip install -e .` exposes `odoo` and
`odoo-dashboard`.

The interface is in Spanish — both the CLI output and the dashboard — the working language of the team it was
built for; code and documentation are in English.

## Skills

The skill lives in `.ai/skills/`; `.claude/skills` in the repo points there, so an agent opened on this repo
already has it. To use it from any other project, symlink it into `~/.claude/skills/`.

It only says when to reach for the CLI and what to confirm first. Everything about using the tools
is in `bin/odoo` (no arguments) and `bin/odoo-dashboard --help`; the why of each behaviour — `--host`
security model, alarms, QR encoder, the gotchas that already cost a debugging session — is in the header of
each module, and `AGENTS.md` says how to work on the repo. This README does not duplicate them.

## Status

Used daily on macOS against Odoo 18 Enterprise. Linux and Windows have not been exercised yet — the code
avoids macOS-only paths, but the first run there is the real test. The Python package is covered line by
line by mocked unit tests and the page's logic runs under `node --test`; `AGENTS.md` lists the commands and
the manual checks that have actually caught regressions.

## License

MIT, see `LICENSE`.
