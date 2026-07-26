# Phase 1 - Blocked-member wire signal and shared stage vocabulary

## 1. Outcome and value

A member session that is waiting on the operator (a pending review or a pane/driver dialog) becomes visible in the ensemble vocabulary: `EnsembleSummary.membersNeedingInput` counts them, run `attention` ORs them in (so the run list's attention dot, its attention-first sort, and the away digest all light up), and `TaskEnsembleLink.needsInput` marks the member's own chip data. A shared `ensembleStageWord()` maps run status to operator words so later phases never re-derive it. This closes the "run detail says Active while the card is red" disagreement (gaps G11, and the wire half of G3/G12) with server-visible value on day one: the Ensembles list row for a run with a blocked member sorts to the top with the attention dot lit.

## 2. Entry criteria and dependencies

- Direct prerequisites: none (first phase). The planning-session artifacts must be on the default branch.

## 3. Scope and non-goals

In scope: shared shapes, the manager-side derivation and republish edge, alert-engine input widening, tests, and doc updates. Non-goals: any web rendering of the new fields (Phase 3), any new alert class (deliberate - see 5.4), any persisted schema change (there is none: both new fields are derived).

## 4. Repository findings this phase is built on (verified 2026-07-26)

- `store.summaryFor` (`src/server/ensembles/store.ts:1279`) and `taskLink` (`store.ts:1332`) are DB-only; the registry is deliberately store-independent via `registerEnsembleProjection` (`src/server/registry.ts:806`). Therefore the join lives in `EnsembleManager`, which holds both `this.store` and `this.registry`.
- `manager.publish(id)` (`src/server/ensembles/manager.ts:1063`) is the live emit path, but the boot paths call `store.listSummaries()` directly (`manager.ts:257`, `manager.ts:302`) - a derived field added only in `publish` disagrees with the boot snapshot.
- The manager's registry subscription early-returns on everything but task events (`manager.ts:269-270`). Nothing republishes an ensemble on a session change - this is the missing invalidation edge.
- Review create/resolve already emits a session update: `ReviewManager` -> `Registry.upsertReview` (`registry.ts:3955`) -> `refreshPendingCount` (`registry.ts:3984`) -> `emitSession`. Dialogs: `applyDriverDialog` (`registry.ts:1395`) and the discovery merge (`registry.ts:1011-1015`). So listening to `session_upsert` is sufficient; no new emitter is needed.
- The session fields are `Session.pendingReviews: number` (`src/shared/types.ts:382`) and `Session.paneDialog: PaneDialog | null` (`types.ts:502`). Member -> session hops: `store.listMembers(runId)` (`store.ts:1105`) gives `EnsembleMember.taskId`; `registry.getTask(id)` (`registry.ts:3997`) gives `Task.sessionId`; `registry.getSession(id)` (`registry.ts:600`).
- `TaskEnsembleLink` rides on `Session.task` (built by `taskSummaryFor`, `registry.ts:4309`, reading `this.ensembleProjection`), whose comparator is `byJson` - a changed link propagates with no comparator work. The links map is rebuilt by `manager.refreshLinks()` (`manager.ts:293-295`) and pushed via `registerEnsembleProjection` -> `resyncSessionTask`.
- Tests that pin the wire: `test/ensemble-sse.test.ts:135-156` asserts the exact sorted 21-key list of `EnsembleSummary`; `test/ensemble-contracts.test.ts:337-341` pins `ensembleNeedsAttention` (5 cases); `test/session-contracts.test.ts:138-152` writes the `TaskEnsembleLink` literal (behavioral, tolerant of an added field, but the literal should be updated); the `ensemble-alerts` fixture recomputes `attention` via `ensembleNeedsAttention`.

## 5. Implementation steps

### 5.1 Shared shapes (`src/shared/ensemble.ts`)

1. Add `membersNeedingInput: number` to `EnsembleSummary` (beside `readyArtifacts`; document it as "derived from live session state at publish time, 0 in any context with no registry").
2. Add `needsInput: boolean` to `TaskEnsembleLink` with the same derivation note.
3. Widen `ensembleNeedsAttention` (currently `{status, unreadable}`, `ensemble.ts:1260-1268`) to accept an optional `membersNeedingInput?: number` and return true when it is > 0. Optional with a 0 default so existing callers compile unchanged.
4. Add `ensembleStageWord(summary: Pick<EnsembleSummary, "status" | "outcomeKind">): string` - a pure total map: `planning` -> "launching", `running` -> "working", `waiting` -> "waiting", `evaluating` -> "reviewing", `awaiting_decision` -> "waiting on you", `finalizing` -> "promoting", `cancelling` -> "cancelling", `completed` -> "done", `cancelled` -> "cancelled", `failed` -> "failed", null/unreadable -> "unreadable". It reads only the summary (the compiled plan is not on the wire, deliberately).

### 5.2 Manager derivation (`src/server/ensembles/manager.ts`)

1. Add a private `memberNeedsInput(taskId: string | null): boolean` - task -> `Task.sessionId` -> session -> `pendingReviews > 0 || paneDialog != null`. Status-scope it: only count members whose status is non-terminal (`pending | launching | active | submitted | reviewing`); a retained or eliminated member's session state is not this run's problem.
2. Add a private `decorateSummary(summary: EnsembleSummary): EnsembleSummary` that fills `membersNeedingInput` (via `store.listMembers(runId)` + the hop above) and recomputes `attention` through the widened `ensembleNeedsAttention`. Apply it in `publish()` AND wrap every `store.listSummaries()` / `store.summary()` result that reaches the registry (the boot paths at `manager.ts:257` and `:302`), so the boot snapshot and the first live emit agree.
3. Inject `needsInput` when the links map is rebuilt in `refreshLinks()` - the link for a member's taskId gets `memberNeedsInput(taskId)`.
4. Add the invalidation edge in the existing registry subscription (the block that early-returns at `manager.ts:269-270`): on `session_upsert`, if the session's task id maps to a known member (consult the links map - it is already keyed by taskId), recompute that run's derived values; republish (`publish(runId)` + `refreshProjection()`) ONLY when the derived value changed from the cached previous value. The change-guard is mandatory: `publish` -> `refreshProjection` -> `resyncSessionTask` -> `session_upsert` would otherwise loop. Cache the last-published `membersNeedingInput` per run and last `needsInput` per member inside the manager.
5. `session_remove` needs no handling here: a removed member session settles through the existing task reconciliation, which already republishes via the task-event path.

### 5.3 `listMembers` cost note

`summaryFor` deliberately avoids loading children on every change (`store.ts:1233-1238`). The decoration adds one `listMembers` read per publish, bounded by `maxMembers <= 16` rows; keep the hop in the manager (not in a new SQL aggregate) because the needs-input fact is registry state SQL cannot see. If profiling ever objects, the cache from 5.2.4 already bounds recomputation.

### 5.4 Alerts: widen input, add no class

`AlertScope.ensembleSummaries` already carries the summary; the widened `attention` flows into `awayDigest` and `hasReportable` with no code change beyond the fixture. Deliberately do NOT add a new edge-triggered ensemble alert class for blocked members: the member session already fires the session-level needs-input/review alert, and a second OS notification for the same fact is a duplicate. Record this in `docs/ensembles.md`'s alerts section.

## 6. Data / compatibility

No DB change, no migration, no new route, no new ServerEvent variant. Both fields are derived at publish time; a build that has never heard of them (older web bundle) ignores unknown JSON keys. `EnsembleSummary` consumers in tests must be updated (below).

## 7. Tests and verification

- Update `test/ensemble-sse.test.ts:135` exact-keys list (insert `"membersNeedingInput"` in sorted position between `"memberCount"` and `"outcomeKind"`).
- Update `test/ensemble-contracts.test.ts:337-341` for the widened `ensembleNeedsAttention` and add cases: `membersNeedingInput > 0` forces attention regardless of status; 0 changes nothing.
- Update the `test/ensemble-alerts` fixture's attention recomputation to pass the new field; assert a blocked member raises `attention` in the summary without emitting a new alert class.
- Update `test/session-contracts.test.ts:138-152` link literal with `needsInput`.
- New `test/ensemble-needs-input.test.ts` (comment: what is at stake is the fleet and the run agreeing about a blocked member): drive a stub registry + store through the manager - (a) creating a review on a member session republishes the summary with `membersNeedingInput: 1` and `attention: true`; (b) resolving it returns to 0; (c) the republish is edge-guarded (a second identical `session_upsert` emits nothing - count `ensemble_upsert` events); (d) `taskLink` for that member carries `needsInput: true`; (e) the boot path (`listSummaries`) reports the same decorated value as `publish`; (f) a `retained` member's pending review does not count.
- New unit cases for `ensembleStageWord` (total over `ENSEMBLE_STATUSES` plus null).
- Commands: `npm run typecheck`, `npm test`.

## 8. Merge and exit criteria

Typecheck and full test suite green; `ensemble-sse` still proves the wire carries no plan/roster/prompt content; a manually driven run (member session given a review via the MCP ask channel) shows the Ensembles list row dot lit and sorted first. `docs/ensembles.md` attention list updated ("a member waiting on your answer" added; duplicate-notification rationale recorded). README untouched (no operator-visible surface changes yet beyond the existing attention dot behavior, which docs/ensembles.md owns).

## 9. Downstream handoff

Later phases may rely on: `EnsembleSummary.membersNeedingInput` and `TaskEnsembleLink.needsInput` being present, correct at boot and live, and edge-guarded; `ensembleStageWord` as the ONE stage vocabulary; `ensembleNeedsAttention`'s widened signature. They must not: re-derive needs-input from sessions in the browser (read the link/summary), add a second stage-word mapping, or add an ensemble alert class for blocked members without revisiting the 5.4 decision.

## 10. Cross-phase audit record

- 2026-07-26: initial version. Reconciled against the source plan's Section 3 (which placed the join "at the registry" - disproved; it lives in the manager, with the registry kept store-independent). Stage vocabulary moved from the source plan's Solution A into this phase so Phases 3-6 share one function.
