#!/usr/bin/env python3
"""Publish the release of what main holds (AGENTS.md § Releasing says when and why).

`python3 tests/release.py` checks that HEAD is main, the tree clean, main pushed as it is, the version in
src/odoo_wrapper/__init__.py not tagged yet, here or on GitHub, and the gate green; then it tags HEAD vX.Y.Z, pushes
the tag and creates the GitHub release, with notes generated from the changes since the last one. `--dry-run` runs
the checks and prints the three commands instead of running them. Every check comes before anything is published,
so a refusal leaves no tag behind: a tag is never moved or reused.
"""

import os
import re
import subprocess
import sys

from check import ROOT

VERSION_FILE = os.path.join(ROOT, "src", "odoo_wrapper", "__init__.py")
VERSION = re.compile(r'^__version__ = "(\d+\.\d+\.\d+)"$', re.MULTILINE)


def git(*args):
    return subprocess.run(["git", *args], cwd=ROOT, check=False, capture_output=True, text=True).stdout.strip()


def version():
    with open(VERSION_FILE) as source:
        return VERSION.search(source.read()).group(1)


def refusal(tag):
    if git("rev-parse", "--abbrev-ref", "HEAD") != "main":
        return "HEAD is not main"
    if git("status", "--porcelain"):
        return "the tree has uncommitted changes"
    git("fetch", "origin", "main", "--tags")
    if git("rev-parse", "HEAD") != git("rev-parse", "origin/main"):
        return "main is not pushed as it is: git push origin main first"
    if git("tag", "--list", tag) or git("ls-remote", "--tags", "origin", f"refs/tags/{tag}"):
        return f"{tag} exists already: raise __version__ in {os.path.relpath(VERSION_FILE, ROOT)}"
    if subprocess.run([sys.executable, os.path.join(ROOT, "tests", "check.py")], cwd=ROOT, check=False).returncode:
        return "the gate fails"
    return ""


def main():
    tag = f"v{version()}"
    why = refusal(tag)
    if why:
        print(f"No release: {why}.")
        sys.exit(1)
    commands = [
        ["git", "tag", "-a", tag, "-m", tag, git("rev-parse", "HEAD")],
        ["git", "push", "origin", tag],
        ["gh", "release", "create", tag, "--verify-tag", "--generate-notes"],
    ]
    for command in commands:
        print("$", " ".join(command), flush=True)
        if "--dry-run" not in sys.argv[1:]:
            subprocess.run(command, cwd=ROOT, check=True)


if __name__ == "__main__":
    main()
