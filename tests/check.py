#!/usr/bin/env python3
"""The gate: every check AGENTS.md § How to verify changes asks for, in one command that fails if any fails.

`python3 tests/check.py` runs Ruff (format and lint), mypy (strict types, for TYPED_PYTHON: mypy 2 checks for 3.10
or newer only, so what 3.9 lacks is caught by the next step, which runs every line on 3.9), the Python suite on the
oldest Python the package supports (MIN_PYTHON, read from .python-version, which pyproject.toml's requires-python
must match; Ruff
takes its target from requires-python itself), the same suite measuring every line and branch on COVERAGE_PYTHON
(branches need 3.14), Biome over the page's JS and CSS and the JS tests (format, lint and import order, as
biome.jsonc sets), TypeScript checking the page's JS against its JSDoc types in strict mode (tsconfig.json), and the
page's suite with its coverage. First it checks that node, pnpm and uv are the versions TOOLCHAIN pins, so every
machine runs the gate the same way. Every step runs even after one fails, so a single run lists everything to fix.
The pre-commit hook (.githooks/pre-commit) runs it
before each commit, and the gate installs that hook itself (git's core.hooksPath) the first time it runs in a
clone, so no clone goes without it.

The tools come at the versions pinned here: uvx for Ruff and mypy, `uv run` for each Python, `pnpm dlx` for
Biome and TypeScript. Nothing is
installed in the repo and nothing reaches the package, whose only requirement is still Python's standard
library (AGENTS.md, rule 1). Mutation testing is not part of it: it takes minutes (AGENTS.md says how to run it).
"""

import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOOKS = ".githooks"
RUFF = "ruff@0.17.3"
MYPY = "mypy@2.4.0"
TYPED_PYTHON = "3.10"
BIOME = "@biomejs/biome@2.6.3"
TYPESCRIPT = "typescript@7.0.2"
with open(os.path.join(ROOT, ".python-version")) as pinned:
    MIN_PYTHON = pinned.read().strip()
COVERAGE_PYTHON = "3.14"
TOOLCHAIN = {"node": "26.13.0", "pnpm": "12.16.1", "uv": "0.13.6"}
VERSION = re.compile(r"\d+\.\d+\.\d+")
NODE_COVERAGE = [
    "--experimental-test-coverage",
    "--test-coverage-include=src/**",
    "--test-coverage-lines=100",
    "--test-coverage-branches=100",
    "--test-coverage-functions=100",
]
STEPS = [
    ("Ruff format", ["uvx", RUFF, "format", "--check"]),
    ("Ruff", ["uvx", RUFF, "check"]),
    ("mypy", ["uvx", MYPY, "--python-version", TYPED_PYTHON]),
    (
        f"Python {MIN_PYTHON} suite",
        ["uv", "run", "--no-project", "--python", MIN_PYTHON, "-m", "unittest", "discover", "-s", "tests", "-q"],
    ),
    ("Python coverage", ["uv", "run", "--no-project", "--python", COVERAGE_PYTHON, "tests/report_coverage.py"]),
    ("Biome", ["pnpm", "dlx", BIOME, "ci"]),
    ("TypeScript", ["pnpm", f"--package={TYPESCRIPT}", "dlx", "tsc", "-p", "tsconfig.json"]),
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
    passed = [toolchain(), *(run(name, command) for name, command in STEPS)]
    sys.exit(0 if all(passed) else 1)


if __name__ == "__main__":
    main()
