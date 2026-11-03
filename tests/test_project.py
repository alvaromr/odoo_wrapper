"""Guards over the project rather than its behaviour: what AGENTS.md asks of the code that no other check sees.

- The dependency rule: client.py imports nothing from the package, so the CLI and the dashboard depend on it and
  never the other way round (AGENTS.md § Code style).
- The rules stay pure: the modules in PURE import nothing outside PURE_IMPORTS and each other, so no Odoo client,
  urllib, socket, subprocess, file or thread can reach them, and they never read the clock (CLOCK_READS), print or
  open anything: the edge modules (data.py, team.py, corrections.py) read the rows and send the writes.
- No secret in any file under the repo, ignored ones included (AGENTS.md, rule 3): private keys and the token
  formats this project handles or could leak. The working copies of the mutation tools are left out.
- No source file past MAX_LINES: past that size a module holds more than one idea and wants splitting.
- Every module of the package and of the page is named in AGENTS.md's map, so the map cannot fall behind.
"""

import ast
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PACKAGE = os.path.join(ROOT, "src", "odoo_wrapper")
SCRIPTS = os.path.join(PACKAGE, "templates", "js")
SKIPPED = {".git", "mutants", ".stryker-tmp", "reports", "__pycache__", "build", "dist", "node_modules"}
SECRETS = {
    "private key": re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    "Discord bot token": re.compile(r"\b[MNO][A-Za-z\d_-]{23,25}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,38}\b"),
    "GitHub token": re.compile(r"\bgh[pousr]_[A-Za-z\d]{36}\b"),
    "Google API key": re.compile(r"\bAIza[\w-]{35}\b"),
    "Google refresh token": re.compile(r"\b1//0[\w-]{20,}"),
}
MAX_LINES = 1000
PURE = ("data_rules", "team_rules", "corrections_rules")
PURE_IMPORTS = {"__future__", "collections.abc", "datetime", "html", "re", "typing"}
CLOCK_READS = {"now", "today", "utcnow"}
IO_CALLS = {"open", "print", "input"}


def impurities(source):
    tree = ast.parse(source)
    allowed = PURE_IMPORTS | {f"odoo_wrapper.{name}" for name in PURE}
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found += [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom) and node.module == "odoo_wrapper":
            found += [f"odoo_wrapper.{alias.name}" for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            found.append(node.module)
        elif isinstance(node, ast.Call):
            if isinstance(node.func, ast.Attribute) and node.func.attr in CLOCK_READS:
                found.append(f"clock read: {node.func.attr}()")
            elif isinstance(node.func, ast.Name) and node.func.id in IO_CALLS:
                found.append(f"I/O call: {node.func.id}()")
    return sorted({name for name in found if name not in allowed})


def sources():
    return [
        os.path.join(folder, name)
        for folder in (PACKAGE, SCRIPTS)
        for name in sorted(os.listdir(folder))
        if name.endswith((".py", ".js", ".css", ".html"))
    ]


def files():
    for folder, names, found in os.walk(ROOT):
        names[:] = [name for name in names if name not in SKIPPED]
        yield from (os.path.join(folder, name) for name in found)


@unittest.skipIf("MUTANT_UNDER_TEST" in os.environ, "mutmut's copy holds the package, not the repo these guard")
class ProjectTest(unittest.TestCase):
    def test_the_client_imports_nothing_from_the_package(self):
        with open(os.path.join(PACKAGE, "client.py"), encoding="utf-8") as f:
            tree = ast.parse(f.read())
        imported = [
            ("." * node.level) + (node.module or "") for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)
        ]
        imported += [alias.name for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names]
        self.assertTrue(imported)
        self.assertEqual([name for name in imported if name.startswith((".", "odoo_wrapper"))], [])

    def test_the_rules_modules_import_nothing_that_does_io_and_never_read_the_clock(self):
        for name in PURE:
            with open(os.path.join(PACKAGE, f"{name}.py"), encoding="utf-8") as f:
                self.assertEqual(impurities(f.read()), [], name)

    def test_the_purity_guard_catches_what_it_names(self):
        samples = [
            ("odoo_wrapper.client", "from odoo_wrapper.client import OdooClient"),
            ("odoo_wrapper.client", "from odoo_wrapper import client"),
            ("odoo_wrapper.data", "from odoo_wrapper import data"),
            ("urllib.request", "import urllib.request"),
            ("socket", "import socket"),
            ("subprocess", "import subprocess"),
            ("clock read: now()", "datetime.now()"),
            ("clock read: today()", "date.today()"),
            ("I/O call: open()", "open('x')"),
            ("I/O call: print()", "print('x')"),
        ]
        for expected, source in samples:
            self.assertEqual(impurities(source), [expected], source)
        self.assertEqual(impurities("from odoo_wrapper import data_rules\nimport re\nnow = 1"), [])

    def test_no_file_holds_a_secret(self):
        found = []
        for path in files():
            try:
                with open(path, encoding="utf-8") as f:
                    text = f.read()
            except (UnicodeDecodeError, OSError):
                continue
            found += [
                f"{os.path.relpath(path, ROOT)}: {kind}" for kind, pattern in SECRETS.items() if pattern.search(text)
            ]
        self.assertEqual(found, [])

    def test_the_secret_patterns_match_what_they_name(self):
        samples = {
            "private key": "-----BEGIN RSA " + "PRIVATE KEY-----",
            "Discord bot token": "MTA" + "x" * 21 + ".GaBcDe." + "y" * 38,
            "GitHub token": "ghp_" + "a1" * 18,
            "Google API key": "AIza" + "b" * 35,
            "Google refresh token": "1//0" + "c" * 30,
        }
        self.assertEqual(samples.keys(), SECRETS.keys())
        for kind, sample in samples.items():
            self.assertTrue(SECRETS[kind].search(f"x = '{sample}'"), kind)

    def test_no_source_file_is_too_long(self):
        long = []
        for path in sources():
            with open(path, encoding="utf-8") as f:
                if sum(1 for _ in f) > MAX_LINES:
                    long.append(os.path.relpath(path, ROOT))
        self.assertEqual(long, [])

    def test_agents_md_names_every_module(self):
        with open(os.path.join(ROOT, "AGENTS.md"), encoding="utf-8") as f:
            guide = f.read()
        modules = [name for name in os.listdir(PACKAGE) if name.endswith(".py") and name != "__init__.py"]
        scripts = [name[:-3] for name in os.listdir(SCRIPTS) if name.endswith(".js")]
        missing = [name for name in modules if name not in guide]
        missing += [name for name in scripts if not re.search(rf"\b{name}\b", guide)]
        self.assertEqual(missing, [])


if __name__ == "__main__":
    unittest.main()
