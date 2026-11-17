# Phase 1: Launch ownership, discovery admission, and the setting

Source plan: [`plan.md`](plan.md). Index: [`phased-plan.md`](phased-plan.md).

## Outcome

By default, the dashboard shows only Claude, Codex, and Pi sessions Mission Control launched,
plus the other terminal sessions the plan's admission rule keeps (`plan.md`, "Design, step 2"),
such as pipeline workers in observed run worktrees. A new checkbox, **Show sessions started outside
Mission Control** under Settings > Setup > Terminals, restores today's behavior. It is off by
default and carries a warning. Hidden sessions cost no pane capture, `gitInfo`, or Codex
rollout `lsof`. One batched `lsof` still reads every agent's working directory, because the
pipeline-worktree rule needs it.

## Entry criteria

- The three plan files under `docs/plans/hide-outside-sessions/` land in the same pull request
  into `teamupstart/mission-control` `main` as this phase.
- No other phase.

## Scope

- Recognizing Mission launch wrappers in the process table.
- Admission in terminal discovery, before annotation.
- The `externalSessions` setting, its storage, and its UI.
- Unit tests, one Playwright spec, and documentation.

## Non-goals

- Hooks, the MCP review channel, telemetry ingest, SDK sessions, and `MISSION_POLL_MS`.
- Any migration: a stored `terminals` blob without the key parses as off for every install.
- Tightening the shared `$TMPDIR` wrapper root across multiple daemons. That is a recorded
  limitation.

## Repository findings this phase relies on

- Launch builders: `isolatedAgentArgv` (`src/server/agent-subprocess-env.ts`) is used by
  `spawnUniquely` (`dispatcher.ts`) and `launchAgentTerminal` (`terminal/targets.ts`). It writes
  `<DISPOSABLE_STATE_ROOT>/session-*/launch-and-cleanup.sh` and returns
  `["/bin/sh", wrapper]`. The wrapper does not `exec`, so it remains the agent's ancestor.
- `prepareTerminalResume` (`src/server/harness/resume.ts`) writes a wrapper that
  `exec`s `[runtime.command, resumeGuardPath(), lease.root, lease.id]`, built by
  `resumeGuardArgv` in the same file, the one owner of that shape. `lease.root` is
  `resumeLeaseRoot(STATE_DIR)`. `src/server/terminal/resume-guard.ts` then `spawn`s the agent as
  a child, so the guard process is the ancestor. `spawnManagedResume` and
  `launchManagedAgentTerminal` both go through `launchPreparedResume` with that argv.
- Ghostty runs the wrapper with `exec -l`, so argv0 may be `-/bin/sh`. `readLaunchProcess`
  already strips that dash.
- `correlate()` computes the synthetic id and cwd before calling `gitInfo`, and `discover()`
  annotates after `correlate()`. `pollOnce(registry, find = discover)` is the injection seam.
- `electron-builder.yml` sets `productName: Agent Mission Control`, so packaged runtime and
  resume-guard paths contain spaces.
- `Registry.mergeDiscovered` calls `ensureWorkEpisode` for every discovered session, outside
  sessions included.
- `Registry.applyDiscovery` evicts every unseen `runtime === "terminal"` session through
  `beginEviction`. `Registry.pipelineLinkFor(cwd)` performs deepest-containment matching against
  observed pipeline runs.

## Implementation steps

1. **Predicate** (`src/server/terminal/launch-process.ts`)
   - Export `DISPOSABLE_STATE_ROOT` from this file, and have `agent-subprocess-env.ts` import it
     from here to write the wrapper. Do not re-derive it.
   - Add `isMissionLaunchProcess(proc: Proc): boolean`. It accepts exactly:
     - `/bin/sh <DISPOSABLE_STATE_ROOT>/session-<one segment>/launch-and-cleanup.sh`, with
       an optional leading `-` on argv0.
     - a command string ending in ` <resumeGuardPath()> <resumeLeaseRoot(STATE_DIR)> <lease id>`,
       where the lease id is one space-free token. Never split the command on whitespace:
       the packaged app is `Agent Mission Control.app`, so the runtime and guard paths contain
       spaces.
   - Add `hasMissionLaunchAncestor(pid, procs)`. It walks `ppid` from the agent process, with
     cycle protection the same way `belongsToLaunch` does, and returns true at the first
     matching ancestor.
   - Keep the module browser-free and cheap. It runs for every grouped agent on every sweep.
2. **Discovery** (`src/server/discovery/correlate.ts`, `poller.ts`)
   - Add `missionLaunched: boolean` to `DiscoveredSession`.
   - `correlate(input, procCwds, admit?)`: after computing `syntheticId`, `cwd`, and
     `missionLaunched`, and before `gitInfo`, skip the session when
     `admit && !admit({ syntheticId, cwd, missionLaunched, agent })`.
   - `discover(admit?)` forwards `admit` to `correlate`, so annotation only sees admitted
     sessions.
   - `pollOnce` takes `{ admit, hiddenCwds }` from `registry.discoveryAdmission()`, calls
     `find(admit)`, and hands `hiddenCwds` to that same sweep's `applyDiscovery`. Keep the
     `find` injection for tests.
3. **Registry** (`src/server/registry.ts`)
   - Add `discoveryAdmission(): DiscoveryAdmission`. Its `admit` is `undefined` (admit all)
     when `getTerminalsConfig().externalSessions` is true. Otherwise `admit` implements the
     four-case admission rule in `plan.md` ("Design, step 2"), which owns it:
     Mission-launched, task-bound or dispatch-invited, in a pipeline worktree, or owed a task
     session closure. The closure case is a safety requirement: without it a finished task's
     teardown target is dropped while its process runs.
   - Read config once per call. Do not add an eviction path. The unseen loop already evicts
     what was not admitted.
4. **Setting** (`src/shared/protocol.ts`, `src/shared/app-config-entries.ts`,
   `src/server/terminals-config.ts`)
   - `TerminalsConfigSchema` gains `externalSessions: z.boolean().default(false)`.
     `TerminalsConfigPatchSchema` gains an optional boolean. Keep both `.strict()` and
     empty-patch refusals.
   - `terminalsFields` gains `externalSessions: "setting"`.
   - `mergeTerminalsPatch` (web) and `setTerminalsConfig` (server) carry the boolean.
   - Widen the schema's doc comment from "what a multiplexer's sessions open in" to "terminal
     settings".
5. **UI** (`src/web/components/SetupPanel.tsx`, `src/web/styles.css` only if needed)
   - In the Terminals family, add a labelled checkbox, **Show sessions started outside Mission
     Control**, bound through `useTerminalsConfig().update({ externalSessions })`.
   - Below it, always visible, show this text:
     "Off by default. When on, Mission Control also shows Claude, Codex, and Pi sessions you
     started yourself in a terminal. This works poorly on some setups: cards can show the wrong
     state, name, or pane, and sending to them can fail. Sessions Mission Control starts are
     always shown."
   - No `data-testid`. No em dash in copy.
6. **Docs**
   - `docs/sessions.md` "How it works": the passive discovery row and sweep paragraph.
   - `docs/overview.md`: the "Discovers" bullet.
   - `docs/harnesses-and-terminals.md` and `docs/skills-and-settings.md`: the setting.
   - `docs/configuration.md`: a note beside `MISSION_POLL_MS` explaining the difference.

## Compatibility

- There is no persisted schema change outside the `terminals` JSON blob. Old blobs and old
  settings snapshots parse with `externalSessions: false`.
- Upgrading hides outside sessions on the first sweep through the normal eviction lifecycle.
  This is the adopted decision.
- Mission terminal sessions that survive a daemon restart are still admitted, because ancestry
  is read from the live process table.

## Tests and verification

Add focused tests in `test/`, run with
`node --test --import ./test/setup-state.mjs --import tsx <file>`:

- Launch-path coverage: build argv through `isolatedAgentArgv` and `prepareTerminalResume` (or the
  smallest real builder seam that produces the guard argv), synthesize the process chain, and
  assert recognition, including the `-/bin/sh` form and a resume whose runtime and guard paths
  contain spaces.
- Negatives: a hand-started agent, a wrapper outside the disposable root, a look-alike script
  path, and a guard with a foreign lease root.
- Admission: with the setting off, Mission-launched, task-bound, and pipeline-worktree sessions
  are admitted, while an outside session (including one that already has a work episode) and a session in the repository root beside a run
  worktree are not. With the setting on, all are admitted. Hidden sessions do not reach the
  annotation seams.
- Invite-only admission: with the setting off, a session that is not Mission-launched, not any
  task's `sessionId`, and not in a pipeline worktree, but holds a `"dispatch"` Foreman invite, is
  admitted. The same session without the invite is not.
- Eviction: switching the setting off evicts an existing outside card via `beginEviction` and
  emits `session_remove`.
- Config: the default is off, a patch round-trips, an empty patch is refused, and a snapshot
  without the key restores as off.
- Dispatch: `waitForSessionAtCwd` resolves for a Mission-launched session when the setting is off.

Add `e2e/specs/external-sessions-setting.spec.ts`. It covers the toggle and its effect on the
Board:

- With discovery off, as every spec runs by default: the checkbox is unchecked on a fresh home,
  the warning is visible, and checking and unchecking each persist across a reload.
- With discovery on for that test's daemon (`MISSION_POLL_MS=400`): two real tmux panes run a
  fake `claude`, one beneath a Mission launch wrapper and one started directly. With the
  setting off only the Mission launch has a Board card; with it on, both do. The test skips
  itself where tmux is not installed.

Then run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`, and
`npm run test:e2e`.

## Merge and exit criteria

- All of the tests above pass, and CI is green.
- On a real machine with the setting off, a hand-started agent in tmux has no card, and a
  dispatched terminal task does. With it on, both have cards.
- The docs listed above match the behavior.

## Downstream handoff

Later work may rely on these:

- `isMissionLaunchProcess` / `hasMissionLaunchAncestor` as the one recognizer of Mission
  launches.
- `DiscoveredSession.missionLaunched`.
- `TerminalsConfig.externalSessions`.

A new terminal launch path must go through `isolatedAgentArgv` or `prepareTerminalResume`, or extend the
predicate together with its launch-path test.

## Cross-phase audit record

- Single-phase plan. This phase implements every source-plan requirement and both adopted
  decisions (off for all installs; pipeline workers visible), and no other phase consumes or
  changes these contracts. The admission rule itself is defined once, in `plan.md` ("Design,
  step 2"); this brief points to it rather than restating it.
- Revision 4: dropped the work-episode admission signal, switched the resume-guard match to a
  full-string comparison, and unified the helper name `hasMissionLaunchAncestor` with the
  root plan.
- Revision 5: added the invite-only admission test, and changed the entry criterion from a
  planning PR merge to the plan files resolving on `origin/main`, matching how the plan was
  actually published.
- Revision 6: entry criteria now state the manual start and that upstream publication is a
  human-opened PR from the fork, not a precondition.
- Revision 7: entry criteria now state that the plan files and this phase land upstream in one
  pull request. The fork-as-`origin` arrangement is retired.
- Revision 8: the Registry step points to the plan's admission rule, which now has a fourth
  case (owed task session closure), instead of restating three cases. The `pollOnce` and
  `discoveryAdmission` shapes match the code after upstream review.
