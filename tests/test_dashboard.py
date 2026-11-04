"""Unit tests for the dashboard entry point: how main() wires the pieces, with only the system mocked.

The package's own code runs for real: the network, the programs main() runs (scutil, openssl, systemctl) and
the clock are stood in for by the fakes below, the servers and threads are never started, and every file is
written under a throwaway HOME.
"""

import io
import os
import re
import runpy
import shutil
import socket
import subprocess
import sys
import threading
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from types import SimpleNamespace
from unittest.mock import Mock, call, patch

from helpers import CONFIG, logged, temp_state

from odoo_wrapper import autostart as au
from odoo_wrapper import cli, lan
from odoo_wrapper import client as c
from odoo_wrapper import dashboard as d
from odoo_wrapper import process as pr
from odoo_wrapper import server as sv

STAMP = re.compile(r"^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d ", re.MULTILINE)
LOOPBACK = "127.0.0.1"


class TerminalOutput(io.StringIO):
    def isatty(self):
        return True


class NetworkSocket:
    def __init__(self, network):
        self.network = network

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.close()

    def close(self):
        pass

    def settimeout(self, _seconds):
        pass

    def connect(self, _address):
        pass

    def getsockname(self):
        return (self.network.ip, 0)

    def connect_ex(self, address):
        self.network.probes.append(address)
        busy = self.network.busy.get(address, 0)
        self.network.busy[address] = busy - 1
        return 0 if busy > 0 else 61


class Network:
    """The sockets: this machine goes out from ip, and every (host, port) in busy answers a connect that many times."""

    def __init__(self):
        self.ip, self.busy, self.probes = "10.0.0.2", {}, []

    def socket(self, *_args):
        return NetworkSocket(self)


class Commands:
    """The programs the dashboard runs: scutil names the machine "mac", openssl writes its files, systemctl
    answers, and any of them raises what errors holds for it."""

    def __init__(self):
        self.calls, self.errors, self.has_openssl = [], {}, True

    def run(self, command, **_kwargs):
        self.calls.append(command)
        if command[0] in self.errors:
            raise self.errors[command[0]]
        if command[0] == "openssl":
            for flag in ("-keyout", "-out"):
                open(command[command.index(flag) + 1], "w").close()
        return SimpleNamespace(stdout="mac\n" if command[0] == "scutil" else "", returncode=0)

    def which(self, name):
        return name if self.has_openssl and name == "openssl" else None

    def of(self, program):
        return [command for command in self.calls if command[0] == program]


class MainTest(unittest.TestCase):
    def setUp(self):
        self.home = temp_state(self)
        c.save_config(**CONFIG)
        self.server = Mock()
        self.net, self.commands = Network(), Commands()
        patches = {
            "server": patch.object(d, "ThreadingHTTPServer", return_value=self.server),
            "thread": patch.object(threading, "Thread"),
            "timer": patch.object(threading, "Timer"),
            "ssl": patch.object(d, "ssl", Mock()),
            "socket": patch.object(socket, "socket", self.net.socket),
            "run": patch.object(subprocess, "run", self.commands.run),
            "which": patch.object(shutil, "which", self.commands.which),
            "platform": patch.object(sys, "platform", "linux"),
            "environ": patch.dict(os.environ, {"HOME": self.home}),
            "local_only": patch.dict(lan._lan, off=lan.HOST_OPTION),
        }
        self.mocks = {name: p.start() for name, p in patches.items()}
        for p in patches.values():
            self.addCleanup(p.stop)
        os.environ.pop("XDG_CONFIG_HOME", None)

    def run_main(self, argv, tty):
        out = TerminalOutput() if tty else io.StringIO()
        err = io.StringIO()
        with patch.object(sys, "argv", ["dash", *argv]), redirect_stdout(out), redirect_stderr(err), logged(out):
            try:
                d.main()
            finally:
                self.output = STAMP.sub("", out.getvalue())
                self.errors = err.getvalue()

    def main(self, *argv, tty=True):
        self.run_main(argv, tty)
        return self.output

    def fails(self, *argv, code=1, tty=True):
        with self.assertRaises(SystemExit) as caught:
            self.run_main(argv, tty)
        self.assertEqual(caught.exception.code, code)
        return self.output

    def stale_unit(self):
        os.makedirs(os.path.dirname(au.unit_file()), exist_ok=True)
        with open(au.unit_file(), "w") as f:
            f.write("stale\n")

    def unit(self):
        with open(au.unit_file()) as f:
            return f.read()

    def test_loopback_only(self):
        out = self.main("--host", LOOPBACK)
        self.assertEqual(out, "INFO Dashboard en http://localhost:8931/ (Ctrl+C para parar)\n")
        self.assertNotIn("móvil", out)
        self.mocks["server"].assert_called_once_with((LOOPBACK, sv.PORT), sv.Handler)
        self.server.serve_forever.assert_called_once()
        self.assertEqual(self.commands.calls, [])
        self.assertEqual(self.net.probes, [(LOOPBACK, sv.PORT)])
        self.assertEqual(lan._lan["off"], lan.HOST_OPTION)
        self.assertNotIn("Sin configurar", out)
        self.assertEqual(
            [made.kwargs["target"] for made in self.mocks["thread"].call_args_list], [pr.watch_sources, cli.keep_alive]
        )

    def test_serves_this_machines_lan_address_over_tls_by_default(self):
        plain = self.server.socket
        out = self.main()
        self.assertIn("INFO Móvil: escucha en https://mac.local:8443/ y https://10.0.0.2:8443/\n", out)
        cert, key = (os.path.join(self.home, f"{kind}-mac.local-10.0.0.2.pem") for kind in ("cert", "key"))
        self.assertTrue(os.path.exists(cert) and os.path.exists(key))
        self.assertEqual(len(self.commands.of("openssl")), 1)
        self.assertIn("INFO Certificado creado para DNS:mac.local,DNS:localhost,IP:10.0.0.2,IP:127.0.0.1\n", out)
        self.mocks["ssl"].SSLContext.return_value.load_cert_chain.assert_called_once_with(cert, key)
        self.assertEqual(self.mocks["server"].call_args_list[1].args, (("10.0.0.2", lan.TLS_PORT), sv.Handler))
        self.assertEqual(self.net.probes, [(LOOPBACK, sv.PORT), ("10.0.0.2", lan.TLS_PORT)])
        self.assertEqual(lan._lan["off"], "")
        ssl = self.mocks["ssl"]
        ssl.SSLContext.assert_called_once_with(ssl.PROTOCOL_TLS_SERVER)
        context = ssl.SSLContext.return_value
        self.assertIs(self.server.socket, context.wrap_socket.return_value)
        self.assertEqual(context.wrap_socket.call_args.kwargs, {"server_side": True})
        self.assertEqual(context.wrap_socket.call_args.args, (plain,))
        self.assertEqual(
            [made.kwargs for made in self.mocks["thread"].call_args_list],
            [
                {"target": self.server.serve_forever, "daemon": True},
                {"target": pr.watch_sources, "args": (lan.net_identity,), "daemon": True},
                {"target": cli.keep_alive, "daemon": True},
            ],
        )
        self.assertIn("INFO Para entrar desde él, pulsa «Emparejar móvil» en http://localhost:8931/\n", out)

    def test_a_known_network_reuses_its_certificate(self):
        self.main()
        self.main()
        self.assertEqual(len(self.commands.of("openssl")), 1)

    def test_without_a_certificate_it_stays_on_this_machine(self):
        self.commands.has_openssl = False
        out = self.main()
        self.assertIn(f"WARNING {lan.NO_OPENSSL}\n", out)
        self.assertIn(
            "WARNING Sin certificado no se escucha en la red: el dashboard queda solo en este ordenador\n", out
        )
        self.assertNotIn("escucha en https://", out)
        self.assertEqual(lan._lan["off"], lan.NO_OPENSSL)
        self.mocks["server"].assert_called_once_with((LOOPBACK, sv.PORT), sv.Handler)
        self.mocks["ssl"].SSLContext.assert_not_called()
        self.server.serve_forever.assert_called_once()

    def test_open_launches_the_browser(self):
        self.main("--open")
        timer = self.mocks["timer"].call_args
        self.assertEqual(timer.args, (0.4, d.webbrowser.open, ["http://localhost:8931/"]))

    def test_help(self):
        for flag in ("-h", "--help"):
            out = io.StringIO()
            with (
                patch.object(sys, "argv", ["dash", flag]),
                redirect_stdout(out),
                self.assertRaises(SystemExit) as caught,
            ):
                d.main()
            self.assertEqual(caught.exception.code, 0)
            self.assertIn("Uso: odoo-dashboard", out.getvalue())
        self.server.serve_forever.assert_not_called()

    def test_refuses_a_busy_port(self):
        self.net.busy = {(LOOPBACK, sv.PORT): float("inf")}
        self.assertEqual(
            self.fails(),
            "ERROR Ya hay un dashboard escuchando en http://localhost:8931/. Recarga esa página; "
            "para aplicar cambios de código basta con guardarlos (se reinicia solo).\n",
        )
        self.net.busy = {(LOOPBACK, lan.TLS_PORT): float("inf")}
        self.assertEqual(self.fails("--host", "0.0.0.0"), "ERROR El puerto 8443 ya está ocupado por otro proceso\n")
        self.mocks["server"].assert_not_called()

    def test_autostart_switches_and_says_what_it_did(self):
        self.assertIn("arrancará solo", self.fails("--autostart", "on", code=0, tty=False))
        self.assertIn("ExecStart=", self.unit())
        self.assertEqual(
            self.commands.calls[-2:],
            [["systemctl", "--user", "enable", au.UNIT], ["systemctl", "--user", "restart", au.UNIT]],
        )
        self.assertIn("ya no arrancará", self.fails("--autostart", "off", code=0, tty=False))
        self.assertFalse(os.path.exists(au.unit_file()))
        self.assertFalse(os.path.exists(pr.LOG_FILE))
        self.server.serve_forever.assert_not_called()

    def test_autostart_needs_on_or_off_and_says_so_on_stderr(self):
        for argv in (["--autostart"], ["--autostart", "yes"]):
            self.assertEqual(self.fails(*argv, tty=False), "")
            self.assertEqual(self.errors, "ERROR: --autostart necesita on u off\n")
        self.assertEqual(self.commands.calls, [])
        self.assertFalse(os.path.exists(au.unit_file()))

    def test_autostart_reports_what_the_system_refused_on_stderr(self):
        for error in (FileNotFoundError("systemctl"), subprocess.CalledProcessError(1, ["systemctl"])):
            self.commands.errors = {"systemctl": error}
            self.assertEqual(self.fails("--autostart", "on", tty=False), "")
            self.assertEqual(self.errors, f"ERROR: no se pudo cambiar el arranque al iniciar sesión: {error}\n")

    def test_the_first_start_after_an_update_moves_the_login_entry_and_says_so(self):
        self.stale_unit()
        with patch.dict(os.environ, {pr.UPDATED_ENV: "1"}):
            out = self.main()
            self.assertNotIn(pr.UPDATED_ENV, os.environ)
        self.assertIn(f"INFO Actualizado a la versión {d.__version__}", out)
        self.assertIn(f'ExecStart="{sys.executable}"', self.unit())
        self.assertEqual(self.commands.of("systemctl"), [["systemctl", "--user", "daemon-reload"]])
        self.stale_unit()
        self.commands.calls.clear()
        self.main()
        self.assertEqual(self.unit(), "stale\n")
        self.assertEqual(self.commands.of("systemctl"), [])
        for error in (PermissionError("plist"), subprocess.CalledProcessError(1, ["systemctl"])):
            self.commands.errors = {"systemctl": error}
            with patch.dict(os.environ, {pr.UPDATED_ENV: "1"}):
                self.assertIn(
                    f"WARNING No se pudo mover el arranque al iniciar sesión a esta instalación: {error}. "
                    "Ejecuta odoo-dashboard --autostart on\n",
                    self.main(),
                )

    def test_an_update_does_not_turn_the_login_entry_on(self):
        with patch.dict(os.environ, {pr.UPDATED_ENV: "1"}):
            self.main()
        self.assertFalse(os.path.exists(au.unit_file()))

    def test_host_flag_needs_a_value(self):
        self.assertEqual(
            self.fails("--host"), "ERROR --host necesita una dirección (127.0.0.1 para no salir de este ordenador)\n"
        )
        self.server.serve_forever.assert_not_called()

    def test_a_restart_child_waits_for_the_ports(self):
        self.net.busy = {(LOOPBACK, sv.PORT): 2, (LOOPBACK, lan.TLS_PORT): 1}
        with patch.dict(os.environ, {pr.RESTART_ENV: "1"}), patch.object(time, "sleep") as sleep:
            self.main("--host", "0.0.0.0")
            self.assertNotIn(pr.RESTART_ENV, os.environ)
        self.assertEqual(sleep.call_args_list, [call(0.2)] * 3)
        self.server.serve_forever.assert_called_once()

    def test_a_dashboard_not_restarted_does_not_wait_for_a_busy_port(self):
        self.net.busy = {(LOOPBACK, sv.PORT): 1}
        with patch.object(time, "sleep") as sleep:
            self.fails("--host", LOOPBACK)
        sleep.assert_not_called()

    def test_host_0000_listens_on_every_interface(self):
        self.main("--host", "0.0.0.0")
        self.assertEqual(self.mocks["server"].call_args_list[1].args, (("0.0.0.0", lan.TLS_PORT), sv.Handler))

    def test_tls_port_is_probed_on_the_given_host_when_not_wildcard(self):
        self.main("--host", "10.0.0.5")
        self.assertEqual(self.net.probes, [(LOOPBACK, sv.PORT), ("10.0.0.5", lan.TLS_PORT)])

    def test_unconfigured_still_starts_and_says_where_to_log_in(self):
        os.remove(c.CONFIG_FILE)
        out = self.main("--host", "0.0.0.0")
        self.assertIn("INFO Sin configurar: abre http://localhost:8931/", out)
        self.server.serve_forever.assert_called_once()

    def test_module_entry_point(self):
        with (
            patch.object(sys, "argv", ["dash", "--host", LOOPBACK]),
            patch.object(sys, "stdout", TerminalOutput()),
            patch("http.server.ThreadingHTTPServer") as server,
            patch.dict(sys.modules),
            logged(),
        ):
            del sys.modules["odoo_wrapper.dashboard"]
            runpy.run_module("odoo_wrapper.dashboard", run_name="__main__")
        server.return_value.serve_forever.assert_called_once()
        self.assertEqual(self.mocks["thread"].return_value.start.call_count, 2)


if __name__ == "__main__":
    unittest.main()
