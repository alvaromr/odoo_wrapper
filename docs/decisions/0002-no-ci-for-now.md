# No CI for now

- **Status:** accepted, decided by the owner on 2026-11-03, for now.
- **Practice departed from:** a CI that runs the gate on every push, on each operating system the tools support.
- **Value not at stake:** correctness on macOS, where the tools are developed and used daily. The repo has one
  developer, and the pre-commit hook runs the whole gate before every commit (AGENTS.md, How to verify changes).

What stays uncovered is Linux and Windows: they are checked by reading the code and by users' reports (AGENTS.md,
Known limitations). Revisit when someone else commits to the repo, or when a report from Linux or Windows finds a
fault the gate on macOS could not.
