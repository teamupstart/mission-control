# Complete all ready sessions

Status: complete planning bundle submitted for exact-revision approval. Planning only; no production implementation is part of this task.

## Outcome

Add a Fleet action that completes and closes every session whose current work has verified delivery evidence. The operator should clear finished sessions together without visiting each session's Complete dialog. Working, blocked, uncertain, and unfinished sessions stay available.

## Confirmed product decisions

The operator selected **sessions Mission Control marks ready to complete**, rather than every session with an enabled manual Complete action. They then selected **verified completion**, rather than treating a finished agent turn as proof of delivery.

Verified completion means a task already marked done, or current-episode delivery proof such as all required PRs merged or a published Scout/Plan artifact, together with a confirmed idle session and no pending work. The details below turn that selection into a single daemon-owned rule. The operator approved whole-Fleet scope, one shared confirmation, and a phased implementation follow-up in the exact revision 1 review.

## Current implementation and evidence

These are source-verified facts at planning time, not claims of runtime testing:

- `src/web/components/ActionBar.tsx` enables manual Complete when a session has a task. `CompleteModal.tsx` supplies an optional outcome, defaults dependency release off, and refuses an incomplete Scout archive unless the operator explicitly overrides it.
- `POST /api/tasks/:id/complete` delegates to `TaskManager.complete`. TaskManager owns completion, Scout capture, lifecycle conflicts, durable closure obligations, and worktree return. Manual completion can discard remaining local work during cleanup.
- `settleIfEpisodeFinished`, `liveEpisodeOutcome`, and `mergeQuorumFor` in `src/server/tasks.ts` already reconcile current-episode merges, including multi-repository delivery. A single merged PR is insufficient when the task's changed repositories require more merges.
- `ArchiveManager.ensureReady` in `src/server/archives/manager.ts` verifies submitted Scout reports. It can perform capture, so a read-only bulk preview must inspect published readiness without calling this mutating gate.
- `src/server/plans/publication.ts` exposes exact local-plan publication receipts. Saved or approved previews alone are not publication. Repository plans require their publication merge.
- `Registry.beginEviction` and durable `session_remove` own session departure. `promptResourceBlockerForSession` blocks daemon-delivered prompts after a closure obligation is recorded.
- `src/web/App.tsx` owns shared Fleet controls across Cards, Console, and Board. The existing SSE stream owns live updates; the browser must not add polling.

Repository discovery found historical completion, archive, plan-storage, and bulk-backlog plans. No existing bulk session-completion source plan was selected or substituted. The managed local catalog was empty (`plans: []`, `nextCursor: null`).

## User experience

Place a secondary **Complete ready (N)** action in the shared Fleet action area, reachable in Cards, Console, and Board. Keep Dispatch visually primary. When no sessions qualify, disable the action and explain that no sessions are ready. Before the daemon snapshot arrives, or while disconnected, show an unavailable state rather than a misleading zero.

The approved scope is **the entire Fleet**, explicitly stated beside the action and in its confirmation. A text or repository filter does not narrow it. The confirmation includes ready sessions hidden by active filters.

The approved interaction is one shared confirmation dialog. Opening it refreshes the daemon preview and shows each included session, its task, repository, and delivery reason. It also states that pending dependencies remain governed by existing publication rules. The operator confirms **Complete and close N sessions** once. Cancel or Escape has no side effects.

The dialog does not offer per-session selection, outcome editing, dependency-release overrides, archive overrides, or a bulk retro. Individual Complete remains the route for exceptional cases. Use the existing Overlay, modal inset, focus restoration, accessible labels, and button patterns.

While executing, prevent duplicate submission and show progress and per-session results. A failure for one session does not stop unrelated candidates. Explain skipped sessions and failures with actionable reasons and a link to the session or task where it still exists. Keep partial results visible until dismissed. A retry obtains a fresh preview and never blindly repeats the stale set.

## One readiness rule

The daemon evaluates the full rule and supplies reasons. The browser displays the answer and never infers readiness from green badges, idle duration, a PR URL, or a model's prose.

A candidate must meet every general gate:

1. A real live session has a current task association and work-episode identity. Restoring projections and unbound sessions are excluded.
2. Lifecycle evidence confirms idle. The latest completed work cycle belongs to the same logical conversation, with no active cycle or newer work/intent since its delivery proof. Missing freshness or identity is an explicit exclusion, never guessed.
3. No pending human review, input dialog, queued/pending/uncertain/steered turn, open Foreman queue item, unresolved intent, runtime transfer, reschedule, or already accepted session closure owns the session. Inspect authoritative stores where a Session summary is insufficient.
4. No active, waiting, blocked, paused, failed-unresolved, or otherwise unfinished workflow owns the current work. A completed review run alone is not delivery. Unfinished ensemble membership or a provider-owned pipeline lifecycle is also excluded. This feature never advances those engines.
5. Every task-owned checkout, including attached repositories, passes the existing archive and worktree safety contracts. Dirty, unpublished, occupied, or unreadable/unknown resources are skipped with a reason. Bulk completion must not discard local work merely because individual manual completion can.

Then at least one delivery branch must hold:

| Delivery branch | Required authoritative evidence |
| --- | --- |
| Task already done | The same task and episode remain current, completion is not superseded by resumed work, and the task-specific archive/publication requirements still pass. Preserve its recorded outcome and completion time. |
| Code or repository-backed plan delivered | The current episode's existing merge quorum is satisfied for every changed attached repository. Untouched repositories remain exempt through the existing quorum contract. Open, closed-unmerged, unknown, or historical-episode PRs do not qualify. |
| Scout delivered | At least one explicitly submitted report for this task and episode is already published and complete; every submitted report passes the existing archive contract. No missing-report override is available. |
| Local plan delivered | The exact final approved bundle has a valid publication receipt for this task and work episode, including its applicable validation. Saved, approved-only, blocked, superseded, or waiting-for-validation revisions do not qualify. |

Task kinds without one of these delivery proofs stay excluded. A completed turn, a completed workflow review, or an empty diff by itself never qualifies. Existing ordinary completion and automatic conclusion policies keep their meanings.

## Request flow and ownership

Before: the operator opens one session's Complete dialog, the browser calls the task-complete route and, when required, Kill; TaskManager and Registry settle that one session.

After: the shared Fleet action requests a read-only daemon preview. On execution, the browser submits only the previewed target identities and guards. The daemon revalidates each target, invokes guarded TaskManager completion or closure, and returns an itemized summary. TaskManager uses the existing archive, durable closure, and worktree-return owners; Registry emits the existing task/session SSE updates back to every dashboard. There are no external services, model calls, or Foreman-side database writes.

## Proposed technical route

The names below are proposed additions, not existing APIs.

- Add typed preview and execution schemas to the existing browser-safe shared contract owners. Represent included and excluded targets with structured reason codes and safe user-facing detail. Preserve append-only persisted IDs; do not introduce a persisted bulk-job lifecycle.
- Add read-only `GET /api/sessions/completion-preview` and `POST /api/sessions/complete-ready` adapters in `src/server/routes.ts`, with browser calls in `src/web/lib/api.ts`. The execute payload names exact session/task/episode identities and a guard covering logical conversation, completed cycle, intent, delivery proof, and task-resource generation. It cannot ask the server to widen the set.
- Put eligibility and guarded completion beside TaskManager's existing completion ownership. Reuse merge-quorum, publication, archive, resource-generation, and transfer owners. Extract narrowly reusable readers where needed rather than copying their policies into a new route or the browser.
- Keep preview read-only: no capture, stopping, task completion, worktree probes that mutate, or workflow starts. Use bounded read-only resource checks; unknown answers exclude. Execution repeats destructive-boundary checks, including archive readiness, after asynchronous work.
- Require the guard to remain valid immediately before the synchronous completion write. Extend the existing completion input/guard seam so Scout capture cannot cross new work, a changed task binding, or a different resource generation. Record the closure obligation in the same existing transaction as completion, including assigned sessions without owned worktrees. Once accepted, daemon-delivered prompts are refused by the existing closure blocker.
- For an already-done task, request its existing durable closure through TaskManager without rewriting the outcome, timestamps, dependency edges, or source writeback. Reuse the existing closure ledger, sweep, stop operation, and cleanup queue. No second eviction or cleanup path.
- Handle members independently with bounded execution concurrency using existing subprocess budgets. A changed target is skipped, an already closing/removed target is reported as such, and an operational failure is retained for retry. Deduplicate target identities and reject malformed, oversized, or truncated requests explicitly; never silently omit part of an 'all' set.
- An accepted closure is distinct from confirmed departure. Show **closing** after acceptance and **closed** only after durable removal or an authoritative absence read. Use existing task/session events for progress. If the HTTP reply is lost, refresh current state and preview; never announce success from a transport failure. Restart recovery belongs to existing per-task closure obligations, not an in-memory batch.
- Add the Fleet control and one app-owned result/confirmation surface in App and shared styles. Use no new polling, global shortcut, layout-specific policy, or top-level SSE collection solely for this action. Derive button count from a bounded daemon-owned readiness projection refreshed through existing session/task/workflow/archive changes and snapshot/reconnect; explicitly wire any new Session projection field into Registry comparisons.
- Direct terminal input outside Mission Control cannot be locked by this feature. Recheck observed runtime/work-cycle state before accepting closure and state this observation boundary in technical documentation; do not claim to prevent an unobserved keystroke.

No database migration is expected because task outcomes and closure/return obligations already exist. If investigation during implementation disproves this, record the discrepancy and design the upgrade beside its existing owner before changing persistence.

## Required outcomes and acceptance

| ID | Observable outcome |
| --- | --- |
| FR-1 | A single shared Fleet action shows the daemon's ready count and completes all targets in the approved scope. It works in all three layouts and at narrow widths. |
| FR-2 | Only the readiness rule above admits a target. Working, uncertain, taskless, blocked, stale-episode, incomplete-artifact, unmerged, unsafe-checkout, and provider-owned unfinished sessions remain untouched. |
| FR-3 | The approved interaction and scope are explicit; cancellation has no effect through the confirmation dialog. Zero, loading, and disconnected states cannot submit. |
| FR-4 | Every target is revalidated after asynchronous work and before completion. New work, rebind, transfer, new plan revision, or resource change causes a skip rather than closing the replacement work. |
| FR-5 | Completion and closure reuse durable owners; existing done metadata is preserved. No dependency is manually released and no archive requirement is bypassed. |
| FR-6 | Partial failures, lost responses, repeated clicks, retries, daemon restart, accepted closure, and confirmed departure are reported honestly without duplicate completion effects. |
| FR-7 | No tokens are spent, no browser polling or parallel lifecycle store is added, and live operator sessions are never used for tests. |

## Verification strategy

Implementation begins with fake-agent browser scenarios for a mixed Fleet and the proposed action. This is a new feature, so the initial failure is the missing affordance, not a claimed reproduction of a pre-existing bug.

- Focused node:test policy cases cover every readiness branch and exclusion, current versus historical episodes, multi-repository quorum, missing/unknown evidence, existing done tasks, and matching or changed guards.
- Focused daemon integration cases exercise preview with zero mutations, execution over mixed valid/stale/failing targets, Scout capture races, workflow/transfer ownership, reused sessions, unsafe resources, duplicate targets, lost-response reconciliation, durable closure retry/restart, and preserved task outcomes/dependencies.
- Add `e2e/specs/complete-ready-sessions.spec.ts`. Drive the built dashboard and isolated daemon with fake agents. Prove the selected interaction, scope under active filters, eligible sessions closing, ineligible sessions staying usable, partial failure and retry, duplicate-click protection, disconnect/reconnect, and both zero and changing counts.
- Exercise Cards, Console, and Board, keyboard focus, narrow viewport, light/dark rendering, long titles, and modal overflow. Any new dialog uses `expectContentClearsBorder`. Capture gitignored screenshots and inspect pixels. Select by roles/labels, never data-testid.
- Run focused tests with `node --test --import ./test/setup-state.mjs --import tsx <focused-files>`, then `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke`, and `npm run test:e2e`. Run relevant existing lifecycle/archive/merge regressions. Use repository-required outside-sandbox approval for real Electron tests when applicable.
- Update `docs/sessions.md`, `docs/ui.md`, and the appropriate lifecycle/API reference for the chosen control and readiness semantics. Do not hand-edit generated files or CHANGELOG.

Planning validation is separate: inspect source contracts, render and review every exact saved HTML revision, check Markdown/HTML consistency and paths, and register the complete final plan text and needed external contracts for the tool-less validation Personas. This planning task does not run or claim implementation tests.

## Scope boundaries and recorded review

This plan covers one manually invoked Fleet operation. It does not add automatic completion scheduling, a model-based readiness judge, force-complete, bulk Kill, dependency overrides, pipeline/ensemble completion, or changes to the existing individual Complete flow.

Recorded human decisions from the revision 1 dashboard review:

- Whole Fleet, including sessions hidden by filters.
- Review and confirm once before execution.
- Create a phased implementation plan and schedule dependency-linked tasks.
- Approve revision 1. That approval records the choices; the complete revised bundle still requires exact-revision approval before handoff.

## Implementation follow-up

The approved follow-up is one coherent implementation phase, indexed in [phased-plan.md](phased-plan.md) and detailed in [phase-1-complete-ready-sessions.md](phase-1-complete-ready-sessions.md). Its task remains blocked on this planning session's artifact publication merge.

## Claims and assumptions ledger

Verified: the completion, merge, archive, publication, prompt-blocking, and eviction owners cited above exist in the checked-out source. No live readiness flag or existing bulk-completion API was found; both are proposed.

Confirmed inputs: the operator chose ready-only scope and verified delivery, with no pending work. All product choices above are recorded from structured human responses. Any later change to the bundle requires a new exact-revision approval. No claim of implemented or runtime-verified behavior is made.
