# Work units

A work unit is one piece of work, which can span several tasks and sessions. Mission Control
gives it one id, `workUnitId`, stored on each of its tasks. A plan task and the phase tasks
its session creates share one, so one query on that id can later find everything the work
did.

The plan behind this is [`docs/plans/work-unit-id/plan.md`](plans/work-unit-id/plan.md).

## What a work unit is

- **The id.** `wu_` followed by a [ULID](https://github.com/ulid/spec): 48 bits of
  millisecond time and 80 random bits in Crockford base32, 26 characters. It always matches
  `^wu_[0-9A-HJKMNP-TV-Z]{26}$`. The id is opaque. It is not a credential and is never
  redacted, but it does embed the time it was minted.
- **Where it lives.** `tasks.work_unit_id`, read as `Task.workUnitId`. The format, the check
  (`isWorkUnitId`) and the names it travels under are defined once, in
  `src/shared/work-unit.ts`. A new id is minted by `mintWorkUnitId` in
  `src/server/work-unit.ts`, and only `TaskManager` calls it.
- **Written once.** No write changes an id once a task has one. The database enforces it:
  `upsertTask` keeps a stored value whatever the written copy of the task carries, so a
  writer holding a copy read before the id was given can neither erase nor replace it.
- **Chosen by Mission Control.** No request body can name a work unit id. A caller can only
  ask to join the work unit of the task it is running, or to start a new one.
- **A resident run has none.** A resident is a standing agent, not a piece of work. Its task
  has no work unit, and tasks it creates get their own.
- **Older tasks.** A task filed before this existed has no id until it is next dispatched or
  assigned. That gives it a new one and saves it before anything in the same dispatch reads
  it. Nothing is inferred from its plan inputs or dependencies.

## Which tasks share one

| How the task is created | Its work unit |
|---|---|
| MCP `create_task`, called by a session whose own task is a plan task | The plan task's. This is how phase tasks inherit, with no change to the phasing skill. |
| MCP `create_task` with `workUnit: "inherit"`, from any session bound to a task | That task's. A task that only predates the column is given its id first. Refused, with the reason, when the session has no task or its task is a resident run. |
| MCP `create_task` with `workUnit: "new"`, or from a session whose task is not a plan task | A new one. |
| A retro follow-up task | The source task's. |
| A failed chat retried as a new task | The source task's. |
| Best-of-N members, their retries and a replacement | One for the whole run. |
| Dashboard dispatch, a schedule occurrence, an imported issue, a pipeline task, a tour, a launch-failure report | A new one. |
| A resident run | None. |
| Requeue, retry, reassign, restore, runtime transfer (the same row) | Unchanged. |

- A task that inherits copies the value. It is not derived through a parent pointer, so it
  survives the parent being deleted.
- A plan created by a plan inherits, and so do its phases, because a copied id is the same id.
- A session with no task (a discovered session, a home session) has no work unit.
- Which kinds share and which have one is kind behaviour, in `TASK_KIND_BEHAVIOR`
  (`src/shared/task.ts`): `sessionTasksJoinWorkUnit` is true for a plan only, and
  `workUnit` is false for a resident only.
- An automatic inheritor whose source has no work unit (a resident run) gets a new one
  rather than failing. Only an explicit `"inherit"` is refused.

**When two operations reach one task at once.** A child inheriting from a task, a dispatch
and an assign can each find the same older task without an id. Each mints a candidate and
writes it only where the column is still empty, then reads the stored value back and uses
that, never its own candidate (`claimTaskWorkUnitId` in `src/server/db.ts`). So the first
write wins and every operation, and the board, ends up with the same id.

## Reading a work unit

- `GET /api/tasks` returns every task with its `workUnitId`.
- The MCP tools `create_task` (its result), `get_task` and `list_tasks` include `workUnitId`.
- `list_tasks` takes a `workUnitId` filter, an exact match, which lists the tasks of one work
  unit. A value that is not a well-formed id is refused.
- `create_task` takes `workUnit: "inherit" | "new"`. Omit it to let the calling session's
  task kind decide.

## Telemetry

Every span Mission Control exports for a session that emits a work unit carries the attribute
`work_unit_id`, so one trace query on it returns the session spans of a plan and all its
phases: `span.work_unit_id = "wu_..."` in Tempo, `@work_unit_id:wu_...` in Datadog.

- **Unhashed, and the same in every lane.** Every other exported id is a per-destination hash.
  This one is the documented exception, so it matches across the local, operator and product
  lanes and the value the agent sends on its own MCP calls.
- **Which value.** The work unit the session's agent was started with, read from the
  [launch record](#the-launch-record), never the preview flag.
- **Never a metric label.** No instrument gains a series per piece of work.

Which spans carry it, which value a launch attempt or a late task outcome carries, when it is
absent, and the limits on late outcomes are owned by
[Work unit id](observability.md#work-unit-id).

## The launch environment

Behind the **Work unit id** preview (`work-unit-id`, Settings > Feature flags), an agent Mission
Control starts for a task that has a work unit gets the id in its environment as `WORK_UNIT_ID`.
MCP config that references the variable then sends it as the `x-work-unit-id` header on the
agent's own MCP calls (see [MCP servers the worker calls](#mcp-servers-the-worker-calls)).
Mission Control writes no header into any MCP config.

- **Every launch path.** A dispatch on either runtime (the Claude Agent SDK, `codex app-server`,
  Pi's tool environment, and the terminal wrapper's `export` lines), a managed Pipeline host, an
  embedded restore after a daemon restart, a hibernation wake (deciding for the task it wakes),
  a managed terminal resume, and a runtime transfer.
  The Claude adapter's in-session relaunch reuses its launch's environment. It is set whether or
  not telemetry is on: it identifies the work.
- **Never inherited.** Every process Mission Control spawns has any `WORK_UNIT_ID` from the
  daemon's own environment removed, and the script that starts an agent in a pane unsets it
  before its exports, as does the managed resume guard. So an agent carries the launch's value
  or none, never one from the shell that started the daemon or the terminal server.
- **No work unit, no variable.** A session with no task, a resident run (which has no work
  unit), a one-shot model call (Foreman, the Inspector, a Persona review) and a workflow check
  command get none. So does the terminal Pipeline host: it is Conductor's own CLI, and the agents
  its engine starts are discovered rather than launched by Mission Control, so no launch record
  could follow them.
- **One decision per launch.** `launchWorkUnitId(task)` in `src/server/work-unit.ts` is the only
  place server code reads the flag. It is called once, where a launch begins, and returns the
  task's id when the preview is on and the id is well formed, and null otherwise. That one value
  goes to the agent's environment, the launch record and the shaping run, so a switch
  while a launch is in flight cannot give its parts different answers. An older task is given
  its id before that point, so its first dispatch carries it.

### The launch record

Mission Control records, per session, the work unit its agent was started with
(`session_launch_work_units`, keyed by the session's note key). Everything else it emits for a
session follows that record, never the flag, so an agent's spans and its MCP calls cannot
disagree.

- **When it changes.** It is installed in the step that puts a launched session in the
  registry, before that session's first event is published. An embedded launch or restore
  installs it in `registerSdkSession`, once its driver has started. A terminal launch (a
  dispatch, a managed resume, a runtime transfer) hands its decision over just before it spawns,
  keyed by the launch's own private state home, and the registry installs it on first sight of
  the agent running beneath that launch's wrapper or resume guard - read off the process
  ancestry, so a pane that merely shares the checkout cannot take it. A launch that carries none
  removes it.
- **It changes only when a launch's agent actually starts.** Being seen beneath the launch's own
  wrapper is proof that agent is running with that environment, so its record lasts as long as
  it does, whatever else the launch then failed at, and a record once installed is final. A
  dispatch that fails keeps its terminal, so its agent may still be running: its record is what
  keeps the reuse guard from handing it another work unit's task. When that agent ends, its
  record describes a process that has ended, and the next launch of its conversation replaces
  it. A hand-over not yet taken keeps waiting, so an agent that appears late still gets its
  record. There is no timer: a hand-over lasts exactly as long as its launch's private home
  exists, which the wrapper removes only when it exits, after its agent. The terminal launcher
  settles its hand-over only to withdraw one nothing can take: a launch that definitely started
  nothing (a managed resume the terminal refused). An embedded launch that fails never reaches
  registration and changes nothing; if its driver started but registration failed, the driver
  is stopped.
- **What it survives.** A `/clear` or an assign starts a new conversation and not a new
  process, so the record follows the session across every note-key rotation, with the standing
  instructions the launch delivered. A `/clear` made while no daemon was running moves it too,
  on the agent's first sight after the restart, unless another live session holds the old
  conversation. Rows load at daemon start and are pruned with them.
- **Readers.** `launchWorkUnitFor(session)` is the recorded id: what the agent carries, read by
  capture and by the reuse guard. `sessionWorkUnitId(session, task)` is that id while the task
  has the same one, and null otherwise: what the session emits for a task in hand. The registry
  projects the record onto `Session.launchWorkUnitId` and the emitted id onto
  `Session.task.workUnitId`.
- **A switch of the preview** takes effect at each agent's next start: a dispatch, a restore, a
  resume or a transfer, each of which decides again. Until then an agent started with the
  variable keeps it and keeps emitting it, and one started without it gains nothing.
- **Sessions running before this existed** have no record and emit nothing until their next
  start.

### Reusing an agent

An agent that was started with one work unit is never handed a task of another: its environment
is fixed, and its MCP calls would carry the first. `TaskManager.assign` refuses it ("that agent
was started for another work unit, so its MCP calls would be tagged with it"), and the backlog's
own selection does not offer it that task. An agent started for the task's own work unit takes
it; one started with none takes any task, which then emits nothing until the agent's next start.
The guard reads the record, not the flag, so it also holds after the preview is switched off.
See [One agent, one task at a time](dispatch-and-backlog.md#one-agent-one-task-at-a-time---but-not-one-task-per-agent).

### The session detail

The session detail shows a **work unit** row with the id the session emits and a **Copy**
control. It follows the agent, not the live preview: an agent started while the preview was on
keeps the variable until its next start, so its row stays after the preview is switched off and
goes when the agent restarts without it. With the preview never switched on no agent carries a
work unit, so no session shows the row. It is absent for a session that emits none - including
one whose task has an id its agent was not started with.

## MCP servers the worker calls

Mission Control sets the variable; the owner of an MCP server's config references it. Mission
Control does not need to know which servers exist, and writes nothing per task into any config.

| Agent and server | What the config owner writes |
|---|---|
| Claude Code, remote server | `"headers": { "x-work-unit-id": "${WORK_UNIT_ID:-}" }` |
| Codex, remote server | `env_http_headers = { "x-work-unit-id" = "WORK_UNIT_ID" }` |
| Codex, stdio server | `env_vars = ["WORK_UNIT_ID"]` |
| Claude Code, stdio server | Nothing. The server inherits the variable. |

- **Claude Code needs the `:-`.** Written `${WORK_UNIT_ID}`, a session started outside Mission
  Control sends the literal text `${WORK_UNIT_ID}`. Written `${WORK_UNIT_ID:-}`, it sends the
  header with an empty value. A server must therefore treat an empty value as absent.
- **Codex** sends no header at all when the variable is unset.
- **Servers that sign in with OAuth: leave the reference off, on both agents, for now.** Whether a
  server keeps its sign-in once the header is added has not been verified (below). Claude Code's
  program text keys a server's stored sign-in by its name and a hash of its type, URL and headers
  after `${...}` is filled in, so a value that differs per work unit is expected to give every
  work unit its own, empty sign-in. A worker's calls to such a server therefore carry no work
  unit. Codex is unverified on its own terms, and its answer says nothing about Claude Code's.
- **Expect to sign in again after adding it.** By the same program text, an entry that has just
  gained the header no longer matches the key its earlier sign-in was stored under, so an
  operator should expect to sign in once more after adding the reference to a Claude Code server
  that uses OAuth - and, per the point above, again for every new work unit. Not verified.
- **Limits.** claude.ai cloud connectors are not covered. Pi has no remote MCP client, so it has
  no header to send. A resident run has no work unit, and the resident catalog drops the
  reference (see [The work unit reference](residents.md#the-work-unit-reference)).

### What the OAuth check found

Decision D8 asked for a check against a local OAuth fixture before this guide was written. It
was attempted on 2026-11-21 with Claude Code 2.1.330 and Codex CLI 0.170.0, and **neither half
could run**, so every answer is recorded as not verified and the guide above takes the cautious
branch for both agents.

- **The fixture.** A loopback MCP server requiring a bearer token, with its own protected
  resource metadata, authorization server metadata, dynamic client registration, an
  auto-approving authorize endpoint and a PKCE token endpoint. Its tokens meant nothing outside
  it. It logged header names, and a value only for `x-work-unit-id`. A driver completed the
  authorize redirect for `mcp login --no-browser`, so no browser was involved.
- **Claude Code: blocked by device management.** A throwaway `CLAUDE_CONFIG_DIR` does get its own
  credential store: the program text suffixes the keychain service with the first eight hex
  characters of the SHA-256 of that directory. But the machine's managed policy
  (`allowedMcpServers`) admits only a list of `https://` server URLs, no loopback ones, so Claude
  Code refused the fixture in any config directory ("not allowed by enterprise policy"). The
  policy was not bypassed.
- **Codex: stopped before signing in.** The machine's managed Codex configuration forces
  `mcp_oauth_credentials_store = "keyring"`, so a fixture sign-in would have been written into the
  same keychain store as the operator's real Codex MCP sign-ins. The check stopped there, as the
  plan requires, rather than write beside them.
- **Cleanup.** The fixture received no request. The throwaway config directories were removed,
  no keychain item was created for them, and the operator's Claude Code and Codex configuration
  was not touched.
- **To verify later,** on a machine whose policy admits a loopback server and lets Codex use a
  file credential store: sign in with one value of the variable and connect with another
  (question 1, for each agent); sign in headerless, add the header, and connect with the
  headerless entry and with the new one (question 2); and if question 1 fails for Claude Code,
  whether a `headersHelper` that emits the header keeps the sign-in (question 3).

## Task shaping

When [task shaping](task-shaping.md) runs at dispatch, every shaper call carries the work unit
decision of the launch it was made for, in the carrier its transport has. That is the value the
launch's agent is started with, and the call keeps it if that agent then fails to start. The
names are the ones the worker's own launch and MCP calls use, so a `get_guidance` call Mission
Control makes is found by the same query as the worker's own calls.

| Transport | Carrier |
|---|---|
| `http` | The `x-work-unit-id` header. No `_meta`: it is not an MCP call, and its request body does not change. |
| `mcp` over streamable HTTP | The `x-work-unit-id` header on every request, and `params._meta.work_unit_id` on each `tools/call`. |
| `mcp` over a local process | `WORK_UNIT_ID` in the server's environment, and `params._meta.work_unit_id` on each `tools/call`. |
| `command` | `WORK_UNIT_ID` in the process's environment. |
| `builtin` | None. It runs in the daemon. |

- **Which value.** For a new agent, the launch's one decision: `launchWorkUnitId(task)`, made
  where the dispatch begins. The shapers are handed that value and the agent is started with it,
  so a switch of the preview while shapers run cannot make them differ. For a task handed to an
  agent that is already running, `sessionWorkUnitId(session, task)`: the agent's launch record,
  while the task has the same id. The preview at the moment of the handover does not matter.
  Shaping never reads the flag itself.
- **When there is none.** The preview was off at the launch's decision, the task has no id, the
  task is handed to an agent that is already running and was started without the variable, or
  the run is a dry run from Settings, which has no task. Then no call carries one.
- **Only the launch's own value.** A configured header or variable named `x-work-unit-id` or
  `WORK_UNIT_ID`, compared without case, is removed first, with or without a value to send. A
  `command` shaper or a local MCP server never inherits a `WORK_UNIT_ID` from the daemon's own
  environment. The value is an opaque id, not a credential or a reference, so it is never
  redacted, and a reply that echoes it keeps it.
- **A launch that fails.** A shaper call is made before the agent starts, so it belongs to the
  launch it was made for. If the agent then fails to start, the call keeps the task's work unit:
  it was made for that task's work. No launch record is written, and a retry is a new launch that
  decides again.
