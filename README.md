# odoo_wrapper

<p align="center">
  <img src="https://img.shields.io/badge/python-3.9%2B-blue" alt="Python 3.9+">
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="No dependencies">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT"></a>
</p>

Clock in and out of an Odoo ERP from the terminal, plus a local web dashboard of your weekly hours. No
dependencies: Python 3.9+ and its standard library, nothing else (one optional command, `odoo notices`, also
runs the `gws` CLI).

```
bin/odoo             clock in / status / history
bin/odoo-dashboard   web dashboard at http://localhost:8931/
src/odoo_wrapper/    client.py (Odoo client), cli.py (the commands), dashboard.py (entry point) and the
                     server modules it wires: server.py, data.py, team.py, state.py, lan.py, process.py,
                     autostart.py; qr.py;
                     sheets.py (Google Sheets for `odoo notices`); discord.py (the Discord bot's notices);
                     templates/ (pages, style.css and the page's scripts in js/)
.ai/skills/          the agent skills odoo-attendance and odoo-notices, as the Claude Code plugin `odoo`
```

## Features

- **CLI**: `login`, `status`, `checkin`, `checkout`, `toggle`, `break`, `resume`, `history`, `notices`, `sheet`,
  `discord` — see `odoo` with no arguments.
- **Dashboard**: local web UI with the week's hours, live timeline and self-restart on source changes.
- **Management view**: for a user who can read other people's attendances, `/gestion` shows everyone's week,
  month or year with punch errors (orange), targets missed, short or over (red) and change requests (blue); a day's dialog
  corrects its punches and approves its change requests, and warns whoever punched wrong by a private
  Discord message from a bot, or a message to copy.
- **Warnings sheet**: `odoo notices` appends everyone's punch errors and change requests to a Google Sheets
  file, and each month's count per employee, leaving alone whatever was changed there by hand;
  `.ai/skills/odoo-notices/SETUP.md` says what a machine needs first, on macOS, Linux or Windows.
- **Phone pairing**: HTTPS over the LAN with a one-shot QR that shares the browser's session, no password
  login off `localhost`.
- **Two-factor login**: asks for the authenticator code once and remembers the device for 90 days.
- **Breaks**: optional integration with `hr_attendance_reason` to punch and show "Descanso" sessions.
- **Nothing but the session is stored**: no password ever touches disk, everything lives in `~/.odoo_dashboard/`.

## Getting started

The same on macOS, Linux and Windows. [uv](https://docs.astral.sh/uv/) installs the commands, and Python
with them if the machine has none; it runs nothing afterwards.

1. **uv**, once: `curl -LsSf https://astral.sh/uv/install.sh | sh` on macOS and Linux,
   `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"` on Windows.
2. **The commands**: `uv tool install git+https://github.com/alvaromr/odoo_wrapper` puts `odoo` and
   `odoo-dashboard` on the PATH. If uv warns that its folder is not on the PATH, `uv tool update-shell` once
   and a new terminal.
3. **The dashboard**: `odoo-dashboard --autostart on` starts it now and at every login. Open
   http://localhost:8931/ and log in to Odoo once; it also serves the LAN over HTTPS, so you can pair your
   phone from the dashboard.
4. **The CLI**: `odoo login` once, since it keeps its own session, then `odoo status`.
5. **The skills, for Claude Code**:
   `claude plugin install odoo --marketplace https://github.com/alvaromr/odoo_wrapper.git`.

To update: `uv tool upgrade odoo-wrapper` and `claude plugin update odoo@odoo-wrapper`. To remove:
`odoo-dashboard --autostart off`, `uv tool uninstall odoo-wrapper` and `claude plugin uninstall
odoo@odoo-wrapper`; `~/.odoo_dashboard/` stays until you delete it.

That is a user's install, which follows GitHub. To work on the code, `AGENTS.md` § Installing for
development sets up a machine whose commands, dashboard and skills run the working copy instead; the
launchers in `bin/` also run it with no install at all: `python3 bin/odoo status` (`py bin\odoo …` on
Windows).

The first login asks for the Odoo URL, database, user and password. Only the session Odoo returns is kept —
in the browser for the dashboard, in `~/.odoo_dashboard/cli_session` for the CLI — never the password. URL,
database and user go to `~/.odoo_dashboard/config.json`. Nothing of this is ever committed.

With two-factor authentication enabled in Odoo, the login also asks for the code from your authenticator app
and then remembers the browser or machine as a trusted device for 90 days (a cookie in the browser,
`~/.odoo_dashboard/cli_device` for the CLI), so the next login within that time needs no code.

The phone mode needs the `openssl` command to create its certificate: macOS and Linux distributions have it,
and on Windows Git for Windows ships it and is found automatically. Windows will ask once whether to let
Python accept connections on the network — answer yes for the phone to reach it.

The interface is in Spanish — both the CLI output and the dashboard — the working language of the team it was
built for; code and documentation are in English.

## Skills

The skills live in `.ai/skills/`, which is also the Claude Code plugin `odoo` that step 5 above installs
(`.claude-plugin/marketplace.json` lists it). `.claude/skills` in the repo points there too, so an agent
opened on this repo already has them.

Each only says when to reach for the CLI and what to confirm first. Everything about using the tools
is in `odoo` (no arguments) and `odoo-dashboard --help`; the why of each behaviour — `--host`
security model, alarms, QR encoder, the gotchas that already cost a debugging session — is in the header of
each module, and `AGENTS.md` says how to work on the repo. This README does not duplicate them.

## Status

Used daily on macOS against Odoo 18 Enterprise. Linux and Windows have not been exercised yet — the code
avoids macOS-only paths, but the first run there is the real test. The Python package is covered line by
line by mocked unit tests and the page's logic runs under `node --test`; `AGENTS.md` lists the commands and
the manual checks that have actually caught regressions.

## License

MIT, see `LICENSE`.
