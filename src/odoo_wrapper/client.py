"""The Odoo client shared by the CLI and the dashboard, plus the connection config in ~/.odoo_dashboard.

- Web session, not API key. login() posts user and password to /web/session/authenticate once and keeps
  the session_id cookie it returns; every later call sends that cookie and nothing else. A dead session
  comes back as JSON-RPC error code 100 and is raised as SessionExpired so callers can ask for a new login;
  wrong credentials come back as odoo.exceptions.AccessDenied (AccessDenied). The password is never stored.
- Two-factor authentication (auth_totp) is honoured. With it enabled, authenticate answers uid null and
  leaves a half-open session behind its cookie; the same session then goes through /web/login/totp, the
  form the browser fills in, as a GET for its CSRF token and a POST with the code. Odoo rotates the session
  when the code is right, so success is a redirect that sets a new session_id; the re-rendered form means a
  wrong code. login() raises TotpRequired when it needs a code, and login_totp() finishes with one.
- The code is skipped on a trusted device: the POST asks Odoo to remember it, which answers with a td_id
  cookie valid for 90 days (Odoo's TRUSTED_DEVICE_AGE). Callers keep that key and hand it back as `device`;
  the GET sends it and Odoo finalizes the session on the spot. The device shows up under the user's Odoo
  security settings named after the User-Agent of the request, which is why the form calls carry one.
- The opener keeps redirects instead of following them: the TOTP endpoint answers 303 and its Set-Cookie
  headers are the point; following it would drop them on a cookieless GET of the web client.
- Clocking goes through /hr_attendance/systray_check_in_out, the same endpoint as the clock-in button in
  Odoo 18. It runs with sudo, which is why it works with plain employee permissions.
- Attendance reasons (hr.attendance.reason, the OCA/AvanzOSC module) are optional: attendance_reasons()
  answers [] when Odoo cannot serve the model — uninstalled, or its access revoked — and every caller
  degrades to plain punches without a reason. Only a dead session still propagates. The rows are read once
  per client; a client lives one CLI command or one dashboard request.
- A network failure on the way to Odoo (refused, DNS, timeout, a gateway error) is raised as OdooDown with a
  message the user can read, so neither the CLI nor the dashboard shows a traceback or a generic 500 when
  Odoo is simply down. A response that is not JSON (a maintenance page, a proxy error page) is OdooDown too.
- config.json keeps url, db and user only, written with mode 600 and replaced atomically.
"""

import json
import os
import platform
import re
import urllib.error
import urllib.parse
import urllib.request

STATE_DIR = os.path.expanduser("~/.odoo_dashboard")
CONFIG_FILE = os.path.join(STATE_DIR, "config.json")
CONFIG_KEYS = ("url", "db", "user")
SESSION_COOKIE = "session_id"
DEVICE_COOKIE = "td_id"
TOTP_PATH = "/web/login/totp"
CSRF_PATTERN = re.compile(r'name="csrf_token"[^>]*value="([^"]+)"')
REDIRECTS = (301, 302, 303, 307, 308)
USER_AGENT = f"Mozilla/5.0 ({platform.system()}) odoo-wrapper"
SESSION_EXPIRED_CODE = 100
ACCESS_DENIED = "odoo.exceptions.AccessDenied"


class OdooError(Exception):
    pass


class SessionExpired(OdooError):
    pass


class OdooDown(OdooError):
    pass


class AccessDenied(OdooError):
    pass


class TotpRequired(OdooError):
    pass


class KeepRedirects(urllib.request.HTTPRedirectHandler):
    def http_error_302(self, req, fp, code, msg, headers):
        return fp

    http_error_301 = http_error_303 = http_error_307 = http_error_308 = http_error_302


def set_cookies(headers):
    pairs = (header.partition(";")[0].partition("=") for header in headers.get_all("Set-Cookie") or [])
    return {name.strip(): value.strip() for name, _, value in pairs}


def write_private(path, text):
    os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
    pending = path + ".tmp"
    with open(os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
        f.write(text)
    os.replace(pending, path)


def read_private(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return ""


def read_config():
    try:
        config = json.loads(read_private(CONFIG_FILE) or "{}")
    except ValueError:
        config = {}
    if isinstance(config, dict) and all(config.get(key) for key in CONFIG_KEYS):
        return {key: str(config[key]) for key in CONFIG_KEYS}
    return {}


def load_config():
    config = read_config()
    if not config:
        raise OdooError("Falta configurar Odoo. Inicia sesión con `odoo login` o desde el dashboard")
    return config


def save_config(url, db, user):
    write_private(CONFIG_FILE, json.dumps({"url": url.rstrip("/"), "db": db, "user": user}))


class OdooClient:
    def __init__(self, url, db, session_id="", device=""):
        self.url = url.rstrip("/")
        self.db = db
        self.session_id = session_id
        self.device = device
        self.user_agent = USER_AGENT
        self.opener = urllib.request.build_opener(KeepRedirects)
        self.uid = None
        self.employee_id = None
        self.employee_name = None
        self.calendar_id = None
        self._reasons = None
        self._csrf = ""

    def _open(self, endpoint, data, headers):
        try:
            return self.opener.open(urllib.request.Request(f"{self.url}{endpoint}", data=data, headers=headers))
        except urllib.error.URLError as error:
            raise OdooDown(f"Odoo no responde ({error.reason})")

    def post(self, endpoint, params):
        data = json.dumps(
            {"jsonrpc": "2.0", "method": "call", "params": params, "id": 1}
        ).encode()
        headers = {"Content-Type": "application/json"}
        if self.session_id:
            headers["Cookie"] = f"{SESSION_COOKIE}={self.session_id}"
        resp = self._open(endpoint, data, headers)
        try:
            result = json.loads(resp.read())
        except ValueError:
            raise OdooDown("Odoo no responde (respuesta no válida)")
        if "error" in result:
            error = result["error"]
            details = error.get("data", {})
            if error.get("code") == SESSION_EXPIRED_CODE:
                raise SessionExpired("La sesión de Odoo ha caducado")
            if details.get("name") == ACCESS_DENIED:
                raise AccessDenied("Usuario o contraseña incorrectos")
            raise OdooError(details.get("message", str(error)))
        return result.get("result"), resp.headers

    def jsonrpc(self, endpoint, params):
        return self.post(endpoint, params)[0]

    def form(self, fields=None):
        cookies = {SESSION_COOKIE: self.session_id, DEVICE_COOKIE: self.device}
        headers = {
            "Cookie": "; ".join(f"{name}={value}" for name, value in cookies.items() if value),
            "User-Agent": self.user_agent,
        }
        data = urllib.parse.urlencode(fields).encode() if fields else None
        return self._open(TOTP_PATH, data, headers)

    def _finish(self, response):
        cookies = set_cookies(response.headers)
        if response.status not in REDIRECTS or SESSION_COOKIE not in cookies:
            return False
        self.session_id = cookies[SESSION_COOKIE]
        self.device = cookies.get(DEVICE_COOKIE, self.device)
        self.session_info()
        return True

    def login(self, user, password, code=""):
        session, headers = self.post(
            "/web/session/authenticate",
            {"db": self.db, "login": user, "password": password},
        )
        self.uid = session.get("uid")
        self.session_id = set_cookies(headers).get(SESSION_COOKIE, "")
        if not self.session_id:
            raise OdooError("Autenticación fallida: Odoo no devolvió una sesión")
        if self.uid:
            return self.session_id
        page = self.form()
        if self._finish(page):
            return self.session_id
        token = CSRF_PATTERN.search(page.read().decode())
        if not token:
            raise OdooError("Autenticación fallida: Odoo no devolvió el formulario de verificación")
        self._csrf = token.group(1)
        if not code:
            raise TotpRequired("Odoo pide el código de verificación en dos pasos")
        return self.login_totp(code)

    def login_totp(self, code):
        fields = {"totp_token": code, "csrf_token": self._csrf, "remember": "1"}
        if not self._finish(self.form(fields)):
            raise AccessDenied("Código de verificación incorrecto")
        return self.session_id

    def session_info(self):
        info = self.jsonrpc("/web/session/get_session_info", {})
        self.uid = info.get("uid")
        return info

    def call_kw(self, model, method, args, kwargs=None):
        return self.jsonrpc(
            "/web/dataset/call_kw",
            {"model": model, "method": method, "args": args, "kwargs": kwargs or {}},
        )

    def load_employee(self):
        if self.employee_id:
            return
        if not self.uid:
            self.session_info()
        emp = self.call_kw(
            "hr.employee",
            "search_read",
            [[("user_id", "=", self.uid)]],
            {"fields": ["id", "name", "resource_calendar_id"], "limit": 1},
        )
        if not emp:
            raise OdooError("No se encontró empleado asociado a tu usuario")
        self.employee_id = emp[0]["id"]
        self.employee_name = emp[0]["name"]
        calendar = emp[0]["resource_calendar_id"]
        self.calendar_id = calendar[0] if calendar else None

    def open_attendance(self):
        self.load_employee()
        rows = self.call_kw(
            "hr.attendance",
            "search_read",
            [[("employee_id", "=", self.employee_id), ("check_out", "=", False)]],
            {"fields": ["id", "check_in"], "limit": 1},
        )
        return rows[0] if rows else None

    def open_is_rest(self, open_att, rest):
        if not open_att or not rest:
            return False
        ids = self.call_kw(
            "hr.attendance",
            "search_read",
            [[("id", "=", open_att["id"])]],
            {"fields": ["attendance_reason_ids"]},
        )[0]["attendance_reason_ids"]
        return rest["id"] in ids

    def punch(self, reason_id=None):
        params = {"attendance_reason_id": reason_id} if reason_id else {}
        return self.jsonrpc("/hr_attendance/systray_check_in_out", params)

    def attendance_reasons(self):
        if self._reasons is None:
            try:
                self._reasons = self.call_kw(
                    "hr.attendance.reason",
                    "search_read",
                    [[]],
                    {"fields": ["name", "is_rest", "action_type", "show_on_attendance_screen"]},
                )
            except SessionExpired:
                raise
            except OdooError:
                self._reasons = []
        return self._reasons

    def sign_in_reasons(self):
        rows = [r for r in self.attendance_reasons() if r["action_type"] == "sign_in" and r["show_on_attendance_screen"]]
        normal = next((r for r in rows if not r["is_rest"]), None)
        rest = next((r for r in rows if r["is_rest"]), None)
        return normal, rest
