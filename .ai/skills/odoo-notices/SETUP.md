# Setting up a machine for `odoo notices`

What the command needs before its first run, in the order to check it. Each step starts with how to tell it is
already done: go through them all and stop only where one is missing. **The user** marks what an agent cannot do
for them, **the owner** what needs whoever administers the Google Cloud project behind the sign-in.

Only macOS has run all of this; Linux and Windows are supported by reading (`AGENTS.md`, known limitations).

## What to install

1. **Python 3.9 or later.** `python3 --version` answers; on Windows try `python --version` and `py --version`
   too, and use whichever answers in place of `python3` everywhere.
   - macOS: `brew install python`, or the installer from [python.org](https://www.python.org/downloads/).
   - Windows: the installer from python.org, ticking «Add python.exe to PATH».
   - Linux: the distribution's package, `python3`.
2. **A copy of this repository**, cloned or downloaded and unpacked anywhere. Every command is run from its
   folder; nothing in it needs installing.
3. **The `gws` CLI** ([googleworkspace/cli](https://github.com/googleworkspace/cli)), which holds the Google
   sign-in. `gws --version` answers «gws» and a version.
   - Any system: download the archive for it from the
     [releases](https://github.com/googleworkspace/cli/releases), unpack it and put `gws` (`gws.exe` on Windows)
     in a folder that is on the `PATH`.
   - macOS and Linux with Homebrew: `brew install googleworkspace-cli`. The formula named just `gws` is an
     unrelated tool that installs the same command.

## What to sign in to

4. **Odoo, as someone who reads everyone's attendances.** `python3 bin/odoo status` answers without
   `Ejecuta: odoo login`. Otherwise **the user** runs `python3 bin/odoo login` in their own terminal: it asks
   for the password. The command lists whoever that session can read, so it has to be the attendance
   officer's: with an ordinary employee's the sheet would get that one person's rows and nothing would look
   wrong.
5. **An OAuth client for gws.** `gws auth status` says `"client_config_exists": true`. Otherwise **the owner**
   hands over the `client_secret.json` of the project's OAuth client (type «Desktop app»), saved at the path
   that same answer gives as `client_config`. It is a secret: it travels outside the repo and stays in the
   user's home. Without an owner, `gws auth setup` creates project and client from scratch, but it needs
   `gcloud` and someone at ease with Google Cloud.
6. **Google.** `gws auth status` says `"token_valid": true` and names the `user`. Otherwise **the user** runs
   `gws auth login -s sheets` in their own terminal: it opens the browser, where they sign in with the account
   that can edit the spreadsheet.
   - «Access blocked» in the browser: the account is not among the test users of the OAuth client; **the
     owner** adds it on the project's OAuth consent screen.
   - Asked to sign in again every week: Google expires the sign-ins of a client still in «Testing» after seven
     days; **the owner** publishes it, or makes it internal to the organisation.

## What each error asks for

The first run is the real check: `python3 bin/odoo notices`. It asks for the spreadsheet's address once, and
whatever is still missing comes back as one of these:

- `Falta el programa gws`: step 3.
- `gws no tiene una sesión de Google`, `Google ya no acepta la sesión de gws`: step 6, and step 5 if the
  sign-in itself complains about the client.
- `Google Sheets: esta cuenta de Google no tiene permiso`, followed by Google's own words. If they speak of
  permission, whoever owns the spreadsheet shares it with that account as editor (reading alone is not enough
  to append). If they say the Sheets API has not been used or is disabled, **the owner** turns it on at the
  link they carry. If they speak of scopes, step 6 again, with `-s sheets`.
- `Google Sheets: la hoja no tiene la pestaña`: the spreadsheet lacks «Avisos Totales» or the «Avisos <año>»
  of the month being written, which someone has to add.
- `Google Sheets: no existe esa hoja de cálculo`: the address saved is wrong; `python3 bin/odoo sheet "<URL>"`
  saves the right one.
- `Google no responde`: the network, or a proxy in the way.
