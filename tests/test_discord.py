"""Unit tests for the Discord bot: its token, the two calls that send a direct message and every refusal, offline."""

import io
import json
import os
import unittest
import urllib.error
from unittest.mock import patch

from helpers import ScriptedClient, temp_state
from odoo_wrapper import discord as dc


class Answer(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def answer(body):
    return Answer(json.dumps(body).encode())


def refused(status, body=b"", reason="Forbidden"):
    return urllib.error.HTTPError(dc.API, status, reason, {}, io.BytesIO(body))


class DiscordTest(unittest.TestCase):
    def setUp(self):
        self.home = temp_state(self)
        self.requests = []

    def opener(self, *results):
        results = list(results)

        def urlopen(request, timeout):
            self.requests.append((request.get_method(), request.full_url, request.data and json.loads(request.data),
                                  dict(request.header_items()), timeout))
            result = results.pop(0)
            if isinstance(result, Exception):
                raise result
            return answer(result)
        return patch.object(dc.urllib.request, "urlopen", side_effect=urlopen)

    def test_the_token_is_checked_with_discord_and_kept_private(self):
        self.assertFalse(dc.configured())
        with self.opener({"username": "Odoo"}):
            self.assertEqual(dc.save_token("tok"), "Odoo")
        method, url, body, headers, _ = self.requests[0]
        self.assertEqual((method, url, body), ("GET", f"{dc.API}/users/@me", None))
        self.assertEqual((headers["Authorization"], headers["User-agent"]), ("Bot tok", dc.USER_AGENT))
        self.assertTrue(dc.configured())
        self.assertEqual(os.stat(dc.TOKEN_FILE).st_mode & 0o777, 0o600)
        with self.opener(refused(401)), self.assertRaises(dc.DiscordError) as caught:
            dc.save_token("bad")
        self.assertIn("no acepta el token", str(caught.exception))
        self.assertEqual(dc.read_private(dc.TOKEN_FILE), "tok")

    def test_the_page_sets_the_token_and_learns_only_the_bot_name(self):
        for token in (None, 5, "  "):
            self.assertEqual(dc.set_token(token), (400, {"error": "Falta el token del bot"}))
        with self.opener({"username": "Odoo"}):
            self.assertEqual(dc.set_token(" tok "), (200, {"bot": "Odoo"}))
        self.assertEqual(dc.read_private(dc.TOKEN_FILE), "tok")
        with self.opener(refused(401)):
            status, body = dc.set_token("bad")
        self.assertEqual(status, 400)
        self.assertIn("no acepta el token", body["error"])
        self.assertEqual(dc.read_private(dc.TOKEN_FILE), "tok")

    def test_a_message_opens_the_conversation_and_posts_into_it(self):
        with self.assertRaises(dc.DiscordError) as caught:
            dc.send("123", "hola")
        self.assertIn("odoo discord", str(caught.exception))
        dc.write_private(dc.TOKEN_FILE, "tok")
        with self.opener({"id": "999"}, {"id": "1"}):
            dc.send("123", "hola")
        self.assertEqual([r[:3] for r in self.requests], [
            ("POST", f"{dc.API}/users/@me/channels", {"recipient_id": "123"}),
            ("POST", f"{dc.API}/channels/999/messages", {"content": "hola"}),
        ])
        self.assertEqual(self.requests[0][4], dc.TIMEOUT)

    def test_every_refusal_reads_in_words(self):
        dc.write_private(dc.TOKEN_FILE, "tok")
        cases = [
            (refused(403, json.dumps({"code": dc.CANNOT_MESSAGE}).encode()), "no deja al bot escribirle"),
            (refused(404, json.dumps({"code": dc.UNKNOWN_USER}).encode()), "no conoce ese ID"),
            (refused(400, json.dumps({"code": 50035, "message": "Invalid Form Body"}).encode()),
             "Discord respondió 400: Invalid Form Body"),
            (refused(502, b"<html>", "Bad Gateway"), "Discord respondió 502: Bad Gateway"),
            (urllib.error.URLError("sin red"), "Discord no responde"),
            (TimeoutError(), "Discord no responde"),
        ]
        for error, words in cases:
            with self.opener(error), self.assertRaises(dc.DiscordError) as caught:
                dc.send("123", "hola")
            self.assertIn(words, str(caught.exception))

    def test_the_sender_is_their_own_discord_id_from_their_employee_record(self):
        odoo = ScriptedClient({"hr.employee": [{"id": 9, "x_studio_discord": "555"}]})
        odoo.labelled[("hr.employee", "discord")] = "x_studio_discord"
        self.assertEqual(dc.sender_id(odoo), "555")
        self.assertEqual(odoo.calls[-2], ("hr.employee", [[("user_id", "=", 3)]], {"fields": ["id"], "limit": 1}))
        odoo.rows["hr.employee"] = [{"id": 9, "x_studio_discord": "elena_dc"}]
        self.assertIsNone(dc.sender_id(odoo))
        odoo.rows["hr.employee"] = []
        self.assertIsNone(dc.sender_id(odoo))

    def test_message_employee_checks_the_request_and_reads_the_recipient_from_odoo(self):
        odoo = ScriptedClient({"hr.employee": [{"id": 7, "x_studio_discord": "123"}]})
        odoo.labelled[("hr.employee", "discord")] = "x_studio_discord"
        for body in ({"employee": "7", "text": "hola"}, {"employee": True, "text": "hola"}):
            self.assertEqual(dc.message_employee(odoo, body)[0], 400)
        for text in (None, "  "):
            self.assertEqual(dc.message_employee(odoo, {"employee": 7, "text": text}), (400, {"error": "El mensaje no tiene texto"}))
        footer = "\n\n-# Este mensaje es automático: si tienes dudas, escribe a <@555>."
        with patch.object(dc, "send") as send, patch.object(dc, "sender_id", return_value=None) as sender:
            self.assertEqual(dc.message_employee(odoo, {"employee": 7, "text": "hola"})[0], 409)
            sender.return_value = "555"
            status, body = dc.message_employee(odoo, {"employee": 7, "text": "x" * (dc.MESSAGE_MAX - len(footer) + 1)})
            self.assertEqual((status, body["error"]), (400, "El mensaje no cabe: Discord admite hasta 2000 caracteres"))
            self.assertEqual(dc.message_employee(odoo, {"employee": 7, "text": " hola "}), (200, {"ok": True}))
            send.assert_called_once_with("123", "hola" + footer)
            sender.assert_called_with(odoo)
            send.side_effect = dc.DiscordError("Discord no responde")
            self.assertEqual(dc.message_employee(odoo, {"employee": 7, "text": "hola"}),
                             (502, {"error": "Discord no responde"}))
            odoo.rows["hr.employee"] = [{"id": 7, "x_studio_discord": "elena_dc"}]
            self.assertEqual(dc.message_employee(odoo, {"employee": 7, "text": "hola"})[0], 409)
            odoo.labelled.clear()
            self.assertEqual(dc.message_employee(odoo, {"employee": 7, "text": "hola"})[0], 409)
        self.assertEqual(send.call_count, 2)


if __name__ == "__main__":
    unittest.main()
