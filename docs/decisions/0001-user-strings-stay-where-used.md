# The strings the user reads stay where they are used

- **Status:** accepted, approved by the owner on 2026-11-03.
- **Practice departed from:** with one language, keep each module's user-facing strings together.
- **Value not at stake:** changeability. Each message is written whole, never pieced from fragments, so moving them
  out for a second language stays mechanical.

The tool speaks only Spanish (AGENTS.md, Hard rules, 6), so gathering the strings would be indirection with nothing to
swap, and a message is read best beside the code that shows it. A constant holds one only when that reads better or it
repeats (AGENTS.md, How to verify changes).
