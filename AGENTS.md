# AI Guidelines

> Single source of truth for agents working on this repo. `CLAUDE.md` is a symlink to this file; don't give it
> separate content.

## What this project is

Tooling to clock in/out of an Odoo ERP and to see your own weekly hours. Two entry points over
one Python package, plus the agent skills that drive the CLI.

```
bin/odoo             CLI: login / status / checkin / checkout / toggle / break / resume / history / notices /
                     sheet
bin/odoo-dashboard   web dashboard on http://localhost:8931/
src/odoo_wrapper/
  client.py          Odoo client (web-session auth) and the connection config
  cli.py             the CLI commands and their output
  sheets.py          Google Sheets for `odoo notices`, as the Google account gws is signed in with
  dashboard.py       entry point: wires the pieces below and serves
  server.py          pages, JSON API, Odoo sessions as the login, same-site guard
  data.py            the payload read from Odoo (sessions, schedule, absences) and its cache
  team.py            the management view's payload: one week of everyone the session can read, flagged
  corrections.py     the day dialog's writes: correcting and adding punches, approving change requests
  discord.py         the day dialog's notice of a punch to fix, sent by private message from a Discord bot, and
                     the change request form its button opens, also from the personal page
  state.py           the shared state file (lunch stamp, durations, mute), per Odoo user
  lan.py             phone access: LAN address and name, self-signed certificate, QR
  process.py         log, self-restart on source or network changes, port check
  autostart.py       the login entry `--autostart` registers on each system
  updates.py         whether GitHub holds a newer release than this version, for the pages' banner, and
                     «Actualizar ahora»: installing it with uv and restarting into it
  qr.py              hand-written QR encoder
  templates/         dashboard.html, team.html (the management view at /gestion), login.html, style.css
                     (design tokens) and each page's own .css, manifest.json and icon.svg (installable page),
                     and js/: the pages
                     as ES modules, app.js and team.js the only ones each page loads: the dashboard's (store, format,
                     week, ui, api, hero, render, alarms, app), the management view's (teamstate, teamfixes, teamcharts,
                     teamdiscord, team) and what both use (shared, dayedit: the day dialog); store.js and
                     teamstate.js hold each page's state. theme.js, the colour theme, is the one classic script,
                     loaded from every page's <head>. Served at /<name>.css and /js/<name>
tests/               unittest + node tests, check.py (the gate) and fix.py; see below
.githooks/           pre-commit: runs the gate before each commit
.ai/skills/          odoo-attendance (clocking) and odoo-notices (the warnings spreadsheet and the setup of a
                     machine for it); .claude/skills in the repo points there
.claude-plugin/      marketplace.json: publishes .ai/ as the Claude Code plugin `odoo`, its skills/ the
                     plugin's default skills folder
```

## Where the documentation lives

Don't duplicate — each fact has one home:

- **`bin/odoo` with no arguments** and **`bin/odoo-dashboard --help`** — everything about using each tool:
  commands, flags, files, what clocks for real.
- **The header of each module** — why it behaves as it does: `server.py` (sessions, same-site guard, API),
  `data.py` (what is read from Odoo and how it is cached), `team.py` (who the management view shows and what each
  flag means), `corrections.py` (what the day dialog writes and when it warns), `discord.py` (why a bot, and
  how the recipient is found), `state.py` (the shared state),
  `lan.py` (phone access and its certificate), `process.py` (log, self-restart, ports, how it is launched),
  `autostart.py` (the login entry on each system), `updates.py` (where the version lives, how it is compared, how
  often GitHub is asked, and how each kind of install is updated), `cli.py` (the commands),
  `sheets.py` (why gws, and how little is asked of it),
  each file in `templates/js/` (shared state, reload policy, buttons, alarms…), `templates/style.css` (palette and
  how breaks are drawn), `qr.py` (the encoder and how to verify it).
- **The skills** — only when an agent should reach for the CLI and what to confirm first; `odoo-notices` also
  carries `SETUP.md`, what a machine needs for `odoo notices` on each operating system.
- **`README.md`** — human quickstart only, the install included.
- **`docs/decisions/`** — each practice the repo departs from on purpose, why, and who approved it.
- **This file** — how to work on the repo, and the Odoo API notes below.

Read the header of a module before touching it.

## Hard rules

1. **No third-party dependencies. Ever.** Python 3.9+ stdlib only, no venv, no `pip install` needed to run.
   `pyproject.toml` is what installers read, never a requirement to run from the repo. This
   is why `qr.py` is hand-written instead of pulling `segno`/`qrencode`. A dependency needs the user's explicit
   agreement, not an assumption that it is more convenient. Two have it: the `gws` CLI, an external program that
   only `odoo notices` runs, for the Google sign-in and nothing else (the header of `sheets.py` says why); and
   uv, the installer the README sends users to, which afterwards runs only when the dashboard's «Actualizar
   ahora» installs a new release (`updates.py`), and is never required to run from the repo. That button also
   runs the `claude` CLI, when it is there and has the plugin, to update the skills; nothing needs it.
2. **Start the dashboard only through `bin/odoo-dashboard` or the login entry of the development install
   (below), and only if nothing listens on port 8931 yet.**
   Never kill and relaunch it (saving a `.py` restarts it by itself) and never patch `PORT`/`TLS_PORT` to dodge
   a busy port; the header of `process.py` says why and how to find the instance holding it.
3. **Secrets stay in `$HOME`.** Odoo config, the CLI session, TLS cert and key, the warnings spreadsheet's
   id with the rows written to it, and the Discord bot's token, all live in `~/.odoo_dashboard/`; the
   dashboard's own Odoo sessions live in the browsers, and the Google sign-in in gws's own config and the OS
   keyring. Neither the Odoo password nor the Google credentials are ever stored by anything here.
   Nothing of this ever enters the repo, not even gitignored: this repo can be pushed anywhere.
4. **Editing `.ai/skills/` changes the skill immediately, wherever it is symlinked from**, and for everyone
   with the plugin once pushed and updated. Renaming or moving `.ai/` or its `skills/` breaks `.claude/skills`,
   any `~/.claude/skills` link and the plugin's `source` in `.claude-plugin/marketplace.json` — fix them if
   you do, and run `claude plugin validate .` after touching either.
5. **Don't touch the user's real `~/.odoo_dashboard/`** to test something. Point `HOME` at a throwaway directory
   instead (see below).
6. Communicate with the user in Spanish. Code, comments and documentation in English; every string the user
   reads while using the tool — dashboard UI and CLI output alike — stays in Spanish.

## Code style

- Functional over imperative where it reads better; no inline comments — the code should not need them. Every
  public module, class, function and method of the package has a docstring saying what it does (Google
  convention, checked by Ruff); the why lives in each module's header (docstring or top comment block), nowhere
  else. Tests and launchers go without: a test says what it checks in its name. The exceptions are the
  comments that tell a tool to let one line be, each with its reason: `# pragma: no mutate - <reason>` of an
  equivalent mutant, `// Stryker disable next-line` in the JS (see How to verify changes), `# noqa: <rule> -
  <reason>` and `biome-ignore <rule>: <reason>`. A rule switched off for a whole file or the whole project says
  why beside it, in `pyproject.toml` or `biome.jsonc`.
- Named constants at module top, `UPPER_SNAKE`. Module-level mutable state is prefixed `_`.
- Keep `client.py` free of dashboard and CLI concerns: no printing, no HTTP serving. `cli.py` and the
  server modules import from it, never the other way round.

## Decisions

Before changing a practice, read `docs/decisions/`.

## Installing for development

The README installs a user's copy: the commands from GitHub's `main`, the skills as a plugin cached from it.
Neither follows the repo. On the machine where the repo is worked on, install from the working copy
instead, so that the commands on the PATH, the dashboard started at login and the skills all run what you
edit, and saving a `.py` restarts the dashboard as rule 2 expects:

```bash
uv tool install --force --editable <repo>          # odoo and odoo-dashboard run this copy's src/
odoo-dashboard --autostart on                       # the login entry follows: it names the interpreter
claude plugin marketplace remove odoo-wrapper       # only if the user's install is there
claude plugin install odoo --marketplace <repo>     # reads .ai/skills in place, no cached copy
```

The README's steps again, with `--force` on uv's, go back to a user's install. Two checks need more than
the editable install, before merging a change that could break them:

- **The package as built** (`pyproject.toml`, a new file the package ships): `uv tool install --force
  --reinstall <repo>` installs this copy as a user gets it. Without `--reinstall` uv reuses its cached build
  of the folder and the old code stays. Go back to the editable install afterwards.
- **The install from GitHub** (`pyproject.toml`, `.claude-plugin/`): push a branch and install from it with
  the README's commands, `git+…@<branch>` for uv and `…odoo_wrapper.git#<branch>` for the plugin.

## Releasing

Every push to `main` is a release, because users install `main` and the dashboards' update banner only
looks at releases (`updates.py`'s header says why): a push without one reaches nobody. In the commit that
goes to `main`, raise `__version__` in `src/odoo_wrapper/__init__.py`, the only place it is written
(semantic versioning: patch for fixes, minor for features, major for what breaks an install or a habit).
Once `main` is pushed, tag that commit and publish it:

```bash
git tag -a vX.Y.Z -m vX.Y.Z <commit on main>
git push origin vX.Y.Z
gh release create vX.Y.Z --verify-tag --generate-notes
```

A tag is never moved or reused; a broken release is fixed by the next one.

## How to verify changes

Start with the gate, one command that needs uv, pnpm and Node ≥ 22 and installs nothing in the repo but its own
pre-commit hook (`.githooks/`, set in git's `core.hooksPath` the first time it runs):

```bash
python3 tests/check.py                   # Ruff, mypy, Biome, TypeScript, both suites, both coverages; its header lists each step
python3 tests/fix.py                     # formats and applies the tools' safe fixes, then runs the gate
```

The Python suite includes the project's guards (`tests/test_project.py`): the dependency rule of Code style, no
secret anywhere under the repo, a size cap for source files and every module named in the map above. Neither
suite reaches the network: `tests/helpers.py` and `tests/page.mjs` make every connection fail, so a call left
unmocked fails its test.

Its steps run alone too, while working on one side: `python3 -m unittest discover -s tests` (the Python
suite), `python3 tests/report_coverage.py` (with every line and branch; branches need Python ≥ 3.14) and
`node --test 'tests/*.test.mjs'` (the page's logic, each suite on the harness in `tests/page.mjs`). `ruff format` lays out every Python file, tests included,
in 120 columns (`pyproject.toml`), and Biome the page's JS and CSS and the JS tests (`biome.jsonc`), which it
also lints; run them rather than wrapping by hand. Types are strict on both sides: mypy `--strict` over the
package, every function annotated, each module starting with `from __future__ import annotations` (Ruff adds
it) so they read as on 3.10+ while the package runs on 3.9; and TypeScript over the page's JS, typed in JSDoc
(`tsconfig.json`), where an element the page always holds is reached with `byId` (`shared.js`).

Mutation testing runs now and then rather than on every commit: it takes a couple of minutes, and its working
copy, `mutants/`, is ignored by git. mutmut skips the one test that starts a subprocess and the project's guards,
which read the repo its copy lacks. It runs each mutant in a forked child, and macOS crashes a forked child that
calls CoreFoundation, which mutmut then reports as segfault: urllib asks the system for its proxies that way
unless `no_proxy` is set, and mutmut before 3.8 set the process title that way too. pytest stays at 9.1, because
mutmut 3.8.0 reads a test's `_nodeid`, which pytest 9.2 removed.

```bash
no_proxy='*' uvx --python 3.12 --with pytest==9.1.1 mutmut@3.8.0 run  # pyproject.toml
no_proxy='*' uvx --python 3.12 --with pytest==9.1.1 mutmut@3.8.0 results  # the mutants no test killed
```

A test that reaches `process.restart` mocks `subprocess.Popen` and `os._exit` as well as `os.execve`: a mutant
that takes the wrong branch would otherwise start a real dashboard and end the test with exit code 0, which
mutmut counts as a survivor. A mutant reported as timeout made a loop endless, and the suite caught it.

The page's JS runs under StrykerJS, through pnpm, with no package.json: `stryker.config.json` points it at
`node --test`, so every mutant runs the whole page suite and a full round takes about an hour. The suite's files
run one after another there: Stryker already runs mutants in parallel, and files in parallel inside each one
overloaded the machine until nearly every mutant timed out. Its working
copy, `.stryker-tmp/`, and `reports/` are ignored by git. The suite hands the active mutant to its vm context
(the header of `tests/page.mjs` says why). It also gets TypeScript, which it needs to copy `tsconfig.json`
into its sandbox.

```bash
pnpm --package=@stryker-mutator/core@10.0.0 --package=typescript@5.9.3 dlx stryker run  # stryker.config.json
```

Every surviving mutant is either a missing test, which gets written, or an equivalent one, which behaves as the
original for every input and gets `# pragma: no mutate - <reason>` on its line, saying why. The pragma silences
every mutant starting on that line, not only the equivalent one, and counts only on the first line of a
statement: on a line whose other mutants a test kills, the equivalent part moves to a line of its own first,
unless splitting reads worse, as in a dict of HTTP headers, whose names are equivalent in any case and whose
statement goes between `# pragma: no mutate start - <reason>` and `# pragma: no mutate end`. In the JS the comment is `// Stryker disable next-line <mutator>:
<reason>` on the line above, and it silences only that mutator. A message moved to a constant to escape its
mutants proves nothing: constants are for what reads better or repeats.

Keep both at 100 % of lines and branches, and the JS at 100 % of functions too: a new branch in the code comes
with the test that runs it, and each report names what is missing. A branch no input can take is removed from
the code, not excused. Extend the DOM stand-in in `tests/page.mjs` when a new DOM call breaks it. What the
tests cannot see is layout, sound and real browsers, so the page is still checked by hand; run the checks your
change touches:

```bash
# Exposed mode end to end, without touching the real config, sessions or cert
mkdir -p /tmp/fakehome
HOME=/tmp/fakehome python3 bin/odoo-dashboard

# Auth and anti-CSRF/rebinding matrix (expected: login page, 401, 401, 403, 303 to /login, 403, 403)
curl -sk https://<lan-ip>:8443/ | grep -c "Introduce tu usuario"
curl -sk -o /dev/null -w "%{http_code}\n" https://<lan-ip>:8443/api/data
curl -sk -o /dev/null -w "%{http_code}\n" -H "Cookie: odoo_dash=deadbeef" https://<lan-ip>:8443/api/data
curl -sk -o /dev/null -w "%{http_code}\n" -X POST https://<lan-ip>:8443/api/login -d '{}'
curl -sk -o /dev/null -w "%{http_code} %{redirect_url}\n" "https://<lan-ip>:8443/pair?t=bogus"
curl -s  -o /dev/null -w "%{http_code}\n" -H "Host: evil.com" http://localhost:8931/api/data
curl -s  -o /dev/null -w "%{http_code}\n" -X POST http://localhost:8931/api/attendance \
     -H "Origin: https://evil.example" -H "Content-Type: text/plain" -d '{"action":"bogus"}'
```

Never test `/api/attendance` with a real action — it would clock the user in or out for real. Use
`{"action":"bogus"}`, which is rejected with 400 before Odoo is contacted.

Never run `odoo notices` to try something either: it appends to whatever spreadsheet is saved, for real, and
remembers it did. What it writes is tested against the stand-ins in `tests/`; by hand, only with a copy of the
spreadsheet saved (`odoo sheet <URL>`).

Never run `odoo-dashboard --autostart on` to try it: it registers a real login entry for the user and starts
a dashboard through the system, whatever `HOME` says. What it writes is tested with the system calls mocked;
by hand, generate the entry in a throwaway `HOME` with them mocked and lint it (`plutil -lint` on macOS).

Never press «Actualizar ahora», nor POST `/api/update`, on a user's install to try it: it replaces their
install and restarts their dashboard for real (the development install refuses it). It is tested with uv,
the restart and the system calls mocked; by hand, run the uv command it builds (`updates.install`) with
`UV_TOOL_DIR` and `UV_TOOL_BIN_DIR` in the scratchpad and start the result with `--help`.

To verify `qr.py`, decode its output rather than diffing the matrix against a reference library (its header
says why, and names the `swift`/Vision recipe).

## Odoo API notes

What `client.py` relies on, and why it looks the way it does. Verified against an Odoo 18 Enterprise (`18.0+e`).

- **Web session, not API key.** `login` posts user and password to `/web/session/authenticate` once and keeps
  the `session_id` cookie it returns; every later call sends that cookie and nothing else. A dead session comes
  back as JSON-RPC error code 100 (`SessionExpiredException`), raised as `SessionExpired` so callers can ask for
  a new login; wrong credentials come back as `odoo.exceptions.AccessDenied` (`AccessDenied`). The cookie Odoo
  issues expires 7 days ahead and is renewed on use, so a session idle for about a week is gone.
- **Two-factor (`auth_totp`) is a second step on the same session.** With it enabled, `/web/session/authenticate`
  answers `{"uid": null}` and leaves a half-open session (`pre_uid`) behind the cookie. `/web/login/totp` is the
  only way to finish it: an HTML form, so a GET for its `csrf_token` and a POST with `totp_token`; with
  `remember` Odoo also returns a `td_id` cookie that lets the GET alone finish the session for 90 days. Success
  is a 303 that rotates `session_id`; the re-rendered form is a wrong code. `client.py`'s header has the details.
- **Clocking goes through `/hr_attendance/systray_check_in_out`**, the same endpoint as the clock-in button in
  Odoo 18. It runs with `sudo`, which is why it works with plain employee permissions.
- **`hr_attendance_reason` (OCA + AvanzOSC extensions) is installed, but optional**: the systray endpoint
  accepts an `attendance_reason_id`, and sign-in reasons are "Normal" and "Descanso" (`is_rest: true`),
  resolved by flags — never hardcode ids. A break is its own attendance session checked in with the Descanso
  reason, and its `worked_hours` count like any other session. Without the module (or its access) both tools
  punch plainly and offer no breaks: the dashboard hides the buttons, the CLI's `break` says so and does not
  punch; `client.py`'s header says how.
- Status and history are `search_read` on `hr.attendance`, read-only. Odoo stores times in UTC; the tools print
  them in the local timezone.
- The management view, the CLI's `notices` (the same payload) and the per-day targets also read, never write:
  `hr.contract` (the calendar in force each day), `hr.employee` (name, calendar, user, and the Discord user id
  in a field added with Studio, found by its label «Discord»; archived employees are
  left out, their `departure_date` is only readable by HR officers) and `approval.request` (attendance change
  requests, found by category name).
  Which employees a session sees is left to Odoo's record rules; `data.py` and `team.py` headers have the
  details.
- **The Discord notice's button, and the personal page's «Solicitar cambio», open a window action created by
  hand** (`ir.actions.act_window` with path `modificacion-fichaje`, an administrator's job, like the «Discord»
  field): a form on `approval.request` whose
  context copies what the category's own «Nueva solicitud» button sets and reads `desde`, `hasta` and `motivo`
  from the URL as `params`. Odoo's URL carries no default values otherwise; `discord.py`'s header says how it
  works, why it may break with an upgrade of Odoo, and what the button falls back to. Nothing creates the
  request: the employee sends it, as the law requires.
- The day dialog (`corrections.py`) is the only other writer: it `write`s, `create`s or `unlink`s `hr.attendance`
  (check_in, check_out, and attendance_reason_ids when the reason is changed) and calls
  `approval.request.action_approve` as the session's user, all only if Odoo's rights allow them. None can be
  tested reversibly against a real Odoo: an attendance keeps a tracking message for every change, even one
  undone, a deleted one is gone for good, and approving notifies the employee. Test them against the scripted
  client only.

## Known limitations, already investigated

Don't re-investigate these from scratch:

- **`<hostname>.local` resolves on some networks and not on others from an Android phone.** With Private DNS
  active every lookup goes to the external resolver, which cannot know an mDNS name; on a network where it
  is bypassed the name works. The Mac advertises the record correctly — verified with `dns-sd`. Hence the
  choice when pairing: by IP always works, by name when the phone resolves it (and then survives network
  changes).
- **A self-signed certificate rules out installing the page as an app on Android.** Chromium only installs
  a PWA from a secure origin without certificate errors; a page opened past the certificate warning does
  not qualify, so «Añadir a pantalla de inicio» creates a browser shortcut, not a standalone app. Full
  screen there would need a CA trusted by the phone. The manifest and metadata still serve Safari, which
  does not check this.
- **A sleeping machine is unreachable from the phone.** Waking on network access only works for advertised
  Bonjour services, and the dashboard advertises none.
- **A Wi-Fi with client isolation blocks phone→laptop regardless of the URL.** On an ordinary home or office
  network the whole path works: pairing QR, a certificate per network, and data.
- **Tailscale and any external service are out of scope.** The dashboard stays LAN-only; don't propose them.
  Reaching the dashboard is meant: the services it calls out to besides Odoo are Discord's API, to send the day
  dialog's notices from a bot (`discord.py`), and GitHub's, to ask whether a newer version is out
  (`updates.py`), both of which the user asked for.
- **An Odoo API key cannot replace the password.** Verified against Odoo 18: the external RPC API (`/jsonrpc`,
  the only place Odoo accepts API keys) authenticates and reads fine, but it cannot punch — a regular employee has
  no `create`/`write` on `hr.attendance`, and `hr.employee` exposes no public clock method in 18
  (`attendance_manual` and `attendance_action_change` no longer exist). The only clock path is the systray
  controller, which needs a web session, and `/web/session/authenticate` rejects API keys.
- **Linux is supported by reading, not by running, and Windows only partly by running.** The first report
  from Windows 11 (uv 0.13.6, Python 3.12, 2026-10-29) found no fault in the code: the install from GitHub,
  `odoo` with no arguments, `odoo-dashboard --help`, `odoo status` without a session (it asks for the login)
  and `--autostart on` (the Run key, and the dashboard answering on 8931) work. Login, two-factor, punching,
  breaks, the phone mode with openssl, `odoo notices` and the management view are still unreported. The
  first report from Linux is the test.
- **Installed by an agent in the Claude desktop app on Windows, nothing exists outside that app.** The app is
  packaged (MSIX), and Windows redirects its writes to `AppData` and to the Run key into the app's private
  space: uv's Python, the tool and the login entry all landed there, and nothing started at login. uv also
  failed installing Python there («Missing expected target directory for Python minor version link»), from
  the same cause. Not a fault of the code; the README says to install from a normal terminal.
