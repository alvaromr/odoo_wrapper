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
src/odoo_wrapper/    the Python package both run, and the pages; AGENTS.md maps each module
.ai/skills/          the agent skills odoo-attendance and odoo-notices, as the Claude Code plugin `odoo`
```

## Features

- **CLI**: clocking, breaks, history, the warnings sheet and the Discord bot's token; `odoo` with no arguments
  lists every command.
- **Dashboard**: local web UI with the week's hours, live timeline and self-restart on source changes; it
  opens Odoo's change request form, filled for each punch to fix, beside the correction for whoever may also
  correct. Light or dark theme, and a banner when GitHub holds a newer release, which installs it.
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
with them if the machine has none; afterwards it only runs again to update.

On Windows, run steps 1 to 3 in a normal terminal, not through an agent in the Claude desktop app. That app
is packaged (MSIX), and Windows redirects what it writes in `AppData` and in the Run key to the app's own
private space: Python, the commands and the start at login then exist only inside the app, and nothing starts
when you log in. If it was installed that way, repeat steps 1 to 3 in a normal terminal.

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

To update: when a new version is out the dashboard says so, and its «Actualizar ahora» installs it, the
skills included when Claude Code has them, and restarts. By hand: `uv tool upgrade odoo-wrapper` and
`claude plugin update odoo@odoo-wrapper`. To remove:
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

The interface is in Spanish — both the CLI output and the dashboard — the working language of the team it was
built for; code and documentation are in English.

## Phone mode

It needs the `openssl` command to create its certificate: macOS and Linux distributions have it, and on Windows
Git for Windows ships it and is found automatically. Windows will ask once whether to let Python accept
connections on the network — answer yes for the phone to reach it. What it cannot do:

- **Reach a sleeping computer.** The phone finds the dashboard only while the computer is awake.
- **Cross a Wi-Fi with client isolation**, common on guest networks: the phone cannot reach the computer there,
  whatever the address. An ordinary home or office network works.
- **Find the computer by name on every network.** An Android phone with Private DNS on resolves no
  `<name>.local`; pairing by IP always works, and by name it also survives a change of network.
- **Install as an app on Android.** With a self-signed certificate «Añadir a pantalla de inicio» adds a browser
  shortcut, not a full-screen app. Safari on iPhone installs it.

## Skills

The skills live in `.ai/skills/`, which is also the Claude Code plugin `odoo` that step 5 above installs
(`.claude-plugin/marketplace.json` lists it). `.claude/skills` in the repo points there too, so an agent
opened on this repo already has them.

Each only says when to reach for the CLI and what to confirm first. Everything about using the tools
is in `odoo` (no arguments) and `odoo-dashboard --help`; the why of each behaviour — `--host`
security model, alarms, QR encoder, the gotchas that already cost a debugging session — is in the header of
each module, and `AGENTS.md` says how to work on the repo. This README does not duplicate them.

## Status

Used daily on macOS against Odoo 18 Enterprise. On Windows 11 the install, the CLI without a session and the
start at login have been reported to work; logging in, punching and the rest are not reported yet. Linux has
not been exercised — the code avoids macOS-only paths, but the first run there is the real test. The Python
package is covered line by line by mocked unit tests and the page's logic runs under Vitest;
`AGENTS.md` lists the commands and the manual checks that have actually caught regressions.

## License

MIT, see `LICENSE`.
