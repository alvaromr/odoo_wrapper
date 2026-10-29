"""Unit tests for the update check: what GitHub is asked, how versions compare, and how long an answer lasts."""

import io
import json
import os
import subprocess
import sys
import unittest
import urllib.error
from unittest.mock import patch

from helpers import temp_state
from odoo_wrapper import __version__
from odoo_wrapper import updates as up

PAGE = "https://github.com/alvaromr/odoo_wrapper/releases/tag/v"


class Answer(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def release(tag):
    return {"tag_name": tag, "html_url": PAGE + tag.removeprefix("v"), "draft": False}


class UpdatesTest(unittest.TestCase):
    def setUp(self):
        up._last.update(at=None, answer=None)
        self.addCleanup(up._last.update, at=None, answer=None)
        self.asked = []

    def github(self, *results):
        results = list(results)

        def opener(request, timeout):
            self.asked.append((request.full_url, dict(request.header_items()), timeout))
            result = results.pop(0)
            if isinstance(result, Exception):
                raise result
            return Answer(result if isinstance(result, bytes) else json.dumps(result).encode())
        return patch.object(up.urllib.request, "urlopen", side_effect=opener)

    def test_the_version_is_written_once_in_the_package(self):
        self.assertRegex(__version__, r"^\d+\.\d+\.\d+$")
        self.assertEqual(up.numbers(__version__), up.numbers("v" + __version__))

    def test_only_a_higher_release_is_an_update_compared_as_numbers(self):
        answers = (release("v1.10.0"), release("v1.9.0"), release("1.2.3"))
        with patch.object(up, "__version__", "1.9.0"), self.github(*answers):
            self.assertEqual(up.ask(), {"available": True, "current": "1.9.0", "latest": "1.10.0",
                                        "url": PAGE + "1.10.0", "error": ""})
            self.assertFalse(up.ask()["available"])
            older = up.ask()
            self.assertEqual((older["available"], older["latest"]), (False, "1.2.3"))
        url, headers, timeout = self.asked[0]
        self.assertEqual(url, "https://api.github.com/repos/alvaromr/odoo_wrapper/releases/latest")
        self.assertEqual((headers["Accept"], headers["User-agent"], timeout),
                         ("application/vnd.github+json", "odoo-wrapper", up.TIMEOUT))

    def test_a_failed_check_is_logged_and_reported_never_taken_for_up_to_date(self):
        none_yet = urllib.error.HTTPError(up.LATEST, 404, "Not Found", {}, io.BytesIO())
        failures = (none_yet, urllib.error.URLError("sin red"), TimeoutError("timed out"), b"<html>",
                    release("v1.x"), {"message": "Not Found"})
        for failure in failures:
            with self.github(failure), patch.object(up, "say") as say:
                answer = up.ask()
            self.assertEqual((answer["available"], answer["current"], answer["latest"], answer["url"]),
                             (False, __version__, None, None))
            self.assertTrue(answer["error"].startswith("No se pudo consultar GitHub: "), failure)
            self.assertTrue(say.call_args.args[0].startswith("No se pudo buscar actualizaciones en GitHub: "), failure)
            say.assert_called_once()

    def test_an_answer_is_kept_for_hours_and_a_forced_check_reuses_one_younger_than_a_minute(self):
        clock = [1000.0]
        answers = (release("v1.0.0"), release("v1.1.0"), release("v1.0.0"))
        with patch.object(up, "__version__", "1.0.0"), self.github(*answers), \
                patch.object(up.time, "monotonic", side_effect=lambda: clock[0]):
            self.assertFalse(up.check()["available"])
            clock[0] += up.FRESH_MIN - 1
            self.assertFalse(up.check(fresh=True)["available"])
            clock[0] = 1000.0 + up.CHECK_TTL - 1
            self.assertFalse(up.check()["available"])
            clock[0] += 1
            self.assertTrue(up.check()["available"])
            self.assertTrue(up.check(fresh=True)["available"])
            clock[0] += up.FRESH_MIN
            self.assertFalse(up.check(fresh=True)["available"])
        self.assertEqual(len(self.asked), 3)


class Ran:
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode, self.stdout, self.stderr = returncode, stdout, stderr


GIT_RECEIPT = """[tool]
requirements = [{ name = "odoo-wrapper", git = "https://github.com/alvaromr/odoo_wrapper" }]
entrypoints = [
    { name = "odoo", install-path = "/home/ana/my \\\\\\"bin\\\\\\"/odoo" },
]
"""
EDITABLE_RECEIPT = '[tool]\nrequirements = [{ name = "odoo-wrapper", editable = "/repo" }]\n'


class InstallTest(unittest.TestCase):
    def setUp(self):
        self.home = temp_state(self)
        self.tools = os.path.join(self.home, "tools")
        self.prefix = os.path.join(self.tools, up.TOOL)
        os.makedirs(os.path.join(self.prefix, "bin"))
        self.installed = os.path.join(self.prefix, "bin", "python")
        self.uv = os.path.join(self.home, "uv")
        self.runs = []
        self.update_skills = up.update_skills
        patches = [patch.object(up.sys, "prefix", self.prefix), patch.object(up, "find", return_value=self.uv),
                   patch.object(up, "update_skills", return_value=""),
                   patch.object(up.threading, "Timer"), patch.object(up.process, "hold"),
                   patch.object(up.process, "release"), patch.object(up, "say")]
        self.skills, self.timer, self.hold, self.release, self.say = [p.start() for p in patches][2:]
        for p in patches:
            self.addCleanup(p.stop)
        self.addCleanup(lambda: up._installing.locked() and up._installing.release())

    def with_receipt(self, text):
        with open(os.path.join(self.prefix, up.RECEIPT), "w", encoding="utf-8") as f:
            f.write(text)

    def uv_answers(self, *results, creates=True):
        results = list(results)

        def run(command, **kwargs):
            self.runs.append((command, kwargs))
            result = results.pop(0)
            if isinstance(result, Exception):
                raise result
            if creates and command[1:3] == ["tool", "install"]:
                open(self.installed, "w").close()
            return result
        return patch.object(up.subprocess, "run", side_effect=run)

    def test_a_program_is_found_on_the_path_or_where_its_installers_put_it(self):
        patch.stopall()
        with patch.object(up.shutil, "which", return_value="/path/uv") as which:
            self.assertEqual(up.find("uv"), "/path/uv")
        which.assert_called_once_with("uv")
        system = os.path.join(self.home, "system")
        os.makedirs(system)
        open(os.path.join(system, "uv"), "w").close()
        with patch.object(up.shutil, "which", return_value=None), patch.dict(os.environ, {"HOME": self.home}), \
                patch.object(up, "SYSTEM_BINS", (system,)):
            self.assertEqual(up.find("uv"), os.path.join(system, "uv"))
        local = os.path.join(self.home, ".local", "bin")
        os.makedirs(local)
        with patch.object(up.shutil, "which", return_value=None), patch.dict(os.environ, {"HOME": self.home}), \
                patch.object(up, "SYSTEM_BINS", ()):
            self.assertIsNone(up.find("uv"))
            open(os.path.join(local, "uv"), "w").close()
            self.assertEqual(up.find("uv"), os.path.join(local, "uv"))
            with patch.object(up.sys, "platform", "win32"):
                self.assertIsNone(up.find("uv"))

    def test_the_skills_are_updated_when_claude_has_the_plugin_and_only_a_failure_is_reported(self):
        listed = Ran(stdout=json.dumps([{"id": "other@x"}, {"id": up.PLUGIN}]))
        cases = [
            (None, [], "", 0),
            (self.uv, [Ran(stdout='[{"id": "other@x"}]')], "", 1),
            (self.uv, [listed, Ran()], "", 2),
            (self.uv, [listed, Ran(1, stdout="", stderr="marketplace not found")], "marketplace not found", 2),
            (self.uv, [subprocess.CalledProcessError(1, "claude")], "Command 'claude' returned non-zero exit status 1.", 1),
            (self.uv, [Ran(stdout="<html>")], "Expecting value: line 1 column 1 (char 0)", 1),
        ]
        for claude, answers, failure, calls in cases:
            self.runs = []
            with patch.object(up, "find", return_value=claude), self.uv_answers(*answers):
                self.assertEqual(self.update_skills(), failure)
            self.assertEqual(len(self.runs), calls)
            if failure:
                self.say.assert_called_once_with(f"No se pudieron actualizar las skills de Claude Code: {failure}")
            else:
                self.say.assert_not_called()
            self.say.reset_mock()
        self.runs = []
        with patch.object(up, "find", return_value=self.uv) as find, self.uv_answers(listed, Ran()):
            self.update_skills()
        find.assert_called_once_with("claude")
        quiet = {"capture_output": True, "text": True, "stdin": subprocess.DEVNULL, "timeout": up.CLAUDE_TIMEOUT}
        self.assertEqual(self.runs, [([self.uv, "plugin", "list", "--json"], dict(quiet, check=True)),
                                     ([self.uv, "plugin", "update", up.PLUGIN], quiet)])

    def test_the_development_install_updates_with_git_and_one_without_uv_by_hand(self):
        self.assertEqual(up.how(), "auto")
        self.with_receipt(EDITABLE_RECEIPT)
        self.assertEqual(up.how(), "git")
        os.remove(os.path.join(self.prefix, up.RECEIPT))
        with patch.object(up, "find", return_value=None):
            self.assertEqual(up.how(), "manual")
            self.assertEqual(up.install([], 8931), (409, {"error": "Esta instalación no se actualiza desde aquí: pídeselo a tu agente"}))

    def test_a_uv_tool_is_replaced_in_its_own_folders(self):
        self.assertEqual(up.placement(""), {})
        self.assertEqual(up.placement(GIT_RECEIPT),
                         {"UV_TOOL_DIR": self.tools, "UV_TOOL_BIN_DIR": '/home/ana/my \\"bin\\"'})
        self.assertEqual(up.placement("entrypoints = [{ name = 'odoo', install-path = '/opt/bin/odoo' }]")["UV_TOOL_BIN_DIR"],
                         "/opt/bin")
        self.assertEqual(up.placement("[tool]\n"), {"UV_TOOL_DIR": self.tools})

    def test_the_new_interpreter_is_where_uv_puts_each_system_s(self):
        self.assertEqual(up.interpreter("/t"), os.path.join("/t", up.TOOL, "bin", "python"))
        with patch.object(up.sys, "platform", "win32"):
            self.assertEqual(up.interpreter("T"), os.path.join("T", up.TOOL, "Scripts", "python.exe"))
            self.assertEqual(up.interpreter("T", windowed=True), os.path.join("T", up.TOOL, "Scripts", "pythonw.exe"))

    def test_an_install_runs_uv_from_github_holds_the_watcher_and_restarts_into_the_new_interpreter(self):
        self.with_receipt('[tool]\nrequirements = [{ name = "odoo-wrapper", directory = "/x" }]\n')
        self.skills.return_value = "marketplace not found"
        with self.uv_answers(Ran()):
            self.assertEqual(up.install(["--host", "0.0.0.0"], 8931),
                             (200, {"ok": True, "skills": "marketplace not found"}))
        self.skills.assert_called_once_with()
        command, kwargs = self.runs[0]
        version = "{}.{}".format(*sys.version_info[:2])
        self.assertEqual(command, [self.uv, "tool", "install", "--force", "--python", version, up.SOURCE])
        self.assertEqual(kwargs, {"env": dict(os.environ, UV_TOOL_DIR=self.tools), "capture_output": True, "text": True,
                                  "timeout": up.INSTALL_TIMEOUT})
        up.find.assert_called_with("uv")
        self.say.assert_called_once_with(f"Actualización instalada en {self.installed}: reiniciando…")
        self.hold.assert_called_once_with()
        self.release.assert_not_called()
        self.timer.assert_called_once_with(up.RESTART_DELAY, up.process.restart, [["--host", "0.0.0.0"], self.installed])
        self.timer.return_value.start.assert_called_once_with()
        self.assertEqual(up.install([], 8931), (409, {"error": "Ya se está instalando una actualización"}))

    def test_a_copy_with_no_uv_tool_gets_the_readme_s_install_in_uv_s_folders(self):
        with self.uv_answers(Ran(stdout=f"{self.tools}\n"), Ran()):
            self.assertEqual(up.install([], 8931), (200, {"ok": True, "skills": ""}))
        self.assertEqual(self.runs[0], ([self.uv, "tool", "dir"], {"env": dict(os.environ), "capture_output": True,
                                                                   "text": True, "check": True, "timeout": up.TIMEOUT}))
        self.assertEqual(self.runs[1][1]["env"].get("UV_TOOL_DIR"), os.environ.get("UV_TOOL_DIR"))

    def test_a_failed_install_says_what_uv_printed_and_leaves_the_dashboard_as_it_was(self):
        refused = Ran(1, stdout="Resolved 1 package", stderr="error: Git operation failed")
        for answers, creates, said in (((refused,), True, "error: Git operation failed\nResolved 1 package"),
                                       ((OSError("uv"),), True, "uv"),
                                       ((Ran(),), False, f"no aparece {self.installed}")):
            self.with_receipt(GIT_RECEIPT)
            if os.path.exists(self.installed):
                os.remove(self.installed)
            with self.uv_answers(*answers, creates=creates):
                status, body = up.install([], 8931)
            self.assertEqual((status, body), (502, {"error": f"uv no pudo instalarla: {said}"}))
            self.say.assert_called_with(f"uv no pudo instalar la actualización: {said}")
            self.release.assert_called_once_with()
            self.release.reset_mock()
            self.timer.assert_not_called()
            self.assertTrue(up._installing.acquire(blocking=False))
            up._installing.release()
        with self.uv_answers(subprocess.CalledProcessError(2, "uv")):
            os.remove(os.path.join(self.prefix, up.RECEIPT))
            self.assertEqual(up.install([], 8931)[0], 502)
        self.assertTrue(up._installing.acquire(blocking=False))
        up._installing.release()

    def test_windows_hands_the_install_to_a_detached_helper_and_exits(self):
        self.with_receipt(GIT_RECEIPT)
        with patch.object(up.sys, "platform", "win32"), patch.object(up.subprocess, "Popen") as popen, \
                patch.object(up.sys, "_base_executable", "C:\\py\\python.exe", create=True):
            self.assertEqual(up.install(["--host", "0.0.0.0"], 8931), (202, {"ok": True, "skills": ""}))
        helper = popen.call_args.args[0]
        self.assertEqual(helper[:2], ["C:\\py\\python.exe", "-c"])
        self.assertIn("from odoo_wrapper.updates import finish", helper[2])
        plan = json.loads(helper[3])
        self.assertEqual((plan["port"], plan["env"]["UV_TOOL_DIR"], plan["new"][1:]),
                         (8931, self.tools, ["-c", up.process.INSTALLED_BOOTSTRAP, "--host", "0.0.0.0"]))
        self.assertTrue(plan["new"][0].endswith("pythonw.exe"))
        self.assertEqual(plan["command"], [self.uv, "tool", "install", "--force", "--python",
                                           "{}.{}".format(*sys.version_info[:2]), up.SOURCE])
        self.assertEqual(popen.call_args.kwargs, {"env": os.environ, "creationflags": up.WINDOWS_DETACHED,
                                                  "stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL,
                                                  "stderr": subprocess.DEVNULL, "close_fds": True})
        self.say.assert_called_once_with("Actualización en marcha: el panel se cierra para que uv pueda reemplazarlo")
        self.timer.assert_called_once_with(up.RESTART_DELAY, os._exit, [0])

    def test_the_helper_starts_the_new_dashboard_or_the_old_one_if_uv_failed(self):
        plan = {"command": [self.uv, "tool", "install"], "env": {"UV_TOOL_DIR": self.tools}, "port": 8931,
                "new": [self.installed, "-c", "new"], "old": ["old-python", "-c", "old"]}
        said = ("Actualización instalada: arranca la versión nueva",
                "uv no pudo instalar la actualización: boom. Vuelve a arrancar la versión anterior")
        for answer, started, updated, words in ((Ran(), plan["new"], "1", said[0]),
                                                (Ran(1, stderr="boom"), plan["old"], None, said[1])):
            self.runs = []
            with self.uv_answers(answer), patch.object(up.process, "own_the_output"), \
                    patch.object(up.process, "port_taken") as port, patch.object(up.subprocess, "Popen") as popen:
                up.finish(plan)
            port.assert_called_once_with(8931, up.HANDOVER_GRACE)
            self.assertEqual(self.runs[0][1]["env"], dict(os.environ, UV_TOOL_DIR=self.tools))
            self.say.assert_called_with(words)
            self.assertEqual(popen.call_args.args[0], started)
            self.assertEqual(popen.call_args.kwargs["env"].get(up.process.UPDATED_ENV), updated)
            self.assertEqual(popen.call_args.kwargs["env"]["UV_TOOL_DIR"], self.tools)
            os.remove(self.installed)


if __name__ == "__main__":
    unittest.main()
