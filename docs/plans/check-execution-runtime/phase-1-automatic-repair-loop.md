# Phase 1: The automatic repair loop

Source plan: `docs/plans/builtin-workflows/phase-2-check-node.md`
Index: `docs/plans/check-execution-runtime/phased-plan.md`

## Outcome and value

A Persona failure repairs itself without a human touching the dashboard: feedback is delivered
to the bound session, the session fixes, the work is resubmitted, and the graph re-runs from
the top - by default, on a fresh install, for an allowlisted repository.

Most of that machinery already exists and has never run for anybody, because three defaults
keep it switched off and two dead ends kill it permanently the first time a session signals
completion without changing anything. This phase turns it on and closes the dead ends.

Value is immediate and independent of the check runtime: the four Personas that ship today
become a self-repairing gate instead of a report the operator has to read and act on.

## Entry criteria and dependencies

- Direct prerequisite: the planning session's PR merges.
- **No dependency on Phase 2, 3 or 4.** Shares no file with them. Concurrency group A.
- Recommended to merge before Phase 4, for the reason in the index. Not an edge in the graph.

## SUPERSEDED IN PART - read before implementing

**PR #327 (`feat(workflows): resume a parked repair round automatically`) landed on `main`
while this plan was in review, and it solves this phase's headline problem by a different
mechanism.** Do not start implementing until the scope below has been re-decided with the
operator. What follows is recorded as-found rather than rewritten, because the collision
touches an operator decision and resolving it is not the planner's call.

What #327 shipped, verified against the merged code:

- **`resumptionPolicy` (`auto` | `manual`)**, immutable per published version
  (`shared/workflow.ts:1028`, `:1057`). A persisted NULL reads as `manual`, so every
  already-published version keeps what it shipped with.
- **A daemon-side observer over parked runs** that opens round N+1 once the bound session is
  settled-idle, has been handed its packet, is not waiting on a human, and **the repository has
  changed**. Its pre-filter is deliberately repository-only.
- **Built-in v7** carrying `auto` (`builtin-workflows.ts:402`); v1-v6 stay pinned to `manual`.
- **`settledIdle` moved to `@shared/session.ts:132`** so the daemon and Foreman decide idleness
  identically. This phase cited it at `queue-machine.ts:121-125`.

**It contradicts operator decision 5.** That decision was "reuse Foreman, do not grow a second
completion detector." #327 argues the Foreman route *could never* have covered resumption -
`retireDrainGuard` needs a `foreman_queues` row with items, so an item-less session throws
rather than claims; a `foreman_complete` binding additionally needs Foreman enabled plus
measured `hooks` and `workQueue`; and `ensureExternalBinding` refuses the mode outright. That
is a stronger technical objection than the one this plan weighed, and it may simply be right.
But it is the operator's decision to revisit, not this document's.

What still holds, verified against the merged code:

- `DEFAULT_WORKFLOW_CONFIG.liveEnabled` is still `false` (`shared/workflow.ts:654`).
- `rearmPromptedCompletionForDelivery` still does not exist anywhere in `src/`. Its
  *importance* drops, though: the observer now covers resumption, so the re-arm matters only
  for the Foreman claim path rather than for the loop as a whole.
- The `unchanged_evidence` dead end is intact (`manager.ts:3245`). #327's repository-only
  pre-filter makes it much less reachable via the observer - an unchanged tree simply does not
  fire it, which is a cleaner answer than this plan's nudge - but it remains reachable through
  a Foreman claim.

The open question for the operator, in one line: **does Phase 1 shrink to "flip the defaults
and fix the Foreman-path dead ends", with #327 owning resumption - or does it keep its original
scope and reconcile the two mechanisms?** Everything below assumes the original scope and has
not been rewritten.

## Scope

In scope:

- `DEFAULT_WORKFLOW_CONFIG.liveEnabled` → `true`.
- Foreman `enabled` default → `true`; `wrapupTriggers` default gains `prompted`.
- `rearmPromptedCompletionForDelivery`, the missing half of the re-arm pair.
- `confirmDeliverySend` re-arms exactly one completion episode: drain when the session has
  queue items, prompted otherwise.
- The `unchanged_evidence` dead end: a bounded nudge instead of a permanently spent guard.
- The end-to-end repair-cycle test that does not exist today.
- README: Configuration rows for the two flipped defaults, and the loop described in one
  place.

Explicit non-goals:

- **No new built-in version.** Operator decision 3: Inspector findings keep `inspector_only`.
  Built-in v6 already ships `foreman_complete` + `live`, so no catalog change is needed and
  versions 1-5 stay immutable app data (`builtin-workflows.ts:343-349`).
- **No second completion detector.** Operator decision 5. The trigger stays in the Foreman
  worker. `docs/plans/workflow-builder/phase-4-live-foreman.md:221` is the standing rule.
- **No change to `repoAllowlist`.** Operator decision 4: consent stays required. Flipping
  `liveEnabled` alone changes nothing for a repository nobody allowlisted, which is the
  intended posture, and the README must say so or the default reads as broken.
- **No preview re-arm.** In `preview` the human is the delivery mechanism; a guard that
  re-armed itself would resubmit work nobody delivered. Preview keeps the manual resubmit
  route. Recorded because the investigation flagged it and it is a deliberate answer, not an
  oversight.
- **No raising or routing around `maxRepairRounds`.** Reaching the bound is a visible
  `blocked` state a human resolves. Contract F.
- **No changes to `checksEnabled`.** Phase 4 owns that conversation.

## Repository findings this phase depends on

Every line reference below was re-verified against `6453445a` after a rebase. PR #323 shifted
`manager.ts` by roughly +61 above line 1660 and `store.ts` by +75 above 2380, and changed two
things in substance - both called out.

- **The cycle is already implemented.** `engine.ts:322-337` parks the submission and cancels
  siblings; `onSubmissionWaiting` → `scheduleWaitingDelivery` → `prepareAndMaybeDeliver`
  (`manager.ts:339-340`, `:2681-2724`); live delivery calls `deliverPrepared`
  (`manager.ts:2723`); `confirmDeliverySend` (`store.ts:3126`) re-arms the drain guard in the
  same transaction (`store.ts:3171-3178`) and `manager.ts:2976` refreshes the queue; Foreman
  reclaims and `claimForemanCompletion` creates round N+1 (`store.ts:~2310-2333`).
- **Restart is from the top, verified.** Attempts and receipts are keyed by `submissionId`
  (`shared/workflow.ts:1098`, `:1122`), so `advanceStructure` re-emits from the Session node
  (`engine.ts:252-271`) and every reachable node gets a fresh attempt (`engine.ts:305-321`).
- **`liveEnabled` is asked twice**, at bind time (`manager.ts:2637-2645`) and at send time
  (`deliveryBlock` clause 10, `manager.ts:2877`). Both read `getWorkflowConfig()`, so one
  default change reaches both.
- **#323 added a THIRD reader of `liveEnabled`, and it makes this phase's default flip louder
  than it looks.** `claimCompletion` gained an auto-bind path (`manager.ts:1643-1699`): when no
  active binding exists and the claim carries `fallbackWorkflow: "no-mistakes"`
  (`protocol.ts:2599-2601`, `shared/workflow.ts:949-956`, set by
  `foreman/workflow-claim.ts:80` when `cfg.wrapup === "no-mistakes"`), the daemon re-proves
  Foreman enabled + live + repo-allowlisted, resolves the built-in No-Mistakes Review version,
  and creates a binding pinned to `triggerMode: "foreman_complete"` whose `deliveryMode` is
  `liveDeliveryAuthorized ? "live" : "preview"`. Consequences for step 5, all three of which
  belong in the PR description: flipping `liveEnabled` silently upgrades every auto-created
  No-Mistakes binding from preview to live on an allowlisted repository; flipping Foreman
  `enabled` makes this auto-bind path reachable at all; and adding `prompted` to
  `wrapupTriggers` makes its prompted variant reachable, which retires through the very
  `retirePromptedGuard` this phase is mirroring.
- **`repoAllowlisted(cwd, repoRoot, [])` is false.** An empty allowlist authorises nothing.
  This is why flipping `liveEnabled` alone is safe.
- **`bindingModeBlock` refuses `foreman_complete` when Foreman is disabled**
  (`manager.ts:2646-2655`), and dispatch refuses earlier (`manager.ts:482-488`).
- **The drain re-arm requires queue items.** `rearmDrainCompletionForDelivery`'s `EXISTS`
  clause (`store.ts:4223-4225`) returns false for an item-less session. `retirePromptedGuard`
  exists (`store.ts:4230-4256`) but **there is no `rearmPromptedCompletionForDelivery`**
  anywhere in `src/` or `test/`.
- **The guard is still spent on an unchanged-evidence refusal, but retirement is now two
  sites, not one.** PR #323 restructured `claimForemanCompletion`. Retirement happens either
  early, on the fallback path (`store.ts:2260-2272`), or at the original site, now guarded by
  `if (!guardRetired)` (`store.ts:2360-2366`). Either way it commits inside the claim
  transaction; `captureAndActivate` runs afterwards (`manager.ts:1721-1726`) and may refuse at
  `manager.ts:3171-3186`. The dead end is intact.
- **#323 made that dead end worse on one path, and Phase 1 must cover the worse variant.** On
  the fallback path the same transaction retires the guard **and inserts a brand-new
  No-Mistakes binding** before capture runs. An unchanged-evidence refusal there leaves a
  freshly created binding attached to a blocked run with a spent guard - a binding the
  operator never asked for and cannot advance.
- **The precedent for "return rather than spend" already exists**, and Phase 1 should cite it
  rather than invent the idea: `store.ts:2198-2208` re-resolves the binding and returns
  `{ claimed: false, reason: "manual_trigger" }` **without touching the guard**.
- **Two signatures moved under #323**, and steps 2-3 must match them: `retirePromptedGuard`
  (`store.ts:4230`) now takes `Pick<WorkflowBinding, "noteKey" | "sessionCwd">` rather than a
  whole `WorkflowBinding`, and `ForemanCompletionStoreResult` is now a **discriminated union**
  with a `claimed: false` arm plus a `binding` field - so `stored.run` is nullable at every
  call site.
- **`claimCompletion` passes `allowUnchanged: false`** positionally (`manager.ts:1721-1726`;
  consumed at `:3171`, parameter default at `:3019`), and the uncertain-delivery replacement
  round passes `true`.
- **The test gap is documented in the tests.** `workflow-delivery.test.ts:111` and `:142`
  assert `rearmedDrain === false`; `workflow-completion-http.test.ts:592-594` clears
  `wrapup_asked_at` with raw SQL to get past the guard, and a **second** pre-existing raw-SQL
  re-arm sits at `:521-524`. Both go.
- **A second re-arm site already exists** and must keep working: `resolveUncertainDelivery`
  (`store.ts:3355-3362`, refresh at `manager.ts:1550`).

## Implementation steps, in execution order

### 1. Close the dead ends first, then flip the defaults

Order matters. Flipping the defaults first would ship the known dead ends to every operator on
upgrade. Everything below lands in one PR, but write and test it in this order.

### 2. `rearmPromptedCompletionForDelivery` (`src/server/workflows/store.ts`)

Mirror `rearmDrainCompletionForDelivery` (`:4215-4228`) for the prompted episode. It clears
whatever `retirePromptedGuard` (`:4230-4256`) wrote, so the next prompted evaluation sees an
un-answered episode. Return `boolean` the same way, so the caller can tell whether it fired.

Match the drain function's guard shape: only re-arm a row that exists, and never create one.

### 3. One episode per confirmed delivery (`store.ts`, `confirmDeliverySend`)

At `store.ts:3171-3178`, replace the unconditional drain call with: try drain; if it returns false, try
prompted. Report which fired on the returned object (widen `rearmedDrain: boolean` to a
discriminated `rearmed: "drain" | "prompted" | null`, or add a sibling field - the
implementation picks, but callers must be able to tell, because `manager.ts:2976` refreshes the
queue only for the drain case).

Append the existing `foreman_completion_rearmed` event with the kind it actually re-armed
(the event at `store.ts:3171-3178` already carries a `completionKind` field - populate it honestly rather
than hard-coding `"drain"`).

**Exactly one.** Re-arming both would let a single delivery produce two completion claims and
therefore two rounds for one repair.

### 4. The `unchanged_evidence` nudge (`store.ts`, `manager.ts`)

The failure to fix: session signals completion, changed nothing, capture refuses, guard already
spent, loop dead forever.

Do **not** simply re-arm on refusal - Foreman's tick is 4s and the settle is 10s, so an
unconditional re-arm is a hot loop re-running context compaction (a real LLM call,
`WORKFLOW_CONTEXT_TIMEOUT_MS = 45_000`) every fourteen seconds against a session that is not
changing.

Instead, make the refusal produce a delivery, and let the existing re-arm path fire off that
delivery's confirmation:

- Add a delivery kind alongside `persona_feedback` / `pr_handoff` / `inspector_feedback` -
  suggested `unchanged_evidence_nudge`. Its packet states plainly that completion was
  signalled but the evidence fingerprint is identical, names what the last packet asked for,
  and says the two acceptable responses are to make the change or to say why it should not be
  made.
- On the `unchanged_evidence` refusal path (`manager.ts:3171-3186`), prepare that delivery
  instead of only parking. In `live` it sends; its `confirmDeliverySend` re-arms one episode
  through step 3, so the next Foreman claim is legitimate and gated on a fresh idle+settle.
- **Bound it, and state the bound as a comparison rather than an ordinal.** Count consecutive
  unchanged refusals on the run. **Refusals 1 and 2 each prepare a nudge; the run blocks when
  the count exceeds two**, i.e. on the third consecutive refusal, with a distinct phase
  (suggested `unchanged_evidence_exhausted`) for a human to resolve. A session that ignores two
  explicit nudges is not going to be fixed by a third.
  The precise wording matters because "after the second, stop" reads two ways - one of which
  blocks on the second refusal and silently shortens the repair loop by a round. `> 2` is the
  bound; the tests below pin all three positions so the ambiguity cannot come back.
- The counter resets on any submission that captures a changed fingerprint.

Keep `allowUnchanged: false` at `manager.ts:1721-1726`. The nudge is the answer to an unchanged
resubmission, not a reason to accept one.

### 5. Flip the defaults

- `src/shared/workflow.ts:618`: `liveEnabled: true`. Update the surrounding comment to say
  what the index says - delivery is authorised by default, the repository allowlist is still
  the consent gate, and an empty allowlist authorises nothing.
- `src/shared/protocol.ts:856`: `ForemanConfigSchema.enabled` default `true`.
- `src/shared/protocol.ts:930`: `wrapupTriggers` default `["drain", "prompted"]`.

`DEFAULT_WORKFLOW_BINDING_DEFAULTS.deliveryMode` stays `"preview"`
(`shared/workflow.ts:396`): it governs operator-authored workflows, and built-in v6 overrides
it with `live` anyway. Flipping it would change the default posture of workflows a human
built, which nobody asked for.

`LEGACY_WORKFLOW_BINDING_DEFAULTS` (`builtin-workflows.ts:350`) **must not change** - immutable
app data, and the comment above it says why.

### 6. README

- Configuration: rows for the two flipped defaults, each stating what is still required
  (allowlist for live delivery; the Foreman worker process actually running for the trigger).
- One place describing the loop end to end, including its latency floor - one Foreman tick
  (`IDLE_MS = 4000`) plus the settle (`SETTLE_MS = 10_000`), so roughly fourteen seconds
  between a session going idle and a new round starting. An operator who does not know that
  will read the pause as a hang.
- State that Foreman is a separate process and the loop does not advance without it.

## Data, API and compatibility

- **No schema change.** The nudge counter fits the run's existing gate-state JSON; adding a
  column for it would be a migration for a value that dies with the run.
- **New delivery kind** reaches durable rows and the SSE payload. Treat the delivery-kind
  vocabulary as append-only for the same reason `EVIDENCE_REF_KINDS` is
  (`shared/workflow.ts:1264-1272`): a build that cannot read a persisted kind fails the row at
  its zod boundary. Add it to every schema that enumerates kinds, and give
  `src/web/workflows/run-model.ts` a sentence for it - that module owns vocabulary, so a new
  kind should fail typecheck until someone says what it means.
- **Upgrade behaviour is the sharp edge.** These are `.default()`s in a zod schema over an
  `app_config` blob. An operator who has *never opened* Workflow or Foreman settings has no
  persisted value, so they get the new default on upgrade - which is the intent. An operator
  who explicitly turned Foreman *off* has a persisted `false` and keeps it. Verify this
  distinction holds for both blobs before merging; if either writes a full blob on first read,
  the "never opened" case is already persisted as `false` and the flip is inert.
- **No wire-breaking change**, so no coordination with an older browser build.

## Tests and verification

New, and the most important artifact in this phase - `test/workflow-repair-cycle.test.ts`:

- The full cycle with **no raw SQL**: persona fail → `waiting_for_session` → live delivery
  confirmed → drain guard observably re-armed → Foreman completion claim → round 2 exists →
  the graph re-runs from the top (assert fresh attempts for every persona node under the new
  `submissionId`, not just that a submission row appeared).
- The same cycle for an **item-less** session, exercising the prompted re-arm.
- Exactly one episode re-armed per delivery, asserted both ways.

Extend existing:

- `test/workflow-delivery.test.ts:111,142` - the `rearmedDrain === false` assertions now have
  a sibling asserting the prompted path fires when there are no items.
- `test/workflow-completion-http.test.ts:592-594` **and `:521-524`** - delete both raw-SQL workarounds; the test
  should now traverse the re-arm honestly. If it cannot, the re-arm is wrong.
- Unchanged-evidence, all four positions asserted so the off-by-one cannot return: first
  refusal prepares a nudge; **second refusal prepares a nudge** (not a block); third blocks
  with the exhausted phase; a changed fingerprint resets the counter to zero.
- `test/workflow-config.test.ts` and the Foreman config tests - the new defaults, plus the
  upgrade case: a persisted explicit `false` survives.

Commands: `npm run typecheck`, `npm test`, `npm run build`.

Manual, and required before merge because no test covers a real pane: on an allowlisted
repository, dispatch a task with the built-in workflow, force a Persona failure, and watch the
packet arrive in the session, the session fix, and round 2 start without touching the
dashboard. Confirm the ~14s pause is the settle and not a stall.

## Merge and exit criteria

- CI green on Node 24 and 26.
- `test/workflow-repair-cycle.test.ts` passes and contains no raw SQL.
- The raw-SQL workaround is gone from `workflow-completion-http.test.ts`.
- A fresh install with an allowlisted repository completes a repair round with no human input.
- A fresh install with **no** allowlisted repository still delivers nothing, and the reason
  surfaced is `live_not_authorized` rather than silence.
- README documents both flipped defaults, the allowlist requirement, the Foreman process
  requirement, and the latency floor.

## Downstream handoff

Later phases may rely on Contract F (index): personas never fix, one episode re-armed per
confirmed delivery, a claim that cannot produce a round returns the guard rather than spending
it, and `maxRepairRounds` still bounds the loop.

Phase 4 relies on the loop being live when a **Check** fail produces the packet. The packet
path is shared - `checkVerdict` (`engine.ts:133-157`) already synthesises a `PersonaVerdict`
with `evidence: [{ kind: "check", … }]` - so Phase 4 inherits this loop without changing it.

Phase 4 must not weaken the nudge bound to make a flaky check converge. A check that fails
identically twice is telling the truth.

## Cross-phase audit record

- **2026-07-30, at authoring:** no overlap with Phases 2-4. Files touched
  (`shared/workflow.ts`, `shared/protocol.ts`, `workflows/store.ts`, `workflows/manager.ts`,
  `web/workflows/run-model.ts`) are disjoint from Phase 2's (`server/pool.ts`,
  `server/dispatcher.ts`, `server/db.ts`, `server/index.ts`) and Phase 3's (new modules).
- **Shared file with Phase 4:** `workflows/manager.ts`. Regions are disjoint - this phase owns
  `unchanged_evidence` (`:3171-3186`) and `claimCompletion` (`:1632-1737`, widened by #323); Phase 4 owns
  `WorkflowManagerOptions` (`:178-220`) and engine forwarding (`:330-346`). Recorded in the
  index under "Shared-file notice".
- **Confirmed no built-in catalog change**, so `test/builtin-workflows.test.ts`'s pinned
  version literals are untouched and Phase 4 inherits them unchanged.
- **2026-07-30, Inspector round 3 (PR #326):** finding accepted - *"State the unchanged-evidence
  cutoff consistently"*. Step 4 said to stop preparing nudges "after the second" refusal while
  the test plan required nudges on the first and second and a block on the third. Both readings
  are defensible from the prose, and the wrong one shortens the repair loop by a round without
  anything failing. Restated as an explicit comparison - block when the count **exceeds two** -
  and the test now pins the second refusal as a nudge rather than leaving it implied. No change
  to the intended bound or to Contract F; this was ambiguity, not a behaviour change.
- **2026-07-30, PR #327 landed mid-review:** recorded above as a "superseded in part" banner
  rather than folded into the body. The mechanism it chose is incompatible with operator
  decision 5, so rewriting this phase to match would have silently reversed a decision the
  operator made explicitly. Phases 2, 3 and 4 are unaffected - #327 touches the workflow
  resumption path and nothing in the lease, supervisor or executor surfaces.
