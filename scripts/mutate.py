#!/usr/bin/env python3
"""Mutation testing, on what changed since the last result unless a full round is asked for (AGENTS.md § How to
verify changes says when each runs).

`python3 scripts/mutate.py` is the Python round, mutmut over the package (pyproject.toml), and `python3
scripts/mutate.py js` the page's, StrykerJS over its JS (stryker.config.json). By default each runs scoped: the
tool's own incremental mode retests only the mutants whose code changed (mutmut by the hash of each function,
StrykerJS by a diff of each file against reports/stryker-incremental.json) and reuses every other result. Neither
sees a change in a test that already existed: mutmut maps only new tests, and StrykerJS's command runner reports no
test files. So this script keeps a digest of the tests and the files every mutant depends on, written after each
complete round (mutants/odoo-tests.json, reports/odoo-tests.json), and compares it before the next: a test of one
module changed (tests/test_<module>.py, tests/<module>.test.mjs) retests that module's mutants; anything else changed
(a shared helper such as tests/harness.py or tests/page.mjs, StrykerJS's config, the Node lock) runs the round in full
and says why. mutmut watches its own config and dependencies itself (pyproject.toml's on_dependency_change), and
reruns all with the files it names. tests/test_project.py and tests/report_coverage.py are not watched: mutmut skips
the guards, and the coverage report runs no mutant. A round runs in full, saying why, also when the tool's result or
the digest is missing, since no complete result exists to reuse, and with `--full`, for the owner's request. Naming
modules instead, `python3 scripts/mutate.py state cache` or `... js tip`, retests only theirs and leaves the digest
as it was.

Every round is bounded so the machine stays usable: at lower priority (NICENESS), on at most half the cores, fewer
for the page, whose every mutant runs the whole suite in one node process (JS_CONCURRENCY), and with a timeout per
mutant of about 10 to 20 times what its tests take: mutmut's default multiplier, 15, and StrykerJS's timeoutFactor in
its config.

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
PY_UNWATCHED = {"tests/test_project.py", "tests/report_coverage.py"}
JS_RESULTS = os.path.join(ROOT, "reports")
JS_INCREMENTAL = os.path.join(JS_RESULTS, "stryker-incremental.json")
JS_DIGEST = os.path.join(JS_RESULTS, "odoo-tests.json")
JS_WATCHED = [
    "tests/*.mjs",
    "stryker.config.json",
    "tsconfig.json",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
]


def digests(paths):
    def digest(path):
        with open(os.path.join(ROOT, path), "rb") as source:
            return hashlib.sha256(source.read()).hexdigest()

    return {path: digest(path) for path in sorted(paths)}


def watched(patterns, unwatched=frozenset()):
    found = {os.path.relpath(path, ROOT) for pattern in patterns for path in glob.glob(os.path.join(ROOT, pattern))}
    return digests(found - unwatched)


def py_module(path):
    name = os.path.basename(path)
    module = name.removeprefix("test_").removesuffix(".py")
    return module if name.startswith("test_") and os.path.isfile(os.path.join(ROOT, PACKAGE, f"{module}.py")) else None


def js_module(path):
    module = os.path.basename(path).removesuffix(".test.mjs")
    return module if path.endswith(".test.mjs") and os.path.isfile(os.path.join(ROOT, PAGE, f"{module}.js")) else None


def plan(full, result, digest_path, now, module_of):
    """Why the round runs in full, or None, and the modules whose tests changed since the last complete round."""
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
    shared = [path for path in changed if module_of(path) is None]
    if shared:
        return f"{', '.join(shared)} changed, which every mutant depends on", []
    return None, sorted({module_of(path) for path in changed})


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
    now = watched(["tests/*.py"], PY_UNWATCHED)
    if modules:
        names = [[f"odoo_wrapper.{module}.*" for module in known(modules, PACKAGE, ".py")]]
    else:
        reason, changed = plan(full, PY_STATS, PY_DIGEST, now, py_module)
        if reason:
            print(f"Full round: {reason}")
            shutil.rmtree(PY_RESULTS, ignore_errors=True)
        elif changed:
            print(f"Tests changed for {', '.join(changed)}: their mutants run again")
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
    now = watched(JS_WATCHED)
    if modules:
        incremental = ["--incremental", "--force"] if os.path.isfile(JS_INCREMENTAL) else []
        runs = [[*incremental, "--mutate", page_files(known(modules, PAGE, ".js"))]]
    else:
        reason, changed = plan(full, JS_INCREMENTAL, JS_DIGEST, now, js_module)
        if reason:
            print(f"Full round: {reason}")
            runs = [["--incremental", "--force"]]
        else:
            if changed:
                print(f"Tests changed for {', '.join(changed)}: their mutants run again")
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
