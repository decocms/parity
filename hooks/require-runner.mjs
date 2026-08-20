#!/usr/bin/env node
// PreToolUse(Bash) gate for the migration orchestrator.
//
// The orchestrator must never run bash directly — every command goes through
// the `runner` subagent (Task tool). This hook enforces that, but ONLY in the
// narrow case where it matters, so the plugin stays invisible everywhere else:
//
//   - Inside any subagent (runner/porter/fixer/builder…) → ALLOW. Those agents
//     legitimately run bash; Claude Code sets `agent_type` when a hook fires in
//     a subagent, absent on the main thread.
//   - Main thread, no active migration in the cwd tree → ALLOW. Unrelated
//     sessions that merely have the plugin enabled are never touched.
//   - Main thread + active migration (`.parity/migration.json`, phase != done)
//     → DENY, telling the model to dispatch via subagent_type:"runner".
//
// Fails OPEN on any error (bad JSON, missing node features, unreadable state):
// a migration gate must never be able to wedge a user's shell.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const allow = () => process.exit(0);

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  allow();
}

// In a subagent, bash is expected — that's the whole point of the runner.
if (input.agent_type) allow();

// Walk up from cwd for an active migration state file.
let dir = input.cwd || process.cwd();
let state = null;
while (dir && dir !== dirname(dir)) {
  const candidate = join(dir, ".parity", "migration.json");
  if (existsSync(candidate)) {
    state = candidate;
    break;
  }
  dir = dirname(dir);
}
if (!state) allow();

let phase;
try {
  phase = JSON.parse(readFileSync(state, "utf8")).phase;
} catch {
  allow();
}
if (!phase || phase === "done") allow();

// Active migration on the main thread → force delegation.
const reason =
  `parity: a migration is active (phase="${phase}"). The orchestrator must not run ` +
  `bash directly — invoke the Task tool with subagent_type:"runner" and pass this ` +
  `command as its cmd (see the migration-orchestrator skill). This gate fires only ` +
  `on the main thread during an active migration; subagents and other sessions are ` +
  `unaffected.`;

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  }),
);
process.exit(0);
