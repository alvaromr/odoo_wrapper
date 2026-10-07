"""Phone access over the LAN: the machine's address and name, the self-signed certificate, the QR.

- Next to the loopback socket there is a TLS one on <host>:TLS_PORT, the whole LAN unless --host names another
  address; --host 127.0.0.1 leaves the loopback one alone. It used to be there only on request, with --host.
  expose() records which it is so phone_access and net_identity know whether there is anything to advertise.
  The server's session guard applies to both sockets alike; the LAN one gets its session by pairing, never by
  password (server.py), which is what lets it be the default.
- _local_only is why nothing listens on the LAN, empty when something does: the option, or a certificate that
  could not be made. phone_access hands it to the page as {off: why}, each reason ending in how to fix it, so the
  page says it where the QR would be: with the LAN as the default, a dashboard without its QR gave no reason.
- The self-signed cert needs the openssl CLI: Python's ssl can use a certificate but cannot create one.
  Without it, or when it fails, ensure_cert says why and returns nothing, and the dashboard stays on loopback
  (dashboard.py): with the LAN as the default, a machine without openssl would otherwise not start at all. One
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
RELAUNCH = "cierra el dashboard (Ctrl+C en la terminal donde se lanzó) y vuelve a lanzarlo"
HOST_OPTION = ("El dashboard se lanzó con la opción --host 127.0.0.1, que lo deja solo en este ordenador. "
               f"Para usarlo desde el móvil, {RELAUNCH} sin esa opción.")
NO_OPENSSL = ("Para que el móvil se conecte de forma segura hace falta el programa openssl, y este ordenador no lo "
              "tiene. En macOS viene con el sistema y, si falta, se instala con Homebrew («brew install openssl»); "
              "en Windows lo incluye Git for Windows (git-scm.com); en Linux es el paquete openssl. "
              f"Cuando esté instalado, {RELAUNCH}.")
CERT_FAILED = ("Para que el móvil se conecte de forma segura se crea un certificado con el programa openssl, y ha "
               "fallado: {error}. Comprueba que funciona escribiendo «openssl version» en la terminal y después "
               + RELAUNCH + ".")
_local_only = HOST_OPTION


def expose(host):
    global _local_only
    _local_only = HOST_OPTION if host in LOOPBACK else ""
    return not _local_only


def local_only(why):
    global _local_only
    _local_only = why
    process.say(why)


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
    return "" if _local_only else f"{bonjour_name()}|{lan_ip()}"


def ensure_cert():
    slug = SLUG_UNSAFE.sub("_", f"{bonjour_name()}-{lan_ip()}")
    cert, key = os.path.join(STATE_DIR, f"cert-{slug}.pem"), os.path.join(STATE_DIR, f"key-{slug}.pem")
    if os.path.exists(cert) and os.path.exists(key):
        return cert, key
    names = f"DNS:{bonjour_name()},DNS:localhost,IP:{lan_ip()},IP:127.0.0.1"
    os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
    openssl = next((path for path in OPENSSL_CANDIDATES if shutil.which(path)), None)
    if not openssl:
        return local_only(NO_OPENSSL)
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
        return local_only(CERT_FAILED.format(error=error))
    os.chmod(key, 0o600)
    process.say(f"Certificado creado para {names}")
    return cert, key


def qr_or_empty(text):
    try:
        return qr.svg(text)
    except ValueError:
        return ""


def phone_access():
    if _local_only:
        return {"off": _local_only}
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
