# Phase 2: Ladder actions - feedback, gate and delivery

Part of `docs/plans/workflow-card-progress/phased-plan.md`. Source plan:
`docs/plans/workflow-card-progress/plan.md`. Source design: `mockups.html`, Option D, slots D2,
D3 and D4.

## Outcome

Every action Option D draws on the ladder works. The run states an operator must actually
*answer* become answerable from the session they are looking at, instead of requiring a trip to
the Runs page: a preview run whose feedback has to be carried to the agent by hand, a run parked
at the Inspector gate, and a repair delivery whose write may or may not have landed.

Option D's own note on D4 is the argument: an uncertain delivery "is the one workflow state that
is genuinely dangerous to guess about". This phase makes it actionable **without** making it
easier to get wrong - every guard the Runs page puts on these actions comes across intact.

## Entry criteria and dependencies

- **Direct prerequisites: the planning session's pull request, and Phase 1.**
- Phase 1 supplies the gate rung and the uncertain-delivery rung as rendered markup, so this
  phase adds an action row to existing structure rather than restructuring it.
- **Concurrent with Phase 3.** Neither consumes anything the other owns.

## Scope

- The changes-requested rung's **Copy feedback**, which is what a Preview-mode run needs: the
  repair packet is prepared and deliberately never typed into the session, so a human carries it.
- The Inspector-gate rung's **Recheck Inspector** and **Open PR** actions, plus **Prepare PR in
  session** where the run's policy offers it.
- The uncertain-delivery rung's **Mark delivered** and **Discard, send new round**, both behind
  the same confirmations the Runs page uses.
- Extracting the action copy and guards the two surfaces now share, so neither retypes a shipped
  sentence.

### Non-goals

- **No new endpoint and no new server behaviour.** Every action posts to a route that exists.
- **No weakening of any guard.** The typed phrase, the disabled-without-a-session rule and the
  idempotency key all come across exactly.
- **No fetching in `WorkflowLadder`.** It stays a pure renderer; the wrapper owns the detail hook
  and drives the shared action controller.
- **No second implementation of the in-flight guard.** Neither surface keeps its own pending set
  or mints its own request id once the controller exists.
- **No change to `useWorkflowRunDetail`'s signature.**

## Repository findings

- **Copy feedback** exists today at `WorkflowRuns.tsx:513`, driven by `copyFeedback`
  (`:1344`) and wired as `onCopyFeedback` (`:1564`). It writes the prepared repair packet to the
  clipboard via `navigator.clipboard.writeText` and flips the button label to "Copied" through a
  `feedbackCopied` state. It is the one action here that is purely local - no route, no
  idempotency key, no confirmation - and it is the action Option D's D2 slot draws, because a
  Preview-mode run prepares a packet it deliberately never types into the session.
- **Recheck Inspector** is shown whenever `inspectorGate.state.waitReason !== null`
  (`WorkflowRuns.tsx:488-494`), tooltip "Evaluate the gate again from Inspector's current durable
  ledger". It POSTs `/api/workflow-runs/:id/recheck-inspector` (`:1572-1576`; route
  `routes.ts:1020-1029`) → `WorkflowManager.recheckInspector(runId, requestId, now)`
  (`manager.ts:1161`), which is **idempotent per `requestId`** via the
  `inspector_recheck_requested` event (`:1185`).
- **Prepare PR in session** appears only for `waiting_for_pr` with wait reason `missing_pr` or
  `unadopted_pr` *and* `missingPrAction === "offer_prepare_pr"` (`WorkflowRuns.tsx:475-482`);
  route `POST /api/workflow-runs/:id/prepare-pr` (`routes.ts:1010-1019`). The shipped built-in is
  at **version 4**, whose policy is
  `{ kind: "inspector", onFindings: "inspector_only", missingPrAction: "offer_prepare_pr" }`
  (`builtin-workflows.ts:404-410`), so this arm is live. Note `completionPolicy` is now per
  version rather than per workflow (#305), and `onFindings` moved from `"restart_workflow"` to
  `"inspector_only"` at v4 - but `missingPrAction` is `"offer_prepare_pr"` on all four versions,
  so read the policy off the run's own version rather than assuming the current default.
- **Mark delivered** (`WorkflowRuns.tsx:903`): tooltip "Confirm the exact packet already reached
  the inspected pane"; modal title "Mark this packet delivered"; body "Confirm you inspected the
  session's pane and this exact repair prompt is in it. Marking it delivered ends the recovery.";
  hint "Records the packet as delivered without sending it again". No bound session required.
- **Discard and send new round** (`:930`): **disabled unless a session is bound** - tooltip
  "Discard this ambiguous packet and create a replacement repair round" when enabled, "The bound
  session is gone, so no replacement round can be prepared" when not; title "Discard and send a
  new repair round"; body "The pane may already hold this packet. Discarding it prepares a fresh
  repair round, which the session could receive twice."; **`requirePhrase: "DISCARD AND SEND A
  NEW REPAIR ROUND"`**.
- Both resolutions POST `/api/workflow-deliveries/:id/resolve` (`routes.ts:1050-1055`) with
  `ResolveWorkflowDeliverySchema` (`protocol.ts:2612-2625`) → `manager.resolveDelivery`
  (`manager.ts:1321`) → `store.resolveUncertainDelivery(id, action, requestId)`
  (`store.ts:3208-3291`), where `mark_delivered → "delivered"` and
  `discard_and_new_round → "cancelled"` with error `discarded_by_operator` (`:3234-3235`).
- A separate **Retry refused delivery** exists for `refused` packets (`WorkflowRuns.tsx:879-888`)
  with its own confirmation requirements (`RetryWorkflowDeliverySchema` carries `requestId`,
  `expectedSessionId`, `expectedNoteKey`). It is **out of scope**: the ladder draws the
  `uncertain` rung, not the `refused` one.
- **`sessionBound` has exactly one correct source, and it is already live.**
  `WorkflowRuns` computes `const sessionBound = detail.binding.sessionId !== null`
  (`WorkflowRuns.tsx:419`) under a doc comment that is itself the rule: "ONE field answers it for
  every control that needs a session ... a second source for one fact is how a link stays enabled
  onto a session that is gone" (`:412-418`). That field is **not** a historical id:
  `orphanBinding` (`store.ts`) runs
  `UPDATE workflow_bindings SET state = 'orphaned', session_id = NULL` and is driven by
  `session_remove`, the durable eviction signal. The same transaction sets the active run
  `blocked` and appends `binding_orphaned`, which moves the run's `updatedAt` and republishes the
  SSE summary - so a ladder refetching on `updatedAt` (Phase 1's hook) picks up the change
  without any additional wiring.
- **The viewed session is NOT that signal.** `ConsoleDetail` has a live `session`, but it is the
  session whose card is open, not necessarily the session the *delivery* targets: a binding's
  `sessionId` is re-pointable, and `workflowRunBySession` joins by newest-updated run per session.
  Deriving `sessionBound` from the viewed session would be the second source that comment warns
  against, and the two would disagree exactly when it matters.
- `WorkflowConfirmModal` (`WorkflowConfirmModal.tsx:64`) takes a `WorkflowConfirmRequest` with
  `title`, `body`, `confirmLabel`, `confirmHint`, `danger`, optional `requirePhrase` and
  `onConfirm`. Each consuming surface holds its own `confirm` state and renders its own instance
  (`WorkflowRuns.tsx:1616`, `WorkflowLibrary.tsx:1070`, `PersonaLibrary`, `App.tsx:1973`). The
  ladder follows that pattern.

## Implementation steps

### 1. `src/web/workflows/run-actions.ts` (new) - the shared descriptors

Phase 1's handoff forbids retyping a shipped sentence. Two surfaces now offer the same five
actions, so the copy and the guards move to one module returning plain data:

```ts
/** Stable per-action key: "recheck-inspector", "prepare-pr", `delivery:${id}:mark_delivered`, … */
export type RunActionId = string;

export function deliveryResolutionActions(
  delivery: WorkflowDelivery,
  /** MUST be `detail.binding.sessionId !== null`. See below - there is no second source. */
  sessionBound: boolean,
): DeliveryAction[];           // id, label, tooltip, disabled, confirm: WorkflowConfirmRequest-minus-onConfirm

export function inspectorGateActions(
  detail: WorkflowRunDetail,
): GateAction[];               // id, recheck / open-pr / prepare-pr, already filtered by waitReason and policy
```

- The descriptors carry **no `onConfirm`**: the caller supplies the effect, the module supplies
  the words and the guards. That is what makes both surfaces provably identical without coupling
  them to each other's mutation code.
- **Every descriptor carries a stable `id: RunActionId`.** This is what lets the controller in
  step 2 key pending state to an action without either surface inventing its own naming.
- **`sessionBound` is supplied by the caller as `detail.binding.sessionId !== null`, and by
  nothing else.** Both surfaces already hold the detail, so both can answer it from the one field
  the server nulls on orphan. `WorkflowLadderPanel` passes it down; `WorkflowLadder` does **not**
  derive it, and must not be given the viewed `Session` in order to guess at it. Spelling this
  out is the difference between a plan an implementer can follow and one where the destructive
  replacement action is enabled by a guess.
- **`WorkflowRuns.tsx` is refactored to consume these**, deleting its inline copies. This is a
  narrow, copy-only refactor and is explicitly *not* the `load()` refactor Phase 1 ruled out;
  the fetch path is untouched.

### 2. `src/web/workflows/run-action-store.ts` (new) - the shared executable guard

Descriptors are pure data and therefore **cannot** hold an in-flight flag or retain a request id.
But React state cannot hold it either, and that is the sharper constraint: the two surfaces live
on **different pages** (`route.page === "workflows"` for the Runs monitor,
`"fleet"` for the session detail, `App.tsx:1448-1471`), so they are never mounted together.
Navigating from one to the other **unmounts** the surface holding the pending state while its
POST is still in flight. Per-hook state is therefore guaranteed to be destroyed by exactly the
transition an operator makes, and the second surface would mint a fresh id for the same intent.

So the state lives **outside the React tree**, in a module-level store keyed by run and action:

```ts
const keyOf = (runId: WorkflowRunId, action: RunActionId): string => `${runId}:${action}`;

export function runAction(
  runId: WorkflowRunId,
  action: RunActionId,
  send: (requestId: string) => Promise<unknown>,
  onSettled: () => void,
): void;
export function isRunActionPending(runId: WorkflowRunId, action: RunActionId): boolean;
export function dropRunActions(runId: WorkflowRunId): void;

/** Subscribes a surface to the entries for one run. */
export function useRunActions(runId: WorkflowRunId, onSettled: () => void): RunActionsController;
```

This is the **`lib/drafts.ts` pattern**, and for the same stated reason: that map exists because
"the text has to outlive every mount that can end under it, and each of those mounts is exactly
what the old state was tied to" (`drafts.ts:12-15`). Pending action state has precisely that
shape.

One deliberate difference from drafts: drafts are explicitly "NOT a store with subscribers -
nothing renders from it" (`drafts.ts:17`). This one **does** need subscribers, because a button's
disabled state renders from it. It is a small store with a subscription hook rather than a bare
map; do not copy the no-subscriber decision along with the map.

- **One request id per run+action, minted on first run and retained until that request settles.**
  A retry of the same intent after a failure reuses it, which is what the idempotency key is
  actually for - and follows the existing `unchangedRequest` precedent
  (`WorkflowRuns.tsx:1200`, `:1321-1337`). It is cleared on success.
- **A second activation while that key is pending issues nothing**, whichever surface it comes
  from. This, not the request id, is what makes a double-click safe.
- `onSettled` is the caller's refetch, so the store owns no fetching of its own.
- **`dropRunActions` is driven by `workflow_run_remove`**, the same shape as `dropSessionDrafts`
  being driven by `session_remove`. Without it a run deleted by the retention sweep leaves an
  entry nothing will ever clear.

**Both surfaces consume this store**, and each renders an action as disabled when
`descriptor.disabled || controller.isPending(descriptor.id)`.

**What this closes, and what it honestly does not.** It closes the in-app case, including the
cross-surface navigation above, which is the one an operator actually hits. It does **not** close
two browser tabs or two machines: those are separate module instances, so the same intent can
still be submitted twice with different ids. Closing that requires the server to deduplicate the
*intent* rather than the client-supplied id, which is a change to
`WorkflowManager.recheckInspector` / `resolveDelivery` semantics and is outside this phase's
"no new server behaviour" boundary. It is recorded here as the known residual rather than left
implied, and the scope is the tab - the same bargain `drafts.ts` states about itself.

**This closes a real gap in the shipped Runs page, not just a risk in new code.** Its click sites
call `crypto.randomUUID()` inline (`WorkflowRuns.tsx:1555-1594`) with no in-flight guard - the
only `disabled` conditions there are `!sessionBound`, `!feedbackAvailable`, `!version` and
`listLoading`. Fixing only the ladder would leave the double-submit live on the surface that has
shipped longest, and copying the existing pattern into the ladder would duplicate the defect.

### 3. `src/web/workflows/WorkflowLadder.tsx`

- Add optional callback props: `onCopyFeedback`, `onRecheckInspector`, `onPreparePr`, `onOpenPr`,
  `onResolveDelivery(deliveryId, action)`, plus a `feedbackCopied: boolean` flag. Absent
  callbacks render no action row, so the component stays drawable from a test with a literal
  detail.
- Render `wf-ladder-actrow` on three rungs: the **changes-requested** rung (Copy feedback, whose
  label reads "Copied" while `feedbackCopied` is true), the **gate** rung and the
  **uncertain-delivery** rung, from `inspectorGateActions` / `deliveryResolutionActions`. A
  disabled action still renders, with its disabled tooltip - the operator has to be able to see
  *why* discarding is unavailable.
- The component still **never fetches, never posts and never touches the clipboard**. The
  `feedbackCopied` flag arrives as a prop precisely so the renderer stays pure and the "Copied"
  state is assertable from a static render.

### 4. `WorkflowLadderPanel` (same file)

- Hold `confirm: WorkflowConfirmRequest | null` and render `<WorkflowConfirmModal>`, the pattern
  every other surface uses.
- Own the clipboard write for Copy feedback and the `feedbackCopied` flag it passes down,
  mirroring `WorkflowRuns`' `copyFeedback` (`:1344`) rather than reimplementing which text is
  copied. The packet is the same packet; the two surfaces must not disagree about it.
- **Drive every POST through `useRunActions(run.id, refetch)` from step 2**, passing the
  descriptor's `id` and a `send` that builds the request with the supplied request id. The panel
  holds no pending state and mints no request id of its own; doing either would be a second
  implementation of the guard, and since the two surfaces never mount together it would not even
  fail loudly.
- Pass `controller.isPending(id)` into the renderer so a pending action renders disabled, and
  render `controller.error` inline rather than throwing out of a click handler.
- `onSettled` is the panel's refetch.

### 5. `src/web/styles.css`

Extend the `/* ---- workflow stage ladder ---- */` section with `wf-ladder-actrow` and its
button states, including a visibly disabled state. Reuse the existing button tokens; add no
vendor-named token.

### 6. `README.md`

Note in "Workflows and Personas" that the ladder can answer the Inspector gate and resolve an
uncertain delivery in place, under the same confirmations as the Runs page.

### 7. Tests

- `test/workflow-ladder-actions.test.ts` - render the gate rung and assert Recheck is offered
  when `waitReason` is non-null and absent when it is null; assert Prepare PR appears only for
  `missing_pr` / `unadopted_pr` with `missingPrAction: "offer_prepare_pr"`; assert the
  changes-requested rung offers Copy feedback and that its label reads "Copied" when
  `feedbackCopied` is true.
- `test/workflow-delivery-actions.test.ts` - **the guard regression**: assert
  `deliveryResolutionActions` returns "Discard and send new round" as **disabled** when no
  session is bound, and that its confirm descriptor carries `requirePhrase` exactly equal to
  `DISCARD AND SEND A NEW REPAIR ROUND`. Assert the same descriptors are what `WorkflowRuns`
  renders, so the two surfaces cannot drift.
  **The disappeared-session case gets its own assertion**: a detail whose
  `binding.sessionId` is `null` while `summary.sessionId` still carries an id must render the
  discard action **disabled** with the "The bound session is gone" tooltip. That combination is
  reachable, and it is the one that decides whether the destructive action is offered for a pane
  that no longer exists.
- `test/workflow-action-inflight.test.ts` - **the double-submit regression**, asserted against
  the module-level store, which is what makes it cover both surfaces rather than one renderer:
  a second `runAction` for a run+action already in flight issues **no** second request; the
  request id is minted once and reused for an explicit retry after failure, then cleared on
  success; `isRunActionPending` is true for exactly the key in flight, so an unrelated action and
  an unrelated run stay enabled; and `dropRunActions` clears a run's entries.
  **The case that motivated the store gets its own test**: start an action, simulate the first
  surface unmounting (the page switch), and assert a second subscriber for the same run still
  reports it pending and still refuses to issue a second request. React state would pass every
  other case here and fail this one.

## Data, API and compatibility

- No schema change, no migration, no new route, no SSE change.
- All three POSTs already exist and are already validated server-side by zod through `parseBody`.
- Every action is idempotent per `requestId`, so a retry after a dropped response cannot double-
  apply.

## Tests and verification

```
npm run typecheck
npm test
npm run build
```

Manual: park a run at the Inspector gate and recheck it from the detail pane; drive a delivery to
`uncertain` and confirm the discard action refuses to enable without the typed phrase, and stays
disabled when the bound session is gone.

## Merge and exit criteria

- CI green on Node 24 and Node 26.
- Both delivery resolutions require exactly what the Runs page requires.
- `WorkflowRuns` and the ladder read their action copy from one module.
- **No action can be submitted twice by double-clicking it, on either surface, and starting one
  on the Runs page then opening the session detail before it settles does not allow a second
  submission.** A pending action renders disabled and issues exactly one request. This is
  implementable because the guard lives in a module-level store both surfaces read - a pure
  descriptor could not have held it, and React state would have died with the page switch.
- README updated in this same change.

## Downstream handoff

Nothing depends on this phase. It establishes, for anyone extending the ladder later:

- **Action copy and guards live in `run-actions.ts`** as pure descriptors with stable ids, never
  inline in a surface.
- **In-flight state and request ids live in `run-action-store.ts`**, a module-level store keyed
  by run and action - deliberately outside the React tree, because the two surfaces are on
  different pages and never mount together. A descriptor describes; the store runs. Anything
  adding an action to either surface inherits the guard by using it, and a surface that keeps its
  own pending set has reintroduced the defect in a way no test of that surface can catch.
- **The residual is known and bounded**: the store's scope is the tab, so two tabs can still
  submit one intent twice. Closing that needs server-side dedup of the intent, not a client
  change.
- **`sessionBound` is `detail.binding.sessionId !== null` and has no second source.** The server
  nulls that column on orphan, so it is a live signal rather than a historical one; anything
  deriving it from a rendered `Session` has created the divergence the shipped doc comment
  warns about.
- **The renderer stays pure**; mutations belong to the panel wrapper via the controller.
- **A disabled action renders with its reason** rather than disappearing.
- **An in-flight action is disabled.** A `requestId` makes a *retry* safe, not a second click.

## Cross-phase audit record

- Reconciled against Phase 1: this phase adds callback props to `WorkflowLadder` and does not
  change `useWorkflowRunDetail`'s signature, honouring Phase 1's handoff. It renders into the
  gate and delivery rungs Phase 1 already draws.
- **A gap in the first draft of this phase was caught during the final audit and closed here.**
  The phase originally covered only the gate and delivery actions, which left Option D's D2 slot
  - "Copy feedback" - owned by no phase at all: Phase 1 rules out in-place actions and Phase 3 is
  the repeat-offender derivation. Because it ships today on the Runs page and is the only way a
  Preview-mode run's packet reaches the agent, an unowned Copy feedback would have been a drawn
  affordance that never got built. The phase was renamed from "Gate and delivery actions" to
  "Ladder actions" to own all three.
- **One tension with Phase 1 was found and resolved.** Phase 1's non-goal says "no refactor of
  `WorkflowRuns.tsx`". That non-goal is about its `load()` fetch path, which stays untouched.
  This phase does modify `WorkflowRuns.tsx` to consume shared action descriptors, which is
  required by Phase 1's own stronger handoff rule that no shipped sentence may be retyped. The
  narrower reading would have forced a second copy of five confirmation bodies. Phase 1's non-goal
  text was left as written because it is accurate about the fetch path; this record is the
  reconciliation.
- **Corrected after Inspector review of the planning PR (#308).** The first draft claimed the
  `requestId` was "what makes a double-click safe". It is not: idempotency per request id
  protects a retry of the *same* request, while two clicks mint two ids and can enqueue two
  rechecks or two delivery resolutions. Checking the shipped code made the finding stronger than
  reported - the Runs page mints its ids inline at each click site
  (`WorkflowRuns.tsx:1555-1594`) with no in-flight guard, so this is a live gap there and not
  only a risk in new code. The guard now belongs to the shared descriptors so both surfaces get
  it, with `test/workflow-action-inflight.test.ts` covering them together.
- **Corrected again after Inspector round 3 on the planning PR (#308).** The previous revision
  said the in-flight guard "belongs in the shared layer", but the shared layer it specified was
  pure descriptors, which by design carry no effects and therefore cannot hold a pending flag or
  retain a request id. The ladder's panel could have guarded itself while `WorkflowRuns` kept
  minting an id per click, so the exit criterion "neither surface can double-submit" was not
  implementable from what the plan described. The guard now has an executable home,
  `useRunActions`, that both surfaces call; descriptors gain a stable `id` so the controller can
  key pending state to them; and the regression test asserts the controller rather than a
  renderer, which is what makes it cover both surfaces.
- **Corrected a third time after Inspector round 4 (#308), and the finding was right again.**
  Round 3's fix put the guard in a hook, which two surfaces calling it would instantiate twice.
  Verifying it made the problem worse than reported rather than better: the Inspector described
  concurrent mounts, but the Runs monitor and the session detail are on **different pages**
  (`App.tsx:1448-1471`), so they are never mounted together and the pending state is
  *guaranteed* to be destroyed by the very navigation in the scenario. The guard now lives in a
  module-level store keyed by run and action, following `lib/drafts.ts`, which exists for exactly
  this failure ("the text has to outlive every mount that can end under it"). The residual - two
  tabs - is stated rather than implied, with server-side intent dedup named as what would close
  it and why that is outside this phase.
- **Inspector round 5 (#308)** was on the source design rather than this phase: the mockups' C3
  annotation still described `onFindings: "restart_workflow"`. Corrected in `mockups.html`
  without discarding Option C's argument, which survives the change because the gate still
  consumes a round under `inspector_only`.
- **Inspector round 6 (#308): the gap was real, the stated mechanism was not, and the proposed
  remedy would have introduced a defect.** The plan did not say where `sessionBound` came from,
  so an implementer could indeed have guessed - that part is fixed, and the disappeared-session
  case now has its own assertion. But the premise that the id is historical is wrong:
  `orphanBinding` sets `session_id = NULL` in the same transaction that blocks the run and
  appends `binding_orphaned`, driven by `session_remove`, so the field is live and the resulting
  summary change drives Phase 1's refetch. And the suggested fix - threading a bound-session
  boolean from `ConsoleDetail` or the session registry - is specifically rejected: the viewed
  session is not necessarily the delivery's target session, so that would be the "second source
  for one fact" `WorkflowRuns.tsx:412-418` warns against, disagreeing exactly when it matters.
  The plan now names the one field and forbids the second.
- Reconciled against Phase 3 (concurrent): the two touch `WorkflowLadder.tsx`, `styles.css` and
  `README.md` in disjoint regions - this phase in the gate and delivery rungs' action rows, Phase
  3 in the failing stage's rung. Ordinary textual conflicts, resolvable at merge; whichever
  merges second rebases. Neither depends on the other's contract.
