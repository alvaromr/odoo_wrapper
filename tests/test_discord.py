"""Unit tests for the Discord bot: its token, the two calls that send a direct message and every refusal, offline."""

import io
import json
import os
import unittest
import urllib.error
from datetime import date, datetime, timedelta, timezone
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from harness import NORMAL, REST, ScriptedClient, logged, temp_state

from odoo_wrapper import cache
from odoo_wrapper import client as c
from odoo_wrapper import discord as dc
from odoo_wrapper import team_rules as tr

RECIPIENT, SENDER = 7, 9
CALENDAR = [{"calendar_id": [4, "Std"], "dayofweek": "0", "hour_from": 8.0, "hour_to": 9.0, "day_period": "morning"}]
FORM = "https://odoo.example/odoo/modificacion-fichaje/new?"


def stamp(day, hour, minute):
    return datetime(2026, 10, day, hour, minute).astimezone().astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def attendances(args, kwargs):
    if len(args) == 3:
        return [{"employee_id": [RECIPIENT, "Ana"], "check_in": stamp(19, 8, 0)}]
    return [
        {
            "employee_id": [RECIPIENT, "Ana"],
            "check_in": stamp(19, 8, 0),
            "check_out": False,
            "worked_hours": 0,
            "attendance_reason_ids": [NORMAL["id"]],
        }
    ]


def employees(staff, args):
    if isinstance(args[0][0], tuple):
        return [{"id": SENDER}] if SENDER in staff else []
    return [
        {
            "id": i,
            "name": "Ana",
            "resource_calendar_id": [4, "Std"],
            "user_id": False,
            "x_studio_discord": staff[i],
        }
        for i in args[0]
    ]


class DiscordOdoo(ScriptedClient):
    """A scripted Odoo for the notices: Ana (RECIPIENT) left a punch open on Monday 19/10/2026 against a one-hour
    day, the session's own employee is SENDER, and `jsonrpc` loads the window action unless `action_error` is set."""

    url = "https://odoo.example"

    def __init__(self, rows=None):
        self.staff = {RECIPIENT: "123", SENDER: "555"}
        super().__init__(
            {
                "hr.employee": lambda args, kwargs: employees(self.staff, args),
                "hr.attendance": attendances,
                "hr.attendance.reason": [NORMAL, REST],
                "resource.calendar.attendance": CALENDAR,
                **(rows or {}),
            }
        )
        self.labelled[("hr.employee", "discord")] = "x_studio_discord"
        self.employee_id = None
        self.actions, self.action_error = [], None

    def load_employee(self):
        self.employee_id = RECIPIENT

    def jsonrpc(self, path, params):
        self.actions.append((path, params))
        if self.action_error:
            raise self.action_error
        return {"id": 1466}


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
        self.addCleanup(cache.drop)
        self.requests = []

    def opener(self, *results):
        results = list(results)

        def urlopen(request, timeout):
            self.requests.append(
                (
                    request.get_method(),
                    request.full_url,
                    request.data and json.loads(request.data),
                    dict(request.header_items()),
                    timeout,
                )
            )
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
        self.assertEqual(
            (headers["Authorization"], headers["User-agent"], headers["Content-type"]),
            ("Bot tok", f"DiscordBot (https://github.com/alvaromr/odoo_wrapper, {dc.__version__})", "application/json"),
        )
        self.assertTrue(dc.configured())
        self.assertEqual(os.stat(dc.TOKEN_FILE).st_mode & 0o777, 0o600)
        with self.opener(refused(401)), self.assertRaises(dc.DiscordError) as caught:
            dc.save_token("bad")
        self.assertEqual(
            str(caught.exception), "Discord no acepta el token del bot: guárdalo de nuevo con odoo discord"
        )
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
        self.assertEqual(str(caught.exception), "No hay bot de Discord en este equipo: guárdalo con odoo discord")
        dc.write_private(dc.TOKEN_FILE, "tok")
        with self.opener({"id": "999"}, {"id": "1"}):
            dc.send("123", "hola")
        self.assertEqual(
            [r[:3] for r in self.requests],
            [
                ("POST", f"{dc.API}/users/@me/channels", {"recipient_id": "123"}),
                ("POST", f"{dc.API}/channels/999/messages", {"content": "hola"}),
            ],
        )
        self.assertEqual(self.requests[0][4], dc.TIMEOUT)
        self.assertEqual([r[3]["Authorization"] for r in self.requests], ["Bot tok", "Bot tok"])
        with self.opener({"id": "999"}, {"id": "2"}):
            dc.send("123", "hola", "https://odoo.example/odoo/approvals/23/approval.request/new")
        self.assertEqual(
            self.requests[-1][2],
            {
                "content": "hola",
                "components": [
                    {
                        "type": 1,
                        "components": [
                            {
                                "type": 2,
                                "style": 5,
                                "label": "Hacer la solicitud en Odoo",
                                "url": "https://odoo.example/odoo/approvals/23/approval.request/new",
                            }
                        ],
                    }
                ],
            },
        )

    def test_the_link_opens_a_new_request_of_the_category_found_by_name(self):
        odoo = ScriptedClient({"approval.category": [{"id": 23}]})
        odoo.url = "https://odoo.example"
        self.assertEqual(dc.request_link(odoo), "https://odoo.example/odoo/approvals/23/approval.request/new")
        self.assertEqual(
            odoo.queries,
            [("approval.category", "search_read", [[("name", "ilike", "fichaje")]], {"fields": ["id"], "limit": 1})],
        )
        odoo.rows["approval.category"] = []
        self.assertIsNone(dc.request_link(odoo))
        odoo.rows["approval.category"] = lambda args, kwargs: (_ for _ in ()).throw(dc.OdooError("sin acceso"))
        with patch.object(c, "_degraded", set()), logged() as out:
            self.assertIsNone(dc.request_link(odoo))
        self.assertEqual(
            out.getvalue(),
            "WARNING Odoo no da la categoría de las solicitudes de cambio: el aviso va sin botón (sin acceso)\n",
        )
        odoo.rows["approval.category"] = lambda args, kwargs: (_ for _ in ()).throw(dc.SessionExpired("caducada"))
        with self.assertRaises(dc.SessionExpired):
            dc.request_link(odoo)

    def test_the_own_request_is_the_notices_link_for_the_sessions_own_employee(self):
        odoo = DiscordOdoo({"approval.category": [{"id": 23}]})
        status, body = dc.own_request(odoo, "2026-10-19")
        self.assertEqual(status, 200)
        self.assertTrue(body["url"].startswith(FORM))
        self.assertEqual(odoo.actions, [("/web/action/load", {"action_id": "modificacion-fichaje"})])
        self.assertEqual(odoo.employee_id, RECIPIENT)
        empty = (200, {"url": "https://odoo.example/odoo/approvals/23/approval.request/new"})
        self.assertEqual(dc.own_request(odoo, "2026-10-20"), empty)
        self.assertEqual(dc.own_request(odoo, None), empty)
        odoo.action_error = dc.OdooError("no existe")
        with logged():
            self.assertEqual(dc.own_request(odoo, "2026-10-19"), empty)
        odoo.rows["approval.category"] = []
        self.assertEqual(
            dc.own_request(odoo, "2026-10-20"),
            (409, {"error": "Odoo no tiene la categoría de solicitudes de cambio de fichaje"}),
        )

    def test_every_refusal_reads_in_words(self):
        dc.write_private(dc.TOKEN_FILE, "tok")
        cases = [
            (
                refused(403, json.dumps({"code": dc.CANNOT_MESSAGE}).encode()),
                "Discord no deja al bot escribirle: no está en su servidor o no acepta mensajes privados de él",
            ),
            (refused(404, json.dumps({"code": dc.UNKNOWN_USER}).encode()), "Discord no conoce ese ID de usuario"),
            (
                refused(400, json.dumps({"code": 50035, "message": "Invalid Form Body"}).encode()),
                "Discord respondió 400: Invalid Form Body",
            ),
            (refused(502, b"<html>", "Bad Gateway"), "Discord respondió 502: Bad Gateway"),
            (urllib.error.URLError("sin red"), "Discord no responde"),
            (TimeoutError(), "Discord no responde"),
        ]
        for error, words in cases:
            with self.opener(error), self.assertRaises(dc.DiscordError) as caught:
                dc.send("123", "hola")
            self.assertEqual(str(caught.exception), words)

    def test_the_sender_is_their_own_discord_id_from_their_employee_record(self):
        odoo = ScriptedClient({"hr.employee": [{"id": 9, "x_studio_discord": "555"}]})
        odoo.labelled[("hr.employee", "discord")] = "x_studio_discord"
        self.assertEqual(dc.sender_id(odoo), "555")
        self.assertEqual(
            odoo.queries,
            [
                ("hr.employee", "search_read", [[("user_id", "=", 3)]], {"fields": ["id"], "limit": 1}),
                ("hr.employee", "read", [[9], ["name", "x_studio_discord"]], None),
            ],
        )
        odoo.rows["hr.employee"] = [{"id": 9, "x_studio_discord": "elena_dc"}]
        self.assertIsNone(dc.sender_id(odoo))
        odoo.rows["hr.employee"] = []
        self.assertIsNone(dc.sender_id(odoo))

    def test_a_test_goes_to_whoever_asks_and_nobody_else(self):
        odoo = DiscordOdoo({"approval.category": [{"id": 23}]})
        dc.write_private(dc.TOKEN_FILE, "tok")
        del odoo.staff[SENDER]
        with self.opener():
            self.assertEqual(
                dc.send_test(odoo),
                (409, {"error": "No se encuentra tu ID de Discord en tu ficha de Odoo, o tu usuario no puede leerlo"}),
            )
        self.assertEqual(self.requests, [])
        odoo.staff[SENDER] = "555"
        with self.opener({"id": "999"}, {"id": "1"}):
            self.assertEqual(dc.send_test(odoo), (200, {"ok": True}))
        self.assertEqual(
            [r[2] for r in self.requests],
            [
                {"recipient_id": "555"},
                {
                    "content": dc.TEST_TEXT,
                    "components": [
                        {
                            "type": 1,
                            "components": [
                                {
                                    "type": 2,
                                    "style": 5,
                                    "label": dc.LINK_LABEL,
                                    "url": "https://odoo.example/odoo/approvals/23/approval.request/new",
                                }
                            ],
                        }
                    ],
                },
            ],
        )
        with self.opener(urllib.error.URLError("sin red")):
            self.assertEqual(dc.send_test(odoo), (502, {"error": "Discord no responde"}))

    def test_message_employee_checks_the_request_and_reads_the_recipient_from_odoo(self):
        odoo = DiscordOdoo()
        dc.write_private(dc.TOKEN_FILE, "tok")
        for body in ({"employee": "7", "text": "hola"}, {"employee": True, "text": "hola"}):
            self.assertEqual(
                dc.message_employee(odoo, body), (400, {"error": f"Empleado no válido: {body['employee']}"})
            )
        for text in (None, "  "):
            self.assertEqual(
                dc.message_employee(odoo, {"employee": 7, "text": text}), (400, {"error": "El mensaje no tiene texto"})
            )
        footer = "\n\n-# Este mensaje es automático: si tienes dudas, escribe a <@555>."
        sender = odoo.staff.pop(SENDER)
        self.assertEqual(
            dc.message_employee(odoo, {"employee": 7, "text": "hola"}),
            (409, {"error": "Tu ficha de Odoo no tiene tu ID de Discord: el aviso no diría a quién escribir"}),
        )
        self.assertEqual(odoo.queries[0], ("hr.employee", "read", [[7], ["name", "x_studio_discord"]], None))
        odoo.staff[SENDER] = sender
        status, body = dc.message_employee(odoo, {"employee": 7, "text": "x" * (dc.MESSAGE_MAX - len(footer) + 1)})
        self.assertEqual((status, body["error"]), (400, "El mensaje no cabe: Discord admite hasta 2000 caracteres"))
        self.assertEqual(self.requests, [])
        fitting = "x" * (dc.MESSAGE_MAX - len(footer))
        with self.opener({"id": "999"}, {"id": "1"}, {"id": "999"}, {"id": "2"}):
            self.assertEqual(dc.message_employee(odoo, {"employee": 7, "text": fitting}), (200, {"ok": True}))
            self.assertEqual(dc.message_employee(odoo, {"employee": 7, "text": " hola "}), (200, {"ok": True}))
        self.assertEqual(
            [r[2] for r in self.requests],
            [
                {"recipient_id": "123"},
                {"content": fitting + footer},
                {"recipient_id": "123"},
                {"content": "hola" + footer},
            ],
        )
        with self.opener(urllib.error.URLError("sin red")):
            self.assertEqual(
                dc.message_employee(odoo, {"employee": 7, "text": "hola"}), (502, {"error": "Discord no responde"})
            )
        self.assertEqual(len(self.requests), 5)
        odoo.staff[RECIPIENT] = "elena_dc"
        self.assertEqual(
            dc.message_employee(odoo, {"employee": 7, "text": "hola"}),
            (409, {"error": "Su ficha de Odoo no tiene un ID de Discord numérico"}),
        )
        odoo.labelled.clear()
        self.assertEqual(dc.message_employee(odoo, {"employee": 7, "text": "hola"})[0], 409)
        self.assertEqual(len(self.requests), 5)

    def test_a_notice_of_a_day_odoo_has_brings_the_filled_form_and_asks_to_check_it(self):
        odoo = DiscordOdoo()
        dc.write_private(dc.TOKEN_FILE, "tok")
        with self.opener({"id": "999"}, {"id": "1"}):
            self.assertEqual(
                dc.message_employee(odoo, {"employee": 7, "date": "2026-10-19", "text": "hola"}), (200, {"ok": True})
            )
        self.assertEqual(self.requests[0][2], {"recipient_id": "123"})
        message = self.requests[1][2]
        self.assertEqual(
            message["content"],
            "hola\n\n-# Este mensaje es automático: si tienes dudas, escribe a "
            "<@555>.\n-# El botón te deja la solicitud preparada: **revisa** bien las "
            "horas antes de enviarla.",
        )
        link = message["components"][0]["components"][0]["url"]
        self.assertTrue(link.startswith(FORM))
        self.assertEqual(
            parse_qs(urlsplit(link).query)["motivo"],
            ["Fichaje incorrecto: lunes 19/10/2026, entrada a las 08:00 sin salida. Corrección: de 08:00 a 09:00."],
        )


def local(day, hour, minute, second=0):
    return datetime(2026, 10, day, hour, minute, second).astimezone().isoformat()


def punch(day, start, end=None, hours=None):
    return {"in": local(day, *start), "out": end and local(*end), "hours": hours}


class ProposalTest(unittest.TestCase):
    def setUp(self):
        self.addCleanup(cache.drop)

    def test_an_open_punch_runs_from_its_check_in_to_the_hours_the_day_lacked(self):
        day = {
            "date": "2026-10-19",
            "flags": ["open"],
            "target": 8.5,
            "sessions": [punch(19, (8, 0, 30), (19, 10, 0), 2.0), punch(19, (12, 29, 14))],
        }
        start, end, reason = dc.proposal(day)
        self.assertEqual((dc.clock(start), dc.clock(end)), ("12:29", "18:59"))
        self.assertEqual(
            reason,
            "Fichaje incorrecto: lunes 19/10/2026, entrada a las 12:29 sin salida. Corrección: de 12:29 a 18:59.",
        )

    def test_a_long_day_proposes_its_longest_punch_and_never_past_the_day(self):
        overnight = {
            "date": "2026-10-19",
            "flags": ["long"],
            "target": 8.5,
            "sessions": [punch(19, (9, 7, 59), (19, 15, 31), 6.39), punch(19, (16, 10, 7), (20, 8, 59), 16.82)],
        }
        start, end, reason = dc.proposal(overnight)
        self.assertEqual((dc.clock(start), dc.clock(end)), ("16:10", "18:16"))
        self.assertEqual(
            reason,
            "Fichaje incorrecto: lunes 19/10/2026, de 16:10 a martes 20/10/2026 08:59 (16h 49m). "
            "Corrección: de 16:10 a 18:16.",
        )
        same_day = {
            "date": "2026-10-19",
            "flags": ["long"],
            "target": 30,
            "sessions": [punch(19, (8, 0), (19, 22, 0), 14.0)],
        }
        self.assertEqual(
            dc.proposal(same_day)[2],
            "Fichaje incorrecto: lunes 19/10/2026, de 08:00 a 22:00 (14h). Corrección: de 08:00 a 23:59.",
        )
        unmeasured = {
            "date": "2026-10-19",
            "flags": ["open"],
            "target": 2,
            "sessions": [punch(19, (8, 0), (19, 9, 0)), punch(19, (12, 0))],
        }
        self.assertEqual(dc.clock(dc.proposal(unmeasured)[1]), "14:00")
        idle = dict(same_day, target=0)
        self.assertEqual(dc.clock(dc.proposal(idle)[1]), "08:00")

    def test_a_day_without_punches_leaves_the_period_and_the_correction_blank(self):
        empty = {"date": "2026-10-15", "flags": ["empty"], "target": 8, "sessions": []}
        self.assertEqual(
            dc.proposal(empty),
            (None, None, "Fichaje incorrecto: jueves 15/10/2026, sin fichajes (jornada prevista de 8h). Corrección: "),
        )
        self.assertIsNone(dc.proposal(dict(empty, flags=[])))

    def test_durations_drop_a_zero_part(self):
        self.assertEqual([dc.duration(h) for h in (16.82, 14, 0.5, 0)], ["16h 49m", "14h", "30m", "0h"])

    def test_the_day_is_read_again_from_odoo(self):
        odoo = DiscordOdoo()
        day = dc.notice_day(odoo, RECIPIENT, "2026-10-19")
        self.assertEqual((day["date"], day["flags"], day["target"]), ("2026-10-19", ["open"], 1))
        self.assertEqual(len(day["sessions"]), 1)
        quiet = dc.notice_day(odoo, RECIPIENT, "2026-10-21")
        self.assertEqual((quiet["date"], quiet["flags"]), ("2026-10-21", []))
        punches = [q for q in odoo.queries if q[0] == "hr.attendance" and q[1] == "search_read"]
        self.assertEqual(len(punches), 1)
        self.assertEqual(punches[0][2][0][1], ("check_in", ">=", tr.odoo_time(date(2026, 10, 19))))
        self.assertIsNone(dc.notice_day(odoo, 8, "2026-10-19"))
        for bogus in (None, "ayer", 5):
            self.assertIsNone(dc.notice_day(odoo, RECIPIENT, bogus))

    def test_the_link_fills_the_form_only_when_odoo_has_the_action(self):
        odoo = DiscordOdoo()
        open_day = {"date": "2026-10-19", "flags": ["open"], "target": 1, "sessions": [punch(19, (8, 0))]}
        link = dc.prefilled_link(odoo, open_day)
        self.assertEqual(odoo.actions, [("/web/action/load", {"action_id": "modificacion-fichaje"})])
        start = datetime.fromisoformat(local(19, 8, 0)).astimezone(timezone.utc)
        self.assertTrue(link.startswith("https://odoo.example/odoo/modificacion-fichaje/new?desde="))
        query = parse_qs(urlsplit(link).query)
        self.assertEqual(query["desde"], [start.strftime("%Y-%m-%d %H:%M:%S")])
        self.assertEqual(query["hasta"], [(start + timedelta(hours=1)).strftime("%Y-%m-%d %H:%M:%S")])
        self.assertEqual(
            query["motivo"],
            ["Fichaje incorrecto: lunes 19/10/2026, entrada a las 08:00 sin salida. Corrección: de 08:00 a 09:00."],
        )
        self.assertNotIn(".", urlsplit(link).query)
        self.assertNotIn("+", urlsplit(link).query)
        self.assertIn("%2E", urlsplit(link).query)
        blank = dc.prefilled_link(odoo, {"date": "2026-10-15", "flags": ["empty"], "target": 8, "sessions": []})
        self.assertEqual(sorted(parse_qs(urlsplit(blank).query)), ["motivo"])
        self.assertIsNone(dc.prefilled_link(odoo, None))
        self.assertIsNone(dc.prefilled_link(odoo, dict(open_day, flags=[])))
        odoo.action_error = dc.OdooError("no existe")
        with logged() as out:
            self.assertIsNone(dc.prefilled_link(odoo, open_day))
        self.assertEqual(
            out.getvalue(),
            "WARNING Odoo no carga la acción modificacion-fichaje (no existe): el enlace abre la solicitud vacía\n",
        )
        odoo.action_error = dc.SessionExpired("caducada")
        with self.assertRaises(dc.SessionExpired):
            dc.prefilled_link(odoo, open_day)


if __name__ == "__main__":
    unittest.main()
