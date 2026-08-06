# Phase 2 - The derived next move

## Outcome

The header stops offering every control a run might accept and offers the one it should. A new
`runNextMove(detail)` resolves at most one action per run state; when it resolves nothing, the header
says why in a sentence and names where the decision lives. `Open PR` becomes absent rather than
disabled on runs with no pull-request concept.

Value: this is the change the plan exists for. A blocked run whose session disappeared goes from nine
controls with the reason hidden in a tooltip to one control and a sentence.

## Entry criteria and dependencies

- **Direct phase dependency: Phase 1.** It owns the same JSX region (`.wf-run-actions`,
  `WorkflowRuns.tsx:629`) and must have removed the audit clutter first, or the two diffs collide on
  every line of the control row.
- Requires Phase 1's contract that the version badge owns composer navigation, so this phase does not
  reintroduce an `Open version` button.

## Scope

In scope:

1. `runNextMove(detail)` in `src/web/workflows/run-actions.ts`, returning at most one descriptor.
2. Restructure `.wf-run-actions` into the primary move, then context controls, keeping the existing
   `.wf-run-actions-danger` group untouched.
3. The why-sentence (`.wf-run-why`) in the identity block, rendered only when there is no move.
4. Make `open-pr` conditional on the run's completion policy, and repair the non-null assertion this
   invalidates.
5. Add the two missing `BLOCKED_PHASE_CLAUSES` entries for `unchanged_evidence` and
   `unchanged_evidence_exhausted`.

Non-goals:

- `Run this review again` on terminal runs: **Phase 3**. `runNextMove` returns `null` for
  `completed`/`cancelled`/`failed` in this phase, and Phase 3 adds that arm.
- The bind chip: **Phase 4**.
- Any change to `runRemedy` in `run-model.ts`. It serves a summary-only surface under a stricter
  contract and stays as it is.
- **Migrating `WorkflowLadder` onto `runNextMove`.** `runNextMove` is the Runs header's derivation
  only. The ladder keeps reading `inspectorGateActions`, which already serves both surfaces; the only
  thing this phase changes for the ladder is that filter's policy condition. A ladder primary would be
  a change to what the session pane *does* - it deliberately takes no resubmit callback today
  (`WorkflowLadderProps`, `WorkflowLadder.tsx:76-93`) and offers no submissions - and no phase owns
  that. The source plan's decision-layer diagram was corrected to show this after Inspector review.
- Any change to `.wf-run-actions-danger`. `Restart full workflow` and `Cancel run` keep their
  placement, tone and phrase confirmation.

## Repository findings

Two findings materially shaped this phase.

### `Open PR` cannot be made conditional in isolation

`WorkflowRuns.tsx:568` asserts the action is always present:

```ts
const openPrAction = gateActions.find((action) => action.kind === "open-pr")!;
```

and then dereferences `openPrAction.href`, `.tooltip` and `.label` unconditionally at `713-727`,
outside any policy guard. `inspectorGateActions` currently pushes `open-pr` unconditionally
(`run-actions.ts:93-103`), which is what makes the `!` true today. Adding the policy condition
without repairing this call site throws a `TypeError` for every non-inspector run. The repair is to
match the existing `preparePrAction`/`recheckAction` shape at `566-567`, which are found without `!`
and rendered as `{action && (…)}`.

`WorkflowLadder.tsx` is safe either way: it calls `inspectorGateActions(detail)` at `258` and `.map`s
over the result with a kind-based ternary (`524-543`), never destructuring `open-pr` out, and its
whole action row already sits inside `{inspectorPolicy && (` at `491` where
`inspectorPolicy = detail.version?.completionPolicy.kind === "inspector"` (`251-254`). The condition
is a no-op there, which is the point of putting the filter in the shared module.

### The unchanged-evidence state is derivable, but the request id is not

`runNextMove` can detect the refusal from `WorkflowRunDetail` alone. The manager persists it as a run
phase (`manager.ts:4420-4426`):

- `status: "waiting_for_session"`, `currentPhase: "unchanged_evidence"` while rounds remain;
- `status: "blocked"`, `currentPhase: "unchanged_evidence_exhausted"` once the nudge limit is passed.

The manager uses the same test as its own source of truth (`manager.ts:1159`, `manager.ts:3212`), and
the nudge delivery deliberately preserves the phase (`store.ts:854-859`). So the affordance is
durable across a remount, unlike the `unchangedRequest` ref.

**But the request id still matters and must not be dropped.** `unchangedRequest`
(`WorkflowRuns.tsx:1451`, a `useRef`) remembers the `requestId` of the refused POST. Replaying that
id makes the server find the failed submission by trigger key `manual:${binding.id}:${requestId}`
(`manager.ts:1153-1154`) and revive it **in the same round** (`manager.ts:1166-1171`). A fresh id
finds nothing and takes the `createRepairSubmission({ round: latest.round + 1 })` path
(`manager.ts:1227-1236`), **burning a repair round**. So:

- `runNextMove` decides *whether* to offer "Review this snapshot anyway", from detail.
- The existing `unchangedRequest` ref keeps deciding *which request id* to send, and must survive
  this refactor untouched.
- After a remount the ref is empty and the action still works, at the cost of one repair round. That
  is today's behaviour too; this phase does not regress it and does not attempt to fix it. A durable
  fix means the server surfacing the pending refusal's trigger key, which is out of scope.

### `Open PR` needs a URL, not a policy

Raised by Inspector review round 3 and confirmed. The condition that matters is
**`gate?.state.prUrl !== null`**, not the completion policy.

The two are not equivalent, and the gap is the common case: an `inspector`-policy run sitting in
`waiting_for_pr` is there *because* no PR has been adopted yet, with `waitReason` of `missing_pr` or
`unadopted_pr` (`run-actions.ts:70-72`). A policy-only gate keeps a destination-less `Open PR` on
exactly those runs - the disabled stand-in this phase exists to remove. `href` is already
`gate?.state.prUrl ?? null` today (`run-actions.ts:93`), so the URL is right there to test.

Nothing is lost by hiding it. A `waiting_for_pr` run's gate section already explains that no PR is
adopted and offers `Prepare PR in session` and `Recheck Inspector`, so a greyed-out header button
repeats a fact the page states properly a few sections down.

### Other findings

- `detail.summary` carries `round` and `maxRepairRounds` (`src/shared/workflow.ts:2177`, `:2213`), and
  `detail.run.currentPhase` carries the phase (`:1830`), so every row of the next-move table is
  decidable from detail without a second fetch.
- **Preview mode changes labels.** `preview = detail.binding.deliveryMode !== "live"`
  (`WorkflowRuns.tsx:590`), and today's labels branch on it: `Preview fresh evidence` versus
  `Submit fresh evidence` (`641`), `Preview unchanged` versus `Submit unchanged` (`658`).
  `runNextMove` must take the same branch, or `e2e/specs/workflow-blocked-resubmit.spec.ts:123-124`
  breaks - it binds with `deliveryMode: "preview"` and asserts the Preview labels.
- `resubmitAvailability` (`run-actions.ts:183-201`) already produces the three refusal sentences in
  the manager's own order. Those strings become the why-sentence rather than a disabled tooltip.
  Keep the function; `runNextMove` consumes it.
- `BLOCKED_PHASE_CLAUSES` (`run-model.ts:660-684`) has **no entry** for either unchanged-evidence
  phase, so `blockedPhaseClause` falls through to `phase.replaceAll("_", " ")` at `688` and renders
  the raw string "unchanged evidence exhausted". Fixing this belongs here because this phase is what
  puts phase-derived prose in front of the reader.
- `run-action-store.ts` is the wiring: `useRunActions(runId, onSettled)` returns
  `{ run, isPending, error }`, keyed module-level by `` `${runId}:${action}` `` so a navigation cannot
  duplicate an in-flight intent. Request ids are retained across failure and cleared on success, so
  the `send` callback **must rethrow**. The Runs page already holds a controller at
  `WorkflowRuns.tsx:1578`. One `RunActionId` per intent, never one per surface
  (`run-model.ts:1485-1487`).

## The next-move table

`runNextMove(detail)` returns at most one descriptor. Labels take the preview branch where the
underlying call is a submission.

| Run state | Move | Label (live / preview) | Route |
| --- | --- | --- | --- |
| `capturing`, `running` | none | - | - |
| `waiting_for_session`, phase not unchanged-evidence | resubmit | Resume review / Preview fresh evidence | `resubmit` |
| `waiting_for_session`, phase `unchanged_evidence` | resubmit unchanged | Review this snapshot anyway / Preview unchanged | `resubmit` + `resubmitUnchanged` |
| `waiting_for_pr`, gate offers the handoff | prepare-pr | Ask the session to open a PR | `prepare-pr` |
| `waiting_for_pr`, no handoff arm | recheck | Check again | `recheck-inspector` |
| `waiting_for_inspector` | recheck | Check again | `recheck-inspector` |
| `waiting_for_new_head` | recheck | Check again | `recheck-inspector` |
| `blocked`, `infrastructure_error` | retry | Retry the failed call | `retry` |
| `blocked`, `check_cleanup_unresolved` / `capture_*` | resubmit | Resume review / Preview fresh evidence | `resubmit` |
| `blocked`, `unchanged_evidence_exhausted` | resubmit unchanged | Review this snapshot anyway / Preview unchanged | `resubmit` + `resubmitUnchanged` |
| `blocked`, `inspector_disabled` | none - see the POST-only note below | - | - |
| `blocked`, `round_limit` / `session_disappeared` | none | - | - |
| `blocked`, delivery phases | none | - | - |
| `blocked`, `inspector_findings` / `inspector_pr_closed` | none | - | - |
| `completed`, `cancelled`, `failed` | none **in this phase** | - | Phase 3 adds `Run this review again` |

Guard order mirrors `resubmitAvailability`'s, which mirrors the manager's, so the primary never
promises a call the daemon will refuse. Where `resubmitAvailability` returns a refusal, the move is
`null` and the refusal string becomes the why-sentence.

### `runNextMove` is POST-only, and navigation stays out of it

**`RunNextMove` models exactly one thing: a mutation dispatched through `useRunActions`.** Every
descriptor it returns has a `path`, a `body` and an optional `confirm`, and every one of them is sent
by the shared action store, which owns the request-id retention that makes a retry idempotent. There
is no navigation kind, and the type must not grow one in this phase.

An earlier draft of this table returned `Turn Inspector on` with a "settings route" for
`blocked`/`inspector_disabled`. That was wrong on two counts, both verified:

1. **There is no route to send.** Inspector settings are opened through a **callback prop** -
   `onOpenInspectorSettings?: () => void` (`WorkflowRuns.tsx:449`, defaulted at `427`, threaded from
   `App.tsx:2172`). A `path` string has nothing to point at, so a POST descriptor could not express
   it and `useRunActions` could not dispatch it.
2. **The control already exists, in the section that owns it.**
   `WorkflowRuns.tsx:1069` already renders
   `<button className="btn btn-ghost" onClick={onOpenInspectorSettings}>Open Inspector settings</button>`
   inside the Inspector final gate section (`1029-1089`). Hoisting a second one into the header would
   duplicate a control forty lines down the same page.

So `inspector_disabled` is a **no-move** state, handled exactly like the delivery and findings phases:
`runNextMove` returns `null` and `runNoMoveReason` says why and names the section. The clause is
already written - `BLOCKED_PHASE_CLAUSES` has `inspector_disabled: "Inspector off"`
(`run-model.ts:669`) and the gate sentence map has "Inspector is switched off, so the gate cannot be
evaluated." (`run-model.ts:694`) - so the why-sentence composes from existing copy.

The benefit of holding this line: `useRunActions` dispatch stays **total** over `RunNextMove`. Every
value the type can hold is sendable, with no kind the render site has to special-case. If a future
change genuinely needs a navigation primary, that is a separate descriptor union modelled on
`GateAction` (`run-actions.ts:25-31`), which already mixes an `href`-carrying `open-pr` with two POST
kinds - not a widening of this one.

Every `blocked` arm that returns `null` still gets a why-sentence, composed from
`blockedPhaseClause` plus, for the phases whose decision lives in a section below, a pointer to that
section - "Confirm or discard it in Deliveries below", "Fix the findings below, then push",
"Turn Inspector back on in the Inspector gate below". That is the same closing move `runRemedy` makes
at `run-model.ts:1593-1596`.

## Implementation steps

1. **`src/web/workflows/run-actions.ts`**
   - Gate the `open-pr` push (`93-103`) on **a usable PR URL**: push it only when
     `gate?.state.prUrl` is non-null. That is the condition the adopted design states
     (`plan.md`, zone 2) and the one the reviewed mockup renders - a control named "Open PR" earns
     its place when there is a PR to open, and not otherwise.
     Requiring the URL **subsumes** the completion-policy check, since a run with no adopted PR has no
     `prUrl` whatever its policy, so a separate `completionPolicy.kind === "inspector"` condition is
     redundant. Keep it only if it reads more clearly beside the `prepare-pr` arm; do not rely on it
     alone. **Policy alone is not sufficient**: an `inspector`-policy run in `waiting_for_pr` is
     waiting precisely *because* no PR exists yet, so a policy-only gate would keep a destination-less
     Open PR on the exact runs this change is meant to clean up.
   - With that gate in place, `open-pr` can only ever hold a real URL, so **strengthen the type**:
     `href` becomes `string` rather than `string | null` and its `disabled` is always `false`. The
     compiler then rejects a future reintroduction of the destination-less entry, which is a better
     guard than a test. Drop the now-dead "This run has no adopted pull request" tooltip branch.
   - Add `export interface RunNextMove` carrying `id: RunActionId`, `label`, `tooltip`,
     `kind`, the POST `path` (a full path string), a `body` record for anything beyond
     `requestId`, and an optional `confirm: WorkflowConfirmDescriptor | null`. Model it on
     `RunRemedy` (`run-model.ts:1483-1497`) so the two read as siblings.
     **Keep it a single POST shape - do not add a navigation kind.** See the POST-only section
     above for why `inspector_disabled` is a no-move state rather than a settings link.
   - Add `export function runNextMove(detail, opts): RunNextMove | null` implementing the table.
     Take `preview` from `detail.binding.deliveryMode !== "live"` inside the function rather than as a
     parameter, so no caller can disagree with it.
   - Add `export function runNoMoveReason(detail): string | null` returning the why-sentence, so the
     header renders prose it did not compose.

2. **`src/web/workflows/run-model.ts`**
   - Add `unchanged_evidence` and `unchanged_evidence_exhausted` clauses to `BLOCKED_PHASE_CLAUSES`
     (`660-684`). Keep them phrased as what happened, per the comment at `679`.

3. **`src/web/workflows/WorkflowRuns.tsx`**
   - Replace the `openPrAction` non-null find at `568` with a plain `find` and render it
     conditionally at `713-728`, matching `preparePrAction`/`recheckAction`.
   - Compute `const nextMove = runNextMove(detail)` and `const noMoveReason = runNoMoveReason(detail)`.
   - Replace the five conditional control blocks at `630-695` (`Submit fresh evidence`,
     `Submit unchanged`, `Prepare PR in session`, `Retry provider call`, `Recheck Inspector`) with one
     primary `<button className="btn btn-primary">` driven by `nextMove`, wired through the existing
     `useRunActions` controller at `1578` and gated on `controller.isPending(nextMove.id)` with
     `runActionTooltip` supplying the busy copy.
   - Keep the resubmit path routing through the existing `resubmit(unchanged)` handler
     (`1593-1617`) so `unchangedRequest` keeps supplying the request id. Do not reimplement the POST.
   - Keep `Copy feedback` and the conditional `Open PR` as the context controls after the primary.
   - Render `{noMoveReason && <p className="wf-run-why">…</p>}` in the identity block between the
     facts row and the `<small>` timestamps.

4. **`src/web/styles.css`**
   - Add `.wf-run-why`: 12px, `var(--muted)`, `line-height: 1.5`, a max measure around 66ch, and a
     little vertical padding so it does not crowd the 10.5px `<small>` beneath it. The mockup settles
     these values.

## Data, API and migration

None. No new endpoint, no schema change. Every route this phase calls is already called from this
component today.

## Tests and verification

- **`test/workflow-runs-render.test.ts`**: replace the header-control assertions with a
  `runNextMove` unit table covering **every row** of the table above, including both preview and live
  labels and both unchanged-evidence phases. Add cases asserting the why-sentence text for the three
  `resubmitAvailability` refusals and for a delivery-blocked run.
- **`Open PR`, three cases**, since the policy-versus-URL distinction is what round 3 of review caught:
  absent when `completionPolicy.kind === "none"`; **absent when the policy is `inspector` but
  `gate.state.prUrl` is null** (a `waiting_for_pr` run - this is the case a policy-only gate would get
  wrong); and present, enabled, with the real href when `prUrl` is set. Assert absence, not
  `disabled === true`.
- Add a case asserting `runNextMove` returns `null` for `blocked`/`inspector_disabled` and that
  `runNoMoveReason` names the Inspector gate section. This is the regression guard for the POST-only
  invariant: it fails if somebody reintroduces a settings navigation as a primary.
- Add a type-level guard that every `RunNextMove` the table can produce carries a non-empty `path`,
  so a navigation descriptor cannot slip in without failing a test.
- Cases at `539` and `558` assert `Cancel run` on blocked runs; they must keep passing untouched,
  which is the regression guard that this phase left the danger row alone.
- **`test/workflow-ladder-actions.test.ts`**: add a case proving the ladder still renders its gate
  actions under an `inspector` policy and renders none under `"none"`, pinning the shared filter. Check
  this file first for an existing assertion that the ladder shows a **disabled** `Open PR`; if one
  exists it now asserts removed behaviour and must be retargeted to absence rather than deleted.
- **`e2e/specs/workflow-blocked-resubmit.spec.ts:116-156`** asserts `Preview fresh evidence`,
  `Preview unchanged` and the refusal tooltips on a `session_disappeared` run. Rewrite for the new
  shape: the run shows **no** submission control, shows the why-sentence naming the gone session, and
  shows `Cancel run`. The spec's seeding path is unchanged.
- **New `e2e/specs/workflow-next-move.spec.ts`**: seed a `waiting_for_session` run via the
  `E2E_FAIL_VERDICT` recipe (`workflow-blocked-resubmit.spec.ts:45-103`) and assert exactly one
  primary control is offered, that clicking it advances the run, and that no second submission
  control exists beside it.
- Commands: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run test:e2e`.

## Merge and exit criteria

- At most one primary control renders for any run state, and the `runNextMove` unit table covers
  every row.
- `RunNextMove` is a single POST shape with no navigation kind, and every value it can hold is
  dispatchable through `useRunActions` without a special case.
- A run with no move renders a why-sentence, never a disabled stand-in.
- `Open PR` is **absent whenever the run has no adopted PR URL** - including an `inspector`-policy run
  waiting on a PR - in both the Runs header and the ladder. Its `href` is a non-nullable `string`, it
  is never rendered disabled, and no `!` assertion remains on a conditionally pushed action.
- The two unchanged-evidence phases render prose, not `phase.replaceAll("_", " ")` output.
- Preview-mode labels still say Preview.
- `.wf-run-actions-danger` is byte-identical to Phase 1's output.
- All five verification commands pass.
- README: check the Workflows section for any enumeration of the run header's controls and update it
  if present.

## Downstream handoff

Later phases may rely on:

- **`runNextMove(detail)` being the only place a primary move is decided**, and returning at most one
  descriptor. Phase 3 adds the terminal-run arm to this function; it does not add a second derivation
  or a bespoke button.
- **`RunNextMove` being POST-only.** Phase 3's arm is a POST like every other, so it inherits this
  invariant unchanged. Any future navigation primary is a separate union modelled on `GateAction`, not
  a widening of this type.
- **`RunNextMove`'s shape**, including `path`/`body`/`confirm`. Phase 3's arm is the first to carry a
  non-null `confirm` and the first whose `path` is keyed by binding rather than run, so the `path`
  field must already be a full path string rather than a run-relative action name. It is.
- **`runNoMoveReason(detail)`** owning the why-sentence.
- **One `RunActionId` per intent**, keyed through the shared `run-action-store`.

Must not change: `runRemedy`'s signature or behaviour, the `.wf-run-actions-danger` group, or the
`unchangedRequest` request-id retention.

## Cross-phase audit record

- **Corrected after Inspector review round 3 (PR #439).** The Inspector found this phase's
  implementation step gated `open-pr` on the completion policy alone, while the adopted design
  (`plan.md` zone 2) says it renders only when `gate.state.prUrl` exists - so an `inspector`-policy run
  waiting on a PR would keep a destination-less `Open PR`, which is the disabled stand-in this phase
  exists to delete. Confirmed, and confirmed that the drift was the phase file's alone: `plan.md:196`
  and the mockup the human actually reviewed (`mockups.html:305`, "absent rather than disabled, because
  this run has no adopted PR") both already state the URL condition. Fixed by making the phase match
  them, not the reverse. Requiring the URL subsumes the policy check, so the step now also strengthens
  `open-pr`'s `href` to a non-nullable `string` with `disabled` always `false`, letting the compiler
  reject a reintroduction. Three test cases replace the single policy case, including the
  inspector-policy-without-URL case a policy-only gate would get wrong, and the ladder test bullet now
  warns that an existing disabled-`Open PR` assertion must be retargeted rather than deleted. No
  approved decision changed; this restores the plan's own stated behaviour.
- **Corrected after Inspector review round 2 (PR #439).** The Inspector found that the source plan's
  "after" decision-layer diagram showed `runNextMove` feeding `WorkflowLadder`, while this phase scopes
  `runNextMove` to the Runs header and leaves the ladder on `inspectorGateActions` - so the plan
  prescribed a shared-derivation migration no phase owned. Confirmed and fixed by correcting the
  diagram rather than by adding a ladder migration: the ladder takes no resubmit callback today
  (`WorkflowLadder.tsx:76-93`) and shows no submissions, so a ladder primary would change what the
  session pane does, which is outside the approved decision. The redrawn diagram now shows
  `runNextMove` feeding only the header and `inspectorGateActions` feeding both surfaces in **both**
  panels, which is also more accurate about the before state. Recorded as an explicit non-goal in this
  phase's scope so no agent re-infers it.
- **Corrected after Inspector review round 1 (PR #439).** The Inspector found that an earlier draft
  of the next-move table returned `Turn Inspector on` with a "settings route" while `RunNextMove` was
  specified as a POST descriptor dispatched through `useRunActions` - so the implementing agent would
  have had to either send a navigation through the action controller or invent an unplanned special
  case. Verified against the code and the finding was right, with the repository making it sharper
  than the comment did: `onOpenInspectorSettings` is a callback prop (`WorkflowRuns.tsx:449`), not a
  route, and `WorkflowRuns.tsx:1069` already renders an `Open Inspector settings` button inside the
  Inspector gate section. Of the two fixes the Inspector offered - add a navigation descriptor kind, or
  exclude navigation from this abstraction - the second was taken, because the first would have
  fabricated a `path` for a callback and duplicated an existing control. `inspector_disabled` is now a
  no-move state whose why-sentence names the gate section, matching the delivery and findings phases.
  The POST-only invariant is recorded in the scope, the interface step, the exit criteria, the
  downstream handoff and two new test cases. No approved decision changed: the user chose Mockup A's
  "one derived primary in the header", and this is a modelling correction beneath that choice. The
  source plan and both HTML renderings were updated to match.
- **Reconciled against Phase 1.** Same JSX region, so this phase depends on Phase 1 rather than
  running beside it. Phase 1's contract that the version badge owns composer navigation is honoured:
  no `Open version` button returns. Phase 1 deliberately left `Open PR` alone so the policy condition
  and the `!` repair land together here, in one diff.
- **Reconciled after Phase 3 authoring.** Phase 3 needs `RunNextMove.path` to hold a full path and
  `confirm` to be part of the interface from the start; both were folded into this phase's step 1 so
  Phase 3 adds a table row rather than widening a type. Confirmed Phase 3 touches no line this phase
  leaves ambiguous.
- **Reconciled against Phase 4.** No shared files. Phase 4 touches `SessionCard.tsx`,
  `ConsoleDetail.tsx` and possibly `src/web/lib/held.ts`; this phase touches `run-actions.ts`,
  `run-model.ts`, `WorkflowRuns.tsx` and `styles.css`.
  **Correction, applied while authoring Phase 4:** an earlier draft of this record claimed Phase 4 also
  edits `styles.css`. It does not - `.workflow-bind-chip` already exists and is already styled, so
  Phase 4 adds no CSS. `styles.css` is therefore touched only by Phases 1 and 2, which are sequential
  and so cannot conflict on it. No file in this plan is edited by two concurrent phases.
