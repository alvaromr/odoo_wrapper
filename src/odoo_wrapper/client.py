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
  per client; a client lives one CLI command or one dashboard request. offered_reasons() are the ones Odoo's
  own attendance screen offers on check-in, working ones first: what a punch may be given, here too.
- A field someone added to a model by hand (Studio names it x_studio_<label>, the technical settings x_<label>)
  is found by its label, field_named(), never by its technical name: None when the model has no such field.
- A network failure on the way to Odoo (refused, DNS, timeout, a gateway error) is raised as OdooDown with a
  message the user can read, so neither the CLI nor the dashboard shows a traceback or a generic 500 when
  Odoo is simply down. A response that is not JSON (a maintenance page, a proxy error page) is OdooDown too.
- config.json keeps url, db and user only, written with mode 600 and replaced atomically. A missing one is the
  first run, and one that cannot be used counts as missing too, so the next login writes it again; degrade() logs
  why. A private file that exists but cannot be read raises: it is not the first run.
- What the tools can go without when Odoo will not serve it (the reasons, the rights to edit punches, contracts,
  change requests, the Discord field) still leaves a trace: degrade() logs what is missing and what the tools do
  instead, once per process and thing, so an employee without the rights gets one line, not one per reload. The
  CLI keeps its output as it was: the package's logger only writes where the dashboard points it.
- Types. A JSON-RPC result is whatever the method called answers, so post(), jsonrpc() and call_kw() return it as
  Any, and so does the envelope's `result`: this is the one place a value enters untyped, and every caller declares
  the rows it asked for beside the `fields` it requested. The rows this module reads itself are the TypedDicts
  below, each holding exactly those fields. Odoo's empty value is False whatever the field's type: a many2one is
  [id, name] or False (Many2one, a pair here, though JSON gives a list that is only ever indexed) and a date or text
  is the string or False. This module imports nothing from the package, so the pure rules (attendance_rules.py) restate
  the few shapes they read, as the fields they need and no others; a row of this module fits them.
"""

from __future__ import annotations

import http.client
import json
import logging
import os
import platform
import re
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping, Sequence
from email.message import Message
from http.client import HTTPResponse
from typing import IO, Any, Literal, TypedDict, Union

Many2one = tuple[int, str]
MaybeMany2one = Union[Many2one, Literal[False]]

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
log = logging.getLogger(__name__)
_degraded: set[str] = set()


class RpcErrorData(TypedDict, total=False):
    """The details of a JSON-RPC error: the exception's name and its message."""

    name: str
    message: str


class RpcError(TypedDict, total=False):
    """A JSON-RPC error: its code and details."""

    code: int
    data: RpcErrorData


class RpcAnswer(TypedDict, total=False):
    """A JSON-RPC response: an error, or the result of the method called."""

    error: RpcError
    result: Any


class SessionInfo(TypedDict):
    """What authenticate and get_session_info say of the session: the user, or None when there is none yet."""

    uid: int | None


class EmployeeCalendar(TypedDict):
    """An hr.employee as the client reads its own: id, name and calendar."""

    id: int
    name: str
    resource_calendar_id: MaybeMany2one


class OpenAttendance(TypedDict):
    """An hr.attendance with no check-out, as open_attendance reads it."""

    id: int
    check_in: str


class ReasonIds(TypedDict):
    """An hr.attendance as open_is_rest reads it: the reasons it was checked in with."""

    attendance_reason_ids: list[int]


class ReasonRow(TypedDict):
    """An hr.attendance.reason, with the fields attendance_reasons requests."""

    id: int
    name: str
    is_rest: bool
    action_type: str
    show_on_attendance_screen: bool


class FieldInfo(TypedDict):
    """A model's field as fields_get answers when asked for its label only."""

    string: str


class PunchedAttendance(TypedDict, total=False):
    """The attendance a punch made: its check-in always, its check-out when the punch was a check-out."""

    check_in: str
    check_out: str


class PunchResult(TypedDict, total=False):
    """What the systray endpoint answers to a punch, with the keys the CLI prints."""

    attendance_state: str
    attendance: PunchedAttendance
    hours_today: float
    last_attendance_worked_hours: float


class OdooError(Exception):
    """Odoo refused or failed a call; the message is for the user."""


class SessionExpired(OdooError):
    """The session is gone: log in again."""


class OdooDown(OdooError):
    """Odoo did not answer, or not with JSON."""


class AccessDenied(OdooError):
    """Wrong user, password or verification code."""


class TotpRequired(OdooError):
    """Odoo wants the two-factor code to finish the login."""


class KeepRedirects(urllib.request.HTTPRedirectHandler):
    """Hand a redirect back as the response instead of following it: the 303 of a finished login."""

    def http_error_302(
        self,
        req: urllib.request.Request,  # noqa: ARG002 - the names of the base handler, which the aliases below need
        fp: IO[bytes],
        code: int,  # noqa: ARG002 - as above
        msg: str,  # noqa: ARG002 - as above
        headers: http.client.HTTPMessage,  # noqa: ARG002 - as above
    ) -> IO[bytes]:
        """Return the redirect itself."""
        return fp

    http_error_301 = http_error_303 = http_error_307 = http_error_308 = http_error_302


def degrade(what: str, error: Exception) -> None:
    """Log, the first time in this process, what the tools go without and why."""
    if what not in _degraded:
        _degraded.add(what)
        log.warning(f"{what} ({error})")


def set_cookies(headers: Message) -> dict[str, str]:
    """Return the cookies a response sets, by name."""
    sent = headers.get_all("Set-Cookie") or []  # pragma: no mutate - header names are case-insensitive
    pairs = (header.partition(";")[0].partition("=") for header in sent)
    return {name.strip(): value.strip() for name, _, value in pairs}


def write_private(path: str, text: str) -> None:
    """Write a file only the user can read, in one step, in the private state folder."""
    os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
    pending = path + ".tmp"  # pragma: no mutate - any name works: it is replaced within this function
    with open(os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
        f.write(text)
    os.replace(pending, path)


def read_private(path: str) -> str:
    """Return a file's text, stripped, or nothing if there is no such file."""
    try:
        with open(path) as f:
            return f.read().strip()
    except FileNotFoundError:
        return ""


def read_config() -> dict[str, str]:
    """Return the saved URL, database and user, or nothing unless all three are there."""
    text = read_private(CONFIG_FILE)
    if not text:
        return {}
    try:
        config = json.loads(text)
    except ValueError as error:
        degrade(f"{CONFIG_FILE} no es JSON: se toma como sin configurar hasta el próximo inicio de sesión", error)
        return {}
    missing = [key for key in CONFIG_KEYS if not config.get(key)] if isinstance(config, dict) else list(CONFIG_KEYS)
    if missing:
        degrade(
            f"{CONFIG_FILE} está incompleto: se toma como sin configurar hasta el próximo inicio de sesión",
            ValueError(f"falta {', '.join(missing)}"),
        )
        return {}
    return {key: str(config[key]) for key in CONFIG_KEYS}


def load_config() -> dict[str, str]:
    """Return the saved configuration, or raise saying how to make one."""
    config = read_config()
    if not config:
        raise OdooError("Falta configurar Odoo. Inicia sesión con `odoo login` o desde el dashboard")
    return config


def save_config(url: str, db: str, user: str) -> None:
    """Save the URL, database and user; never the password."""
    write_private(CONFIG_FILE, json.dumps({"url": url.rstrip("/"), "db": db, "user": user}))


class OdooClient:
    """One Odoo, database and web session: JSON-RPC calls, the login and clocking, as its user."""

    def __init__(self, url: str, db: str, session_id: str = "", device: str = "") -> None:
        self.url = url.rstrip("/")
        self.db = db
        self.session_id = session_id
        self.device = device
        self.user_agent = USER_AGENT
        self.opener = urllib.request.build_opener(KeepRedirects)
        self.uid: int | None = None
        self.employee_id: int | None = None
        self.employee_name: str | None = None
        self.calendar_id: int | None = None
        self._reasons: list[ReasonRow] | None = None
        self._csrf = ""  # pragma: no mutate - login() sets it before login_totp() sends it

    def _open(self, endpoint: str, data: bytes | None, headers: dict[str, str]) -> HTTPResponse:
        try:
            response: HTTPResponse = self.opener.open(
                urllib.request.Request(f"{self.url}{endpoint}", data=data, headers=headers)
            )
        except urllib.error.URLError as error:
            raise OdooDown(f"Odoo no responde ({error.reason})") from error
        return response

    def post(self, endpoint: str, params: Mapping[str, object]) -> tuple[Any, Message]:
        """Make a JSON-RPC call and return its result and the response's headers, or raise what Odoo answered."""
        data = json.dumps({"jsonrpc": "2.0", "method": "call", "params": params, "id": 1}).encode()
        headers = {"Content-Type": "application/json"}  # pragma: no mutate - header names are case-insensitive
        if self.session_id:
            headers["Cookie"] = f"{SESSION_COOKIE}={self.session_id}"  # pragma: no mutate - as above
        resp = self._open(endpoint, data, headers)
        try:
            result: RpcAnswer = json.loads(resp.read())
        except ValueError as unreadable:
            raise OdooDown("Odoo no responde (respuesta no válida)") from unreadable
        if "error" in result:
            error = result["error"]
            details = error.get("data", {})
            if error.get("code") == SESSION_EXPIRED_CODE:
                raise SessionExpired("La sesión de Odoo ha caducado")
            if details.get("name") == ACCESS_DENIED:
                raise AccessDenied("Usuario o contraseña incorrectos")
            raise OdooError(details.get("message", str(error)))
        return result.get("result"), resp.headers

    def jsonrpc(self, endpoint: str, params: Mapping[str, object]) -> Any:
        """Make a JSON-RPC call and return its result."""
        return self.post(endpoint, params)[0]

    def form(self, fields: dict[str, str] | None = None) -> HTTPResponse:
        """Open the two-factor page, posting its fields when there are any, with the session's cookies."""
        cookies = {SESSION_COOKIE: self.session_id, DEVICE_COOKIE: self.device}
        cookie = "; ".join(f"{name}={value}" for name, value in cookies.items() if value)
        headers = {"Cookie": cookie, "User-Agent": self.user_agent}  # pragma: no mutate - as in post()
        data = urllib.parse.urlencode(fields).encode() if fields else None
        return self._open(TOTP_PATH, data, headers)

    def _finish(self, response: HTTPResponse) -> bool:
        cookies = set_cookies(response.headers)
        if response.status not in REDIRECTS or SESSION_COOKIE not in cookies:
            return False
        self.session_id = cookies[SESSION_COOKIE]
        self.device = cookies.get(DEVICE_COOKIE, self.device)
        self.session_info()
        return True

    def login(self, user: str, password: str, code: str = "") -> str:
        """Log in and return the session, finishing two-factor with the code or a remembered device."""
        session: SessionInfo
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

    def login_totp(self, code: str) -> str:
        """Finish a half-open login with the two-factor code, remembering this device, and return the session."""
        fields = {"totp_token": code, "csrf_token": self._csrf, "remember": "1"}
        if not self._finish(self.form(fields)):
            raise AccessDenied("Código de verificación incorrecto")
        return self.session_id

    def session_info(self) -> SessionInfo:
        """Return Odoo's information on the session and take its user from it."""
        info: SessionInfo = self.jsonrpc("/web/session/get_session_info", {})
        self.uid = info.get("uid")
        return info

    def sees_others(self) -> bool:
        """Tell whether Odoo's record rules let this user read anyone else's attendances."""
        if not self.uid:
            self.session_info()
        return bool(self.call_kw("hr.attendance", "search", [[("employee_id.user_id", "!=", self.uid)]], {"limit": 1}))

    def edits_punches(self) -> bool:
        """Tell whether this user may write, create and delete attendances."""
        try:
            return all(
                self.call_kw("hr.attendance", "check_access_rights", [op], {"raise_exception": False})
                for op in ("write", "create", "unlink")
            )
        except SessionExpired:
            raise
        except OdooError as error:
            degrade(
                "Odoo no deja comprobar si puedes corregir fichajes: el diálogo del día queda de solo lectura", error
            )
            return False

    def logout(self) -> None:
        """End the session in Odoo."""
        self.jsonrpc("/web/session/destroy", {})

    def call_kw(
        self, model: str, method: str, args: Sequence[object], kwargs: Mapping[str, object] | None = None
    ) -> Any:
        """Call a method of a model, as the web client does."""
        return self.jsonrpc(
            "/web/dataset/call_kw",
            {"model": model, "method": method, "args": args, "kwargs": kwargs or {}},
        )

    def load_employee(self) -> None:
        """Find the employee of the session's user once, with their calendar."""
        if self.employee_id:
            return
        if not self.uid:
            self.session_info()
        emp: list[EmployeeCalendar] = self.call_kw(
            "hr.employee",
            "search_read",
            [[("user_id", "=", self.uid)]],
            {"fields": ["id", "name", "resource_calendar_id"], "limit": 1},
        )
        if not emp:
            raise OdooError("No se encontró empleado asociado a tu usuario")
        self._take(emp[0])

    def load_other(self, employee_id: int) -> None:
        """Read someone else's employee, by id, instead of the user's own."""
        emp: list[EmployeeCalendar] = self.call_kw(
            "hr.employee", "read", [[employee_id], ["name", "resource_calendar_id"]]
        )
        self._take(emp[0])

    def _take(self, emp: EmployeeCalendar) -> None:
        self.employee_id = emp["id"]
        self.employee_name = emp["name"]
        calendar = emp["resource_calendar_id"]
        self.calendar_id = calendar[0] if calendar else None

    def open_attendance(self) -> OpenAttendance | None:
        """Return the user's attendance with no check-out, or None."""
        self.load_employee()
        rows: list[OpenAttendance] = self.call_kw(
            "hr.attendance",
            "search_read",
            [[("employee_id", "=", self.employee_id), ("check_out", "=", False)]],
            {"fields": ["id", "check_in"], "limit": 1},
        )
        return rows[0] if rows else None

    def open_is_rest(self, open_att: OpenAttendance | None, rest: ReasonRow | None) -> bool:
        """Tell whether the open attendance was checked in with the break reason."""
        if not open_att or not rest:
            return False
        reasoned: list[ReasonIds] = self.call_kw(
            "hr.attendance",
            "search_read",
            [[("id", "=", open_att["id"])]],
            {"fields": ["attendance_reason_ids"]},
        )
        return rest["id"] in reasoned[0]["attendance_reason_ids"]

    def punch(self, reason_id: int | None = None) -> PunchResult:
        """Check in or out through the systray endpoint, with a sign-in reason when given."""
        params = {"attendance_reason_id": reason_id} if reason_id else {}
        result: PunchResult = self.jsonrpc("/hr_attendance/systray_check_in_out", params)
        return result

    def attendance_reasons(self) -> list[ReasonRow]:
        """Return the attendance reasons once, or none where the module or its access is missing."""
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
            except OdooError as error:
                degrade("Odoo no da los motivos de fichaje: se ficha sin motivo y sin descansos", error)
                self._reasons = []
        return self._reasons

    def field_named(self, model: str, label: str) -> str | None:
        """Return the technical name of a model's field by its label, or None."""
        fields: dict[str, FieldInfo] = self.call_kw(model, "fields_get", [], {"attributes": ["string"]})
        return next((name for name, f in fields.items() if f["string"].strip().lower() == label), None)

    def offered_reasons(self) -> list[ReasonRow]:
        """Return the sign-in reasons the attendance screen offers, work before break."""
        rows = [
            r for r in self.attendance_reasons() if r["action_type"] == "sign_in" and r["show_on_attendance_screen"]
        ]
        return sorted(rows, key=lambda r: r["is_rest"])

    def sign_in_reasons(self) -> tuple[ReasonRow | None, ReasonRow | None]:
        """Return the normal and the break sign-in reasons, each None when Odoo has none."""
        rows = self.offered_reasons()
        normal = next((r for r in rows if not r["is_rest"]), None)
        rest = next((r for r in rows if r["is_rest"]), None)
        return normal, rest
