# AI Guidelines

> Single source of truth for agents working on this repo. `CLAUDE.md` is a symlink to this file; don't give it
> separate content.

## What this project is

Tooling to clock in/out of an Odoo ERP and to see your own weekly hours. Two entry points over
one Python package, plus the agent skill that drives the CLI.

```
bin/odoo             CLI: login / status / checkin / checkout / toggle / break / resume / history
bin/odoo-dashboard   web dashboard on http://localhost:8931/
src/odoo_wrapper/
  client.py          Odoo client (web-session auth) and the connection config
  cli.py             the CLI commands and their output
  dashboard.py       entry point: wires the pieces below and serves
  server.py          pages, JSON API, Odoo sessions as the login, same-site guard
  data.py            the payload read from Odoo (sessions, schedule, absences) and its cache
  state.py           the shared state file (lunch stamp, durations, mute)
  lan.py             phone access: LAN address and name, self-signed certificate, QR
  process.py         log, self-restart on source or network changes, port check
  qr.py              hand-written QR encoder
  templates/         dashboard.html, login.html, style.css (design tokens), manifest.json and icon.svg
                     (installable page), and js/: the page as ES modules (store, format, week, ui, api,
                     render, alarms, app), app.js the only one dashboard.html loads and store.js holding
                     the shared state, served at /style.css and /js/<name>
tests/               unittest + node tests, see below
.ai/skills/          odoo-attendance  (.claude/skills in the repo points there; symlink it into
                     ~/.claude/skills to use it from other projects)
```

## Where the documentation lives

Don't duplicate — each fact has one home:

- **`bin/odoo` with no arguments** and **`bin/odoo-dashboard --help`** — everything about using each tool:
  commands, flags, files, what clocks for real.
- **The header of each module** — why it behaves as it does: `server.py` (sessions, same-site guard, API),
  `data.py` (what is read from Odoo and how it is cached), `state.py` (the shared state), `lan.py` (phone
  access and its certificate), `process.py` (log, self-restart, ports), `cli.py` (the commands), each file
  in `templates/js/` (shared state, reload policy, buttons, alarms…), `templates/style.css` (palette and
  how breaks are drawn), `qr.py` (the encoder and how to verify it).
- **The skill** — only when an agent should reach for the CLI and what to confirm first.
- **`README.md`** — human quickstart only.
- **This file** — how to work on the repo, and the Odoo API notes below.

Read the header of a module before touching it.

## Hard rules

1. **No third-party dependencies. Ever.** Python 3.9+ stdlib only, no venv, no `pip install` needed to run.
   `pyproject.toml` exists so `pip install -e .` *can* expose the commands on PATH, never as a requirement. This
   is why `qr.py` is hand-written instead of pulling `segno`/`qrencode`. A dependency needs the user's explicit
   agreement, not an assumption that it is more convenient.
2. **Start the dashboard only through `bin/odoo-dashboard`, and only if nothing listens on port 8931 yet.**
   Never kill and relaunch it (saving a `.py` restarts it by itself) and never patch `PORT`/`TLS_PORT` to dodge
   a busy port; the header of `process.py` says why and how to find the instance holding it.
3. **Secrets stay in `$HOME`.** Odoo config, the CLI session, TLS cert and key all live in `~/.odoo_dashboard/`;
   the dashboard's own Odoo sessions live in the browsers. The Odoo password is never stored by anything.
   Nothing of this ever enters the repo, not even gitignored: this repo can be pushed anywhere.
4. **Editing `.ai/skills/` changes the skill immediately, wherever it is symlinked from.** Renaming or moving
   its directory breaks `.claude/skills` and any `~/.claude/skills` link — recreate them if you do.
5. **Don't touch the user's real `~/.odoo_dashboard/`** to test something. Point `HOME` at a throwaway directory
   instead (see below).
6. Communicate with the user in Spanish. Code, comments and documentation in English; every string the user
   reads while using the tool — dashboard UI and CLI output alike — stays in Spanish.

## Code style

- Functional over imperative where it reads better; no inline comments — the code should not need them. The
  why lives in each module's header (docstring or top comment block), nowhere else.
- Named constants at module top, `UPPER_SNAKE`. Module-level mutable state is prefixed `_`.
- Keep `client.py` free of dashboard and CLI concerns: no printing, no HTTP serving. `cli.py` and the
  server modules import from it, never the other way round.

## How to verify changes

Start with the unit tests:

```bash
python3 -m unittest discover -s tests   # the Python suite
python3 tests/report_coverage.py        # the same under the stdlib tracer; fails unless every line ran
node --test tests/app.test.mjs          # the page's logic (Node ≥ 18, nothing to install)
```

Keep it at 100 %: a new branch in the Python code comes with the test that runs it, and the report names the
lines that are missing. Extend the DOM stand-in in `tests/app.test.mjs` when a new DOM call breaks it. What the
tests cannot see is layout, sound and real browsers, so the page is still checked by hand; run the checks your
change touches:

```bash
# Exposed mode end to end, without touching the real config, sessions or cert
mkdir -p /tmp/fakehome
HOME=/tmp/fakehome python3 bin/odoo-dashboard --host 0.0.0.0

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
- **An Odoo API key cannot replace the password.** Verified against Odoo 18: the external RPC API (`/jsonrpc`,
  the only place Odoo accepts API keys) authenticates and reads fine, but it cannot punch — a regular employee has
  no `create`/`write` on `hr.attendance`, and `hr.employee` exposes no public clock method in 18
  (`attendance_manual` and `attendance_action_change` no longer exist). The only clock path is the systray
  controller, which needs a web session, and `/web/session/authenticate` rejects API keys.
- **Linux and Windows are supported by reading, not by running.** The first report from either platform is the
  test.
