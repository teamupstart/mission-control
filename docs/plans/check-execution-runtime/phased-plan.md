# Phased implementation: check execution runtime and the automatic repair loop

Source plan: `docs/plans/builtin-workflows/phase-2-check-node.md` - specifically its
**dependency-linked execution-runtime unit**, the split that document recorded at lines 44-50
and whose escape hatch it authorised at lines 40-42 and 428-430:

> The implementing change must answer every item with a real design and focused failure test.
> If that design is materially larger than the graph, settings, and presentation work in this
> phase, split the check execution runtime into its own dependency-linked implementation unit.

It is materially larger. This is that unit, plus the repair-loop work the operator asked for
in the same breath, because a gate that can fail is only useful if the loop that repairs it
runs to completion.

Rendered page: `phased-plan.html` beside this file. Phase detail lives in the four
`phase-<n>-*.md` files linked below; this index is the contract between them.

## Why this is not written beside the source plan

The `phased-plan` skill says to write artifacts beside the source plan. Doing that literally
would emit `docs/plans/builtin-workflows/phased-plan.md`, which **already exists** and is the
parent index for phases 1-3 of the built-in workflows plan. Overwriting it would destroy the
index that schedules the work this unit descends from.

Recorded decision: this unit gets its own directory, `docs/plans/check-execution-runtime/`,
and names its source plan by path. `docs/plans/builtin-workflows/phase-2-check-node.md`
should gain a pointer to this directory in the phase that first touches it.

## Incorporated human decisions

Submitted by the operator on 2026-07-30, before decomposition:

1. **Personas never fix.** They return feedback to the bound session; the session fixes. This
   is already how the code behaves (`feedback.ts:17-18` renders a packet, the persona output
   is a verdict JSON and never a patch) and is now a recorded invariant no phase may weaken.
2. **The loop is automatic by default.** Feedback delivers live, the session fixes, and the
   work is resubmitted automatically so the graph re-runs from the top. "Resubmitted", not
   `git push` - confirmed with the operator before decomposition.
3. **Inspector findings keep `inspector_only`.** A Persona failure restarts the full graph. An
   Inspector finding parks at `waiting_for_new_head` and re-checks only Inspector on the new
   head. No built-in v7. Rationale accepted: an Inspector nit should not re-spend four model
   calls on code the Personas already passed.
4. **Consent stays required.** `liveEnabled` flips to `true` by default, but `repoAllowlist`
   stays empty and a repository must still be allowlisted before anything is typed into a
   pane or executed on disk. The "allowlist everything" option was offered and declined.
5. **One completion detector.** The automatic trigger reuses Foreman rather than growing a
   second idle detector in the daemon. Foreman's `enabled` default flips to `true` and the
   `prompted` trigger ships, so item-less sessions also re-arm.
6. **Option A for isolation.** Checks run in a pooled treehouse worktree pinned to the
   captured commit. The cheaper throwaway-`git worktree` variant was offered and declined.

## Investigated findings (what the repository actually does)

Verified against `HEAD` at `b44f7232`, then re-verified in full against `6453445a` after a
rebase. PR #323 (Foreman-completion binding) and #322 (check-repository combobox) landed in
the middle of this decomposition; the two substantive consequences are recorded in Phase 1's
findings and Phase 4's presentation non-goal.

**Read every `file.ts:NNN` below as a snapshot, not an address.** This repository moves fast
enough that #323 shifted `manager.ts` by +61 lines between this plan being written and being
opened as a pull request. The **symbol names and the claims about them** are the durable part;
if a line does not hold, grep the named symbol rather than assuming the claim is stale. A
phase whose finding turns out to be wrong in substance should say so in its cross-phase audit
record and adjust, not quietly work around it.

### The check seam is built and the production executor is null

`CheckExecutor` (`src/server/workflows/checks.ts:80`) and `CheckRunDeps.execute`
(`checks.ts:94-114`) exist and are tested. `WorkflowEngine` defaults `checkDeps` to `{}`
(`engine.ts:193`), `WorkflowManagerOptions` has **no `checkDeps` passthrough at all** (only
`checkScheduler`, `manager.ts:197`, forwarded at `:338`), and `src/server/index.ts:102-109`
constructs the manager with no `engine` option. So `execute` is null in production, `runCheck`
returns `unavailable` (`checks.ts:275`), and `checkOutcomePasses` is `status !== "failed"`
(`src/shared/workflow.ts:831`).

**A configured, authorised check currently passes without running.** That is the defect this
unit closes, and it is why Phase 4 owns the passthrough rather than treating it as plumbing.

### `treehouse return` has no holder argument, and that is the hard problem

Verified against the installed binary. `treehouse return [path] [--force]` - no `--holder`, no
dry-run, no JSON. `treehouse status` has no flags and no `--json`. `pool.ts:31-33` already
states the consequence: *"`return` takes a path and no holder, and `--lease-holder` is a label
treehouse records and never checks."*

So the source plan's "holder-verified idempotent return" (`phase-2-check-node.md:291-301`) is
**not achievable by asking treehouse**. Its own escape clause applies:

> The implementation must supply holder-aware return semantics or exclusive coordination
> across comparison and return. If it cannot close that race, pooled check execution cannot
> ship.

Phase 2 supplies exclusive coordination in three layers, and the plan is explicit that layer 3
is a residual, not a closure. See "Cross-phase contract: lease safety" below.

### The pool reaper will destroy a check lease unless something stops it

`PoolPins` has exactly two fields today (`pool.ts:175-178`): `sessionCwds`, `taskWorktrees`.
A check-leased tree is neither. Walk `cheapVerdict` (`pool.ts:479-512`) for an idle
check lease held as `mission-control`: state `leased` ✓, holder in `LEASE_HOLDERS` ✓, not busy
✓ (the command has not spawned yet, or is between pin and spawn), not a task worktree ✓, not a
session cwd ✓, path exists ✓ - **verdict null, so it is reaped**, via
`treehouse return --force`, which terminates processes and hard-resets the tree.

This is a currently-reachable defect the moment leases exist. It is why Phase 2 cannot be
split into "table now, pins later".

### Acquire and return are private to the dispatcher

`leaseFromPool` (`dispatcher.ts:821-834`) and `returnLease` (`dispatcher.ts:794-796`) are
module-private and **not exported**. Note they already disagree: the dispatcher returns with
`["return", path]`, the reaper with `["return", "--force", path]` (`pool.ts:107-108`). The
source plan's instruction - *"The lease and return commands have one shared adapter used by
Dispatcher and checks; do not copy their argv into `checks.ts`"* - therefore requires an
extraction, and the extraction has to decide which of the two spellings is correct for which
caller rather than silently unifying them.

### There is no streaming spawn helper, and the two detached-child precedents are not models

`src/server/util/exec.ts` exports `onPath`, `RunResult`, `stubRun`, `run`. `run()` is
`execFile`-based and buffered; it cannot preserve a tail or report an exact omitted-byte count
(`phase-2-check-node.md:72-76` already found this). The only `detached: true` +
process-group-kill precedents are `claude-cli.ts:288-294` and `llm/codex.ts:18-25`, and both
send **`SIGKILL` immediately with no grace period and no pid+start-time identity check**.
Neither satisfies the "confirmed group emptiness" contract, so Phase 3 writes a new one rather
than generalising either.

### `WorkflowEngine.stop()` cancels nothing

`engine.ts:204-209` sets `stopped`, clears the wake timer, and awaits `inFlight`. A live check
child would hold daemon shutdown for its full timeout. `phase-2-check-node.md:320-321` requires
`stop()` to cancel live check groups first; Phase 4 owns that because it is the first phase in
which a live check group can exist.

### The automatic loop mostly exists already - four dead ends are what break it

This was the biggest surprise of the investigation and it substantially shrank Phase 1.

Built-in v6 already ships `triggerMode: "foreman_complete"` + `deliveryMode: "live"`
(`builtin-workflows.ts:441`, via `NO_MISTAKES_REVIEW_LIVE_DEFAULTS` at `:361-364`). And
`confirmDeliverySend` **already re-arms Foreman's drain guard in the same transaction**
(`store.ts:3171-3178` calling `rearmDrainCompletionForDelivery` at `store.ts:4215-4228`), with
`manager.ts:2976` refreshing the queue. The full cycle - persona fail → `waiting_for_session`
→ live delivery → drain re-arm → session fixes → Foreman reclaims → round N+1 → graph re-runs
from the top - is implemented.

Confirmed that "start over" is literal: attempts and edge receipts are keyed by
`submissionId` (`shared/workflow.ts:1098`, `:1122`), so a new submission means an empty
attempt table and `advanceStructure` re-emits from the Session node (`engine.ts:252-271`).

What stops it running by default:

1. `DEFAULT_WORKFLOW_CONFIG.liveEnabled` is `false` (`shared/workflow.ts:618`), so
   `deliveryBlock` clause 10 (`manager.ts:2816`) returns `live_not_authorized` and nothing is
   ever delivered.
2. `ForemanConfigSchema.enabled` defaults `false` (`protocol.ts:856`), so `bindingModeBlock`
   (`manager.ts:2646-2655`) refuses `foreman_complete` at bind time.
3. **`unchanged_evidence` permanently kills the loop.** `claimForemanCompletion` retires the
   guard inside its transaction - at one of two sites since PR #323, `store.ts:2260-2272` on the
   fallback path or `store.ts:2360-2366` otherwise - *before*
   `captureAndActivate` runs. If capture then refuses for unchanged evidence
   (`manager.ts:3171-3186`), the guard is spent, the run parks, and no further claim will ever
   arrive. `test/workflow-completion-http.test.ts:592-594` has to clear `wrapup_asked_at` with
   raw SQL to continue - the test documents the gap.
4. **Item-less sessions never re-arm.** `rearmDrainCompletionForDelivery` requires
   `EXISTS (SELECT 1 FROM foreman_queue_items …)` (`store.ts:4147-4149`). There is **no
   `rearmPromptedCompletionForDelivery` anywhere**; the prompted path's re-arm depends entirely
   on the goal text happening to change. `wrapupTriggers` also defaults to `["drain"]` only
   (`protocol.ts:930`).

And: **no test asserts the cycle end-to-end.** `workflow-delivery.test.ts` asserts
`rearmedDrain === false` at `:111` and `:142`; the completion test fakes the re-arm with SQL.
Phase 1 owns that test.

### Decisions the source plan left open that are already resolved

- **The `check` evidence kind shipped.** `phase-2-check-node.md:351-357` asked the
  implementation to decide between adding a `check` `EvidenceRef` kind or relaxing the
  citation rule. It was decided: `EVIDENCE_REF_KINDS` includes `"check"`
  (`shared/workflow.ts:1264-1272`) with a docstring defending it as a real kind. No phase
  re-opens this.
- **`workflow_node_attempts` needs no widening.** Confirmed (`db.ts:461-478`,
  `store.ts:2443`). Only the durable lease table is new.

## Phases

| # | Phase | Depends on | Concurrency group | Size |
|---|---|---|---|---|
| 1 | [Automatic repair loop](phase-1-automatic-repair-loop.md) | planning PR | A | M |
| 2 | [Lease foundation](phase-2-lease-foundation.md) | planning PR | A | L |
| 3 | [Streaming process supervisor](phase-3-process-supervisor.md) | 2 | B | L |
| 4 | [Check executor wiring](phase-4-executor-wiring.md) | 2, 3 | C | M |

### Dependency graph

```
planning PR
   |
   +-- Phase 1  Automatic repair loop ......... independent, merge first when ready
   |
   +-- Phase 2  Lease foundation
            |
            +-- Phase 3  Streaming process supervisor
                     |
                     +-- Phase 4  Check executor wiring  (also depends on 2)
```

### Concurrency

- **Phases 1 and 2 may run and merge concurrently, in either order.** They share no file.
  Phase 1 touches `shared/workflow.ts` (one default), `shared/protocol.ts` (Foreman
  defaults), `workflows/store.ts`, `workflows/manager.ts`. Phase 2 touches `server/pool.ts`,
  `server/dispatcher.ts`, `server/db.ts`, `server/index.ts`, and new modules.
- **Phase 3 depends only on Phase 2**, for the `CheckProcessRegistry` interface and the lease
  table that backs it.
- **Phase 4 depends on both 2 and 3.** It is the only consumer of Phase 3's supervisor.
- **Merge-order preference, not a prerequisite:** land Phase 1 before Phase 4. Phase 4 makes
  checks able to fail for real, which exercises the repair loop hard; landing it into a loop
  with the four known dead ends would produce stalled runs that look like check bugs. This is
  a recommendation the phase files restate, not an edge in the graph - Phase 4 does not
  consume anything Phase 1 produces, and the two can merge in either order without breaking.

### Shared-file notice

Phase 1 and Phase 4 both edit `src/server/workflows/manager.ts`, in disjoint regions:

- Phase 1 owns the `unchanged_evidence` handling around `manager.ts:3171-3186` and
  `claimCompletion` at `:1632-1737` (widened by #323, still clear of Phase 4's region).
- Phase 4 owns `WorkflowManagerOptions` (`:178-220`) and its forwarding to the engine
  (`:330-346`).

A textual conflict is possible if they land close together; a semantic one is not. Whichever
lands second rebases and keeps both.

## Cross-phase contracts

These are the contracts a later phase may rely on and must not change. Each is owned by
exactly one phase.

### Contract L: lease safety (owned by Phase 2)

Three layers, and the plan is explicit that the third is a residual rather than a closure:

1. **Distinct holder token.** A check lease is taken as
   `mission-control-check-<attemptId>`, never the bare `LEASE_HOLDER`. Because
   `cheapVerdict` gates on `LEASE_HOLDERS.includes(tree.holder ?? "")`
   (`pool.ts:501`), the shared pool reaper **structurally cannot** return a check lease -
   it refuses with *"it is leased to X; we only return our own leases"*. This is the
   primary protection and it needs no new code in the reaper.
2. **`PoolPins.checkLeasePaths`.** Defence in depth for the case where a token scheme
   changes, a legacy row reads as `mission-control`, or a future caller widens
   `LEASE_HOLDERS`. Populated from `workflow_check_leases` **union** the lease manager's
   just-acquired in-memory set, added synchronously on acquisition before yielding for
   persistence, removed only after confirmed return.
3. **A daemon-wide pool mutex** serialising every `treehouse get` / `status` / `return`
   issued by this process, so the dispatcher, the reaper, and the check lease manager
   cannot interleave a status read with someone else's return.

**Stated residual, which Phase 2 must document in code and README rather than paper over:**
layer 3 binds only this process. A `make session` or a hand-run `treehouse get` in another
terminal is outside the mutex, so a status-read-then-return remains non-atomic against it.
Layer 1 is what makes that survivable: an out-of-process actor re-leasing the same path gets
the bare `mission-control` holder or its own, never `mission-control-check-<attemptId>`, so
the identity comparison fails and the return is refused. **A refused return is terminal, not
a hold**: the row survives as `lost` for audit and the pin is dropped, because the pin protects
our lease and a mismatch proves the tree is no longer ours. Holding it would outlive the
external holder and bar the ordinary reaper from that path for the life of the daemon. `pool.ts:603-628` already lives with
the analogous residual and names it: *"The uncovered sliver is a re-lease whose agent has yet
to start a process."*

Because the shared reaper cannot see check leases, **a leaked check lease is never collected
by it.** Phase 2 therefore owns its own reclamation from the durable table, at startup and on
a bounded retry, and that is a requirement rather than a nicety.

### Contract P: process identity (owned by Phase 2, consumed by Phase 3)

```ts
export interface CheckProcessRegistry {
  /** Persist supervisor identity BEFORE branch code is allowed to run. */
  record(attemptId: string, pid: number, startTimeTicks: string): void;
  /** Clear after confirmed group emptiness, never merely leader exit. */
  clear(attemptId: string): void;
}
```

**This interface is closed.** Phase 3 consumes it exactly as published and adds nothing to it.
Recovery needs to READ back an identity, which Contract P does not offer, and Phase 3 therefore
declares that need as its own narrow seam - `CheckSupervisorLookup` in `check-supervisor.ts` -
for Phase 4 to supply from an accessor it already holds. Recorded in Phase 3's audit, after a
first implementation added a `read` here and was corrected: widening an earlier phase's
published contract to serve a later phase's consumer turns a consumer's need into an owner's
obligation, and it is the wrong direction even when the addition is purely additive.

Phase 2 defines this interface and implements it against `workflow_check_leases`. Phase 3
consumes it and must not reach the table directly.

There is a **second, opposite-direction seam** between the same two phases, added in round 5:
`CheckGroupRecovery(attemptId) => "empty" | "not-empty" | "unknown"`. Phase 2's startup
reconciliation can prove a leased tree is *ours* but not that its process group is *empty*, and
only emptiness may authorise a return. Phase 2 declares the seam with a refusing default, Phase
3 implements it, Phase 4 injects it. So Phase 2 hands Phase 3 durability and Phase 3 hands Phase
2 proof-of-death; neither can answer the other's question alone. The ordering invariant - persist, then
release the gate - belongs to Phase 3's supervisor; the durability belongs to Phase 2.

`startTimeTicks` is **opaque to Phase 2** and, since round 3, a **composite**: a start-time
field plus the supervisor's command line, which carries the attempt id. Neither platform
exposes a start-time with enough resolution to stand alone - `ps -o lstart=` is whole-second -
so uniqueness comes from the attempt id in the argv rather than from precision. Phase 2 stores
and compares the string and never parses it, which is what lets Phase 3 change its composition
without touching the table.

### Contract R: the retry gate (owned by Phase 2, consumed by Phase 4)

`unresolvedLeaseForNode(submissionId, nodeId)` answers whether a check node still owns a lease
in `held` or `returning`. Phase 4 consults it **before** `handleInfrastructureFailure` creates
a fresh attempt, and blocks the run instead of retrying when the answer is yes.

The reason it has to exist: a retry is a **new attempt id**, so it carries a new holder token
and will happily lease a *different* pool tree while the original group may still be writing
into the first. There is no natural collision to rely on. `workflow_check_leases` therefore
carries `submission_id` and `node_id` as columns rather than joining through
`workflow_node_attempts`, so retention deleting the attempt cannot make the answer wrong -
the same argument that keeps the table free of a foreign key.

### Contract E: the executor signature (owned by the shipped code, changed by nobody)

`CheckExecutor`, `CheckExecutionRequest`, `CheckExecutionResult` (`checks.ts:48-80`) are
already published and tested. Phase 4 implements the type; no phase edits it. In particular
`workingSubpath` stays **relative**, to be joined onto the leased tree, and `command` stays an
argv spawned with `shell: false`.

### Contract F: the repair loop (owned by Phase 1)

After Phase 1, these hold and no later phase may weaken them:

- A Persona or Check `fail` returns a rendered packet to the session and never a patch.
- A confirmed live delivery re-arms exactly one Foreman completion episode, drain **or**
  prompted, so a later completion signal exists without a second detector.
- A completion claim that cannot produce a new round returns the guard rather than spending
  it, so the loop is never permanently dead from one refusal.
- `maxRepairRounds` still bounds the loop, and reaching it is a visible `blocked` state a
  human resolves - the bound is the safety property, not a bug to route around.

## Verification strategy for the completed set

1. `npm run typecheck`, `npm test`, `npm run build`, bundle smoke - the CI matrix, Node 24
   and 26.
2. The end-to-end repair cycle test Phase 1 adds must still pass after Phase 4, with a real
   failing check as the trigger instead of a persona verdict. Phase 4 extends it rather than
   forking it.
3. Manual, on a real repository, after Phase 4: configure a `typecheck` command that fails,
   allowlist the repo, dispatch a task, and confirm the check fails the submission, the packet
   reaches the session, the session fixes, and round 2 runs the check again and passes.
4. Kill the daemon mid-check and confirm on restart that the lease row survives, the process
   group is reconciled by identity, the tree is returned only once emptiness is confirmed, and
   the pool reaper never touched it.
5. Confirm `npm test` leaves no `~/.treehouse` lease behind - the lease-leak assertion belongs
   in Phase 2's tests and is the cheapest guard against the worst failure mode.

## Cross-phase audit record

- **2026-07-30, after all four phase files:** verified that every requirement of the source
  plan's runtime unit (`phase-2-check-node.md:254-330`, plus the six-item checklist at
  `:415-427`) is owned by exactly one phase. Mapping: lease/pin/table/return → Phase 2;
  supervisor/env-scrub/group-teardown → Phase 3; executor composition, `stop()` cancellation,
  run-detail rendering, README → Phase 4. Checklist items 1, 4, 5 → Phase 2 (reaper reclaim,
  return-failure erasing state, non-idempotent return). Items 2, 3, 6 → Phase 3 (crash between
  spawn and durable identity, PID recycling, leader exit with live descendants).
- The six operator decisions map: 1 and 2 → Phase 1 (Contract F); 3 → recorded as a non-goal
  in Phase 1, no code; 4 → Phase 1 (`liveEnabled`) and Phase 4 (`checksEnabled` stays false,
  allowlist still asked); 5 → Phase 1; 6 → Phase 2.
- Confirmed no phase re-opens the `check` evidence kind or widens
  `workflow_node_attempts`, both settled in the shipped unit.
- **2026-07-30, Inspector round 2 (PR #326):** two failure paths contradicted the guarantees
  above and both were corrected. A holder mismatch used to retain the pin, permanently
  consuming a pool slot - Contract L now names `lost` as a terminal that drops the pin. And an
  `unknown` group-emptiness used to return a plain `infrastructure`, which retries onto a
  second tree rather than blocking - Contract R is the new gate, with its enabling columns
  placed in Phase 2 rather than looked up from Phase 4. Both phases' audit records carry the
  detail. No operator decision, phase boundary or dependency edge changed.
- **2026-07-30, Inspector round 3 (PR #326):** three findings, all accepted, none changing a
  phase boundary or an operator decision. One is worth recording at index level because it was
  a contradiction *between* rounds rather than a defect in one phase: round 2 made a
  holder-mismatch row drop its pin, but Phase 2's pin query still read the whole lease table,
  so the retained audit row would have been re-pinned on the next sweep and the fix would have
  silently lost. The state filter (`held` / `returning` only) is now the seam that makes
  "retain the row" and "drop the pin" compatible. The other two: the unchanged-evidence bound
  is stated as a comparison rather than an ordinal, and process identity became a composite
  because no shell-reachable start-time field has the resolution to stand alone. Contract P's
  wording above was widened to say `startTimeTicks` is opaque and composite.
- **2026-07-30, PR #327 landed on `main` mid-review** (`feat(workflows): resume a parked repair
  round automatically`). It implements automatic resumption through a daemon-side observer over
  parked runs plus an immutable per-version `resumptionPolicy`, and ships built-in v7 carrying
  `auto`. That is a different mechanism from the one Phase 1 plans, and its commit message
  argues the Foreman route could never have covered resumption at all - which contradicts
  **operator decision 5**. Phase 1 now carries a "superseded in part" banner naming exactly what
  #327 took over and what still holds, and it must not be implemented until the operator
  re-decides its scope. Phases 2, 3 and 4 are untouched: #327 changes nothing in the lease,
  supervisor or executor surfaces, and no cross-phase contract moved.
- **2026-07-31, Phase 1 re-scoped and implemented.** The operator kept the original scope and
  operator decision 5 stands. The collision proved to be smaller than it read: the two
  mechanisms cannot both open a round (the run-status transition is the lock, and the observer
  re-reads after its `await`), and #327's observer serves only versions pinned to
  `resumptionPolicy: "auto"` - built-in v7 alone - so every binding on v1-v6 still reaches round
  N+1 through the Foreman claim Phase 1 repairs. Both mechanisms additionally need Live
  delivery, so Phase 1's `liveEnabled` flip is what switches #327 on as well. Phase 1's own
  audit record carries two corrections found while implementing, one of which contradicts a
  finding in its "Data, API and compatibility" section: the nudge counter does NOT fit in the
  run's gate state, because every path that opens a round nulls `gate_state_json`. It is derived
  from the event log instead, which keeps the no-schema-change constraint intact. No phase
  boundary, dependency edge or cross-phase contract moved.
- **2026-07-31, Phase 4 implemented; the unit is complete and the headline defect is closed.**
  A configured, authorised check now leases a pooled worktree pinned to the captured commit,
  runs the operator's argv in it, and **fails the submission on a non-zero exit** - verified end
  to end on a real repository with a real pool and a real session, not by inspection. Phase 4's
  own audit record carries the detail; two items belong at index level because they are about
  the plan rather than about one phase.

  **One finding contradicts nothing in this plan but was invisible to all of it.** Evidence
  capture records an ABBREVIATED head sha (`diff.ts`), and a pin requires a full 40-hex id. Every
  phase's contracts were honoured and the two halves still did not fit, because each was tested
  against the shape the other was assumed to produce - and every automated test passed, because
  every one of them supplied a full sha. The first real submission failed three times as
  infrastructure and blocked, with the gate still never running. Fixed in Phase 4 by resolving
  the abbreviation through `git rev-parse --verify` before the lease, never by relaxing the pin.
  This is the concrete vindication of the instruction that a phase may not be reported done on
  the strength of its diff.

  **Contract E survived, but not in the shape Phase 4 described.** `CheckExecutionRequest`
  describes a command and carries no attempt identity, while the runtime's resources are keyed
  by attempt id and Contract R needs the submission and node ids. Phase 4's literal instruction -
  a plain `checkDeps?: CheckRunDeps` - is therefore unimplementable. Resolved by BINDING the
  identity (`checkDeps` is now `(attempt) => CheckRunDeps`) rather than by widening the published
  request, so all three of Contract E's types are byte-identical and no existing caller of
  `runCheck` changed. Contracts L, P and R were consumed exactly as published; two small additive
  members were added to Phases 2 and 3's modules, each one already promised by that module's own
  comments (`handOffForReclaim`, `terminateLiveCheckGroups`).

- **2026-07-30, Inspector rounds 5 and 6 (PR #326):** two majors, both accepted, both about the
  same seam between ownership and liveness. Round 5: Phase 2's startup reconciliation would have
  returned a lease on ownership alone, hard-resetting a tree a live check was still writing into
  - fixed with the `CheckGroupRecovery` seam described under Contract P, spanning all three of
  Phases 2, 3 and 4. Round 6: round 3's composite identity included the shim's command line while
  step 4 still had the shim `exec` the configured argv, which replaces that command line - so
  every later identity read would have mismatched on a live group and stranded its lease. The
  shim now forks and waits instead of `exec`ing, which also restores the group-leader property
  step 5 already required. Both were contradictions this plan introduced, not gaps in the source
  plan; no phase boundary, dependency edge or operator decision moved.
