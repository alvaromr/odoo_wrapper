"""Unit tests for the process plumbing: log, port check, source watcher and restart."""

import io
import os
import socket
import subprocess
import sys
import time
import unittest
from contextlib import redirect_stdout
from types import SimpleNamespace
from unittest.mock import Mock, patch

from helpers import temp_state
from odoo_wrapper import process as pr


class PortTest(unittest.TestCase):
    def test_port_taken(self):
        sock = Mock()
        sock.__enter__ = lambda s: s
        sock.__exit__ = lambda s, *a: None
        with patch.object(socket, "socket", return_value=sock):
            sock.connect_ex.return_value = 0
            self.assertTrue(pr.port_taken(8931))
            sock.connect_ex.return_value = 61
            self.assertFalse(pr.port_taken(8931))

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
        with patch.object(socket, "socket", return_value=sock), patch.object(time, "sleep") as sleep, \
                patch.object(time, "monotonic", side_effect=lambda: next(clock)):
            sock.connect_ex.side_effect = [0, 0, 61]
            self.assertFalse(pr.port_taken(8931, grace=5))
            self.assertEqual(sleep.call_count, 2)
            sock.connect_ex.side_effect = [0, 0]
            self.assertTrue(pr.port_taken(8931, grace=1))


class OutputTest(unittest.TestCase):
    def test_a_terminal_keeps_its_output(self):
        with patch.object(sys, "stdout", SimpleNamespace(isatty=lambda: True)), patch.object(os, "dup2") as dup2:
            pr.own_the_output()
        dup2.assert_not_called()

    def test_anything_else_is_sent_to_the_log(self):
        home = temp_state(self)
        streams = (SimpleNamespace(isatty=lambda: False, fileno=lambda: 1), SimpleNamespace(fileno=lambda: 2))
        with patch.object(sys, "stdout", streams[0]), patch.object(sys, "stderr", streams[1]), patch.object(os, "dup2") as dup2:
            pr.own_the_output()
        self.assertEqual([call.args[1] for call in dup2.call_args_list], [1, 2])
        self.assertTrue(os.path.exists(os.path.join(home, "dashboard.log")))

    def test_a_big_log_is_set_aside(self):
        home = temp_state(self)
        log = os.path.join(home, "dashboard.log")
        with open(log, "w") as f:
            f.write("x" * (pr.LOG_MAX + 1))
        streams = (SimpleNamespace(isatty=lambda: False, fileno=lambda: 1), SimpleNamespace(fileno=lambda: 2))
        with patch.object(sys, "stdout", streams[0]), patch.object(sys, "stderr", streams[1]), patch.object(os, "dup2"):
            pr.own_the_output()
        self.assertEqual(os.path.getsize(log + ".1"), pr.LOG_MAX + 1)
        self.assertEqual(os.path.getsize(log), 0)

    def test_messages_carry_a_timestamp(self):
        out = io.StringIO()
        with redirect_stdout(out):
            pr.say("hola")
        self.assertRegex(out.getvalue(), r"^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d hola\n$")

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


class StopLoop(Exception):
    pass


class WatchTest(unittest.TestCase):
    def watch(self, stamp_values, identities, interval):
        calls = {"sleep": 0}

        def sleep(_):
            calls["sleep"] += 1
            if calls["sleep"] >= len(stamp_values):
                raise StopLoop

        with patch.object(pr, "stamps", side_effect=stamp_values), patch.object(time, "sleep", side_effect=sleep), \
                patch.object(pr, "NET_INTERVAL", interval), patch.object(os, "execv", side_effect=StopLoop) as execv, \
                redirect_stdout(io.StringIO()) as out:
            with self.assertRaises(StopLoop):
                pr.watch_sources(Mock(side_effect=identities))
        return execv, out.getvalue()

    def test_a_changed_source_restarts_without_reopening_the_browser(self):
        with patch.object(sys, "argv", ["dash", "--host", "0.0.0.0", "--open"]):
            execv, out = self.watch([{"a.py": 1}, {"a.py": 2}], ["", ""], 30)
        self.assertIn("Cambio en a.py", out)
        execv.assert_called_once_with(sys.executable, [sys.executable, "-m", "odoo_wrapper.dashboard", "--host", "0.0.0.0"])

    def test_a_network_change_restarts(self):
        execv, out = self.watch([{"a.py": 1}, {"a.py": 1}], ["mac|1", "mac|2"], -1)
        self.assertIn("Cambio de red", out)
        execv.assert_called_once()

    def test_quiet_ticks_keep_waiting(self):
        execv, _ = self.watch([{"a.py": 1}, {"a.py": 1}, {"a.py": 1}], ["mac|1", "mac|1", "mac|1"], -1)
        execv.assert_not_called()
        execv, _ = self.watch([{"a.py": 1}, {"a.py": 1}], ["mac|1"], 30)
        execv.assert_not_called()

    def test_windows_spawns_a_child_and_exits(self):
        with patch.object(sys, "platform", "win32"), patch.object(subprocess, "Popen") as popen, \
                patch.object(os, "execv") as execv, patch.object(os, "_exit", side_effect=StopLoop) as exit_:
            with self.assertRaises(StopLoop):
                pr.restart(["--host", "0.0.0.0"])
        execv.assert_not_called()
        popen.assert_called_once()
        self.assertEqual(popen.call_args.args[0], [sys.executable, "-m", "odoo_wrapper.dashboard", "--host", "0.0.0.0"])
        self.assertEqual(popen.call_args.kwargs["env"][pr.RESTART_ENV], "1")
        exit_.assert_called_once_with(0)


if __name__ == "__main__":
    unittest.main()
