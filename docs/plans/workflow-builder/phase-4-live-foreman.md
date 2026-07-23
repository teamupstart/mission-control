# Phase 4 plan: live repair delivery and Foreman completion

Status: **implemented**

Parent: [Persona-driven workflow builder](./plan.md)

Prerequisites:

- [Phase 1 foundation and Personas](./phase-1-foundation-personas.md)
- [Phase 2 builder and publishing](./phase-2-builder-publishing.md)
- [Phase 3 bindings, context, and manual preview execution](./phase-3-preview-engine.md)

## Outcome

An operator can opt an allowlisted workflow binding into Live delivery and Foreman completion.
One deterministic repair packet is delivered to the bound session after a Persona failure. When
Foreman later reaches one of its existing proof-grade completion boundaries, the daemon claims that
completion and starts or resubmits the same durable workflow. Duplicate HTTP requests, worker
restarts, daemon restarts, and ambiguous terminal writes cannot create duplicate runs, submissions,
or prompts.

Preview remains the default and continues to perform no terminal writes. Foreman remains a separate
HTTP-only worker and never reads or writes workflow tables directly.

## Prior-phase prerequisites

Phase 4 extends, rather than replaces:

- Phase 1's shared state enums, complete workflow table family, and route schemas;
- Phase 2's published binding defaults and immutable versions;
- Phase 3's one engine entry point, evidence capture, fingerprints, repair-round accounting,
  durable events, run summaries, orphaning, reattach, and Reset cleanup;
- the existing `injectPrompt` action and its pane lock;
- Foreman's existing queue-drain and prompted-wrapup proof boundaries.

The implementation task begins by running the Phase 1 through Phase 3 targeted suites. Any failure
in submission idempotency, session reattach, Reset cleanup, or Preview's no-write guarantee blocks
live-delivery work.

## Scope

### Included

- Workflows-specific live enablement and repository allowlist.
- Activation of `live` delivery and `foreman_complete` trigger modes on bindings.
- Durable exact-payload delivery records and deterministic Persona feedback rendering.
- `workflow` transcript origin and origin-safe context filtering.
- Confirmed, refused, and uncertain terminal delivery handling.
- Foreman completion claims at queue drain and prompted wrap-up.
- Initial submission and repair resubmission through the same Phase 3 entry point.
- Re-arming Foreman's existing completion episode after confirmed workflow feedback.
- Live-path coverage for session disappearance, `/clear`, reattach, Reset, and daemon restart.

### Deferred

- Inspector final-gate waits and Inspector repair packets: Phase 5.
- Retention pruning, cost attribution, notifications, and final UI/accessibility polish: Phase 6.

## Workflows live configuration

Create an app-level `WorkflowConfig` stored in `app_config`:

```ts
export interface WorkflowConfig {
  liveEnabled: boolean;
  repoAllowlist: string[];
}
```

Defaults are `liveEnabled: false` and an empty allowlist. An existing install therefore gains no
new terminal-writing behavior after upgrade.

Add `WorkflowConfigSchema` to `src/shared/protocol.ts` and expose:

```text
GET /api/workflows/config
PUT /api/workflows/config
```

The mutating route uses `parseBody`. Render the controls in a Workflows settings drawer, not as a
new global Settings category. Show the same explicit confirmation used by other automation settings
when `liveEnabled` changes from false to true.

Canonicalize configured paths through the existing repo-path route and decide consent with
`repoAllowlisted(session.cwd, session.repoRoot, config.repoAllowlist)`. Do not introduce a second
path-prefix matcher. A worktree of an allowlisted repository must pass by `repoRoot`; a similarly
prefixed unrelated repository must not.

An active binding may save `deliveryMode: "live"` only when live is globally enabled and its current
session is allowlisted. If consent is later removed, retain the binding choice but block before
delivery with a visible `live_not_authorized` reason. Never silently downgrade a published or bound
choice to Preview, because that makes the Run page claim feedback was delivered when it was not.

`foreman_complete` is independent of terminal-delivery consent. It requires Foreman to be enabled
and the session harness to declare the measured hooks and work-queue capabilities Foreman already
uses for completion proof. A Foreman-triggered Preview binding is valid.

## Delivery contracts and persistence

Add a dedicated delivery record rather than hiding a terminal side effect inside a node attempt:

```ts
export type WorkflowDeliveryKind = "persona_feedback" | "inspector_feedback" | "pr_handoff";

export type WorkflowDeliveryState =
  | "prepared"
  | "sending"
  | "delivered"
  | "refused"
  | "uncertain"
  | "cancelled";

export interface WorkflowDelivery {
  id: string;
  runId: WorkflowRunId;
  submissionId: WorkflowSubmissionId;
  kind: WorkflowDeliveryKind;
  sessionId: string;
  noteKey: string;
  payload: string;
  payloadSha256: string;
  state: WorkflowDeliveryState;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  deliveredAt: number | null;
}
```

Phase 1 creates `workflow_deliveries` with non-null identity columns and unique non-null
`(submission_id, kind, payload_sha256)`. Multiple delivery attempts never create multiple records
for the same immutable packet. The row stores the exact bounded prompt, not only a hash, so Preview,
recovery, audit, and Copy all show the text whose side effect was attempted.

`workflow_submissions` also owns a non-null unique `trigger_key` and a `trigger_source`. Manual and
Foreman resubmissions need idempotency per round, not only on the first `workflow_runs` row. Phase 3
must store its client request id there before Phase 4 adds worker retries.

## Deterministic repair packet

Create `src/server/workflows/feedback.ts`. It accepts only structured engine output and produces one
bounded plain-text prompt. Model prose never chooses the template or adds terminal control text.

The packet contains:

1. A fixed statement that the workflow review failed and this is a repair round.
2. The original user goal, bounded but never replaced by a Persona summary.
3. Workflow name/version, run id, submission round, and evidence fingerprint prefix.
4. One section per failed Persona in graph order, containing Persona name, summary, and numbered
   requested changes with evidence references.
5. A final instruction to preserve the user's explicit intent, make only supported changes, verify
   the work, and signal completion normally.

Pass details and infrastructure errors do not enter a failure packet. A Join contributes its
already-deduplicated aggregate so the session receives one prompt even when concurrent Personas
fail. Strip terminal control characters, cap every field and the total payload through the shared
prompt limit, and end with a deterministic truncation notice when necessary.

The payload hash covers the final UTF-8 bytes. Rendering the same immutable submission twice must
produce the same payload and hash.

## Live delivery state machine

Only the daemon delivers workflow feedback. It resolves the current binding and repeats all safety
checks immediately before the write: binding active, expected `noteKey`, current synthetic session
id, live pane, no active reattach/reset transition, global live switch, and repository allowlist.

For a failed submission whose failure edge reaches Session:

1. Render the exact packet and insert or recover its `prepared` delivery row.
2. In a short transaction, recheck that no delivered or sending sibling exists and transition the
   row to `sending`.
3. Call the existing `injectPrompt(session, payload)`. That function owns the pane lock and terminal
   capability checks. Do not call a terminal adapter directly.
4. On confirmed success, call `recordInjection(session.id, payload, "workflow")`, persist
   `delivered`, record the transcript anchor when available, and transition the run to
   `waiting_for_session`.
5. After confirmed delivery only, re-arm the appropriate existing Foreman completion episode so the
   repaired work can produce another proof-grade completion signal.

Interpret an `ActionResult` using the same evidence discipline as Foreman's `InjectError`:

- Positive `pasted: false` means nothing landed. Mark `refused`; the operator may explicitly retry
  after correcting the cause.
- Confirmed success means one delivered prompt.
- A failure with `pasted: true`, a missing landing answer, a lost response, or daemon interruption
  after `sending` means the payload might be in the composer. Mark `uncertain`, block the run, and
  never retry automatically.
- A pane blocked by a human reading copy mode remains a visible refused state. It does not consume a
  repair round, and retry remains explicit.

On daemon boot, `prepared` rows are safe to resume before any terminal call. Every surviving
`sending` row becomes `uncertain`; recovery cannot prove which side of the write boundary occurred.
`delivered`, `refused`, `uncertain`, and `cancelled` are terminal until an explicit operator action.

Add an explicit retry route for positively refused deliveries:

```text
POST /api/workflow-deliveries/:id/retry
```

The request body is owned by `RetryWorkflowDeliverySchema` in `src/shared/protocol.ts`. It carries a
client-generated request id plus the expected session and conversation identities, uses `parseBody`,
and is refused for `sending`, `delivered`, or `uncertain`. Resolving an uncertain delivery requires
either **Mark delivered** after inspecting the pane or **Discard and send a new repair round** with a
typed confirmation. Both choices append an audit event; neither silently reuses the ambiguous row.

## Transcript origin

Append `workflow` to `TurnOrigin` and add it to `InjectPromptSchema.origin` beside `human` and
`foreman`. The injection route continues to call `recordInjection` only after confirmed success.
The workflow manager may call the action directly, but it must make the same post-success attribution
call exactly once.

Update comments and tests that currently describe only Foreman and harness as non-human authors.
Phase 3's `origin !== undefined` context filter requires no new branch and must exclude workflow
feedback automatically. The packet may still become the session's current captured goal for
Foreman's prompted-completion verifier; origin attribution and goal capture answer different
questions.

## Re-arming one completion episode

Live repair must produce a later completion signal without creating a second completion detector.
Reuse the existing Foreman guards:

- If the session has work-queue items, confirmed workflow delivery clears the drain episode's
  `wrapupAskedAt` and `wrapupAnswer` together in the same workflow-store transaction that confirms
  delivery, then refreshes `QueueManager`'s denormalized projection. Existing terminal items remain
  terminal. After the agent works and settles, the normal drain decision fires once.
- If the session has no work-queue items, the workflow prompt becomes the captured goal. Its changed
  text differs from `promptedGoal`, so the existing prompted-wrapup trigger re-arms naturally.

Never clear either guard before confirmed delivery. An uncertain or refused packet must not let
Foreman judge the old evidence as a new repair. The paired drain reset is owned by
`WorkflowStore.rearmDrainCompletionForDelivery`; do not write its two fields independently.

The Workflows config does not turn on Foreman's `prompted` trigger. If a binding selects
`foreman_complete` on an itemless session while that trigger is disabled, the binding dialog must
explain that the first or later itemless completion needs Manual Submit. It must not mutate Foreman
preferences on the operator's behalf.

## Foreman completion claim

Add a parsed route owned by `WorkflowManager`:

```text
POST /api/sessions/:id/workflow-completion
```

The request and response wire contracts are owned by `WorkflowCompletionClaimSchema` and
`WorkflowCompletionClaimResultSchema` in `src/shared/protocol.ts`, with their browser-safe types in
`src/shared/workflow.ts`.

Bound all strings. `marker` is a worker-generated SHA-256 of the proof episode, never raw prompt or
diff text:

- drain uses durable queue identity, queue update generation, terminal item ids/rounds, HEAD, and
  transcript anchor;
- prompted uses durable `noteKey`, captured goal, HEAD, and transcript anchor.

The marker must be stable across a worker retry and change after confirmed workflow repair re-arms
the completion episode. The daemon combines it with binding id and completion kind into the
submission `trigger_key`. A repeated request returns the existing run/submission.

`claimed: false` is reserved for no active binding or a binding whose trigger is Manual. An active
Foreman binding owns the boundary even when round limits, unchanged evidence, capture failure, or a
current running submission prevent new work. In those cases the route records a visible blocked
state and returns `claimed: true`, so Foreman cannot bypass the configured workflow by falling
through to its old ship action.

The route resolves durable identity server-side from the live session and binding. It never trusts
a note key, workflow id, run id, author, repository, or delivery mode supplied by the worker.

## Foreman worker integration

Add `ForemanClient.claimWorkflowCompletion` and no database import. Call it only after Foreman has
the same proof it already uses to choose a wrap-up:

### Queue drain

In `processQueueTarget`, after `decideQueueTick` returns `ask-wrapup` or `auto-wrapup` and before
`applyQueueAction`, post the claim. If it returns false, execute the existing action byte-for-byte.
If it returns true, return without raising the Ship it? card or typing the old wrap-up. The completion
claim transaction itself stores `wrapupAskedAt` and a non-null internal answer such as
`workflow:<run-id>`; the answered row preserves the existing once-only guard without presenting a
human action.

If the claim request fails, do not guess. Leave the drain episode armed, perform no old wrap-up, and
retry on a later tick. A daemon outage must not turn a configured workflow into an unreviewed push.

### Prompted wrap-up

In `processPromptedWrapup`, call the claim after a complete verifier verdict and before
`planPromptedWrapup`. A false response continues through the current plan and actions unchanged. A
true response logs the run id and returns without raising a card or typing the old wrap-up. The
completion claim transaction already stored the current captured goal as `promptedGoal`.

If the claim transaction cannot also retire the matching drain/prompted guard, it rolls back and the
request fails. The next tick repeats the stable claim; it cannot create a second submission. Leave
the episode armed and take no old action on any failed claim request.

Pin current behavior with seam-level tests around `ForemanClient` fakes. The worker must not learn
whether a workflow has Personas, Inspector enabled, or a live-delivery mode. It knows only whether
the daemon claimed the completion.

## Engine integration

Manual and Foreman completion use caller-specific durable store transactions, then converge on
`WorkflowManager.captureAndActivate` with different server-owned authors and trigger keys.

- With no active run, a claimed completion creates a full-workflow run and round 1 submission.
- With a run at `waiting_for_session`, it captures a new full-workflow submission at the next round.
- With a current capturing/running submission, it returns the existing claim.
- With a run in a Phase 5 Inspector wait, complete, cancelled, orphaned, or blocked state, it does
  not create parallel work. It records why the claimed boundary produced no submission.
- Round-limit and unchanged-evidence failures are workflow blocks, not Foreman fallthroughs.

Trigger claims never skip Phase 3's stable evidence capture or immutable version lookup. A
Foreman summary is audit metadata, not the context snapshot and not a Persona verdict.

## HTTP and UI changes

Phase 4 adds:

```text
GET  /api/workflows/config
PUT  /api/workflows/config
POST /api/sessions/:id/workflow-completion
POST /api/workflow-deliveries/:id/retry
POST /api/workflow-deliveries/:id/resolve
```

Update the binding dialog to enable Live and Foreman Complete with exact prerequisites. Run detail
shows:

- the final deterministic packet and hash;
- Prepared, Sending, Delivered, Refused, or Delivery uncertain;
- actual target session identity and delivery timestamps;
- retry only for positive refusal;
- explicit uncertain-resolution actions;
- the Foreman completion kind, marker prefix, summary, and claimed state.

The graph overlay still shows the Session node as the wait boundary. Do not add a Checkpoint or
Foreman node. Session cards use the Phase 3 shared workflow mark and tone helper; no new layout-only
chip is needed.

## Reset, reattach, and restart behavior

Phase 3 owns the lifecycle policy. Extend its implementation rather than adding a second cleanup:

- successful `resetSession` removes or cancels every delivery row and completion claim scoped to the
  old `noteKey`; failed Reset changes none;
- session disappearance before delivery leaves `prepared` blocked and changes `sending` to
  uncertain;
- explicit reattach never retargets an existing prepared payload automatically. The operator must
  confirm that the new live session is the intended recipient, producing an event before retry;
- `/clear` behaves like other reattach boundaries and cannot carry a pending terminal side effect
  across the new agent session id;
- cancelled runs cancel prepared deliveries but retain delivered/uncertain audit rows until Reset or
  Phase 6 retention;
- startup recovery processes delivery states before advancing ready graph work.

## Implementation order

1. Add config, completion-claim, delivery, retry, and resolution schemas and shared types.
2. Add `workflow_deliveries` plus per-submission trigger source/key to the Phase 1 table family and
   store methods.
3. Add config persistence/routes and shared allowlist checks.
4. Add deterministic feedback rendering and payload-hash tests.
5. Add `workflow` origin across protocol, transcript attribution, and filtering tests.
6. Implement delivery transitions, pane-locked action use, recovery, and explicit resolution.
7. Add queue re-arm and atomic claimed-retirement methods.
8. Add the workflow-completion route and reuse Phase 3 submission entry points.
9. Add Foreman client/worker calls at the two proof boundaries.
10. Enable binding modes and build config/delivery/claim UI.
11. Exercise live orphan, reattach, `/clear`, Reset, and restart cases.
12. Update README with consent gates, trigger prerequisites, and uncertain-delivery recovery.

## Tests

- `workflow-feedback.test.ts`: deterministic order, aggregate failures, intent preservation,
  control-character removal, caps, truncation marker, and stable payload hash.
- `workflow-delivery.test.ts`: prepared/sending/delivered, positive refusal, copy-mode refusal,
  ambiguous response, crash recovery, no automatic uncertain retry, and explicit resolution.
- `workflow-config.test.ts`: default off, parsed writes, canonical allowlist, worktree repo identity,
  and live consent removal.
- `workflow-completion-http.test.ts`: manual/no-binding fallthrough, initial claim, repair resubmit,
  duplicate marker, concurrent claim, unchanged evidence, round cap, and server-owned identity.
- `workflow-foreman-claim.test.ts`: drain and prompted claims, claimed suppression, false-response
  byte parity, HTTP failure fail-closed behavior, prompted retirement retry, and no worker DB import.
- Extend `queue-apply.test.ts` for atomic claimed retirement and repair re-arm without touching item
  states.
- Extend transcript/injection tests for `workflow` origin and exact post-success attribution.
- Extend `workflow-recovery.test.ts` for prepared versus sending deliveries.
- Extend `workflow-reset.test.ts` for delivery and claim rows on successful and failed Reset.
- Extend `workflow-run-render.test.ts` for delivery states and uncertain-resolution controls.
- Full typecheck and test suite.

## Exit criteria

- Preview remains the default and produces zero terminal calls.
- Live cannot write unless the global switch, per-binding choice, and shared repo allowlist all pass.
- Concurrent Persona failures produce one deterministic, auditable repair prompt.
- Confirmed feedback is attributed to `workflow` and excluded from human decisions.
- A possibly landed prompt is never automatically sent again.
- Foreman starts or resubmits a workflow only at an existing proof-grade completion boundary.
- A claimed completion suppresses only the corresponding old wrap-up; an unclaimed completion runs
  the old path unchanged.
- Foreman and daemon retries cannot duplicate a run, submission, receipt, or delivery.
- Confirmed repair delivery re-arms exactly one later completion episode.
- Live failure paths preserve Phase 3 orphan, reattach, Reset, and restart invariants.

## Handoff to Phase 5

Phase 5 may reuse `WorkflowDelivery` with `kind: "inspector_feedback"` and the same delivery state
machine. It may wake `WorkflowManager` from Inspector's existing durable ledger, but it must not add
a GitHub poller, ask Foreman to inspect PRs, relax PR provenance, bypass current-head checks, or type
Inspector findings through another terminal path.

## Cross-phase audit record

- Initial audit: checked against the parent and Phases 1 through 3.
- Prior-plan follow-up required: front-load `workflow_deliveries` and per-submission trigger keys in
  Phase 1, use submission trigger keys in Phase 3, and include deliveries in Phase 3 Reset cleanup.
- Parent follow-up required: name the durable delivery table, clarify completion re-arming after a
  confirmed repair, and distinguish positive refusal from ambiguous delivery.
- Phase 5 audit: added `pr_handoff` as a third deterministic packet kind. Missing-PR preparation is
  an explicit user action, but once chosen it crosses the same terminal side-effect boundary and
  must use the same delivery state machine.
- Phase 6 audit: no delivery or Foreman semantic correction required. Retention explicitly protects
  uncertain payloads, and alerts observe these durable states without adding another delivery path.
