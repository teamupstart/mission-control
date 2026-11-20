# Work unit id - Phase 2: Flag, launch environment and dashboard row

## Outcome

With the `work-unit-id` preview switched on, every agent Mission Control launches for a
task that has a work unit has `WORK_UNIT_ID` in its environment, so MCP config that references it sends the
`x-work-unit-id` header. The session detail shows the id with a copy control. With the
preview off, no launch carries the variable and the dashboard shows no row.

One change in this phase does not depend on the flag: the resident catalog accepts the work
unit reference and drops it. With the flag on or off, a pinned resident's
launch is no longer refused for a Codex server that carries the reference, a new snapshot
holds no `x-work-unit-id` header for the reference, and a run launched before this phase
stops sending the empty one it holds, from its next start. A non-empty header value an operator
wrote themselves is not the reference, and is still sent as configured (step 9).

## Entry criteria and dependencies

- Phase 1 is merged.

## Scope

- The preview flag and the one function that gates emission.
- `WORK_UNIT_ID` on every launch path, and removal of an inherited value everywhere.
- The "Work unit" row in the session detail, with its browser spec.
- The config guide for MCP server owners.
- The resident catalog accepts the work unit reference and drops it (decision D6).

Not here: telemetry (Phase 3), shaping (Phase 4), any header injection into MCP config
(decision D2), a work unit for resident runs (decision D6).

## Repository findings

- `src/server/agent-trace-context.ts` is the model: a pure module, imported by both SDK
  adapters, that removes inherited variables and sets the launch's own.
- Its users are `harness/claude/sdk.ts` (the `env` built for `query()`, reused by the
  in-session relaunch) and `codexAppServerEnv` in `harness/codex/sdk-deps.ts`.
  `sdk/supervisor.ts` passes `traceContext` in `spec.launch` for a new launch and for a
  restore, and has the task id at both.
- `SdkLaunchOptions` (`harness/types.ts`) carries no task. Pi runs in the daemon's
  process; its tool environment is `toolEnv` in `harness/pi/sdk-deps.ts`.
- Terminal launches: `Dispatcher.dispatch` passes an extra environment to `spawnUniquely`,
  which `isolatedAgentArgv` (`agent-subprocess-env.ts`) writes as `export` lines in a
  wrapper script. The two pipeline hosts are in `dispatchPipeline`. Managed resume builds
  its environment in `harness/resume.ts`. Runtime transfer is
  `session-transfers/coordinator.ts`.
- `agentSubprocessEnv` copies the inherited environment, applies `extraEnv`, then removes
  only state-home and token names.
- `ConsoleDetail.tsx` draws a `dl.detail-sub` of `kv` rows (path, branch), shown when
  `bandHasContent`. `session.task` is a `TaskSummary`, built in `src/server/registry.ts`.
  `useCopyFeedback` in `src/web/lib/clipboard.ts` is the copy helper.
- `e2e/fixtures/fake-claude.mjs` records a fixed list of environment fields per invocation.
  `fake-codex.mjs` records argv and cwd.
- Exact-equality tests on the environment exist: `test/claude-sdk-adapter.test.ts` and
  `test/agent-trace-propagation.test.ts`.
- A pinned resident does not load the operator's MCP config.
  `src/server/residents/mcp-catalog.ts` snapshots it. `parseClaudeServer` expands
  `${VAR:-default}` from the daemon's environment and stores every header as a secret, so
  the line `"x-work-unit-id": "${WORK_UNIT_ID:-}"` becomes an empty header that the
  launcher bridge sends on every call. If the daemon's environment has the variable, the
  server is refused as `inherited`. `parseCodexServer` allows only the fields in
  `CODEX_HTTP_FIELDS`, so a server with `env_http_headers` is unusable: "it uses
  env_http_headers, which residents cannot carry". `resolveResidentMcpSet`
  (`src/server/residents/mcp-launch.ts`) refuses a launch whose inherited or selected set
  includes an unusable server.
- A launch resolves the run's set once and keeps a private copy (`docs/residents.md`, "What
  a run starts"). Every later start or resume reads only that copy:
  `redeemResidentMcpTicket` builds a launcher server's headers from the stored names and
  secret values. So a Claude Code run launched before this phase can hold `x-work-unit-id`
  with an empty value, and would keep sending it. No Codex run can hold a refused server,
  because that launch never started.
- The embedded Codex runtime was checked against a local fixture during planning. Real
  `codex app-server`, started with `-c` overrides and the variable in its process
  environment, sent the header on every request it made at thread start and on the
  `tools/call` of a real turn, and none with the variable unset. What this phase has to pin is Mission Control's half: the variable is in
  the environment of the app-server it spawns.

## Steps

1. **Flag.** In `src/shared/feature-flag-registry.ts` add `WORK_UNIT_ID_FLAG_ID =
   "work-unit-id"`, stage `preview`, label "Work unit id", with a description that says it
   tags a task's sessions with one id so its traces and MCP calls can be found together.
2. **The gate.** In `src/server/work-unit.ts` add `activeWorkUnitId(task)`: the task's id
   when the flag is on and the id is well formed, otherwise null. Everything this plan
   emits goes through it.
3. **The helper.** A pure module beside `agent-trace-context.ts` with
   `withWorkUnit(env, id)`: delete `WORK_UNIT_ID`, then set it when `id` is given.
4. **Never inherit.** `agentSubprocessEnv` removes `WORK_UNIT_ID` from the inherited
   environment before it applies `extraEnv`. That covers terminal launches, resume,
   workflow checks and one-shot model calls, none of which may carry the daemon's own.
5. **Embedded launches.** Add `workUnitId` to `SdkLaunchOptions`. `supervisor.start` and
   the restore path fill it from the task through `activeWorkUnitId`. Apply `withWorkUnit`
   where each adapter applies `withAgentTraceContext`: the Claude adapter, the Codex
   app-server environment, and Pi's `toolEnv`.
6. **Terminal launches.** `Dispatcher.dispatch` adds the variable to the extra environment
   it hands `spawnUniquely`. Do the same for both pipeline hosts, for managed resume from
   the session's task, and for runtime transfer.
7. **Dashboard.** Add `workUnitId` to `TaskSummary`. In `ConsoleDetail`, add a `kv` row:
   term "work unit", the id in `dd.mono`, and a button named "Copy work unit id" that uses
   `useCopyFeedback`. Show it only when `useFeatureFlag(WORK_UNIT_ID_FLAG_ID)` is on and
   the task has an id. `bandHasContent` must count it.
8. **Fakes.** `fake-claude.mjs`, `fake-codex.mjs` and `fake-pi.mjs` record
   `workUnitId: process.env.WORK_UNIT_ID ?? null`.
9. **Resident catalog.** In `src/server/residents/mcp-catalog.ts`, recognize the reference
   with one predicate kept in `src/shared/work-unit.ts`, and drop it. This step is not gated
   by the flag: it keeps the recommended config lines from breaking residents.
   - `parseClaudeServer`: a header named `x-work-unit-id`, compared without case, whose
     whole value is `${WORK_UNIT_ID}` or `${WORK_UNIT_ID:-...}`, is removed before
     expansion. It is not expanded, not stored and not a secret.
   - `parseCodexServer`: `env_http_headers` is accepted when its only entry maps
     `x-work-unit-id` to `WORK_UNIT_ID`, and that entry is removed. Any other entry keeps
     today's refusal.
   - Nothing else about the server changes. For the decision whether the harness may sign
     in to the server itself, a removed reference still counts as a header, as it does
     today.
   - Runs that already exist. `redeemResidentMcpTicket` leaves out a header named
     `x-work-unit-id`, compared without case, whose value is empty, whenever it hands a
     server's headers to a start. The stored copy is not rewritten. So a Claude Code run
     launched before this phase stops sending the empty header at its next start or resume.
     A launcher process that is already running keeps what it redeemed until it restarts.
   - A Codex profile whose launch was refused for the reference needs nothing migrated: no
     run was created. Launching it again resolves the set with the new rule.
   - What the rule covers. Every bullet above is about the reference. A header named
     `x-work-unit-id` with a non-empty value that an operator wrote themselves is not the
     reference, and nothing above removes it. Such a literal is kept in a new snapshot and
     sent, as any configured header is. A non-empty value that an earlier snapshot holds,
     which only an operator's own literal or own default can have produced, is returned as
     stored until the resident is launched again. An empty value is left out at
     redemption whoever wrote it: it carries nothing. Mission Control does not treat an
     operator's value as a work unit: a resident run has none (D6).
   - A custom server's stored definition is not changed.
10. **Docs.** In `docs/work-units.md` add "The launch environment" and "MCP servers the
    worker calls": the four config lines from the plan's section 5, the rule that Claude
    Code needs `${WORK_UNIT_ID:-}` and that a server treats an empty value as absent, and
    the limits: cloud connectors, Pi, and residents, which have no work unit (D6). Say the
    same in `docs/residents.md`, with the existing rule that on Claude Code a server with
    any header is reached through the launcher, which presents no harness login. Name the flag in `docs/feature-flags.md` and the variable
    in `docs/configuration.md`.

## Data, API and compatibility

- No schema change. `TaskSummary.workUnitId` is additive on the event stream.
- The variable is set whether or not telemetry is on: it identifies the work.
- One-shot model calls and workflow check commands get no id. They are not sessions.
- Flag off: `activeWorkUnitId` is null, so no launch gains the variable, and an ordinary
  launch does not differ from today by one byte. The resident catalog rule (step 9) is the
  one difference from today that applies with the flag on or off.
- Turning the flag off affects new launches only. A running agent keeps its environment.
- A resident launch has no variable, because its task has no id. The catalog change only
  removes two effects of the reference: a launch is no longer refused for a Codex server
  that carries it, and a new Claude Code snapshot holds no header for it.
- Upgrade. A snapshot taken before this phase is not rewritten: a pinned run keeps its
  private copy. The empty header such a copy may hold is left out at redemption (step 9),
  so the upgrade takes effect at the run's next start, with no relaunch. There is no
  migration and no schema change.

## Tests and verification

- Unit: `withWorkUnit` sets, replaces and removes; `agentSubprocessEnv` drops an inherited
  value and keeps a launch's own; `activeWorkUnitId` is null with the flag off and for a
  malformed id; the supervisor passes the field on launch and on restore; the Claude, Codex
  and Pi environments carry it; the wrapper script has the `export` line; resume carries
  it. Update the exact-equality tests only for the cases that now carry a value.
- Resident catalog: the Claude Code reference is dropped with the variable set and with it
  unset in the daemon's environment, and the snapshot holds no header for it; a Codex
  server whose `env_http_headers` holds only the reference is available and has no header;
  one with another entry is still unusable, with today's reason; a literal,
  non-empty `x-work-unit-id` value on a Claude Code server or a Codex server is kept in the
  snapshot, as today; a resident launch has no variable.
- Upgrade path, with a snapshot written in the shape a launch before this phase stored (a
  secret header `x-work-unit-id` whose value is empty, beside another secret header):
  redemption returns the other header and no `x-work-unit-id`; the stored copy is unchanged
  afterwards; a non-empty `x-work-unit-id` value in a snapshot is still returned, because
  only an operator's own literal or own default can have produced it (step 9, "What the
  rule covers"). And
  `resolveResidentMcpSet` resolves a Codex profile whose inherited server carries only the
  reference, where the same server with any other `env_http_headers` entry is refused.
- `e2e/specs/work-unit-id.spec.ts`, with the fake agents:
  - flag on, an embedded Claude task, an embedded Codex task and a terminal task: each
    recorded invocation has that task's id, and the ids differ. The embedded Codex case is
    the app-server launch. It shows the variable is in that process's environment, which is
    Mission Control's half. That real Codex then puts it on every MCP request, `tools/call`
    included, was observed with a local fixture during planning;
  - the session detail shows "work unit" with the id, and the copy button reports success;
  - flag off: no row, and the recorded value is null.
  Select by role and label. Add no `data-testid`.
- The row changes the detail band's height, so run `npm run test:electron`.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`,
  `npm run test:e2e`.

## Merge and exit criteria

- Flag on: every launch path for a task-bound session sets `WORK_UNIT_ID` to the task's
  id, and a session with no task has none.
- No child process ever carries a `WORK_UNIT_ID` inherited from the daemon's environment.
- Flag off: no launch has the variable and the session detail is unchanged. The resident
  catalog rule in the last criterion below applies with the flag on or off.
- The row shows and copies the id, covered by the browser spec.
- The guide tells a config owner exactly what to write for each agent.
- A resident launch has no `WORK_UNIT_ID`. For a pinned resident, with the flag on and with
  it off: the reference no longer gets a launch refused; a snapshot taken after this phase
  holds no `x-work-unit-id` header for the reference; and a run launched before this phase
  stops sending the empty `x-work-unit-id` it holds, from its next start. The upgrade-path
  test above covers that last case. A non-empty header value an operator wrote themselves is outside
  this criterion: it is still sent as configured (step 9), and the same tests assert that.

## Handoff

Phases 3 and 4 may rely on `WORK_UNIT_ID_FLAG_ID` and `activeWorkUnitId(task)`. They must
not add a second gate or read the flag another way.

## Cross-phase audit

- Phase 1: this phase adds to `src/server/work-unit.ts` and to `TaskSummary`, and changes
  nothing Phase 1 wrote.
- Phase 3: touches no launch path and no file listed here except `docs/work-units.md`,
  where it adds its own section.
- Phase 4: uses `activeWorkUnitId` at the dispatch seam. The shaper transports set their
  own environment for shaper processes; this phase does not touch them.
- Source plan: owns D2, R5, the environment half of R4 and the catalog half of D6.
- Plan validation repair, round 1: the resident catalog step, the embedded Codex case in
  the browser spec, and the planning-time check of `codex app-server`.
- Plan validation repair, round 2: the outcome, the compatibility notes and the exit
  criteria now say the same thing about the flag being off, and the embedded Codex finding
  records the observed `tools/call`.
- Plan validation repair, round 3: step 9 and the compatibility notes say what happens to a
  resident run launched before this phase, and the tests cover that upgrade path.
- Plan validation repair, round 4: step 9 states what the resident header rule covers. The
  outcome, the tests and the exit criterion state the same two facts about the reference,
  and that a non-empty value an operator wrote themselves is still sent as configured. No behaviour
  changed.
