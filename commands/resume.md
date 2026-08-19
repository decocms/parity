# /parity:resume

Continue an interrupted migration — the common case, since a full run spans many
turns and sessions get cut off mid-phase.

## Trigger

1. Read `.parity/migration.json` from the current directory or any parent.
   - If none is found, tell the user there's nothing to resume and point them at
     `/parity:migrate`. Stop.
2. Load `skills/migration-orchestrator/SKILL.md`.
3. Re-enter the phase machine at the **current** `phase` (the last one that was
   in progress) and carry on — no "resume from <phase>?" question, just continue.
   Unlike `/parity:migrate`, this assumes the user already committed to the run.
4. Report what phase you resumed at and the next action before doing it.

## Notes

- Mid-phase state (`round`, `components[].status`, `parity.lastScore`) is the
  source of truth — trust it over re-deriving. Only re-run a phase's work for
  components/issues still marked `pending`/open.
- Every bash call still goes through the `runner` agent.
