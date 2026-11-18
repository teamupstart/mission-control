# Phase 7: Integration and docs

Plan: `docs/plans/headless-mode/plan.md`. Spec sections 10 and 11. Index: `docs/plans/headless-mode-phases/phased-plan.md`.

## 1. Outcome

The whole v1 loop, starting from the automatic first-message launcher, is proven end to end without model tokens, isolation is proven, the single-branch delivery rule is verified, and the feature is documented as alpha. The work is pushed to `feat/headless-mode-spike`.

## 2. Entry criteria and dependencies

Phase 6 pushed to `feat/headless-mode-spike` (which implies phases 1 to 5).

## 3. Scope and non-goals

In scope: loop and isolation tests, worker identity test, delivery checks, docs. Not in scope: new behaviour, merging to `main`, any pull request. Fix defects found in earlier phases in the smallest possible change and record them.

## 4. Repository findings and contracts

- Real daemon test pattern: `test/settings-backup-daemon.test.ts`; call `ensureNativeStateLockAddon` at module scope.
- Docs link checker and the no-em-dash rule apply to everything under `docs/`.

## 5. Implementation steps

1. Start from the tip of `origin/feat/headless-mode-spike`.
2. `test/handoff-loop.test.ts`: register a `startup` session with the interactive entrypoint, notice, first `UserPromptSubmit` returns the launcher instruction, dispatch-options launcher question then kind, harness, after work, create with the first message as brief, confirm and dispatch, a second prompt in the same session returns no instruction, worker question, hook card, answer receipt, ready (spec 10), plus the worker-identity test (AC-INT-04) and dashboard parity of choices (AC-INT-05).
3. `test/handoff-isolation.test.ts`: sandbox setup and purge leave default files byte-identical.
4. `docs/headless-mode.md` per spec 11, opening with the spike and alpha notice naming `feat/headless-mode-spike` (AC-DEL-04), then when the launcher asks, when it does not, how to switch it off; link from `docs/README.md` and `README.md`; add the paragraph in `docs/dispatch-and-backlog.md`; the security section in `docs/security.md`; `docs/configuration.md` note for `handoff.launcher.prompt` and `MISSION_HANDOFF_LAUNCHER`.
5. `test/handoff-docs.test.ts`.
6. Run the delivery checks AC-DEL-01, 02, 03 against `origin` and record their output in the report.
7. Fetch, rebase on the branch tip, re-run verification, push fast-forward to `feat/headless-mode-spike`.

## 6. Data, API and compatibility

None.

## 7. Tests and verification

Owns AC-INT-01 to AC-INT-05, AC-DOC-01 to AC-DOC-05, AC-DEL-01 to AC-DEL-04, and AC-DEL-05 for its own pushes. Run the full set on the branch tip: `npm run typecheck`, `npm run lint`, `MISSION_TEST_CONCURRENCY=4 npm test`, `npm run build`, `npm run smoke`, `npm run test:e2e`.

## 8. Exit criteria

All v1 acceptance rows pass with no `todo`; checks green on the branch tip; no other upstream branch carries the code; nothing merged to `main`.

## 9. Downstream handoff

v1.1 phases (attach, notifications, config set) start from this state on the same branch unless decided otherwise.

## 10. Cross-phase audit

Final audit confirmed every acceptance group has exactly one owning phase and every phase exits with a push to the one branch.
