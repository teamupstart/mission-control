# Phase 13 (WP11): subagents

## Outcome
The read-only `mission-briefer` helps gather facts for a brief, workers get `mission-explorer` and `mission-reviewer`, and the picker shows each worker's subagents (F9).

## Entry and dependencies
Phases 9 and 12. Merge gated by spike S4.

## Scope and non-goals
Spec 7.17. Owns `agents/`, `src/server/skills/agent-links.ts` (a new file with one call added to `reconcile.ts`), `src/cli/pick-subagents.ts`. Non-goals: worker prompt changes.

## Repository findings
`agents/` does not exist; `SubagentStop` with empty `agent_type` is the compaction helper (L9).

## Steps
`reconcileAgentLinks` reads the flag and links `~/.claude/agents/mission-*.md` only while on; briefer output shown as context, never mixed into the person's words; picker tree.

## Tests and verification
`home-dispatch-subagents.test.ts` structural checks plus link tests; suite, typecheck, lint.

## Merge and exit
Flag off: no agents linked. S4 recorded or fallback applied.

## Downstream handoff
Phase 14 documents it.

## Cross-phase audit
Only one call is added to `reconcile.ts`, after phase 9 merged its gating.
