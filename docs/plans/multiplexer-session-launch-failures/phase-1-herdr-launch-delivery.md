# Phase 1: Herdr launch delivery and enumeration resilience

Source plan: [`plan.md`](plan.md). Index: [`phased-plan.md`](phased-plan.md).

This is the proposed route, not a specification. Follow it where the repository agrees, use your own
judgement where it does not or where a better implementation presents itself, and record any
deviation and its reasoning in the pull request.

## 1. Outcome

A dispatch to Herdr starts the agent. Today it does not: the launch command is typed into a login
shell and its Enter is lost inside the bracketed paste, so the command sits unexecuted and the
dispatcher reports "agent session never appeared" thirty seconds later. Three of the operator's
dispatches failed this way on 2026-09-09 while the same agent succeeded on tmux.

Two smaller outcomes ride with it: the test suite stops opening real multiplexer sessions on the
machine that runs it, and one slow Herdr pane stops blanking every Herdr card on the dashboard.

## 2. Entry criteria and dependencies

- Direct dependency: the planning session's pull request, which publishes this file and
  [`plan.md`](plan.md) to the default branch. No other phase exists.
- Herdr installed and its server running, for the manual confirmation in section 7. The automated
  tests must not require either; they drive the adapter through its injected `TerminalExec` and
  `HerdrClientDeps` seams, as `test/herdr-adapter.test.ts` and `test/herdr-client.test.ts` already do.

## 3. Scope

**In scope**

1. Fold the environment assignments and the agent argv into the `launch-and-cleanup.sh` wrapper that
   `isolatedAgentArgv` already writes, so what a backend receives is a short command.
2. In the Herdr adapter's `spawnDetached`, send the paste and the Enter as separate writes, then
   verify the agent started before reporting success, and roll the workspace back when it did not.
3. Make Herdr's `list()` degrade per pane rather than collapsing to `[]` when one pane's
   `pane.process_info` fails.
4. Inject the `spawn` seam in `test/multi-repo-dispatch.test.ts` and pin the boundary.

**Explicit non-goals**

- **Defect 2, the Pi / Mission MCP work.** It is a separate plan task
  (`fa74e272-3762-4683-8fe8-bf9defe233ea`). Do not add a harness capability gate, do not touch the
  `missionMcpRegistered` guard in `dispatcher.ts`, and do not change `ask-channel.ts`.
- Reaping the 42 leaked Herdr workspaces or the 2 leaked tmux sessions already on the operator's
  machine. Fix the source; the existing ones are operator state and a daemon that deletes workspaces
  it did not create is a worse defect than the one it cleans up.
- Changing tmux or cmux launch semantics beyond the shorter argv that falls out of step 1.
- Raising `HERDR_MIN_PROTOCOL`. Herdr 0.9.0 on protocol 22 is compatible and the floor is correctly
  a floor.
- Any change to the `Multiplexer`, `MuxSessions` or `NameRules` interfaces.

## 4. Repository findings

Verified before this file was written. Trust these, but confirm anything you build on.

- `isolatedAgentArgv` (`src/server/agent-subprocess-env.ts:174`) writes
  `#!/bin/sh\ntrap '/bin/rm -rf -- "$MISSION_HOME"' EXIT\n"$@"\n` and returns
  `[env, ...(-u NAME)*, ...(NAME=VALUE)*, sh, wrapper, ...argv]`. It has exactly two callers:
  `dispatcher.ts:2720` and `targets.ts:238`.
- A real dispatch argv measured on the operator's machine is **3,546 bytes**.
- `shellCommand` (`src/server/terminal/shell.ts`) single-quotes every word, so the typed text is
  slightly longer than the argv it encodes.
- tmux (`tmux.ts:454`) and cmux (`cmux.ts:504`) hand the command to the multiplexer to exec. Herdr
  (`herdr.ts` `sessions.spawnDetached`) is the only backend that types it, because Herdr's socket API
  has no command parameter: `WorkspaceCreateParams` accepts only `cwd`, `label`, `env`, `focus` and
  `source_workspace_id`.
- Herdr's `workspace.create` `env` map **is not a substitute** for the exec prefix. Measured: it
  reaches the shell for `MISSION_HOME`, but the login shell's rc files rewrite `PATH` back to the
  operator's interactive PATH, defeating the isolation the prefix exists to provide.
- Measured delivery reliability against the live server at a 3,009-byte command: one combined
  `send_input(text, keys: ["enter"])` executed **1 of 6** times; `send_input(text)` followed after
  400 ms by `send_keys(["enter"])` executed **6 of 6**. A size sweep in the single-call form executed
  at 207, 607, 907, 1009 and 1509 bytes and failed at 1109 and 3009, which is a race rather than a
  limit.
- `HerdrClientDeps` already injects `sleep` and `now`, so a bounded poll is testable without real
  time. The client has **no** single-pane process lookup; `snapshotWithProcesses` is the only caller
  of `pane.process_info` and it fetches every pane.
- `snapshotWithProcesses` already treats the `pane_not_found` error code as a null process rather
  than a failure. Every other failure returns from the whole call, and `herdr.ts` `list()` maps any
  failure to `[]`.
- `list()` also has its own `return []` inside the pane loop when a pane's workspace or tab lookup
  misses or its process entry is `undefined`.
- Measured enumeration cost at 47 workspaces / 93 panes: snapshot 113 ms, 93 `pane.process_info`
  calls 314 ms at 8 concurrent (p50 2 ms, p95 104 ms), whole `list()` **427 ms**, against a 1,500 ms
  discovery tick and a 1,000 ms per-call read timeout, with a hard refusal at `panes + 1 > 512`.
- The leaking test is `test/multi-repo-dispatch.test.ts:285`, the `soloharness` case:
  `new Dispatcher(registry)` with no `spawn` seam, agent `pi`, task id `soloharness`, title `T`.
  `sessionLabel` gives `T` and `taskId.slice(0, 6)` gives `soloha`, producing **`T-soloha`** - the
  label on all 42 leaked Herdr workspaces and the 2 leaked tmux sessions. The seam exists and is
  documented for exactly this at `dispatcher.ts:258`.

## 5. Implementation steps

### 5.1 `src/server/agent-subprocess-env.ts` - shrink what any backend receives

Change `isolatedAgentArgv` so the wrapper script carries the environment and the agent argv, and the
returned array is short.

- Write the wrapper as a `/bin/sh` script that unsets `STATE_HOME_ENV_NAMES`, exports each
  `agentSubprocessEnv` entry, keeps the existing `trap … EXIT` cleanup, and ends by running the
  agent. Quote every value with the same rule `shellCommand` uses; do not hand-roll a second quoting
  function, and prefer reusing `shellCommand` if the import direction allows it.
- The `trap` must still fire on the agent's exit. Run the agent as the script's final statement; if
  you `exec` it, the `trap` will not fire, so either do not `exec` or arrange cleanup another way and
  say which in the pull request.
- Return an argv that names the interpreter and the script and nothing else, so
  `shellCommand(argv)` is on the order of 90 bytes rather than 3,546.
- Both call sites (`dispatcher.ts:2720`, `targets.ts:238`) should need no change. If one does, that
  is a finding worth recording.

Compatibility note: the file mode stays `0o700` and the path stays inside the disposable state home,
so `cleanupDisposableAgentStateHome` still removes it and the "the terminal wrapper removes its state
home" assertion in `test/agent-subprocess-env.test.ts:127` still holds.

### 5.2 `src/server/terminal/herdr-client.ts` - a narrow single-pane process lookup

- Add `processInfo(paneId)` returning the same `HerdrProcessInfo` shape `snapshotWithProcesses`
  already validates, with `pane_not_found` surfaced as a null process rather than an error.
- Refactor `snapshotWithProcesses` to call it, so `pane.process_info` is spelled once.

### 5.3 `src/server/terminal/herdr.ts` - deliver, submit, verify, roll back

In `sessions.spawnDetached`, replace the single `client.sendInput(paneId, shellCommand(spec.argv), ["enter"])`:

1. `sendInput(paneId, shellCommand(spec.argv))` with no keys.
2. Confirm the paste has settled before submitting. Prefer an observation over a fixed sleep: poll
   `client.read(paneId)` until the pane's visible text contains the tail of what was pasted, bounded
   by a short deadline using the injected `sleep`/`now`. A fixed sleep is acceptable only if the
   observation proves unreliable, and then say so in the pull request.
3. `sendKeys(paneId, ["enter"])`.
4. Verify with `processInfo(paneId)`, polling until the pane's foreground process is something other
   than the bare login shell, bounded by a short deadline. Treat a pane whose foreground process is
   still only the shell at the deadline as a failed launch.
5. On a failed launch, roll the workspace back the way the existing refused-`sendInput` branch
   already does via `client.closeWorkspace`, and return an error that names what happened: Herdr
   accepted the command but the shell never ran it. Preserve the existing `outcomeUnknown` handling -
   an outcome-unknown delivery must not be rolled back, because it may have started an agent.

Keep the existing side-pane behavior: a failed split still cannot fail a launch.

### 5.4 `src/server/terminal/herdr.ts` and `herdr-client.ts` - partial enumeration

- In `snapshotWithProcesses`, a failing `pane.process_info` for one pane records a null process for
  that pane instead of failing the whole call, matching what `pane_not_found` already does. Keep the
  whole-call failure only for what genuinely invalidates the snapshot: a protocol below
  `HERDR_MIN_PROTOCOL`, a pane identity mismatch, a duplicate pane id, and a failed
  `session.snapshot`.
- In `list()`, a pane whose workspace or tab lookup misses is **skipped**, not a reason to discard
  every other pane. Keep `return []` for the cases that mean the snapshot itself is untrustworthy
  (the `uniqueBy` duplicate-id checks).
- `MuxPane.panePid` is already nullable and the herdr adapter already sets `tty: null`, so a pane with
  no process information is representable without a type change.

### 5.5 `test/multi-repo-dispatch.test.ts` - stop opening real sessions

- Inject the `spawn` seam on the `soloharness` case at line 285, and on any other construction in
  that file whose dispatch can reach the launch path. Correct the comment at lines 288-290, which
  currently asserts the belief that produced the leak.
- Add a boundary test pinning that a dispatcher constructed without an explicit `spawn` seam cannot
  reach a real backend under the test runner. Put it where the repository already states this kind of
  boundary rather than inventing a new home for it; `test/db-isolation.test.ts` is the precedent for
  the shape, not the location.

## 6. Data, API and migration

None. No schema, no persisted field, no migration, no wire contract, no generated file, no dashboard
surface. `dist/` is untouched except as a build output.

## 7. Tests and verification

Single-file runs use the suite's loader:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/<file>.ts
```

- `test/agent-subprocess-env.test.ts` - the existing end-to-end isolation case at line 127 must keep
  passing. Add a case asserting the wrapper script carries the environment and the agent argv, and
  that the returned argv encodes to a short command. Assert an order of magnitude, not an exact byte
  count.
- `test/herdr-adapter.test.ts` - the Enter is a separate write from the paste; a pane whose foreground
  process never leaves the login shell is a failed launch with the workspace closed; an
  outcome-unknown delivery is **not** rolled back; a successful launch still reports success and still
  tolerates a failed side split.
- `test/herdr-client.test.ts` - one pane's failing `process_info` leaves the other panes reported;
  a protocol below the floor, a pane identity mismatch and a failed snapshot still fail the whole
  call.
- `test/multi-repo-dispatch.test.ts` - unchanged assertions, plus the new boundary test.
- `npm test`, `npm run typecheck`, `npm run lint`.
- `npm run build` and `npm run smoke`, because `isolatedAgentArgv` is on the launch path
  `scripts/smoke-bundles.mjs` exercises.
- No `e2e/` spec: nothing here changes a dashboard surface. If the new failure text lands on a card
  in a form a person reads differently, add one.
- **Manual, and it is the check that matters**: on a machine with Herdr running, dispatch one
  `claude` task and one `pi` task to the Herdr backend and confirm both reach `working`. That is the
  exact thing that failed three times on 2026-09-09. Attach the evidence to the pull request; do not
  commit it.

## 8. Merge and exit criteria

- A Herdr dispatch starts its agent, confirmed manually for both `claude` and `pi`.
- A Herdr launch that does not start reports that fact from the adapter and closes its workspace,
  rather than returning `ok` and surfacing as a 30 s dispatcher timeout.
- `shellCommand(isolatedAgentArgv(...))` is on the order of 90 bytes for a real dispatch.
- One failing pane's `process_info` no longer empties the Herdr pane list.
- Running `npm test` opens no tmux session and no Herdr workspace.
- All checks in section 7 pass, and the pull request records any deviation from this route.

## 9. Downstream handoff

There is no later phase in this plan. What a future change may rely on, and must not undo:

- `isolatedAgentArgv` returns a launchable argv whose command is short, and the disposable state home
  is still released when the agent exits. Do not move cleanup off the agent's exit to shorten it
  further.
- `Multiplexer.list()` returning `[]` means "this backend has no panes". Partial degradation must not
  introduce a third meaning; a genuinely invalid snapshot still returns `[]`.
- `spawnDetached` reporting `ok` now means the agent was observed running, not that bytes were
  accepted. A backend added later should hold itself to the same reading.
- The Pi / Mission MCP work is deliberately absent. The extension plan
  (`fa74e272-3762-4683-8fe8-bf9defe233ea`) owns the `missionMcpRegistered` guard; do not pre-empt it
  here.

## 10. Cross-phase audit record

- **2026-09-09, single-phase audit.** Sized at 115-170 non-test implementation lines, under the
  200-line threshold, so one phase and one task. Confirmed every in-scope source-plan requirement
  (defects 1, 3 and 4) is owned here and nothing is left to an undocumented cleanup. Confirmed defect
  2 appears in no phase, per the amended decision, and that this phase touches neither
  `dispatcher.ts`'s `missionMcpRegistered` guard nor `ask-channel.ts`, which the extension plan will
  own.
- **Contract check.** The two repository-wide contracts named in
  [`phased-plan.md`](phased-plan.md#cross-phase-contracts) are asserted by section 7's test list:
  the state-home release by `agent-subprocess-env.test.ts`, and the meaning of `[]` by
  `herdr-client.test.ts`.
