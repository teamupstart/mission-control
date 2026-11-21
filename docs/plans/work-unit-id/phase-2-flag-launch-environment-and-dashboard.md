# Work unit id - Phase 2: Flag, launch environment and dashboard row

## Outcome

With the `work-unit-id` preview on when an agent is started, every agent Mission Control
launches for a task that has a work unit has `WORK_UNIT_ID` in its environment, so MCP
config that references it sends the `x-work-unit-id` header. Mission Control records, per
session, the work unit its agent was started with, and everything else it emits follows
that record. The session detail shows the id a session emits, with a copy control. With the
preview off when an agent is started, the launch carries no variable. While the preview is
off the dashboard shows no row.

Two things follow from the record. A switch of the preview takes effect at an agent's next
start, so the spans and the MCP calls of one agent never disagree. And an agent that was
started with one work unit is not handed a task of another (decision D7).

The phase starts with a check: does a server that Claude Code signs in to with OAuth keep
its sign-in when the header is added (decision D8)? The config guide is written from the
result.

Two changes in this phase do not depend on the flag. The reuse guard is one. The other is
that the resident catalog accepts the work unit reference and drops it. With the flag on or
off, a pinned resident's launch is no longer refused for a Codex server that carries the
reference, a new snapshot holds no `x-work-unit-id` header for the reference, and a run
launched before this phase stops sending the empty one it holds, from its next start. A
non-empty header value an operator wrote themselves is not the reference, and is still sent
as configured (the resident catalog step).

## Entry criteria and dependencies

- Phase 1 is merged.

## Scope

- The OAuth check, before anything else (decision D8).
- The preview flag and the one function that reads it.
- `WORK_UNIT_ID` on every launch path, and removal of an inherited value everywhere.
- The launch record: the work unit each agent was started with, and the one function that
  reads it.
- The reuse guard in `assign` and in the backlog's own selection (decision D7).
- The "Work unit" row in the session detail, with its browser spec.
- The config guide for MCP server owners.
- The resident catalog accepts the work unit reference and drops it (decision D6).

Not here: telemetry (Phase 3), shaping (Phase 4), any header injection into MCP config
(decision D2), a work unit for resident runs (decision D6), restarting a reused agent so
that it can take another work unit's task (decision D7).

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
- A terminal agent starts through a wrapper script, `launchAndCleanupScript` in
  `agent-subprocess-env.ts`. It runs inside the pane, "after a long-lived terminal server
  contributes its own inherited environment". The script unsets only the state-home names
  and then exports what the launch built. So a variable the launch leaves out is not
  removed from the pane: an agent can still see the value the terminal server had.
- Reused agents. `TaskManager.assign` (`src/server/tasks.ts`) hands a backlog task to an
  agent that is already running, after a reset: "An agent may take SEVERAL tasks over its
  life, one after another". `agentIsFree` is the same choice when the backlog makes it. No
  process starts, so the agent keeps the environment of its launch. A variable set for one
  task would be sent on the MCP calls of the next.
- What a launch delivered. `Registry.recordStandingInstructions` (`src/server/registry.ts`)
  is the model for a per-session record of something a launch installed on the process.
  `dispatcher.ts` and `sdk/supervisor.ts` call it when they compose a launch. The row is
  keyed by `noteKeyFor(session)`, replaced whole by a later launch, loaded at daemon start,
  and carried across every note-key rotation by `moveStandingInstructionsKey`, because a
  `/clear` "starts a new conversation but does not end the PROCESS".
- Flags are live. `docs/feature-flags.md`, "Writes and live gates": `featureEnabled(id)` is
  checked "for each new operation", and "Each feature documents what it does with work
  already in flight".
- A launched session is announced early. `noteDispatchLaunch`
  (`src/server/telemetry/sessions.ts`) records a launch intent before the spawn, "because
  the session appears - and is announced - before the dispatcher gets control back".
  Anything that has to be known when a launched session is first announced needs the same
  ordering.
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
- Resident sign-in. `parseClaudeServer` sets `harnessLogin` only for a server with no
  header, no secret query value and a URL that carries no credential of its own. Such a
  server is handed to the harness as configured, so Claude Code uses its own sign-in. Any
  other server is reached through the launcher, which presents no sign-in. The function's
  comment says why the entry must match: the stored login "is keyed by the name and by the
  type, URL and headers exactly as configured".
- Claude Code and OAuth, read in the program text of Claude Code 2.1.329 and not run. A
  server's sign-in is stored under its name and a hash of its `type`, `url` and `headers`.
  The `${...}` references in a header are filled in when the config is loaded, before that
  hash. Several sign-in decisions also treat a server with any header differently from a
  headerless one. So a header whose value differs per work unit is expected to give each
  work unit its own, empty sign-in, and a headerless entry is expected to find the sign-in
  that was made before a header was added.
- A launch resolves the run's set once and keeps a private copy (`docs/residents.md`, "What
  a run starts"). Every later start or resume reads only that copy:
  `redeemResidentMcpTicket` builds a launcher server's headers from the stored names and
  secret values. So a Claude Code run launched before this phase can hold `x-work-unit-id`
  with an empty value, and would keep sending it. No Codex run can hold a refused server,
  because that launch never started.
- The embedded Codex runtime was checked against a local fixture during planning. Real
  `codex app-server`, started with `-c` overrides and the variable in its process
  environment, sent the header on every request it made at thread start and on the
  `tools/call` of a real turn, and none with the variable unset. What this phase has to pin
  is Mission Control's half: the variable is in the environment of the app-server it
  spawns.

## Steps

1. **OAuth check, first (decision D8).** Before the guide is written, find out what happens
   to a server's OAuth sign-in when the reference is added.
   - Build a local OAuth fixture on loopback: an MCP server that requires a sign-in, with
     its authorization server metadata, client registration and token endpoint. Its tokens
     mean nothing outside the fixture.
   - Run Claude Code against it under a config directory made for the check
     (`CLAUDE_CONFIG_DIR`), never the operator's. First confirm that this directory has its
     own credential store. If the fixture's sign-in would be written beside the operator's
     real ones, stop and report that instead of signing in. The check then has no answers.
   - Never read, copy, export or pass a real credential. The fixture logs header names, and
     values only for `x-work-unit-id`.
   - Answer three questions, each with what the fixture received:
     1. With the header written `${WORK_UNIT_ID:-}`, sign in with one value of the
        variable. Does a launch with another value find that sign-in?
     2. Sign in with no header configured, then add the header. Does a headerless entry
        still find the first sign-in? The resident catalog step relies on this.
     3. If the first answer is no: does a header supplied through `headersHelper` carry the
        id and keep the sign-in? The program text does not put `headersHelper` in the key.
   - Ask the first question of Codex too, with `env_http_headers`.
   - Record the versions, the method and the answers in `docs/work-units.md` and in the pull
     request. Remove the fixture and the config directory, and check that the operator's
     Claude Code and Codex configuration is unchanged.
   - What the result decides. No answer blocks this phase: each one decides what the guide
     and `docs/residents.md` say.
     - The first answer, for Claude Code. If a second work unit finds the sign-in, the
       guide recommends the Claude Code reference for every remote server. If it does not,
       the guide tells an owner not to add it to a server that Claude Code signs in to with
       OAuth, names the alternative if the third question found one, and says that a
       worker's calls to such a server carry no work unit.
     - The first answer, for Codex. It is decided on its own: one agent's answer says
       nothing about the other's config line. If a second work unit finds Codex's sign-in,
       the guide recommends `env_http_headers` for every remote Codex server. If it does
       not, the guide tells an owner not to add that entry to a server that Codex signs in
       to with OAuth, and says that a Codex worker's calls to such a server carry no work
       unit.
     - The second answer. If a headerless entry finds the earlier sign-in, the guide says a
       pinned resident keeps it. If it does not, the resident catalog step ships as written
       all the same: the launcher presents no sign-in at all, so handing the server to the
       harness cannot be worse. The guide and `docs/residents.md` then say that a pinned
       resident loses that server's sign-in once the reference is added, and that an owner
       should leave the reference off a server a pinned resident signs in to.
     - No answers. If the check stopped because it could not keep its sign-in apart from
       real ones, that does not block the phase either. Every answer is recorded as not
       verified. The guide takes the cautious branch for both agents: it tells an owner
       not to add the reference to a server that signs in with OAuth. `docs/residents.md`
       says that a pinned resident's sign-in after the reference is added is not verified.
2. **Flag.** In `src/shared/feature-flag-registry.ts` add `WORK_UNIT_ID_FLAG_ID =
   "work-unit-id"`, stage `preview`, label "Work unit id", with a description that says it
   tags a task's sessions with one id so its traces and MCP calls can be found together.
3. **The decision.** In `src/server/work-unit.ts` add `launchWorkUnitId(task)`: the task's
   id when the flag is on and the id is well formed, otherwise null. Call it once per
   launch, where the launch begins: the start of a dispatch, a resume, a restore or a
   transfer. An older task has been given its id, and the id has been saved, before that
   point (Phase 1), so its first dispatch decides with the id it has just received. Carry
   that one value through the launch and hand it to everything the launch
   does: the shaping run a dispatch starts (Phase 4), the agent's environment, both hosts
   of a pipeline dispatch, and the launch record when the launch succeeds. Nothing calls it
   a second time for the same launch, so a switch of the flag while a launch is in flight
   cannot give its parts different answers. No other server code in this plan reads the
   flag.
4. **The helper.** A pure module beside `agent-trace-context.ts` with
   `withWorkUnit(env, id)`: delete `WORK_UNIT_ID`, then set it when `id` is given.
5. **Never inherit.** `agentSubprocessEnv` removes `WORK_UNIT_ID` from the inherited
   environment before it applies `extraEnv`. That covers every process the daemon spawns
   itself: embedded agents, workflow checks and one-shot model calls. None of them may
   carry the daemon's own. An agent that starts inside a pane needs more, because the pane
   already has the terminal server's environment. The wrapper script unsets `WORK_UNIT_ID`
   with the state-home names, before its `export` lines. The launch's decision is then the
   only source of the variable: set when the launch carries a work unit, absent when it
   does not. This holds wherever a terminal launch, a managed resume or a runtime transfer
   starts an agent in a pane.
6. **Embedded launches.** Add `workUnitId` to `SdkLaunchOptions`. `supervisor.start` and
   the restore path fill it with the launch's decision (step 3). Apply `withWorkUnit`
   where each adapter applies `withAgentTraceContext`: the Claude adapter, the Codex
   app-server environment, and Pi's `toolEnv`. The Claude adapter's in-session relaunch
   reuses the environment of its launch, so it carries the same value and is not a new
   decision.
7. **Terminal launches.** `Dispatcher.dispatch` adds the variable, from the launch's
   decision (step 3), to the extra environment it hands `spawnUniquely`. Do the same for
   both pipeline hosts, for managed resume from the session's task, and for runtime
   transfer.
8. **The launch record.** Record, per session, the work unit its agent was started with.
   - Storage: a table of its own, one row per session whose agent carries a work unit,
     keyed by the session's note key (`noteKeyFor`), with the id and the time. Keep it next
     to its upgrade path in `src/server/db.ts`, and take the next free schema number.
   - Follow `Registry.recordStandingInstructions` for the shape of the record, and not for
     its timing. `dispatcher.ts` and `sdk/supervisor.ts` call it once they have the launched
     session back, which is after the session was first announced. The launch record has to
     be there sooner. The launch hands the registry its decision before it starts the
     agent, and the registry installs the record in the step that registers the launched
     session, before that step publishes the session's first event. The value is the one
     the launch's environment was built from.
   - A pipeline host and a runtime transfer's target are launched sessions like any other:
     their record is installed before their first event. A resume and a restore keep their
     session, so their record is replaced in the step that adopts the new process, before
     the next event for that session is published.
   - Load the rows at daemon start. Carry a row across every note-key rotation, at the
     sites that call `moveStandingInstructionsKey`. A `/clear` or an assign starts a new
     conversation and not a new process, so the row has to survive both.
   - The record changes only when the new process has taken over the session. A launch
     that succeeds replaces the row, or removes it when the launch carries no work unit, so
     a resume after the flag is switched off leaves nothing behind. A launch that fails
     changes nothing: the agent that is still running keeps the record it was started with,
     whatever the failed launch decided. A decision that was handed over for a launch that
     then fails is discarded, and one whose session never appears is swept by age, as a
     launch intent is. A runtime transfer leaves the source's record alone, and a target
     that is discarded takes its record with it. Prune rows as the standing instructions
     snapshot is pruned.
   - Add two readers to `src/server/work-unit.ts`. `launchWorkUnitFor(session)` is the
     recorded id, or null: what the session's agent carries. `sessionWorkUnitId(session,
     task)` is that id when the task's `workUnitId` is the same, otherwise null. A reader
     with a task in hand uses the second: the dashboard row here, and the shaping seam in
     Phase 4 when a task goes to an agent that is already running. Capture in Phase 3 uses
     the first, because a span belongs to its session, and the reuse guard keeps every task
     a session runs in that one work unit.
   - A session that was running before this phase has no row, so it emits nothing until
     its next start.
9. **Reuse guard (decision D7).** An agent that was started with one work unit must not run
   a task of another, because its MCP calls would carry the first.
   - `TaskManager.assign` refuses an agent whose record holds a work unit other than the
     task's. The refusal sits with the other session-scoped refusals, before the reset, and
     says: "that agent was started for another work unit, so its MCP calls would be tagged
     with it". An older task has been given its id by then (Phase 1), so the comparison is
     between the record and the task's id.
   - `agentIsFree`, the backlog's own selection, does not offer such an agent for that
     task. The backlog then treats it as it treats any agent that is not free.
   - An agent with no record takes any task. That task emits nothing until the agent's
     next start, because `sessionWorkUnitId` is null.
   - An agent whose record holds the task's own work unit takes it, and the task emits it.
     A plan's phase tasks handed to one agent are this case.
   - The guard does not read the flag. It protects against an environment that is already
     set, so it has to hold after the flag is switched off too. With the flag never
     switched on there is no record, and the guard never refuses.
10. **Dashboard.** Add `workUnitId` to `TaskSummary`, filled in `src/server/registry.ts`
    with `sessionWorkUnitId(session, task)`: the id this session emits, otherwise null. In
    `ConsoleDetail`, add a `kv` row: term "work unit", the id in `dd.mono`, and a button
    named "Copy work unit id" that uses `useCopyFeedback`. Show it only when
    `useFeatureFlag(WORK_UNIT_ID_FLAG_ID)` is on and the value is set. `bandHasContent`
    must count it.
11. **Fakes.** `fake-claude.mjs`, `fake-codex.mjs` and `fake-pi.mjs` record
    `workUnitId: process.env.WORK_UNIT_ID ?? null`.
12. **Resident catalog.** In `src/server/residents/mcp-catalog.ts`, recognize the reference
    with one predicate kept in `src/shared/work-unit.ts`, and drop it. This step is not
    gated by the flag: it keeps the recommended config lines from breaking residents.
    - `parseClaudeServer`: a header named `x-work-unit-id`, compared without case, whose
      whole value is `${WORK_UNIT_ID}` or `${WORK_UNIT_ID:-...}`, is removed before
      expansion. It is not expanded, not stored and not a secret.
    - `parseCodexServer`: `env_http_headers` is accepted when its only entry maps
      `x-work-unit-id` to `WORK_UNIT_ID`, and that entry is removed. Any other entry keeps
      today's refusal.
    - Sign-in. Nothing else about the server changes, and the decision whether the harness
      may sign in to the server itself is made on the headers that remain. A server whose
      only header was the reference is headerless again. If it qualifies otherwise it
      keeps `harnessLogin`, and the harness is handed the entry it had before the reference
      was added, so it looks up the same sign-in. A server with the reference and another
      header stays on the launcher, as today.
    - Runs that already exist. `redeemResidentMcpTicket` leaves out a header named
      `x-work-unit-id`, compared without case, whose value is empty, whenever it hands a
      server's headers to a start. The stored copy is not rewritten. So a Claude Code run
      launched before this phase stops sending the empty header at its next start or
      resume. A launcher process that is already running keeps what it redeemed until it
      restarts. Such a run also keeps its pinned route: a server it reaches through the
      launcher because of the reference stays there until the resident is launched again.
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
13. **Docs.**
    - `docs/work-units.md`, "The launch environment": what a session emits, when a switch
      of the preview takes effect, and when assign refuses an agent.
    - `docs/work-units.md`, "MCP servers the worker calls": the config lines the OAuth
      check supports, the rule that Claude Code needs `${WORK_UNIT_ID:-}` and that a server
      treats an empty value as absent, what the check found, for each agent, for a server
      that signs in with OAuth, and the limits: cloud connectors, Pi, and residents, which have no work unit
      (D6).
    - `docs/residents.md`: the same limits, and the sign-in rule from the resident catalog
      step.
    - `docs/dispatch-and-backlog.md`: when assign refuses an agent, and why.
    - `docs/feature-flags.md`: the flag, and what it does with work already in flight.
    - `docs/configuration.md`: the variable.

## Data, API and compatibility

- One new table, for the launch record. No change to `tasks`. `TaskSummary.workUnitId` is
  additive on the event stream.
- The variable is set whether or not telemetry is on: it identifies the work.
- One-shot model calls and workflow check commands get no id. They are not sessions.
- Flag off when an agent is started: `launchWorkUnitId` is null, so the launch gains no
  variable and no record, and an ordinary launch does not differ from today by one byte.
  The resident catalog rule and the reuse guard are the two differences from today that
  apply with the flag on or off. With the flag never switched on there is no record, so the
  guard never refuses.
- Work in flight. A switch of the flag affects agents started afterwards. An agent that is
  running keeps its environment and its record, so its session keeps emitting, or keeps
  not emitting, until its next start. A resume, a restore and a transfer are starts. A
  start that fails changes neither the environment nor the record.
- A resident launch has no variable, because its task has no id. The catalog change only
  removes two effects of the reference: a launch is no longer refused for a Codex server
  that carries it, and a new Claude Code snapshot holds no header for it.
- An agent Mission Control did not start has no record, so nothing Mission Control emits
  for it carries a work unit. Mission Control cannot see that agent's environment: a
  `WORK_UNIT_ID` an operator exported in their own shell is theirs.
- Upgrade. The new table starts empty: a session that was running before this phase has no
  record and emits nothing until its next start. A resident snapshot taken before this
  phase is not rewritten: a pinned run keeps its private copy. The empty header such a copy
  may hold is left out at redemption (the resident catalog step), so that part takes effect
  at the run's next start, with no relaunch. No existing row is migrated.

## Tests and verification

- The OAuth check's method and answers, or the reason it could not run, are in
  `docs/work-units.md` and in the pull request.
- Unit: `withWorkUnit` sets, replaces and removes; `agentSubprocessEnv` drops an inherited
  value and keeps a launch's own; `launchWorkUnitId` is null with the flag off and for a
  malformed id; the supervisor passes the field on launch and on restore; the Claude, Codex
  and Pi environments carry it; the wrapper script has the `export` line; resume carries
  it. Update the exact-equality tests only for the cases that now carry a value.
- The wrapper script, run in a shell that already has `WORK_UNIT_ID` set: with a launch
  that carries none, the agent's environment has none; with a launch that carries an id,
  it has the launch's and not the shell's.
- Launch record: a launch writes the row and a later launch replaces it; a launch that
  carries none removes it; the row survives a `/clear`, an assign and every note-key
  rotation the standing instructions snapshot survives; rows load at daemon start;
  `sessionWorkUnitId` is the id only while the task has that id.
- The first event: when a launched session's first event is published, its record is
  already installed and equals the `WORK_UNIT_ID` the agent was started with. This holds
  for a dispatch, a pipeline host and a runtime transfer target. A decision handed over for
  a launch that fails leaves no record.
- An older row: the first dispatch of a task that had no id, with the flag on, gives the
  task its id and carries it. The agent's environment and the record hold that id.
- A launch that fails: a resume, a restore and a transfer that fail after the flag is
  switched off leave the row of the agent that is still running as it was, and `assign`
  still refuses another work unit's task for that agent. A transfer that succeeds writes
  the target's row and leaves the source's alone.
- A switch in flight, in process: an agent started with the flag on keeps the variable and
  its `sessionWorkUnitId` after the flag is switched off, and loses both at its next start;
  one started with the flag off has neither after the flag is switched on, and gains both
  at its next start.
- A switch while a launch is in flight: the flag is switched after the launch's decision
  and before the agent starts, in each direction. The agent's environment and its record
  hold the value decided at the start, and `launchWorkUnitId` was called once.
- Reuse guard: `assign` refuses an agent whose record holds another work unit, with the
  flag on and with it off; it accepts an agent with no record and one whose record holds
  the task's own work unit; `agentIsFree` does not offer the first for that task; a task on
  an agent with no record has a null `sessionWorkUnitId`.
- Resident catalog: the Claude Code reference is dropped with the variable set and with it
  unset in the daemon's environment, and the snapshot holds no header for it; a Claude Code
  server whose only header is the reference keeps `harnessLogin`, and one with the
  reference and another header stays on the launcher; a Codex server whose
  `env_http_headers` holds only the reference is available and has no header; one with
  another entry is still unusable, with today's reason; a literal, non-empty
  `x-work-unit-id` value on a Claude Code server or a Codex server is kept in the snapshot,
  as today; a resident launch has no variable.
- Upgrade path, with a snapshot written in the shape a launch before this phase stored (a
  secret header `x-work-unit-id` whose value is empty, beside another secret header):
  redemption returns the other header and no `x-work-unit-id`; the stored copy is unchanged
  afterwards; a non-empty `x-work-unit-id` value in a snapshot is still returned, because
  only an operator's own literal or own default can have produced it (the resident catalog
  step, "What the rule covers"). And `resolveResidentMcpSet` resolves a Codex profile whose
  inherited server carries only the reference, where the same server with any other
  `env_http_headers` entry is refused.
- `e2e/specs/work-unit-id.spec.ts`, with the fake agents:
  - flag on, an embedded Claude task, an embedded Codex task and a terminal task: each
    recorded invocation has that task's id, and the ids differ. The embedded Codex case is
    the app-server launch. It shows the variable is in that process's environment, which is
    Mission Control's half. That real Codex then puts it on every MCP request, `tools/call`
    included, was observed with a local fixture during planning;
  - the session detail shows "work unit" with the id, and the copy button reports success;
  - flag off: no row, and the recorded value is null;
  - flag on: a task dropped on an idle agent that was started for another work unit is
    refused, and the board shows the reason.
  Select by role and label. Add no `data-testid`.
- The row changes the detail band's height, so run `npm run test:electron`.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`,
  `npm run test:e2e`.

## Merge and exit criteria

- The OAuth check ran, or stopped because it could not keep its sign-in apart from real
  ones. Its answers, or that they are not verified, are recorded, and the guide and
  `docs/residents.md` follow them. Neither outcome blocks this phase.
- Flag on when an agent is started: every launch path for a task-bound session sets
  `WORK_UNIT_ID` to the task's id and, once the launch has succeeded, records it. A
  session with no task has none.
- One launch has one decision. Its agent's environment and its record never differ, also
  when the flag is switched while the launch is in flight.
- The launch record is installed before a launched session's first event is published.
- An older task's first dispatch carries the id it has just been given.
- No agent ever carries a `WORK_UNIT_ID` it inherited: not from the daemon's environment,
  and not from the terminal server its pane runs in.
- Flag off when an agent is started: the launch has no variable and no record. While the
  flag is off the session detail is unchanged. The resident catalog rule in the last
  criterion below, and the reuse guard, apply with the flag on or off.
- A switch of the flag takes effect at each agent's next start. Until then the agent's
  environment and `sessionWorkUnitId` agree, also when a replacement launch fails.
- An agent that was started with one work unit is never handed a task of another.
- The row shows and copies the id the session emits, covered by the browser spec.
- The guide tells a config owner exactly what to write for each agent, and what not to.
- A resident launch has no `WORK_UNIT_ID`. For a pinned resident, with the flag on and with
  it off: the reference no longer gets a launch refused; a snapshot taken after this phase
  holds no `x-work-unit-id` header for the reference; a Claude Code server whose only
  header is the reference is handed to the harness headerless, with `harnessLogin`, as it
  was before the reference was added; and a run launched before this phase
  stops sending the empty `x-work-unit-id` it holds, from its next start. The upgrade-path
  test above covers that last case. A non-empty header value an operator wrote themselves
  is outside this criterion: it is still sent as configured (the resident catalog step),
  and the same tests assert that.

## Handoff

Phases 3 and 4 may rely on `WORK_UNIT_ID_FLAG_ID`, on the one decision a launch carries,
and on the two readers of the launch record, `launchWorkUnitFor(session)` and
`sessionWorkUnitId(session, task)`. They must not read the flag, must not call
`launchWorkUnitId` themselves, and must not emit a work unit for a session whose launch
record does not hold it.

## Cross-phase audit

- Phase 1: this phase adds to `src/server/work-unit.ts` and to `TaskSummary`, and changes
  nothing Phase 1 wrote. The reuse guard compares against `Task.workUnitId`, which Phase 1
  sets when a task is assigned as well as when it is dispatched.
- Phase 3: changes nothing a launch does. It reads the launch record and never writes
  it, and it shares no file listed here except `docs/work-units.md`, where it adds its own
  section.
- Phase 4: takes the launch's one decision at the dispatch seam for a new agent, and
  `sessionWorkUnitId` for an agent that is already running. The shaper transports set their
  own environment for shaper processes; this phase does not touch them.
- Source plan: owns D2, D7, D8, R5, the environment half of R4 and the catalog half of D6.
- Plan validation repair, round 1: the resident catalog step, the embedded Codex case in
  the browser spec, and the planning-time check of `codex app-server`.
- Plan validation repair, round 2: the outcome, the compatibility notes and the exit
  criteria now say the same thing about the flag being off, and the embedded Codex finding
  records the observed `tools/call`.
- Plan validation repair, round 3: the resident catalog step and the compatibility notes
  say what happens to a resident run launched before this phase, and the tests cover that
  upgrade path.
- Plan validation repair, round 4: the resident catalog step states what the resident
  header rule covers. The outcome, the tests and the exit criterion state the same two
  facts about the reference, and that a non-empty value an operator wrote themselves is
  still sent as configured. No behaviour changed.
- Inspector review of the plan's pull request: emission follows a record of what each
  agent was started with, so a switch of the flag or a reused agent cannot split spans from
  MCP calls (D7). The resident sign-in decision is made on the headers that remain. The
  phase starts with the OAuth check (D8). The steps were renumbered; other files name them
  instead of numbering them.
- Inspector review, round 2: the launch record changes only when a launch succeeds, so a
  failed replacement cannot leave it out of step with the agent that is still running.
- Inspector review, round 3: one launch has one decision, computed once and shared by its
  shaping run, its agent's environment and its record. No answer of the OAuth check blocks
  the phase, and the resident exit criterion names the routing this phase controls.
- Inspector review, round 4: the registry installs the launch record before it publishes a
  launched session's first event, so no reader of that event finds the session without it.
- Inspector review, round 5: an older task has its id before the launch decision reads it.
  A pipeline host and a transfer target get their record before their first event. The
  OAuth check's guidance is decided for Claude Code and for Codex separately.
- Inspector review, round 6: the script that starts an agent in a pane unsets the variable
  before it applies the launch's decision. The launch record has a reader that needs no
  task, for capture. An OAuth check that cannot run does not block the phase.
