# /parity:report

Build a stakeholder-facing HTML report from a migration: either a **deck**
(lateral scroll, one topic per page, for the working team) or a **one-pager**
(single vertical page, for an executive).

Load `skills/stakeholder-report/SKILL.md`. It carries the design kit, the deck
shell, the page components, and — the part that matters most — the evidence and
editorial rules that keep the report defensible.

Route every shell command through `runner`. The report is a build artifact:
generate it from a script so it can be regenerated when a number changes, never
hand-edit the HTML.

Arguments:
- `--shape deck|onepager` — output shape (default: `deck`)
- `--out <path>` — destination `.html` (default: `docs/<site>-report.html`)
- `--from <dir>` — parity output dir to read `report.json` from
- `--before <ref>` + `--after <ref>` — git refs for a before/after capture pass
- `--audience team|exec` — sets depth and tone (`exec` implies `--shape onepager`)

## Before you generate

Three questions decide the whole report. Ask them if the user has not answered:

1. **Which comparison?** `prod × candidate` (is the migration faithful?) or
   `candidate-then × candidate-now` (what did we improve?). They tell different
   stories and need different pages. Both is fine; one page each.
2. **Which window?** Filter by the team's own authorship and start from the
   engagement date, not the repo's first commit. A repo older than the
   engagement will inflate every "how long / how much" number.
3. **What is not measured yet?** Anything in flight gets labelled as such. A
   pending number presented as a result is the fastest way to lose the room.
