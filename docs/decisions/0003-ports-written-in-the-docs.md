# The dashboard's ports are written in the docs

- **Status:** accepted, approved by the owner on 2026-11-03.
- **Practice departed from:** docs point to a configuration value instead of restating it.
- **Value not at stake:** changeability. The ports are constants (`PORT` in `server.py`, `TLS_PORT` in `lan.py`) that have
  not changed since the first release, and a search for the number finds every copy.

README.md tells whoever installs the tool which address to open, and AGENTS.md gives commands to paste: both are
read to be followed, and a pointer to a constant would leave each reader to look the number up first.
