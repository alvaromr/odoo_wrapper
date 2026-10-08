"""Unit tests for the Google Sheets side: the credentials asked of gws, the token trade and both requests, against a
scripted opener."""

import io
import json
import unittest
import urllib.error
import urllib.parse
from types import SimpleNamespace
from unittest.mock import patch

import helpers  # noqa: F401
from odoo_wrapper import sheets as sh

EXPORTED = {"type": "authorized_user", "client_id": "cid", "client_secret": "s3cret", "refresh_token": "r3fresh"}
TOKEN = {"access_token": "tok", "expires_in": 3599}
VALUES = "https://sheets.googleapis.com/v4/spreadsheets/hoja/values/"


def refused(code, body):
    return urllib.error.HTTPError("https://google.example", code, "refused", {}, io.BytesIO(body.encode()))


class Opener:
    """Answers each request with the next scripted reply, a JSON body or the error to raise, and keeps them."""

    def __init__(self, *replies):
        self.replies = list(replies)
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return io.BytesIO(reply if isinstance(reply, bytes) else json.dumps(reply).encode())


class CredentialsTest(unittest.TestCase):
    def export(self, stdout=json.dumps(EXPORTED).encode(), which="/bin/gws", **run):
        with patch.object(sh.shutil, "which", return_value=which) as which, \
                patch.object(sh.subprocess, "run", return_value=SimpleNamespace(stdout=stdout), **run) as ran:
            self.which, self.ran = which, ran
            return sh.credentials()

    def test_gws_is_asked_for_its_credentials_by_the_path_it_was_found_at(self):
        self.assertEqual(self.export(), {"client_id": "cid", "client_secret": "s3cret", "refresh_token": "r3fresh"})
        self.which.assert_called_once_with("gws")
        self.ran.assert_called_once_with(["/bin/gws", "auth", "export", "--unmasked"], capture_output=True)

    def test_without_gws_it_says_so(self):
        with self.assertRaisesRegex(sh.SheetsError, "Falta el programa gws"):
            self.export(which=None)
        self.ran.assert_not_called()

    def test_anything_but_credentials_is_gws_signed_out(self):
        for stdout in (b"", b"error[auth]: no credentials", b"[1]", b'{"client_id": "cid"}'):
            with self.assertRaisesRegex(sh.SheetsError, "gws no tiene una sesión de Google. Ejecuta: gws auth login"):
                self.export(stdout)
        with self.assertRaisesRegex(sh.SheetsError, "gws no tiene una sesión de Google"):
            self.export(side_effect=OSError("no se puede ejecutar"))


class SheetsTest(unittest.TestCase):
    def setUp(self):
        patcher = patch.object(sh, "credentials", return_value={k: EXPORTED[k] for k in sh.CREDENTIALS})
        patcher.start()
        self.addCleanup(patcher.stop)

    def sheets(self, *replies):
        sheets = sh.Sheets("hoja")
        sheets.opener = Opener(*replies)
        return sheets

    def failure(self, *replies):
        with self.assertRaises(sh.SheetsError) as caught:
            self.sheets(*replies).get("Avisos 2026!B4:E")
        self.assertNotIn("s3cret", str(caught.exception))
        self.assertNotIn("r3fresh", str(caught.exception))
        return str(caught.exception)

    def test_the_credentials_are_traded_for_a_token_once_and_a_range_read_unformatted(self):
        sheets = self.sheets(TOKEN, {"range": "x", "values": [["Bea", "Septiembre", 46267]]}, {"range": "x"})
        self.assertEqual(sheets.get("Avisos 2026!B4:E"), [["Bea", "Septiembre", 46267]])
        self.assertEqual(sheets.get("Avisos Totales!D4:D"), [])
        trade, read, again = sheets.opener.requests
        self.assertEqual((trade.full_url, trade.get_method()), (sh.TOKEN_URL, "POST"))
        self.assertEqual(dict(urllib.parse.parse_qsl(trade.data.decode())), {
            "client_id": "cid", "client_secret": "s3cret", "refresh_token": "r3fresh", "grant_type": "refresh_token"})
        self.assertEqual(read.full_url, VALUES + "Avisos%202026%21B4%3AE?valueRenderOption=UNFORMATTED_VALUE")
        self.assertEqual((read.get_method(), read.get_header("Authorization")), ("GET", "Bearer tok"))
        self.assertEqual(again.get_header("Authorization"), "Bearer tok")

    def test_rows_are_appended_as_typed_over_the_empty_rows_and_none_asks_nothing(self):
        sheets = self.sheets(TOKEN, {"updates": {"updatedRows": 1}})
        sheets.append("Avisos Totales!B4:D", [])
        self.assertEqual(sheets.opener.requests, [])
        sheets.append("Avisos Totales!B4:D", [["Íñigo Peña", 2, "Septiembre"]])
        post = sheets.opener.requests[1]
        self.assertEqual(post.full_url, VALUES + "Avisos%20Totales%21B4%3AD:append"
                                                 "?valueInputOption=USER_ENTERED&insertDataOption=OVERWRITE")
        self.assertEqual((post.get_method(), post.get_header("Content-type")), ("POST", "application/json"))
        self.assertEqual(json.loads(post.data), {"values": [["Íñigo Peña", 2, "Septiembre"]]})

    def test_a_token_google_will_not_give_asks_to_sign_in_again(self):
        for reply in (refused(400, '{"error": "invalid_grant", "error_description": "Token has been revoked."}'),
                      {"token_type": "Bearer"}, ["tok"]):
            self.assertEqual(self.failure(reply), "Google ya no acepta la sesión de gws. Ejecuta: gws auth login -s sheets")

    def test_what_google_refuses_comes_with_what_it_means_here_and_its_own_words(self):
        said = '{"error": {"code": %d, "message": "Google dice", "status": "X"}}'
        for code, hint in sh.HINTS.items():
            self.assertEqual(self.failure(TOKEN, refused(code, said % code)), f"Google Sheets: {hint} (Google dice)")
        self.assertEqual(self.failure(TOKEN, refused(500, "<html>")), "Google Sheets: no admite la petición (HTTP 500)")
        self.assertEqual(self.failure(TOKEN, refused(429, '{"error": "lento"}')),
                         "Google Sheets: no admite la petición (HTTP 429)")

    def test_google_out_of_reach_or_answering_something_else_is_said_plainly(self):
        self.assertEqual(self.failure(urllib.error.URLError("sin red")), "Google no responde (sin red)")
        self.assertEqual(self.failure(TOKEN, urllib.error.URLError("timed out")), "Google no responde (timed out)")
        self.assertEqual(self.failure(TOKEN, b"<html>portal</html>"), "Google no responde (su respuesta no es JSON)")


if __name__ == "__main__":
    unittest.main()
