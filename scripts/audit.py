#!/usr/bin/env python3
"""The audit of the tools' locks against known vulnerabilities, run now and then and by release.py before it ships.

`python3 scripts/audit.py` asks pnpm about every package pnpm-lock.yaml holds, and pip-audit about every package the
locks in scripts/tools/ hold, its own lock included, and fails if either knows of a vulnerability. None of those
packages reaches users (AGENTS.md, rule 1), but they run on the machine of whoever works on the repo, with their
rights; the release age the locks wait for keeps a fresh compromised release out, not one found bad later. pip-audit
comes locked, as the gate's tools do (check.py says how): from scripts/tools/audit.txt into .tools/audit, on
COVERAGE_PYTHON. It reads each lock as it is, with its hashes, and installs nothing from it (--disable-pip), one lock
at a time: pip-audit refuses a package that two of its requirement files pin differently, and the locks share some.
Both ask the network: pnpm the npm registry, pip-audit the PyPI advisory database.
"""

import glob
import os
import sys

from check import COVERAGE_PYTHON, LOCKS, TOOLS, install, pythons, run


def python_locks():
    if not (pythons(COVERAGE_PYTHON) and install("audit", COVERAGE_PYTHON)):
        return [False]
    audit = [os.path.join(TOOLS, "audit", "bin", "pip-audit"), "--require-hashes", "--disable-pip", "-r"]
    locks = sorted(glob.glob(os.path.join(LOCKS, "*.txt")))
    return [run(f"scripts/tools/{os.path.basename(lock)}", [*audit, lock]) for lock in locks]


def main():
    done = [*python_locks(), run("pnpm-lock.yaml", ["pnpm", "audit"])]
    sys.exit(0 if all(done) else 1)


if __name__ == "__main__":
    main()
