# Work unit id: mint, inherit and carry across sessions and MCP calls

Status: decisions adopted in the plan review on 2026-11-20, and phased the same day. Owner:
Jordan. Planning task: "Work unit id - mint, carry and trace across Mission Control sessions
and MCP calls".

## Goal

Mission Control gives every piece of work one id, `work_unit_id`. It carries that id to every
span it exports for the work's sessions and to every MCP call the work makes. One Datadog
query on `work_unit_id` then finds every trace and MCP call for the piece of work, across
sessions, harnesses and services.

Today there is no such id. Mission Control makes one trace per session, so a plan with five
phases is at least six unrelated traces.

## Requirements (decided by Jordan, 2026-11-20)

| # | Requirement |
|---|---|
| R1 | One `work_unit_id` covers a plan task plus all its phase tasks. Format `wu_<ULID>`, Crockford base32, matching Agent Platform's check `^wu_[0-9A-HJKMNP-TV-Z]{26}$`. |
| R2 | One plain name everywhere: span attribute `work_unit_id`, HTTP header `x-work-unit-id`, MCP `params._meta.work_unit_id`, environment variable `WORK_UNIT_ID`. Mission Control core stays generic, with no company names. |
| R3 | Mission Control exports it unhashed on its own telemetry, as a documented exception to `scopedRef` hashing. Every session span of the work unit carries it. |
| R4 | It travels as explicit fields, not W3C baggage. Agent Platform's control plane strips baggage. |
| R5 | The worker's own in-session MCP calls carry it too. |

## Adopted decisions (Jordan, plan review, 2026-11-20)

| # | Decision | Choice |
|---|---|---|
| D1 | Which tasks inherit by default | A task created by a plan task's session inherits that plan task's work unit. Any other session gets a new unit unless it passes `workUnit: "inherit"`. |
| D2 | How the worker's own MCP calls get the header | Mission Control sets `WORK_UNIT_ID`. The owner of an MCP server's config references it. Mission Control injects no header. |
| D3 | Tasks that exist before this ships | No inference. Such a task gets a new id at its next dispatch. |
| D4 | Which telemetry lanes export the unhashed id | Every lane that exports traces. |
| D5 | After the plan | Create the phased implementation plan and schedule its tasks. |

## Step 1: the spike, and what it found

**Question.** Can Claude Code and Codex attach a per-session header, or `_meta`, to the remote
MCP calls a worker makes, from per-launch config or environment interpolation?

**Answer.** A header: yes, on both agents, from both sources. `_meta`: no, on neither.

**Method.** Two local fixture MCP servers on loopback, one streamable HTTP and one stdio,
recorded what each agent sent. Claude Code 2.1.329 (the CLI and Agent SDK 0.3.325) and Codex
CLI 0.170.0 ran under the real home with its normal sign-in. No credential was read, copied or
passed. The fixtures logged header names, and header values only for a fixed list of safe
names.

### Claude Code

| Case | What reached the fixture |
|---|---|
| Per-launch `--mcp-config`, literal header | The header, on every request: discovery, `initialize`, notifications, the event stream, `tools/list` and `tools/call`. |
| Header written `${WORK_UNIT_ID}` or `${WORK_UNIT_ID:-}`, variable set at launch | The variable's value. |
| The same reference in user scope (`~/.claude.json`), in a project `.mcp.json` and in a plugin's `.mcp.json` | The variable's value, in all three. |
| Agent SDK `query()` called as Mission Control calls it (`options.env`, `mcpServers`, setting sources user, project and local) | The literal header, and the interpolated one. |
| Variable unset, header written `${WORK_UNIT_ID}` | The literal text `${WORK_UNIT_ID}`. The server still loads. |
| Variable unset, header written `${WORK_UNIT_ID:-}` | The header, with an empty value. |
| A stdio server | `WORK_UNIT_ID` in its environment, inherited from the agent. |
| `params._meta` on `tools/call` | Only `claudecode/toolUseId` and `progressToken`. No setting adds a key. |
| `traceparent` | Sent on `tools/call` only, with the trace id of the launch's `TRACEPARENT` and a new span id per call. No `tracestate` and no `baggage`. |

### Codex

| Case | What reached the fixture |
|---|---|
| Per-launch `-c mcp_servers.<name>.http_headers={...}`, literal | The header, on every request. |
| Per-launch `-c mcp_servers.<name>.env_http_headers={"x-work-unit-id"="WORK_UNIT_ID"}`, variable set | The variable's value. |
| The same entry written in `~/.codex/config.toml` | The variable's value. |
| The same entry, variable unset | No header at all. |
| A stdio server, default settings | `WORK_UNIT_ID` is not in its environment. |
| A stdio server with `env_vars = ["WORK_UNIT_ID"]` | It is. |
| `params._meta` on `tools/call` | Codex's own keys (`traceparent`, `threadId`, `sessionId`, `x-codex-turn-metadata` and others). No setting adds a key. |
| `traceparent` | Sent as a header on every request. Startup requests carried the launch's trace id. In `codex exec` each `tools/call` carried a different trace id, not the launch's. |

### What follows from it

- The environment variable is the per-session carrier. Config that references it turns it
  into a header, in every place an operator, a plugin or IT keeps MCP config. Mission Control
  does not need to know which servers exist.
- `_meta.work_unit_id` can only be sent by a client Mission Control writes itself, which is
  the shaper transports. So a server must accept the header on its own. When Mission Control
  sends both, they carry the same value, so a server may prefer either.
- Trace context alone does not reliably join an MCP call to its session (see Codex above).
  That is one more reason the id is an explicit field.
- One sharp edge. On Claude Code the reference must be written `${WORK_UNIT_ID:-}`. Without
  the `:-`, a session started outside Mission Control sends the literal text. With it, the
  header is present and empty, so a server must treat an empty value as absent.

### Cleanup and limits

- Installed for the test: one user-scope Claude Code server (`wu-spike-user-7f3a91`) and one
  block in `~/.codex/config.toml` (`wu_spike_user_7f3a91`). Both were removed and checked.
  Claude Code: the user-scope server list has the same count (3) and the same content hash
  before and after. Codex: the file has the same size (9044 bytes) and the same SHA-256
  before and after.
- Not run on its own: `codex app-server`, Mission Control's embedded Codex runtime. It is the
  same binary and config loader as `codex exec`, and Mission Control already passes it
  `-c mcp_servers...` overrides.
- Not testable with a local fixture: claude.ai cloud connectors, and servers that sign in
  with OAuth.
- Pi has no remote MCP client, so it has no header to send.

## Design

### 1. The id

- `wu_` followed by a ULID: 48 bits of millisecond time and 80 random bits in Crockford
  base32, 26 characters. It always matches Agent Platform's check.
- `src/shared/work-unit.ts` holds the pattern, `isWorkUnitId`, the pure encoder and the four
  carrier names as constants, so no other file spells them. `src/server/work-unit.ts` mints,
  with `node:crypto`. It is about twenty lines and needs no new dependency. The repository
  has no ULID or prefixed-id helper today.
- The id is opaque. It is not a credential and is never redacted. It does embed the time it
  was minted.

### 2. The task record and inheritance

A new column `tasks.work_unit_id`, and `Task.workUnitId`. Every task created after this
ships has one from creation. It is written once: no later write changes a value that is set.

Minting and inheriting happen in one place, `TaskManager.create` in `src/server/tasks.ts`,
which every task-creating path already goes through. The source is named by an internal
option, next to the reserved id that internal callers already pass, so no HTTP body can
choose a work unit.

| How the task is created | Its work unit |
|---|---|
| MCP `create_task`, called by a session whose own task is a plan task | The plan task's. This is how phase tasks inherit, with no change to the phasing skill (D1). |
| MCP `create_task` with `workUnit: "inherit"`, from any session bound to a task | That task's. Refused, with the reason, when the session has no task. |
| MCP `create_task` with `workUnit: "new"`, or from a session whose task is not a plan task | A new one. |
| A retro follow-up task | The source task's. |
| A failed chat retried as a new task | The source task's. |
| Best-of-N members, their retries and a replacement | One for the whole run. |
| Dashboard dispatch, a schedule occurrence, an imported issue, a resident run, a pipeline task, a tour, a launch-failure report | A new one. |
| Requeue, retry, reassign, restore, runtime transfer (the same row) | Unchanged. |

- **A standalone task** gets its own id: a work unit of one. Every task-bound session is
  therefore tagged the same way.
- **A plan created by a plan** inherits, and so do its phases, because a copied id is the
  same id.
- **A session with no task** (a discovered session, a home session) has no work unit, and
  nothing is sent for it.
- **A task that predates the column** has no id until its next dispatch, which mints one
  (D3). Nothing is inferred from its plan inputs or dependencies. When a new task inherits
  from such a task, the parent is given its id first and the child copies it.
- The value is copied, not derived through a parent pointer. A copy survives the parent
  being deleted and needs no tree walk at launch or capture.
- Why the default follows the task kind: a resident or a chat schedules many unrelated
  pieces of work, so "inherit from whoever called" would merge them into one unit. R1 names
  the plan task as the root.

### 3. Reading it

- `workUnitId` is in every task read: `GET /api/tasks`, and the MCP tools `get_task`,
  `list_tasks` and the `create_task` result.
- `list_tasks` gains a `workUnitId` filter, so an agent or a person can list the tasks of
  one work unit.
- The dashboard shows it in the session detail (`ConsoleDetail`), as a "Work unit" row with
  a copy control. Mission Control links to no observability vendor.

### 4. The launch environment

Every agent process Mission Control starts for a task gets `WORK_UNIT_ID`.

- One pure helper, beside `withAgentTraceContext`: remove any inherited `WORK_UNIT_ID`, then
  set the task's. The daemon may itself have been started from a worker's shell, and a
  session must never carry another unit's id.
- Paths: Claude Agent SDK launch, restore and in-session relaunch; Codex app-server; Pi's
  tool environment; terminal dispatch (the wrapper script's exports); the two pipeline
  hosts; managed terminal resume and runtime transfer.
- It is set whether or not telemetry is on. Unlike `TRACEPARENT`, it identifies the work,
  and other services record it.
- One-shot model calls (Foreman, Inspector, Persona reviews) and workflow check commands are
  not sessions and load no MCP servers. They get no id, and an inherited one is removed.

### 5. The worker's own MCP calls

Mission Control sets the variable. The owner of an MCP server's config references it.
Mission Control writes no per-task value into any MCP config (D2).

| Agent and server type | What the config owner writes |
|---|---|
| Claude Code, remote server | `"headers": { "x-work-unit-id": "${WORK_UNIT_ID:-}" }` |
| Codex, remote server | `env_http_headers = { "x-work-unit-id" = "WORK_UNIT_ID" }` |
| Codex, stdio server | `env_vars = ["WORK_UNIT_ID"]` |
| Claude Code, stdio server | Nothing. The server inherits the variable. |

Why Mission Control does not inject the header itself:

- It would have to know server names, which is company configuration.
- On the terminal runtime Claude Code reads one shared `ask-channel/mcp.json` for every
  launch, so a per-task value in it would race between dispatches.
- A per-launch entry cannot add one header to a server the operator defined elsewhere. It
  would have to restate the whole server.

Limits: cloud connectors and Pi, as above. A pinned resident does not load the operator's
MCP config, so its remote servers do not carry the header in this plan.

### 6. Telemetry: the unhashed attribute

- `work_unit_id` becomes a declared ref on every event that has a span and declares
  `session_id` or `task_id`: session start, restore, dispatch, segment, effort select,
  operation, turn, end, kill, task outcome, PR observed, and the workflow events.
- It is exported as the span attribute `work_unit_id`, verbatim, in every lane that exports
  traces (D4). It is never also exported as `mission.ref.work_unit_id`.
- The exception is one named list, `UNSCOPED_REF_KEYS = ["work_unit_id"]`. `Collector.span`
  in `src/server/telemetry/projection.ts` is the one place refs are hashed. It exports a key
  on that list as it is, and only when the value is a well-formed `wu_` id. Anything else is
  dropped, so nothing else can leave through that door.
- The catalog lint enforces three rules. Only a listed key may be exported unscoped. Every
  span-bearing event that declares `session_id` or `task_id` also declares `work_unit_id`,
  so a new event cannot forget it. And `work_unit_id` is a forbidden metric dimension.
- The value is read from the task record at capture, through one helper. A session with no
  task gets none.
- Only `mission.session.start` is in the session's trace today. Every other session span is
  the root of its own trace. That is why the attribute goes on each span, and why a query on
  it returns all of them.
- What changes in the privacy contract. `docs/observability.md` says every exported id is a
  per-destination hash. It will say that `work_unit_id` is the one exception: a random id,
  the same in every lane and in other services, so two destinations that both receive it
  can join on it. That is its purpose.

### 7. Shaping

- The queued task "Task shaping - Phase 5: Remote transports" already carries an addendum.
  Its transports send `x-work-unit-id`, `params._meta.work_unit_id` and `WORK_UNIT_ID` when
  the shaping run has a work unit, remove a configured header or variable of that name
  first, and never redact the value.
- This plan supplies the value. The shaping run's input gains `workUnitId`, beside the
  `trace` field the shaping core already defines, and the dispatch seam fills it from the
  task. The header and `_meta` always carry that one value.
- A dry run from Settings has no task, so it sends none. A built-in shaper runs in the
  daemon and needs no carrier. The shaper request body (protocol 1) does not change.
- Shaper spec 544e584d, section 5, gains a "Work unit" paragraph beside "Trace context".
  Its text goes on the Common Room thread with this plan.

### 8. The Agent Platform handoff (later)

Nothing is built now: Mission Control does not call Agent Platform yet. The contract is
fixed here so the later work has no choice left to make.

- `POST /v1/tasks` sends `work_unit_id` equal to the task's `workUnitId`, and the same value
  on a retry.
- Mission Control always supplies it. If a reply names a different work unit, that is an
  error, not a new id to adopt.
- Work that starts in Agent Platform and continues in Mission Control keeps its id: the
  internal create option accepts a supplied, validated id.
- Reported on the Common Room thread on 2026-11-20 by the Agent Platform API owner's agent:
  the API's own MCP endpoint accepts the same header and `_meta` key, and ignores a value
  that is not a well-formed id. Mission Control only ever sends a well-formed one.

### 9. Feature flag

A preview flag, `work-unit-id`, as the repository requires for a new user-facing feature.

- Off (the default): launches, exports and the dashboard are exactly as today.
- On: the variable is set, the attribute is exported, shaping receives the id and the
  dashboard shows it.
- Minting, inheritance and the task read field are not gated. They are data, so a plan and
  its phases are already one unit when the flag is switched on.

## The flow

```mermaid
flowchart LR
  T[Task record: work_unit_id minted or inherited] --> L[Launch: WORK_UNIT_ID in the agent environment]
  L --> W[Worker: Claude Code, Codex, Pi]
  W -->|x-work-unit-id, from the config owner's reference| M[MCP servers the worker calls]
  T -->|header, _meta and env| S[Shapers, including get_guidance]
  T -->|span attribute work_unit_id, unhashed| O[Telemetry export]
  T -.->|work_unit_id on POST /v1/tasks, later| A[Agent Platform]
  M --> D[One query on work_unit_id]
  S --> D
  O --> D
  A -.-> D
```

## Out of scope

- Agent Platform and context MCP server changes. Other owners have them, and they record the
  id they receive.
- A Mission Control span for the shaping run, and trace context for terminal sessions. Both
  are gaps that exist today.
- Tagging the agents' own spans. Claude Code and Codex emit their own telemetry, and Mission
  Control does not produce those spans. For embedded sessions they sit in the trace whose
  root span carries the attribute. For terminal sessions they are not linked. A later spike
  can test `OTEL_RESOURCE_ATTRIBUTES`.
- Sending the header to a resident's pinned remote servers.
- Inferring a work unit for tasks that already exist, and joining a task to another unit
  after creation (D3).

## Verification

- Unit tests, including the task routes in process: the id format against Agent Platform's
  pattern and a known ULID vector; every row of the inheritance table; write-once; the
  environment helper; the projection (the attribute is present and equal in two lanes, is
  never hashed, and a malformed value is dropped); the catalog lint rules.
- End to end, with the fake agents and no model tokens: a launched task's agent records the
  task's `WORK_UNIT_ID`; two standalone tasks record different ones; with the flag off a
  launch has none; the dashboard row shows and copies the id.
- The local telemetry stack test asserts the attribute on an exported span.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke` and
  `npm run test:e2e`.

## Phases

`phased-plan.md` is the implementation index, and each phase has its own file beside this
plan. Investigation merged the dashboard row into the flag phase, so there are four.

| Phase | File | Delivers | Direct prerequisites |
|---|---|---|---|
| 1. Id and task record | `phase-1-id-and-task-record.md` | The helper, the column, the creation rules and inheritance, the read field and filter | This plan |
| 2. Flag, launch environment and dashboard row | `phase-2-flag-launch-environment-and-dashboard.md` | The preview flag, `WORK_UNIT_ID` on every launch path, the "Work unit" row, the config guide | 1 |
| 3. Telemetry attribute | `phase-3-telemetry-attribute.md` | The unscoped ref, capture, lint, the privacy contract | 2 |
| 4. Shaping hand-off | `phase-4-shaping-hand-off.md` | `workUnitId` on the shaping run, filled at dispatch | 2, and task-shaping phases 2 and 5 |

Phases 3 and 4 can run at the same time.
