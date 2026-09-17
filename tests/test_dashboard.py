"""Unit tests for the dashboard entry point: how main() wires the pieces, with every piece mocked."""

import io
import os
import runpy
import socket
import sys
import threading
import unittest
from contextlib import redirect_stdout
from types import SimpleNamespace
from unittest.mock import Mock, patch

from helpers import CONFIG, temp_state
from odoo_wrapper import dashboard as d
from odoo_wrapper import lan, process as pr, server as sv


class MainTest(unittest.TestCase):
    def setUp(self):
        temp_state(self)
        self.server = Mock()
        patches = {
            "own_the_output": patch.object(pr, "own_the_output"),
            "port_taken": patch.object(pr, "port_taken", return_value=False),
            "read_config": patch.object(d, "read_config", return_value=CONFIG),
            "server": patch.object(d, "ThreadingHTTPServer", return_value=self.server),
            "thread": patch.object(threading, "Thread"),
            "timer": patch.object(threading, "Timer"),
            "cert": patch.object(lan, "ensure_cert", return_value=("c.pem", "k.pem")),
            "ssl": patch.object(d, "ssl", Mock()),
            "bonjour": patch.object(lan, "bonjour_name", return_value="mac.local"),
            "ip": patch.object(lan, "lan_ip", return_value="10.0.0.2"),
            "exposed": patch.object(lan, "_exposed", False),
        }
        self.mocks = {name: p.start() for name, p in patches.items()}
        for p in patches.values():
            self.addCleanup(p.stop)

    def main(self, *argv):
        out = io.StringIO()
        with patch.object(sys, "argv", ["dash", *argv]), redirect_stdout(out):
            d.main()
        return out.getvalue()

    def fails(self, *argv):
        out = io.StringIO()
        with patch.object(sys, "argv", ["dash", *argv]), redirect_stdout(out), self.assertRaises(SystemExit):
            d.main()
        return out.getvalue()

    def test_loopback_only(self):
        out = self.main()
        self.assertIn("http://localhost:8931/", out)
        self.assertNotIn("móvil", out)
        self.mocks["server"].assert_called_once_with(("127.0.0.1", sv.PORT), sv.Handler)
        self.server.serve_forever.assert_called_once()
        self.mocks["cert"].assert_not_called()
        self.assertFalse(lan._exposed)
        self.assertNotIn("Sin configurar", out)

    def test_exposed_serves_tls_too(self):
        out = self.main("--host", "0.0.0.0")
        self.assertIn("https://mac.local:8443/", out)
        self.assertIn("https://10.0.0.2:8443/", out)
        self.mocks["cert"].assert_called_once()
        self.mocks["ssl"].SSLContext.return_value.load_cert_chain.assert_called_once_with("c.pem", "k.pem")
        self.assertEqual(self.mocks["server"].call_args_list[1].args[0], ("0.0.0.0", lan.TLS_PORT))
        self.assertTrue(lan._exposed)

    def test_open_launches_the_browser(self):
        self.main("--open")
        timer = self.mocks["timer"].call_args
        self.assertEqual((timer.args[1], timer.args[2]), (d.webbrowser.open, ["http://localhost:8931/"]))

    def test_help(self):
        for flag in ("-h", "--help"):
            out = io.StringIO()
            with patch.object(sys, "argv", ["dash", flag]), redirect_stdout(out), self.assertRaises(SystemExit) as caught:
                d.main()
            self.assertEqual(caught.exception.code, 0)
            self.assertIn("Uso: odoo-dashboard", out.getvalue())
        self.server.serve_forever.assert_not_called()

    def test_refuses_a_busy_port(self):
        self.mocks["port_taken"].return_value = True
        self.assertIn("ya hay un dashboard", self.fails())
        self.mocks["port_taken"].side_effect = [False, True]
        self.assertIn("8443", self.fails("--host", "0.0.0.0"))

    def test_host_flag_needs_a_value(self):
        self.assertIn("--host necesita una dirección", self.fails("--host"))
        self.server.serve_forever.assert_not_called()

    def test_a_restart_child_waits_for_the_ports(self):
        with patch.dict(os.environ, {pr.RESTART_ENV: "1"}):
            self.main("--host", "0.0.0.0")
            self.assertNotIn(pr.RESTART_ENV, os.environ)
        self.assertEqual([call.args for call in self.mocks["port_taken"].call_args_list],
                         [(sv.PORT, pr.RESTART_GRACE), (lan.TLS_PORT, pr.RESTART_GRACE, "127.0.0.1")])
        self.main()
        self.assertEqual(self.mocks["port_taken"].call_args.args, (sv.PORT, 0))

    def test_tls_port_is_probed_on_the_given_host_when_not_wildcard(self):
        self.main("--host", "10.0.0.5")
        self.assertEqual(self.mocks["port_taken"].call_args.args, (lan.TLS_PORT, 0, "10.0.0.5"))

    def test_unconfigured_still_starts_and_says_where_to_log_in(self):
        self.mocks["read_config"].return_value = {}
        out = self.main("--host", "0.0.0.0")
        self.assertIn("Sin configurar: abre http://localhost:8931/", out)
        self.server.serve_forever.assert_called_once()

    def test_module_entry_point(self):
        tty = SimpleNamespace(isatty=lambda: True, write=lambda s: None, flush=lambda: None)
        sock = Mock()
        sock.__enter__ = lambda s: s
        sock.__exit__ = lambda s, *a: None
        sock.connect_ex.return_value = 61
        with patch.object(sys, "argv", ["dash"]), patch.object(sys, "stdout", tty), patch.object(socket, "socket", return_value=sock), \
                patch("http.server.ThreadingHTTPServer") as server, patch("odoo_wrapper.client.read_config", return_value=CONFIG), \
                patch.object(threading, "Thread") as thread, patch.dict(sys.modules):
            del sys.modules["odoo_wrapper.dashboard"]
            runpy.run_module("odoo_wrapper.dashboard", run_name="__main__")
        server.return_value.serve_forever.assert_called_once()
        thread.return_value.start.assert_called_once()


if __name__ == "__main__":
    unittest.main()
