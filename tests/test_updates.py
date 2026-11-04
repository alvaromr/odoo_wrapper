"""Unit tests for the update check: what GitHub is asked, how versions compare, and how long an answer lasts."""

import io
import json
import os
import socket
import subprocess
import sys
import time
import unittest
import urllib.error
from unittest.mock import call, patch

from harness import logged, temp_state

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
            self.assertEqual(
                up.ask(),
                {"available": True, "current": "1.9.0", "latest": "1.10.0", "url": PAGE + "1.10.0", "error": ""},
            )
            self.assertFalse(up.ask()["available"])
            older = up.ask()
            self.assertEqual((older["available"], older["latest"]), (False, "1.2.3"))
        url, headers, timeout = self.asked[0]
        self.assertEqual(url, "https://api.github.com/repos/alvaromr/odoo_wrapper/releases/latest")
        self.assertEqual(
            (headers["Accept"], headers["User-agent"], timeout),
            ("application/vnd.github+json", "odoo-wrapper", up.TIMEOUT),
        )

    def test_a_failed_check_is_logged_and_reported_never_taken_for_up_to_date(self):
        none_yet = urllib.error.HTTPError(up.LATEST, 404, "Not Found", {}, io.BytesIO())
        failures = (
            none_yet,
            urllib.error.URLError("sin red"),
            TimeoutError("timed out"),
            b"<html>",
            release("v1.x"),
            {"message": "Not Found"},
        )
        for failure in failures:
            with self.github(failure), logged() as out:
                answer = up.ask()
            self.assertEqual(
                (answer["available"], answer["current"], answer["latest"], answer["url"]),
                (False, __version__, None, None),
            )
            self.assertTrue(answer["error"].startswith("No se pudo consultar GitHub: "), failure)
            lines = out.getvalue().splitlines()
            self.assertEqual(len(lines), 1, failure)
            self.assertTrue(lines[0].startswith("WARNING No se pudo buscar actualizaciones en GitHub: "), failure)

    def test_an_answer_is_kept_for_hours_and_a_forced_check_reuses_one_younger_than_a_minute(self):
        clock = [1000.0]
        answers = (release("v1.0.0"), release("v1.1.0"), release("v1.0.0"))
        with (
            patch.object(up, "__version__", "1.0.0"),
            self.github(*answers),
            patch.object(up.time, "monotonic", side_effect=lambda: clock[0]),
        ):
            self.assertFalse(up.check()["available"])
            clock[0] += up.FRESH_MIN - 1
            self.assertFalse(up.recheck()["available"])
            clock[0] = 1000.0 + up.CHECK_TTL - 1
            self.assertFalse(up.check()["available"])
            clock[0] += 1
            self.assertTrue(up.check()["available"])
            self.assertTrue(up.recheck()["available"])
            clock[0] += up.FRESH_MIN
            self.assertFalse(up.recheck()["available"])
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


class Replaced(BaseException):
    """What execve never returns from: the process is gone."""


class FakeTimer:
    """Stands in for threading.Timer: records what is scheduled and runs it only when the test fires it."""

    def __init__(self, scheduled, delay, function, args):
        self.delay, self.function, self.args, self.started = delay, function, args, False
        scheduled.append(self)

    def start(self):
        self.started = True

    def fire(self):
        self.function(*self.args)


class InstallTest(unittest.TestCase):
    def setUp(self):
        self.home = temp_state(self)
        self.tools = os.path.join(self.home, "tools")
        self.prefix = os.path.join(self.tools, up.TOOL)
        os.makedirs(os.path.join(self.prefix, "bin"))
        self.installed = os.path.join(self.prefix, "bin", "python")
        self.uv = os.path.join(self.home, "uv")
        self.claude = os.path.join(self.home, "claude")
        self.programs = {"uv": self.uv}
        self.runs, self.held, self.timers = [], [], []
        self.out = io.StringIO()
        capture = logged(self.out)
        capture.__enter__()
        self.addCleanup(capture.__exit__, None, None, None)
        patches = [
            patch.object(up.sys, "prefix", self.prefix),
            patch.dict(os.environ, {"HOME": self.home}),
            patch.object(up, "SYSTEM_BINS", ()),
            patch.object(
                up.shutil,
                "which",
                side_effect=lambda program: self.programs.get(program),  # noqa: PLW0108 - tests replace self.programs
            ),
            patch.object(up.threading, "Timer", new=lambda *args: FakeTimer(self.timers, *args)),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.which = up.shutil.which
        self.addCleanup(up.process._held.clear)
        self.addCleanup(lambda: up._installing.locked() and up._installing.release())

    def said(self):
        lines = self.out.getvalue().splitlines()
        self.out.seek(0)
        self.out.truncate()
        return lines

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
            if command[1:3] == ["tool", "install"]:
                self.held.append(up.process._held.is_set())
                if creates:
                    open(self.installed, "w").close()
            return result

        return patch.object(up.subprocess, "run", side_effect=run)

    def test_a_program_is_found_on_the_path_or_where_its_installers_put_it(self):
        self.programs = {"uv": "/path/uv"}
        self.assertEqual(up.find("uv"), "/path/uv")
        self.which.assert_called_once_with("uv")
        self.programs = {}
        system = os.path.join(self.home, "system")
        os.makedirs(system)
        open(os.path.join(system, "uv"), "w").close()
        with patch.object(up, "SYSTEM_BINS", (system,)):
            self.assertEqual(up.find("uv"), os.path.join(system, "uv"))
        local = os.path.join(self.home, ".local", "bin")
        os.makedirs(local)
        self.assertIsNone(up.find("uv"))
        open(os.path.join(local, "uv"), "w").close()
        self.assertEqual(up.find("uv"), os.path.join(local, "uv"))
        with patch.object(up.sys, "platform", "win32"):
            self.assertIsNone(up.find("uv"))

    def test_the_skills_are_updated_when_claude_has_the_plugin_and_only_a_failure_is_reported(self):
        listed = Ran(stdout=json.dumps([{"id": "other@x"}, {"id": up.PLUGIN}]))
        cases = [
            (False, [], "", 0),
            (True, [Ran(stdout='[{"id": "other@x"}]')], "", 1),
            (True, [listed, Ran()], "", 2),
            (True, [listed, Ran(stdout="Plugin updated", stderr="notice")], "", 2),
            (True, [listed, Ran(1, stdout="", stderr="marketplace not found")], "marketplace not found", 2),
            (
                True,
                [subprocess.CalledProcessError(1, "claude")],
                "Command 'claude' returned non-zero exit status 1.",
                1,
            ),
            (True, [Ran(stdout="<html>")], "Expecting value: line 1 column 1 (char 0)", 1),
        ]
        for has_claude, answers, failure, calls in cases:
            self.runs = []
            self.programs = {"claude": self.claude} if has_claude else {}
            with self.uv_answers(*answers):
                self.assertEqual(up.update_skills(), failure)
            self.assertEqual(len(self.runs), calls)
            said = [f"WARNING No se pudieron actualizar las skills de Claude Code: {failure}"] if failure else []
            self.assertEqual(self.said(), said)
        self.runs = []
        self.which.reset_mock()
        self.programs = {"claude": self.claude}
        with self.uv_answers(listed, Ran()):
            up.update_skills()
        self.which.assert_called_once_with("claude")
        quiet = {"capture_output": True, "text": True, "stdin": subprocess.DEVNULL, "timeout": up.CLAUDE_TIMEOUT}
        self.assertEqual(
            self.runs,
            [
                ([self.claude, "plugin", "list", "--json"], dict(quiet, check=True)),
                ([self.claude, "plugin", "update", up.PLUGIN], dict(quiet, check=False)),
            ],
        )

    def test_the_development_install_updates_with_git_and_one_without_uv_by_hand(self):
        self.assertEqual(up.how(), "auto")
        self.which.assert_called_with("uv")
        self.with_receipt(EDITABLE_RECEIPT)
        self.assertEqual(up.how(), "git")
        os.remove(os.path.join(self.prefix, up.RECEIPT))
        self.programs = {}
        self.assertEqual(up.how(), "manual")
        self.assertEqual(
            up.install([], 8931),
            (409, {"error": "Esta instalación no se actualiza desde aquí: pídeselo a tu agente"}),
        )

    def test_a_uv_tool_is_replaced_in_its_own_folders(self):
        self.assertEqual(up.placement(""), {})
        self.assertEqual(
            up.placement(GIT_RECEIPT), {"UV_TOOL_DIR": self.tools, "UV_TOOL_BIN_DIR": '/home/ana/my \\"bin\\"'}
        )
        self.assertEqual(
            up.placement("entrypoints = [{ name = 'odoo', install-path = '/opt/bin/odoo' }]")["UV_TOOL_BIN_DIR"],
            "/opt/bin",
        )
        self.assertEqual(up.placement("[tool]\n"), {"UV_TOOL_DIR": self.tools})

    def test_the_new_interpreter_is_where_uv_puts_each_system_s(self):
        self.assertEqual(up.interpreter("/t"), os.path.join("/t", up.TOOL, "bin", "python"))
        with patch.object(up.sys, "platform", "win32"):
            self.assertEqual(up.interpreter("T"), os.path.join("T", up.TOOL, "Scripts", "python.exe"))
            self.assertEqual(up.interpreter("T", "pythonw"), os.path.join("T", up.TOOL, "Scripts", "pythonw.exe"))

    def test_an_install_runs_uv_from_github_holds_the_watcher_and_restarts_into_the_new_interpreter(self):
        self.with_receipt('[tool]\nrequirements = [{ name = "odoo-wrapper", directory = "/x" }]\n')
        self.programs["claude"] = self.claude
        skills = (Ran(stdout=json.dumps([{"id": up.PLUGIN}])), Ran(1, stderr="marketplace not found"))
        with (
            self.uv_answers(*skills, Ran()),
            patch.object(os, "execve", side_effect=Replaced) as execve,
            patch.object(up.subprocess, "Popen") as popen,
            patch.object(os, "_exit") as exit_,
        ):
            self.assertEqual(
                up.install(["--host", "0.0.0.0"], 8931), (200, {"ok": True, "skills": "marketplace not found"})
            )
            self.assertEqual(self.held, [True])
            self.assertTrue(up.process._held.is_set())
            self.assertEqual(
                [(timer.delay, timer.function, timer.args, timer.started) for timer in self.timers],
                [(up.RESTART_DELAY, up.process.restart, [["--host", "0.0.0.0"], self.installed], True)],
            )
            with self.assertRaises(Replaced):
                self.timers[0].fire()
        execve.assert_called_once_with(
            self.installed,
            [self.installed, "-c", up.process.INSTALLED_BOOTSTRAP, "--host", "0.0.0.0"],
            dict(os.environ, **{up.process.UPDATED_ENV: "1"}),
        )
        popen.assert_not_called()
        exit_.assert_not_called()
        self.assertEqual(
            [run[0][:3] for run in self.runs[:2]],
            [[self.claude, "plugin", "list"], [self.claude, "plugin", "update"]],
        )
        command, kwargs = self.runs[2]
        version = "{}.{}".format(*sys.version_info[:2])
        self.assertEqual(command, [self.uv, "tool", "install", "--force", "--python", version, up.SOURCE])
        self.assertEqual(
            kwargs,
            {
                "check": False,
                "env": dict(os.environ, UV_TOOL_DIR=self.tools),
                "capture_output": True,
                "text": True,
                "timeout": up.INSTALL_TIMEOUT,
            },
        )
        self.which.assert_any_call("uv")
        self.assertEqual(
            self.said(),
            [
                "WARNING No se pudieron actualizar las skills de Claude Code: marketplace not found",
                f"INFO Actualización instalada en {self.installed}: reiniciando…",
            ],
        )
        self.assertEqual(up.install([], 8931), (409, {"error": "Ya se está instalando una actualización"}))

    def test_a_copy_with_no_uv_tool_gets_the_readme_s_install_in_uv_s_folders(self):
        with self.uv_answers(Ran(stdout=f"{self.tools}\n"), Ran()):
            self.assertEqual(up.install([], 8931), (200, {"ok": True, "skills": ""}))
        self.assertEqual(
            self.runs[0],
            (
                [self.uv, "tool", "dir"],
                {"env": dict(os.environ), "capture_output": True, "text": True, "check": True, "timeout": up.TIMEOUT},
            ),
        )
        self.assertEqual(self.runs[1][1]["env"].get("UV_TOOL_DIR"), os.environ.get("UV_TOOL_DIR"))

    def test_a_failed_install_says_what_uv_printed_and_leaves_the_dashboard_as_it_was(self):
        refused = Ran(1, stdout="Resolved 1 package", stderr="error: Git operation failed")
        for answers, creates, said in (
            ((refused,), True, "error: Git operation failed\nResolved 1 package"),
            ((OSError("uv"),), True, "uv"),
            ((Ran(),), False, f"no aparece {self.installed}"),
        ):
            self.with_receipt(GIT_RECEIPT)
            if os.path.exists(self.installed):
                os.remove(self.installed)
            with self.uv_answers(*answers, creates=creates):
                status, body = up.install([], 8931)
            self.assertEqual((status, body), (502, {"error": f"uv no pudo instalarla: {said}"}))
            self.assertEqual(self.said(), f"ERROR uv no pudo instalar la actualización: {said}".split("\n"))
            self.assertEqual(self.held[-1], True)
            self.assertFalse(up.process._held.is_set())
            self.assertEqual(self.timers, [])
            self.assertTrue(up._installing.acquire(blocking=False))
            up._installing.release()
        with self.uv_answers(subprocess.CalledProcessError(2, "uv")):
            os.remove(os.path.join(self.prefix, up.RECEIPT))
            self.assertEqual(
                up.install([], 8931), (502, {"error": "uv no responde: Command 'uv' returned non-zero exit status 2."})
            )
        self.assertFalse(up.process._held.is_set())
        self.assertTrue(up._installing.acquire(blocking=False))
        up._installing.release()

    def test_windows_hands_the_install_to_a_detached_helper_and_exits(self):
        self.with_receipt(GIT_RECEIPT)
        with (
            patch.object(up.sys, "platform", "win32"),
            patch.object(up.subprocess, "Popen") as popen,
            patch.object(up.sys, "_base_executable", "C:\\py\\python.exe", create=True),
            patch.object(os, "_exit") as exit_,
        ):
            self.assertEqual(up.install(["--host", "0.0.0.0"], 8931), (202, {"ok": True, "skills": ""}))
            self.assertEqual(
                [(timer.delay, timer.function, timer.args, timer.started) for timer in self.timers],
                [(up.RESTART_DELAY, exit_, [0], True)],
            )
            exit_.assert_not_called()
            self.timers[0].fire()
        exit_.assert_called_once_with(0)
        self.assertFalse(up.process._held.is_set())
        helper = popen.call_args.args[0]
        self.assertEqual(helper[:2], ["C:\\py\\python.exe", "-c"])
        self.assertEqual(
            helper[2],
            f"import json, sys; sys.path.insert(0, {os.path.dirname(up.process.HERE)!r}); "
            "from odoo_wrapper.updates import finish; finish(json.loads(sys.argv[1]))",
        )
        plan = json.loads(helper[3])
        self.assertEqual(plan["old"], up.process.launch_command(["--host", "0.0.0.0"]))
        self.assertEqual(
            (plan["port"], plan["env"]["UV_TOOL_DIR"], plan["new"][1:]),
            (8931, self.tools, ["-c", up.process.INSTALLED_BOOTSTRAP, "--host", "0.0.0.0"]),
        )
        self.assertTrue(plan["new"][0].endswith("pythonw.exe"))
        self.assertEqual(
            plan["command"],
            [self.uv, "tool", "install", "--force", "--python", "{}.{}".format(*sys.version_info[:2]), up.SOURCE],
        )
        self.assertEqual(
            popen.call_args.kwargs,
            {
                "env": os.environ,
                "creationflags": up.WINDOWS_DETACHED,
                "stdin": subprocess.DEVNULL,
                "stdout": subprocess.DEVNULL,
                "stderr": subprocess.DEVNULL,
                "close_fds": True,
            },
        )
        self.assertEqual(
            self.said(), ["INFO Actualización en marcha: el panel se cierra para que uv pueda reemplazarlo"]
        )

    def test_the_helper_starts_the_new_dashboard_or_the_old_one_if_uv_failed(self):
        plan = {
            "command": [self.uv, "tool", "install"],
            "env": {"UV_TOOL_DIR": self.tools},
            "port": 8931,
            "new": [self.installed, "-c", "new"],
            "old": ["old-python", "-c", "old"],
        }
        said = (
            "INFO Actualización instalada: arranca la versión nueva",
            "ERROR uv no pudo instalar la actualización: boom. Vuelve a arrancar la versión anterior",
        )
        for answer, started, updated, words in (
            (Ran(), plan["new"], "1", said[0]),
            (Ran(1, stderr="boom"), plan["old"], None, said[1]),
        ):
            self.runs = []
            terminal = io.StringIO()
            terminal.isatty = lambda: True
            with (
                self.uv_answers(answer),
                patch.object(sys, "stdout", terminal),
                patch.object(socket.socket, "connect_ex", side_effect=[0, 1]) as connect,
                patch.object(time, "sleep") as sleep,
                patch.object(up.subprocess, "Popen") as popen,
            ):
                up.finish(plan)
            self.assertEqual(connect.call_args_list, [call(("127.0.0.1", 8931))] * 2)
            sleep.assert_called_once_with(0.2)
            self.assertEqual(self.runs[0][1]["env"], dict(os.environ, UV_TOOL_DIR=self.tools))
            self.assertEqual([line.split(" ", 2)[2] for line in terminal.getvalue().splitlines()], [words])
            self.assertEqual(popen.call_args.args[0], started)
            self.assertEqual(popen.call_args.kwargs["env"].get(up.process.UPDATED_ENV), updated)
            self.assertEqual(popen.call_args.kwargs["env"]["UV_TOOL_DIR"], self.tools)
            os.remove(self.installed)


if __name__ == "__main__":
    unittest.main()
