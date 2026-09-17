"""Phone access over the LAN: the machine's address and name, the self-signed certificate, the QR.

- --host adds a TLS socket on <host>:TLS_PORT next to the loopback one; expose() records that so
  phone_access and net_identity know whether there is anything to advertise. The server's session guard
  applies to both sockets alike; the LAN one gets its session by pairing, never by password (server.py).
- The self-signed cert needs the openssl CLI: Python's ssl can use a certificate but cannot create one. One
  certificate per network identity (bonjour name + LAN IP) is kept in ~/.odoo_dashboard/, reused whenever the
  laptop returns to a network it has seen, so the phone accepts each network's certificate once; a new
  network gets a new one (the process watcher asks net_identity and restarts when it changes). On Windows
  openssl is looked up in Git for Windows' folders too (OPENSSL_CANDIDATES).
- Two URLs: the IP one and the .local one. A phone with Android Private DNS sends every lookup to the external
  resolver and can never resolve mDNS, so the IP one is the one that always works; the name one is for phones
  that do resolve it, and pairs once for every network where it resolves, since the cookie follows the host.
  The QR is drawn by the server for the pairing link only (server.py); qr_or_empty is its fallback when the
  link is too long for the encoder.
- hostname_of and is_local_name are what the server uses to accept a request only when its Host (and Origin,
  when present) is an IP literal, localhost or a .local name. The rule pins no address, so it survives
  network changes.
"""

import os
import re
import shutil
import socket
import subprocess
import sys
from urllib.parse import urlsplit

from . import process, qr
from .client import STATE_DIR

TLS_PORT = 8443
LOOPBACK = ("127.0.0.1", "::1", "localhost")
SLUG_UNSAFE = re.compile(r"[^A-Za-z0-9.-]")
OPENSSL_CANDIDATES = (
    "openssl",
    r"C:\Program Files\Git\usr\bin\openssl.exe",
    r"C:\Program Files\Git\mingw64\bin\openssl.exe",
)
_exposed = False


def expose(host):
    global _exposed
    _exposed = host not in LOOPBACK
    return _exposed


def lan_ip():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("192.0.2.1", 53))
        return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


def bonjour_name():
    try:
        name = subprocess.run(["scutil", "--get", "LocalHostName"], capture_output=True, text=True).stdout.strip()
    except OSError:
        name = ""
    name = name or socket.gethostname().split(".")[0] or "localhost"
    return name if name.endswith(".local") else f"{name}.local"


def net_identity():
    return f"{bonjour_name()}|{lan_ip()}" if _exposed else ""


def ensure_cert():
    slug = SLUG_UNSAFE.sub("_", f"{bonjour_name()}-{lan_ip()}")
    cert, key = os.path.join(STATE_DIR, f"cert-{slug}.pem"), os.path.join(STATE_DIR, f"key-{slug}.pem")
    if os.path.exists(cert) and os.path.exists(key):
        return cert, key
    names = f"DNS:{bonjour_name()},DNS:localhost,IP:{lan_ip()},IP:127.0.0.1"
    os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
    openssl = next((path for path in OPENSSL_CANDIDATES if shutil.which(path)), None)
    if not openssl:
        print("ERROR: falta openssl, necesario para el certificado del móvil")
        print("En Windows lo incluye Git for Windows (git-scm.com); en Linux, el paquete openssl")
        sys.exit(1)
    try:
        subprocess.run(
            [
                openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650",
                "-subj", f"/CN={bonjour_name()}", "-addext", f"subjectAltName={names}",
                "-keyout", key, "-out", cert,
            ],
            check=True,
            capture_output=True,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        print(f"ERROR: no se pudo generar el certificado TLS con openssl: {error}")
        sys.exit(1)
    os.chmod(key, 0o600)
    process.say(f"Certificado creado para {names}")
    return cert, key


def qr_or_empty(text):
    try:
        return qr.svg(text)
    except ValueError:
        return ""


def phone_access():
    if not _exposed:
        return None
    return {"url": f"https://{lan_ip()}:{TLS_PORT}/", "name_url": f"https://{bonjour_name()}:{TLS_PORT}/"}


def hostname_of(value):
    if not value:
        return ""
    if "//" in value:
        return urlsplit(value).hostname or ""
    if value.startswith("["):
        return value[1:].split("]", 1)[0]
    return value.split(":", 1)[0]


def is_local_name(name):
    if name == "localhost" or name.endswith(".local"):
        return True
    for family in (socket.AF_INET, socket.AF_INET6):
        try:
            socket.inet_pton(family, name)
            return True
        except OSError:
            continue
    return False
