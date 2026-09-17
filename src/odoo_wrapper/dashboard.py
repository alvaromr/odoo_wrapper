#!/usr/bin/env python3
"""Local attendance dashboard: weekly hours, clock in/out and Odoo absences. This is the entry point.

Run `bin/odoo-dashboard --help` for usage. main() only wires the pieces together; each one explains
itself at its top:

  server.py    pages, JSON API, Odoo sessions as the login, same-site guard
  data.py      the payload read from Odoo (sessions, schedule, absences) and its cache
  state.py     the shared state file (lunch stamp, durations, mute)
  lan.py       phone access: LAN address and name, self-signed certificate, QR
  process.py   log, self-restart on source or network changes, port check

The page is documented at the top of each file in templates/js/ and of templates/style.css, the QR
encoder in qr.py,
and what the Odoo side offers in AGENTS.md § Odoo API notes.
"""

import os
import ssl
import sys
import threading
import webbrowser
from http.server import ThreadingHTTPServer

from . import lan, process, server
from .client import STATE_DIR, read_config

USAGE = f"""Uso: odoo-dashboard [--host <ip>] [--open]

Sirve el dashboard de horas en http://localhost:{server.PORT}/ y se queda en marcha hasta Ctrl+C.
La primera vez pide iniciar sesión en Odoo (URL, base de datos, usuario y contraseña);
solo se conserva la sesión, en el navegador, nunca la contraseña.

Opciones:
  --host <ip>   Además escucha en https://<ip>:{lan.TLS_PORT}/ para el móvil (0.0.0.0 = toda la LAN).
                Necesita el comando openssl para crear el certificado; la primera vez el
                móvil pedirá aceptarlo. El móvil entra emparejándolo desde este ordenador:
                «Emparejar móvil» en el panel muestra un QR de un solo uso que caduca a los
                {server.PAIR_TTL // 60} min y comparte la sesión del navegador. En la red no hay login con contraseña.
  --open        Abre el navegador al arrancar.

Al guardar cambios en el código se reinicia solo; no hace falta pararlo. Si el puerto {server.PORT}
está ocupado es que ya hay otro dashboard: recarga esa página en vez de arrancar otro.

Ficheros, en {STATE_DIR}:
  config.json    URL, base de datos y usuario
  state.json     comida, descansos y silencio del día, compartidos entre tus dispositivos
  cert-<red>.pem, key-<red>.pem   un certificado por red (nombre e IP); al volver a una red conocida se reutiliza
  dashboard.log  salida del servidor cuando no hay terminal; al pasar de 1 MB se aparta como .1"""


def main():
    if any(arg in ("-h", "--help") for arg in sys.argv[1:]):
        print(USAGE)
        sys.exit(0)
    process.own_the_output()
    if "--host" in sys.argv:
        host_index = sys.argv.index("--host") + 1
        if host_index >= len(sys.argv):
            print("ERROR: --host necesita una dirección (0.0.0.0 para toda la red)")
            sys.exit(1)
        host = sys.argv[host_index]
    else:
        host = "127.0.0.1"
    exposed = lan.expose(host)
    grace = process.RESTART_GRACE if os.environ.pop(process.RESTART_ENV, None) else 0
    if process.port_taken(server.PORT, grace):
        print(f"ERROR: ya hay un dashboard escuchando en http://localhost:{server.PORT}/")
        print("Recarga esa página; para aplicar cambios de código basta con guardarlos (se reinicia solo).")
        sys.exit(1)
    probe_host = "127.0.0.1" if host == "0.0.0.0" else host
    if exposed and process.port_taken(lan.TLS_PORT, grace, probe_host):
        print(f"ERROR: el puerto {lan.TLS_PORT} ya está ocupado por otro proceso")
        sys.exit(1)
    http = ThreadingHTTPServer(("127.0.0.1", server.PORT), server.Handler)
    url = f"http://localhost:{server.PORT}/"
    process.say(f"Dashboard en {url} (Ctrl+C para parar)")
    if not read_config():
        process.say(f"Sin configurar: abre {url} e inicia sesión en Odoo")
    if exposed:
        cert, key = lan.ensure_cert()
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        tls = ThreadingHTTPServer((host, lan.TLS_PORT), server.Handler)
        tls.socket = context.wrap_socket(tls.socket, server_side=True)
        threading.Thread(target=tls.serve_forever, daemon=True).start()
        process.say(f"Móvil: escucha en https://{lan.bonjour_name()}:{lan.TLS_PORT}/ y https://{lan.lan_ip()}:{lan.TLS_PORT}/")
        process.say(f"Para entrar desde él, pulsa «Emparejar móvil» en {url}")
    threading.Thread(target=process.watch_sources, args=(lan.net_identity,), daemon=True).start()
    if "--open" in sys.argv:
        threading.Timer(0.4, webbrowser.open, [url]).start()
    http.serve_forever()


if __name__ == "__main__":
    main()
