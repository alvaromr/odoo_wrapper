#!/usr/bin/env python3
"""Mutation testing, run now and then rather than before each commit (AGENTS.md § How to verify changes says why).

`python3 tests/mutate.py` runs mutmut over the package (pyproject.toml) and lists the mutants no test killed;
`python3 tests/mutate.py js` runs StrykerJS over the page's JS (stryker.config.json), which takes about an hour. The
tools come at the versions pinned here, and mutmut type-checks each mutant with the gate's own mypy (check.py).
"""

import os
import subprocess
import sys

from check import MYPY, ROOT, TYPESCRIPT

MUTMUT = "mutmut@3.8.1"
MUTMUT_PYTEST = "pytest==9.2.0"
MUTMUT_PYTHON = "3.12"
STRYKER = "@stryker-mutator/core@10.1.1"


def python_round():
    env = {**os.environ, "no_proxy": "*"}
    mutmut = ["uvx", "--python", MUTMUT_PYTHON, "--with", MUTMUT_PYTEST, "--with", MYPY.replace("@", "=="), MUTMUT]
    done = subprocess.run([*mutmut, "run"], cwd=ROOT, env=env, check=False)
    subprocess.run([*mutmut, "results"], cwd=ROOT, env=env, check=False)
    return done.returncode


def js_round():
    command = ["pnpm", f"--package={STRYKER}", f"--package={TYPESCRIPT}", "dlx", "stryker", "run"]
    return subprocess.run(command, cwd=ROOT, check=False).returncode


def main():
    sys.exit(js_round() if sys.argv[1:] == ["js"] else python_round())


if __name__ == "__main__":
    main()
