#!/usr/bin/env python3
"""Mutation testing, run now and then rather than before each commit (AGENTS.md § How to verify changes says why).

`python3 tests/mutate.py` runs mutmut over the package (pyproject.toml) and lists the mutants no test killed;
`python3 tests/mutate.py js` runs StrykerJS over the page's JS (stryker.config.json), which takes about an hour. The
tools come locked, as the gate's do (check.py says how): mutmut, with the pytest it runs and the gate's own mypy,
which type-checks each mutant, from tests/tools/mutation.txt into .tools/mutation, on MUTMUT_PYTHON; StrykerJS from
package.json. StrykerJS reads tsconfig.json through TypeScript's JavaScript API, which TypeScript 7, the gate's, no
longer ships, so package.json keeps `typescript` on 6, the last line that has it.
"""

import os
import subprocess
import sys

from check import ROOT, TOOLS, install, run

MUTMUT_PYTHON = "3.12"


def python_round():
    if not install("mutation", MUTMUT_PYTHON):
        return 1
    tools = os.path.join(TOOLS, "mutation", "bin")
    env = {**os.environ, "no_proxy": "*", "PATH": os.pathsep.join([tools, os.environ.get("PATH", "")])}
    mutmut = os.path.join(tools, "mutmut")
    done = subprocess.run([mutmut, "run"], cwd=ROOT, env=env, check=False)
    subprocess.run([mutmut, "results"], cwd=ROOT, env=env, check=False)
    return done.returncode


def js_round():
    if not run("page tools", ["pnpm", "install", "--frozen-lockfile"]):
        return 1
    return subprocess.run(["pnpm", "exec", "stryker", "run"], cwd=ROOT, check=False).returncode


def main():
    sys.exit(js_round() if sys.argv[1:] == ["js"] else python_round())


if __name__ == "__main__":
    main()
