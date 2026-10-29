# Phase 1: CodeRabbit observation and session follow-through

Read [the approved root plan](plan.md) and [the implementation index](phased-plan.md) first. This phase owns the complete feature, CR-1 through CR-8. It is a proposed implementation route: preserve the approved outcomes, adapt private module/API choices when the repository warrants it, and record deviations and their reasons in the pull request.

## Outcome and value

An operator enables “Follow up on CodeRabbit comments” in Settings > Shipping. Mission Control observes its adopted open PRs even when Inspector reviews and YOLO are off, and prompts each eligible owning session about new unresolved CodeRabbit findings. The session works on the same PR. Existing Foreman consent and workflow ownership prevent competing instructions; durable claims prevent automatic replay after a restart or uncertain send.

This is one one-shot implementation task and one reviewable PR in teamupstart/mission-control. No other repository is modified. Runtime support for attached repositories is part of this feature, not permission to attach or change another implementation repository.

## Entry criteria and direct dependencies

- The planning session's PR has merged all three Markdown artifacts under `docs/plans/code-rabbit-auto-resolver/`.
- The task retains a direct dependency on the planning session. There are no preceding implementation tasks.
- Re-read current AGENTS.md, its linked architecture/change contracts, repository memory and `e2e/README.md`. Inspect status and preserve unrelated edits.
- Confirm current main still has the provider adapter, adoption ledger, Foreman follow-through and Shipping settings seams described below. Do not copy a schema version or line number from this plan as an implementation fact.

## Scope and non-goals

Deliver every root requirement, including migrations, backend decisions, state projections, settings restore, UI, focused tests, browser verification and docs in this phase.

Do not add a second PR poller, PR inventory, daemon/database writer, general bot framework, webhook service, merge permission, automatic GitHub thread mutation, replacement-session launch, workflow repair action, or independent message loop. Do not change CI, release, signing or deployment configuration. Human-origin threads remain outside CodeRabbit classification even when the bot replies to them.

An active or parked non-terminal workflow holds delivery. CodeRabbit observation may continue, but this phase does not try to make that workflow relinquish ownership.

## Repository findings and inherited contracts

- `src/server/inspector/worker.ts`: adoption is already independent of Inspector enablement. The tick currently requires Inspector enabled; `processPr` reads the PR before expensive reviews, records head/state, retires non-open rows and invokes existing merge handling. Preserve that lifecycle while separating observation authority from review/posting authority.
- `src/server/inspector/github.ts`: `PrSnapshot` has first-page threads and pagination information. `ThreadSnapshot.comments` retains login, body and creation time, but not bot actor type, root URL or update time. The later-page query only asks for the root comment. Preserve Inspector's own full first-page/reply needs while making CodeRabbit root metadata consistent across pages.
- `src/server/foreman/review-followup.ts`: `followupPrs`, `decideReviewFollowup`, `activeWorkflowOwnsSession`, `advanceFollowupMark` and `buildPayload` already enumerate per-PR work and apply policy. Existing Inspector and CI deduplication clocks must not be collapsed into a new aggregate hash.
- `src/server/foreman/worker.ts`: `runReviewFollowup` reads ownership, refreshes session/config before sending, claims at most one prompt per session per pass and excludes touched sessions from other work. Its existing mark map is transient and cannot be CodeRabbit's durable authority.
- `src/server/routes.ts` and `src/server/foreman/client.ts`: daemon injection already reports proven non-delivery, reserves daemon-origin attribution and selects the runtime path. The ship-recovery claim route is precedent for rebuilding eligibility from daemon-owned state; it is not a second state store to repurpose for CodeRabbit.
- `src/server/registry.ts` owns projections and equality checks. `TaskRepoPrSummary.feedback` carries live sibling-PR feedback; durable work-episode PR facts alone cannot authorize a send.
- `src/shared/protocol.ts`, `src/shared/types.ts`, `src/shared/app-config-entries.ts`, `src/server/shipping/config.ts`, `src/web/useShipping.ts` and `ShippingSettingsPanel.tsx` provide the existing schema/config/projection/UI paths. Use one Shipping setting and the existing settings backup registry.
- `src/server/db.ts` owns schema upgrades. New tables or columns must be safe for existing databases and indexed after their upgrade path exists. Foreman remains HTTP-only.
- `src/shared/shipping.ts` and `src/server/shipping/merge.ts` own merge decisions. CodeRabbit observation must never become an Inspector clean-review receipt, resolve an Inspector finding, or bypass a merge veto.

No contract is inherited from another implementation phase because this phase owns the full feature.

## Implementation steps

### 1. Pin the behavior with focused fixtures

Add proposed tests `test/code-rabbit-feedback.test.ts`, `test/code-rabbit-delivery.test.ts` and `test/code-rabbit-worker.test.ts`, adapting names to current conventions if needed. Extend existing follow-through, shipping, multi-repository and settings tests where their fixtures already represent the boundary.

Prepare fake GraphQL pages with CodeRabbit Bot root authors, human roots with bot replies, missing authors, misleading logins, resolved and unresolved outdated threads, changed root findings, unchanged roots with new replies, page-2 findings and malformed pageInfo. Fake all agent and provider binaries in runtime tests.

### 2. Add additive contracts and the single setting

Extend `ShippingConfigSchema` with default-false `codeRabbitAutoResolve`; the existing partial patch, config store and backup registry remain its owners. Verify older snapshots and partial patches retain unrelated settings.

Define browser-safe observation and delivery summaries with explicit known/unknown status, last successful observation, latest failure, observed PR/head identity, unresolved count and delivery explanation. Keep CodeRabbit separate from Inspector finding counts and review-round provenance. A missing field from old rows/builds becomes unknown.

Extend the existing live PR feedback projections, not durable ownership facts masquerading as liveness. The single-repository and attached-repository paths must carry equivalent CodeRabbit information. Keep schema validation at HTTP and persisted JSON boundaries.

### 3. Build complete, bounded provider observation

Extend the existing GraphQL adapter with root comment actor type, stable id, URL and update/change identity. Classify only a Bot with exact normalized login `coderabbitai`; normalization may remove one terminal `[bot]` suffix, never arbitrary text. Use the first comment only. A required identity field that cannot be read prevents a complete affirmative observation.

Traverse review-thread pages using the existing provider seam. Detect missing/repeated cursors and malformed connections. Set documented finite page, total-byte and elapsed-time limits, with tests at each boundary. No partial result may become a zero count or an eligible delivery.

Preserve unresolved outdated threads. Use root update metadata and a bounded digest for change identity; a later reply alone does not re-arm a finding. Retain identifiers and bounded metadata rather than arbitrary review bodies. Preserve Inspector's existing author, marker, reply and review-publication behavior.

### 4. Persist observations and finding generations in the daemon

Add observation/generation storage as an extension of the existing canonical adoption key in `src/server/db.ts`. Do not create a separately discoverable PR inventory. A complete successful snapshot records PR state, draft state, head, observation time, completeness and per-thread metadata.

For each known root finding, preserve a monotonic generation. Increment for a new unresolved finding, a changed root finding or a resolved-to-unresolved transition seen across complete observations. Include resolved threads in reconciliation so reopening can be recognized. A failed or incomplete read does not delete or resolve prior thread state and does not advance a generation.

Keep last successful data for explanation, but store the latest failure/unknown state independently so a failed newer read immediately disables delivery. Do not refresh a success timestamp merely because the same cached row was read. At daemon startup persisted observations are display history until a current-process successful poll refreshes them.

Bound active state without discarding spent identities needed by the same active PR/conversation/episode. Prune superseded generations only when an old claim's delayed result cannot alter the current generation. Tie final cleanup to existing adoption/session lifecycle; do not introduce session eviction or infer durable cleanup from `state === "exited"`.

### 5. Separate observation from Inspector review authority

Adjust the existing Inspector tick to run when Inspector or the new Shipping setting is enabled. Read both controls for each PR and recheck before entering actuation. With both off, preserve inert behavior.

Perform one shared base PR observation per tick and complete CodeRabbit pagination only when that source is enabled. Record CodeRabbit state before lengthy Inspector work. Reuse this snapshot within the tick; pagination is additional pages of the same observation, not a second poller.

With Inspector off, stop after observation/retirement/projection work. Do not invoke review models, post/reply/resolve on GitHub, or promote any prior dry-run review. Existing Inspector-on review and merge logic keeps all of its current consent checks. Capture provider failures as unknown for CodeRabbit without manufacturing new Inspector findings.

### 6. Add durable claims and guarded delivery

Persist CodeRabbit claims keyed by canonical PR, stable conversation identity and current intent episode, with the exact batch of thread generations, observed head/version, claim id, timestamp and outcome. Choose an additive table or validated record that keeps these semantics explicit and bounded. Do not use the in-memory follow-up map as write authority.

A daemon-owned claim operation resolves current session/episode/repository ownership and rebuilds the complete eligibility policy. Require the source switch, a current-process complete and fresh observation, open non-draft PR, matching head/association, invitation, messaging capability, Foreman Live/trust, no human/input wait, no queued work and no active workflow. For sibling PRs verify the target repository's trust as well as the session's send permission.

Use a documented freshness window derived from the polling interval. Retained success is never sufficient after a newer error, after startup without a fresh observation, or after a known newer head. An unreadable prerequisite is a hold, not permission.

Atomically claim only unhandled current generations before attempting transport. Concurrent calls have one winner. Revalidate any state that can change while waiting for the existing message/pane lock at the daemon send boundary. The delivery must be bound to its exact claim, not accept arbitrary worker-supplied text or booleans as proof. Prefer a guarded claim-and-deliver operation that reuses the existing injection implementation, or an exact claim token checked by that implementation; do not duplicate transport logic.

Preserve daemon-origin attribution and runtime support. Record success as spent. If transport positively confirms nothing was delivered, release only that claim's exact generations for retry. A timeout, lost response or crash after claiming remains spent/uncertain. Restart must not replay it. A delayed response from an old claim must not clear a newer claim or generation.

Setting changes off/on, head-only pushes, observation order and shrinking sets never clear handled identities. New findings and newly observed generations remain actionable. Manual messaging stays available for uncertain delivery; no automatic retry button or new operator workflow is required.

### 7. Integrate the existing Foreman pass and prompt

Extend the pure policy with a separate CodeRabbit source and consume the Shipping setting through the existing daemon client. Preserve the current Inspector and CI switches and clocks. CodeRabbit can act when those two source switches are off, but never when Foreman's overall permission is absent.

Feed durable observation/claim state to the policy. Use the guarded daemon delivery seam for CodeRabbit-containing prompts. Combine other currently actionable feedback for the same PR where practical, stamping the corresponding existing marks consistently with the delivery result. Do not consume another PR's marks.

Keep primary-first enumeration and one nudge per conversation per pass. Add both pre-refresh and post-refresh session identities to the touched set on delivered or uncertain sends; positive refusal may release the slot under existing policy. A worker or daemon restart cannot clear CodeRabbit's spent identities.

The bounded prompt names the repository, checkout, exact PR and thread links; distinguishes CodeRabbit from Inspector/CI; tells the agent to fetch the complete unresolved review-thread list; and requires judging findings, focused validation and fixes pushed to the existing branch. Truncation must disclose the total. Treat comment content as evidence, never instructions that override the task or repository. Follow the repository's repair policy rather than requesting a full test rerun for each review fix.

### 8. Project status and build the Shipping control

Update Registry projections and equality comparisons so primary and sibling PR feedback changes reach the existing session/SSE paths. Continue to clear live feedback on a positive closed/no-open observation; do not retract durable PR associations. Error observations hold eligibility while retaining truthful history.

Use the existing Shipping hook/config API and settings restore paths. Add the labelled default-off control, unavailable-config state and Foreman prerequisite copy/links. Do not add a Foreman setting or a new browser poller.

Extend existing Shipping PR rows/ConsoleTable with the CodeRabbit unresolved count and observation/delivery explanation. Known zero, unknown/error, waiting for eligible owner, workflow-owned and uncertain delivery must be distinguishable. Preserve the merge-block column's truth; no CodeRabbit status may imply that GitHub's merge gates passed.

Add a focused Playwright spec at proposed path `e2e/specs/shipping-coderabbit-followup.spec.ts`. Exercise the built dashboard and daemon with fake agents/GitHub, select by accessible names, and assert visible behavior rather than markup alone. No new modal is needed; if the implementation adds one, follow the repository's modal verification contract.

### 9. Finish compatibility checks and documentation

Verify existing databases reopen and preserve adoption/review/merge state, old settings defaults remain off, settings backups restore the new field, and closed/unknown rows never prompt. Include a focused regression for unaffected Inspector/CI behavior and every existing merge veto.

Update README and the relevant sections of `docs/inspector-and-shipping.md`, `docs/foreman.md`, `docs/configuration.md` and the architecture/change guides where ownership or stored contracts changed. Explain independence from Inspector/YOLO, Foreman prerequisites, polling delay, workflow holds and uncertain delivery. Keep generated files on their generator path.

## Data, API and compatibility details

The approved public setting spelling is proposed as `codeRabbitAutoResolve`; keep one source of truth in Shipping. Observation status, finding generations and delivery outcomes are distinct records even if stored together physically. A consumer must not use a last-success count without checking current completeness and freshness.

Persist explicit claim identity rather than a global hash of unresolved ids. If one of two handled threads resolves, the remaining handled thread is not new. A second PR on the same conversation has its own identities. Replacing the task episode requires fresh ownership validation; an old claim cannot authorize or consume a new task's work.

Claim routes are internal daemon/Foreman seams, protected and schema-validated like existing routes. Shared code contains no Node imports. Runtime delivery uses existing capabilities and `injectPromptForRuntime`/write policy rather than agent-name branches. Foreman never imports the database.

Schema version and concrete migration names must be taken from current main at implementation time. Add indexes after required columns/tables exist; test both fresh and upgraded fixture databases. Do not backfill an old observation as current proof or an old Inspector finding as CodeRabbit feedback.

## Tests and verification

Use AGENTS.md's canonical isolated single-file invocation for each focused test file; do not invent another preload/environment convention.

- Classifier/pagination: exact Bot/root matching, suffix normalization, unknown actor, misleading login/body, human root with bot reply, unresolved outdated thread, resolved thread, page 2, malformed/null connection, cursor loop, page/byte/time caps and provider failure.
- Observation/store: new finding, root edit, ordinary reply, resolved then reopened, head-only change, reordered and shrinking sets, failure after success, daemon restart requiring a fresh poll, old-database migration and bounded cleanup with in-flight claims.
- Delivery: concurrent claim winner, duplicate request, successful send, proven refusal retry, uncertain outcome, restart, old-result/new-generation race, flag/trust/invitation/workflow/owner/head changes at the delivery boundary.
- Policy/routing: all existing idle, awaiting-input, queue, capability, Foreman consent and workflow gates; two repositories with same PR number; primary/sibling isolation; one prompt per conversation; existing Inspector and CI behavior; terminal and SDK transport.
- Worker integration: fake provider proves CodeRabbit-on/Inspector-off observation, zero Inspector model calls and zero GitHub writes; both off inert; enabled Inspector retains its existing behavior; a new finding prompts exactly once through the real daemon claim/delivery seam.
- Browser: toggle and reload/restore; unknown config; Foreman prerequisite; unresolved count changing to zero; error distinguished from zero; workflow-held and uncertain status; eligible fake-agent prompt and no repeated prompt on an unchanged observation.

Run the new focused tests and relevant existing files: `test/foreman-review-followup.test.ts`, `test/foreman-invite-enforcement.test.ts`, `test/inspector-diff-once-per-tick.test.ts`, `test/inspector-observation-migration.test.ts`, `test/shipping-merge.test.ts`, `test/shipping-panel-warnings.test.ts`, `test/multi-repo-policy.test.ts` and relevant settings-backup tests.

Run `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke`, and `npm run test:e2e -- e2e/specs/shipping-coderabbit-followup.spec.ts`. Complete the repository-required E2E verification before first handoff. Subsequent CI/reviewer repair rounds run only appropriate focused checks before pushing, following the standing repair instruction.

Capture the final focused command results and rendered Shipping evidence in gitignored paths and register them with the workflow when eligible. No evidence artifacts belong in the commit.

## Merge and exit criteria

- CR-1 through CR-8 pass with both the positive and negative cases above.
- Independent observation works without Inspector reviews or YOLO; no extra model/provider-write path has appeared.
- Durable claims survive restart and unknown delivery without replay; primary and attached repositories remain isolated.
- The visible Shipping setting and statuses match the daemon's actual eligibility.
- Existing merge authority, workflow ownership and Inspector/CI follow-through remain intact.
- Focused checks, typecheck, lint, build/smoke and required browser verification pass; docs match the implementation.
- One scoped, reviewable Mission Control PR is opened and follows the task's selected workflow. The phase is complete when that implementation PR has merged. Do not assume the planning task authorized merge for the implementation session.

## Downstream handoff

There are no later implementation phases. Future consumers may rely on one Shipping control, adoption-backed observations, per-finding generations and daemon-owned claims. They must not infer delivery from an unresolved count, infer openness from durable episode history, clear claims on toggle/restart, or use CodeRabbit as Inspector/merge authority.

If implementation discovers that a root requirement cannot be achieved within these ownership boundaries, surface that conflict. Do not silently remove a guard or broaden into workflow repair as an adaptation.

## Cross-phase audit record

Audit date: 2026-10-28. Compared this file with the complete root plan and index after authoring.

- CR-1 through CR-8 all belong to this phase; no requirement is postponed to an unstated cleanup task.
- The approved independent Shipping switch is reflected in both observation and UI steps.
- The root's unknown-read and uncertain-send semantics are preserved by separate observation status and claim outcomes.
- Worker mark maps stay with Inspector/CI; CodeRabbit's restart guarantee belongs to daemon state.
- Per-repository trust, live feedback, same-PR payloads and the conversation-wide send limit agree with the existing multi-repository contracts.
- Direct dependency is planning-session publication only. There are no parallel phase claims, cross-repository code dependencies or consumers of an unmerged preparation phase.
- This is a planning repair. No feature implementation, schema migration or runtime test is claimed to have run in the planning session.
