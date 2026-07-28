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
- **No fetching in `WorkflowLadder`.** It stays a pure renderer; the wrapper owns the hook and
  now also owns the mutation-and-refetch.
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
export function deliveryResolutionActions(
  delivery: WorkflowDelivery,
  sessionBound: boolean,
): DeliveryAction[];           // label, tooltip, disabled, confirm: WorkflowConfirmRequest-minus-onConfirm

export function inspectorGateActions(
  detail: WorkflowRunDetail,
): GateAction[];               // recheck / open-pr / prepare-pr, already filtered by waitReason and policy
```

- The descriptors carry **no `onConfirm`**: the caller supplies the effect, the module supplies
  the words and the guards. That is what makes both surfaces provably identical without coupling
  them to each other's mutation code.
- **`WorkflowRuns.tsx` is refactored to consume these**, deleting its inline copies. This is a
  narrow, copy-only refactor and is explicitly *not* the `load()` refactor Phase 1 ruled out;
  the fetch path is untouched.

### 2. `src/web/workflows/WorkflowLadder.tsx`

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

### 3. `WorkflowLadderPanel` (same file)

- Hold `confirm: WorkflowConfirmRequest | null` and render `<WorkflowConfirmModal>`, the pattern
  every other surface uses.
- Own the clipboard write for Copy feedback and the `feedbackCopied` flag it passes down,
  mirroring `WorkflowRuns`' `copyFeedback` (`:1344`) rather than reimplementing which text is
  copied. The packet is the same packet; the two surfaces must not disagree about it.
- Perform the POSTs through `workflowRequest`, then refetch.
- **Hold a per-action in-flight flag and disable the action while its request is pending.** This
  is what makes a double-click safe - **not** the `requestId`. Idempotency per request id
  protects a *retry of the same request* (a dropped response, a reconnect); two clicks produce
  two different ids and therefore two accepted rechecks, or two delivery resolutions. If an
  explicit retry of the same intent is offered, retain and reuse the one id until that request
  settles, the way `resubmit` retains `unchangedRequest` (`WorkflowRuns.tsx:1200`, `:1321-1337`)
  for its unchanged-evidence confirmation.
- Surface a failed mutation as an inline error on the panel, not a thrown promise.

**This is a real gap in the shipped Runs page, not just a risk in new code.** Its click sites
call `crypto.randomUUID()` inline (`WorkflowRuns.tsx:1555-1594`) with no in-flight guard - the
only `disabled` conditions there are `!sessionBound`, `!feedbackAvailable`, `!version` and
`listLoading`. Since this phase already extracts the shared descriptors and refactors that file
to consume them, **the in-flight guard belongs in the shared layer so both surfaces get it**.
Fixing only the ladder would leave the double-submit live on the surface that has shipped
longest, and copying the existing pattern into the ladder would duplicate the defect.

### 4. `src/web/styles.css`

Extend the `/* ---- workflow stage ladder ---- */` section with `wf-ladder-actrow` and its
button states, including a visibly disabled state. Reuse the existing button tokens; add no
vendor-named token.

### 5. `README.md`

Note in "Workflows and Personas" that the ladder can answer the Inspector gate and resolve an
uncertain delivery in place, under the same confirmations as the Runs page.

### 6. Tests

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
- `test/workflow-action-inflight.test.ts` - **the double-submit regression**: an action whose
  request is in flight renders disabled, and a second activation while pending issues no second
  request. Assert it against the shared descriptors so it covers the Runs page and the ladder
  together.

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
- **No action can be submitted twice by double-clicking it, on either surface.** A pending action
  renders disabled and issues exactly one request.
- README updated in this same change.

## Downstream handoff

Nothing depends on this phase. It establishes, for anyone extending the ladder later:

- **Action copy and guards live in `run-actions.ts`**, never inline in a surface.
- **The renderer stays pure**; mutations belong to the panel wrapper.
- **A disabled action renders with its reason** rather than disappearing.
- **An in-flight action is disabled.** A `requestId` makes a *retry* safe, not a second click;
  anything adding an action to either surface inherits the in-flight guard.

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
- Reconciled against Phase 3 (concurrent): the two touch `WorkflowLadder.tsx`, `styles.css` and
  `README.md` in disjoint regions - this phase in the gate and delivery rungs' action rows, Phase
  3 in the failing stage's rung. Ordinary textual conflicts, resolvable at merge; whichever
  merges second rebases. Neither depends on the other's contract.
