#!/usr/bin/env python3
"""Run the unit tests under the stdlib tracer and report line and branch coverage of the package.

Exits 1 when a test fails, any line of src/odoo_wrapper stays unexecuted or any branch is never taken one way,
so the missing lines and branches are always the whole story: no pragmas, no exclusions.

Branches need Python 3.14 (code.co_branches lists every branch, sys.monitoring's BRANCH_LEFT and
BRANCH_RIGHT say which way each one went); on an older Python only lines are measured, and the report says so.
A branch is named by its line and the line it goes to («42→45»). As in coverage.py, only a branch whose two
ways both leave its line counts: an if, a while or an elif, not a conditional inside one line («a if c else
b», a comprehension's filter) nor what the compiler adds on its own (a with block's exception exit, an except
clause that does not match, a for loop's end).

Nothing is handed to the tracer as ignoredirs on purpose: trace caches its ignore decision by the file's
bare module name, so once the stdlib's http/client.py and http/server.py are ignored, this package's
client.py and server.py are ignored too and report 0 % (seen on Python 3.9). Tracing everything costs
under a second more.
"""

import dis
import os
import sys
import trace
import types
import unittest

TESTS = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(os.path.dirname(TESTS), "src")
PACKAGE = os.path.join(SRC, "odoo_wrapper")
sys.path.insert(0, SRC)
BRANCHES = hasattr(types.CodeType, "co_branches")


def executable_lines(path):
    with open(path) as f:
        pending = [compile(f.read(), path, "exec")]
    lines = set()
    while pending:
        code = pending.pop()
        lines.update(line for _, line in dis.findlinestarts(code) if line)
        pending.extend(const for const in code.co_consts if hasattr(const, "co_code"))
    return lines


def code_objects(path):
    with open(path) as f:
        pending = [compile(f.read(), path, "exec")]
    while pending:
        code = pending.pop()
        yield code
        pending.extend(const for const in code.co_consts if isinstance(const, types.CodeType))


def code_key(code):
    return code.co_qualname, code.co_firstlineno


def line_at(code, offset):
    return next(line for start, end, line in code.co_lines() if start <= offset < end)


def branch_arcs(path):
    arcs = {}
    for code in code_objects(path):
        for src, left, right in code.co_branches():
            line = line_at(code, src)
            ways = {dest: line_at(code, dest) for dest in (left, right)}
            if line not in ways.values():
                arcs.update({(code_key(code), src, dest): (line, to) for dest, to in ways.items()})
    return arcs


def watch_branches():
    monitoring = sys.monitoring
    tool = monitoring.COVERAGE_ID
    monitoring.use_tool_id(tool, "report_coverage")
    taken = {}

    def on_branch(code, src, dest):
        if code.co_filename.startswith(PACKAGE):
            taken.setdefault(code.co_filename, set()).add((code_key(code), src, dest))
        return monitoring.DISABLE

    for event in (monitoring.events.BRANCH_LEFT, monitoring.events.BRANCH_RIGHT):
        monitoring.register_callback(tool, event, on_branch)
    monitoring.set_events(tool, monitoring.events.BRANCH_LEFT | monitoring.events.BRANCH_RIGHT)
    return taken


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
    taken = watch_branches() if BRANCHES else {}
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
        report = f"{name:14} {percent:5.1f} %"
        arcs = branch_arcs(path) if BRANCHES else {}
        untaken = sorted({arcs[a] for a in arcs.keys() - taken.get(path, set())})
        if arcs:
            report += f"  ramas {100 * (len(arcs) - len(untaken)) / len(arcs):5.1f} %"
        if missed:
            report += f"  sin ejecutar: {ranges(missed)}"
        if untaken:
            report += "  ramas sin tomar: " + ", ".join(f"{a}→{b}" for a, b in untaken)
        print(report)
        complete = complete and not missed and not untaken
    if not BRANCHES:
        print("ramas: sin medir, hace falta Python 3.14")
    sys.exit(0 if complete else 1)


if __name__ == "__main__":
    main()
