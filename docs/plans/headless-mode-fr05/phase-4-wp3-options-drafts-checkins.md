# Phase 4 (WP3): options, drafts, check-ins

## Outcome
The daemon produces the form and fallback choices from shared registries, holds drafts and starts a task only on Start now, and builds check-in lists (F3, F4, F6, F16 parts).

## Entry and dependencies
Phase 1.

## Scope and non-goals
Spec 7.5, 7.6, 7.7 (check-ins), 7.20 (draft). Owns `options.ts, drafts.ts, checkins.ts`, `src/shared/dispatch-options.ts`, `src/shared/after-work.ts`, and the behavior-preserving import swap in `DispatchModal.tsx`. Non-goals: any visible dashboard change.

## Repository findings
Kinds and defaults must come from `TASK_KIND_INFO`, `HOME_DISPATCH_KINDS`, `resolveTaskAgent`, `taskDefaultWorkflowId`; no hand-written lists (rule 3.9).

## Steps
Shared option rules, drafts in memory with expiry and one-task-per-draft, create-disabled-then-start-with-override (L16), quick path and repository names, check-in ordering (D26), banner text.

## Tests and verification
`home-dispatch-options`, `-drafts-http`, `-checkins-http`, dashboard parity test; existing guided-dispatch e2e specs unchanged; suite, typecheck, lint.

## Merge and exit
Dashboard unchanged; flag-off routes 404.

## Downstream handoff
Phases 7 and 10 consume options, drafts and check-ins.

## Cross-phase audit
`after-work.ts` is only here; phase 2 and 3 do not edit it.
