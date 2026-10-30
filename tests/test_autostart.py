"""Unit tests for the login entries: what each system gets written and asked, with the system calls mocked."""

import os
import plistlib
import subprocess
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

from helpers import temp_state

from odoo_wrapper import autostart as au
from odoo_wrapper import process as pr


class AutostartCase(unittest.TestCase):
    def setUp(self):
        self.home = temp_state(self)
        patches = [
            patch.dict(os.environ, {"HOME": self.home}),
            patch.object(subprocess, "run"),
            patch.object(subprocess, "Popen"),
        ]
        self.run_, self.popen = [p.start() for p in patches][1:]
        self.run_.return_value.returncode = 0
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
        with (
            patch.object(sys, "platform", "win32"),
            patch.object(sys, "executable", os.path.join(self.home, "python.exe")),
        ):
            self.assertEqual(au.command()[0], quiet)
            os.remove(quiet)
            self.assertEqual(au.command()[0], sys.executable)


class MacTest(AutostartCase):
    def test_on_writes_a_launch_agent_and_reloads_it(self):
        self.on("darwin")
        path = os.path.join(self.home, "Library", "LaunchAgents", f"{au.LABEL}.plist")
        with open(path, "rb") as f:
            self.assertEqual(plistlib.load(f), {"Label": au.LABEL, "ProgramArguments": au.command(), "RunAtLoad": True})
        session = f"gui/{os.getuid()}"
        self.assertEqual(
            [(c.args, c.kwargs) for c in self.run_.call_args_list],
            [
                ((["launchctl", "bootout", f"{session}/{au.LABEL}"],), {"check": False, "capture_output": True}),
                ((["launchctl", "bootstrap", session, path],), {"check": False, "capture_output": True}),
            ],
        )

    def test_a_job_still_being_booted_out_is_waited_for_and_a_lasting_refusal_is_an_error(self):
        refused, loaded = SimpleNamespace(returncode=5), SimpleNamespace(returncode=0)
        self.run_.side_effect = [loaded, refused, refused, loaded]
        with patch.object(au.time, "sleep") as sleep:
            self.on("darwin")
        self.assertEqual(sleep.call_args_list, [((au.BOOTSTRAP_PAUSE,),)] * 2)
        self.assertEqual(self.run_.call_count, 4)
        self.run_.side_effect = (
            [loaded] + [refused] * (au.BOOTSTRAP_TRIES - 1) + [subprocess.CalledProcessError(5, "launchctl")]
        )
        with patch.object(au.time, "sleep"), self.assertRaises(subprocess.CalledProcessError):
            self.on("darwin")
        self.assertEqual(self.run_.call_args.kwargs, {"capture_output": True, "check": True})
        self.assertEqual(
            self.run_.call_args.args[0], ["launchctl", "bootstrap", f"gui/{os.getuid()}", au.launch_agent()]
        )

    def test_off_removes_it_and_tolerates_its_absence(self):
        self.on("darwin")
        self.off("darwin")
        self.assertFalse(os.path.exists(au.launch_agent()))
        self.off("darwin")

    def test_follow_rewrites_an_existing_agent_and_starts_nothing(self):
        with patch.object(sys, "platform", "darwin"):
            au.follow()
            self.assertFalse(os.path.exists(au.launch_agent()))
            self.on("darwin")
            self.run_.reset_mock()
            with patch.object(au, "command", return_value=["/new/python", "-c", "x"]):
                au.follow()
        with open(au.launch_agent(), "rb") as f:
            self.assertEqual(plistlib.load(f)["ProgramArguments"], ["/new/python", "-c", "x"])
        self.run_.assert_not_called()


class LinuxTest(AutostartCase):
    def test_on_writes_a_user_unit_and_restarts_it(self):
        self.on("linux")
        self.assertEqual(au.unit_file(), os.path.join(self.home, ".config", "systemd", "user", au.UNIT))
        with open(au.unit_file()) as f:
            unit = f.read()
        exec_start = " ".join(f'"{arg.translate(au.SYSTEMD_ESCAPES)}"' for arg in au.command())
        self.assertEqual(
            unit,
            f"[Unit]\nDescription=Odoo dashboard\n\n[Service]\nExecStart={exec_start}\n\n"
            "[Install]\nWantedBy=default.target\n",
        )
        self.assertEqual(
            [c.args[0][2:] for c in self.run_.call_args_list],
            [["daemon-reload"], ["enable", au.UNIT], ["restart", au.UNIT]],
        )
        self.assertTrue(all(c.kwargs["check"] for c in self.run_.call_args_list))

    def test_the_xdg_config_folder_is_respected(self):
        with patch.dict(os.environ, {"XDG_CONFIG_HOME": os.path.join(self.home, "cfg")}):
            self.on("linux")
            self.assertTrue(os.path.exists(os.path.join(self.home, "cfg", "systemd", "user", au.UNIT)))

    def test_arguments_are_escaped_for_systemd(self):
        with patch.object(au, "command", return_value=["/a b/py", '50% "x" $HOME \\']):
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
        self.assertIs(self.run_.call_args.kwargs["check"], False)
        self.assertFalse(os.path.exists(au.unit_file()))

    def test_follow_rewrites_an_existing_unit_and_only_reloads_systemd(self):
        with patch.object(sys, "platform", "linux"):
            au.follow()
            self.assertFalse(os.path.exists(au.unit_file()))
            self.on("linux")
            self.run_.reset_mock()
            with patch.object(au, "command", return_value=["/new/python"]):
                au.follow()
        with open(au.unit_file()) as f:
            self.assertIn('ExecStart="/new/python"\n', f.read())
        self.assertEqual([c.args[0][2:] for c in self.run_.call_args_list], [["daemon-reload"]])


class WindowsTest(AutostartCase):
    def setUp(self):
        super().setUp()
        self.winreg = SimpleNamespace(
            HKEY_CURRENT_USER="HKCU",
            KEY_SET_VALUE=2,
            KEY_QUERY_VALUE=1,
            REG_SZ=1,
            OpenKey=MagicMock(),
            SetValueEx=Mock(),
            DeleteValue=Mock(),
            QueryValueEx=Mock(),
        )
        patcher = patch.dict(sys.modules, {"winreg": self.winreg})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_on_sets_the_run_value_and_starts_it_detached(self):
        self.on("win32")
        self.winreg.OpenKey.assert_called_once_with("HKCU", au.RUN_KEY, 0, 2)
        key = self.winreg.OpenKey.return_value.__enter__.return_value
        self.winreg.SetValueEx.assert_called_once_with(key, au.RUN_VALUE, 0, 1, subprocess.list2cmdline(au.command()))
        self.assertEqual(self.popen.call_args.args[0], au.command())
        self.assertEqual(
            self.popen.call_args.kwargs,
            {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL},
        )

    def test_off_deletes_the_value_and_tolerates_its_absence(self):
        self.off("win32")
        key = self.winreg.OpenKey.return_value.__enter__.return_value
        self.winreg.DeleteValue.assert_called_once_with(key, au.RUN_VALUE)
        self.winreg.DeleteValue.side_effect = FileNotFoundError
        self.off("win32")

    def test_follow_rewrites_an_existing_run_value_and_starts_nothing(self):
        with patch.object(sys, "platform", "win32"):
            self.winreg.QueryValueEx.side_effect = FileNotFoundError
            au.follow()
            self.winreg.SetValueEx.assert_not_called()
            self.winreg.QueryValueEx.side_effect = None
            au.follow()
        self.winreg.OpenKey.assert_called_with("HKCU", au.RUN_KEY, 0, 3)
        key = self.winreg.OpenKey.return_value.__enter__.return_value
        self.winreg.QueryValueEx.assert_called_with(key, au.RUN_VALUE)
        self.winreg.SetValueEx.assert_called_once_with(key, au.RUN_VALUE, 0, 1, subprocess.list2cmdline(au.command()))
        self.popen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
