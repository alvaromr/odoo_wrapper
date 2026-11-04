"""The HTTP side of the dashboard: pages and assets, the JSON API, Odoo sessions as the login, the same-site guard.

Login and sessions
- The dashboard cookie is the Odoo session itself. POST /api/login forwards the user's Odoo user and
  password once to /web/session/authenticate and hands the session_id back as the odoo_dash cookie
  (HttpOnly, SameSite=Lax, Secure over TLS, Max-Age 400 days). The password is never stored. Every later
  request forwards that cookie to Odoo, so each browser holds its own session. config.json keeps url, db
  and user only.
- Whether a session may read other people (client.sees_others, behind /api/team and /api/data?employee)
  and whether it may change punches (client.edits_punches, Odoo's own access rights on hr.attendance) are
  remembered per session for SEES_TTL, half an hour: each was one more Odoo call on every request and
  does not change within a session. Logout forgets them. Payloads carry can_edit so a page offers no
  correction it cannot make, and /api/team/attendance and /api/team/delete answer 403 without it, before
  reaching Odoo.
- Validity is Odoo's call. A cookie not seen since the server started is checked once with
  get_session_info and remembered in _sessions with its uid (cleared by every restart, which is fine).
  When Odoo answers code 100 anywhere, the API replies 401, clears the cookie and forgets it; the page sends
  itself to /login on any 401. Odoo issues its session with a 7-day expiry renewed on use; the paired phone
  shares the laptop's session, so the laptop's polling keeps it alive and the phone drops out only when
  Odoo ends that session for both. Our Max-Age is deliberately longer, Odoo governs.
- Two-factor: when Odoo wants a code, /api/login answers 401 with totp true and the page shows the code
  field; the browser then posts user, password and code together, so the server keeps no half-open
  session between the two requests. Every successful code also makes the browser a trusted device: Odoo's
  td_id key comes back as the odoo_td cookie (same flags, Max-Age 90 days) and is forwarded on the next
  login so it needs no code. A 401 clears the session cookie only; the device stays trusted, that is its
  point. The device is named in Odoo after the browser's own User-Agent, forwarded for that reason.
- Login is loopback only: /api/login answers 403 to any other client, so nobody on the Wi-Fi can even try
  a password, and a LAN client can never repoint the server at another Odoo URL (it would get the user's
  real session forwarded to it). /api/config tells the login page whether Odoo is configured and whether the
  client is local; the URL, database and user are shown to loopback only, so the LAN learns no username.
- Pairing is how the phone gets in. POST /api/pair (loopback, with a session) mints a one-shot token that
  stands for that same Odoo session for PAIR_TTL seconds and returns the pairing link and its QR; GET
  /pair?t=<token> from the phone spends the token, sets the odoo_dash cookie and redirects to /. A spent,
  expired, revoked ({"revoke": true} drops the session's tokens when the page cancels) or unknown token
  redirects to /login, whose page tells a LAN client to pair from the laptop.
  Both devices then share one Odoo session: whatever ends it on one ends it on the other. Tokens live in
  memory, so a restart drops any pairing in progress. The QR carries the session for two minutes, so the
  page shows it only on demand: a QR always on screen would be a key to anyone watching a screen share.
- Logout: POST /api/logout destroys the session in Odoo (/web/session/destroy), forgets it here with its
  pairings and cached data, and clears the cookie; a session Odoo already ended still clears the cookie.
  It needs no valid session, so a dead one never leaves the page stuck. The phone shares that session, so
  logging out on either device logs out both. The trusted-device cookie stays: it is per browser, and Odoo
  simply ignores it for a different user.
- Brute force: wrong passwords cost LOGIN_PENALTY seconds each, and after LOGIN_TRIES failures that IP is
  locked out with a doubling delay capped at LOGIN_LOCK_MAX, answered as 429. The sleep alone was not a
  brake: the server is threaded, so concurrent attempts sleep in parallel.
- Loopback is not exempt. It used to be, when the guard was a separate dashboard password. Now the guard is
  the Odoo session, which the person at the machine has to obtain once anyway, and requiring it on loopback
  means no other local process reads the data or clocks in without a cookie it does not have.

Same-site guard
- Every request whose Host (or Origin, when present) is not an IP literal, localhost or a .local name gets
  403. That blocks DNS rebinding (reads the data by defeating CORS) and a cross-site POST to
  /api/attendance (needs no preflight with text/plain and would clock the user in or out). Every response
  carries X-Frame-Options: DENY so no page can frame the dashboard and click its buttons through an overlay.
- Every response also carries CONTENT_POLICY: scripts only from this server's own files (no inline script,
  hence js/login.js), styles too (no <style> block nor style attribute: each page has its own .css next to
  style.css, served like it), requests only to itself, nothing framed or framing; and
  X-Content-Type-Options: nosniff, so a JSON answer is never run as a script. The scripts still set element
  styles through el.style, which the policy does not govern. The page builds nothing from user text with
  innerHTML (only the QR's SVG, which qr.py writes), so the policy is a second wall, not the only one.

Assets
- /manifest.json and /icon.svg make the page installable, so the phone can add it to the home screen and
  open it full screen; the URL it opens still changes with the network, same as any other bookmark.

API
- GET /api/data is the cached payload from data.py plus, fresh on every response, the phone access block and
  the shared state; the state used to ride inside the cached payload, so for up to its TTL a page could load
  with a stale mute or duration and overwrite the good one.
- GET /api/data?employee=<id> is that employee's payload, for /empleado?id=<id> (the dashboard page in
  read-only mode, linked from each row of /gestion), with the same 403 as /api/team; it carries no phone
  block and state.OTHER_STATE instead of the viewer's state, plus the employee's pending change requests the
  viewer may approve (team.requests_to_approve), read fresh each time since approving changes them.
- GET /api/request?date=YYYY-MM-DD is the link to Odoo's attendance change request form for that day of the
  session's own employee, filled as the Discord notice's button (discord.own_request), and without a date the
  empty form; it only reads.
- GET /api/update[?fresh] says whether GitHub holds a newer release than this version (updates.py), for the
  pages' banner and «Ajustes», plus whether this client is the machine itself (local) and how this install
  is updated (how: auto, git or manual, updates.how); it needs a session like the data,
  though it touches no Odoo. POST /api/update installs the latest release and restarts into it
  (updates.install), from loopback only, like pairing: the LAN never starts an install on this machine.
- GET /api/team?week=<any day>[&fresh] is team.py's payload for that day's week (this week by default), and
  ?month=YYYY-MM the one for every week of that month, ?year=YYYY that year summarised by month, ?fixes
  the punch errors to fix over the whole history (team.fetch_fixes); 403 unless the session reads other people's
  attendances. The page for it is /gestion. The week, month and year payloads carry can_message: whether this
  machine has a Discord bot to send the day dialog's notice with (discord.py).
- Punch actions go through data.punch, which validates the real state and returns the (status, body) to send.
- POST /api/team/attendance {id | employee, check_in, check_out[, reason]} (ISO times with their offset, the
  id of an attendance reason) edits or creates someone's punch, POST /api/team/delete {id} removes one, and
  POST /api/team/approve {id} approves a change request (see corrections.py); all answer 403 like /api/team,
  and they are the only writes besides punching. POST /api/team/discord {employee, date, text} sends that employee
  a direct message from the bot (discord.py), with the same 403; it writes nothing to Odoo. POST
  /api/team/discord/token {token} keeps the bot's token once Discord accepts it, the same as `odoo discord`, and
  answers the bot's name, never the token: no request reads it back. POST /api/team/discord/test sends the
  session's own user a test message.

Types
- A POST body is declared a JSON object (Body) as it is parsed, and its values stay objects: each route checks
  the ones it reads, or hands them on to a function that does (corrections_rules.py says which). A body that is
  JSON but not an object is not refused; it fails on its first key and ends as the 500 of any other crash. The
  payloads the routes send are data.py's and team.py's TypedDicts, added to with dict(payload, key=...); an answer
  that only acknowledges is a Mapping[str, object] (Reply).
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import secrets
import ssl
import string
import threading
import time
from collections.abc import Mapping, Sequence
from datetime import date, datetime
from email.message import Message
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler
from typing import Callable, TypedDict, TypeVar
from urllib.parse import parse_qsl

from odoo_wrapper import corrections, data, discord, lan, process, state, team, team_rules, updates
from odoo_wrapper.client import (
    CONFIG_KEYS,
    AccessDenied,
    OdooClient,
    OdooDown,
    OdooError,
    SessionExpired,
    TotpRequired,
    load_config,
    read_config,
    save_config,
)

PORT = 8931
DASHBOARD_PAGE = f"{process.STATIC}/dashboard.html"
LOGIN_PAGE = f"{process.STATIC}/login.html"
TEAM_PAGE = f"{process.STATIC}/team.html"
PAGES = {
    "/": DASHBOARD_PAGE,
    "/index.html": DASHBOARD_PAGE,
    "/empleado": DASHBOARD_PAGE,
    "/gestion": TEAM_PAGE,
    "/login": LOGIN_PAGE,
}
SCRIPTS = f"{process.STATIC}/js"
MANIFEST = f"{process.STATIC}/manifest.json"
ICON = f"{process.STATIC}/icon.svg"
FILES = {
    "/manifest.json": (MANIFEST, "application/manifest+json; charset=utf-8"),
    "/icon.svg": (ICON, "image/svg+xml"),
}
COOKIE_NAME = "odoo_dash"
DEVICE_COOKIE = "odoo_td"
COOKIE_MAX_AGE = {COOKIE_NAME: 60 * 60 * 24 * 400, DEVICE_COOKIE: 60 * 60 * 24 * 90}
SESSION_CHARS = frozenset(string.ascii_letters + string.digits + "-_")
LOGIN_PENALTY = 1.0
LOGIN_TRIES = 5
LOGIN_LOCK = 30
LOGIN_LOCK_MAX = 900
PAIR_TTL = 120
SEES_TTL = 1800
CONTENT_POLICY = (
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; "
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"
)
NOT_TEAM = "Tu usuario de Odoo no ve fichajes de otras personas"
NOT_EDITOR = "Tu usuario de Odoo no puede modificar fichajes"
log = logging.getLogger(__name__)
_sessions: dict[str, int | None] = {}
_rights: dict[str, dict[str, tuple[float, bool]]] = {}
_pairings: dict[str, tuple[str, float]] = {}
_login_fails: dict[str, tuple[int, float]] = {}
_login_lock = threading.Lock()
Argument = TypeVar("Argument")
Body = dict[str, object]
Reply = tuple[int, Mapping[str, object]]


class Pairing(TypedDict):
    """A pairing link: where to open it, its QR and the seconds it lasts."""

    url: str
    qr: str
    expires_in: int


def new_client(session_id: str) -> OdooClient:
    """Return a client of the configured Odoo on a session, with its user if the server knows it."""
    config = load_config()
    client = OdooClient(config["url"], config["db"], session_id)
    client.uid = _sessions.get(session_id)
    return client


def session_cookie(headers: Message[str, str], name: str = COOKIE_NAME) -> str:
    """Return a cookie of the request when it holds only session characters, else nothing."""
    sent = headers.get("Cookie")  # pragma: no mutate - header names ignore case
    morsel = SimpleCookie(sent).get(name)
    value = morsel.value if morsel else ""
    return value if set(value) <= SESSION_CHARS else ""


def remembered(client: OdooClient, right: str) -> bool:
    """Return a session's right as Odoo last told it, asking again after SEES_TTL."""
    known = _rights.setdefault(client.session_id, {}).get(right)
    if known and time.monotonic() - known[0] < SEES_TTL:
        return known[1]
    answer: bool = getattr(client, right)()
    _rights[client.session_id][right] = (time.monotonic(), answer)
    return answer


def sees_others(client: OdooClient) -> bool:
    """Tell whether the session's user can read other people's attendances."""
    return remembered(client, "sees_others")


def edits_punches(client: OdooClient) -> bool:
    """Tell whether the session's user can change other people's attendances."""
    return remembered(client, "edits_punches")


def session_ok(session_id: str) -> bool:
    """Tell whether a session is alive in Odoo, remembering its user once it is."""
    if not session_id or not read_config():
        return False
    if session_id in _sessions:
        return True
    try:
        client = new_client(session_id)
        client.session_info()
    except SessionExpired:
        return False
    _sessions[session_id] = client.uid
    return True


def login_wait(ip: str) -> float:
    """Return the seconds an address must still wait before trying to log in again."""
    with _login_lock:
        until = _login_fails[ip][1] if ip in _login_fails else 0
        return max(0, until - time.monotonic())


def login_failed(ip: str) -> None:
    """Count a failed login of an address and lock it out longer each time past LOGIN_TRIES."""
    with _login_lock:
        now = time.monotonic()
        fails, until = _login_fails.get(ip, (0, 0))  # pragma: no mutate - an unknown address counts 1 either way
        fails = 1 if now > until + LOGIN_LOCK_MAX else fails + 1
        lock = 0 if fails < LOGIN_TRIES else min(LOGIN_LOCK_MAX, LOGIN_LOCK * 2 ** (fails - LOGIN_TRIES))
        _login_fails[ip] = (fails, now + lock)


def login_succeeded(ip: str) -> None:
    """Forget an address's failed logins."""
    with _login_lock:
        _login_fails.pop(ip, None)


def new_pairing(session_id: str, base_url: str) -> Pairing:
    """Return a one-use link that gives a phone this session for PAIR_TTL seconds, with its QR."""
    now = time.monotonic()
    for token in [token for token, (_, until) in list(_pairings.items()) if until < now]:
        _pairings.pop(token, None)  # pragma: no mutate - only another request spending it at once would miss it
    token = secrets.token_urlsafe(24)
    _pairings[token] = (session_id, now + PAIR_TTL)
    link = f"{base_url}pair?t={token}"
    return {"url": link, "qr": lan.qr_or_empty(link), "expires_in": PAIR_TTL}


def spend_pairing(token: str | None) -> str:
    """Use up a pairing link and return its session, or nothing when it is unknown or late."""
    pairing = _pairings.pop(token, None) if token else None
    return pairing[0] if pairing and pairing[1] >= time.monotonic() else ""


def team_period(params: dict[str, str]) -> tuple[int | None, team_rules.Span]:
    """Return the year asked for, if any, and the span of the month or week; raise ValueError on a bad one."""
    year = int(params["year"]) if params.get("year") else None
    if params.get("month"):
        return year, team_rules.month_span(date.fromisoformat(f"{params['month']}-01"))
    week = date.fromisoformat(params["week"]) if params.get("week") else datetime.now().astimezone().date()
    return year, (team_rules.monday_of(week),)


def revoke_pairings(session_id: str) -> None:
    """Drop every pairing link a session handed out."""
    for token in [token for token, (owner, _) in list(_pairings.items()) if owner == session_id]:
        _pairings.pop(token, None)  # pragma: no mutate - as in new_pairing()


class Handler(BaseHTTPRequestHandler):
    """One request: the same-site guard, then a page, a file or a route of the API."""

    def log_message(self, *args: object) -> None:
        """Keep the server's request log out of the dashboard's."""

    def _send(
        self,
        status: int,
        body: Mapping[str, object] | bytes,
        ctype: str = "application/json; charset=utf-8",
        cookies: Sequence[tuple[str, str]] = (),
        location: str | None = None,
    ) -> None:
        # pragma: no mutate start - None is as false as False
        payload = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
        # pragma: no mutate end
        self.send_response(status)
        if location:
            self.send_header("Location", location)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", CONTENT_POLICY)
        self.send_header("X-Content-Type-Options", "nosniff")
        secure = "; Secure" if isinstance(self.connection, ssl.SSLSocket) else ""
        for name, value in cookies:
            max_age = COOKIE_MAX_AGE[name] if value else 0
            self.send_header(
                "Set-Cookie",
                f"{name}={value}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Lax{secure}",
            )
        self.end_headers()
        self.wfile.write(payload)

    def _same_site(self) -> bool:
        host = self.headers.get("Host")  # pragma: no mutate - header names ignore case
        if not lan.is_local_name(lan.hostname_of(host)):
            return False
        origin = self.headers.get("Origin")  # pragma: no mutate - as above
        return not origin or lan.is_local_name(lan.hostname_of(origin))

    def _local(self) -> bool:
        return self.client_address[0] in lan.LOOPBACK

    def _authorized(self) -> bool:
        self.session = session_cookie(self.headers)
        return session_ok(self.session)

    def _serve(self, handler: Callable[[], None]) -> None:
        if not self._same_site():
            self._send(403, {"error": "origen no permitido"})
            return
        self.session = ""  # pragma: no mutate - no session is ever stored under the value it starts with
        try:
            handler()
        except SessionExpired as error:
            _sessions.pop(self.session, None)  # pragma: no mutate - a request alongside may have dropped it first
            self._send(401, {"error": str(error)}, cookies=[(COOKIE_NAME, "")])
        except OdooDown as error:
            self._send(502, {"error": str(error)})
        except OdooError as error:
            self._send(502, {"error": f"Odoo: {error}"})
        except Exception:
            log.exception(f"Error interno atendiendo {self.command} {self.path}")
            self._send(500, {"error": "Error interno del dashboard"})

    def do_GET(self) -> None:
        """Answer a GET."""
        self._serve(self._get)

    def do_POST(self) -> None:
        """Answer a POST."""
        self._serve(self._post)

    def _get(self) -> None:
        self.path, _, query = self.path.partition("?")
        asset = self._asset()
        if asset:
            with open(asset[0], "rb") as f:
                self._send(200, f.read(), asset[1])
            return
        self._route(GET_ROUTES, query)

    def _asset(self) -> tuple[str, str] | None:
        name = self.path[1:]
        if self.path in PAGES:
            return PAGES[self.path] if session_cookie(self.headers) else LOGIN_PAGE, "text/html; charset=utf-8"
        if name.endswith(".css") and name in os.listdir(process.STATIC):
            return os.path.join(process.STATIC, name), "text/css; charset=utf-8"
        if name.startswith("js/") and name[3:] in os.listdir(SCRIPTS):
            return os.path.join(SCRIPTS, name[3:]), "text/javascript; charset=utf-8"
        return FILES.get(self.path)

    def _route(
        self, routes: Mapping[str, tuple[Callable[[Handler, Argument], None], bool]], argument: Argument
    ) -> None:
        route = routes.get(self.path)
        if route is None:
            self._send(404, {"error": "not found"})
        elif route[1] and not self._authorized():
            self._send(401, {"error": "no autorizado"})
        else:
            route[0](self, argument)

    def _pair(self, query: str) -> None:
        session_id = spend_pairing(dict(parse_qsl(query)).get("t"))
        cookies = [(COOKIE_NAME, session_id)] if session_id else []
        self._send(303, b"", "text/plain", cookies=cookies, location="/" if session_id else "/login")

    def _version(self, _query: str) -> None:
        self._send(200, {"version": process.source_version()})

    def _config(self, _query: str) -> None:
        config, local = read_config(), self._local()
        shown = CONFIG_KEYS if local else ()
        self._send(200, dict({key: config.get(key, "") for key in shown}, configured=bool(config), local=local))

    def _state(self, _query: str) -> None:
        self._send(200, state.read_state(_sessions[self.session]))

    def _request(self, query: str) -> None:
        self._send(*discord.own_request(new_client(self.session), dict(parse_qsl(query)).get("date")))

    def _update_check(self, query: str) -> None:
        forced = "fresh" in dict(parse_qsl(query, keep_blank_values=True))
        answer = updates.recheck() if forced else updates.check()
        self._send(200, dict(answer, local=self._local(), how=updates.how()))

    def _data(self, query: str) -> None:
        params = dict(parse_qsl(query, keep_blank_values=True))
        if params.get("employee"):
            self._someone_data(params)
            return
        client = new_client(self.session)
        payload = (data.reload_data if "fresh" in params else data.fetch_data)(client)
        own = {
            "phone": lan.phone_access(),
            "state": state.read_state(client.uid),
            "can_edit": bool(payload.get("team")) and edits_punches(client),
        }
        self._send(200, dict(payload, **own))

    def _someone_data(self, params: dict[str, str]) -> None:
        employee = params["employee"]
        if not employee.isdigit():
            self._send(400, {"error": f"Empleado no válido: {employee}"})
            return
        client = new_client(self.session)
        if not sees_others(client):
            self._send(403, {"error": NOT_TEAM})
            return
        payload = (data.reload_data if "fresh" in params else data.fetch_data)(client, int(employee))
        someone = {
            "phone": None,
            "state": state.OTHER_STATE,
            "can_edit": edits_punches(client),
            "requests": team.requests_to_approve(client, int(employee)),
        }
        self._send(200, dict(payload, **someone))

    def _team(self, query: str) -> None:
        params = dict(parse_qsl(query, keep_blank_values=True))
        try:
            year, span = team_period(params)
        except ValueError:
            period = params.get("year") or params.get("month") or params["week"]
            self._send(400, {"error": f"Periodo no válido: {period}"})
            return
        client = new_client(self.session)
        fresh = "fresh" in params
        if not sees_others(client):
            self._send(403, {"error": NOT_TEAM})
        elif year:
            summary = (team.reload_year if fresh else team.fetch_year)(client, year)
            self._send(200, dict(summary, can_message=discord.configured()))
        elif "fixes" in params:
            self._send(200, (team.reload_fixes if fresh else team.fetch_fixes)(client))
        else:
            payload = (team.reload_team if fresh else team.fetch_team)(client, span)
            self._send(200, dict(payload, can_edit=edits_punches(client), can_message=discord.configured()))

    def _login(self, body: Body) -> None:
        if not self._local():
            self._send(403, {"error": "En el móvil no se inicia sesión: empareja desde el ordenador"})
            return
        ip = self.client_address[0]
        wait = login_wait(ip)
        if wait:
            self._send(429, {"error": f"Demasiados intentos. Espera {int(wait) + 1} s"})
            return
        config = read_config()
        if body.get("url") and body.get("db"):
            config = {"url": str(body["url"]), "db": str(body["db"])}
        if not config:
            self._send(409, {"error": "Configura Odoo primero: faltan la URL y la base de datos"})
            return
        user = str(body.get("user") or config.get("user") or "")
        client = OdooClient(config["url"], config["db"], device=session_cookie(self.headers, DEVICE_COOKIE))
        agent = self.headers.get("User-Agent")  # pragma: no mutate - header names ignore case
        client.user_agent = agent or client.user_agent
        try:
            client.login(user, str(body.get("password") or ""), str(body.get("code") or ""))
        except TotpRequired as error:
            self._send(401, {"error": str(error), "totp": True})
            return
        except AccessDenied as error:
            login_failed(ip)
            time.sleep(LOGIN_PENALTY)
            self._send(401, {"error": str(error)})
            return
        login_succeeded(ip)
        save_config(config["url"], config["db"], user)
        _sessions[client.session_id] = client.uid
        cookies = [(COOKIE_NAME, client.session_id)]
        if client.device:
            cookies.append((DEVICE_COOKIE, client.device))
        self._send(200, {"ok": True}, cookies=cookies)

    def _logout(self, _body: Body) -> None:
        session_id = session_cookie(self.headers)
        if session_id and read_config():
            with contextlib.suppress(SessionExpired):
                new_client(session_id).logout()
        _sessions.pop(session_id, None)
        _rights.pop(session_id, None)
        revoke_pairings(session_id)
        data.drop_data_cache(session_id)
        self._send(200, {"ok": True}, cookies=[(COOKIE_NAME, "")])

    def _post(self) -> None:
        declared = self.headers.get("Content-Length")  # pragma: no mutate - header names ignore case
        length = int(declared or 0)
        try:
            body: Body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            self._send(400, {"error": "Cuerpo de la petición ilegible"})
            return
        self._route(POST_ROUTES, body)

    def _save_state(self, body: Body) -> None:
        uid = _sessions[self.session]
        minutes: dict[str, int] = {}
        for key, top in state.MINUTE_LIMITS.items():
            if key in body:
                value = state.valid_minutes(body[key], None, top)
                if value is None:
                    self._send(400, {"error": f"{key} fuera de rango: {body[key]}"})
                    return
                minutes[key] = value
        current = state.read_state(uid)
        window = {key: minutes.get(key, current[key]) for key in state.SETTINGS}
        if not state.window_ok(window["lunch_button_from"], window["lunch_button_to"]):
            self._send(400, {"error": "El botón de comida tiene que aparecer antes de la hora en que desaparece"})
            return
        changes: dict[str, object] = dict(minutes)
        if "muted" in body:
            changes["muted"] = bool(body["muted"])
        self._send(200, state.write_state(uid, **changes))

    def _pairing(self, body: Body) -> None:
        phone = lan.phone_access()
        if not self._local():
            self._send(403, {"error": "Solo se empareja desde el propio ordenador"})
        elif body.get("revoke"):
            revoke_pairings(self.session)
            self._send(200, {"ok": True})
        elif "off" in phone:
            self._send(409, {"error": phone["off"]})
        else:
            self._send(200, new_pairing(self.session, phone["name_url" if body.get("name") else "url"]))

    def _punch(self, body: Body) -> None:
        self._send(*data.punch(new_client(self.session), body.get("action")))

    def _update(self, _body: Body) -> None:
        if not self._local():
            self._send(403, {"error": "Solo se actualiza desde el propio ordenador"})
        else:
            self._send(*updates.install(process.relaunch_args(), PORT))

    def _for_team(self, body: Body) -> None:
        act, editor = TEAM_ACTIONS[self.path]
        client = new_client(self.session)
        if not sees_others(client):
            self._send(403, {"error": NOT_TEAM})
        elif editor and not edits_punches(client):
            self._send(403, {"error": NOT_EDITOR})
        else:
            self._send(*act(client, body))


TEAM_ACTIONS: dict[str, tuple[Callable[[OdooClient, Body], Reply], bool]] = {
    "/api/team/discord": (discord.message_employee, False),
    "/api/team/discord/token": (lambda _client, body: discord.set_token(body.get("token")), False),
    "/api/team/discord/test": (lambda client, _body: discord.send_test(client), False),
    "/api/team/approve": (lambda client, body: corrections.approve_request(client, body.get("id")), False),
    "/api/team/attendance": (corrections.save_attendance, True),
    "/api/team/delete": (lambda client, body: corrections.delete_attendance(client, body.get("id")), True),
}
GET_ROUTES = {
    "/pair": (Handler._pair, False),
    "/api/version": (Handler._version, False),
    "/api/config": (Handler._config, False),
    "/api/state": (Handler._state, True),
    "/api/request": (Handler._request, True),
    "/api/update": (Handler._update_check, True),
    "/api/data": (Handler._data, True),
    "/api/team": (Handler._team, True),
}
POST_ROUTES = {
    "/api/login": (Handler._login, False),
    "/api/logout": (Handler._logout, False),
    "/api/state": (Handler._save_state, True),
    "/api/pair": (Handler._pairing, True),
    "/api/attendance": (Handler._punch, True),
    "/api/update": (Handler._update, True),
    **dict.fromkeys(TEAM_ACTIONS, (Handler._for_team, True)),
}
