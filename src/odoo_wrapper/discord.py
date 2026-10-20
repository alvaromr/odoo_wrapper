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
  break it; without the action, or when it does not load, the button opens the category's empty form, and
  without the category the message goes without it.
- What it fills (proposal) is the punch to fix as it stands, in the description, and a correction to check:
  an open punch or the longest one of a long day, from its check-in to the hours the day still lacked (never
  past that day's LAST_MINUTE, the check-in itself without a target). A day without punches leaves the period
  and the correction blank: nothing there says when the day was worked. Nobody but the employee knows the
  real times, so a last subtext line, after FOOTER, asks them to check it (REVIEW): sent as it comes, it
  would approve an estimate. The day is read again from Odoo (team.fetch_team, cached), never taken from the
  page.
- The bot's token is a password: `odoo discord` asks for it without echo, and the management view's «Discord»
  dialog sends it once (set_token); either checks it with Discord (GET /users/@me, which also names the bot)
  and keeps it in TOKEN_FILE, mode 600, like the Odoo session. Nothing ever sends it back: the page only learns
  whether there is one (configured(), the team payload's can_message), and without it the day dialog offers
  only copying the message. The same dialog sends a test (send_test) to whoever asks, by their own Discord id,
  never to someone else: it proves the token, the sender's id and the link button in one go.
- Discord refuses a request without a User-Agent of its own form, DiscordBot (url, version). Its refusals come
  back as DiscordError in words the dialog shows: a token it no longer accepts, a person the bot may not write to,
  an id it does not know, anything else with Discord's own message; a network failure as Discord out of reach.
"""

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, time, timedelta, timezone

from . import team
from .client import STATE_DIR, OdooError, SessionExpired, read_private, write_private

API = "https://discord.com/api/v10"
TOKEN_FILE = os.path.join(STATE_DIR, "discord_token")
USER_AGENT = "DiscordBot (https://github.com/alvaromr/odoo_wrapper, 1.0)"
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


class DiscordError(Exception):
    pass


def refusal(error):
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


def call(token, path, body=None):
    request = urllib.request.Request(
        API + path, data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Bot {token}", "Content-Type": "application/json", "User-Agent": USER_AGENT},
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise DiscordError(refusal(error)) from None
    except OSError:
        raise DiscordError("Discord no responde") from None


def configured():
    return bool(read_private(TOKEN_FILE))


def save_token(token):
    bot = call(token, "/users/@me")
    write_private(TOKEN_FILE, token)
    return bot["username"]


def set_token(token):
    if not isinstance(token, str) or not token.strip():
        return 400, {"error": "Falta el token del bot"}
    try:
        return 200, {"bot": save_token(token.strip())}
    except DiscordError as error:
        return 400, {"error": str(error)}


def discord_id(client, employee_id):
    user = team.discord_of(client, employee_id)
    return user if user and user.isdigit() else None


def sender_id(client):
    mine = client.call_kw("hr.employee", "search_read", [[("user_id", "=", client.session_info()["uid"])]],
                          {"fields": ["id"], "limit": 1})
    return discord_id(client, mine[0]["id"]) if mine else None


def request_link(client):
    try:
        found = client.call_kw("approval.category", "search_read", [[("name", "ilike", team.REQUEST_CATEGORY)]],
                               {"fields": ["id"], "limit": 1})
    except SessionExpired:
        raise
    except OdooError:
        return None
    return f"{client.url}/odoo/approvals/{found[0]['id']}/approval.request/new" if found else None


def clock(moment):
    return moment.strftime("%H:%M")


def day_name(moment):
    return f"{WEEKDAYS[moment.weekday()]} {moment.strftime('%d/%m/%Y')}"


def duration(hours):
    h, m = divmod(round(hours * 60), 60)
    return " ".join(part for part in (f"{h}h" if h or not m else "", f"{m}m" if m else "") if part)


def proposal(day):
    sessions, target, today = day["sessions"], day["target"], date.fromisoformat(day["date"])
    if {"open", "long"} & set(day["flags"]):
        wrong = next((s for s in sessions if not s["out"]), None) or max(sessions, key=lambda s: s["hours"])
        start = datetime.fromisoformat(wrong["in"]).replace(second=0)
        done = sum(s["hours"] or 0 for s in sessions if s is not wrong)
        last = datetime.combine(today, LAST_MINUTE).astimezone()
        end = min(start + timedelta(hours=max(0, target - done)), last).replace(second=0)
        if wrong["out"]:
            out = datetime.fromisoformat(wrong["out"])
            until = clock(out) if out.date() == start.date() else f"{day_name(out)} {clock(out)}"
            what = f"de {clock(start)} a {until} ({duration(wrong['hours'])})"
        else:
            what = f"entrada a las {clock(start)} sin salida"
        correction = f"de {clock(start)} a {clock(end)}."
        return start, end, f"Fichaje incorrecto: {day_name(start)}, {what}. Corrección: {correction}"
    if "empty" in day["flags"]:
        return None, None, (f"Fichaje incorrecto: {day_name(today)}, sin fichajes (jornada prevista de "
                            f"{duration(target)}). Corrección: ")
    return None


def odoo_utc(moment):
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def notice_day(client, employee, iso):
    try:
        monday = team.monday_of(date.fromisoformat(iso))
    except (TypeError, ValueError):
        return None
    found = next((e for e in team.fetch_team(client, monday)["employees"] if e["id"] == employee), None)
    return next((d for d in found["days"] if d["date"] == iso), None) if found else None


def prefilled_link(client, day):
    filled = proposal(day) if day else None
    if not filled:
        return None
    try:
        client.jsonrpc("/web/action/load", {"action_id": REQUEST_ACTION})
    except SessionExpired:
        raise
    except OdooError:
        return None
    start, end, reason = filled
    period = {"desde": odoo_utc(start), "hasta": odoo_utc(end)} if start else {}
    query = urllib.parse.urlencode({**period, "motivo": reason}, quote_via=urllib.parse.quote)
    return f"{client.url}/odoo/{REQUEST_ACTION}/new?{query.replace('.', '%2E')}"


def send(user_id, text, link=None):
    token = read_private(TOKEN_FILE)
    if not token:
        raise DiscordError("No hay bot de Discord en este equipo: guárdalo con odoo discord")
    channel = call(token, "/users/@me/channels", {"recipient_id": user_id})
    button = {"type": BUTTON, "style": LINK_STYLE, "label": LINK_LABEL, "url": link}
    call(token, f"/channels/{channel['id']}/messages",
         {"content": text, **({"components": [{"type": ACTION_ROW, "components": [button]}]} if link else {})})


def send_test(client):
    me = sender_id(client)
    if not me:
        return 409, {"error": "No se encuentra tu ID de Discord en tu ficha de Odoo, o tu usuario no puede leerlo"}
    try:
        send(me, TEST_TEXT, request_link(client))
    except DiscordError as error:
        return 502, {"error": str(error)}
    return 200, {"ok": True}


def message_employee(client, body):
    employee, text = body.get("employee"), body.get("text")
    if type(employee) is not int:
        return 400, {"error": f"Empleado no válido: {employee}"}
    if not isinstance(text, str) or not text.strip():
        return 400, {"error": "El mensaje no tiene texto"}
    user = discord_id(client, employee)
    if not user:
        return 409, {"error": "Su ficha de Odoo no tiene un ID de Discord numérico"}
    sender = sender_id(client)
    if not sender:
        return 409, {"error": "Tu ficha de Odoo no tiene tu ID de Discord: el aviso no diría a quién escribir"}
    prefilled = prefilled_link(client, notice_day(client, employee, body.get("date")))
    review = f"\n{REVIEW}" if prefilled else ""
    message = f"{text.strip()}\n\n{FOOTER.format(f'<@{sender}>')}{review}"
    if len(message) > MESSAGE_MAX:
        return 400, {"error": f"El mensaje no cabe: Discord admite hasta {MESSAGE_MAX} caracteres"}
    try:
        send(user, message, prefilled or request_link(client))
    except DiscordError as error:
        return 502, {"error": str(error)}
    return 200, {"ok": True}
