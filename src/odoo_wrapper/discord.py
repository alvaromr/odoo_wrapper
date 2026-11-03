"""Direct messages from a Discord bot: the day dialog's notice of a punch to fix, sent to whoever made it.

- A link cannot do it: Discord opens a profile from a user id, but takes no message from a link, and it opens a
  conversation only by that conversation's own id, one per pair of people. So the dashboard sends the message
  itself, as a bot added to the company's server: Discord lets a bot open a direct message with anyone who shares
  a server with it and accepts direct messages from that server's members, the default. Two REST calls and no
  gateway connection, so nothing runs in between: POST /users/@me/channels with the recipient opens (or finds)
  the conversation, POST /channels/<id>/messages sends the text. The person sees it from the bot, not from whoever
  pressed the button: writing as a person would take that person's own token, which Discord forbids automating.
- The recipient is the employee's Discord user id, read from Odoo on every send (team.discord_of), never taken
  from the page, so a session can only write to people whose attendances it reads (server.py checks that first).
- Nobody reads the replies: the bot never connects, so an answer stays in that conversation unseen. Every
  message therefore closes with FOOTER, saying so and naming whom to write to instead: whoever sent it, as a
  Discord mention of the id on their own employee record (sender_id). Discord shows it with the name they go
  by there, not Odoo's legal one («Constanza Elena…» for someone everyone knows as Elena), and a click on it
  opens their profile, so they can always be reached; a sender without an id sends nothing. It is added here,
  so the page can neither leave it out nor change it, and as Discord's subtext («-# »), small and grey, so it
  does not compete with the notice itself.
- Under the text, a link button opens Odoo's form for a new attendance change request (request_link): the
  Approvals category found by name like team.py's requests, never by id. A link button is the one kind Discord
  lets a bot send without being told of the click, which would need the dashboard reachable from the
  internet. The request must be the employee's own, for legal reasons, so nothing is created for them: the
  button only opens the form they then send, or not, empty unless the action below fills it.
- Filled, when this Odoo has the window action REQUEST_ACTION (prefilled_link): Odoo 18's URL carries no
  default values, but its web client evaluates an action's context with the URL's query as `params`
  (action_service.js), so that action, created by hand like the Discord field, copies what the category's own
  «Nueva solicitud» button sets (create_request: subject, category, the user as owner, status) and takes
  desde, hasta and motivo from the query. It is web client internals, not an API, so an upgrade of Odoo may
  break it; without the action, or when it does not load, the button opens the category's empty form (the log
  says why), and without the category the message goes without it.
- What it fills (proposal) is the punch to fix as it stands, in the description, and a correction to check:
  an open punch or the longest one of a long day, from its check-in to the hours the day still lacked (never
  past that day's LAST_MINUTE, the check-in itself without a target). A day without punches leaves the period
  and the correction blank: nothing there says when the day was worked. Nobody but the employee knows the
  real times, so a last subtext line, after FOOTER, asks them to check it (REVIEW): sent as it comes, it
  would approve an estimate. The day is read again from Odoo (team.fetch_team, cached), never taken from the
  page.
- The same link opens from the personal page's own punch errors (own_request), whether or not the session may
  correct them: always the session's own employee, never one the page names. Without a date it is the empty form.
- The bot's token is a password: `odoo discord` asks for it without echo, and the management view's «Discord»
  dialog sends it once (set_token); either checks it with Discord (GET /users/@me, which also names the bot)
  and keeps it in TOKEN_FILE, mode 600, like the Odoo session. Nothing ever sends it back: the page only learns
  whether there is one (configured(), the team payload's can_message), and without it the day dialog offers
  only copying the message. The same dialog sends a test (send_test) to whoever asks, by their own Discord id,
  never to someone else: it proves the token, the sender's id and the link button in one go.
- Discord refuses a request without a User-Agent of its own form, DiscordBot (url, version). Its refusals come
  back as DiscordError in words the dialog shows: a token it no longer accepts, a person the bot may not write to,
  an id it does not know, anything else with Discord's own message; a network failure as Discord out of reach.
- Types. Discord's JSON is read as the one or two fields used (DiscordObject, DiscordRefusal), declared where it
  is parsed. The body of a notice is an object per key until notice_of has checked it, and what it returns is typed;
  a reply that only acknowledges is a Mapping[str, object].
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping
from datetime import date, datetime, time, timedelta, timezone
from typing import NamedTuple, TypedDict

from odoo_wrapper import __version__, data_rules, team, team_rules
from odoo_wrapper.client import (
    STATE_DIR,
    OdooClient,
    OdooError,
    SessionExpired,
    degrade,
    read_private,
    write_private,
)

API = "https://discord.com/api/v10"
TOKEN_FILE = os.path.join(STATE_DIR, "discord_token")
USER_AGENT = f"DiscordBot (https://github.com/alvaromr/odoo_wrapper, {__version__})"
TIMEOUT = 15
MESSAGE_MAX = 2000
FOOTER = "-# Este mensaje es automático: si tienes dudas, escribe a {}."
UNAUTHORIZED = 401
CANNOT_MESSAGE = 50007
UNKNOWN_USER = 10013
ACTION_ROW = 1
BUTTON = 2
LINK_STYLE = 5
LINK_LABEL = "Hacer la solicitud en Odoo"
TEST_TEXT = "Mensaje de prueba del dashboard de fichajes: el bot puede enviarte avisos."
REVIEW = "-# El botón te deja la solicitud preparada: **revisa** bien las horas antes de enviarla."
REQUEST_ACTION = "modificacion-fichaje"
LAST_MINUTE = time(23, 59)
WEEKDAYS = ("lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo")
log = logging.getLogger(__name__)


class DiscordError(Exception):
    """Discord refused or failed a call; the message is for the user."""


class DiscordRefusal(TypedDict, total=False):
    """What Discord answers to a refused call: its code and its own message."""

    code: int
    message: str


class DiscordObject(TypedDict, total=False):
    """What Discord answers to a call that worked, of which the bot's name and a conversation's id are read."""

    username: str
    id: str


class IdRow(TypedDict):
    """An Odoo record read for its id only."""

    id: int


class Notice(NamedTuple):
    """What the day dialog asks to send: the employee, the text and the day it is about, if the body says one."""

    employee: int
    text: str
    day: str | None


def refusal(error: urllib.error.HTTPError) -> str:
    """Return what a refusal from Discord means here, in the user's words."""
    answer: DiscordRefusal
    try:
        answer = json.loads(error.read())
    except ValueError:
        answer = {}
    if error.code == UNAUTHORIZED:
        return "Discord no acepta el token del bot: guárdalo de nuevo con odoo discord"
    if answer.get("code") == CANNOT_MESSAGE:
        return "Discord no deja al bot escribirle: no está en su servidor o no acepta mensajes privados de él"
    if answer.get("code") == UNKNOWN_USER:
        return "Discord no conoce ese ID de usuario"
    return f"Discord respondió {error.code}: {answer.get('message', error.reason)}"


def call(token: str, path: str, body: Mapping[str, object] | None = None) -> DiscordObject:
    """Call Discord's API as the bot and return its JSON answer, or raise DiscordError."""
    # pragma: no mutate start - header names ignore case
    headers = {
        "Authorization": f"Bot {token}",
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
    }
    # pragma: no mutate end
    request = urllib.request.Request(
        API + path, data=None if body is None else json.dumps(body).encode(), headers=headers
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            answer: DiscordObject = json.load(response)
            return answer
    except urllib.error.HTTPError as error:
        raise DiscordError(refusal(error)) from None
    except OSError:
        raise DiscordError("Discord no responde") from None


def configured() -> bool:
    """Tell whether this machine has the bot's token."""
    return bool(read_private(TOKEN_FILE))


def save_token(token: str) -> str:
    """Save a token Discord accepts and return its bot's name."""
    bot = call(token, "/users/@me")
    write_private(TOKEN_FILE, token)
    return bot["username"]


def set_token(token: object) -> tuple[int, Mapping[str, object]]:
    """Save the token the page sends and answer (status, payload)."""
    if not isinstance(token, str) or not token.strip():
        return 400, {"error": "Falta el token del bot"}
    try:
        return 200, {"bot": save_token(token.strip())}
    except DiscordError as error:
        return 400, {"error": str(error)}


def discord_id(client: OdooClient, employee_id: int) -> str | None:
    """Return the numeric Discord id on an employee's form, or None."""
    user = team.discord_of(client, employee_id)
    return user if user and user.isdigit() else None


def sender_id(client: OdooClient) -> str | None:
    """Return the Discord id of the session's own employee, or None."""
    mine: list[IdRow] = client.call_kw(
        "hr.employee", "search_read", [[("user_id", "=", client.session_info()["uid"])]], {"fields": ["id"], "limit": 1}
    )
    return discord_id(client, mine[0]["id"]) if mine else None


def request_link(client: OdooClient) -> str | None:
    """Return the link to an empty change request in Odoo, or None without its category."""
    try:
        found: list[IdRow] = client.call_kw(
            "approval.category",
            "search_read",
            [[("name", "ilike", team.REQUEST_CATEGORY)]],
            {"fields": ["id"], "limit": 1},
        )
    except SessionExpired:
        raise
    except OdooError as error:
        degrade("Odoo no da la categoría de las solicitudes de cambio: el aviso va sin botón", error)
        return None
    return f"{client.url}/odoo/approvals/{found[0]['id']}/approval.request/new" if found else None


def clock(moment: datetime) -> str:
    """Return a time as HH:MM."""
    return moment.strftime("%H:%M")


def day_name(moment: date) -> str:
    """Return a day as its Spanish weekday and date."""
    return f"{WEEKDAYS[moment.weekday()]} {moment.strftime('%d/%m/%Y')}"


def duration(hours: float) -> str:
    """Return hours as 7h 30m, without a zero part."""
    h, m = divmod(round(hours * 60), 60)
    return " ".join(part for part in (f"{h}h" if h or not m else "", f"{m}m" if m else "") if part)


def proposal(day: team_rules.Day) -> tuple[datetime | None, datetime | None, str] | None:
    """Return the start, end and reason a change request for a flagged day would carry, or None."""
    sessions, target, today = day["sessions"], day["target"], date.fromisoformat(day["date"])
    if {"open", "long"} & set(day["flags"]):
        wrong = next((s for s in sessions if not s["out"]), None) or max(sessions, key=data_rules.hours_of)
        start = datetime.fromisoformat(wrong["in"]).replace(second=0)
        done = sum(data_rules.hours_of(s) for s in sessions if s is not wrong)
        last = datetime.combine(today, LAST_MINUTE).astimezone()
        end = min(start + timedelta(hours=max(0, target - done)), last).replace(second=0)
        if wrong["out"]:
            out = datetime.fromisoformat(wrong["out"])
            until = clock(out) if out.date() == start.date() else f"{day_name(out)} {clock(out)}"
            what = f"de {clock(start)} a {until} ({duration(data_rules.hours_of(wrong))})"
        else:
            what = f"entrada a las {clock(start)} sin salida"
        correction = f"de {clock(start)} a {clock(end)}."
        return start, end, f"Fichaje incorrecto: {day_name(start)}, {what}. Corrección: {correction}"
    if "empty" in day["flags"]:
        return (
            None,
            None,
            (
                f"Fichaje incorrecto: {day_name(today)}, sin fichajes (jornada prevista de "
                f"{duration(target)}). Corrección: "
            ),
        )
    return None


def odoo_utc(moment: datetime) -> str:
    """Return a time as Odoo's UTC stamp."""
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def notice_day(client: OdooClient, employee: int | None, iso: str | None) -> team_rules.Day | None:
    """Return an employee's day as the management view reads it from Odoo, or None."""
    if iso is None:
        return None
    try:
        monday = team_rules.monday_of(date.fromisoformat(iso))
    except (TypeError, ValueError):
        return None
    found = next((e for e in team.fetch_team(client, (monday,))["employees"] if e["id"] == employee), None)
    return next(d for d in found["days"] if d["date"] == iso) if found else None


def prefilled_link(client: OdooClient, day: team_rules.Day | None) -> str | None:
    """Return the link to a change request filled for a flagged day, or None when it cannot be made."""
    filled = proposal(day) if day else None
    if not filled:
        return None
    try:
        client.jsonrpc("/web/action/load", {"action_id": REQUEST_ACTION})
    except SessionExpired:
        raise
    except OdooError as error:
        log.warning(f"Odoo no carga la acción {REQUEST_ACTION} ({error}): el enlace abre la solicitud vacía")
        return None
    start, end, reason = filled
    # pragma: no mutate start - start and end are both set or both None, so `and` and `or` are the same
    period = {"desde": odoo_utc(start), "hasta": odoo_utc(end)} if start and end else {}
    # pragma: no mutate end
    query = urllib.parse.urlencode({**period, "motivo": reason}, quote_via=urllib.parse.quote)
    return f"{client.url}/odoo/{REQUEST_ACTION}/new?{query.replace('.', '%2E')}"


def own_request(client: OdooClient, iso: str | None) -> tuple[int, Mapping[str, object]]:
    """Answer the link to the session's own change request for a day, filled when it can be."""
    client.load_employee()
    link = prefilled_link(client, notice_day(client, client.employee_id, iso)) or request_link(client)
    if not link:
        return 409, {"error": "Odoo no tiene la categoría de solicitudes de cambio de fichaje"}
    return 200, {"url": link}


def send(user_id: str, text: str, link: str | None = None) -> None:
    """Send a private message from the bot, with a button to the link when there is one."""
    token = read_private(TOKEN_FILE)
    if not token:
        raise DiscordError("No hay bot de Discord en este equipo: guárdalo con odoo discord")
    channel = call(token, "/users/@me/channels", {"recipient_id": user_id})
    button: dict[str, object] = {"type": BUTTON, "style": LINK_STYLE, "label": LINK_LABEL, "url": link}
    call(
        token,
        f"/channels/{channel['id']}/messages",
        {"content": text, **({"components": [{"type": ACTION_ROW, "components": [button]}]} if link else {})},
    )


def send_test(client: OdooClient) -> tuple[int, Mapping[str, object]]:
    """Send the session's own user a test message and answer (status, payload)."""
    me = sender_id(client)
    if not me:
        return 409, {"error": "No se encuentra tu ID de Discord en tu ficha de Odoo, o tu usuario no puede leerlo"}
    try:
        send(me, TEST_TEXT, request_link(client))
    except DiscordError as error:
        return 502, {"error": str(error)}
    return 200, {"ok": True}


def notice_of(body: Mapping[str, object]) -> Notice | str:
    """Read the body of a notice, or say what is wrong with its employee or its text."""
    employee, text, day = body.get("employee"), body.get("text"), body.get("date")
    if type(employee) is not int:
        return f"Empleado no válido: {employee}"
    if not isinstance(text, str) or not text.strip():
        return "El mensaje no tiene texto"
    return Notice(employee, text, day if isinstance(day, str) else None)


def message_employee(client: OdooClient, body: Mapping[str, object]) -> tuple[int, Mapping[str, object]]:
    """Send an employee the day dialog's notice, signed by the sender, and answer (status, payload)."""
    notice = notice_of(body)
    if isinstance(notice, str):
        return 400, {"error": notice}
    user = discord_id(client, notice.employee)
    if not user:
        return 409, {"error": "Su ficha de Odoo no tiene un ID de Discord numérico"}
    sender = sender_id(client)
    if not sender:
        return 409, {"error": "Tu ficha de Odoo no tiene tu ID de Discord: el aviso no diría a quién escribir"}
    prefilled = prefilled_link(client, notice_day(client, notice.employee, notice.day))
    review = f"\n{REVIEW}" if prefilled else ""
    message = f"{notice.text.strip()}\n\n{FOOTER.format(f'<@{sender}>')}{review}"
    if len(message) > MESSAGE_MAX:
        return 400, {"error": f"El mensaje no cabe: Discord admite hasta {MESSAGE_MAX} caracteres"}
    try:
        send(user, message, prefilled or request_link(client))
    except DiscordError as error:
        return 502, {"error": str(error)}
    return 200, {"ok": True}
