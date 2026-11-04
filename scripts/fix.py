#!/usr/bin/env python3
"""The gate's companion: fixes what the tools can fix by themselves, then runs the gate.

`python3 scripts/fix.py` formats the Python with Ruff and applies its safe fixes, lets Biome format the page, apply
its safe fixes and sort its imports, and then runs scripts/check.py, whose verdict and exit code it hands on. What
is left for a person is what the gate still lists. The tools and their versions are the gate's own.
"""

import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import check  # noqa: E402 - a sibling script, importable once its folder is on the path

FIXES = [
    [os.path.join(check.LINT, "ruff"), "format"],
    [os.path.join(check.LINT, "ruff"), "check", "--fix"],
    ["pnpm", "exec", "biome", "check", "--write"],
]


def main():
    """Install the gate's tools, run every fixer, quietly, then the gate."""
    check.tools()
    for command in FIXES:
        subprocess.run(command, check=False, cwd=check.ROOT, capture_output=True)
    check.main()


if __name__ == "__main__":
    main()
