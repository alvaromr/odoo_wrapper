---
name: odoo-attendance
description: Clock in and out of Odoo ERP from the terminal, start or end a break, check the current attendance state and read the history. Use when the user asks to clock in, clock out, take a break, come back from a break, check whether they are clocked in, or review logged work hours.
---

# Odoo Attendance

The command is `odoo`, on the PATH once installed. Run it with no arguments for the commands, the files and
what clocks for real. Inside the odoo_wrapper repo itself, `python3 bin/odoo` runs the working copy instead.
If `odoo` is not found, it is not installed on this machine: the README of
https://github.com/alvaromr/odoo_wrapper says how.

- **Confirm with the user before `checkin`, `checkout`, `toggle`, `break` or `resume`**: they register real
  punches in Odoo. A break is `break`, never `checkout`; coming back is `resume`, never `checkin`.
- If it answers `Ejecuta: odoo login`, ask the user to run `odoo login` in their own terminal — it prompts
  for the password and cannot be driven by an agent.
