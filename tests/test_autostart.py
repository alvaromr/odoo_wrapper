"""Unit tests for the login entries: what each system gets written and asked, with the system calls mocked."""

import os
import plistlib
import subprocess
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

from helpers import temp_state
from odoo_wrapper import autostart as au, process as pr


class AutostartCase(unittest.TestCase):
    def setUp(self):
        self.home = temp_state(self)
        patches = [
            patch.dict(os.environ, {"HOME": self.home}),
            patch.object(subprocess, "run"),
            patch.object(subprocess, "Popen"),
        ]
        self.run_, self.popen = [p.start() for p in patches][1:]
        for p in patches:
            self.addCleanup(p.stop)
        os.environ.pop("XDG_CONFIG_HOME", None)

    def on(self, platform):
        with patch.object(sys, "platform", platform):
            au.set_autostart(True)

    def off(self, platform):
        with patch.object(sys, "platform", platform):
            au.set_autostart(False)


class CommandTest(AutostartCase):
    def test_the_running_interpreter_launches_it(self):
        with patch.object(sys, "platform", "darwin"):
            self.assertEqual(au.command(), pr.launch_command())

    def test_windows_prefers_pythonw_beside_it(self):
        quiet = os.path.join(self.home, "pythonw.exe")
        open(quiet, "w").close()
        with patch.object(sys, "platform", "win32"), patch.object(sys, "executable", os.path.join(self.home, "python.exe")):
            self.assertEqual(au.command()[0], quiet)
            os.remove(quiet)
            self.assertEqual(au.command()[0], sys.executable)


class MacTest(AutostartCase):
    def test_on_writes_a_launch_agent_and_loads_it(self):
        self.on("darwin")
        path = os.path.join(self.home, "Library", "LaunchAgents", f"{au.LABEL}.plist")
        with open(path, "rb") as f:
            self.assertEqual(plistlib.load(f), {"Label": au.LABEL, "ProgramArguments": au.command(), "RunAtLoad": True})
        self.assertEqual(self.run_.call_args.args[0], ["launchctl", "bootstrap", f"gui/{os.getuid()}", path])

    def test_off_removes_it_and_tolerates_its_absence(self):
        self.on("darwin")
        self.off("darwin")
        self.assertFalse(os.path.exists(au.launch_agent()))
        self.off("darwin")


class LinuxTest(AutostartCase):
    def test_on_writes_a_user_unit_and_enables_it_now(self):
        self.on("linux")
        with open(os.path.join(self.home, ".config", "systemd", "user", au.UNIT)) as f:
            unit = f.read()
        self.assertIn(f'ExecStart="{sys.executable}" "-c" ', unit)
        self.assertIn("WantedBy=default.target", unit)
        self.assertEqual([c.args[0][2:] for c in self.run_.call_args_list], [["daemon-reload"], ["enable", "--now", au.UNIT]])
        self.assertTrue(all(c.kwargs["check"] for c in self.run_.call_args_list))

    def test_the_xdg_config_folder_is_respected(self):
        with patch.dict(os.environ, {"XDG_CONFIG_HOME": os.path.join(self.home, "cfg")}):
            self.on("linux")
            self.assertTrue(os.path.exists(os.path.join(self.home, "cfg", "systemd", "user", au.UNIT)))

    def test_arguments_are_escaped_for_systemd(self):
        with patch.object(au, "command", return_value=['/a b/py', '50% "x" $HOME \\']):
            self.on("linux")
        with open(au.unit_file()) as f:
            self.assertIn('ExecStart="/a b/py" "50%% \\"x\\" $$HOME \\\\"\n', f.read())

    def test_off_disables_and_removes_only_what_is_there(self):
        self.off("linux")
        self.run_.assert_not_called()
        self.on("linux")
        self.run_.reset_mock()
        self.off("linux")
        self.assertEqual(self.run_.call_args.args[0], ["systemctl", "--user", "disable", au.UNIT])
        self.assertFalse(self.run_.call_args.kwargs["check"])
        self.assertFalse(os.path.exists(au.unit_file()))


class WindowsTest(AutostartCase):
    def setUp(self):
        super().setUp()
        self.winreg = SimpleNamespace(HKEY_CURRENT_USER="HKCU", KEY_SET_VALUE=2, REG_SZ=1, OpenKey=MagicMock(),
                                      SetValueEx=Mock(), DeleteValue=Mock())
        patcher = patch.dict(sys.modules, {"winreg": self.winreg})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_on_sets_the_run_value_and_starts_it_detached(self):
        self.on("win32")
        self.winreg.OpenKey.assert_called_once_with("HKCU", au.RUN_KEY, 0, 2)
        key = self.winreg.OpenKey.return_value.__enter__.return_value
        self.winreg.SetValueEx.assert_called_once_with(key, au.RUN_VALUE, 0, 1, subprocess.list2cmdline(au.command()))
        self.assertEqual(self.popen.call_args.args[0], au.command())
        self.assertEqual(self.popen.call_args.kwargs["stdout"], subprocess.DEVNULL)

    def test_off_deletes_the_value_and_tolerates_its_absence(self):
        self.off("win32")
        key = self.winreg.OpenKey.return_value.__enter__.return_value
        self.winreg.DeleteValue.assert_called_once_with(key, au.RUN_VALUE)
        self.winreg.DeleteValue.side_effect = FileNotFoundError
        self.off("win32")


if __name__ == "__main__":
    unittest.main()
