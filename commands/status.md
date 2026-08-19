# /parity:status

Show the current phase and score of the active migration.

Read `.parity/migration.json` from the current directory or any parent.
Report: phase, round, source.kind, target.name, parity.lastScore, component
counts (done / pending / total), and the last 3 open `parity-migrate` issues
(via `gh issue list --label parity-migrate --limit 3`). Route the gh call
through `runner`.
