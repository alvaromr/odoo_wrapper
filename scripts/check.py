#!/usr/bin/env python3
"""The gate: every check AGENTS.md § How to verify changes asks for, in one command that fails if any fails.

`python3 scripts/check.py` runs Ruff (format and lint), mypy (strict types, for TYPED_PYTHON: mypy 2 checks for 3.10
or newer only, so what 3.9 lacks is caught by the suites, which run every line on 3.9), the Python suite on every
minor Python the package supports from MIN_PYTHON (read from .python-version, which pyproject.toml's requires-python
must match; Ruff takes its target from requires-python itself) up to the one before COVERAGE_PYTHON, the same suite
on COVERAGE_PYTHON measuring every line and branch (branches need 3.14), Biome over the page's JS and CSS and the JS
tests (format, lint and import order, as biome.jsonc sets), TypeScript checking the page's JS against its JSDoc types
in strict mode (tsconfig.json), the page's suite with its coverage, and a smoke test of the package as users get it:
built by uv on the oldest and the newest Python, installed alone, and its two commands run. Every Python is uv's
own, brought up to the latest patch the pinned uv knows before anything runs, since that is the patch users get;
each Python step names it, so a difference between machines shows. A warning fails the Python suites and Biome as an
error does, and so does one from node in the page's suite (tests/page.mjs). First it checks that node, pnpm and uv
are the versions TOOLCHAIN pins, so every machine runs the gate the same way. Every step runs even after one fails,
so a single run lists everything to fix. The pre-commit hook (.githooks/pre-commit) runs it before each commit, and
the gate installs that hook itself (git's core.hooksPath) the first time it runs in a clone, so no clone goes
without it.

The tools come locked with every dependency they pull in, so each run installs the same files. Ruff and mypy come
from scripts/tools/lint.txt, generated from lint.in with a hash for every file, and installed with the hashes required
into .tools/lint, a virtual environment git ignores, on COVERAGE_PYTHON; Biome and TypeScript from package.json and
pnpm-lock.yaml into node_modules, which pnpm-workspace.yaml hardens. TypeScript is there twice: the gate runs the 7
line through its alias, typescript-7, and `typescript` stays on 6 for StrykerJS (mutate.py says why). The suites run
on `uv run`, with nothing but the standard library. Nothing reaches the package, whose only requirement is still
Python's standard library (AGENTS.md, rule 1). Mutation testing is not part of it: it takes minutes (AGENTS.md says
how to run it).
"""

import glob
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOOKS = ".githooks"
TOOLS = os.path.join(ROOT, ".tools")
LOCKS = os.path.join(ROOT, "scripts", "tools")
TYPED_PYTHON = "3.10"
with open(os.path.join(ROOT, ".python-version")) as pinned:
    MIN_PYTHON = pinned.read().strip()
COVERAGE_PYTHON = "3.14"
LINT = os.path.join(TOOLS, "lint", "bin")
TOOLCHAIN = {"node": "26.13.0", "pnpm": "12.16.1", "uv": "0.13.6"}
VERSION = re.compile(r"\d+\.\d+\.\d+")
NODE_COVERAGE = [
    "--experimental-test-coverage",
    "--test-coverage-include=src/**",
    "--test-coverage-lines=100",
    "--test-coverage-branches=100",
    "--test-coverage-functions=100",
]
COMMANDS = (["odoo-dashboard", "--help"], ["odoo"])
PYTHON_STEPS = [
    ("Ruff format", [os.path.join(LINT, "ruff"), "format", "--check"]),
    ("Ruff", [os.path.join(LINT, "ruff"), "check"]),
    ("mypy", [os.path.join(LINT, "mypy"), "--python-version", TYPED_PYTHON]),
]
PAGE_STEPS = [
    ("Biome", ["pnpm", "exec", "biome", "ci", "--error-on-warnings"]),
    ("TypeScript", ["node", "node_modules/typescript-7/bin/tsc", "-p", "tsconfig.json"]),
    ("page suite and coverage", ["node", "--test", *NODE_COVERAGE, "tests/*.test.mjs"]),
]


def installed(program):
    try:
        said = subprocess.run([program, "--version"], check=False, capture_output=True, text=True).stdout
    except FileNotFoundError:
        return "not installed"
    found = VERSION.search(said)
    return found.group() if found else said.strip()


def toolchain():
    found = {program: installed(program) for program in TOOLCHAIN}
    wrong = [
        f"{program} is {found[program]}, pinned {pin}" for program, pin in TOOLCHAIN.items() if found[program] != pin
    ]
    if wrong:
        print(f"FAIL toolchain: {'; '.join(wrong)} (AGENTS.md says how to move a pin)")
        return False
    print("ok   toolchain")
    return True


def run(name, command):
    try:
        done = subprocess.run(command, check=False, cwd=ROOT, capture_output=True, text=True)
    except FileNotFoundError:
        print(f"FAIL {name}: {command[0]} is not installed")
        return False
    if done.returncode == 0:
        print(f"ok   {name}")
        return True
    print(f"FAIL {name}\n{done.stdout}{done.stderr}")
    return False


def install(name, minor):
    venv = os.path.join(TOOLS, name)
    made = os.path.isdir(venv) or run(f"{name} tools' environment", ["uv", "venv", "-q", *interpreter(minor), venv])
    lock = os.path.join(LOCKS, f"{name}.txt")
    python_bin = os.path.join(venv, "bin", "python")
    return made and run(f"{name} tools", ["uv", "pip", "sync", "-q", "--require-hashes", "--python", python_bin, lock])


def tools():
    return [
        pythons(*minors(), COVERAGE_PYTHON),
        install("lint", COVERAGE_PYTHON),
        run("page tools", ["pnpm", "install", "--frozen-lockfile"]),
    ]


def python(minor):
    return ["uv", "run", "--no-project", *interpreter(minor), "python"]


def interpreter(minor):
    return ["--managed-python", "--python", minor]


def pythons(*minors):
    return run(f"Python {', '.join(minors)} at their latest patch", ["uv", "python", "install", "--upgrade", *minors])


def patch(minor):
    said = subprocess.run(
        [*python(minor), "-c", "import platform; print(platform.python_version())"],
        check=False,
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    return said.stdout.strip() or minor


def minors():
    first, last = (int(version.split(".")[1]) for version in (MIN_PYTHON, COVERAGE_PYTHON))
    return [f"3.{minor}" for minor in range(first, last)]


def suites():
    unittest = ["-W", "error", "-m", "unittest", "discover", "-s", "tests", "-q"]
    return [
        *(run(f"Python {patch(minor)} suite", [*python(minor), *unittest]) for minor in minors()),
        run(
            f"Python {patch(COVERAGE_PYTHON)} suite and coverage",
            [*python(COVERAGE_PYTHON), "-W", "error", "tests/report_coverage.py"],
        ),
    ]


def smoke(minor):
    on = f"on Python {patch(minor)}"
    with tempfile.TemporaryDirectory() as out:
        if not run(f"package built {on}", ["uv", "build", *interpreter(minor), "--wheel", "--out-dir", out]):
            return False
        wheel = glob.glob(os.path.join(out, "*.whl"))[0]
        uvx = ["uvx", "--isolated", *interpreter(minor), "--from", wheel]
        ran = [run(f"{' '.join(command)}, installed {on}", [*uvx, *command]) for command in COMMANDS]
        return all(ran)


def install_hook():
    inside = subprocess.run(
        ["git", "rev-parse", "--is-inside-work-tree"], check=False, cwd=ROOT, capture_output=True, text=True
    )
    hooks = subprocess.run(["git", "config", "core.hooksPath"], check=False, cwd=ROOT, capture_output=True, text=True)
    if inside.stdout.strip() == "true" and hooks.stdout.strip() != HOOKS:
        subprocess.run(["git", "config", "core.hooksPath", HOOKS], cwd=ROOT, check=True)
        print(f"hook installed: git runs {HOOKS}/pre-commit before each commit")


def main():
    try:
        install_hook()
    except OSError:
        print("FAIL hook: git is not installed")
    passed = [
        toolchain(),
        *tools(),
        *(run(name, command) for name, command in PYTHON_STEPS),
        *suites(),
        *(run(name, command) for name, command in PAGE_STEPS),
        *(smoke(minor) for minor in (MIN_PYTHON, COVERAGE_PYTHON)),
    ]
    sys.exit(0 if all(passed) else 1)


if __name__ == "__main__":
    main()
