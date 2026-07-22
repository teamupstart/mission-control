# Phase 5 plan: Inspector final gate and PR repair policies

Status: **implementation-ready**

Parent: [Persona-driven workflow builder](./plan.md)

Prerequisites:

- [Phase 1 foundation and Personas](./phase-1-foundation-personas.md)
- [Phase 2 builder and publishing](./phase-2-builder-publishing.md)
- [Phase 3 bindings, context, and manual preview execution](./phase-3-preview-engine.md)
- [Phase 4 live repair delivery and Foreman completion](./phase-4-live-foreman.md)

## Outcome

A published workflow can require an adopted pull request to pass Inspector after the Persona graph
succeeds. The workflow waits on Inspector's existing adopted-PR and finding ledgers, pins one current
PR head, completes when that head has a completed review with no open findings, and returns one
deterministic Inspector repair packet to the Session when findings remain.

The workflow author chooses whether repaired work reruns every Persona or bypasses Personas and
returns directly to Inspector after a new pushed head. Inspector remains a separate asynchronous
daemon subsystem and the sole owner of GitHub polling, review execution, marker parsing, comment
posting/resolution, and PR adoption. The workflow engine adds no GitHub poller and performs no GitHub
write.

## Prior-phase prerequisites

Phase 5 consumes:

- the immutable `WorkflowCompletionPolicy` published in Phase 2;
- Phase 3's successful End, evidence head, repair rounds, submission modes, run timeline, and SSE;
- Phase 4's exact-payload delivery state machine for `inspector_feedback` and PR handoff prompts;
- Inspector's existing `inspector_prs` adoption ledger and `inspector_comments` provenance ledger;
- only the two existing adoption proofs: a hook with `prCreated` and `NmRunSummary.prUrl`.

Run all workflow suites from Phases 1 through 4 plus `inspector-adoption.test.ts`,
`inspector-marker.test.ts`, `inspector-plan.test.ts`, `inspector-posture.test.ts`, and
`shipping-merge.test.ts` before implementation. Any adoption, comment-dedup, delivery-ambiguity, or
current-head regression blocks this phase.

## Scope

### Included

- Existing-table migration for scrubbed Inspector finding bodies.
- An internal Inspector observation/update signal with no new poll loop.
- Final-gate PR resolution, provenance validation, fresh observation, and head pinning.
- Wait/block reasons for missing, unadopted, disabled, stale, mismatched, failed, and closed PR state.
- Clean-current-head completion and deterministic finding repair packets.
- Explicit missing-PR handoff action.
- `restart_workflow` and `inspector_only` repair policies.
- New-head enforcement and visible Persona-bypass audit.
- A Shipping veto while an active workflow final gate owns a PR.
- UI for gate state, PR/head provenance, Inspector posture, findings, repair policy, and recovery.

### Deferred

- Retention pruning, cost attribution, notifications, canvas polish, and final accessibility work:
  Phase 6.

## Existing Inspector contract remains authoritative

Do not move Inspector, call its model from `WorkflowEngine`, or copy its GitHub client. The final
gate is an adapter over durable facts Inspector already owns:

- `InspectorPr` row existence proves Mission Control opened the PR.
- `InspectorPr.headSha` is the head of the last completed review.
- `InspectorPr.lastAttemptSha` is the last head Inspector started or observed work against.
- `InspectorPr.lastError` and backoff fields explain why review has not completed.
- non-resolved `InspectorComment` rows are findings still carried by the ledger.
- `InspectorPr.reviewPosture` states whether that completed review was live, dry-run, or not
  allowlisted.

`session.prUrl` is only a lookup hint. It may select a key that must already exist in
`inspector_prs`; it can never create or adopt a row. Do not call `adoptPr` from any workflow path.
Keep the provenance tests pinning that `prCreated` and `NmRunSummary.prUrl` are the only inputs to
adoption.

## Persist scrubbed finding bodies

Extend `InspectorComment`:

```ts
export interface InspectorComment {
  // existing fields
  body: string | null;
}
```

Add nullable `body TEXT` to the existing `inspector_comments` table in both places required by the
database contract:

1. the `CREATE TABLE IF NOT EXISTS` block for new installs;
2. `addColumn(d, "inspector_comments", "body", "TEXT")` in `migrate()` for existing installs.

Do not put backticks in the SQL block's comments. Update the row interface/parser, insert/upsert SQL,
fixtures, and all `InspectorComment` builders. A new or regressed finding stores the already-scrubbed
`PlannedComment.body` produced by `planReview`; it never stores the raw model body. Resolution keeps
the last body for audit. Older rows parse `NULL` and render a fallback from severity, title, path,
and line without inventing detail.

The body remains local workflow/Inspector data. Existing public posting still renders from the same
scrubbed planned comment, and no new route exposes raw model output.

## Gate state contracts

Extend Phase 3's run contract:

```ts
export type WorkflowRunStatus =
  | "capturing"
  | "running"
  | "waiting_for_session"
  | "waiting_for_pr"
  | "waiting_for_inspector"
  | "waiting_for_new_head"
  | "blocked"
  | "completed"
  | "cancelled"
  | "failed";

export type WorkflowGateWaitReason =
  | "missing_pr"
  | "unadopted_pr"
  | "inspector_disabled"
  | "awaiting_fresh_observation"
  | "working_tree_not_pushed"
  | "head_mismatch"
  | "review_pending"
  | "review_backoff"
  | "review_error"
  | "findings"
  | "pr_closed";

export interface WorkflowInspectorGateState {
  prKey: string | null;
  prUrl: string | null;
  targetHeadSha: string | null;
  failedHeadSha: string | null;
  enteredAt: number;
  lastObservedAt: number | null;
  observedHeadSha: string | null;
  reviewPosture: InspectorPosture | null;
  waitReason: WorkflowGateWaitReason | null;
  findingFingerprints: string[];
}
```

Persist gate state in the Phase 1 `workflow_runs` table using its pinned Inspector PR/head fields and
bounded gate-state JSON. Since Phase 1 creates that table before Phase 5, front-load the JSON column
there rather than adding a later migration to a workflow table.

## Fresh Inspector observation signal

A workflow gate must not approve a stale reviewed head while GitHub may already hold a newer push.
At the same time, it must not create another PR poller. Add a server-internal observation contract:

```ts
export interface InspectionUpdated {
  prKey: string;
  observedHeadSha: string | null;
  observedState: "OPEN" | "CLOSED" | "MERGED" | null;
  observedAt: number;
  ledger: InspectorInspection;
}
```

`processPr` already calls `fetchPr` even while model review is backed off. Return or emit the current
snapshot after that fetch and refresh the ledger after the PR pass. `Registry` exposes an internal
`onInspectionUpdated` subscription beside `onPrOpened`; it is not a `ServerEvent`. The browser still
learns gate changes only through compact workflow-run SSE.

Emit:

- after a newly adopted PR refresh, with no observed head yet;
- after every successful `fetchPr`, even when the head did not change or review stays backed off;
- after a completed review or failure updates the ledger;
- after Inspector config changes, so a disabled gate can re-evaluate immediately.

The event carries no finding bodies. `WorkflowManager` rereads the ledger and comments from SQLite
when it handles the signal. The Inspector remains the single writer of Inspector tables.

Persist `enteredAt` on the gate and require an observation at or after it before pinning a target
head. If the daemon restarts after entry, it waits for Inspector's next normal sweep. A stale
pre-entry `headSha` is never enough by itself.

## Entering the final gate

When an immutable version has `{ kind: "none" }`, Phase 3 behavior remains exact: successful End
completes the run and Inspector proceeds independently.

For `{ kind: "inspector", ... }`, successful End calls one `WorkflowManager.enterInspectorGate`
transaction:

1. Persist the successful submission id, its captured local `headSha`, gate `enteredAt`, and the
   published findings/missing-PR policy.
2. Resolve the current live session and read `session.prUrl` only as a candidate.
3. If no candidate exists, wait `missing_pr`.
4. Parse the candidate and look up `InspectorPr`. If no row exists, wait `unadopted_pr`; never adopt
   it.
5. Pin `prKey` and URL, but not a target head yet. Reject switching to another PR without an explicit
   full-workflow restart.
6. If Inspector is disabled, set a visible `inspector_disabled` block with a direct Settings link.
7. Wait for an `InspectionUpdated` observation at or after gate entry.
8. Require the observed PR to be open and its head to equal the successful submission's captured
   local HEAD. A mismatch means the Persona verdict did not judge the PR's current commit.
9. Require the successful submission to report no staged, unstaged, or untracked changes outside
   that captured HEAD. Otherwise wait `working_tree_not_pushed` and require a commit/push plus a new
   full-workflow submission.
10. Pin the matching observed head as `targetHeadSha` and evaluate the ledger.

Phase 3 must therefore add `workingTreeDirty` and bounded status evidence to the immutable context
snapshot. Its branch diff continues to include committed, staged, unstaged, and untracked work for
Persona judgment; the separate dirty flag answers whether the captured HEAD alone represents all
of it.

The conservative re-review after commit is intentional. A Persona verdict over uncommitted content
cannot prove that a later commit or PR contains byte-identical content. The UI explains the required
sequence: commit and push, then resubmit the full Persona workflow.

## Evaluating one pinned head

After pinning, evaluate only the same adopted `prKey` and exact `targetHeadSha`:

- If the observed remote head changes, stop using every result from the old head. Under a normal full
  workflow, wait `head_mismatch` for a new full submission. Under Inspector-only repair, the new head
  is the expected transition described below.
- If `InspectorPr.state` is closed or the observation says closed/merged before workflow completion,
  block `pr_closed`. Never declare retroactive success after the gate was bypassed.
- If Inspector is disabled, block with `inspector_disabled` and wake on config change.
- If `InspectorPr.lastAttemptSha` is the target but `lastError` is non-null, show `review_error` or
  `review_backoff` with the existing retry time. Do not call Inspector directly.
- If `InspectorPr.headSha !== targetHeadSha`, wait `review_pending`.
- Once `headSha` matches, load non-resolved comments for the PR. `open`, `drafted`, and `posting` all
  remain findings; only `resolved` is closed.
- Zero non-resolved findings and no error complete the workflow.
- One or more findings snapshot their ids/fingerprints and render one repair packet.

An enabled dry-run or not-allowlisted Inspector still performs a local review and records `drafted`
findings. The final gate may consume that completed local judgment, but Run detail must label its
`reviewPosture` and never imply comments were published. The gate does not promote posture, enable
Inspector, or modify either allowlist. Shipping remains stricter and still requires a live-published
review.

## Deterministic Inspector repair packet

Extend `src/server/workflows/feedback.ts` with a separate Inspector template. It receives a frozen
snapshot of non-resolved `InspectorComment` rows and renders:

1. A fixed statement that Inspector reviewed the pinned PR head and found changes.
2. Original user goal and run/workflow identity.
3. PR URL, full target head, Inspector round, and review posture.
4. Findings sorted by blocker, major, minor, nit, then path, line, and fingerprint.
5. For each finding: severity, title, path/line, stored scrubbed body or explicit legacy fallback.
6. Policy-specific next steps.

`restart_workflow` tells the agent to fix, verify, commit, push, then signal completion so every
Persona reruns. `inspector_only` tells the agent that this published policy permits bypassing
Personas for this Inspector repair only, and requires a new pushed head.

The renderer deduplicates by fingerprint, strips terminal controls, applies the same per-field and
total caps as Persona feedback, and hashes the final bytes. It creates or reuses one
`WorkflowDelivery` with `kind: "inspector_feedback"`. Preview displays/copies it; Live uses Phase 4's
prepared/sending/delivered/refused/uncertain state machine. Never type directly from Inspector code.

## Missing PR handoff

The published `missingPrAction` means:

- `wait`: show why the gate cannot start and provide Open session only.
- `offer_prepare_pr`: additionally show **Prepare PR in session**. This remains a deliberate human
  action; entering the gate never pushes or opens a PR automatically.

The action renders a deterministic prompt asking the session to commit all reviewed work, push, open
the PR through the normal harness/no-mistakes path, and resubmit the full workflow. Add
`"pr_handoff"` to `WorkflowDeliveryKind` and send the prompt through the Phase 4 delivery state
machine. Once the operator chooses the handoff, transition the run from `waiting_for_pr` to
`waiting_for_session` with reason `pr_handoff`; the next Manual or Foreman completion creates a new
full-workflow submission. A PR handoff changes the evidence boundary, so it never resumes the old
Persona approval.

When the hook or no-mistakes later proves PR authorship, normal Inspector adoption emits
`InspectionUpdated`. An unadopted PR remains visibly refused even when `session.prUrl` points to it.

## Findings policy: restart full workflow

`restart_workflow` is the default and the safe path:

1. Snapshot findings and preview/deliver one Inspector repair packet.
2. Move the run to `waiting_for_session`; count one repair round only when the new submission begins.
3. Manual Submit or a Phase 4 Foreman completion creates a new `full_workflow` submission with a new
   context fingerprint and trigger key.
4. Rerun every Persona and Join from the immutable version.
5. Require the repaired session to be clean, committed, pushed, and observed on the same adopted PR
   head before re-entering Inspector.

Old Persona approvals, old Inspector findings, and the failed target head remain in history but
cannot activate the new submission.

## Findings policy: Inspector-only repush

`inspector_only` is a narrow published bypass, not an agent-selected shortcut:

1. Snapshot findings, set `failedHeadSha`, and preview/deliver the policy-specific repair packet.
2. Move the run to `waiting_for_new_head` and visibly set `bypassedPersonaReview: true` only after the
   bypass is actually used.
3. Continue consuming Inspector's normal observations for the same adopted `prKey`.
4. Refuse the failed head and every previously inspected repair head. The new observed head must be
   non-null and different from `failedHeadSha`.
5. On the new head, create an immutable `inspector_only` submission with trigger key
   `inspector-head:<run-id>:<head-sha>`, prior finding fingerprints, failed/new heads, and bypass
   reason. Create no Persona attempts or graph receipts.
6. Pin the new head and wait for Inspector's normal completed review.
7. Complete on zero findings, or repeat the repair/new-head loop on new findings until the workflow
   repair-round cap is reached.

A manual **Recheck Inspector** action calls the same evaluation and remains waiting until Inspector
has observed a new head. A Phase 4 Foreman completion received while waiting for a new head returns
`claimed: true` but creates no full submission; it records that the active policy still requires a
push. This prevents the old wrap-up path from bypassing the published gate.

Changing PR key, same-head retry, missing adoption, and round-cap exhaustion block visibly. The only
escape is an explicit human action to restart the full workflow, which creates a new full submission
and records that the published Inspector-only shortcut was abandoned.

## Prevent Shipping from bypassing the workflow

Inspector owns YOLO merge evaluation, but a clean Inspector review could otherwise merge a PR before
its bound Persona workflow completes. Add one pure veto to Shipping:

```ts
export interface MergeInput {
  // existing fields
  workflowGatePending: boolean;
}
```

Append `workflow-gate-pending` to `MergeBlock` and `MERGE_BLOCK_LABEL`, and check it before review/
finding readiness. `maybeMerge` obtains the boolean from a narrow
`WorkflowManager.blocksMerge(prKey)` callback passed into Inspector startup.

The callback returns true when an active binding/version with an Inspector completion policy owns
the adopted PR through either a pinned gate key or the bound live session's candidate PR URL. It
returns false for versions with no final gate and for completed, archived, or cancelled workflows.
It never makes a merge eligible; it can only veto.

This keeps the Inspector/Shipping tick as the only GitHub merge path. No workflow code calls
`mergePr`, reads checks, or creates a second shipping decision.

## Recovery and concurrency

- Subscribe `WorkflowManager` before starting Inspector so an adoption/observation cannot be missed
  during boot.
- On workflow recovery, rebuild gate subscriptions from durable run state and wait for the next
  Inspector signal. Do not synthesize a fresh observation from stale ledger timestamps.
- Serialize gate transitions per run. An Inspector signal, manual recheck, config change, and
  Foreman completion may arrive together; unique submission trigger keys and a gate compare-and-set
  allow only one transition.
- Snapshot finding fingerprints and bodies before creating a delivery. Later Inspector resolution
  never mutates an existing repair packet.
- Cancelling a run removes its Shipping veto immediately but retains audit rows.
- Reset uses Phase 3's `resetSession` cleanup for run, gate state, submissions, deliveries, and
  events. It never deletes Inspector's PR/comment ledgers, which outlive sessions.
- An Inspector process failure is a wait/block state. The workflow never marks it as a clean review
  or Persona fail.

## HTTP, SSE, and UI

Add parsed workflow actions:

```text
POST /api/workflow-runs/:id/prepare-pr
POST /api/workflow-runs/:id/recheck-inspector
POST /api/workflow-runs/:id/restart-full
```

Each takes a client request id and uses `parseBody`. `restart-full` requires typed confirmation when
abandoning an active Inspector-only repair.

Keep full gate/findings data on Run-detail HTTP. Extend compact `WorkflowRunSummary` only with:

```ts
gate: "none" | "waiting_pr" | "waiting_inspector" | "findings" | "clean" | "blocked";
gatePrNumber: number | null;
gateHeadShort: string | null;
reviewPosture: InspectorPosture | null;
```

Use the existing run-summary SSE upsert. Do not stream finding bodies or add browser polling.

Run detail shows:

- Final gate separate from graph nodes.
- Adopted provenance source, PR link, target/observed/reviewed heads, and observation time.
- Inspector enabled/mode/posture, review round, backoff/error, and Settings link.
- Finding cards with legacy-body fallback.
- Published findings and missing-PR policies.
- Preview/Live delivery state and exact repair/handoff packet.
- A conspicuous **Persona review bypassed for Inspector repair** banner and failed/new heads when
  Inspector-only is active.

The graph overlay leaves the successful End green and renders the final gate in the run header or a
separate footer stage. Do not add an Inspector node to React Flow.

## Implementation order

1. Add `InspectorComment.body` and the required existing-table migration, parser, upsert, and tests.
2. Add gate state/wait contracts, Phase 3 dirty-status evidence, `pr_handoff`, and schemas.
3. Add internal Inspector observation/update subscription and config-change wakeup.
4. Implement provenance-safe PR resolution, fresh observation, clean working-tree/head pinning, and
   ledger evaluation.
5. Add deterministic Inspector feedback and PR handoff renderers through Phase 4 delivery.
6. Implement full-restart findings flow.
7. Implement Inspector-only new-head flow and audited submissions.
8. Add Shipping's pure workflow veto and pass the narrow callback into Inspector startup.
9. Add run actions, summary SSE fields, detail UI, Settings links, and bypass labels.
10. Exercise restart, concurrency, Reset, disabled/error posture, and no-final-gate parity.
11. Update README with provenance, current-head, posture, policy, and Shipping-veto behavior.

## Tests

- `inspector-body-migration.test.ts`: fresh and upgraded schema, null legacy row, scrubbed body round
  trip, resolution retention, and no raw-body persistence.
- `workflow-inspector-gate.test.ts`: no policy, missing/unadopted PR, disabled Inspector, fresh
  observation, dirty worktree, head mismatch, pending/error/backoff, findings, and clean completion.
- `workflow-inspector-update.test.ts`: adoption, same-head observation, completed review, failure,
  config wakeup, restart wait, and no second timer/poller.
- `workflow-inspector-feedback.test.ts`: severity order, fingerprint dedup, scrubbed bodies, legacy
  fallback, policy wording, caps, and stable hash.
- `workflow-inspector-restart.test.ts`: finding delivery, full resubmit, no old approval reuse, clean
  committed/pushed head, and second gate entry.
- `workflow-inspector-bypass.test.ts`: same-head refusal, new-head submission, no Persona attempts,
  repeat findings, round cap, PR switch block, full-restart escape, and visible bypass audit.
- Extend `inspector-adoption.test.ts` to prove workflow hints never adopt a PR.
- Extend `inspector-plan.test.ts` and DB tests for the nullable body.
- Extend `shipping-merge.test.ts` for `workflow-gate-pending`, its label, and no change when false.
- Extend `workflow-reset.test.ts` to retain Inspector ledgers while removing workflow gate/deliveries.
- Extend `workflow-sse.test.ts` and run rendering tests for compact gate state and reconnect parity.
- Full typecheck and test suite.

## Exit criteria

- No-final-gate workflows behave exactly as Phase 4.
- A final gate can use only an already-adopted PR and never treats `session.prUrl` as provenance.
- Gate entry waits for a post-entry Inspector observation and pins the exact locally reviewed,
  committed, pushed head.
- Inspector remains the only PR poller and the only code that posts/resolves comments or merges.
- A completed current-head review with zero findings completes the workflow.
- Findings produce one frozen, deterministic repair packet through Preview or the safe Live path.
- Full restart reruns every Persona; Inspector-only creates no Persona attempts and requires a new
  head.
- Same-head retries, PR switching, and round-cap bypass are impossible.
- Disabled, dry-run, not-allowlisted, backed-off, and failed Inspector states are honest and do not
  mutate operator settings.
- YOLO Shipping cannot merge a PR while its active workflow final gate is incomplete.
- Restart, concurrent signals, delivery ambiguity, and Reset preserve all prior safety invariants.

## Handoff to Phase 6

Phase 6 may prune completed workflow evidence and improve notifications/presentation. It must retain
the compact audit needed to prove Persona version, submission fingerprint, delivery hash, adopted PR,
target head, Inspector findings policy, bypass decision, and final outcome. It may not weaken current
head, adoption, Shipping veto, or ambiguous-delivery rules to simplify the UI.

## Cross-phase audit record

- Initial audit: checked against the parent and Phases 1 through 4.
- Prior-plan follow-up required: front-load gate-state JSON and `pr_handoff` in Phase 1, add dirty
  working-tree evidence in Phase 3, and make Phase 4's delivery kind reusable for the handoff.
- Parent follow-up required: add a fresh post-entry Inspector observation before head pinning and a
  Shipping veto so auto-merge cannot bypass the workflow before the final gate completes.
- Phase 6 audit: no Inspector or Shipping semantic correction required. Retention keeps their
  provenance/audit facts, and UI/alert work consumes the existing gate state without polling GitHub.
