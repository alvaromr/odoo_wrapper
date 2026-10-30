#!/usr/bin/env python3
"""The gate's companion: fixes what the tools can fix by themselves, then runs the gate.

`python3 tests/fix.py` formats the Python with Ruff and applies its safe fixes, lets Biome format the page, apply
its safe fixes and sort its imports, and then runs tests/check.py, whose verdict and exit code it hands on. What
is left for a person is what the gate still lists. The tools and their versions are the gate's own.
"""

import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import check  # noqa: E402 - a sibling script, importable once its folder is on the path

FIXES = [
    ["uvx", check.RUFF, "format"],
    ["uvx", check.RUFF, "check", "--fix"],
    ["pnpm", "dlx", check.BIOME, "check", "--write"],
]


def main():
    """Run every fixer, quietly, then the gate."""
    for command in FIXES:
        subprocess.run(command, check=False, cwd=check.ROOT, capture_output=True)
    check.main()


if __name__ == "__main__":
    main()
