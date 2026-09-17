"""Unit tests for phone access: LAN address and name, the certificate, the phone URLs and the same-site names."""

import io
import os
import shutil
import socket
import subprocess
import unittest
from contextlib import redirect_stdout
from types import SimpleNamespace
from unittest.mock import Mock, patch

from helpers import temp_state
from odoo_wrapper import lan


class NetworkTest(unittest.TestCase):
    def test_lan_ip_from_a_routed_socket(self):
        sock = Mock()
        sock.getsockname.return_value = ("192.168.1.9", 0)
        with patch.object(socket, "socket", return_value=sock):
            self.assertEqual(lan.lan_ip(), "192.168.1.9")
        sock.connect.assert_called_once_with(("192.0.2.1", 53))
        sock.close.assert_called_once()

    def test_lan_ip_falls_back_to_loopback(self):
        sock = Mock()
        sock.connect.side_effect = OSError
        with patch.object(socket, "socket", return_value=sock):
            self.assertEqual(lan.lan_ip(), "127.0.0.1")
        sock.close.assert_called_once()

    def test_bonjour_name_from_scutil(self):
        with patch.object(subprocess, "run", return_value=SimpleNamespace(stdout="mac\n")):
            self.assertEqual(lan.bonjour_name(), "mac.local")
        with patch.object(subprocess, "run", return_value=SimpleNamespace(stdout="ya.local")):
            self.assertEqual(lan.bonjour_name(), "ya.local")

    def test_bonjour_name_without_scutil(self):
        with patch.object(subprocess, "run", side_effect=OSError), patch.object(socket, "gethostname", return_value="host.lan"):
            self.assertEqual(lan.bonjour_name(), "host.local")
        with patch.object(subprocess, "run", side_effect=OSError), patch.object(socket, "gethostname", return_value=""):
            self.assertEqual(lan.bonjour_name(), "localhost.local")

    def test_expose_and_net_identity(self):
        with patch.object(lan, "bonjour_name", return_value="mac.local"), patch.object(lan, "lan_ip", return_value="10.0.0.2"):
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

    def openssl(self, cmd, *args, **kwargs):
        key, cert = cmd[cmd.index("-keyout") + 1], cmd[cmd.index("-out") + 1]
        for path in (cert, key):
            with open(path, "w") as f:
                f.write("pem")

    def test_generates_once_per_identity(self):
        with patch.object(subprocess, "run", side_effect=self.openssl) as run, redirect_stdout(io.StringIO()):
            cert, key = lan.ensure_cert()
            again = lan.ensure_cert()
        self.assertEqual(run.call_count, 1)
        self.assertTrue(cert.startswith(self.home) and key.startswith(self.home))
        self.assertIn("mac.local-10.0.0.2", cert)
        self.assertIn("mac.local-10.0.0.2", key)
        self.assertEqual(again, (cert, key))
        self.assertIn("subjectAltName=DNS:mac.local,DNS:localhost,IP:10.0.0.2,IP:127.0.0.1", run.call_args[0][0])
        self.assertEqual(oct(os.stat(key).st_mode & 0o777), "0o600")

    def test_a_new_identity_gets_its_own_pair_and_a_known_one_is_reused(self):
        with patch.object(subprocess, "run", side_effect=self.openssl) as run, redirect_stdout(io.StringIO()):
            first = lan.ensure_cert()
            lan.lan_ip.return_value = "10.0.0.3"
            second = lan.ensure_cert()
            lan.lan_ip.return_value = "10.0.0.2"
            third = lan.ensure_cert()
        self.assertEqual(run.call_count, 2)
        self.assertNotEqual(first, second)
        self.assertEqual(first, third)

    def test_openssl_failure_is_fatal(self):
        out = io.StringIO()
        with patch.object(subprocess, "run", side_effect=OSError("no openssl")), redirect_stdout(out):
            with self.assertRaises(SystemExit):
                lan.ensure_cert()
        self.assertIn("openssl", out.getvalue())

    def test_openssl_is_looked_up_in_the_git_for_windows_folders_too(self):
        bundled = lan.OPENSSL_CANDIDATES[1]
        shutil.which.side_effect = lambda path: path if path == bundled else None
        with patch.object(subprocess, "run", side_effect=self.openssl) as run, redirect_stdout(io.StringIO()):
            lan.ensure_cert()
        self.assertEqual(run.call_args[0][0][0], bundled)
        shutil.which.side_effect = lambda path: None
        out = io.StringIO()
        with patch.object(subprocess, "run") as run, redirect_stdout(out), self.assertRaises(SystemExit):
            lan.lan_ip.return_value = "10.0.0.3"
            lan.ensure_cert()
        run.assert_not_called()
        self.assertIn("Git for Windows", out.getvalue())

    def test_slug_strips_unsafe_characters(self):
        with patch.object(lan, "bonjour_name", return_value="Ana’s Mac.local"), \
                patch.object(subprocess, "run", side_effect=self.openssl), redirect_stdout(io.StringIO()):
            cert, key = lan.ensure_cert()
        allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-_")
        self.assertTrue(set(os.path.basename(cert)) <= allowed, cert)
        self.assertTrue(set(os.path.basename(key)) <= allowed, key)


class PhoneTest(unittest.TestCase):
    def test_nothing_unless_exposed(self):
        with patch.object(lan, "_exposed", False):
            self.assertIsNone(lan.phone_access())

    def test_urls(self):
        with patch.object(lan, "_exposed", True), patch.object(lan, "lan_ip", return_value="10.0.0.2"), \
                patch.object(lan, "bonjour_name", return_value="mac.local"):
            self.assertEqual(lan.phone_access(), {"url": "https://10.0.0.2:8443/", "name_url": "https://mac.local:8443/"})

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
            "mac.local": "mac.local",
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
