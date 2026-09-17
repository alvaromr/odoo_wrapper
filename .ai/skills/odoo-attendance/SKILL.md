---
name: odoo-attendance
description: Clock in and out of Odoo ERP from the terminal, start or end a break, check the current attendance state and read the history. Use when the user asks to clock in, clock out, take a break, come back from a break, check whether they are clocked in, or review logged work hours.
---

# Odoo Attendance

The launcher is `bin/odoo` at the root of the repo this skill lives in (`.ai/skills/odoo-attendance/`). Run
it with no arguments for the commands, the files and what clocks for real. Inside the repo that is
`python3 bin/odoo`; from any other project, through the symlink in `~/.claude/skills/`:

```bash
python3 "$(dirname "$(readlink -f ~/.claude/skills/odoo-attendance)")/../../bin/odoo"
```

- **Confirm with the user before `checkin`, `checkout`, `toggle`, `break` or `resume`**: they register real
  punches in Odoo. A break is `break`, never `checkout`; coming back is `resume`, never `checkin`.
- If it answers `Ejecuta: odoo login`, ask the user to run `bin/odoo login` in their own terminal — it prompts
  for the password and cannot be driven by an agent.
