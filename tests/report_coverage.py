#!/usr/bin/env python3
"""Run the unit tests under the stdlib tracer and report line coverage of the package.

Exits 1 when a test fails or any line of src/odoo_wrapper stays unexecuted, so the
missing lines are always the whole story: no pragmas, no exclusions.

Nothing is handed to the tracer as ignoredirs on purpose: trace caches its ignore decision by the file's
bare module name, so once the stdlib's http/client.py and http/server.py are ignored, this package's
client.py and server.py are ignored too and report 0 % (seen on Python 3.9). Tracing everything costs
under a second more.
"""

import dis
import os
import sys
import trace
import unittest

TESTS = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(os.path.dirname(TESTS), "src")
PACKAGE = os.path.join(SRC, "odoo_wrapper")
sys.path.insert(0, SRC)


def executable_lines(path):
    with open(path) as f:
        pending = [compile(f.read(), path, "exec")]
    lines = set()
    while pending:
        code = pending.pop()
        lines.update(line for _, line in dis.findlinestarts(code) if line)
        pending.extend(const for const in code.co_consts if hasattr(const, "co_code"))
    return lines


def ranges(lines):
    groups = []
    for line in lines:
        if groups and line == groups[-1][1] + 1:
            groups[-1][1] = line
        else:
            groups.append([line, line])
    return ", ".join(str(a) if a == b else f"{a}-{b}" for a, b in groups)


def run_tests():
    suite = unittest.defaultTestLoader.discover(TESTS)
    return unittest.TextTestRunner(verbosity=0).run(suite)


def main():
    tracer = trace.Trace(count=1, trace=0)
    result = tracer.runfunc(run_tests)
    hits = {}
    for (path, line), _ in tracer.results().counts.items():
        hits.setdefault(path, set()).add(line)
    complete = result.wasSuccessful()
    for name in sorted(os.listdir(PACKAGE)):
        if not name.endswith(".py"):
            continue
        path = os.path.join(PACKAGE, name)
        lines = executable_lines(path)
        if not lines:
            continue
        missed = sorted(lines - hits.get(path, set()))
        percent = 100 * (len(lines) - len(missed)) / len(lines)
        print(f"{name:14} {percent:5.1f} %" + (f"  sin ejecutar: {ranges(missed)}" if missed else ""))
        complete = complete and not missed
    sys.exit(0 if complete else 1)


if __name__ == "__main__":
    main()
