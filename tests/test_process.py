"""Unit tests for the process plumbing: log, port check, source watcher and restart."""

import io
import logging
import os
import socket
import subprocess
import sys
import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from helpers import logged, temp_state

from odoo_wrapper import process as pr


class PortTest(unittest.TestCase):
    def test_port_taken(self):
        sock = Mock()
        sock.__enter__ = lambda s: s
        sock.__exit__ = lambda s, *a: None
        with patch.object(socket, "socket", return_value=sock), patch.object(time, "sleep") as sleep:
            sock.connect_ex.return_value = 0
            self.assertTrue(pr.port_taken(8931))
            sock.connect_ex.return_value = 61
            self.assertFalse(pr.port_taken(8931))
        sock.settimeout.assert_called_with(0.3)
        self.assertEqual(sock.connect_ex.call_args.args, (("127.0.0.1", 8931),))
        sleep.assert_not_called()

    def test_port_taken_probes_the_given_host(self):
        sock = Mock()
        sock.__enter__ = lambda s: s
        sock.__exit__ = lambda s, *a: None
        sock.connect_ex.return_value = 61
        with patch.object(socket, "socket", return_value=sock):
            pr.port_taken(8443, host="10.0.0.5")
        self.assertEqual(sock.connect_ex.call_args.args, (("10.0.0.5", 8443),))

    def test_port_taken_can_wait_for_the_port_to_free(self):
        sock = Mock()
        sock.__enter__ = lambda s: s
        sock.__exit__ = lambda s, *a: None
        clock = iter(range(0, 100))
        with (
            patch.object(socket, "socket", return_value=sock),
            patch.object(time, "sleep") as sleep,
            patch.object(time, "monotonic", side_effect=lambda: next(clock)),
        ):
            sock.connect_ex.side_effect = [0, 0, 61]
            self.assertFalse(pr.port_taken(8931, grace=5))
            self.assertEqual(sleep.call_count, 2)
            sock.connect_ex.side_effect = [0, 0]
            self.assertTrue(pr.port_taken(8931, grace=1))
            self.assertEqual(sleep.call_args_list, [unittest.mock.call(0.2)] * 2)


class OutputTest(unittest.TestCase):
    def setUp(self):
        restore = logged()
        restore.__enter__()
        self.addCleanup(restore.__exit__, None, None, None)

    def test_a_terminal_keeps_its_output(self):
        with patch.object(sys, "stdout", SimpleNamespace(isatty=lambda: True)), patch.object(os, "dup2") as dup2:
            pr.own_the_output()
        dup2.assert_not_called()

    def test_anything_else_is_sent_to_the_log(self):
        home = temp_state(self)
        streams = (SimpleNamespace(isatty=lambda: False, fileno=lambda: 1), SimpleNamespace(fileno=lambda: 2))
        with (
            patch.object(sys, "stdout", streams[0]),
            patch.object(sys, "stderr", streams[1]),
            patch.object(os, "dup2") as dup2,
        ):
            pr.own_the_output()
        self.assertEqual([call.args[1] for call in dup2.call_args_list], [1, 2])
        self.assertTrue(all(isinstance(call.args[0], int) for call in dup2.call_args_list))
        self.assertTrue(os.path.exists(os.path.join(home, "dashboard.log")))

    def test_a_big_log_is_set_aside(self):
        home = temp_state(self)
        log = os.path.join(home, "dashboard.log")
        with open(log, "w") as f:
            f.write("x" * pr.LOG_MAX)
        streams = (SimpleNamespace(isatty=lambda: False, fileno=lambda: 1), SimpleNamespace(fileno=lambda: 2))
        with patch.object(sys, "stdout", streams[0]), patch.object(sys, "stderr", streams[1]), patch.object(os, "dup2"):
            pr.own_the_output()
        self.assertFalse(os.path.exists(log + ".1"))
        with open(log, "w") as f:
            f.write("x" * (pr.LOG_MAX + 1))
        streams = (SimpleNamespace(isatty=lambda: False, fileno=lambda: 1), SimpleNamespace(fileno=lambda: 2))
        with patch.object(sys, "stdout", streams[0]), patch.object(sys, "stderr", streams[1]), patch.object(os, "dup2"):
            pr.own_the_output()
        self.assertEqual(os.path.getsize(log + ".1"), pr.LOG_MAX + 1)
        self.assertEqual(os.path.getsize(log), 0)
        with open(log, "w") as f:
            f.write("x")
        with patch.object(sys, "stdout", streams[0]), patch.object(sys, "stderr", streams[1]), patch.object(os, "dup2"):
            pr.own_the_output()
        self.assertEqual(os.path.getsize(log + ".1"), pr.LOG_MAX + 1)

    def test_messages_carry_a_timestamp_and_their_level_from_info_up(self):
        out = io.StringIO()
        out.isatty = lambda: True
        with patch.object(sys, "stdout", out):
            pr.own_the_output()
        pr.log.debug("oculto")
        pr.log.info("hola")
        logging.getLogger("odoo_wrapper.lan").warning("sin red")
        self.assertRegex(
            out.getvalue(),
            r"^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d INFO hola\n"
            r"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d WARNING sin red\n$",
        )
        self.assertEqual(logging.getLogger("odoo_wrapper").handlers[0].stream, out)
        with patch.object(sys, "stdout", out):
            pr.own_the_output()
        self.assertEqual(len(logging.getLogger("odoo_wrapper").handlers), 1)

    def test_no_streams_at_all_take_the_log(self):
        home = temp_state(self)
        with patch.object(sys, "stdout", None), patch.object(sys, "stderr", None), patch.object(os, "dup2") as dup2:
            pr.own_the_output()
            self.assertIs(sys.stdout, sys.stderr)
            self.assertEqual(sys.stdout.name, os.path.join(home, "dashboard.log"))
            self.assertTrue(sys.stdout.line_buffering)
            sys.stdout.close()
        private = os.path.join(home, "new")
        with (
            patch.object(sys, "stdout", None),
            patch.object(sys, "stderr", None),
            patch.object(pr, "STATE_DIR", private),
            patch.object(pr, "LOG_FILE", os.path.join(private, "x.log")),
        ):
            pr.own_the_output()
            sys.stdout.close()
        self.assertEqual(oct(os.stat(private).st_mode & 0o777), "0o700")
        dup2.assert_not_called()

    @unittest.skipIf("MUTANT_UNDER_TEST" in os.environ, "mutmut runs a copy of the package no subprocess can import")
    def test_the_launch_command_needs_no_pythonpath(self):
        env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
        done = subprocess.run(
            pr.launch_command(["--help"]), check=False, env=env, cwd=temp_state(self), capture_output=True, text=True
        )
        self.assertEqual(done.returncode, 0)
        self.assertIn("Uso: odoo-dashboard", done.stdout)

    def test_a_closed_stream_counts_as_no_terminal(self):
        temp_state(self)
        broken = SimpleNamespace(isatty=Mock(side_effect=ValueError), fileno=lambda: 1)
        with patch.object(sys, "stdout", broken), patch.object(sys, "stderr", broken), patch.object(os, "dup2") as dup2:
            pr.own_the_output()
        self.assertEqual(dup2.call_count, 2)

    def test_source_version_is_the_newest_mtime(self):
        home = temp_state(self)
        paths = [os.path.join(home, name) for name in ("a", "b", "missing")]
        for path, stamp in zip(paths[:2], (100, 200)):
            with open(path, "w"):
                pass
            os.utime(path, (stamp, stamp))
        with patch.object(pr, "SOURCES", paths):
            self.assertEqual(pr.source_version(), 200)
        with patch.object(pr, "SOURCES", paths[2:]):
            self.assertEqual(pr.source_version(), 0)

    def test_stamps_skip_missing_files(self):
        home = temp_state(self)
        present = os.path.join(home, "x.py")
        with open(present, "w"):
            pass
        with patch.object(pr, "WATCHED", [present, os.path.join(home, "gone.py")]):
            self.assertEqual(list(pr.stamps()), [present])

    def test_every_module_and_template_is_watched(self):
        names = {os.path.basename(p) for p in pr.SOURCES}
        self.assertTrue({"process.py", "server.py", "lan.py", "data.py", "state.py", "cli.py"} <= names)
        self.assertTrue({"dashboard.html", "login.html", "style.css"} <= names)
        self.assertTrue(any(name.endswith(".js") for name in names))


class StopLoop(BaseException):
    pass


class WatchTest(unittest.TestCase):
    def watch(self, stamp_values, identities, interval):
        calls = {"sleep": 0}

        def sleep(seconds):
            self.assertEqual(seconds, pr.WATCH_INTERVAL)
            calls["sleep"] += 1
            if calls["sleep"] >= len(stamp_values):
                raise StopLoop

        with (
            patch.object(pr, "stamps", side_effect=stamp_values),
            patch.object(time, "sleep", side_effect=sleep),
            patch.object(pr, "NET_INTERVAL", interval),
            patch.object(os, "execve", side_effect=StopLoop) as execv,
            patch.object(subprocess, "Popen") as popen,
            patch.object(os, "_exit", side_effect=StopLoop),
            logged() as out,
            self.assertRaises(StopLoop),
        ):
            pr.watch_sources(Mock(side_effect=identities))
        popen.assert_not_called()
        return execv, out.getvalue()

    def test_a_changed_source_restarts_without_reopening_the_browser(self):
        with patch.object(sys, "argv", ["dash", "--host", "0.0.0.0", "--open"]):
            execv, out = self.watch([{"a.py": 1}, {"a.py": 2}], ["", ""], 30)
        self.assertIn("Cambio en a.py", out)
        execv.assert_called_once_with(sys.executable, pr.launch_command(["--host", "0.0.0.0"]), dict(os.environ))

    def test_every_changed_source_is_named(self):
        _, out = self.watch([{"a.py": 1, "b.py": 1}, {}], ["", ""], 30)
        self.assertEqual("INFO Cambio en a.py, b.py: reiniciando…\n", out)

    def test_the_network_is_checked_once_its_interval_has_passed(self):
        with patch.object(time, "monotonic", return_value=5.0):
            execv, out = self.watch([{"a.py": 1}, {"a.py": 1}], ["mac|1", "mac|2"], 0)
        self.assertEqual("INFO Cambio de red: reiniciando…\n", out)
        execv.assert_called_once()

    def test_the_launch_command_runs_the_bootstrap_with_its_arguments(self):
        self.assertEqual(pr.launch_command(["--open"]), [sys.executable, "-c", pr.BOOTSTRAP, "--open"])
        self.assertEqual(pr.launch_command(executable="/py"), ["/py", "-c", pr.BOOTSTRAP])

    def test_a_vanished_source_restarts(self):
        execv, out = self.watch([{"a.py": 1, "b.py": 1}, {"b.py": 1}], ["", ""], 30)
        self.assertIn("Cambio en a.py", out)
        execv.assert_called_once()

    def test_a_network_change_restarts(self):
        execv, out = self.watch([{"a.py": 1}, {"a.py": 1}], ["mac|1", "mac|2"], -1)
        self.assertIn("Cambio de red", out)
        execv.assert_called_once()

    def test_quiet_ticks_keep_waiting(self):
        execv, _ = self.watch([{"a.py": 1}, {"a.py": 1}, {"a.py": 1}], ["mac|1", "mac|1", "mac|1"], -1)
        execv.assert_not_called()
        execv, _ = self.watch([{"a.py": 1}, {"a.py": 1}], ["mac|1"], 30)
        execv.assert_not_called()

    def test_a_failing_watcher_logs_why_and_restarts_after_a_pause(self):
        with (
            patch.object(time, "sleep") as sleep,
            patch.object(os, "execve", side_effect=StopLoop) as execv,
            patch.object(sys, "argv", ["dash", "--open"]),
            logged() as out,
            self.assertRaises(StopLoop),
        ):
            pr.watch_sources(Mock(side_effect=NameError("name '_local_only' is not defined")))
        sleep.assert_called_once_with(pr.FAILED_PAUSE)
        execv.assert_called_once_with(sys.executable, pr.launch_command([]), dict(os.environ))
        log = out.getvalue()
        self.assertTrue(log.startswith("ERROR El vigilante de cambios ha fallado: reiniciando en 30 s…\n"))
        self.assertIn("NameError: name '_local_only' is not defined", log)

    def test_a_held_watcher_restarts_nothing_until_released(self):
        pr.hold()
        self.addCleanup(pr.release)
        execv, _ = self.watch([{"a.py": 1}, {"a.py": 2}, {"a.py": 3}], ["mac|1", "mac|2", "mac|3"], -1)
        execv.assert_not_called()
        pr.release()
        execv, _ = self.watch([{"a.py": 1}, {"a.py": 2}], ["", ""], 30)
        execv.assert_called_once()

    def test_a_restart_into_a_new_install_runs_its_interpreter_and_package(self):
        with (
            patch.object(os, "execve", side_effect=StopLoop) as execve,
            patch.object(subprocess, "Popen") as popen,
            patch.object(os, "_exit", side_effect=StopLoop),
            self.assertRaises(StopLoop),
        ):
            pr.restart(["--host", "0.0.0.0"], installed="/tools/odoo-wrapper/bin/python")
        popen.assert_not_called()
        command = ["/tools/odoo-wrapper/bin/python", "-c", pr.INSTALLED_BOOTSTRAP, "--host", "0.0.0.0"]
        self.assertEqual(execve.call_args.args[:2], (command[0], command))
        self.assertEqual(execve.call_args.args[2][pr.UPDATED_ENV], "1")
        with (
            patch.object(sys, "platform", "win32"),
            patch.object(subprocess, "Popen") as popen,
            patch.object(os, "_exit", side_effect=StopLoop),
            self.assertRaises(StopLoop),
        ):
            pr.restart([], installed="C:\\tools\\python.exe")
        self.assertEqual(popen.call_args.args[0][:3], ["C:\\tools\\python.exe", "-c", pr.INSTALLED_BOOTSTRAP])
        self.assertEqual(
            (popen.call_args.kwargs["env"][pr.UPDATED_ENV], popen.call_args.kwargs["env"][pr.RESTART_ENV]), ("1", "1")
        )

    def test_windows_spawns_a_child_and_exits(self):
        with (
            patch.object(sys, "platform", "win32"),
            patch.object(subprocess, "Popen") as popen,
            patch.object(os, "execve") as execv,
            patch.object(os, "_exit", side_effect=StopLoop) as exit_,
            self.assertRaises(StopLoop),
        ):
            pr.restart(["--host", "0.0.0.0"])
        execv.assert_not_called()
        popen.assert_called_once()
        self.assertEqual(popen.call_args.args[0], pr.launch_command(["--host", "0.0.0.0"]))
        self.assertEqual(popen.call_args.kwargs["env"][pr.RESTART_ENV], "1")
        exit_.assert_called_once_with(0)


if __name__ == "__main__":
    unittest.main()
