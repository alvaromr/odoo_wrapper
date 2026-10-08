#!/usr/bin/env python3
"""The attendance CLI, printing in Spanish:
`odoo status|checkin|checkout|toggle|break|resume|history|notices|sheet|login`.

Run it with no arguments for usage. It keeps its own Odoo session in ~/.odoo_dashboard/cli_session, written
by `odoo login`, which asks for the password on the terminal and never stores it; the dashboard's sessions
live in the browsers instead, so the two tools never share or invalidate each other's login. When Odoo asks
for a two-factor code, `odoo login` asks for it too and keeps the trusted-device key Odoo answers with in
cli_device, so the next login within 90 days skips the code (client.py says how). Every command
builds one OdooClient (client.py), runs one action and exits; sheet never reaches Odoo and builds none, so it
works without a session.

Odoo ends a session idle for about a week, and this one is idle most of the time (the dashboard's are renewed
by the polling of their open pages), so it used to be dead by the time an agent needed it. Two answers:
- keep_alive, which the dashboard runs in a thread of its own (a call to Odoo can hang, and the source watcher
  must not): every KEEPALIVE_INTERVAL it reads cli_session again, since a login rewrites it, and asks Odoo for
  the session info, the call that renews it. It works only while the dashboard runs and the machine is awake,
  and it never logs in: a missing or dead session, or an Odoo out of reach, is left for the next round.
- A command that finds the session missing or expired logs in on the spot and starts over, so it reads the
  real state again before punching, when there is a terminal to ask the password on. Without one (an agent,
  a script) `Ejecuta: odoo login` is still the only answer.

notices brings the warnings spreadsheet up to date, a Google Sheets file reached through sheets.py: tab «Avisos
<year>» gets a row per notice (employee, month, date, kind) and «Avisos Totales» each employee's count, once a
month. It is one command with nothing to decide, so that someone who is not technical can run it, by hand or
from a scheduled task, without an agent in between.
- A notice is a day already over, of anyone the session can read (team.py says who), with a punch error still
  unfixed (team.py's day flags, «Incidencia») or an attendance change request («Solicitud»): one row per
  employee, day and kind. Only the rows the sheet lacks are appended, so a second run adds nothing, and none is
  ever rewritten: people fill the sheet's other columns by hand, which is also why those are left empty.
- Each run covers the month in progress up to yesterday and, before it, the previous month if it is not closed
  yet: its notices, then its totals. A month is closed when «Avisos Totales» has a row with its name, so the
  totals are written once, when the month is over. That tab has no year: a file is expected to hold one.
- The totals count the sheet's own rows of the month per employee, not Odoo's: the sheet is the record, and an
  error fixed since is still a notice given.
- What people change by hand stays as they left it, so a row they deleted or rewrote must not come back, and the
  sheet alone cannot tell it from one never written. notices_written keeps, per spreadsheet, every row once
  appended to it, noted only after the sheet took it, and those are never appended again. The sheet is still
  read: it is all there is on a machine without that file, or with one that cannot be read, taken as empty like
  a broken config. Closing a month is not remembered this way: deleting all its totals asks for them again.
- Dates are compared as the serial number Sheets stores (days since SHEET_EPOCH), whatever format the cell
  shows.
- sheet remembers which spreadsheet that is, in notices_sheet, and notices asks for it on the spot the first
  time when there is a terminal to ask on: its address must not be needed on every run. Only its id is kept,
  and in the state directory like everything else that is one person's: the address of a staff record has no
  place in the repo.
"""

import getpass
import json
import os
import re
import sys
import time
from collections import Counter
from datetime import date, datetime, timedelta, timezone

from . import team
from .client import (
    STATE_DIR, OdooClient, OdooError, SessionExpired, TotpRequired, load_config, read_config, read_private,
    save_config, write_private,
)
from .sheets import Sheets, SheetsError

CLI_SESSION_FILE = os.path.join(STATE_DIR, "cli_session")
CLI_DEVICE_FILE = os.path.join(STATE_DIR, "cli_device")
SHEET_FILE = os.path.join(STATE_DIR, "notices_sheet")
WRITTEN_FILE = os.path.join(STATE_DIR, "notices_written")
SHEET_URL = re.compile(r"/spreadsheets/d/([\w-]+)")
KEEPALIVE_INTERVAL = 3600
MONTHS = ("Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre",
          "Noviembre", "Diciembre")
NOTICE_KINDS = (("Incidencia", "flags"), ("Solicitud", "requests"))
TOTALS_TAB = "Avisos Totales"
SHEET_COLUMNS = 4
SHEET_EPOCH = date(1899, 12, 30)
USAGE = f"""Uso: odoo <comando>

Comandos:
  login           Iniciar sesión en Odoo: pide URL, base de datos y usuario la primera vez,
                  la contraseña siempre y el código de verificación (2FA) si Odoo lo exige;
                  guarda solo la sesión (nunca la contraseña) y este equipo como dispositivo
                  de confianza durante 90 días
  status          Estado actual (fichado o no) y horas de hoy
  checkin         Fichar entrada
  checkout        Fichar salida
  toggle          Fichar entrada o salida, lo que toque
  break           Salir a descanso: cierra el fichaje abierto y abre otro con motivo Descanso
  resume          Volver del descanso: cierra el descanso y abre un fichaje Normal
  history [días]  Historial de los últimos días (7 por defecto)
  notices         Poner al día la hoja de avisos (Google Sheets): añade a «Avisos <año>» cada día
                  ya pasado con un error de fichaje sin corregir (Incidencia) o con una solicitud
                  de modificación de fichaje (Solicitud), de todos los empleados que ve la sesión,
                  del mes en curso; y, si el mes anterior aún no tiene totales, también los suyos
                  y el número de avisos de cada empleado en «Avisos Totales». Solo añade filas:
                  nunca repite una que ya escribió, aunque después se borre o cambie a mano
  sheet [URL]     Identificador de la hoja de avisos guardada; con la dirección de una hoja de
                  cálculo de Google, la guarda antes como hoja de avisos

checkin, checkout, toggle, break y resume registran fichajes reales en Odoo; status, history y notices
solo leen de Odoo, y sheet ni siquiera contacta con él.
notices escribe en la hoja con la cuenta de Google de gws (el único programa externo que se usa, y solo
aquí): necesita gws instalado y con sesión («gws auth login -s sheets») y la hoja compartida con esa
cuenta como editor. La primera vez pregunta la dirección de la hoja y la recuerda.
break y resume necesitan el motivo Descanso en Odoo (módulo hr_attendance_reason); sin él lo dicen y no fichan.
Odoo caduca una sesión tras una semana sin uso; el dashboard, mientras está en marcha, mantiene viva
la de este CLI. Si aun así no existe o ha caducado, el comando pide iniciar sesión en el momento y
continúa; sin terminal (un agente, un script) responde «Ejecuta: odoo login».

Ficheros, en {STATE_DIR}:
  config.json      URL, base de datos y usuario
  cli_session      sesión de Odoo de este CLI; bórralo para cerrar sesión
  cli_device       dispositivo de confianza para el 2FA; bórralo para que vuelva a pedir el código
  notices_sheet    hoja de avisos guardada con sheet; bórralo para olvidarla
  notices_written  avisos ya escritos en cada hoja, para no repetir los que se borren o cambien a mano"""


def local_time(ts):
    return datetime.strptime(ts, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).astimezone()


def status(client):
    open_att = client.open_attendance()
    if open_att:
        checkin_local = local_time(open_att["check_in"])
        hours = (datetime.now(timezone.utc) - checkin_local).total_seconds() / 3600
        _, rest = client.sign_in_reasons()
        print(f"Estado: FICHADO ({'descanso' if client.open_is_rest(open_att, rest) else 'entrada'})")
        print(f"Check-in: {checkin_local.strftime('%H:%M:%S')} ({hours:.1f}h)")
    else:
        print("Estado: NO FICHADO (salida)")
        last = client.call_kw(
            "hr.attendance",
            "search_read",
            [[("employee_id", "=", client.employee_id)]],
            {
                "fields": ["check_in", "check_out", "worked_hours"],
                "limit": 1,
                "order": "check_in desc",
            },
        )
        if last:
            print(f"Último check-out: {local_time(last[0]['check_out']).strftime('%H:%M:%S')}")

    local_midnight = datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
    today_start = local_midnight.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    today_records = client.call_kw(
        "hr.attendance",
        "search_read",
        [
            [
                ("employee_id", "=", client.employee_id),
                ("check_in", ">=", today_start),
            ]
        ],
        {"fields": ["check_in", "check_out", "worked_hours"], "order": "check_in asc"},
    )
    total_hours = 0
    for r in today_records:
        if r["check_out"]:
            total_hours += r["worked_hours"]
        else:
            total_hours += (datetime.now(timezone.utc) - local_time(r["check_in"])).total_seconds() / 3600
    print(f"Horas hoy: {total_hours:.2f}h")


def toggle(client):
    open_att = client.open_attendance()
    normal, _ = client.sign_in_reasons()
    result = client.punch(None if open_att else (normal and normal["id"]))
    state = result.get("attendance_state", "")
    att = result.get("attendance", {})
    hours_today = result.get("hours_today", 0)

    if state == "checked_in":
        print(f"CHECK-IN registrado a las {local_time(att['check_in']).strftime('%H:%M:%S')}")
    elif state == "checked_out":
        session_hours = result.get("last_attendance_worked_hours", 0)
        print(f"CHECK-OUT registrado a las {local_time(att['check_out']).strftime('%H:%M:%S')} ({session_hours:.2f}h esta sesión)")

    print(f"Horas hoy: {hours_today:.2f}h")


def check_in(client):
    open_att = client.open_attendance()
    if open_att:
        print(f"Ya estás fichado desde las {local_time(open_att['check_in']).strftime('%H:%M:%S')}. Usa 'checkout' para salir.")
        return
    normal, _ = client.sign_in_reasons()
    result = client.punch(normal and normal["id"])
    att = result.get("attendance", {})
    print(f"CHECK-IN registrado a las {local_time(att['check_in']).strftime('%H:%M:%S')}")
    print(f"Horas hoy: {result.get('hours_today', 0):.2f}h")


def check_out(client):
    open_att = client.open_attendance()
    if not open_att:
        print("No hay fichaje abierto. Usa 'checkin' para entrar.")
        return
    result = client.punch()
    att = result.get("attendance", {})
    session_hours = result.get("last_attendance_worked_hours", 0)
    print(f"CHECK-OUT registrado a las {local_time(att['check_out']).strftime('%H:%M:%S')} ({session_hours:.2f}h esta sesión)")
    print(f"Horas hoy: {result.get('hours_today', 0):.2f}h")


def take_break(client):
    open_att = client.open_attendance()
    _, rest = client.sign_in_reasons()
    if not rest:
        print("Este Odoo no tiene el motivo Descanso; no se puede fichar un descanso.")
        return
    if not open_att:
        print("No hay fichaje abierto. Usa 'checkin' para entrar.")
        return
    if client.open_is_rest(open_att, rest):
        print("Ya estás en descanso. Usa 'resume' para volver.")
        return
    client.punch()
    result = client.punch(rest["id"])
    att = result.get("attendance", {})
    print(f"DESCANSO iniciado a las {local_time(att['check_in']).strftime('%H:%M:%S')}")
    print(f"Horas hoy: {result.get('hours_today', 0):.2f}h")


def resume(client):
    open_att = client.open_attendance()
    normal, rest = client.sign_in_reasons()
    if not client.open_is_rest(open_att, rest):
        print("No hay un descanso abierto. Usa 'break' para salir a descanso.")
        return
    closed = client.punch()
    result = client.punch(normal and normal["id"])
    att = result.get("attendance", {})
    print(f"VUELTA del descanso a las {local_time(att['check_in']).strftime('%H:%M:%S')}"
          f" ({closed.get('last_attendance_worked_hours', 0):.2f}h de descanso)")
    print(f"Horas hoy: {result.get('hours_today', 0):.2f}h")


def history(client, days=7):
    client.load_employee()
    since = (datetime.now(timezone.utc) - timedelta(days=days)).strftime(
        "%Y-%m-%d %H:%M:%S"
    )
    records = client.call_kw(
        "hr.attendance",
        "search_read",
        [
            [
                ("employee_id", "=", client.employee_id),
                ("check_in", ">=", since),
            ]
        ],
        {
            "fields": ["check_in", "check_out", "worked_hours"],
            "order": "check_in desc",
        },
    )
    if not records:
        print(f"No hay registros en los últimos {days} días")
        return

    current_date = None
    daily_total = 0
    for r in records:
        ci_local = local_time(r["check_in"])
        date_str = ci_local.strftime("%Y-%m-%d (%a)")

        if current_date and current_date != date_str:
            print(f"  {'':>23} TOTAL: {daily_total:.2f}h")
            daily_total = 0

        if current_date != date_str:
            print(f"\n{date_str}")
            current_date = date_str

        ci_str = ci_local.strftime("%H:%M")
        if r["check_out"]:
            co_str = local_time(r["check_out"]).strftime("%H:%M")
            print(f"  {ci_str} - {co_str}  ({r['worked_hours']:.2f}h)")
            daily_total += r["worked_hours"]
        else:
            elapsed = (datetime.now(timezone.utc) - ci_local).total_seconds() / 3600
            print(f"  {ci_str} - ...    ({elapsed:.2f}h en curso)")
            daily_total += elapsed

    print(f"  {'':>23} TOTAL: {daily_total:.2f}h")


def save_sheet(url):
    found = SHEET_URL.search(url)
    if not found:
        raise OdooError(f"«{url}» no es la dirección de una hoja de cálculo de Google")
    write_private(SHEET_FILE, found.group(1))


def saved_sheet():
    saved = read_private(SHEET_FILE)
    if not saved:
        raise OdooError("No hay hoja de avisos guardada. Ejecuta: odoo sheet <dirección de la hoja>")
    return saved


def sheet(url=None):
    if url:
        save_sheet(url)
    print(saved_sheet())


def ledger():
    try:
        return dict(json.loads(read_private(WRITTEN_FILE) or "{}"))
    except (ValueError, TypeError):
        return {}


def sheet_rows(sheets, month):
    return [(row + [""] * SHEET_COLUMNS)[:SHEET_COLUMNS] for row in sheets.get(f"Avisos {month.year}!B4:E")]


def add_notices(client, sheets, month):
    known = {(employee, day, kind) for employee, _, day, kind in sheet_rows(sheets, month)}
    book = ledger()
    written = book.setdefault(sheets.id, [])
    payload = team.build_team(client, *team.month_span(month))
    stop = min(payload["stop"], payload["generated_at"][:10])
    found = sorted((date.fromisoformat(d["date"]), e["name"], kind)
                   for e in payload["employees"] for d in e["days"] if payload["start"] <= d["date"] < stop
                   for kind, field in NOTICE_KINDS if d[field])
    rows = [[employee, MONTHS[day.month - 1], day.strftime("%d/%m/%Y"), kind] for day, employee, kind in found
            if (employee, (day - SHEET_EPOCH).days, kind) not in known]
    rows = [row for row in rows if row not in written]
    sheets.append(f"Avisos {month.year}!B4:E", rows)
    written += rows
    write_private(WRITTEN_FILE, json.dumps(book))
    print(f"Avisos de {MONTHS[month.month - 1].lower()} añadidos a «Avisos {month.year}»: {len(rows)}")


def add_totals(sheets, month):
    name = MONTHS[month.month - 1]
    counts = Counter(employee for employee, row_month, _, _ in sheet_rows(sheets, month) if row_month == name)
    sheets.append(f"{TOTALS_TAB}!B4:D", [[employee, count, name] for employee, count in sorted(counts.items())])
    print(f"Empleados con avisos en {name.lower()}, anotados en «{TOTALS_TAB}»: {len(counts)}")


def notices(client, today):
    if not read_private(SHEET_FILE) and sys.stdin and sys.stdin.isatty():
        save_sheet(ask("Dirección de la hoja de avisos"))
    sheets = Sheets(saved_sheet())
    current = today.replace(day=1)
    previous = (current - timedelta(days=1)).replace(day=1)
    closed = {name for row in sheets.get(f"{TOTALS_TAB}!D4:D") for name in row}
    if MONTHS[previous.month - 1] not in closed:
        add_notices(client, sheets, previous)
        add_totals(sheets, previous)
    add_notices(client, sheets, current)


def ask(prompt, default=""):
    answer = input(f"{prompt} [{default}]: " if default else f"{prompt}: ").strip()
    return answer or default


def cli_login():
    config = read_config()
    url = config.get("url") or ask("URL de Odoo")
    db = config.get("db") or ask("Base de datos")
    user = ask("Usuario", config.get("user", ""))
    client = OdooClient(url, db, device=read_private(CLI_DEVICE_FILE))
    try:
        client.login(user, getpass.getpass("Contraseña: "))
    except TotpRequired:
        client.login_totp(ask("Código de verificación (2FA)"))
    save_config(url, db, user)
    write_private(CLI_SESSION_FILE, client.session_id)
    if client.device:
        write_private(CLI_DEVICE_FILE, client.device)
    print(f"Sesión guardada en {CLI_SESSION_FILE}")


def cli_client():
    config = load_config()
    session_id = read_private(CLI_SESSION_FILE)
    if not session_id:
        raise SessionExpired("No hay sesión de Odoo guardada")
    return OdooClient(config["url"], config["db"], session_id)


def keep_alive():
    while True:
        try:
            cli_client().session_info()
        except (OdooError, OSError):
            pass
        time.sleep(KEEPALIVE_INTERVAL)


COMMANDS = {"status": status, "checkin": check_in, "checkout": check_out, "toggle": toggle,
            "break": take_break, "resume": resume}


def run(cmd):
    if cmd == "sheet":
        sheet(*sys.argv[2:3])
        return
    client = cli_client()
    if cmd == "history":
        arg = sys.argv[2] if len(sys.argv) > 2 else "7"
        if not arg.isdigit() or not int(arg):
            raise OdooError(f"history espera un número de días, no «{arg}»")
        history(client, int(arg))
    elif cmd == "notices":
        notices(client, date.today())
    else:
        COMMANDS[cmd](client)


def main():
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help", "help"):
        print(USAGE)
        sys.exit(0)

    cmd = sys.argv[1].lower()
    if cmd not in ("login", "history", "notices", "sheet", *COMMANDS):
        print(f"Comando desconocido: {cmd}")
        print(USAGE)
        sys.exit(1)

    try:
        if cmd == "login":
            cli_login()
            return
        try:
            run(cmd)
        except SessionExpired as error:
            if not (sys.stdin and sys.stdin.isatty()):
                raise
            print(f"{error}. Inicia sesión para continuar.")
            cli_login()
            run(cmd)
    except SessionExpired as error:
        print(f"ERROR: {error}. Ejecuta: odoo login", file=sys.stderr)
        sys.exit(1)
    except (OdooError, SheetsError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
