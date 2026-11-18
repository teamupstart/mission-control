# Phase 7: Integration and docs

Plan: `docs/plans/headless-mode/plan.md`. Spec sections 10 and 11. Index: `docs/plans/headless-mode-phases/phased-plan.md`.

## 1. Outcome

The whole v1 loop is proven end to end without model tokens, isolation is proven, and the feature is documented.

## 2. Entry criteria and dependencies

Phase 6 merged (which implies phases 1 to 5).

## 3. Scope and non-goals

In scope: loop and isolation tests, worker identity test, docs. Not in scope: new behaviour. Fix defects found in earlier phases in the smallest possible change and record them.

## 4. Repository findings and contracts

- Real daemon test pattern: `test/settings-backup-daemon.test.ts`; call `ensureNativeStateLockAddon` at module scope.
- Docs link checker and the no-em-dash rule apply to everything under `docs/`.

## 5. Implementation steps

1. `test/handoff-loop.test.ts`: banner, dispatch-options questions, create with answers, dispatch, worker question, hook card, answer receipt, ready (spec 10), plus the worker-identity test (AC-INT-04) and dashboard parity of choices (AC-INT-05).
2. `test/handoff-isolation.test.ts`: sandbox setup and purge leave default files byte-identical.
3. `docs/headless-mode.md` per spec 11; link from `docs/README.md` and `README.md`; add the paragraph in `docs/dispatch-and-backlog.md`; the security section in `docs/security.md`; `docs/configuration.md` note.
4. `test/handoff-docs.test.ts`.

## 6. Data, API and compatibility

None.

## 7. Tests and verification

Owns AC-INT-01 to AC-INT-05, AC-DOC-01 to AC-DOC-05. Run the full set: `npm run typecheck`, `npm run lint`, `MISSION_TEST_CONCURRENCY=4 npm test`, `npm run build`, `npm run smoke`, `npm run test:e2e`.

## 8. Merge and exit criteria

All v1 acceptance rows pass with no `todo`; checks green.

## 9. Downstream handoff

v1.1 phases (attach, notifications, config set) start from this state.

## 10. Cross-phase audit

Final audit confirmed every acceptance group has exactly one owning phase.
