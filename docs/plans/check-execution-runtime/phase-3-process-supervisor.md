# Phase 3: Streaming process supervisor

Source plan: `docs/plans/builtin-workflows/phase-2-check-node.md` (lines 233-238, 303-330, and
checklist items 2, 3, 6 at 417-427)
Index: `docs/plans/check-execution-runtime/phased-plan.md`

## Outcome and value

Branch-authored code can be run, watched, bounded and killed - with its descendants - and a
daemon crash mid-command leaves enough evidence to prove afterwards whether anything is still
writing into the leased tree.

This is the piece with no existing precedent in the repository. The two `detached: true` sites
that exist (`claude-cli.ts:288-294`, `llm/codex.ts:18-25`) send `SIGKILL` immediately with no
grace period and no identity check, which is fine for a model subprocess we own end to end and
is not fine for a build that may have spawned a test runner that spawned a browser.

## Entry criteria and dependencies

- **Direct prerequisite: Phase 2 merged.** Consumes Contract P (`CheckProcessRegistry`) and
  the sentinel semantics of `supervisor_pid` / `supervisor_start_ticks`.
- No dependency on Phase 1.

## Scope

In scope:

- A streaming spawn adapter: `spawn` with `shell: false`, bounded tail-biased output, an exact
  omitted-byte count.
- The gated supervisor: persist identity before branch code is permitted to run.
- Process-group teardown with a grace period and a hard-kill escalation.
- Identity-verified signalling, used by both live teardown and startup recovery.
- The environment scrubber, as a pure function.
- A platform preflight that degrades honestly where identity cannot be read.

Explicit non-goals:

- **No lease acquisition.** Phase 2 owns it. This phase is handed a directory.
- **No `CheckExecutor`.** Phase 4 composes this with Phase 2.
- **No sandbox.** Scrubbing the environment reduces credential exposure; the command still has
  the daemon's filesystem authority. The source plan is explicit
  (`phase-2-check-node.md:325-330`) and the README copy must not call this a sandbox.
- **No shell.** An argv, always. This removes shell injection as a category rather than
  mitigating it (`phase-2-check-node.md:59`, `:77-78`).
- **No generalising of the two existing `killTree` helpers.** They are correct for what they
  do. Widening them to carry a grace period and identity would put check semantics on the
  model-subprocess path for no benefit.

## Repository findings this phase depends on

- **`run()` cannot serve this** (`util/exec.ts:68-93`). `execFile`-based, buffers from the
  start, kills the child on `maxBuffer` overflow. It cannot preserve a tail or report an exact
  omitted count. Already found by the source plan (`:72-76`). `run()` stays correct for the
  bounded lease/status/return commands.
- **`onPath(bin)` is unsafe here** (`exec.ts:17-23`). For a name containing `/` it
  `existsSync`es relative to the daemon cwd, not the leased checkout, so
  `./scripts/check` and `node_modules/.bin/tsc` exist and would be reported unavailable. The
  spawn's own `ENOENT` is the single authority (`phase-2-check-node.md:79-83`, `:246-248`).
- **`RunResult` carries `outcomeUnknown` and `overflowed` as required fields**
  (`exec.ts:25-50`), a deliberate shape this adapter should echo: a timeout or kill is
  `outcomeUnknown`, which the ladder turns into infrastructure and never a fail.
- **The result contract is already published.** `CheckExecutionResult` (`checks.ts:72-78`) is
  `exited | unavailable | infrastructure`. This phase produces those three and no fourth.
  `tailBounded(text, maxBytes)` (`checks.ts:167-185`) and
  `WORKFLOW_EXECUTION_LIMITS.checkOutput = 4_000` (`shared/workflow.ts:66`) already exist.
- **The precedents' shape is worth copying even where their policy is not**: a module-level
  `live` set, an `exit`-hooked killer registered once, `setEncoding("utf8")` on both streams
  to decode once, and `child.stdin.on("error", () => {})`
  (`claude-cli.ts:66-86`, `:187-194`, `:215-216`, `:240`).
- **Node exposes no process start time.** There is no built-in. It has to be read per
  platform, and that is the one genuinely unresolved implementation question in this phase.

## Implementation steps, in execution order

### 1. The environment scrubber

Pure function, own module, own tests, written first because it is the only part with no
concurrency in it.

Removes: the daemon auth token; the `MISSION_HOME` / `FLEET_HOME` / `HARNESS_HOME` aliases that
locate it (all three spellings - `src/shared/harness-runtime.mjs` owns the fallback chain);
and variables whose **names** are credential-shaped (token, secret, password, key, credential,
as suffixes and segments). Preserves ordinary settings needed to find and run tools: `PATH`,
`HOME`, `SHELL`, `LANG`/`LC_*`, `TMPDIR`, `TZ`, and the proxy vars.

Allow-list or deny-list is the implementer's call, but the choice must be commented. A
deny-list that misses a variable leaks it; an allow-list that misses one breaks a build with a
confusing error. Given the stated non-goal (this is not a sandbox), a deny-list with a broad
name-shape rule is the honest match to the threat model - say so.

### 2. Process start identity

`processStartIdentity(pid): string | null` - a stable, opaque, comparable token for "this
exact process, not a recycled pid".

- Linux: field 22 of `/proc/<pid>/stat` (starttime, in clock ticks since boot). Cheap, no
  spawn.
- macOS: `ps -o lstart= -p <pid>`, normalised. Costs a spawn; acceptable, it happens twice per
  check.
- Anything else: `null`.

**Where `null` is the answer, checks do not run.** Preflight it once and have the executor
report `unavailable` with a sentence naming the platform. That routes into the already-tested
third passing outcome (`checks.ts:23-28` - *"a gate no runtime can serve"*) and is the same
honest degradation the null executor ships today.

This is a deliberate departure from the source plan, which says recovery *"keeps the durable row
and reaper pin and refuses return until the runtime's recovery protocol resolves that
uncertainty"* (`:316-319`). That answer is right for a *transient* failure to read identity and
wrong as a *platform* answer: it would strand a pool tree on every crash, permanently, on a
platform where identity is never readable. Refusing to start is strictly safer than starting
something we can never prove is dead. Recorded in the audit below.

### 3. The streaming spawn adapter

```ts
spawn(argv[0], argv.slice(1), {
  cwd: <leasePath>/<workingSubpath>,
  env: scrubbed,
  shell: false,
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
})
```

- `stdin` is `ignore`, not `pipe`. A check that blocks on input should fail on a closed stdin,
  not hang until the timeout.
- Both streams `setEncoding("utf8")` and feed **one** bounded tail-biased ring shared across
  stdout and stderr, so interleaving is preserved in the order it arrived.
- Count **every** streamed byte. `truncatedBytes` = total streamed minus retained, exact.
  The source plan is explicit (`:233-237`): if the implementation cannot preserve that
  invariant, replace the field with `truncated: boolean` and never invent a count.
- `ENOENT` from the spawn → `{ kind: "unavailable", note }`. Nothing else may produce
  `unavailable` from this adapter.
- Timeout, OOM, or a signal death → `{ kind: "infrastructure", reason }`. Never a
  non-zero-exit `exited`.
- Clean exit → `{ kind: "exited", exitCode, output, truncatedBytes }`.
- Timer `unref()`d, as the precedents do.

### 4. The gated supervisor - persist before release

The ordering invariant, and the reason this is not just a spawn call
(`phase-2-check-node.md:303-314`):

1. Spawn the supervisor in its own process group (`detached: true`) with the branch command
   **held**, not running. A tiny trusted shim: the child starts, signals readiness, and waits
   for one byte before `exec`ing the configured argv.
2. Read the supervisor's pid and `processStartIdentity(pid)`.
3. `CheckProcessRegistry.record(attemptId, pid, ticks)` - a synchronous durable write.
4. **Only then** release the gate so branch code may run.

If any of 2-3 fails, close the gate and terminate the supervisor **without** ever starting
branch code. Because the gate was never released, the row still carries the sentinel and
recovery knows nothing ran.

This is what makes "crash between spawn and durable identity" (checklist item 2) unreachable:
there is no window in which branch code runs without a persisted owner.

The shim is the fiddly part. Prefer a mechanism with no temp file - an inherited pipe fd the
parent writes one byte to - over anything that writes a script to disk. Whatever is chosen,
the shim must remain the identifiable group leader for the life of the group; a shim that
`exec`s itself away and lets the build become the leader breaks step 5.

### 5. Identity-verified teardown

One function, used by live cancellation, timeout, daemon shutdown, and startup recovery.

- Read pid + ticks from the registry. Sentinel → nothing ever ran; nothing to signal.
- Re-read `processStartIdentity(pid)`. **Mismatch → never signal.** It is a recycled pid, and
  signalling it kills a stranger (checklist item 3).
- Match → `process.kill(-pid, "SIGTERM")`, wait a bounded grace, then `process.kill(-pid,
  "SIGKILL")`. The grace is what distinguishes this from the two existing precedents and it
  exists so a test runner can flush and remove its own temp state.
- **Then prove emptiness.** Leader exit is not emptiness (checklist item 6). Poll
  `process.kill(-pid, 0)` until it throws `ESRCH`, bounded. While the group answers, the tree
  is still being written to.
- Report a tri-state: `empty` / `not-empty` / `unknown`. Only `empty` may authorise Phase 2's
  `releaseForAttempt`. `unknown` keeps the row and the pin, which is exactly the source plan's
  rule at `:316-319`.

Windows has no POSIX process group. Where `process.kill(-pid)` is unavailable the answer is the
step-2 preflight - checks do not run - so this function may assume POSIX and say so.

### 6. Wire the shutdown path's precedent, not its policy

Register a module-level `live` set and an `exit` hook the way `claude-cli.ts:66-86` does, so a
hard daemon exit still signals the groups. It must call the identity-verified path, not a bare
`killTree`. Phase 4 owns making `WorkflowEngine.stop()` call it in an orderly way; this phase
owns the last-resort hook.

## Data, API and compatibility

- **No schema change.** The two columns exist from Phase 2.
- **No change to `CheckExecutionResult`.** Contract E. This phase produces the published
  three-variant type.
- **New platform floor for checks**: Linux and macOS. Everything else reports `unavailable`
  and passes, so no build breaks - it degrades into an already-tested path. README must say
  which platforms execute checks.
- **`WORKFLOW_EXECUTION_LIMITS.checkOutput`** is the existing bound; do not add a second one.

## Tests and verification

`test/workflow-check-spawn.test.ts` - the adapter against real short-lived processes, no
mocks:

- Exit 0 with output; non-zero with output; the tail is retained and `truncatedBytes` is
  **exact** against a generator writing a known byte count.
- Interleaved stdout/stderr preserve arrival order in the shared ring.
- A missing executable is `unavailable`; a relative `./script` inside the working directory is
  found (the `onPath` trap).
- A timeout is `infrastructure`, never `exited`.
- `shell: false` proven: an argv containing `;`, `$(…)` and `&&` is passed as literal
  arguments.

`test/workflow-check-supervisor.test.ts`:

- Identity is persisted **before** branch code runs - assert by making the branch command's
  first act observable and checking the registry write happened first.
- A failure between spawn and persist leaves the sentinel and never runs branch code.
- A process spawning a grandchild: `SIGTERM` to the group reaches both; emptiness is only
  reported after the grandchild exits.
- A grandchild ignoring `SIGTERM` is `SIGKILL`ed after the grace.
- A mismatched start identity is never signalled - the strongest test in the phase; construct
  it by recording a live pid with a deliberately wrong tick value and asserting no signal.
- Emptiness returns `unknown`, not `empty`, when the group still answers at the bound.

`test/workflow-check-env.test.ts`: the scrubber removes the token, all three home aliases and
credential-shaped names, and preserves `PATH` / `HOME` / proxy vars. Table-driven.

Commands: `npm run typecheck`, `npm test`, `npm run build`.

Manual: run a check command that spawns a background server, cancel it, and confirm with `ps`
that nothing survives.

## Merge and exit criteria

- CI green on Node 24 and 26.
- No orphan process survives the suite - assert it, do not eyeball it.
- The adapter is the only new `spawn` under `src/server/workflows/`.
- `truncatedBytes` is exact, or the field is a boolean and the plan is amended to say so.
- This phase ships **tested but unwired**: nothing calls the supervisor until Phase 4. That is
  the same honest shape the first check unit took with its null executor, and the module
  comment should say who its one consumer will be.

## Downstream handoff

Phase 4 may rely on: the three-variant result; the tri-state emptiness report, where only
`empty` authorises a lease return; the platform preflight already having decided whether checks
can run here; and identity-verified teardown being safe to call from `WorkflowEngine.stop()`
concurrently for several attempts.

Nobody may: call `process.kill` on a check group without the identity check; treat leader exit
as emptiness; introduce a second spawn path for checks; or use `onPath` to precheck a check
command.

## Cross-phase audit record

- **2026-07-30, at authoring:** re-read the source plan, the index, and Phases 1-2. Consumes
  Contract P exactly as Phase 2 defined it; no direct table access. No overlap with Phase 1.
- **Deviation from the source plan recorded, and it edits nothing earlier:** the source plan
  (`:316-319`) treats unreadable identity as a recovery-time uncertainty to be held open.
  This phase adds a *startup* preflight so an unsupported platform never starts a check at
  all, and keeps the plan's hold-open rule for the transient case. Both survive:
  `unknown` at teardown still keeps the row and the pin. Phase 2 needs no change - its
  `releaseForAttempt` already refuses without positive identity, and a preflighted platform
  simply never creates a row.
- **Source-plan checklist coverage**: item 2 (crash between spawn and durable identity) →
  step 4's gate; item 3 (PID recycling) → step 5's mismatch rule; item 6 (leader exit with
  live descendants) → step 5's emptiness proof and its tri-state.
- **Confirmed the phase leaves the repository operable**: the new modules are pure additions
  with no call site, so `checkDeps.execute` stays null and the shipped
  `unavailable`-and-pass behaviour is unchanged until Phase 4.
