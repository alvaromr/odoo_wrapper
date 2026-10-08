"""Google Sheets for the warnings spreadsheet: reading a range and appending rows to it, as the Google account
the gws CLI is signed in with.

- gws (googleworkspace/cli) is the one external tool this package runs, agreed as the exception to its «no
  dependencies» rule, and only `odoo notices` needs it. It is here for the part not worth writing again: the
  OAuth sign-in in a browser and keeping its refresh token in the OS keyring.
- It is asked for one thing only, `gws auth export --unmasked`, and the requests are made here. Its own request
  commands take their JSON as command-line arguments, which do not survive every way a Windows machine may have
  it installed (npm leaves a .cmd shim, and cmd.exe has its own idea of quotes). A command with nothing to quote
  runs the same everywhere, and so does the HTTP below: one code path for every platform, all of it under test.
- What it prints (client id and secret, refresh token) lives in this process just long enough to be traded for
  an access token: never written, logged or put in an error message.
- Cells are read unformatted, so a date comes back as the serial number Sheets stores, whatever format its cell
  shows, and written as if typed (USER_ENTERED), so «02/09/2026» becomes a date in the spreadsheet's locale.
  append writes after the last row of the table found in the range, over the empty rows the sheet already has
  (OVERWRITE), which keeps their dropdowns and formats.
- Every failure is a SheetsError the user can act on, never a traceback: gws missing or signed out, Google out of
  reach, and Google's own refusals, each with what it usually means here (HINTS) next to Google's message.
"""

import json
import shutil
import subprocess
import urllib.error
import urllib.parse
import urllib.request

API = "https://sheets.googleapis.com/v4/spreadsheets"
TOKEN_URL = "https://oauth2.googleapis.com/token"
EXPORT = ("auth", "export", "--unmasked")
CREDENTIALS = ("client_id", "client_secret", "refresh_token")
LOGIN = "gws auth login -s sheets"
TIMEOUT = 30
HINTS = {
    400: "la hoja no tiene la pestaña o el rango que se le pide",
    403: "esta cuenta de Google no tiene permiso: la hoja debe estar compartida con ella como editor, la sesión "
         "de gws incluir Google Sheets y el proyecto tener activada su API",
    404: "no existe esa hoja de cálculo, o esta cuenta de Google no puede verla",
}


class SheetsError(Exception):
    pass


def credentials():
    gws = shutil.which("gws")
    if not gws:
        raise SheetsError("Falta el programa gws, con el que se inicia sesión en Google")
    try:
        answer = json.loads(subprocess.run([gws, *EXPORT], capture_output=True).stdout)
        return {key: answer[key] for key in CREDENTIALS}
    except (OSError, ValueError, KeyError, TypeError):
        raise SheetsError(f"gws no tiene una sesión de Google. Ejecuta: {LOGIN}")


def send(opener, request):
    try:
        with opener.open(request, timeout=TIMEOUT) as response:
            return json.load(response)
    except urllib.error.HTTPError:
        raise
    except urllib.error.URLError as error:
        raise SheetsError(f"Google no responde ({error.reason})")
    except ValueError:
        raise SheetsError("Google no responde (su respuesta no es JSON)")


def reason(error):
    try:
        return json.load(error)["error"]["message"]
    except (ValueError, KeyError, TypeError):
        return f"HTTP {error.code}"


class Sheets:
    def __init__(self, spreadsheet):
        self.id = spreadsheet
        self.opener = urllib.request.build_opener()
        self.token = None

    def _authorize(self):
        body = urllib.parse.urlencode(dict(credentials(), grant_type="refresh_token")).encode()
        try:
            self.token = send(self.opener, urllib.request.Request(TOKEN_URL, data=body))["access_token"]
        except (urllib.error.HTTPError, KeyError, TypeError):
            raise SheetsError(f"Google ya no acepta la sesión de gws. Ejecuta: {LOGIN}")

    def _call(self, cells, verb="", rows=None, **query):
        if not self.token:
            self._authorize()
        url = f"{API}/{self.id}/values/{urllib.parse.quote(cells, safe='')}{verb}?{urllib.parse.urlencode(query)}"
        headers = {"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"}
        data = json.dumps({"values": rows}).encode() if rows else None
        try:
            return send(self.opener, urllib.request.Request(url, data=data, headers=headers))
        except urllib.error.HTTPError as error:
            raise SheetsError(f"Google Sheets: {HINTS.get(error.code, 'no admite la petición')} ({reason(error)})")

    def get(self, cells):
        return self._call(cells, valueRenderOption="UNFORMATTED_VALUE").get("values", [])

    def append(self, cells, rows):
        if rows:
            self._call(cells, ":append", rows, valueInputOption="USER_ENTERED", insertDataOption="OVERWRITE")
