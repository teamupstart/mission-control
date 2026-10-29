# CodeRabbit follow-up in Shipping

Issue: [teamupstart/mission-control#1224](https://github.com/teamupstart/mission-control/issues/1224)
Planning date: 2026-10-28. Repository: teamupstart/mission-control.
Status: root scope approved in revision 2; complete phase bundle prepared for final review. This is a plan, not an implementation.

## Outcome

When an adopted open pull request has unresolved review threads opened by CodeRabbit, Mission Control should prompt its eligible owning session to investigate and fix them. An off-by-default setting in Settings > Shipping controls this behavior independently of YOLO auto-merge. The session keeps working on the same pull request and branch.

“Auto-resolver” means automatically asking the session to handle feedback. The polling service does not apply suggested patches, post replies, resolve GitHub threads, or grant merge permission.

## Adopted decisions and review scope

Human decision on 2026-10-28: use an independent Shipping setting. CodeRabbit observation must work with Inspector reviews off, through the existing daemon poll owner, without triggering Inspector model calls or writes.

The proposed scope is GitHub review threads on Mission Control's adopted PRs, including PRs in attached repositories. Top-level review summaries and issue comments have no thread-resolution state and are excluded. An unresolved outdated thread still counts: outdated is not resolved. Human threads that CodeRabbit replies to do not become CodeRabbit-owned.

The setting authorizes a follow-up through existing Foreman controls. Foreman must be enabled and Live, invited into the session, and trusted for the PR's repository. An active or parked non-terminal workflow retains exclusive ownership; detection continues but delivery waits until it releases ownership. This feature does not add a workflow repair route or resume an absent session.

Human decision recorded in review 487d260a-88dc-4e6c-ad4b-601cafe30d0b: approve the root bundle and create the phased implementation plan with dependency-linked tasks. This supersedes revision 2's statement that phasing was not yet authorized. The selected follow-up is incorporated in [the implementation index](phased-plan.md) and [Phase 1](phase-1-coderabbit-follow-through.md). One dependency-linked implementation task will carry the complete feature. The completed phase bundle receives its own exact-revision approval.

## Repository findings

These are verified from the current checkout, not assumptions about new APIs.

- `src/server/inspector/worker.ts` adopts PRs even when Inspector is disabled, but its polling loop currently runs only when Inspector is enabled. Its default interval is 90 seconds. `processPr` records observed head and state before review work.
- `src/server/inspector/github.ts` already reads review threads and root comment authors through GraphQL. Its initial query reads 100 threads; later-page support exists for Inspector-owned thread checks but is not a complete CodeRabbit observation. Reuse that provider adapter and pagination machinery.
- GitHub GraphQL on repository PRs #1223 and #1227 returned root authors with `__typename: Bot` and `login: coderabbitai`. The current adapter retains login but not actor type. Add actor type before relying on bot classification.
- `src/server/foreman/review-followup.ts` and `worker.ts` own PR follow-through. They already use settled idle, invitation, trust, human-input, queue and workflow gates, refresh before delivery, and one prompt per session per pass. Their existing Inspector/CI marks are in memory; those marks alone cannot provide restart-safe CodeRabbit deduplication.
- `followupPrs` enumerates a session's primary and attached-repository PRs. `TaskRepoPrSummary.feedback` is a live observation; durable `prState` is not sufficient proof a sibling PR is still open.
- `ShippingConfigSchema`, `src/server/shipping/config.ts`, the shipping config routes, `useShipping.ts`, and `ShippingSettingsPanel.tsx` already provide the setting's persistence and UI path. Schema defaults upgrade older config blobs.
- `src/server/db.ts` owns migrations and durable writes. Foreman is a separate HTTP-only process and must never open SQLite.
- Repository and managed-local plan catalogs were checked. No existing plan for issue #1224 was found. Related Foreman ship-shepherd and multi-repo plans describe existing boundaries, not an alternative source plan for this feature.

## Requirements and acceptance criteria

### CR-1: A separate, persistent Shipping setting

Add a proposed `codeRabbitAutoResolve: boolean` to Shipping config, default false. Settings > Shipping labels it “Follow up on CodeRabbit comments” and explains that it prompts the owning session. It saves through the existing config API, survives reload and settings restore, and does not change YOLO, Inspector posting consent, or Foreman consent.

The UI reports unknown when config cannot be read. When enabled but Foreman is unavailable, disabled, or in dry run, explain the unmet prerequisite and link to the existing Foreman controls. Per-repository trust and per-session invitation remain delivery checks, not new switches.

Acceptance: old saved config remains off; toggling persists; YOLO can remain off; disabled or unreadable configuration cannot authorize a new prompt.

### CR-2: Observe only known, owned PRs through the existing poller

Use the Inspector adoption ledger as the PR set. Do not scan all repository or account PRs. Keep one daemon poll owner, the existing interval and bounded sequential work. Attached repositories are part of the same adopted set.

Run the existing poll loop when Inspector or CodeRabbit follow-up is enabled, but enter Inspector review/posting code only with Inspector's own consent. CodeRabbit-only operation is read-only toward GitHub. Both off means no additional observation work. YOLO remains independently gated.

Capture CodeRabbit state before expensive Inspector review work. Re-read effective settings during a sweep and before acting. A closed, merged or draft PR is ineligible for delivery. A PR with no live, eligible owner is observable but receives no prompt and launches no replacement session.

Acceptance: a fake provider proves one observation path; enabling CodeRabbit alone never spawns Inspector's model or calls GitHub write APIs; unrelated PRs and departed sessions are not acted on.

### CR-3: Precise and complete thread detection

A qualifying thread is unresolved and its first comment was authored by the CodeRabbit bot. Require actor type Bot and the exact normalized login `coderabbitai`, allowing an explicit terminal `[bot]` suffix for REST-style fixtures. No substring matching, display-name matching, or body matching. Missing actor data is unknown rather than an affirmative match.

Follow all thread pages, with repeated/missing-cursor detection and bounded page, response-size and elapsed-time limits. An implementation should choose and document concrete limits alongside tests. If any limit or provider error prevents a complete read, publish unknown/error status, retain the last successful observation for explanation, and prohibit delivery from it. A missing or malformed required connection is not an empty result.

Retain stable thread ids, root comment ids, links, paths, root comment change identity, resolution state, observed head, observation time and completeness. Avoid retaining whole comment bodies when ids and bounded hashes suffice. Root-comment edits can be detected with `updatedAt` plus a body hash; ordinary replies do not change the root finding's identity.

Acceptance: cover page 2, empty responses, human-origin threads with bot replies, deleted authors, misleading usernames, resolved threads, unresolved outdated threads, provider errors and cursor loops.

### CR-4: Deliver through existing ownership and send policy

Extend the PR follow-through policy and fleet pass with a third feedback source. The CodeRabbit switch controls that source even if Inspector-comment and CI tracking switches are off. Preserve the other two sources' behavior.

Require a fresh, complete observation for the exact PR and observed head; refresh through the existing poller after startup before sending. Use a bounded freshness window derived from the polling interval. A failed newer read immediately invalidates CodeRabbit delivery eligibility, even if the prior observation has not aged out.

Resolve the current owning session and its repository worktree, current intent episode and PR association. Recheck Shipping config, Foreman live/trust/invitation, readiness, queues, workflows and observation identity at the daemon delivery-claim boundary. For an attached repository, check that repository's trust and ownership as well as the current session's send permission. Unknown ownership holds.

Combine simultaneous Inspector, CI and CodeRabbit feedback for one PR into one prompt where practical. Preserve one prompt per conversation per pass and the touched-session exclusion before ship recovery or other Foreman work. Use shared messaging predicates and existing terminal/SDK delivery; do not branch on agent names or create an independent injection loop.

Acceptance: busy, awaiting-input, uninvited, untrusted, queued, exited, workflow-owned and stale-observation cases send nothing. Removing a grant or changing ownership between decision and claim refuses delivery. Two PRs on one session keep independent feedback state and never receive interleaved prompts.

### CR-5: Restart-safe duplicate suppression

Add a daemon-owned durable CodeRabbit delivery record keyed by canonical PR, stable conversation identity and intent episode. This is the sole CodeRabbit delivery state, not a second PR inventory. Keep existing Inspector/CI state intact.

Track handled finding generations individually: a newly observed unresolved thread, a changed root finding, or a resolved-to-unresolved transition observed by complete polls is new work. A push alone, unchanged poll, reordering, another thread's resolution, or a worker/daemon restart is not new work. A close/reopen transition never authorizes reuse by a different session or episode.

Claim the batch of unhandled generations atomically before injecting. A repeated claim cannot send twice. Confirmed non-delivery releases only that exact claim; success or an uncertain send leaves it spent. Changing settings off and on must not clear spent claims. A stale claim must not suppress a genuinely newer generation. Unknown delivery is visible as “delivery uncertain”; leave manual messaging available rather than automatically retrying it.

Keep the record bounded through existing PR/session lifecycle ownership, retaining enough history while the PR is active to prevent replay. Startup must reconcile saved claims and require fresh provider observation. Do not promise exactly-once transport: this policy chooses no automatic replay when delivery may have happened.

Acceptance: identical polls and restart produce one prompt; a genuinely new finding produces another; shrinking unresolved sets and head-only changes do not. Concurrent claims have one winner. Proven refusal retries; lost-response delivery does not.

### CR-6: A useful, bounded session instruction

The prompt identifies the repository, checkout, PR URL and current unresolved CodeRabbit thread links. If the list is too large, include a bounded sample plus the total and explicitly require loading the complete unresolved thread list.

Tell the session to assess each finding against the code, fix valid in-scope defects, explain invalid findings, run focused checks, commit and push to the same branch, and follow the review to resolution. It must not silently change the task's intended behavior to satisfy a comment. Repository rules still govern replies and resolution. Do not imply `gh pr view --comments` alone contains line review threads.

The daemon treats external comment text as data; the prompt makes the repository and task instructions authoritative. No model is called just to decide whether feedback exists.

Acceptance: primary and attached-repository payloads target the correct PR; the prompt includes safe validation and same-branch instructions; no daemon-side GitHub mutation is introduced.

### CR-7: Truthful, modest visibility

Keep the feature's control and explanatory status in Shipping. Reuse existing Inspector PR rows and ConsoleTable layout to show CodeRabbit unresolved count and the last observation/delivery state, including unknown, waiting for an eligible session, workflow-owned and delivery uncertain. Keep merge-block reasons intact. No separate dashboard, second ledger table UI, new navigation destination or browser poller.

Use additive shared contracts and existing session/SSE and settings data paths. A record absent from an older database/build is unknown. No new setting belongs in Foreman's config as a second source of truth.

Acceptance: the visible count follows provider changes; unknown is distinguishable from zero; the UI explains a held prompt without suggesting the PR is safe to merge.

### CR-8: Compatibility and verification

All merge gates remain unchanged, including unresolved human review threads, workflow vetoes, CI, Inspector posture, trust and compare-and-swap head checks. CodeRabbit feedback never becomes an Inspector finding or a clean-review receipt.

Focused unit/integration tests cover the new source, migrations, parsing, claims, races, restart, settings upgrades and multi-repository projection. Add a Playwright spec for the Shipping toggle and visible behavior through fake GitHub and fake agents; no real model calls or external writes. Use accessible selectors and the repository's existing fixture helpers.

Update README plus `docs/inspector-and-shipping.md`, `docs/foreman.md`, and relevant configuration/contract documentation. Do not change release, signing, CI or deployment settings.

## Flow

Before: GitHub -> Inspector's enabled polling loop -> Inspector observation/review ledger -> Registry -> Foreman follow-through for Inspector findings or CI -> eligible owning session.

After: Shipping config -> the same daemon poll owner; GitHub -> complete CodeRabbit thread observation -> adoption-backed projection and durable delivery claims -> Foreman follow-through -> existing session message path. The session handles fixes on the same PR; later GitHub observations close or update the feedback. Inspector review/posting and Shipping merge decisions remain separately gated. The browser consumes existing config and projection routes plus SSE.


## Implementation route

Use additive fields in the existing Shipping schema and PR projections. Isolate provider classification/pagination and the pure decision logic so fixtures can exercise them without GitHub. Add durable observation and claim storage near the adoption ledger in `src/server/db.ts`, with migration helpers adjacent to schema changes. Put read/claim HTTP seams under existing daemon ownership and consume them from Foreman's client.

The approved phased follow-up is organized as one coherent implementation phase. Its sizing estimate, dependency graph and requirement ownership are in [the implementation index](phased-plan.md); detailed implementation and verification steps are in [Phase 1](phase-1-coderabbit-follow-through.md). Observation, durable delivery and the usable Shipping control land together. No additional preparation, UI-only or cleanup phase is required.

## Verification strategy

The implementation phase must run focused tests with the canonical isolated test invocation from AGENTS.md. Target existing follow-through, Inspector polling, shipping merge and settings tests as well as new CodeRabbit parsing and durable delivery tests.

Run `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke`, and the new focused Playwright spec; run the required E2E suite before first implementation handoff. During later CI or reviewer repair, use the focused tests for the actual fix and push, following the repository's repair policy.

This planning turn validates Markdown/HTML consistency, static offline rendering, source paths, policy-eligible publication paths, and the dependency graph if requested. It does not claim the proposed feature or its future tests already exist.

## Alternatives considered

- Require Inspector to be enabled: smallest poller change, but users must enable another reviewer to receive CodeRabbit prompts.
- Reuse the existing daemon poll owner with an observation-only path: preserves a single provider adapter and lets the Shipping control do what it says without adding model calls.
- Add a separate Shipping poller or let Foreman call GitHub: rejected because it duplicates remote state and violates daemon/Foreman ownership.

## Boundaries and known limits

No general review-bot framework, per-bot customization, GitHub Enterprise host expansion, webhook server, top-level-comment scraping, unattended thread resolution, automatic task redispatch, or new workflow repair action. An active workflow can hold delivery indefinitely; this is an explicit ownership boundary. No changes to merge authority or existing review budgets.

GitHub thread updates are observed on the existing polling cadence, not instantly. Rate limits, pagination limits or unavailable credentials hold delivery and remain visible. A root finding changed and reverted entirely between polls cannot be detected; the source is the snapshots GitHub supplies.

## Planning publication

The managed creation policy is repository storage with generated HTML excluded from Git. Only the returned required Markdown paths may be committed and pushed. Renderings remain in the exact managed revision and must be reviewed there.

The selected Plan Validation workflow owns publication. After human approval, complete and push the scoped plan artifacts, schedule any requested phases with a dependency on this planning session, register full-text review evidence and yield. Do not create/update a PR, monitor PR CI or merge in this planning turn. A planning handoff does not release phase tasks; the planning PR's merge does.

## Sources

- Current implementation: `src/server/inspector/github.ts`, `src/server/inspector/worker.ts`, `src/server/foreman/review-followup.ts`, `src/server/foreman/worker.ts`, `src/server/foreman/client.ts`, `src/server/registry.ts`, `src/server/db.ts`.
- Contracts and UI: `src/shared/protocol.ts`, `src/shared/types.ts`, `src/web/useShipping.ts`, `src/web/components/ShippingSettingsPanel.tsx`, `docs/agent-guides/architecture.md`, `docs/agent-guides/change-contracts.md`, `docs/managed-plans.md`, `e2e/README.md`.
- [GitHub GraphQL review-thread reference](https://docs.github.com/en/enterprise-cloud%40latest/graphql/reference/pulls): resolution and outdated state are distinct fields.
- Direct authenticated GitHub read of issue #1224 and root review authors on PRs #1223 and #1227, using account Jordan7265. No external writes were made.
