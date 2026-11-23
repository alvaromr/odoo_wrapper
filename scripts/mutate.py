#!/usr/bin/env python3
"""Mutation testing, on what changed since the last result unless a full round is asked for (AGENTS.md § How to
verify changes says when each runs).

`python3 scripts/mutate.py` is the Python round, mutmut over the package (pyproject.toml), and `python3
scripts/mutate.py js` the page's, StrykerJS over its JS (stryker.config.json). By default each runs scoped: the
tool's own incremental mode retests only the mutants whose code changed (mutmut by the hash of each function and of
those it calls, StrykerJS by a diff of each file against reports/stryker-incremental.json) and reuses every other
result. StrykerJS's Vitest runner reports each test with its file, so its incremental mode also retests the mutants
a changed test file covers; mutmut maps only new tests, and neither sees a shared helper that is no test file. So
this script keeps a digest of what they miss, written after each complete round (mutants/odoo-tests.json,
reports/odoo-tests.json), and compares it before the next, retesting only the modules each change reaches: a Python
test of one module (tests/test_<module>.py) reaches that module; a shared helper (tests/harness.py, tests/page.mjs,
or one they import) the modules whose tests import it; a file no test imports, such as the guards of
tests/test_project.py or tests/report_coverage.py, none. The page's test files (tests/*.test.mjs) are left to
StrykerJS. Its config reaches every mutant only through the keys that say how the tests run, all but
JS_CONFIG_UNUSED (which files are mutated, where the reports go, what the sandbox leaves out), and Vitest's
(JS_SUITE_CONFIG) through any change; the round then runs in full, saying why. Nothing else is watched: the tools'
versions and locks, the package's version, pnpm's settings, tsconfig.json and the linters' config change no mutant's
result, and a mutant they add, as a new file to mutate or a new release of the tool may, has no result yet and runs
anyway. mutmut, told so in pyproject.toml, ignores the changes of files
other than Python, and resets by itself only the verdicts its own settings can change (how pytest runs, the
timeout, the type check). A round runs in full also when the tool's result or the digest is missing, since no
complete result exists to reuse, and with `--full`, when the owner asks for it. Naming modules instead, `python3
scripts/mutate.py state cache` or `... js tip`, retests only theirs and leaves the digest as it was.

Every round is bounded so the machine stays usable: at lower priority (NICENESS), on at most half the cores, fewer
for the page, whose every worker is a Vitest process of its own running the tests that cover each mutant
(JS_CONCURRENCY), and with a timeout per mutant: mutmut's default multiplier, 15 times what its tests take, and
StrykerJS's defaults, 1.5 times what the mutant's tests took in the dry run plus 5 seconds
(docs/decisions/0004-strykers-default-timeout.md says why).

The tools come locked, as the gate's do (check.py says how): mutmut, with the pytest it runs and the gate's own mypy,
which type-checks each mutant, from scripts/tools/mutation.txt into .tools/mutation, on MUTMUT_PYTHON; StrykerJS from
package.json. StrykerJS reads tsconfig.json through TypeScript's JavaScript API, which TypeScript 7, the gate's, no
longer ships, so package.json keeps `typescript` on 6, the last line that has it.
"""

import argparse
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

from check import ROOT, TOOLS, install, pythons, run

MUTMUT_PYTHON = "3.12"
NICENESS = 10
CORES = os.cpu_count() or 2
PY_CHILDREN = max(1, CORES // 2)
JS_CONCURRENCY = max(1, min(4, CORES // 2))
PACKAGE = os.path.join("src", "odoo_wrapper")
PAGE = os.path.join(PACKAGE, "static", "js")
PY_RESULTS = os.path.join(ROOT, "mutants")
PY_STATS = os.path.join(PY_RESULTS, "mutmut-stats.json")
PY_DIGEST = os.path.join(PY_RESULTS, "odoo-tests.json")
JS_RESULTS = os.path.join(ROOT, "reports")
JS_INCREMENTAL = os.path.join(JS_RESULTS, "stryker-incremental.json")
JS_DIGEST = os.path.join(JS_RESULTS, "odoo-tests.json")
JS_CONFIG = "stryker.config.json"
JS_CONFIG_UNUSED = {"mutate", "reporters", "ignorePatterns"}
JS_SUITE_CONFIG = "vitest.config.mjs"


def digests(paths):
    def digest(path):
        with open(os.path.join(ROOT, path), "rb") as source:
            return hashlib.sha256(source.read()).hexdigest()

    return {path: digest(path) for path in sorted(paths)}


def watched(patterns):
    return digests(
        {os.path.relpath(path, ROOT) for pattern in patterns for path in glob.glob(os.path.join(ROOT, pattern))}
    )


def settings(path, unused):
    with open(os.path.join(ROOT, path)) as source:
        kept = {key: value for key, value in json.load(source).items() if key not in unused}
    return hashlib.sha256(json.dumps(kept, sort_keys=True).encode()).hexdigest()


def py_watched():
    return watched(["tests/*.py"])


def js_watched():
    helpers = {path: digest for path, digest in watched(["tests/*.mjs"]).items() if not path.endswith(".test.mjs")}
    return {**helpers, **digests([JS_SUITE_CONFIG]), JS_CONFIG: settings(JS_CONFIG, JS_CONFIG_UNUSED)}


def py_module(path):
    name = os.path.basename(path)
    module = name.removeprefix("test_").removesuffix(".py")
    return module if name.startswith("test_") and os.path.isfile(os.path.join(ROOT, PACKAGE, f"{module}.py")) else None


def js_module(path):
    module = os.path.basename(path).removesuffix(".test.mjs")
    return module if path.endswith(".test.mjs") and os.path.isfile(os.path.join(ROOT, PAGE, f"{module}.js")) else None


def py_import(path):
    return rf"^\s*(?:from|import)\s+{re.escape(os.path.basename(path).removesuffix('.py'))}\b"


def js_import(path):
    return rf'from\s+"\./{re.escape(os.path.basename(path))}"'


def importers(path, statement):
    found = re.compile(statement(path), re.MULTILINE)

    def imports(test):
        with open(test) as source:
            return found.search(source.read())

    tests = glob.glob(os.path.join(ROOT, "tests", "*"))
    return [os.path.relpath(test, ROOT) for test in tests if os.path.isfile(test) and imports(test)]


def reach(path, module_of, statement):
    """The modules whose mutants the test file at path can change: its module's, or those of the tests importing it."""
    module = module_of(path)
    if module:
        return {module}
    return set().union(*(reach(test, module_of, statement) for test in importers(path, statement)))


def py_reach(path):
    return reach(path, py_module, py_import)


def js_reach(path):
    return None if path in (JS_CONFIG, JS_SUITE_CONFIG) else reach(path, js_module, js_import)


def plan(full, result, digest_path, now, reach_of):
    """Why the round runs in full, or None, and the modules whose mutants the changes since the last complete round
    can change: reach_of(path) names them, or is None for a change of how every mutant's tests run."""
    if full:
        return "asked for with --full", []
    if not os.path.isfile(result):
        return "no previous result", []
    try:
        with open(digest_path) as saved:
            before = json.load(saved)
    except FileNotFoundError:
        return "no complete result recorded yet", []
    changed = sorted(path for path in now.keys() | before.keys() if now.get(path) != before.get(path))
    reached = {path: reach_of(path) for path in changed}
    everything = [path for path, modules in reached.items() if modules is None]
    if everything:
        return f"{', '.join(everything)} changed how every mutant's tests run", []
    return None, sorted(set().union(*reached.values()))


def record(digest_path, now):
    os.makedirs(os.path.dirname(digest_path), exist_ok=True)
    with open(digest_path, "w") as saved:
        json.dump(now, saved, indent=2)


def known(modules, folder, suffix):
    unknown = [module for module in modules if not os.path.isfile(os.path.join(ROOT, folder, f"{module}{suffix}"))]
    if unknown:
        sys.exit(f"No module {', '.join(unknown)} in {folder}")
    return modules


def page_files(modules):
    return ",".join(os.path.join(PAGE, f"{module}.js") for module in modules)


def python_round(full, modules):
    if not (pythons(MUTMUT_PYTHON) and install("mutation", MUTMUT_PYTHON)):
        return 1
    tools = os.path.join(TOOLS, "mutation", "bin")
    env = {**os.environ, "no_proxy": "*", "PATH": os.pathsep.join([tools, os.environ.get("PATH", "")])}
    mutmut = [os.path.join(tools, "mutmut"), "run", "--max-children", str(PY_CHILDREN)]
    now = py_watched()
    if modules:
        names = [[f"odoo_wrapper.{module}.*" for module in known(modules, PACKAGE, ".py")]]
    else:
        reason, changed = plan(full, PY_STATS, PY_DIGEST, now, py_reach)
        if reason:
            print(f"Full round: {reason}")
            shutil.rmtree(PY_RESULTS, ignore_errors=True)
        elif changed:
            print(f"Tests changed that reach {', '.join(changed)}: their mutants run again")
        names = [[], *([[f"odoo_wrapper.{module}.*" for module in changed]] if changed else [])]
    done = all(subprocess.run([*mutmut, *each], cwd=ROOT, env=env, check=False).returncode == 0 for each in names)
    if not modules:
        subprocess.run([os.path.join(tools, "mutmut"), "results"], cwd=ROOT, env=env, check=False)
        if done:
            record(PY_DIGEST, now)
    return 0 if done else 1


def js_round(full, modules):
    if not run("page tools", ["pnpm", "install", "--frozen-lockfile"]):
        return 1
    stryker = ["pnpm", "exec", "stryker", "run", "--concurrency", str(JS_CONCURRENCY)]
    now = js_watched()
    if modules:
        incremental = ["--incremental", "--force"] if os.path.isfile(JS_INCREMENTAL) else []
        runs = [[*incremental, "--mutate", page_files(known(modules, PAGE, ".js"))]]
    else:
        reason, changed = plan(full, JS_INCREMENTAL, JS_DIGEST, now, js_reach)
        if reason:
            print(f"Full round: {reason}")
            runs = [["--incremental", "--force"]]
        else:
            if changed:
                print(f"Tests changed that reach {', '.join(changed)}: their mutants run again")
            retest = [["--incremental", "--force", "--mutate", page_files(changed)]] if changed else []
            runs = [["--incremental"], *retest]
    done = all(subprocess.run([*stryker, *each], cwd=ROOT, check=False).returncode == 0 for each in runs)
    if done and not modules:
        record(JS_DIGEST, now)
    return 0 if done else 1


def main():
    parser = argparse.ArgumentParser(description="Mutation testing, scoped to what changed (see the header).")
    parser.add_argument("names", nargs="*", help="`js` for the page's round, then modules to retest alone")
    parser.add_argument("--full", action="store_true", help="retest every mutant, reusing no result")
    args = parser.parse_args()
    page = args.names[:1] == ["js"]
    modules = args.names[1:] if page else args.names
    if args.full and modules:
        parser.error("--full retests every module; name modules or ask for --full, not both")
    os.nice(NICENESS)
    sys.exit((js_round if page else python_round)(args.full, modules))


if __name__ == "__main__":
    main()
