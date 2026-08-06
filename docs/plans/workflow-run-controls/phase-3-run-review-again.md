# Phase 3 - Run this review again

## Outcome

A finished run offers the one thing a finished run can offer: running the same workflow against the
same session again. `runNextMove` gains its terminal arm, and the header's primary becomes
**Run this review again** on `completed`, `cancelled` and `failed`.

Value: this closes the plan's largest functional gap. Today a terminal run renders six controls and
none of them run anything, and there is no path anywhere in the product back to reviewing that
session again.

## Entry criteria and dependencies

- **Direct phase dependency: Phase 2.** This phase adds a row to `runNextMove`'s table and reuses
  `RunNextMove`'s `path`, `body` and `confirm` fields, all of which Phase 2 establishes.
- May merge in either order with Phase 4. No shared files.

## Scope

In scope:

1. The `completed` / `cancelled` / `failed` arm of `runNextMove`, returning a binding-keyed submit.
2. The client call and confirmation, and routing to the new run once it exists.
3. Client-side preconditions mirroring the manager's refusals.

Non-goals:

- Any new or changed server route. The endpoint already exists and this phase adds nothing to
  `src/server`.
- Retiring or re-binding a binding. If the binding is not `active`, this phase offers nothing and
  says why; the bind dialog remains the path for that.
- The `＋ workflow` bind chip on session surfaces: **Phase 4**. The two are complementary but share
  no code.

## Repository findings

The capability exists and needs no endpoint. Verified:

- **The route.** `POST /api/workflow-bindings/:id/submit` (`src/server/routes.ts:1063-1075`) parses
  `SubmitWorkflowSchema` at `src/server/routes.ts:1066`. That schema is
  `src/shared/protocol.ts:2845-2847` and is exactly one field:

  ```ts
  export const SubmitWorkflowSchema = z.object({
    requestId: z.string().min(1).max(200),
  });
  ```

  The route then calls `manager.enqueueSubmit`, which shares `prepareSubmit` with `manager.submit`
  (`src/server/workflows/manager.ts:1024-1062`). Note `ManualWorkflowSubmitSchema`
  (`protocol.ts:2849`) is an alias of the same object, so there is nothing extra to send.
- **A terminal run does not block a new one.** `activeRunForBinding` defines "open" purely by SQL
  exclusion of the three terminal statuses (`src/server/workflows/store.ts:2468-2475`:
  `WHERE binding_id = ? AND status NOT IN ('completed','cancelled','failed')`), so the `run_active`
  refusal at `manager.ts:1042-1045` stops firing the moment the prior run finishes.
- **The binding survives completion.** Nothing in the completion path writes
  `workflow_bindings.state`. The only writers are `orphanBinding` (`store.ts:5168`), `pauseBinding`
  (`store.ts:5201`) and `archiveBindingAndCancel` (`store.ts:5234`), reached only from
  session-disappearance reconciliation and explicit archive.
- **No once-only guard.** The only per-submission guard is the `requestId`-derived trigger key
  `manual:${binding.id}:${requestId}` (`manager.ts:1034`), which is idempotency, not exclusivity.
  `test/workflow-bindings-http.test.ts:388-424` already pins submit → idempotent replay → completed
  with the binding untouched.
- **`detail.binding.id` is on the wire.** `detail.binding` is the whole `WorkflowBinding` row
  including `id` (`src/shared/workflow.ts:1807-1823`); `store.runDetail` puts it there
  (`store.ts:5080`, `:5098`) and `manager.decorateRun` only adds `inspectorGate`
  (`manager.ts:864-878`). `detail.summary.bindingId` also exists (`src/shared/workflow.ts:2154`).
- **The precedent in the UI.** `WorkflowBindingDialog.tsx:414-418` already makes exactly this call
  under the label "Submit bound version", with a fresh `crypto.randomUUID()` at `:234-240`, then
  routes to the new run via `onRun(result.run.id)`. The response is `202` with `{ run, submission }`
  still in `capturing`, or `200` with `idempotent: true` on a replay.
- **Refusals to mirror, in the manager's order** (`prepareSubmit`, `manager.ts:1030-1045`): binding
  missing → 404; `binding.state !== "active"` → `inactive_binding`; `requestId` replay → the same run
  with `idempotent: true`; an active run → `run_active`. Additionally
  `externallySourced(run)` runs cannot take a manual round - `resubmitAvailability` already refuses
  those (`run-actions.ts:194-196`) and the same guard applies here.

The one behavioural note worth stating plainly: this creates a **new run**, so the user's current page
becomes history. The dialog's precedent is to route to the new run, and this phase follows it.

## Implementation steps

1. **`src/web/workflows/run-actions.ts`**
   - Add the terminal arm to `runNextMove`. Return `null` unless
     `detail.binding.state === "active"`, `detail.externalSource` is unset, and the run status is one
     of the three terminal statuses. Prefer `WORKFLOW_RUN_TERMINAL_STATUSES` from
     `@shared/workflow.ts:1119` over a local list, so a fourth terminal status reaches this arm
     automatically.
   - `path` is `/api/workflow-bindings/${encodeURIComponent(detail.binding.id)}/submit`. This is the
     first `RunNextMove` whose path is keyed by binding rather than run, which is why Phase 2 defined
     `path` as a full string.
   - `body` is `{}` - the route needs only `requestId`.
   - Label: `Run this review again` live, `Preview this review again` when
     `detail.binding.deliveryMode !== "live"`, taking the same preview branch every other label takes.
   - `confirm` is non-null and **not** phrase-gated: title "Run this review again", body naming the
     workflow, its version and the session, and stating plainly that it captures fresh evidence,
     starts a new run, and spends model tokens. `confirmHint` "Starts a new run against the same
     session".
   - When the binding is not active, return `null` and let `runNoMoveReason` say so. Extend
     `runNoMoveReason` with that sentence for terminal runs: the binding is gone, so this review
     cannot be run again from here.

2. **`src/web/workflows/WorkflowRuns.tsx`**
   - The primary button added in Phase 2 already renders whatever `runNextMove` returns, so no new
     button is needed. What is needed is the response handling: this is the only move whose POST
     returns a **different run id**, so on success route to it with the existing hash navigation
     (`#/runs/${result.run.id}`) rather than calling `load()` on the old run.
   - Wire it through the shared `useRunActions` controller at `1578` like every other action, with a
     distinct `RunActionId` (`run-again`) so pending state and request-id retention work. The `send`
     callback must rethrow on failure, per `run-action-store.ts`'s retention contract.
   - Handle the `idempotent: true` response by routing to the returned run just the same; a replay is
     not an error.
   - Surface `run_active` and `inactive_binding` failures through the existing page error path. They
     should be unreachable given the client guards, but a race between two tabs can produce them.

3. **`src/web/styles.css`** - nothing. The primary uses `.btn-primary`, already in place.

## Data, API and migration

No change. One existing route gains a second caller.

Wire contract touched: none. `SubmitWorkflowSchema` is unchanged, and the response shape
(`{ run, submission, idempotent? }`) is already consumed by `WorkflowBindingDialog`.

## Tests and verification

- **`test/workflow-runs-render.test.ts`**: extend the `runNextMove` unit table with the terminal
  rows - `completed`, `cancelled` and `failed` each returning the binding-keyed submit with a
  non-null `confirm`; an orphaned or paused binding returning `null` with the reason sentence; an
  externally sourced terminal run returning `null`. Assert the path is the binding submit route and
  **not** a `/api/workflow-runs/` path, which is the regression guard against copying the resubmit
  shape.
- Add a case pinning the preview label branch on a terminal run.
- **New `e2e/specs/workflow-run-again.spec.ts`**: seed a completed run using the recipe from
  `e2e/specs/workflow-skipped-status.spec.ts:44-95`, which returns the run id and is the suite's
  simplest completed-run path. Assert the header offers `Run this review again`, that confirming it
  produces a **new** run id distinct from the first, and that the new run reaches a non-terminal
  status. Copy `api` and `dispatch` from the same sibling - there is no shared helper module and each
  workflow spec carrying its own copies is the established pattern.
- The e2e spec must bind with `deliveryMode: "preview"` or assert the live label accordingly; pick one
  and make the assertion match the seed.
- Commands: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run test:e2e`.

## Merge and exit criteria

- A `completed`, `cancelled` or `failed` run with an active binding offers exactly one primary,
  `Run this review again`, and confirming it lands the user on a new run.
- A terminal run whose binding is orphaned or paused offers no primary and says why.
- No new server route, and `src/server` is untouched by this phase's diff.
- All five verification commands pass.
- README: the Workflows section should mention that a finished run can be run again from the run page.
  Update it in this phase.

## Downstream handoff

Nothing depends on this phase. It is a leaf.

What a future change must preserve: `runNextMove`'s terminal arm is keyed by
`detail.binding.id`, and it is the only arm whose success routes away from the current run. Anything
that later unifies the action dispatch must keep that asymmetry.

## Cross-phase audit record

- **Reconciled against Phase 2.** Confirmed `RunNextMove.path` is a full path string and `confirm` is
  part of the interface from Phase 2's step 1, so this phase adds a table row and a response handler,
  not a type widening. Confirmed Phase 2 leaves `runNextMove` returning `null` for terminal statuses,
  so there is no arm to override here - only one to add.
- **Reconciled against Phase 1.** No overlap. Phase 1's audit disclosure is untouched; this phase adds
  no control to it and does not reintroduce anything Phase 1 removed.
- **Reconciled against Phase 4.** Disjoint files. Phase 4 fixes the session surfaces' bind chip so a
  finished run stops hiding it; this phase fixes the run page. Both address "you cannot run it again"
  from opposite ends, and neither is required for the other to be correct or shippable. Verified
  Phase 4 touches no file this phase edits, so either merge order is safe.
