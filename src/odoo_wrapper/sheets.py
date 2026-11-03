"""Google Sheets for the warnings spreadsheet: reading a range and appending rows, as gws's Google account.

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
- Types. Google's answer is JSON that send() returns as Any, the one place it enters untyped; each caller declares
  the fields it reads (Token, Values). A cell is what Sheets stores unformatted: text, a number (a date is its
  serial) or a boolean.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Sequence
from typing import Any, TypedDict, Union, cast

Cell = Union[str, int, float, bool]

API = "https://sheets.googleapis.com/v4/spreadsheets"
TOKEN_URL = "https://oauth2.googleapis.com/token"  # noqa: S105 - a URL, not a password
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
    """A failure the user can act on, in their words."""


class Token(TypedDict):
    """Google's answer to the token request: the access token."""

    access_token: str


class Values(TypedDict, total=False):
    """Google's answer to a request on a range, of which the rows are read."""

    values: list[list[Cell]]


def credentials() -> dict[str, str]:
    """Return the client id, secret and refresh token gws holds for the Google account it is signed in with."""
    gws = shutil.which("gws")
    if not gws:
        raise SheetsError("Falta el programa gws, con el que se inicia sesión en Google")
    try:
        answer = json.loads(subprocess.run([gws, *EXPORT], check=False, capture_output=True).stdout)
        return {key: answer[key] for key in CREDENTIALS}
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise SheetsError(f"gws no tiene una sesión de Google. Ejecuta: {LOGIN}") from error


def send(opener: urllib.request.OpenerDirector, request: urllib.request.Request) -> Any:
    """Make a request to Google and return its JSON answer; Google's own refusals are raised as they come."""
    try:
        with opener.open(request, timeout=TIMEOUT) as response:
            return json.load(response)
    except urllib.error.HTTPError:
        raise
    except urllib.error.URLError as error:
        raise SheetsError(f"Google no responde ({error.reason})") from error
    except ValueError as error:
        raise SheetsError("Google no responde (su respuesta no es JSON)") from error


def reason(error: urllib.error.HTTPError) -> str:
    """Return Google's message for a refused request, or its HTTP status."""
    try:
        return cast("str", json.load(error)["error"]["message"])
    except (ValueError, KeyError, TypeError):
        return f"HTTP {error.code}"


class Sheets:
    """One spreadsheet, by its id, read and appended to with an access token traded on first use."""

    def __init__(self, spreadsheet: str) -> None:
        self.id = spreadsheet
        self.opener = urllib.request.build_opener()
        self.token: str | None = None

    def _authorize(self) -> None:
        body = urllib.parse.urlencode(dict(credentials(), grant_type="refresh_token")).encode()
        expired = f"Google ya no acepta la sesión de gws. Ejecuta: {LOGIN}"
        try:
            answer: Token = send(self.opener, urllib.request.Request(TOKEN_URL, data=body))
        except urllib.error.HTTPError as error:
            with error:
                raise SheetsError(expired) from error
        try:
            self.token = answer["access_token"]
        except (KeyError, TypeError) as error:
            raise SheetsError(expired) from error

    def _call(self, cells: str, verb: str = "", rows: Sequence[Sequence[Cell]] | None = None, **query: str) -> Values:
        if not self.token:
            self._authorize()
        quoted = urllib.parse.quote(cells, safe="")  # pragma: no mutate - letters are never quoted: safe="XXXX" is ""
        url = f"{API}/{self.id}/values/{quoted}{verb}?{urllib.parse.urlencode(query)}"
        # pragma: no mutate start - header names ignore case
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
        }
        # pragma: no mutate end
        data = json.dumps({"values": rows}).encode() if rows else None
        try:
            answer: Values = send(self.opener, urllib.request.Request(url, data=data, headers=headers))
        except urllib.error.HTTPError as error:
            with error:
                raise SheetsError(
                    f"Google Sheets: {HINTS.get(error.code, 'no admite la petición')} ({reason(error)})"
                ) from error
        return answer

    def get(self, cells: str) -> list[list[Cell]]:
        """Return the rows of a range, unformatted."""
        return self._call(cells, valueRenderOption="UNFORMATTED_VALUE").get("values", [])

    def append(self, cells: str, rows: Sequence[Sequence[Cell]]) -> None:
        """Write rows after the last row of the table in a range, as if typed."""
        if rows:
            self._call(cells, ":append", rows, valueInputOption="USER_ENTERED", insertDataOption="OVERWRITE")
