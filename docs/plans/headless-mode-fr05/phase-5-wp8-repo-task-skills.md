# Phase 5 (WP8): repository task skills

## Outcome
A repository's `.claude/skills/{kind}/SKILL.md` is appended to the worker's first prompt for every origin and harness (F7).

## Entry and dependencies
Phase 1.

## Scope and non-goals
Spec 7.15. Owns `src/server/instructions/repo-task-skill.ts` and `composeTurnOne` in `src/server/dispatcher.ts`. Non-goals: terminal runtime call site (phase 12).

## Repository findings
`composeTurnOne` is a local closure in `dispatcher.ts` (near line 720); extract or extend it without changing flag-off output.

## Steps
Reader with size and safety limits, skipped files recorded in `session_standing_instructions.repo_task_skills`, appended after a line saying it cannot relax Mission Control's rules, per attached repository, checked per launch via `featureEnabled`. Q6: keep `.claude/skills/{kind}`.

## Tests and verification
`home-dispatch-repo-skill.test.ts`: byte-identical prompt without a file or with the flag off; oversized, unsafe, unreadable files skipped; suite, typecheck, lint.

## Merge and exit
Flag-off launches byte-identical.

## Downstream handoff
Phase 12 changes only the runtime call site in `dispatcher.ts` and merges after this phase.

## Cross-phase audit
`dispatcher.ts` ownership: this phase for composition, phase 12 only for the runtime call.
