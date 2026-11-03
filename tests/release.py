#!/usr/bin/env python3
"""Publish the release of what main holds (AGENTS.md § Releasing says when and why).

`python3 tests/release.py` checks that HEAD is main, the tree clean, main pushed as it is, the version in
src/odoo_wrapper/__init__.py not tagged yet, here or on GitHub, its section in CHANGELOG.md written, and the gate
green; then it tags HEAD vX.Y.Z, pushes the tag and creates the GitHub release with that section as its notes: the
dashboards' «Novedades» link opens them, so users read what the changelog says. Its wrapped lines are joined, as
GitHub breaks a release's lines where the source does. `--dry-run` runs the checks and
prints the three commands and the notes instead of running them. Every check comes before anything is published,
so a refusal leaves no tag behind: a tag is never moved or reused.
"""

import os
import re
import subprocess
import sys

from check import ROOT

VERSION_FILE = os.path.join(ROOT, "src", "odoo_wrapper", "__init__.py")
VERSION = re.compile(r'^__version__ = "(\d+\.\d+\.\d+)"$', re.MULTILINE)
CHANGELOG = os.path.join(ROOT, "CHANGELOG.md")
GATE = [sys.executable, os.path.join(ROOT, "tests", "check.py")]


def git(*args):
    return subprocess.run(["git", *args], cwd=ROOT, check=False, capture_output=True, text=True).stdout.strip()


def version():
    with open(VERSION_FILE) as source:
        return VERSION.search(source.read()).group(1)


def notes(number):
    with open(CHANGELOG) as source:
        found = re.search(
            rf"^## \[{re.escape(number)}\][^\n]*\n(.*?)(?=^## \[|^\[|\Z)", source.read(), re.MULTILINE | re.DOTALL
        )
    return re.sub(r"\n +", " ", found.group(1).strip()) if found else ""


def refusal(tag, said):
    git("fetch", "origin", "main", "--tags")
    checks = [
        (lambda: git("rev-parse", "--abbrev-ref", "HEAD") != "main", "HEAD is not main"),
        (lambda: git("status", "--porcelain"), "the tree has uncommitted changes"),
        (
            lambda: git("rev-parse", "HEAD") != git("rev-parse", "origin/main"),
            "main is not pushed as it is: git push origin main first",
        ),
        (
            lambda: git("tag", "--list", tag) or git("ls-remote", "--tags", "origin", f"refs/tags/{tag}"),
            f"{tag} exists already: raise __version__ in {os.path.relpath(VERSION_FILE, ROOT)}",
        ),
        (lambda: not said, f"CHANGELOG.md has no section for {tag[1:]}: write it first"),
        (lambda: subprocess.run(GATE, cwd=ROOT, check=False).returncode, "the gate fails"),
    ]
    return next((why for failed, why in checks if failed()), "")


def main():
    number = version()
    tag = f"v{number}"
    said = notes(number)
    why = refusal(tag, said)
    if why:
        print(f"No release: {why}.")
        sys.exit(1)
    commands = [
        ["git", "tag", "-a", tag, "-m", tag, git("rev-parse", "HEAD")],
        ["git", "push", "origin", tag],
        ["gh", "release", "create", tag, "--verify-tag", "--notes-file", "-"],
    ]
    dry = "--dry-run" in sys.argv[1:]
    for command in commands:
        print("$", " ".join(command), flush=True)
        if not dry:
            subprocess.run(command, cwd=ROOT, check=True, input=said, text=True)
    if dry:
        print(f"\nNotes:\n{said}")


if __name__ == "__main__":
    main()
