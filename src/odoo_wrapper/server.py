"""The HTTP side of the dashboard: pages and assets, the JSON API, Odoo sessions as the login, the same-site guard.

Login and sessions
- The dashboard cookie is the Odoo session itself. POST /api/login forwards the user's Odoo user and
  password once to /web/session/authenticate and hands the session_id back as the odoo_dash cookie
  (HttpOnly, SameSite=Lax, Secure over TLS, Max-Age 400 days). The password is never stored. Every later
  request forwards that cookie to Odoo, so each browser holds its own session. config.json keeps url, db
  and user only.
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

Assets
- /manifest.json and /icon.svg make the page installable, so the phone can add it to the home screen and
  open it full screen; the URL it opens still changes with the network, same as any other bookmark.

API
- GET /api/data is the cached payload from data.py plus, fresh on every response, the phone access block and
  the shared state; the state used to ride inside the cached payload, so for up to its TTL a page could load
  with a stale mute or duration and overwrite the good one.
- Punch actions go through data.punch, which validates the real state and returns the (status, body) to send.
"""

import json
import os
import secrets
import ssl
import string
import threading
import time
import traceback
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qsl

from . import data, lan, process, state
from .client import (
    CONFIG_KEYS, AccessDenied, OdooClient, OdooDown, OdooError, SessionExpired, TotpRequired,
    load_config, read_config, save_config,
)

PORT = 8931
TEMPLATE = f"{process.TEMPLATES}/dashboard.html"
LOGIN_TEMPLATE = f"{process.TEMPLATES}/login.html"
STYLESHEET = f"{process.TEMPLATES}/style.css"
SCRIPTS = f"{process.TEMPLATES}/js"
MANIFEST = f"{process.TEMPLATES}/manifest.json"
ICON = f"{process.TEMPLATES}/icon.svg"
COOKIE_NAME = "odoo_dash"
DEVICE_COOKIE = "odoo_td"
COOKIE_MAX_AGE = {COOKIE_NAME: 60 * 60 * 24 * 400, DEVICE_COOKIE: 60 * 60 * 24 * 90}
SESSION_CHARS = frozenset(string.ascii_letters + string.digits + "-_")
LOGIN_PENALTY = 1.0
LOGIN_TRIES = 5
LOGIN_LOCK = 30
LOGIN_LOCK_MAX = 900
PAIR_TTL = 120
_sessions = {}
_pairings = {}
_login_fails = {}
_login_lock = threading.Lock()


def new_client(session_id):
    config = load_config()
    client = OdooClient(config["url"], config["db"], session_id)
    client.uid = _sessions.get(session_id)
    return client


def session_cookie(headers, name=COOKIE_NAME):
    morsel = SimpleCookie(headers.get("Cookie") or "").get(name)
    value = morsel.value if morsel else ""
    return value if value and set(value) <= SESSION_CHARS else ""


def session_ok(session_id):
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


def login_wait(ip):
    with _login_lock:
        return max(0, _login_fails.get(ip, (0, 0))[1] - time.monotonic())


def login_failed(ip):
    with _login_lock:
        now = time.monotonic()
        fails, until = _login_fails.get(ip, (0, 0))
        fails = 1 if now > until + LOGIN_LOCK_MAX else fails + 1
        lock = 0 if fails < LOGIN_TRIES else min(LOGIN_LOCK_MAX, LOGIN_LOCK * 2 ** (fails - LOGIN_TRIES))
        _login_fails[ip] = (fails, now + lock)


def login_succeeded(ip):
    with _login_lock:
        _login_fails.pop(ip, None)


def new_pairing(session_id, base_url):
    now = time.monotonic()
    for token in [token for token, (_, until) in list(_pairings.items()) if until < now]:
        _pairings.pop(token, None)
    token = secrets.token_urlsafe(24)
    _pairings[token] = (session_id, now + PAIR_TTL)
    link = f"{base_url}pair?t={token}"
    return {"url": link, "qr": lan.qr_or_empty(link), "expires_in": PAIR_TTL}


def spend_pairing(token):
    session_id, until = _pairings.pop(token, ("", 0))
    return session_id if until >= time.monotonic() else ""


def revoke_pairings(session_id):
    for token in [token for token, (owner, _) in list(_pairings.items()) if owner == session_id]:
        _pairings.pop(token, None)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, status, body, ctype="application/json; charset=utf-8", cookies=(), location=None):
        payload = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        if location:
            self.send_header("Location", location)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Frame-Options", "DENY")
        secure = "; Secure" if isinstance(self.connection, ssl.SSLSocket) else ""
        for name, value in cookies:
            max_age = COOKIE_MAX_AGE[name] if value else 0
            self.send_header(
                "Set-Cookie",
                f"{name}={value}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Lax{secure}",
            )
        self.end_headers()
        self.wfile.write(payload)

    def _same_site(self):
        if not lan.is_local_name(lan.hostname_of(self.headers.get("Host"))):
            return False
        origin = self.headers.get("Origin")
        return not origin or lan.is_local_name(lan.hostname_of(origin))

    def _local(self):
        return self.client_address[0] in lan.LOOPBACK

    def _authorized(self):
        self.session = session_cookie(self.headers)
        return session_ok(self.session)

    def _serve(self, handler):
        if not self._same_site():
            self._send(403, {"error": "origen no permitido"})
            return
        self.session = ""
        try:
            handler()
        except SessionExpired as error:
            _sessions.pop(self.session, None)
            self._send(401, {"error": str(error)}, cookies=[(COOKIE_NAME, "")])
        except OdooDown as error:
            self._send(502, {"error": str(error)})
        except OdooError as error:
            self._send(502, {"error": f"Odoo: {error}"})
        except Exception:
            process.say(f"Error interno atendiendo {self.command} {self.path}:")
            traceback.print_exc()
            self._send(500, {"error": "Error interno del dashboard"})

    def do_GET(self):
        self._serve(self._get)

    def do_POST(self):
        self._serve(self._post)

    def _get(self):
        self.path, _, query = self.path.partition("?")
        if self.path in ("/", "/index.html", "/login"):
            page = TEMPLATE if self.path != "/login" and session_cookie(self.headers) else LOGIN_TEMPLATE
            with open(page, "rb") as f:
                self._send(200, f.read(), "text/html; charset=utf-8")
        elif self.path == "/style.css":
            with open(STYLESHEET, "rb") as f:
                self._send(200, f.read(), "text/css; charset=utf-8")
        elif self.path == "/manifest.json":
            with open(MANIFEST, "rb") as f:
                self._send(200, f.read(), "application/manifest+json; charset=utf-8")
        elif self.path == "/icon.svg":
            with open(ICON, "rb") as f:
                self._send(200, f.read(), "image/svg+xml")
        elif self.path == "/pair":
            session_id = spend_pairing(dict(parse_qsl(query)).get("t", ""))
            cookies = [(COOKIE_NAME, session_id)] if session_id else []
            self._send(303, b"", "text/plain", cookies=cookies, location="/" if session_id else "/login")
        elif self.path.startswith("/js/") and self.path[4:] in os.listdir(SCRIPTS):
            with open(os.path.join(SCRIPTS, self.path[4:]), "rb") as f:
                self._send(200, f.read(), "text/javascript; charset=utf-8")
        elif self.path == "/api/version":
            self._send(200, {"version": process.source_version()})
        elif self.path == "/api/config":
            config, local = read_config(), self._local()
            shown = CONFIG_KEYS if local else ()
            self._send(200, dict({key: config.get(key, "") for key in shown}, configured=bool(config), local=local))
        elif self.path == "/api/state":
            if not self._authorized():
                self._send(401, {"error": "no autorizado"})
                return
            self._send(200, state.read_state())
        elif self.path == "/api/data":
            if not self._authorized():
                self._send(401, {"error": "no autorizado"})
                return
            payload = data.fetch_data(new_client(self.session), fresh=query == "fresh")
            self._send(200, dict(payload, phone=lan.phone_access(), state=state.read_state()))
        else:
            self._send(404, {"error": "not found"})

    def _login(self, body):
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
        client.user_agent = self.headers.get("User-Agent") or client.user_agent
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

    def _post(self):
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            self._send(400, {"error": "Cuerpo de la petición ilegible"})
            return
        if self.path == "/api/login":
            self._login(body)
            return
        if not self._authorized():
            self._send(401, {"error": "no autorizado"})
            return
        if self.path == "/api/state":
            changes = {}
            for key in ("lunch_minutes", "break_minutes"):
                if key in body:
                    if state.valid_minutes(body[key], None) is None:
                        self._send(400, {"error": f"{key} fuera de rango: {body[key]}"})
                        return
                    changes[key] = body[key]
            if "muted" in body:
                changes["muted"] = bool(body["muted"])
            self._send(200, state.write_state(**changes))
        elif self.path == "/api/pair":
            phone = lan.phone_access()
            if not self._local():
                self._send(403, {"error": "Solo se empareja desde el propio ordenador"})
            elif body.get("revoke"):
                revoke_pairings(self.session)
                self._send(200, {"ok": True})
            elif not phone:
                self._send(409, {"error": "El dashboard no escucha en la red: arráncalo con --host"})
            else:
                self._send(200, new_pairing(self.session, phone["name_url" if body.get("name") else "url"]))
        elif self.path == "/api/attendance":
            self._send(*data.punch(new_client(self.session), body.get("action")))
        else:
            self._send(404, {"error": "not found"})
