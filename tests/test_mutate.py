"""Unit tests for what each mutation round retests, decided by scripts/mutate.py from the files that changed."""

import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))

import mutate  # noqa: E402 - found only once scripts/ is on the path

PY_FILES = {
    "src/odoo_wrapper/state.py": "",
    "src/odoo_wrapper/cache.py": "",
    "src/odoo_wrapper/qr.py": "",
    "tests/harness.py": "import os\n",
    "tests/test_state.py": "import json\n\nfrom harness import NOW\n",
    "tests/test_cache.py": "import harness\n",
    "tests/test_qr.py": "import unittest\n",
    "tests/test_project.py": "from harness import NOW\n",
    "tests/report_coverage.py": "import sys\n",
}
JS_FILES = {
    "src/odoo_wrapper/static/js/store.js": "",
    "src/odoo_wrapper/static/js/tip.js": "",
    "src/odoo_wrapper/static/js/qr.js": "",
    "tests/page.mjs": "export const x = 1;\n",
    "tests/store.test.mjs": 'import { load } from "./page.mjs";\n',
    "tests/tip.test.mjs": 'import {\n  load,\n} from "./page.mjs";\n',
    "tests/qr.test.mjs": 'import test from "node:test";\n',
    "stryker.config.json": json.dumps({"mutate": ["a.js"], "commandRunner": {"command": "node --test"}}),
    "tsconfig.json": "{}",
    "package.json": "{}",
    "pnpm-lock.yaml": "",
    "pnpm-workspace.yaml": "minimumReleaseAge: 5760\n",
}


@unittest.skipIf("MUTANT_UNDER_TEST" in os.environ, "mutmut's copy holds the package, not the scripts")
class PlanTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = folder.name
        patcher = patch.object(mutate, "ROOT", self.root)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.result = os.path.join(self.root, "result")
        self.digest = os.path.join(self.root, "digest.json")
        self.write({**PY_FILES, **JS_FILES})

    def write(self, files):
        for path, text in files.items():
            os.makedirs(os.path.dirname(os.path.join(self.root, path)), exist_ok=True)
            with open(os.path.join(self.root, path), "w") as target:
                target.write(text)

    def remove(self, path):
        os.remove(os.path.join(self.root, path))

    def recorded(self, now):
        self.write({"result": ""})
        mutate.record(self.digest, now)

    def py_plan(self, full=False):
        return mutate.plan(full, self.result, self.digest, mutate.py_watched(), mutate.py_reach)

    def js_plan(self, full=False):
        return mutate.plan(full, self.result, self.digest, mutate.js_watched(), mutate.js_reach)

    def test_full_when_asked_even_with_nothing_changed(self):
        self.recorded(mutate.py_watched())
        self.assertEqual(self.py_plan(full=True), ("asked for with --full", []))

    def test_full_without_a_previous_result(self):
        self.assertEqual(self.py_plan(), ("no previous result", []))

    def test_full_without_a_recorded_digest(self):
        self.write({"result": ""})
        self.assertEqual(self.py_plan(), ("no complete result recorded yet", []))

    def test_nothing_changed_retests_nothing(self):
        self.recorded(mutate.py_watched())
        self.assertEqual(self.py_plan(), (None, []))

    def test_a_modules_test_retests_that_module(self):
        self.recorded(mutate.py_watched())
        self.write({"tests/test_state.py": "from harness import NOW, TODAY\n"})
        self.assertEqual(self.py_plan(), (None, ["state"]))

    def test_a_new_or_deleted_test_of_a_module_retests_that_module(self):
        self.recorded(mutate.py_watched())
        self.remove("tests/test_qr.py")
        self.write({"tests/test_cache_more.py": ""})
        self.assertEqual(self.py_plan(), (None, ["qr"]))

    def test_the_shared_helper_retests_only_the_modules_whose_tests_import_it(self):
        self.recorded(mutate.py_watched())
        self.write({"tests/harness.py": "import io\n"})
        self.assertEqual(self.py_plan(), (None, ["cache", "state"]))

    def test_a_helper_imported_through_another_helper_reaches_the_tests_of_both(self):
        self.write({"tests/fixtures.py": "", "tests/harness.py": "from fixtures import ROWS\n"})
        self.recorded(mutate.py_watched())
        self.write({"tests/fixtures.py": "ROWS = []\n"})
        self.assertEqual(self.py_plan(), (None, ["cache", "state"]))

    def test_the_guards_and_the_coverage_report_retest_nothing(self):
        self.recorded(mutate.py_watched())
        self.write({"tests/test_project.py": "import re\n", "tests/report_coverage.py": "import os\n"})
        self.assertEqual(self.py_plan(), (None, []))

    def test_the_python_round_watches_no_config_lock_or_version(self):
        self.assertEqual(sorted(mutate.py_watched()), sorted(path for path in PY_FILES if path.startswith("tests/")))

    def test_the_page_round_ignores_tool_config_locks_and_versions(self):
        self.recorded(mutate.js_watched())
        self.write(
            {
                "tsconfig.json": '{"strict": true}',
                "package.json": '{"packageManager": "pnpm@99.0.0"}',
                "pnpm-lock.yaml": "lockfileVersion: 10\n",
                "pnpm-workspace.yaml": "minimumReleaseAge: 1\n",
            }
        )
        self.assertEqual(self.js_plan(), (None, []))

    def test_a_page_modules_test_retests_that_module(self):
        self.recorded(mutate.js_watched())
        self.write({"tests/tip.test.mjs": "// changed\n"})
        self.assertEqual(self.js_plan(), (None, ["tip"]))

    def test_the_page_harness_retests_only_the_modules_whose_tests_import_it(self):
        self.recorded(mutate.js_watched())
        self.write({"tests/page.mjs": "export const x = 2;\n"})
        self.assertEqual(self.js_plan(), (None, ["store", "tip"]))

    def test_strykers_config_outside_how_tests_run_retests_nothing(self):
        self.recorded(mutate.js_watched())
        config = {"mutate": ["b.js"], "commandRunner": {"command": "node --test"}, "reporters": ["html"]}
        self.write({"stryker.config.json": json.dumps(config, indent=4)})
        self.assertEqual(self.js_plan(), (None, []))

    def test_strykers_config_of_how_tests_run_retests_every_mutant_saying_why(self):
        self.recorded(mutate.js_watched())
        config = {"mutate": ["a.js"], "commandRunner": {"command": "node --test --test-concurrency=1"}}
        self.write({"stryker.config.json": json.dumps(config)})
        self.assertEqual(self.js_plan(), ("stryker.config.json changed how every mutant's tests run", []))


if __name__ == "__main__":
    unittest.main()
