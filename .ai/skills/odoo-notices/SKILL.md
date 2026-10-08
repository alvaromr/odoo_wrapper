---
name: odoo-notices
description: Bring the attendance warnings spreadsheet (Google Sheets, «Control Avisos - Fichajes») up to date from Odoo, appending every employee's punch errors and attendance change requests to «Avisos <año>» and, once a month, each employee's count to «Avisos Totales». Use when the user asks to update or fill the warnings sheet (hoja de avisos, avisos de fichajes, avisos totales), or to get a machine ready for it.
---

# Odoo Notices

One command does all of it and needs no agent: `python3 bin/odoo notices`. Run `bin/odoo` with no arguments for
what it adds and when; the `odoo-attendance` skill, next to this one, says where the launcher is from another
project.

- **It writes to the real spreadsheet the moment it runs.** Run it when the user asks for the sheet to be
  updated, not to find something out, and report the lines it prints.
- **It only appends, and so do you.** Never edit the sheet any other way to complete or correct it: what people
  changed there by hand is meant to stay as they left it.
- `No hay hoja de avisos guardada`: ask the user for the spreadsheet's URL and save it with
  `python3 bin/odoo sheet "<URL>"`. It is remembered from then on; the same command changes it.
- `Ejecuta: odoo login`: as the `odoo-attendance` skill says.
- Any other `ERROR:`, or a machine where it has never run: `SETUP.md`, next to this file, lists what the
  machine needs on each operating system and what each error asks for.
