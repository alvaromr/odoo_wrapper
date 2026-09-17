#!/usr/bin/env python3
"""The attendance CLI: `odoo status|checkin|checkout|toggle|break|resume|history|login`, printing in Spanish.

Run it with no arguments for usage. It keeps its own Odoo session in ~/.odoo_dashboard/cli_session, written
by `odoo login`, which asks for the password on the terminal and never stores it; the dashboard's sessions
live in the browsers instead, so the two tools never share or invalidate each other's login. When Odoo asks
for a two-factor code, `odoo login` asks for it too and keeps the trusted-device key Odoo answers with in
cli_device, so the next login within 90 days skips the code (client.py says how). Every command
builds one OdooClient (client.py), runs one action and exits; `Ejecuta: odoo login` is the only answer to a
missing or expired session.
"""

import getpass
import os
import sys
from datetime import datetime, timedelta, timezone

from .client import (
    STATE_DIR, OdooClient, OdooError, SessionExpired, TotpRequired, load_config, read_config, read_private,
    save_config, write_private,
)

CLI_SESSION_FILE = os.path.join(STATE_DIR, "cli_session")
CLI_DEVICE_FILE = os.path.join(STATE_DIR, "cli_device")
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

checkin, checkout, toggle, break y resume registran fichajes reales en Odoo; status e history solo leen.
break y resume necesitan el motivo Descanso en Odoo (módulo hr_attendance_reason); sin él lo dicen y no fichan.
Si un comando responde «Ejecuta: odoo login», la sesión no existe o Odoo la ha caducado.

Ficheros, en {STATE_DIR}:
  config.json   URL, base de datos y usuario
  cli_session   sesión de Odoo de este CLI; bórralo para cerrar sesión
  cli_device    dispositivo de confianza para el 2FA; bórralo para que vuelva a pedir el código"""


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
        if last and last[0]["check_out"]:
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


COMMANDS = {"status": status, "checkin": check_in, "checkout": check_out, "toggle": toggle,
            "break": take_break, "resume": resume}


def main():
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help", "help"):
        print(USAGE)
        sys.exit(0)

    cmd = sys.argv[1].lower()
    if cmd not in ("login", "history", *COMMANDS):
        print(f"Comando desconocido: {cmd}")
        print(USAGE)
        sys.exit(1)

    try:
        if cmd == "login":
            cli_login()
            return
        client = cli_client()
        if cmd == "history":
            arg = sys.argv[2] if len(sys.argv) > 2 else "7"
            if not arg.isdigit() or not int(arg):
                raise OdooError(f"history espera un número de días, no «{arg}»")
            history(client, int(arg))
        else:
            COMMANDS[cmd](client)
    except SessionExpired as error:
        print(f"ERROR: {error}. Ejecuta: odoo login", file=sys.stderr)
        sys.exit(1)
    except OdooError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
