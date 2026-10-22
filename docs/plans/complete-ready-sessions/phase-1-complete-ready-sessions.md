# Phase 1 - Complete ready sessions

## Outcome and value

Give Mission Control one shared Fleet action that completes and closes every session with verified current-work delivery and no pending work. The whole Fleet is in scope, including sessions hidden by filters. The operator reviews the included sessions and confirms once. Ineligible sessions remain usable and partial failures are explained per session.

This is the only phase and owns root requirements FR-1 through FR-7 and every recorded product decision. Read [plan.md](plan.md) and [phased-plan.md](phased-plan.md) in this directory first. The root goal and adopted choices are requirements; this document is a proposed route. Adapt implementation details when current source disagrees or a better design presents itself, and explain the deviation in the implementation PR.

## Entry criteria and direct dependencies

The planning session's PR has merged all three Markdown files to the default branch. The backlog task must retain its direct planning-session dependency. No prior implementation phase exists.

Re-read root AGENTS.md, `.agents/memory/MEMORY.md` and relevant linked entries, `docs/agent-guides/architecture.md`, `docs/agent-guides/change-contracts.md`, and `e2e/README.md`. Inspect Git status before editing and preserve unrelated changes.

## Repository scope and non-goals

Change only mission-control. No other repository is attached or required. Implement the complete vertical slice, its tests, and its user/lifecycle documentation.

No automatic scheduler, readiness model call, force-completion, bulk Kill, per-session checkboxes, dependency override, incomplete-report override, automatic retro, new global shortcut, or pipeline/ensemble advancement. Do not change individual Complete semantics, automatic close-after-merge preferences, release/CI configuration, generated sources, or CHANGELOG.

## Repository findings and inherited contracts

- `src/web/App.tsx` owns state and shared Fleet controls; Cards, Console, and Board are arrangements. Place one app-owned confirmation/result surface and one shared action.
- `src/web/components/CompleteModal.tsx` illustrates existing outcome and Scout warning behavior, but its manual eligibility and discard permission are broader than bulk readiness. Do not reuse its task-exists predicate as eligibility.
- `src/shared/types.ts`, `src/shared/protocol.ts`, `src/web/lib/api.ts`, and `src/server/routes.ts` own shared types, validated requests, browser transport, and thin daemon adapters.
- `src/server/tasks.ts` owns completion. Its `finishCompletion` writes done and optional closure/return obligations together. Scout capture awaits before that write, so the guarded bulk path must validate again after capture. Existing route flags `satisfyDependents` and `confirmIncompleteScout` remain false for this feature.
- `mergeQuorumFor` reads durable repository facts and delegates to `src/shared/task-repos.ts`. `liveEpisodeOutcome` applies full multi-repository quorum after the preliminary current-episode check. Do not reduce it to one merged PR or use a historical PR badge.
- `src/server/archives/manager.ts` owns complete Scout publication and capture. `src/server/plans/publication.ts` owns exact local-plan receipts. No archive or plan policy belongs in a component or route.
- `src/server/task-resource-generation.ts`, existing reset/worktree-return checks, and task lifecycle ownership supply resource guards. Check every attached tree, not only the primary.
- `Registry.promptResourceBlockerForSession` refuses daemon prompts for a task with an owed closure. `Registry.beginEviction` emits exited followed by durable `session_remove`; accepted stop is not observed departure.
- Existing lifecycle history can prove current task and episode; missing facts remain excluded. An idle-looking session without confirmed lifecycle evidence is not ready.

## Execution steps

### 1. Establish the browser contract before implementation

Write `e2e/specs/complete-ready-sessions.spec.ts` using the standard isolated daemon and fake agents. Set up a mixed Fleet with ready delivery and unfinished work. Cover the shared action, a whole-Fleet candidate hidden by a filter, the one confirmation, and eligible sessions leaving while ineligible work remains usable. Run against the built baseline and observe failure at the missing feature. Never use operator state or real provider tokens to arrange the scenario.

Build fixture delivery facts through production paths where practical. Where merges, publication, or capture require seeding, use the established scoped fixture helpers, record what was seeded, and exercise the real preview/execute route afterward. Never instantiate SQLite directly in an E2E spec.

### 2. Implement the authoritative readiness reader and wire contracts

Create narrowly scoped readiness types and structured exclusion reasons in the existing shared ownership pattern. A proposed server helper may live beside TaskManager; do not create a parallel lifecycle manager.

Implement every general gate and delivery branch in the root plan's **One readiness rule**. The task, logical conversation, current work episode, cycle/intent, delivery proof, ownership, and resource generation must describe the same work. Missing evidence is an exclusion with a readable reason. Require all changed repositories' merge quorum, every submitted Scout report's complete publication, and exact final local-plan publication receipt. For an already done task, still check task-specific publication/archive requirements and no resumed work.

Reuse existing owner readers. Add read-only readers to the archive or plan owner if their current public method mutates; preview must never call capture or completion. Recheck authoritative workflow, pending-turn, transfer, reschedule, ensemble, and provider state rather than relying only on a potentially compact Session summary.

Return both ready candidates and useful exclusions, with explicit unknown/read-error states. Use bounded/coalesced resource probes and explicit collection/request limits. If the full Fleet cannot be evaluated or transported, return a clear incomplete/unavailable state and disable execution rather than silently taking a prefix.

Use the same rule for preview and execution. The execution request carries exact targets plus an opaque server-computed guard derived from current identities and proof facts; compare against a fresh server computation. Client-supplied booleans are never authorization.

### 3. Extend completion and closure through their existing owners

Add the guarded execution entry point on TaskManager or its existing completion seam. Before each target acts, read its exact binding and guard. Repeat validation after any asynchronous archive or resource check and immediately before the synchronous state transition. Detect a newer work cycle, intent revision, artifact revision, changed task/resource generation, new transfer or workflow ownership, and resumed work.

For an active task, call the normal completion path with an evidence-backed outcome and no override flags. Add the expected-state guard to the existing post-Scout-capture boundary rather than taking a stale outer snapshot. Record its session closure in the same transaction, including assigned sessions without managed worktrees.

For an already done task, request closure through the existing task closure ledger without running a second completion write. Preserve outcome, outcome URL, completedAt, source writeback, and dependency edges. Existing closure requests are idempotent. Do not synthesize a fresh outcome just to make an already completed task pass.

Reject unsafe or unknown worktree state before closure acceptance. At actual return, keep the existing provider/lease/occupancy checks and cleanup owner. If worktree conditions change afterward, retain unsafe resources and report the cleanup warning. No second cleanup, resource reset, or Registry eviction path.

The durable closure blocker must be in force before execution yields after acceptance, so Mission-delivered follow-ups cannot race a committed close. External terminal keystrokes remain outside that delivery lock; document and test the latest observable-state recheck without claiming a stronger lock.

### 4. Add preview and execute transport

Proposed routes are `GET /api/sessions/completion-preview` and `POST /api/sessions/complete-ready`. Use shared Zod schemas through `parseBody`, thin route adapters, the existing error style, and browser API wrappers.

Preview is read-only. Execute receives only the confirmed exact target set and guards, deduplicates it, and never expands it to newly eligible sessions. Bound concurrency using existing subprocess budgets. Return an item result for every supplied target: closure accepted, already closing/absent, skipped with a reason, or failed. A failure for one does not cancel independent targets.

Treat an accepted closure as pending, not removed. The existing SSE/state and authoritative absence reads settle departure. On timeout or a lost response, the client refreshes state and a fresh preview; it cannot announce success or resend the stale set as though nothing happened. No durable batch table or retry scheduler is added.

### 5. Add the shared Fleet action and confirmation/results

In `src/web/App.tsx`, add secondary **Complete ready (N)** beside existing Fleet actions without crowding Dispatch. Disable it during loading, disconnection, incomplete preview, zero readiness, and pending submission.

Refresh the daemon-owned preview on Fleet entry, reconnect/snapshot replacement, and relevant session/task/workflow/archive/plan changes through existing SSE events. Coalesce invalidations and disregard obsolete responses. A changed relevant state must invalidate a stale ready count, including publication and blocked-workflow changes; do not wait for an unrelated session event. Do not poll or reconstruct readiness in the browser.

Use an app-owned component and shared styles for the dialog, following Overlay IDs, focus trapping/restoration, shell-owned inset, responsive content, accessible role/name, Escape/Cancel, and in-progress duplicate prevention. The confirmed set can shrink after server revalidation; never add new candidates while running.

Show whole-Fleet scope explicitly, including filter-hidden targets, each task and delivery reason, and clear dependency/cleanup semantics. Use per-target progress and keep partial results until dismissal. A fresh retry reopens the current preview. Existing done metadata, dependency state, and individual Complete flow remain unchanged.

If adding any Session readiness projection, wire `SESSION_FIELD_COMPARATORS`; if adding any ServerEvent, update exhaustive browser handling and snapshot/Line decisions as required. Prefer existing event-triggered reads when sufficient; no new top-level collection solely for this action.

### 6. Verify the vertical slice and update documentation

Complete the focused tests, browser proof, and user/lifecycle documentation below. Inspect all three layouts, long titles, narrow widths, and both themes. Fix overflow, clipping, ambiguous labels, or missing focus indication encountered in these surfaces.

## API, data, and compatibility

No new persistent schema is expected. Extend the existing closure/complete owner and reuse its transaction and restart recovery. A migration is only justified if a source-verified gap prevents the approved behavior; keep it beside the current upgrade path and record the reason.

The API is additive. Unknown readiness fields in a mixed version cannot become a ready default. A missing/unsupported preview route is shown as unavailable. Existing complete callers retain their current defaults and manual behavior. Browser compatibility cannot bypass a daemon refusal.

Status and reason strings that are persisted or stored in durable IDs follow append-only contracts. Keep browser-safe contracts free of node imports.

## Test matrix and commands

Focused policy tests should cover all four delivery branches; missing/stale lifecycle evidence; idle versus working/input/review; queues and uncertain turns; current versus historical episode; all changed repositories versus untouched exemption; archive missing/incomplete/published; plan saved/approved/validated/published/superseded; workflow/transfer/reschedule/ensemble/provider ownership; and dirty, unpublished, occupied, or unreadable checkouts.

Focused integration tests must prove zero-mutation preview; independent mixed-target outcomes; guards invalidated during Scout capture and resource I/O; already done metadata preservation; duplicate and already absent/closing targets; no manual dependency release; no missing-report override; assigned-session closure; accepted closure followed by failed stop and restart recovery; and preserved unsafe worktrees.

Browser tests must prove the whole-Fleet action under filters, the confirmation list, cancel/no side effects, mixed eligibility, changing count, layout parity, zero/loading/disconnected states, double submission prevention, partial failure/retry, and removal versus closing semantics. Use fake terminal and SDK paths where the feature interacts with them. Any new modal calls `expectContentClearsBorder`. Capture and inspect gitignored successful screenshots in both themes and at a narrow viewport; register representative final images and focused output for workflow review.

Run the new focused files with `node --test --import ./test/setup-state.mjs --import tsx test/complete-ready-sessions.test.ts test/complete-ready-sessions-http.test.ts` if those names remain appropriate. Run relevant existing regressions such as `test/task-complete-satisfies.test.ts`, `test/task-merge-settles.test.ts`, `test/task-worktree-return.test.ts`, `test/scout-capture.test.ts`, `test/local-plan-publication.test.ts`, and `test/plan-publication.test.ts` with the same preload. Adapt filenames to actual ownership; do not invent a claim that a named test already exists.

Run `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke`, the focused browser spec using `npm run test:e2e -- e2e/specs/complete-ready-sessions.spec.ts`, then `npm run test:e2e` for the repository's UI gate. Apply the documented scoped outside-sandbox approval for real Electron tests where applicable. The build must precede E2E. Do not spend model tokens or bypass fake binaries.

Update `docs/sessions.md`, `docs/ui.md`, and the relevant API/lifecycle reference to describe readiness, whole-Fleet scope, one confirmation, skip reasons, retained unsafe resources, closure progress, and the direct-terminal observation boundary.

## Merge and exit criteria

- FR-1 through FR-7 pass with all adopted product decisions.
- Unit/integration and browser scenarios above demonstrate behavior; meaningful races are exercised at the owner boundary.
- Typecheck, lint, build, smoke, required E2E, and relevant regressions pass.
- Final screenshots show readable unclipped UI across the required layouts, themes, and widths.
- No unrelated changes, evidence, local state, credentials, auto-generated edits, or plan HTML are committed.
- Documentation matches implementation. The implementation PR explains any departure from this proposed route and carries reviewer-visible evidence.
- The implementation PR is reviewable, required CI is green, and valid review findings are addressed according to repository instructions. Merge requires the operator's applicable authorization.

## Downstream handoff

There is no later phase. Future callers may rely on one daemon readiness rule, guarded exact-set execution, preserved done metadata, existing durable closure/restart recovery, existing publication/merge dependency rules, and no browser-side readiness fold. They must not widen ready to mean merely idle or manually completable.

## Cross-phase audit record

Compared against the current root and index before final save. One phase owns FR-1 through FR-7 exactly once. Confirmed whole-Fleet and review-once choices are used in the UI, transport, test cases, and exit criteria. The full merge quorum, archive read-versus-capture boundary, exact publication receipt, guard-after-await, done-metadata preservation, and planning merge gate agree across all files. No prerequisite points to itself or an unscheduled phase. There are no parallel phase claims, cross-repository changes, or later repair obligations.
