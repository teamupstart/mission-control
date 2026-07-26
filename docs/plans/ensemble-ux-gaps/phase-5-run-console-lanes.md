# Phase 5 - Run console: stage pipeline, live member lanes, inline answering

## 1. Outcome and value

The run detail becomes a page the operator can stay in mid-flight. A stage pipeline header names each stage in operator words with live counts and translates `waiting` into its barrier ("waiting for 2 more submissions"); member cards become live lanes (session tone, activity line, goal, elapsed, live cost) with a blocked member's review question answerable inline and its pane dialog rendered in place; the record-keeping halves (attempt/artifact histories) fold behind a disclosure. Closes G6/G7 fully, G8, the visibility of G9 (staleness is shown; no new timer policy), and the in-run halves of G11/G12.

## 2. Entry criteria and dependencies

- Direct prerequisites: Phase 4 (both phases restructure `EnsembleDetail.tsx` and its result plumbing; the approved order runs the dossier first). Transitively Phases 1 and 3.

## 3. Scope and non-goals

In scope: threading `sessions`/`reviews` into the ensemble detail, the pipeline header, lane composition, inline `ReviewCard`/`PaneDialogPrompt`, barrier phrasing, tests, docs. Non-goals: the compare workspace (Phase 6); any stall TIMER or deadline policy (the lane shows `lastActivity` age and lets the human judge - a server-side stall policy is a product decision this plan does not take); observed-model capture (`member-launch.ts:75` stays a later-phase server item, out of scope).

## 4. Repository findings this phase is built on (verified 2026-07-26)

- The detail sees neither sessions nor reviews today: `EnsembleDetail` receives only the fetched `EnsembleRunDetailResponse` + callbacks (`EnsembleDetail.tsx:32-59`); `EnsembleRuns` receives only `summaries` (`EnsembleRuns.tsx:25-41`). Both are in App's render scope (`MissionState.sessions`, `.reviews`), so this is prop threading (App -> WorkflowPage -> EnsembleRuns -> EnsembleDetail), not new wire.
- The detail refetches only when the run's summary `updatedAt` revises (`EnsembleRuns.tsx:121-127`). Phase 1's session-edge republish means a member gaining/losing a review DOES revise the summary - the lanes' review state arrives without polling. Live session facts (activity, tone) come from the threaded `sessions` array, which re-renders on `session_upsert` independently of the fetch.
- Lane inputs on `Session`: `activity: string | null` (`types.ts:375`), `lastActivity: number | null` (`types.ts:380` - shared across hooks/driver events; there is NO per-activity timestamp, so the lane labels the age as "last event", not "activity age"), `goal` (`types.ts:455`, has its own `updatedAt`), `paneDialog` (`types.ts:502`), `pendingReviews` (`types.ts:382`). Cost: the session's live cost field as rendered by `CostChip` today; the artifact's `agentCostUsd` remains the frozen at-submission figure and the lane must not conflate them.
- `PaneDialogPrompt` renders anywhere given `{ sessionId, dialog }` (`PaneDialogPrompt.tsx:33-39`; calls `api.selectOption` / `submitOptions` / `submitAnswers` only). `ReviewCard` is exported by Phase 4 and needs only the `ReviewItem` (unique `namePrefix` per rendered form). These are two protocols rendered side by side, deliberately - same recording as Phase 4.
- The stage plan (labels, ids, driverKind, barrier, dependsOn) is already in the detail's timeline data; barriers are `none | members_settled{minEligible, requiredArtifacts} | stages_succeeded | human_decision`. "Waiting for N more" = `minEligible - readyArtifacts` floor 0, using the summary's `readyArtifacts`.
- Members section today: `EnsembleMembers.tsx` (wave-grouped record cards with Open session / Open task / Withdraw / Retry / Submit). The lane wraps this, it does not replace the actions.

## 5. Implementation steps

1. **Thread props**: `sessions: Session[]` and `reviews: ReviewItem[]` from App through `WorkflowPage` to `EnsembleRuns` to `EnsembleDetail` (optional props defaulting to empty, so route tests with stub registries stay valid). Build a per-member join inside `EnsembleDetail`: memberId -> taskId -> session (by `session.task?.id`) -> that session's pending reviews.
2. **Pipeline header** - new `src/web/ensembles/EnsemblePipeline.tsx` above the facts `<dl>`: one step per compiled stage in ordinal order, labeled by driverKind through a small extension of the Phase 1 vocabulary (`member` -> "Work", `review` -> "Review", `decision` -> "Decide", `finalize` -> "Promote", with a synthetic leading "Launch" step from member launch counts). Step state from stage attempts + run status; the active step carries its counts ("3/5 submitted · 1 blocked") and a `waiting` run renders the barrier sentence. Pure projection helpers in `src/web/ensembles/pipeline.ts` (unit-testable, no component).
3. **Lanes** - extend `EnsembleMembers.tsx`: when a live session joins, the card header gains tone dot, activity line, "last event Xm ago" (from `lastActivity`, labeled honestly per 4), goal line, live cost; the attempt/artifact history lists move behind a `<details>` disclosure (default open when the member is failed). When the joined session has pending reviews, render each via `ReviewCard` under a "candidate N asks" header; when it has a `paneDialog`, render `PaneDialogPrompt` in the lane. No session -> the card renders exactly as today (record form), which keeps terminal runs and restored snapshots unchanged.
4. **Facts row** - the header facts lose the duplicated stage entry (the pipeline owns it); Members count stays.
5. **CSS** - new rules in the ensembles section (`ensemble-pipeline`, `ensemble-lane-*`), following the existing `ensemble-` prefix families.

## 6. Data / compatibility

No wire changes, no route changes. Detail props are additive and optional. The `namePrefix` uniqueness rule extends to lanes (review id already unique).

## 7. Tests and verification

- New `test/ensemble-pipeline.test.ts` (comment: what is at stake is the run explaining itself in operator words): projection over the three shipped strategies' plans; barrier phrasing (`minEligible 2`, 1 ready -> "waiting for 1 more submission"); decision stage renders "waiting on you"; terminal runs render the full walked pipeline.
- New `test/ensemble-lanes-render.test.ts`: a member with a joined session renders tone/activity/goal; pending review renders an answer form with the candidate header; pane dialog renders the prompt; no session renders the record card byte-identically to today's snapshot; failed member's history is expanded.
- Update `ensemble-page-render` for the pipeline header and facts change.
- Commands: `npm run typecheck`, `npm test`; manual: watch a live run, answer a member's question from the lane, confirm the summary-driven refetch shows the unblue state without reload.

## 8. Merge and exit criteria

Suite green; `docs/ensembles.md` progress/monitoring section rewritten around the pipeline and lanes; README's ensemble paragraph updated. The Members section's existing actions (Withdraw/Retry/Submit/Open) all still render and fire.

## 9. Downstream handoff

Phase 6 may rely on: the threaded `sessions`/`reviews` props; `EnsemblePipeline` and `pipeline.ts` projections; lanes owning the member half of the page (the compare workspace is a sibling section, not a lane feature). It must not: add a second barrier-phrasing implementation or move answering out of the lanes.

## 10. Cross-phase audit record

- 2026-07-26: initial version. Reconciliations: (a) stall handling narrowed to showing `lastActivity` age honestly - the field is shared across event kinds and no dedicated activity timestamp exists, so the lane says "last event", and a stall TIMER is explicitly out of scope as a product decision; (b) inline answering renders two protocols side by side (reviews via `ReviewCard`, dialogs via `PaneDialogPrompt`) per Phase 4's recorded decision; (c) the Phase 1 session-edge republish is what makes lane review-state fresh without polling - if Phase 1's edge guard is ever weakened, this page is the consumer that notices.
