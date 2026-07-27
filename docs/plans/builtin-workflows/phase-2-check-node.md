# Phase 2: The check node

Source plan: `docs/plans/builtin-workflows/plan.md`
Index: `docs/plans/builtin-workflows/phased-plan.md`

## Outcome and value

A workflow can gate on a deterministic command. An operator configures what `test` or `lint`
runs for a repository, drops a Check node into a graph, and a submission that does not compile
fails on an exit code instead of spending four model calls to reach the same conclusion.

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
- Execution: bounded, timed, in a temporary detached worktree at the captured commit, on its
  own concurrency limit, with teardown on completion and daemon restart.
- A scrubbed child environment, repository allowlisting, and consent copy that names the
  filesystem authority granted to branch-authored code.
- Validation, Graph-view rendering, run-detail presentation, README, tests.

Explicit non-goals:

- **No Pipeline editor support.** `stageExpressible` returns false for a graph containing a
  check, which routes it to the existing Graph view. Phase 3 owns making that a true.
- **No built-in workflow uses a check yet.** Phase 3 ships version 2.
- **No repository-file command source.** Settings only, per decision 5. The default-branch
  file is a named follow-up, not this phase.
- **No shell.** The streaming check runner spawns an argv directly with `shell: false`.
- **No DB migration.** The existing attempt row accommodates a check.
- **No auto-fix.** A failing check returns findings to the Session through the same repair
  packet a Persona fail produces.
- **No full execution sandbox.** Environment scrubbing reduces credential exposure, but the
  command still has the daemon's filesystem authority. A full sandbox is a named follow-up.

## Repository findings this phase depends on

- **`run()` (`src/server/util/exec.ts:68`) is not the check-command seam.** It uses
  `execFile`, buffers from the start, and kills the child when `maxBuffer` is exceeded. It
  cannot preserve the useful tail or report an exact omitted-byte count. Checks need a
  streaming `spawn` adapter with a bounded byte ring; `run()` remains suitable for the
  bounded git worktree setup and teardown commands.
- **The streaming adapter uses `spawn` with `shell: false`.** A command is an argv, not a
  string. This removes shell injection as a category rather than mitigating it.
- **`onPath(bin)` (`exec.ts:17`) answers "is this command even there" from the filesystem**,
  without spawning. It is the cheap pre-check for a misconfigured slot.
- **`workflow_node_attempts` needs no migration.** `persona_snapshot_json`, `runner_id`,
  `model_id` and `verdict_json` are all nullable (`db.ts:461-478`), and `insertAttempt`
  already writes `input.persona === null ? null : ...` (`store.ts:2443`). This corrects the
  source plan, which left widening open.
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
  fail verdict", with `MAX_INFRA_ATTEMPTS = 3` and exponential backoff. A check that could not
  run takes that path, not a fail.
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
  onPath?: typeof onPath;
  worktrees?: CheckWorkspaceDeps;
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
- **Binary not on PATH (`onPath` false): `unavailable`.** A typo in settings is a
  configuration problem, not a defect in the change under review.
- **`outcomeUnknown` true (timeout, OOM, killed): infrastructure failure.** Return it to
  `handleInfrastructureFailure` for retry and eventual block. It is never a `fail` verdict,
  matching the rule the engine already enforces for Personas.
- **Exit 0: `passed`. Non-zero: `failed`**, with tail-biased bounded output.

Execution context: create a per-attempt directory under a dedicated check-worktrees state
directory and materialize it with `git worktree add --detach <path> <captured-head-sha>`.
Run the command with that directory as `cwd`. Never use `sessionRepoRoot` or `sessionCwd` as
the execution directory. The former identifies the shared main repository for a linked
worktree, while the latter remains mutable after evidence capture. Sessions normally run in
pooled worktrees under `~/.treehouse/`, so choosing `sessionRepoRoot` would execute against
an unrelated checkout in the common case.

Use `sessionRepoRoot` only as repository identity for the git worktree operation. Reject a
missing or invalid captured commit as infrastructure failure. Remove the temporary worktree
in `finally` after every success or failure. Before scheduling attempts on startup, reap
leftover check worktrees from interrupted runs through `git worktree remove --force`.
The concurrency ceiling therefore also bounds disk use: at most one extra checkout per
running check, plus restart leftovers until the startup reaper runs.

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
that it needs consent. Document the detached checkout, environment scrubbing, remaining
filesystem authority, and deferred full sandbox. Add the two Settings rows under
Configuration.

## Data, API and compatibility

- **No migration.** The attempt row already accommodates a check.
- **`WORKFLOW_CHECK_SLOTS` is append-only.** A slot id reaches published graphs; renaming one
  orphans every graph naming the old spelling.
- **A published version pins no command.** Two runs of the same version on different machines
  may run different commands, which is correct: the version describes the gate, the operator
  describes the machine.
- **Forward compatibility.** A build without this phase reading a graph containing a check
  node rejects it at the zod boundary. That is a downgrade, same as any node kind, and needs
  no special handling.

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
- A binary absent from PATH produces `unavailable` without spawning.
- The command is passed to the streaming adapter as argv with `cwd` set to a detached
  worktree at the captured commit, never the binding's main repository or mutable session
  checkout.
- Temporary worktrees are removed after pass, fail, timeout, and spawn failure. The startup
  reaper removes a simulated leftover before attempts resume.
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
- Every command runs in a detached checkout at the captured commit, and temporary worktrees
  are reclaimed after completion and restart.
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
- **Correction carried back into the index**: the source plan left open whether
  `workflow_node_attempts` needs widening. The repository answers it, so this phase adds no
  migration. Recorded in `phased-plan.md` under investigated findings.
- **Scheduler boundary**: the first draft of this phase reused `ReviewScheduler`. A separate
  limiter inside `runAttempt` is still insufficient because `pump()` already acquires the
  review scheduler around every attempt. Corrected so `pump()` resolves node kind and routes
  to exactly one limiter before either is acquired.
- **Verdict evidence**: flagged rather than silently decided, because adding an `EvidenceRef`
  kind is append-only and reaches durable verdict JSON. The implementing agent records the
  choice in the PR.
