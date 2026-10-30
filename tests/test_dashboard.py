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

from helpers import CONFIG, logged, temp_state
from odoo_wrapper import dashboard as d
from odoo_wrapper import cli, lan, process as pr, server as sv


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
            "local_only": patch.object(lan, "_local_only", lan.HOST_OPTION),
        }
        self.mocks = {name: p.start() for name, p in patches.items()}
        for p in patches.values():
            self.addCleanup(p.stop)

    def main(self, *argv):
        out = io.StringIO()
        with patch.object(sys, "argv", ["dash", *argv]), redirect_stdout(out), logged(out):
            d.main()
        return out.getvalue()

    def fails(self, *argv, code=1):
        out = io.StringIO()
        with patch.object(sys, "argv", ["dash", *argv]), redirect_stdout(out), logged(out), \
                self.assertRaises(SystemExit) as caught:
            d.main()
        self.assertEqual(caught.exception.code, code)
        return out.getvalue()

    def test_loopback_only(self):
        out = self.main("--host", "127.0.0.1")
        self.assertEqual(out, "INFO Dashboard en http://localhost:8931/ (Ctrl+C para parar)\n")
        self.assertNotIn("móvil", out)
        self.mocks["server"].assert_called_once_with(("127.0.0.1", sv.PORT), sv.Handler)
        self.server.serve_forever.assert_called_once()
        self.mocks["cert"].assert_not_called()
        self.assertEqual(lan._local_only, lan.HOST_OPTION)
        self.assertNotIn("Sin configurar", out)
        self.assertEqual([call.kwargs["target"] for call in self.mocks["thread"].call_args_list],
                         [pr.watch_sources, cli.keep_alive])

    def test_serves_the_whole_lan_over_tls_by_default(self):
        plain = self.server.socket
        out = self.main()
        self.assertIn("INFO Móvil: escucha en https://mac.local:8443/ y https://10.0.0.2:8443/\n", out)
        self.mocks["cert"].assert_called_once()
        self.mocks["ssl"].SSLContext.return_value.load_cert_chain.assert_called_once_with("c.pem", "k.pem")
        self.assertEqual(self.mocks["server"].call_args_list[1].args, (("0.0.0.0", lan.TLS_PORT), sv.Handler))
        self.assertEqual(lan._local_only, "")
        ssl = self.mocks["ssl"]
        ssl.SSLContext.assert_called_once_with(ssl.PROTOCOL_TLS_SERVER)
        context = ssl.SSLContext.return_value
        self.assertIs(self.server.socket, context.wrap_socket.return_value)
        self.assertEqual(context.wrap_socket.call_args.kwargs, {"server_side": True})
        self.assertEqual(context.wrap_socket.call_args.args, (plain,))
        self.assertEqual([call.kwargs for call in self.mocks["thread"].call_args_list], [
            {"target": self.server.serve_forever, "daemon": True},
            {"target": pr.watch_sources, "args": (lan.net_identity,), "daemon": True},
            {"target": cli.keep_alive, "daemon": True},
        ])
        self.assertIn("INFO Para entrar desde él, pulsa «Emparejar móvil» en http://localhost:8931/\n", out)

    def test_without_a_certificate_it_stays_on_this_machine(self):
        self.mocks["cert"].return_value = None
        out = self.main()
        self.assertIn("WARNING Sin certificado no se escucha en la red: el dashboard queda solo en este ordenador\n", out)
        self.assertNotIn("escucha en https://", out)
        self.mocks["server"].assert_called_once_with(("127.0.0.1", sv.PORT), sv.Handler)
        self.mocks["ssl"].SSLContext.assert_not_called()
        self.server.serve_forever.assert_called_once()

    def test_open_launches_the_browser(self):
        self.main("--open")
        timer = self.mocks["timer"].call_args
        self.assertEqual(timer.args, (0.4, d.webbrowser.open, ["http://localhost:8931/"]))

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
        self.assertEqual(self.fails(), "ERROR Ya hay un dashboard escuchando en http://localhost:8931/. Recarga esa página; "
                                       "para aplicar cambios de código basta con guardarlos (se reinicia solo).\n")
        self.mocks["port_taken"].side_effect = [False, True]
        self.assertEqual(self.fails("--host", "0.0.0.0"), "ERROR El puerto 8443 ya está ocupado por otro proceso\n")

    def test_autostart_switches_and_says_what_it_did(self):
        with patch.object(d.autostart, "set_autostart") as switch:
            self.assertIn("arrancará solo", self.fails("--autostart", "on", code=0))
            self.assertIn("ya no arrancará", self.fails("--autostart", "off", code=0))
        self.assertEqual([call.args for call in switch.call_args_list], [(True,), (False,)])
        self.mocks["own_the_output"].assert_not_called()
        self.server.serve_forever.assert_not_called()

    def test_autostart_needs_on_or_off(self):
        with patch.object(d.autostart, "set_autostart") as switch:
            self.assertEqual(self.fails("--autostart"), "ERROR: --autostart necesita on u off\n")
            self.assertEqual(self.fails("--autostart", "yes"), "ERROR: --autostart necesita on u off\n")
        switch.assert_not_called()

    def test_autostart_reports_what_the_system_refused(self):
        for error in (FileNotFoundError("systemctl"), d.subprocess.CalledProcessError(1, ["systemctl"])):
            with patch.object(d.autostart, "set_autostart", side_effect=error):
                self.assertIn("no se pudo cambiar el arranque", self.fails("--autostart", "on"))

    def test_the_first_start_after_an_update_moves_the_login_entry_and_says_so(self):
        with patch.dict(os.environ, {pr.UPDATED_ENV: "1"}), patch.object(d.autostart, "follow") as follow:
            out = self.main()
            self.assertNotIn(pr.UPDATED_ENV, os.environ)
        follow.assert_called_once_with()
        self.assertIn(f"INFO Actualizado a la versión {d.__version__}", out)
        with patch.object(d.autostart, "follow") as follow:
            self.main()
        follow.assert_not_called()
        for error in (PermissionError("plist"), d.subprocess.CalledProcessError(1, ["systemctl"])):
            with patch.dict(os.environ, {pr.UPDATED_ENV: "1"}), patch.object(d.autostart, "follow", side_effect=error):
                self.assertIn(f"WARNING No se pudo mover el arranque al iniciar sesión a esta instalación: {error}. "
                              "Ejecuta odoo-dashboard --autostart on\n", self.main())

    def test_host_flag_needs_a_value(self):
        self.assertEqual(self.fails("--host"),
                         "ERROR --host necesita una dirección (127.0.0.1 para no salir de este ordenador)\n")
        self.server.serve_forever.assert_not_called()

    def test_a_restart_child_waits_for_the_ports(self):
        with patch.dict(os.environ, {pr.RESTART_ENV: "1"}):
            self.main("--host", "0.0.0.0")
            self.assertNotIn(pr.RESTART_ENV, os.environ)
        self.assertEqual([call.args for call in self.mocks["port_taken"].call_args_list],
                         [(sv.PORT, pr.RESTART_GRACE), (lan.TLS_PORT, pr.RESTART_GRACE, "127.0.0.1")])
        self.main("--host", "127.0.0.1")
        self.assertEqual(self.mocks["port_taken"].call_args.args, (sv.PORT, 0))

    def test_tls_port_is_probed_on_the_given_host_when_not_wildcard(self):
        self.main("--host", "10.0.0.5")
        self.assertEqual(self.mocks["port_taken"].call_args.args, (lan.TLS_PORT, 0, "10.0.0.5"))

    def test_unconfigured_still_starts_and_says_where_to_log_in(self):
        self.mocks["read_config"].return_value = {}
        out = self.main("--host", "0.0.0.0")
        self.assertIn("INFO Sin configurar: abre http://localhost:8931/", out)
        self.server.serve_forever.assert_called_once()

    def test_module_entry_point(self):
        tty = SimpleNamespace(isatty=lambda: True, write=lambda s: None, flush=lambda: None)
        sock = Mock()
        sock.__enter__ = lambda s: s
        sock.__exit__ = lambda s, *a: None
        sock.connect_ex.return_value = 61
        with patch.object(sys, "argv", ["dash", "--host", "127.0.0.1"]), patch.object(sys, "stdout", tty), patch.object(socket, "socket", return_value=sock), \
                patch("http.server.ThreadingHTTPServer") as server, patch("odoo_wrapper.client.read_config", return_value=CONFIG), \
                patch.object(threading, "Thread") as thread, patch.dict(sys.modules), logged():
            del sys.modules["odoo_wrapper.dashboard"]
            runpy.run_module("odoo_wrapper.dashboard", run_name="__main__")
        server.return_value.serve_forever.assert_called_once()
        self.assertEqual(thread.return_value.start.call_count, 2)


if __name__ == "__main__":
    unittest.main()
