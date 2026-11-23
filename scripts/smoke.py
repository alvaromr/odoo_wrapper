#!/usr/bin/env python3
"""The auth and same-site smoke check of the dashboard running on this machine, over the real sockets.

`python3 scripts/smoke.py` asks the dashboard already listening here, on loopback (server.PORT) and over TLS on this
machine's LAN address (lan.TLS_PORT), what tests/test_server.py checks in process, through the path the suite never
opens: the phone's certificate and address. It expects the login page for anyone, 401 from the API without a session
or with a made-up one, 403 to a login from the LAN, a bogus pairing token sent to /login, and 403 to a foreign Host
(DNS rebinding) and to a foreign Origin (CSRF). It starts no dashboard (AGENTS.md, rule 2): start one first, the
exposed mode in a throwaway HOME as AGENTS.md says, or check the one already running. Every request is one the
dashboard refuses before Odoo is contacted, so a user's own dashboard is safe from it: the punch carries a bogus
action and a foreign Origin. The certificate is the dashboard's own self-signed one, so TLS is not verified.
"""

import http.client
import os
import ssl
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src"))

from odoo_wrapper import lan, server  # noqa: E402 - found only once src/ is on the path

TIMEOUT = 5
LOGIN_TEXT = "Introduce tu usuario"
CHECKS = [
    {"what": "login page over TLS", "tls": True, "path": "/", "status": 200, "text": LOGIN_TEXT},
    {"what": "API over TLS without a session", "tls": True, "path": "/api/personal", "status": 401},
    {
        "what": "API over TLS with a made-up session",
        "tls": True,
        "path": "/api/personal",
        "headers": {"Cookie": "odoo_dash=deadbeef"},
        "status": 401,
    },
    {"what": "login from the LAN", "tls": True, "method": "POST", "path": "/api/login", "body": "{}", "status": 403},
    {"what": "bogus pairing token", "tls": True, "path": "/pair?t=bogus", "status": 303, "location": "/login"},
    {"what": "foreign Host", "path": "/api/personal", "headers": {"Host": "evil.com"}, "status": 403},
    {
        "what": "foreign Origin",
        "method": "POST",
        "path": "/api/attendance",
        "headers": {"Origin": "https://evil.example", "Content-Type": "text/plain"},
        "body": '{"action":"bogus"}',
        "status": 403,
    },
]


def unverified():
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    return context


def connect(check, address):
    if check.get("tls"):
        return http.client.HTTPSConnection(address, lan.TLS_PORT, timeout=TIMEOUT, context=unverified())
    return http.client.HTTPConnection("localhost", server.PORT, timeout=TIMEOUT)


def ask(check, address):
    connection = connect(check, address)
    try:
        connection.request(
            check.get("method", "GET"), check["path"], body=check.get("body"), headers=check.get("headers", {})
        )
        response = connection.getresponse()
        return response.status, response.getheader("Location", ""), response.read().decode(errors="replace")
    finally:
        connection.close()


def verdict(check, address):
    try:
        status, location, text = ask(check, address)
    except OSError as error:
        return f"no answer ({error}); start a dashboard first, as AGENTS.md says"
    wrong = [f"status {status}, expected {check['status']}"] if status != check["status"] else []
    if "location" in check and not location.endswith(check["location"]):
        wrong.append(f"redirect to {location or 'nowhere'}, expected {check['location']}")
    if "text" in check and check["text"] not in text:
        wrong.append(f"no {check['text']!r} in the page")
    return "; ".join(wrong)


def main():
    address = lan.lan_ip()
    failed = 0
    for check in CHECKS:
        wrong = verdict(check, address)
        print(f"FAIL {check['what']}: {wrong}" if wrong else f"ok   {check['what']}")
        failed += bool(wrong)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
