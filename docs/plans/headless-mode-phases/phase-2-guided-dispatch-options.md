# Phase 2: Guided dispatch options

Plan: `docs/plans/headless-mode/plan.md`. Spec 3.5. Index: `docs/plans/headless-mode-phases/phased-plan.md`.

## 1. Outcome

`POST /mcp/handoff/dispatch-options` returns the launcher question (for the first-message entry) and the same Repo, Kind, Harness and After work questions the dashboard's guided pass asks, paged to four options, with a plain-text fallback.

## 2. Entry criteria and dependencies

Phase 1 merged (guided schemas, `pageOptions`, `recommendKind`, `LAUNCHER_CHOICES`, route seam).

## 3. Scope and non-goals

In scope: the route, `src/shared/dispatch-options.ts`, the behaviour-preserving dashboard import swap, the launcher question. Not in scope: MCP tool, skill text, the offer decision (phase 1), the hook instruction (phase 3), any visible dashboard change, model or effort questions, pipeline kind.

## 4. Repository findings and contracts

- Rules to share: `afterWorkForKind` in `src/web/components/DispatchModal.tsx` (about line 1730), `GUIDED_STEPS` in `src/web/lib/guided-dispatch-steps.ts`, `taskDefaultWorkflowId` and `TASK_KIND_INFO` in `src/shared/task.ts`, `resolveTaskAgent` in `src/server/harnesses.ts`.
- `ui.guidedDispatch` is the on/off value (`src/shared/protocol.ts`). It switches off the Kind, Harness and After work questions, not the launcher question.
- Kinds offered: `HANDOFF_KINDS` in `HANDOFF_KIND_ORDER`; scout and chat have no after work.

## 5. Implementation steps

1. Extract the pure rules (which kinds, default after work, applies flag) into `src/shared/dispatch-options.ts`; make `DispatchModal.tsx` import them with no behaviour change. If extraction is not clean, keep the rules server side and rely on the parity test in step 6.
2. Build the response in `src/server/handoff/dispatch-options.ts`: questions for Launcher (only for `entry` `first-message`), Repo (only when `repoRoot` is null), Kind (with Check in), Harness (recommended `resolveTaskAgent(kind)`), After work (default, None, active published workflows); `defaults`, `afterWorkApplies`, `guided`, `banner`, `fallbackText`.
3. Launcher question: three options (`work-here`, `hand-off`, `check-in`), Recommended is `hand-off` when `recommendKind(brief)` is not null, else `work-here`, listed first with the suffix " (Recommended)".
4. Recommended option first with the suffix " (Recommended)" in other questions; "More..." description names an off-page recommendation.
5. `guided: false` returns no Kind, Harness or After work questions but full `defaults`; the launcher question is still returned for the first-message entry.
6. Add the parity test (AC-GUIDE-07) comparing every kind against the dashboard rule.
7. Register the route in `registerHandoffRoutes`; require the harness token.

## 6. Data, API and compatibility

No schema change. The dashboard's guided pass must behave identically; run its existing e2e specs.

## 7. Tests and verification

Owns AC-GUIDE-01 to AC-GUIDE-13 and the dispatch-options part of AC-API-01. Run `test/handoff-dispatch-options.test.ts`, the dashboard guided specs (`npm run build`, then `npm run test:e2e` for guided dispatch), typecheck, lint, `npm test`.

## 8. Merge and exit criteria

Owned rows pass; e2e guided dispatch unchanged; no visible dashboard difference.

## 9. Downstream handoff

Phase 4 consumes the response shape. The question `value` fields (including `work-here`, `hand-off`, `check-in`) are stable ids; labels may change.

## 10. Cross-phase audit

Touches `src/web/components/DispatchModal.tsx` (import swap only) and no file phases 3 or 5 touch. The banner text is produced by one shared function also used by phase 1's sessions route.
