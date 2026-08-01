# Phase 2: The check node

Source plan: `docs/plans/builtin-workflows/plan.md`
Index: `docs/plans/builtin-workflows/phased-plan.md`

## Outcome and value

Phase 2 defines a workflow gate on a deterministic command. Its first implementation unit
adds the Check graph and configuration contract; the dependency-linked execution-runtime unit
makes that gate operational against a captured submission. An operator configures what `test`
or `lint` runs for a repository, and the completed pair can fail a submission on an exit code
instead of spending four model calls to reach the same conclusion.

This is the primitive the earlier mapping plan decided against and this plan's decision 4
reverses. Every other no-mistakes gate already has a home; this is the last one.

## Entry criteria and dependencies

- Direct prerequisite: the planning session's PR merges.
- **No dependency on Phase 1.** This phase adds no built-in and does not touch the built-in
  catalog. The two may run concurrently.

## Scope

In scope:

- `check` node kind in the draft and published graph types, and their zod schemas.
- `WORKFLOW_CHECK_SLOTS`, append-only.
- Slot-to-command configuration in `WorkflowConfig`, edited in Settings, plus a consent switch.
- Execution: bounded, timed, in a pooled worktree leased and pinned to the captured commit,
  on its own concurrency limit. This is a substantial runtime unit with a durable lease
  registry, pool-reaper pins, a gated process supervisor, process-group teardown,
  holder-verified idempotent return, and crash recovery.
- A scrubbed child environment, repository allowlisting, and consent copy that names the
  filesystem authority granted to branch-authored code.
- Validation, Graph-view rendering, run-detail presentation, README, tests.

Phase 2 is no longer a small node-kind addition. It contains two implementation units: the
graph, configuration, and presentation slice, plus a crash-safe check execution runtime. The
runtime must be designed and estimated explicitly during implementation. If it is materially
larger than the rest of Phase 2, split it into its own dependency-linked implementation unit
before coding rather than hiding that scope inside this phase.

**Split recorded:** that escape hatch was taken. The first implementation unit landed the
graph, configuration, validation, presentation, scheduler boundary, and a tested execution
seam, with its production executor deliberately `null` - no command was spawned, and a
configured, authorized Check recorded `unavailable` and passed with a sentence. The pooled
lease, process supervisor, durable lease table, pool pins, environment scrubbing, and startup
recovery specified below were the dependency-linked execution-runtime unit, and the
runtime-specific tests, manual checks, and exit criteria below applied to that follow-up rather
than to the first unit.

**That follow-up has now shipped**, decomposed and implemented in
`docs/plans/check-execution-runtime/` (`phased-plan.md`, with a rendered page beside it) as four
merge-aware phases: the lease foundation, the streaming process supervisor, the check executor
that composes them, and the automatic repair loop the operator asked for in the same breath.
**The "deliberately null" executor is gone as of that unit's Phase 4** - a configured,
authorized check now leases a pooled worktree pinned to the captured commit, runs its argv, and
fails the submission on a non-zero exit. Read that directory rather than this document for how
the runtime actually behaves; what remains below is the specification it was built against.

That decomposition also recorded two findings this document could not have known. `treehouse
return` accepts no holder argument, so the "holder-verified idempotent return" specified at
lines 291-301 is reached by exclusive coordination plus a distinct holder token rather than by
asking the CLI. And a distinct holder token makes the shared pool reaper refuse a check lease
outright, which is a stronger protection than the `PoolPins` entry specified at lines 281-289 -
both ship, and the consequence, that leaked check leases need their own collector, is new work
that directory owns.

Explicit non-goals:

- **No Pipeline editor support.** `stageExpressible` returns false for a graph containing a
  check, which routes it to the existing Graph view. Phase 3 owns making that a true.
- **No built-in workflow uses a check yet.** Phase 3 ships version 2.
- **No repository-file command source.** Settings only, per decision 5. The default-branch
  file is a named follow-up, not this phase.
- **No shell.** The streaming check runner spawns an argv directly with `shell: false`.
- **No existing-table migration.** The existing attempt row accommodates the check outcome,
  but a new `workflow_check_leases` table owns crash-safe lease and process cleanup.
- **No auto-fix.** A failing check returns findings to the Session through the same repair
  packet a Persona fail produces.
- **No full execution sandbox.** Environment scrubbing reduces credential exposure, but the
  command still has the daemon's filesystem authority. A full sandbox is a named follow-up.
- **No plain-worktree fallback.** A configured check requires a pooled worktree because the
  pool carries ignored warm dependencies. Lease or pin failure is infrastructure, not a
  verdict against the submission.

## Repository findings this phase depends on

- **`run()` (`src/server/util/exec.ts:68`) is not the check-command seam.** It uses
  `execFile`, buffers from the start, and kills the child when `maxBuffer` is exceeded. It
  cannot preserve the useful tail or report an exact omitted-byte count. Checks need a
  streaming `spawn` adapter with a bounded byte ring; `run()` remains suitable for the
  bounded pool lease, pin-support, and return commands.
- **The streaming adapter uses `spawn` with `shell: false`.** A command is an argv, not a
  string. This removes shell injection as a category rather than mitigating it.
- **`onPath(bin)` (`exec.ts:17`) is not safe for check commands.** For a name containing
  `/`, it calls `existsSync` relative to the daemon cwd, not the leased checkout.
  `./scripts/check` and `node_modules/.bin/tsc` can therefore exist and still be reported
  unavailable. The streaming spawn is the single authority: its `ENOENT` result means the
  configured executable is unavailable.
- **Pinned pooled worktrees already have one owner.** `pinLeasedWorktree`
  (`dispatcher.ts:706`) proves the lease belongs to the requested repository and delegates
  to `resetWorktreeToCommit` (`git/ensemble-snapshot.ts:346`). That reset hard-resets and
  runs `git clean -fd`, never `-fdx`, specifically so ignored `node_modules`, virtual
  environments, and warm caches survive. Checks reuse this mechanism rather than creating a
  second pinning path.
- **The existing pinned-dispatch path unwinds a live lease before throwing.**
  `provisionWorktree` returns the pool lease when pinning or verification fails
  (`dispatcher.ts:788-802`), and `teardownWorktree` uses the same return path for ordinary
  completion. Check setup and recovery inherit that ownership rule.
- **The pool reaper does not know about check leases.** `PoolPins` (`pool.ts:175`) contains
  only `sessionCwds` and `taskWorktrees`, populated from live sessions and Task rows. An
  active check lease is neither, so Phase 2 adds `checkLeasePaths` as a third source. It is
  populated from the durable check-lease registry plus acquisitions not yet committed, and
  is active from acquisition through confirmed return.
- **Detached children need group teardown.** The headless LLM runners already spawn with
  `detached: true` and signal the negative child pid on POSIX so descendants do not outlive
  the owner. A check command needs the same process-group boundary plus cancellation owned
  by `WorkflowEngine.stop()`.
- **`workflow_node_attempts` needs no widening for outcomes.** `persona_snapshot_json`, `runner_id`,
  `model_id` and `verdict_json` are all nullable (`db.ts:461-478`), and `insertAttempt`
  already writes `input.persona === null ? null : ...` (`store.ts:2443`). The final
  `CheckOutcome` fits `output_json`, but cleanup state cannot: `handleInfrastructureFailure`
  finishes the old attempt without output and creates a fresh retry. A dedicated durable
  lease table must outlive both attempt rows.
- **`ReviewScheduler` is explicitly a ceiling on tool-less MODEL calls**
  (`llm/review-scheduler.ts`), and its comment defines membership that way. Today
  `WorkflowEngine.pump()` wraps every runnable attempt in that scheduler before
  `runAttempt`, so adding an inner limiter would still make checks occupy review slots.
  Scheduling must resolve the node kind and choose exactly one limiter before acquiring
  either.
- **The validator branches on node kind in five places**: the `sourcePorts` / `targetPorts`
  tables (`workflow-graph.ts:20-32`), the pass/fail route requirement (180), the label ternary
  (183, 186), and the Join predecessor kind check (198).
- **The engine branches in four**: `engine.ts:150`, 213 (persona attempt insertion), 230, 256,
  319. A check needs an arm beside 213 and its own runner beside `runAttempt`.
- **`handleInfrastructureFailure`** already implements "an infrastructure problem is never a
  fail verdict", with `MAX_INFRA_ATTEMPTS = 3` and exponential backoff. It finishes the old
  attempt without output and creates a fresh retry, so it is used only after check resources
  are clean. Lease-return failure stays in a separate cleanup retry and cannot make another
  attempt runnable.
- **`WorkflowConfig`** is `{ liveEnabled, repoAllowlist, retention }` (`workflow.ts:486-509`),
  an `app_config` blob edited by `WorkflowSettingsPanel.tsx`.
  `WorkflowConfigSchema` uses `.default()`, not `.catch()`, so malformed persisted values
  still throw. Phase 2 must add recovery for the complete stored config, not only its new
  fields. This slightly widens the phase.
- **`repoAllowlisted` (`@shared/allowlist.ts`)** is the shared consent predicate. Per
  `AGENTS.md`, "any additional consent gate extends `allowlist.ts`; it does not start a
  matcher."

## Implementation steps, in execution order

### 1. Shared model (`src/shared/workflow.ts`)

```ts
/** APPEND-ONLY: a slot id reaches durable published graphs. */
export const WORKFLOW_CHECK_SLOTS = ["test", "lint", "typecheck", "build"] as const;
export type WorkflowCheckSlot = (typeof WORKFLOW_CHECK_SLOTS)[number];
```

Add to both unions:

```ts
| { id: string; kind: "check"; slot: WorkflowCheckSlot; position: Point }
```

A check node is identical in draft and published form. Unlike a Persona it snapshots nothing,
because the command is deliberately not part of the version: a version pinning a command would
be the executable-content problem the slot indirection exists to avoid.

Extend `WorkflowConfig`:

```ts
export interface WorkflowCheckCommand {
  repoRoot: string;
  slot: WorkflowCheckSlot;
  /** argv, not a shell string. The check runner spawns it with shell: false. */
  command: string[];
}

// on WorkflowConfig:
checksEnabled: boolean;
checkCommands: WorkflowCheckCommand[];
```

`DEFAULT_WORKFLOW_CONFIG` gets `checksEnabled: false` and `checkCommands: []`. Off by default,
matching `liveEnabled`.

Add `checkCommandFor(config, repoRoot, slot): string[] | null` as a shared pure helper so the
daemon and the settings panel agree on resolution, and `checkBlockedReason(config, repoRoot):
string | null` beside `workQueueBlockedReason`, returning a **sentence** and never a boolean.

### 2. Zod (`src/shared/protocol.ts`)

Add the `check` member to `WorkflowDraftNodeSchema` (2127) and `PublishedWorkflowNodeSchema`
(2144), with `slot: z.enum(WORKFLOW_CHECK_SLOTS)`. Extend the workflow config schema with
`checksEnabled` and `checkCommands`, then make malformed persisted values recover across the
complete `WorkflowConfig`, including `liveEnabled`, `repoAllowlist`, `retention`, and the two
new fields. Missing fields still use `.default()` for upgrades; an outer
`.catch(DEFAULT_WORKFLOW_CONFIG)` is the single no-throw boundary for unreadable stored
blobs.

Bound `command`: non-empty array, each element non-empty, a sane element count and total
length. An unbounded argv is a durable blob nobody bounded.

### 3. Validation (`src/shared/workflow-graph.ts`)

- `sourcePorts.check = ["pass", "fail"]`, `targetPorts.check = ["activate"]`.
- Line 180: include `check` in the pass/fail route requirement.
- Lines 183 and 186: the two-way label ternary becomes a lookup so a third kind reads
  correctly. `"Check"` is the label.
- Line 198: a Join predecessor may now be a Persona, a Join, **or a Check**.
- Nothing validates the slot beyond the enum. Whether a command is configured is a runtime
  fact about a repository, not a property of the graph, and a graph that fails validation on
  a machine that has not configured a command would be unpublishable for the wrong reason.

### 4. Stage projection (`src/shared/workflow-stages.ts`)

`stageExpressible` returns **false** for any graph containing a check node, so such graphs
render in Graph view. This is a deliberate, temporary narrowing that Phase 3 removes. Add a
`stageBlockers` sentence naming the reason, because that function exists to explain why Graph
view is showing.

Do not widen `StageMember` here. Phase 3 owns it, and a half-widened union in two phases is
the temporary second source of truth the phasing rules forbid.

### 5. Execution (`src/server/workflows/`)

New `src/server/workflows/checks.ts`:

```ts
export interface CheckRunDeps {
  spawn?: CheckSpawn;        // the PaneDeps.pane seam, so a test drives the real adapter
  leases?: CheckLeaseDeps;
}

export interface CheckOutcome {
  status: "passed" | "failed" | "skipped" | "unavailable";
  slot: WorkflowCheckSlot;
  command: string[] | null;
  exitCode: number | null;
  /** Bounded, tail-biased: a failure's last lines are the useful ones. */
  output: string;
  /** Exact number of streamed stdout and stderr bytes omitted from output. */
  truncatedBytes: number;
  note: string;
}
```

The adapter consumes stdout and stderr as streams, counts every byte, and keeps only the last
configured number of bytes in one bounded ring. `truncatedBytes` is the total streamed byte
count minus retained bytes, so it is exact rather than inferred from an `execFile` overflow.
If the implementation cannot preserve that invariant, replace the field with
`truncated: boolean`; never invent a byte count.

Rules, each of which has a stated failure it prevents:

- **No command configured for this repository and slot: `skipped`, which passes.** A shipped
  built-in must not fail on a repository nobody configured. Phase 3 depends on this.
- **Consent absent (`checksEnabled` false, or the repo root not allowlisted): `unavailable`,
  which passes with the sentence from `checkBlockedReason`.** A gate the operator never
  authorized must not block their work, and it must say why rather than silently passing.
- **Streaming spawn reports `ENOENT`: `unavailable`.** A missing bare binary or
  repository-relative executable is a configuration problem, not a defect in the change
  under review. There is no separate precheck that can disagree with the real cwd.
- **`outcomeUnknown` true (timeout, OOM, killed): infrastructure failure.** Return it to
  `handleInfrastructureFailure` for retry and eventual block. It is never a `fail` verdict,
  matching the rule the engine already enforces for Personas.
- **Exit 0: `passed`. Non-zero: `failed`**, with tail-biased bounded output.

Execution context: lease a pre-warmed tree from the repository's treehouse pool, resolve and
verify the captured head as the full 40-character `baseSha` the pinned-worktree contract
requires, and call `pinLeasedWorktree(repoRoot, leasePath, baseSha)`. Run the command with
`leasePath` as `cwd`. Never use `sessionRepoRoot` or `sessionCwd` as the execution directory.
The former identifies the shared main repository for a linked worktree, while the latter
remains mutable after evidence capture. Sessions normally run in pooled worktrees under
`~/.treehouse/`, so choosing `sessionRepoRoot` would execute against an unrelated checkout
in the common case.

The lease and return commands have one shared adapter used by Dispatcher and checks; do not
copy their argv into `checks.ts`. There is deliberately no fallback to `git worktree add`.
The pool is what preserves ignored dependencies while `pinLeasedWorktree` removes tracked
and nonignored residue and proves HEAD equals the captured commit. A missing pool, dry lease,
invalid commit, ownership refusal, or reset failure is infrastructure and reaches
`handleInfrastructureFailure` only after cleanup succeeds; none becomes a `failed` check
verdict.

Add `workflow_check_leases`, keyed by attempt id, with the repository root, unique lease
path, exact check-specific holder token, cleanup state, process pid, process start-time
identity, and timestamps. This table, not `workflow_node_attempts.output_json`, is the
durable owner of a live lease. `output_json` holds only the final `CheckOutcome`. A cleanup
worker retains the lease row until pool return is confirmed, retries teardown independently
with backoff, and only then lets `handleInfrastructureFailure` create or release a runnable
attempt. A failed return must not delete the row, release its reaper pin, or permit a second
lease. This invariant prevents attempt rollover from erasing the only record of a resource
that is still owned.

Extend `PoolPins` with `checkLeasePaths`. Its value is the union of paths in
`workflow_check_leases` and the lease manager's just-acquired in-memory set. The manager adds
a path synchronously when acquisition returns, before yielding for persistence, and removes
it only after confirmed pool return. Each lease uses a check-specific holder token tied to
the durable attempt id, so startup can reconcile an acquisition interrupted before the path
commit. On startup, restore durable rows and reconcile those holder tokens before starting
the pool reaper or `pump()`. This invariant pins a check lease from acquisition through
confirmed return, including setup, teardown, and daemon restart, and prevents the reaper
from returning or re-leasing an active tree.

Lease return is idempotent and holder-verified. Immediately before every return, read pool
status and compare both the canonical path and the exact holder token in
`workflow_check_leases`. A matching path and token permits return. An available slot or a
missing lease means the prior return already succeeded and completes cleanup without another
return call. A path held by any different token is refused and remains untouched. This
invariant prevents recovery after a crash between successful return and row deletion from
returning a tree that has already been leased to someone else and destroying their work.
Because the current `treehouse return` accepts no holder, a status read followed by return is
not atomic. The implementation must supply holder-aware return semantics or exclusive
coordination across comparison and return. If it cannot close that race, pooled check
execution cannot ship.

The streaming runner starts a trusted supervisor in its own process group with the branch
command stopped or held behind a gate. Read the supervisor's pid and operating-system process
start time, persist both in `workflow_check_leases`, and only then release the gate so branch
code can execute. Timeout, cancellation, and daemon shutdown verify the pid plus start-time
identity, signal the whole group, wait for descendant termination, and escalate to a hard
kill after a bounded grace period. Startup recovery performs the same identity check before
signalling. A mismatched identity is never signalled, because it may be a recycled pid, but
neither a missing nor mismatched leader proves the group is empty. The supervisor must remain
the identifiable group owner until every descendant is gone. Closing an unreleased gate must
terminate its supervisor without starting branch code. Persist-before-release prevents
branch code from running without a durable owner; identity verification prevents a recycled
pid from targeting an unrelated process group.

Confirmed process-group emptiness, not leader liveness, is the precondition for lease return.
If recovery lacks enough identity to prove emptiness, it keeps the durable row and reaper pin
and refuses return until the runtime's recovery protocol resolves that uncertainty. Returning
a reusable tree while a descendant can still write into it would corrupt the next lessee.
`WorkflowEngine.stop()` therefore cancels live check groups before awaiting its in-flight
attempts instead of merely waiting for their command timeout. The concurrency ceiling bounds
resource use to one pre-warmed pool slot per running check. It creates no extra checkout, but
repositories need enough configured pool capacity for the chosen check concurrency.

Build the child environment through one pure scrubber. It removes the daemon auth token and
the `MISSION_HOME` / `FLEET_HOME` / `HARNESS_HOME` aliases that locate it, plus variables
whose names are credential-shaped, including token, secret, password, key, and credential
suffixes. Preserve only ordinary process settings needed to locate and run tools. Checks
still execute branch-authored code with the daemon's filesystem authority, so repository
allowlisting remains mandatory. This is environment scrubbing, not a sandbox.

New limiter: `createLimiter(DEFAULT_CHECK_CONCURRENCY)` with a small value (1 or 2), created
in `src/server/index.ts` beside the review scheduler and injected. Do **not** reuse
`ReviewScheduler`; its comment defines its membership as tool-less model calls, and a long
test suite would starve Persona reviews.

### 6. Engine (`src/server/workflows/engine.ts`)

- Beside the persona arm at `:213`, insert a queued attempt for a `check` target with
  `persona: null`.
- In `pump()`, resolve each attempt's target node kind from its pinned graph before acquiring
  a limiter. Persona attempts go directly through the existing review scheduler; check
  attempts go directly through the check limiter. `runAttempt` dispatches to the appropriate
  runner after that choice and never acquires another limiter. A check waiting or running
  must not consume a model-review slot.
- On completion write a synthetic verdict so downstream code, the Join, and the repair packet
  are unchanged:
  - pass: `{ verdict: "pass", summary: <note>, approvalDetails: { reason, evidence: [] }, confidence: 1 }`
  - fail: `{ verdict: "fail", summary, requestedChanges: [{ title, rationale: <bounded output> }], confidence: 1 }`

  A fail verdict requires at least one `EvidenceRef` per requested change today
  (`verdict.ts`). A command's evidence is its own output, which is not one of the five
  `EvidenceRef` kinds (`diff | transcript | standard | goal | decision`). **Decide and record
  in the implementation**: either add a `check` evidence kind (append-only, reaches durable
  verdict JSON) or relax the requirement for check-authored changes. Prefer the new kind: the
  requirement exists so a human can trace a claim to its source, and a check's output is
  exactly that source.
- Put the raw `CheckOutcome` in `output_json` so run detail can render exit code and output
  without re-deriving them from prose.

### 7. Settings and web

- `WorkflowSettingsPanel.tsx`: a `checksEnabled` switch whose consent copy says it authorizes
  executing branch-authored code with the daemon's filesystem authority. It must not call
  this a sandbox. Add a command table (repository root, slot, argv). Rows carry
  `data-anchor="workflows/<slug>"` and get entries in `lib/settings-search.ts`, per the
  settings registry rules.
- The argv field accepts a typed string, splits it quote-aware, and **displays the parsed
  argv back**, so an operator sees what will actually run rather than trusting a split they
  cannot inspect.
- `WorkflowNode.tsx`: render the `check` kind with the slot as its label and the same
  `activate` / `pass` / `fail` handles a Persona has. `WORKFLOW_NODE_TYPES` already maps every
  kind to this one component.
- `WorkflowLibrary.tsx`: a Check entry in the node palette.
- `WorkflowRuns.tsx` / `run-model.ts`: a check attempt renders its slot, exit code, and
  bounded output. `run-model.ts` owns vocabulary, so the four `CheckOutcome` statuses each get
  a sentence in a `Record`, which is what makes a new status fail typecheck until someone
  says what it means.

### 8. README

Extend the node vocabulary in `#workflows-and-personas` with Check: what it gates on, that it
names a slot rather than a command and why, that an unconfigured slot passes with a note, and
that it needs consent. Document the pinned pooled lease, preserved warm dependencies,
process-group teardown, environment scrubbing, remaining filesystem authority, and deferred
full sandbox. Add the two Settings rows under Configuration.

## Data, API and compatibility

- **New durable lease table.** `workflow_node_attempts` needs no new columns for the final
  outcome, but `workflow_check_leases` owns leases across attempt retries and daemon
  restarts. It remains present until return is confirmed.
- **Pool reaper contract widens.** `PoolPins.checkLeasePaths` is a third pin source beside
  session CWDs and Task worktrees.
- **`WORKFLOW_CHECK_SLOTS` is append-only.** A slot id reaches published graphs; renaming one
  orphans every graph naming the old spelling.
- **A published version pins no command.** Two runs of the same version on different machines
  may run different commands, which is correct: the version describes the gate, the operator
  describes the machine.
- **Forward compatibility.** A build without this phase reading a graph containing a check
  node rejects it at the zod boundary. That is a downgrade, same as any node kind, and needs
  no special handling.

## Unresolved implementation questions

The leased-worktree execution model raises lease-lifetime, process-supervision, and
crash-recovery questions whose full protocol must be designed during implementation, not
declared complete by this plan. The invariants above are safety requirements. They do not
substitute for a concrete state machine, platform-specific process model, storage
transactions, and tests against the real pool adapter.

Each checklist item below is a **known failure mode with a named consequence**, not a
hypothetical or a suggestion:

- [ ] **Reaper reclaim of an in-flight lease:** the pool can re-lease a tree while a check
  still owns it, producing concurrent writers and corrupted work.
- [ ] **Crash between spawn and durable identity:** branch code can keep writing with no
  recoverable process owner.
- [ ] **PID recycling:** recovery can signal an unrelated process group.
- [ ] **Lease-return failure erasing durable state:** an attempt retry can acquire a second
  lease while the first remains held.
- [ ] **Non-idempotent return after a crash:** a replay can return a tree now held by a new
  lessee and destroy that lessee's work; the current CLI's separate status and return calls
  also leave a time-of-check-to-time-of-use race the design must close.
- [ ] **Leader exit with live descendants:** cleanup can return a reusable tree while workers
  still write through it.

The implementing change must answer every item with a real design and focused failure test.
If that design is materially larger than the graph, settings, and presentation work in this
phase, split the check execution runtime into its own dependency-linked implementation unit.

## Tests and verification

`test/workflow-check-node.test.ts`:

- The four `CheckOutcome` statuses from a stubbed streaming adapter: exit 0 passes, non-zero
  fails with bounded output, and a timeout or killed child is an infrastructure failure and
  never a fail verdict.
- The streaming runner retains the output tail under its byte cap and reports the exact
  omitted-byte count across stdout and stderr.
- No configured command produces `skipped` and a pass. **This is the contract Phase 3 depends
  on and is asserted explicitly.**
- Consent absent produces `unavailable` and a pass carrying the sentence.
- A bare or repository-relative executable that produces `ENOENT` from the real spawn is
  `unavailable`; no `onPath` precheck runs.
- The command is passed to the streaming adapter as argv with `cwd` set to a pooled lease
  pinned to the captured commit, never the binding's main repository or mutable session
  checkout.
- Pinning preserves an ignored warm dependency while removing a nonignored leftover and
  proving HEAD equals the full captured commit.
- Lease acquisition, pin, and other setup failures take the infrastructure retry path and
  never produce a fail verdict.
- The pool reaper runs while a check holds a lease during setup, execution, and teardown and
  leaves the tree alone until confirmed return.
- A return stub fails once: the durable lease row and reaper pin remain, no new attempt runs
  or acquires a second lease, the cleanup worker retries separately, and only successful
  return releases the pin and infrastructure retry.
- Simulate a crash after `treehouse return` succeeds but before the lease row is deleted.
  Recovery sees the path as available or missing, treats cleanup as already complete, and
  does not issue a second return. Re-lease the same path under a different holder token and
  prove recovery refuses to return it.
- The supervisor holds the branch command behind its gate until pid plus process start time
  are durable. Closing an unreleased gate terminates the supervisor without executing branch
  code. Startup recovery never signals a mismatched, simulated recycled pid.
- Recovery sees a missing supervisor leader with a live descendant and refuses lease return
  until group emptiness is positively established.
- The lease is returned after pass, fail, spawn refusal, timeout, and cancellation. Startup
  recovery restores lease pins, terminates a matching recorded process group, and returns
  the lease before the pool reaper or attempts resume.
- A test command spawns a descendant; timeout, explicit cancellation, and daemon shutdown
  each terminate the full process group before the lease-return stub is called.
- The scrubbed environment drops auth and credential-shaped variables while retaining the
  ordinary process settings the runner needs.

`test/workflow-graph.test.ts` additions: check ports accepted, a check missing a pass or fail
route diagnoses, a check as a Join predecessor is accepted, and the diagnostic message says
"Check" rather than "Persona".

`test/workflow-stages.test.ts`: a graph containing a check is not stage-expressible and
`stageBlockers` explains why.

`test/workflow-engine.test.ts`: a check node advances the graph, its verdict reaches the Join,
and a failing check returns a repair packet to the Session. Hold the review scheduler at
capacity and prove a check can still run; hold the check limiter and prove a Persona can
still run.

`test/workflow-settings-panel.test.ts` and `test/workflow-config.test.ts`: the switch and the
command table render, the consent copy names branch-authored code and filesystem authority,
anchors are unique and name a real category, and malformed values in every old and new
stored config field fall back rather than throwing.

Commands: `npm run typecheck`, `npm test`, `npm run build`.

Manual: configure a `test` command for this repository, build a graph with one check, submit,
and watch it pass. Then break the build and watch it fail with the compiler output in run
detail. Confirm on your own Vite port.

## Merge and exit criteria

- CI green on Node 24 and Node 26.
- A check node runs, gates, and reports on a real repository.
- An unconfigured, unauthorized, or missing-binary slot passes with a sentence and never
  blocks.
- A timeout is an infrastructure failure, not a fail verdict.
- Every command runs in a pooled lease pinned to the captured commit, warm ignored
  dependencies survive the pin, and the lease remains durably pinned until confirmed return
  after completion or restart.
- Timeout, cancellation, and shutdown terminate the command's process group before returning
  its reusable lease.
- Branch code cannot start until its pid and process start time are durable. Recovery never
  signals a process whose identity does not match and never equates a missing leader with an
  empty process group.
- Every return is replay-safe: it requires the exact recorded path and holder token, treats
  available or missing as already returned, and refuses a different holder.
- The child environment contains no daemon auth token or credential-shaped variables, and
  the consent UI names the remaining filesystem authority.
- No shell is invoked anywhere in the path.
- README updated in this change.

## Downstream handoff

Phase 3 may rely on:

- The `check` node kind and `WORKFLOW_CHECK_SLOTS` spellings, both append-only.
- An unconfigured slot passing with a note, which is what makes a shipped built-in with check
  gates safe on an unconfigured machine.
- `checkCommandFor` and `checkBlockedReason` as the shared resolution and refusal helpers.

Phase 3 must not:

- Rename a slot or change the unconfigured-slot semantics.
- Move command resolution out of settings without revisiting decision 5 explicitly.

Phase 3 **must** change:

- `stageExpressible`, which this phase deliberately narrows.

## Cross-phase audit record

- **Against Phase 1**: no contract overlap. Textual overlap in `src/shared/workflow.ts`
  (different regions), `src/shared/protocol.ts` (Phase 1 touches none of it) and `README.md`
  (different subsections). Neither phase's tests import the other's modules. Confirmed
  mergeable in either order.
- **Correction carried back into the index**: an earlier source-plan draft left open whether
  `workflow_node_attempts` needs widening. The repository answers that outcomes fit without
  new attempt columns, while crash-safe cleanup needs a separate `workflow_check_leases`
  table. Recorded in `phased-plan.md` under investigated findings.
- **Scheduler boundary**: the first draft of this phase reused `ReviewScheduler`. A separate
  limiter inside `runAttempt` is still insufficient because `pump()` already acquires the
  review scheduler around every attempt. Corrected so `pump()` resolves node kind and routes
  to exactly one limiter before either is acquired.
- **Verdict evidence**: flagged rather than silently decided, because adding an `EvidenceRef`
  kind is append-only and reaches durable verdict JSON. The implementing agent records the
  choice in the PR.
