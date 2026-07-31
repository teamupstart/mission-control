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

**It is a COMPOSITE, and it has to be**, because no shell-reachable start-time field on either
platform has enough resolution to stand alone. `ps -o lstart=` is whole-**second**; Linux's
`starttime` is clock ticks, typically 10ms. A pid recycled inside that window compares equal,
and the one thing this check exists to prevent is signalling a stranger's process group.

So the identity is `(start-time field, supervisor command line)`, and step 4's shim **takes the
attempt id as an argument** specifically so the second half is unique. A false match would then
require the same pid, started in the same second, running our shim, for the same attempt - and
only one supervisor is ever created per attempt, so no second process can bear that id. The
attempt id is already in hand at spawn time; this costs nothing and turns a probabilistic
argument into a structural one.

- Linux: field 22 of `/proc/<pid>/stat` (starttime, in clock ticks since boot) plus
  `/proc/<pid>/cmdline`. Two cheap file reads, no spawn.
- macOS: `ps -o lstart=,command= -p <pid>`, normalised. **One** spawn for both halves, so the
  composite costs no more than the single field did; it happens twice per check.
- Anything else: `null`.

If either half is unreadable the whole identity is `null`. A half-identity is the failure mode
this is guarding against, so it must not be allowed to look like a successful read.

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
   **held**, not running. A tiny trusted shim: it starts, signals readiness, and waits for one
   byte before launching the configured argv **as a child of itself**.
2. Read the supervisor's pid and `processStartIdentity(pid)`.
3. `CheckProcessRegistry.record(attemptId, pid, ticks)` - a synchronous durable write.
4. **Only then** release the gate so branch code may run.

If any of 2-3 fails, close the gate and terminate the supervisor **without** ever starting
branch code. Because the gate was never released, the row still carries the sentinel and
recovery knows nothing ran.

This is what makes "crash between spawn and durable identity" (checklist item 2) unreachable:
there is no window in which branch code runs without a persisted owner.

The shim is the fiddly part, and two of its properties are load-bearing rather than
stylistic.

**It forks the command as a child and stays alive; it must NOT `exec`.** An `exec` replaces the
process image, so the pid survives but its command line becomes the branch command - and step
2's identity includes that command line. A later identity read would then see a mismatch on a
group that is very much alive, refuse to signal it (correctly, by its own rule), and leave the
lease pinned forever with a live process still writing into the tree. The same `exec` also
hands group leadership to the build, which breaks step 5's emptiness proof independently. So
the shim spawns the argv as a child, inherits and passes through the stdout/stderr fds so the
streaming adapter needs no relay, waits for the child, and exits with the child's status.
It costs one extra process in the group and buys a leader whose identity is stable from spawn
to teardown.

**The shim's argv must carry the attempt id**, because step 2's identity depends on it for
uniqueness. It is not decoration and it is not for logging: drop it and the identity falls back
to a whole-second timestamp that a recycled pid can match. Note the two requirements are one
design - the id has to be in the argv, and the argv has to survive, or neither is worth having.

Prefer a gate mechanism with no temp file - an inherited pipe fd the parent writes one byte to -
over anything that writes a script to disk.

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

### 6. Startup group recovery, which Phase 2 consumes through a seam

Phase 2's `reconcileOnStartup()` can prove a leased tree is still ours (path plus holder token)
but **cannot prove its process group is empty** - and this phase's own rule is that confirmed
emptiness, not leader liveness, is the precondition for a return. Export the recovery entry
point that closes that gap:

```ts
export type CheckGroupRecovery = (attemptId: string) => Promise<"empty" | "not-empty" | "unknown">;
```

It reads the persisted pid and identity, applies step 5 unchanged - sentinel means nothing ever
ran; mismatch is never signalled; a match is signalled, graced, escalated, then proven empty -
and returns the same tri-state. Phase 2 declared this seam with a default that refuses
(`"unknown"`, keep the row and the pin); this phase supplies the real implementation, and Phase
4 injects it. Until it is injected, a non-sentinel row is held rather than returned, which is
the fail-closed direction.

### 7. Wire the shutdown path's precedent, not its policy

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
  which platforms execute checks, and that on both the identity is a composite of a start-time
  field and the attempt-bearing command line rather than a timestamp alone.
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
- **The identity survives the gate release.** Record identity, release the gate, let the child
  run, then re-read the identity and assert it still matches. This is the regression an `exec`
  shim would cause, and it is invisible to every other test here because they all read identity
  before the command starts.
- **Each half of the composite is load-bearing on its own.** One case where the start-time
  halves match but the command line does not (the recycled-pid-within-the-same-second case the
  composite exists for), and one where the command matches but the start time does not. Both
  must refuse. A test that only varies the timestamp would pass against a single-field identity
  and prove nothing about the fix.
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
`empty` authorises a lease return; `CheckGroupRecovery`, to be injected into Phase 2's
reconciliation seam; the platform preflight already having decided whether checks
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
- **2026-07-30, Inspector round 3 (PR #326):** finding accepted - *"Use a PID identity with
  sub-second precision on macOS"*. `ps -o lstart=` is whole-second, so a pid recycled inside
  that second compares equal and recovery could signal an unrelated group. The suggested
  fallback (report checks unavailable on macOS) was not needed: there is no finer
  shell-reachable field without native code, but there is a cheaper answer than precision -
  make the identity a **composite** with the supervisor's command line, and make that command
  line unique by putting the attempt id in the shim's argv. A collision then requires a second
  process bearing an attempt id only one supervisor ever holds, which is structural rather than
  probabilistic. Applied to Linux too: its 10ms `starttime` was better but not immune, and one
  identity shape across platforms is easier to reason about than two. Costs no extra spawn on
  macOS (`lstart` and `command` come from one `ps`). Phase 2's Contract P is unchanged - it
  stores an opaque `startTimeTicks` string, and a composite is still one opaque string.
- **2026-07-30, Inspector round 6 (PR #326):** finding accepted - *"Keep the supervisor identity
  stable after releasing the gate"*. This was self-inflicted: round 3 made the identity a
  composite including the shim's command line, and step 4 still said the shim `exec`s the
  configured argv. An `exec` replaces the command line, so every later identity read would
  mismatch on a live group, refuse to signal it, and strand its lease - the exact failure the
  composite was introduced to prevent. Step 4 also contradicted itself, since its own closing
  paragraph already forbade a shim that "`exec`s itself away". Corrected to fork-and-wait, with
  the two requirements stated as one design so the next reader cannot satisfy half of it, and a
  test that re-reads identity *after* the gate is released - a case no existing test covered,
  because they all read it before the command starts.
- **2026-07-30, Inspector round 5 (PR #326), consumed here:** Phase 2's startup reconciliation
  could `return --force` a tree whose group was still live. The gap was that Phase 2 can prove
  ownership but not emptiness, so this phase now exports `CheckGroupRecovery` for it. Recorded
  in Phase 2's audit as well; the seam is declared there and implemented here.
- **2026-07-31, at implementation.** Eight deviations from this document's literal text, each
  with the reason it was made. Modules shipped: `check-env.ts`, `check-identity.ts`,
  `check-group.ts`, `check-spawn.ts`, `check-supervisor.ts`; tests
  `test/workflow-check-{env,spawn,supervisor}.test.ts`.

  1. **Contract P is consumed exactly as published, and `check-lease.ts` is untouched.** This
     phase must implement `CheckGroupRecovery(attemptId)`, which is handed nothing but an
     attempt id and has to find the pid it persisted before the daemon died - and Contract P
     offers no reader. The first implementation added a `read` member to
     `CheckProcessRegistry` and implemented it in `CheckLeaseManager`. **That was wrong and has
     been reverted**, on review: Phase 2 has merged, it owns and publishes that interface, and
     widening it to serve a later phase's consumer turns a consumer's need into an owner's
     obligation. Additive is not the same as in-bounds.

     The capability is now supplied the way every other seam in this design is - the consumer
     names the narrow function it needs and its composer supplies one. `CheckSupervisorLookup`
     is declared in `check-supervisor.ts`, and Phase 4, which already composes the lease
     manager with the supervisor, provides it from an accessor it holds. `runSupervisedCheck`
     calls only `record` and `clear`. As a bonus the sentinel comparison stopped being anyone's
     obligation: a supplier may return `null` for "nothing recorded" or hand the raw sentinel
     columns straight through, because `terminateCheckGroup` already refuses a non-signallable
     pid or an empty identity. Both routes reach `empty`, and both are asserted.
  2. **The output ring works in BYTES, not in decoded text**, so `setEncoding("utf8")` is not
     used on stdout/stderr. Taken under this document's own escape clause about the exactness
     invariant, and the field stays a number rather than becoming a boolean. A decoded ring can
     only count the bytes of its OWN decoding, so a build emitting one invalid byte - a binary
     fixture, a truncated UTF-8 tail - reports a count three times larger than the truth,
     silently. Counting raw bytes and decoding ONCE at the end keeps both properties the
     precedents wanted: the count is exact by construction, and a multi-byte character
     straddling a chunk boundary decodes correctly because the boundary is interior to the
     retained buffer by then. The only new edge is the FRONT of the tail, where a byte-exact
     cut can land mid-character; the ring advances past the continuation bytes and counts them
     as dropped, which they are. Both asserted, including a case where kept + dropped must
     equal a generator's known byte count.
  3. **"The group still answers at the bound" reports `not-empty`, not `unknown`.** This
     document's test list says `unknown`. The two have identical downstream effect - only
     `empty` authorises a return - so nothing about lease safety changes, but the words are
     worth keeping distinct: `not-empty` is "we asked and it answered", `unknown` is "we could
     not ask", which is what an unreadable or mismatched identity produces. The test asserts
     both the safety property (`!== "empty"`) and the specific value, so it holds under either
     reading.
  4. **A mismatched or unreadable identity is still PROBED, though never signalled.** The rule
     that a mismatch is never signalled is kept exactly. But `kill(-pid, 0)` sends nothing, and
     `ESRCH` on the group id proves emptiness on its own without any signal. Without this, a
     daemon that crashed *after* its checks had finished would strand one pool slot per crash
     forever - the same outcome step 2 of this document rejects when arguing why an unsupported
     platform must refuse to start rather than hold leases open. The source plan's "neither a
     missing nor mismatched leader proves the group is empty" is about inferring from the
     LEADER; this infers from the GROUP, which is the thing the contract is actually about.
  5. **The command-line half of the identity is stored condensed** (a truncated SHA-256) rather
     than raw. The supervisor's command line carries the whole `node -e` shim, about 2.6KB, and
     the identity is written to a durable column on a table whose rows are RETAINED for audit.
     Equality is the only question ever asked of an identity, and equal command lines digest
     equally. Contract P is unaffected: it is still one opaque string Phase 2 stores and
     compares without parsing.
  6. **`processStartIdentity` permits pid 1; only the signalling path refuses it.** Found by
     running the real modules on Linux in Docker before opening this, and it was a genuine bug
     rather than a test artifact: the daemon is pid 1 whenever it runs as a container's
     entrypoint, the platform preflight probes its own identity, and a `pid <= 1` guard on the
     READ path reported every containerised Linux daemon as a platform that cannot run checks
     at all. The wildcard danger (`kill(-0)` hits our own group, `kill(-1)` hits everything the
     user owns) is real but belongs on the signal path, where `signallableGroup` still enforces
     `pid > 1` and is consulted first by every caller. **CI would not have caught this** - test
     pids are always above 1 - which is the argument for having run it on Linux at all.
  7. **The shim lives in argv (`node -e`), not in a file.** This document asked only that the
     GATE avoid a temp file; the shim's own home was open. A separate `.mjs` would have to
     survive `esbuild --bundle` into `dist/`, an Electron package and a `tsx` dev run, and a
     path that resolves in two of those three fails at the moment a check runs rather than at
     build time. In argv it is present wherever the daemon is, and it needs no build-step or
     packaging change. The gate itself is an inherited pipe, as asked: fd 3 carries the release
     byte and fd 4 the shim's readiness and the command's outcome, two fds rather than one
     duplex socket so each direction's EOF means exactly one thing.
  8. **The platform preflight probes the daemon's own identity, not just `process.platform`.**
     A platform string is a guess that a container with no `/proc` mounted, or an image with no
     `ps`, answers wrongly. Asking the same question the check will ask, once, is cheap and
     correct.

  Two limitations were found by measurement and are documented in `checkGroupAnswers` rather
  than papered over. A descendant that calls `setsid()` leaves the group and cannot be reached
  by any group signal - group emptiness is the contract, and a deliberate daemoniser is outside
  it. And a ZOMBIE still answers a group probe, so a daemon that is itself a container's pid 1
  must reap adopted orphans or emptiness never resolves; measured directly, the Linux run
  reports `not-empty` forever as a bare container entrypoint and `empty` under
  `docker run --init`. Both fail in the safe direction: they delay a lease return rather than
  authorising one early.

  **Confirmed the phase ships unwired**, as required: nothing imports `check-supervisor.ts`,
  `checkDeps.execute` is still null, and a configured check still reports `unavailable` and
  passes. Phase 4 remains its only intended consumer. **No file owned by another phase is
  modified**: the diff outside the five new modules and their tests is README prose and these
  planning documents.

- **2026-07-31, review round 1 (Inspector).** One `major`, accepted and fixed: *"Abort an
  unreleased supervisor when the run timer fires."* A `timeoutMs` shorter than the supervisor's
  own start-up - a small configured value, or a loaded machine - fired the run timer while the
  gate was still HELD. `tearDown()` then answered `empty`, truthfully (nothing had been
  released, so there was no group), and settled the call **without closing the gate or killing
  the shim**. The result was a detached supervisor waiting on its gate forever, recorded in no
  durable row and registered with neither the `live` set nor the exit hook - the one process in
  this design that nothing would ever come back for.

  Fixed by branching the run timer on whether the gate was released: unreleased goes to
  `abortBeforeRelease`, and group teardown is used only after release. A second, adjacent hole
  was found while fixing it and closed in the same change: killing the shim does not retract a
  readiness byte the kernel has already delivered, so `onReady` could still run afterwards and
  persist the identity of a process just killed. `abortBeforeRelease` now latches, and
  `onReady` refuses once it has.

  The regression test is `"a timeout before the supervisor is ready leaves no held shim
  behind"`. It asserts the leak directly rather than by proxy, by scanning `ps` for the attempt
  id the shim carries in its argv - which is that argument's own purpose, used here to identify
  a process the caller was never handed a pid for. Against the unfixed code the test does not
  merely fail, it HANGS: the orphaned shim's inherited handles keep the test file's event loop
  alive, which is the same mechanism that would have kept the daemon's alive.
