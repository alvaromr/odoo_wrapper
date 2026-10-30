"""Unit tests for phone access: LAN address and name, the certificate, the phone URLs and the same-site names."""

import io
import os
import shutil
import socket
import subprocess
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from helpers import logged, temp_state

from odoo_wrapper import lan


class NetworkTest(unittest.TestCase):
    def test_lan_ip_from_a_routed_socket(self):
        sock = Mock()
        sock.getsockname.return_value = ("192.168.1.9", 0)
        with patch.object(socket, "socket", return_value=sock) as opened:
            self.assertEqual(lan.lan_ip(), "192.168.1.9")
        opened.assert_called_once_with(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect.assert_called_once_with(("192.0.2.1", 53))
        sock.close.assert_called_once()

    def test_lan_ip_falls_back_to_loopback(self):
        sock = Mock()
        sock.connect.side_effect = OSError
        with patch.object(socket, "socket", return_value=sock):
            self.assertEqual(lan.lan_ip(), "127.0.0.1")
        sock.close.assert_called_once()

    def test_bonjour_name_from_scutil(self):
        with patch.object(subprocess, "run", return_value=SimpleNamespace(stdout="mac\n")) as run:
            self.assertEqual(lan.bonjour_name(), "mac.local")
        run.assert_called_once_with(["scutil", "--get", "LocalHostName"], check=False, capture_output=True, text=True)
        with patch.object(subprocess, "run", return_value=SimpleNamespace(stdout="ya.local")):
            self.assertEqual(lan.bonjour_name(), "ya.local")

    def test_bonjour_name_without_scutil(self):
        with (
            patch.object(subprocess, "run", side_effect=OSError),
            patch.object(socket, "gethostname", return_value="host.lan"),
        ):
            self.assertEqual(lan.bonjour_name(), "host.local")
        with patch.object(subprocess, "run", side_effect=OSError), patch.object(socket, "gethostname", return_value=""):
            self.assertEqual(lan.bonjour_name(), "localhost.local")

    def test_expose_and_net_identity(self):
        with (
            patch.object(lan, "bonjour_name", return_value="mac.local"),
            patch.object(lan, "lan_ip", return_value="10.0.0.2"),
        ):
            self.assertTrue(lan.expose("0.0.0.0"))
            self.assertEqual(lan.net_identity(), "mac.local|10.0.0.2")
            self.assertFalse(lan.expose("127.0.0.1"))
            self.assertEqual(lan.net_identity(), "")


class CertTest(unittest.TestCase):
    def setUp(self):
        self.home = temp_state(self)
        for name, value in (("bonjour_name", "mac.local"), ("lan_ip", "10.0.0.2")):
            patcher = patch.object(lan, name, return_value=value)
            patcher.start()
            self.addCleanup(patcher.stop)
        which = patch.object(shutil, "which", side_effect=lambda path: path if path == "openssl" else None)
        which.start()
        self.addCleanup(which.stop)
        local_only = patch.dict(lan._lan, off="")
        local_only.start()
        self.addCleanup(local_only.stop)

    def openssl(self, cmd, *args, **kwargs):
        key, cert = cmd[cmd.index("-keyout") + 1], cmd[cmd.index("-out") + 1]
        for path in (cert, key):
            with open(path, "w") as f:
                f.write("pem")

    def test_generates_once_per_identity(self):
        with patch.object(subprocess, "run", side_effect=self.openssl) as run, logged() as out:
            cert, key = lan.ensure_cert()
            again = lan.ensure_cert()
        self.assertEqual(run.call_count, 1)
        self.assertEqual(
            "INFO Certificado creado para DNS:mac.local,DNS:localhost,IP:10.0.0.2,IP:127.0.0.1\n", out.getvalue()
        )
        self.assertTrue(cert.startswith(self.home) and key.startswith(self.home))
        self.assertIn("mac.local-10.0.0.2", cert)
        self.assertIn("mac.local-10.0.0.2", key)
        self.assertEqual(again, (cert, key))
        names = "DNS:mac.local,DNS:localhost,IP:10.0.0.2,IP:127.0.0.1"
        run.assert_called_once_with(
            [
                "openssl",
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-days",
                "3650",
                "-subj",
                "/CN=mac.local",
                "-addext",
                f"subjectAltName={names}",
                "-keyout",
                key,
                "-out",
                cert,
            ],
            check=True,
            capture_output=True,
        )
        self.assertEqual(oct(os.stat(key).st_mode & 0o777), "0o600")
        os.remove(key)
        with patch.object(subprocess, "run", side_effect=self.openssl) as run, logged():
            self.assertEqual(lan.ensure_cert(), (cert, key))
        self.assertEqual(run.call_count, 1)

    def test_a_new_identity_gets_its_own_pair_and_a_known_one_is_reused(self):
        with patch.object(subprocess, "run", side_effect=self.openssl) as run, logged():
            first = lan.ensure_cert()
            lan.lan_ip.return_value = "10.0.0.3"
            second = lan.ensure_cert()
            lan.lan_ip.return_value = "10.0.0.2"
            third = lan.ensure_cert()
        self.assertEqual(run.call_count, 2)
        self.assertNotEqual(first, second)
        self.assertEqual(first, third)

    def test_a_failing_openssl_leaves_no_certificate_and_says_why(self):
        out = io.StringIO()
        with patch.object(subprocess, "run", side_effect=OSError("no openssl")), logged(out):
            self.assertIsNone(lan.ensure_cert())
        self.assertEqual(out.getvalue(), f"WARNING {lan.CERT_FAILED.format(error='no openssl')}\n")
        self.assertEqual(lan.phone_access(), {"off": lan.CERT_FAILED.format(error="no openssl")})

    def test_openssl_is_looked_up_in_the_git_for_windows_folders_too(self):
        bundled = lan.OPENSSL_CANDIDATES[1]
        shutil.which.side_effect = lambda path: path if path == bundled else None
        with patch.object(subprocess, "run", side_effect=self.openssl) as run, logged():
            lan.ensure_cert()
        self.assertEqual(run.call_args[0][0][0], bundled)
        shutil.which.side_effect = lambda path: None
        out = io.StringIO()
        with patch.object(subprocess, "run") as run, logged(out):
            lan.lan_ip.return_value = "10.0.0.3"
            self.assertIsNone(lan.ensure_cert())
        run.assert_not_called()
        self.assertEqual(out.getvalue(), f"WARNING {lan.NO_OPENSSL}\n")
        self.assertEqual(lan.phone_access(), {"off": lan.NO_OPENSSL})

    def test_slug_strips_unsafe_characters(self):
        with (
            patch.object(lan, "bonjour_name", return_value="Ana’s Mac.local"),
            patch.object(subprocess, "run", side_effect=self.openssl),
            logged(),
        ):
            cert, key = lan.ensure_cert()
        self.assertEqual(os.path.basename(cert), "cert-Ana_s_Mac.local-10.0.0.2.pem")
        private = os.path.join(self.home, "new")
        with (
            patch.object(lan, "STATE_DIR", private),
            patch.object(subprocess, "run", side_effect=self.openssl),
            logged(),
        ):
            lan.ensure_cert()
        self.assertEqual(oct(os.stat(private).st_mode & 0o777), "0o700")
        allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-_")
        self.assertTrue(set(os.path.basename(cert)) <= allowed, cert)
        self.assertTrue(set(os.path.basename(key)) <= allowed, key)


class PhoneTest(unittest.TestCase):
    def test_why_and_how_when_nothing_listens_on_the_lan(self):
        with patch.dict(lan._lan, off="sin red"):
            self.assertEqual(lan.phone_access(), {"off": "sin red"})
        lan.expose("127.0.0.1")
        self.assertEqual(lan.phone_access(), {"off": lan.HOST_OPTION})

    def test_urls(self):
        with (
            patch.dict(lan._lan, off=""),
            patch.object(lan, "lan_ip", return_value="10.0.0.2"),
            patch.object(lan, "bonjour_name", return_value="mac.local"),
        ):
            self.assertEqual(
                lan.phone_access(), {"url": "https://10.0.0.2:8443/", "name_url": "https://mac.local:8443/"}
            )

    def test_qr_or_empty(self):
        self.assertTrue(lan.qr_or_empty("https://10.0.0.2:8443/").startswith("<svg"))
        self.assertEqual(lan.qr_or_empty("x" * 200), "")


class SameSiteNamesTest(unittest.TestCase):
    def test_hostname_of(self):
        cases = {
            "localhost:8931": "localhost",
            "http://localhost:8931/x": "localhost",
            "https://192.168.1.51:8443": "192.168.1.51",
            "[::1]:8443": "::1",
            "[::1]]:8443": "::1",
            "evil.com:80:8931": "evil.com",
            "mac.local": "mac.local",
            "http://": "",
            "": "",
            None: "",
        }
        for value, expected in cases.items():
            self.assertEqual(lan.hostname_of(value), expected, value)

    def test_local_names_are_accepted(self):
        for name in ("localhost", "mac.local", "127.0.0.1", "192.168.1.51", "::1"):
            self.assertTrue(lan.is_local_name(name), name)

    def test_public_names_are_not(self):
        for name in ("evil.com", "odoo.example.org", "", "localhost.evil.com"):
            self.assertFalse(lan.is_local_name(name), name)


if __name__ == "__main__":
    unittest.main()
