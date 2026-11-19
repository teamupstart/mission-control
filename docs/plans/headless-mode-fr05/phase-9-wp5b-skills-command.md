# Phase 9 (WP5b): skills and command

## Outcome
The `mission-dispatch` and `mission-checkin` skills, and the `/mission-dispatch` command, are linked for Claude only while the flag is on (F3, F5, F16).

## Entry and dependencies
Phase 7. Merge gated by spikes S3 and S8.

## Scope and non-goals
Spec 7.11, 7.20. Owns `skills/dispatch/`, `skills/checkin/`, flag and harness gating in `src/server/skills/reconcile.ts`, and the `homeDispatch` harness capability. Non-goals: agents (phase 13).

## Repository findings
The reconciler links into `~/.claude/skills`, `~/.agents/skills`, `~/.pi/agent/skills` (L27); Claude-specific behavior goes through the harness registry.

## Steps
Skills that name the tools from phase 7 and never list kinds by hand; command name only from `DISPATCH_COMMAND`; reserved words only as the whole argument (L20); `desiredSkillIds` reads the flag and a flag change triggers reconcile.

## Tests and verification
`home-dispatch-skills.test.ts` structural checks (frontmatter, headings, named tools, forbidden phrases); flag on and off link tests; suite, typecheck, lint.

## Merge and exit
Flag off: no link exists. S3 and S8 recorded or fallback applied.

## Downstream handoff
Phases 11 and 13 reconcile on top of this gating.

## Cross-phase audit
`reconcile.ts` owned here; phase 13 adds one call from a new file.
