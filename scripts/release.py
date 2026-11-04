#!/usr/bin/env python3
"""Ship what dev holds: push it, install it from GitHub, move main to it and publish its release (AGENTS.md §
Releasing says when and why).

`python3 scripts/release.py` checks that HEAD is dev, the tree clean, main behind dev so it moves forward without a
merge, the version in src/odoo_wrapper/__init__.py not tagged yet, here or on GitHub, its section in CHANGELOG.md
written, and the gate green. Then it pushes dev and installs that commit from GitHub as users install it (the source
updates.py names, through uv, isolated from any install of the machine) on the oldest and the newest Python, and
runs its two commands; only if they run does it push dev to main, move the local main along, tag the commit vX.Y.Z,
push the tag and create the GitHub release with that section as its notes: the dashboards' «Novedades» link opens
them, so users read what the changelog says. Its wrapped lines are joined, as GitHub breaks a release's lines where
the source does. Each step runs only if the one before it worked, and a failure says what is already done.
`--dry-run` runs the checks and prints the commands and the notes instead of running them. Every check comes before
anything leaves the machine, and dev is the only thing pushed before the install from GitHub has run, so a refusal
or a failed install leaves main and the tags as they were: a tag is never moved or reused.
"""

import os
import re
import subprocess
import sys

from check import COMMANDS, COVERAGE_PYTHON, MIN_PYTHON, ROOT, interpreter

sys.path.insert(0, os.path.join(ROOT, "src"))
from odoo_wrapper.updates import SOURCE  # noqa: E402 - found only once src is on the path

BRANCH = "dev"
VERSION_FILE = os.path.join(ROOT, "src", "odoo_wrapper", "__init__.py")
VERSION = re.compile(r'^__version__ = "(\d+\.\d+\.\d+)"$', re.MULTILINE)
CHANGELOG = os.path.join(ROOT, "CHANGELOG.md")
GATE = [sys.executable, os.path.join(ROOT, "scripts", "check.py")]


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
        (lambda: git("rev-parse", "--abbrev-ref", "HEAD") != BRANCH, f"HEAD is not {BRANCH}"),
        (lambda: git("status", "--porcelain"), "the tree has uncommitted changes"),
        (
            lambda: git("merge-base", "origin/main", "HEAD") != git("rev-parse", "origin/main"),
            f"main holds commits {BRANCH} lacks: bring them into {BRANCH} first",
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
    commit = git("rev-parse", "HEAD")
    uvx = ["uvx", "--isolated", "--from", f"{SOURCE}@{commit}"]
    commands = [
        ["git", "push", "origin", BRANCH],
        *([*uvx, *interpreter(minor), *command] for minor in (MIN_PYTHON, COVERAGE_PYTHON) for command in COMMANDS),
        ["git", "push", "origin", f"{BRANCH}:main"],
        ["git", "branch", "--force", "main", BRANCH],
        ["git", "tag", "-a", tag, "-m", tag, commit],
        ["git", "push", "origin", tag],
        ["gh", "release", "create", tag, "--verify-tag", "--notes-file", "-"],
    ]
    dry = "--dry-run" in sys.argv[1:]
    for command in commands:
        print("$", " ".join(command), flush=True)
        if not dry and subprocess.run(command, cwd=ROOT, check=False, input=said, text=True).returncode:
            print("Stopped: that command failed; every command above it is done.")
            sys.exit(1)
    if dry:
        print(f"\nNotes:\n{said}")


if __name__ == "__main__":
    main()
