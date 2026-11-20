# Work unit id - Phase 4: Shaping hand-off

## Outcome

When Mission Control shapes a task at dispatch, every shaper call carries the work
unit the task's agent carries, in the carrier its transport has:

| Transport | Carrier |
|---|---|
| `http` | The `x-work-unit-id` header. No `_meta`: it is not an MCP call. |
| `mcp` over streamable HTTP | The `x-work-unit-id` header on every request, and `params._meta.work_unit_id` on each `tools/call`. |
| `mcp` over a local process | `WORK_UNIT_ID` in the server's environment, and `params._meta.work_unit_id` on each `tools/call`. |
| `command` | `WORK_UNIT_ID` in the process's environment. |
| `builtin` | None. It runs in the daemon. |

A `get_guidance` call that Mission Control makes is then found by the same query as the
worker's own calls. A shaper call carries an id only when the task's agent carries it too
(Phase 2), so the two never disagree.

## Entry criteria and dependencies

- Phase 2 of this plan is merged.
- "Task shaping - Phase 2: Dispatch seam and visibility" is merged. It starts the shaping
  run at dispatch.
- "Task shaping - Phase 5: Remote transports" is merged. Its task carries an addendum:
  the transports send the work unit when the run context has one.

## Scope

- The work unit as an input of a shaping run, and its value at the dispatch seam.
- A check that every transport sends it, closing any gap the shaping phases left.

Not here: any change to the shaper request body (protocol 1), a span for the shaping run,
the transports' own design.

## Repository findings

- No shaping code is on `main` at planning time. Read the merged code first. Where a name
  or file below differs from what merged, the merged code wins.
- On the shaping core branch (pull request 1558), the engine's run input has
  `trace?: ShapingTraceContext | null` (`src/server/shaping/engine.ts`) and hands it to
  every call as `ctx.trace` (`src/server/shaping/transports/types.ts`). The `command`
  transport builds its process environment in `transports/command.ts` and removes any
  configured `TRACEPARENT` or `TRACESTATE` first.
- `docs/plans/task-shaping/phase-5-remote-transports.md`, step 5, describes how trace
  context is sent on `http` and `mcp`. The addendum on that task asks for the same
  treatment of the work unit: a configured header or variable of the same name is removed
  first, the value is never redacted, and with no work unit nothing is sent.
- The `command` transport shipped with the shaping core, before the addendum. Check whether
  the remote transports phase extended it.

## Steps

1. **Read what merged.** Find the run input, the transport context, and what each
   transport already does with a work unit.
2. **Run input.** If it is not there yet, add `workUnitId?: string | null` to the engine's
   run input beside `trace`, and hand it unchanged to every call of the run as
   `ctx.workUnitId`. If the remote transports phase added the field under another name,
   keep that name.
3. **Dispatch seam.** Where dispatch starts the shaping run for a task, pass the id the task's
   agent carries. For a new agent that is the launch's one decision: Phase 2 computes it
   once, at the start of the dispatch, and uses the same value for the agent's environment
   and the launch record. Take that value. Do not call `launchWorkUnitId` again, and do not
   read the flag. For a task that goes to an agent that is already running, pass
   `sessionWorkUnitId(session, task)`.
4. **Transports.** Confirm each one, and add what is missing:
   - `http` and `mcp` over streamable HTTP: header `x-work-unit-id` on every request;
   - every `mcp` `tools/call`, on both kinds of server: `params._meta.work_unit_id`;
   - `http` carries the header only. It has no `_meta`, and its request body does not
     change;
   - the header and the `_meta` key always carry the same value, the run's one work unit;
   - `command`, and `mcp` over a local process: `WORK_UNIT_ID` in the environment. Both first
     remove the variable from the environment they have assembled, whether it came from the
     daemon's own environment or from the shaper's configuration, and then set the run's id
     when there is one;
   - a configured header or variable of the same name, compared without case, is removed
     first, with or without a work unit;
   - the value is not a reference and is never redacted.
   Use the constants in `src/shared/work-unit.ts`.
5. **Dry run.** A test run from Settings has no task. It passes no work unit.
6. **Docs.** A "Work unit" paragraph beside the trace context text in
   `docs/task-shaping.md`, and a "Task shaping" section at the end of
   `docs/work-units.md`.

## Data, API and compatibility

- No schema change, and no change to the shaper request body or result (protocol 1).
  `params._meta` is part of the MCP `tools/call` envelope, not of the tool's arguments. So
  a `get_guidance` call keeps its arguments, and an `http` shaper, which has no envelope,
  gets the header only.
- A shaper that ignores the header, `_meta` key or variable is unaffected.
- When the task's agent carries no work unit, nothing is added to any call. That is the case
  when the flag was off as the agent started, when the task has no id, and for an agent that
  was started without the variable.

## Tests and verification

- Engine: a run given a work unit hands the same value to every call, across two
  repositories; a run given none hands null.
- Dispatch seam: for a new agent started with the flag on, the fixture shaper receives the
  task's id; with the flag off, it receives none; for a task that goes to an agent that is
  already running, it receives the id only when that agent was started with it; a dry run
  sends none.
- A switch in between: an agent started with the flag on takes a task of its own work unit
  after the flag is switched off, and the shaper still receives the id; an agent started
  with the flag off takes a task after the flag is switched on, and the shaper receives
  none.
- A switch while shaping is in flight: the flag is switched after the dispatch's decision
  and before the agent starts, in each direction. The shaper and the agent hold the same
  value.
- Transports, one present case and one absent case each, unless the remote transports
  phase already has them: `http` header, with no work unit anywhere in its request body; streamable-HTTP `mcp` header on every request of
  a call and `_meta` on `tools/call`, with equal values; stdio `mcp` environment and
  `_meta`; `command` environment. A configured `x-work-unit-id` header is not sent when
  the run has no work unit. A reply that echoes the id comes back unredacted and unmarked.
  An absent case for `command` and one for a local `mcp` server run with `WORK_UNIT_ID` set
  in the daemon's environment, and the shaper process has none.
- No browser spec: this phase has no dashboard surface.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`.

## Merge and exit criteria

- When the task's agent carries the task's work unit, each transport carries that id as the
  table under "Outcome" says: a fixture `get_guidance` shaper on an `mcp` server over
  streamable HTTP receives it in the header and in `_meta`; an `http` shaper in the header
  only; a local `mcp` server in its environment and in `_meta`; a `command` shaper in its
  environment. That agent is a new one started with the flag on, or a running one whose
  launch record holds the task's work unit, whatever the flag says when the task is handed
  over.
- When it does not, no call carries one: a new agent started with the flag off, a running
  agent with no launch record, a task with no id, and a dry run.
- Only the launch's own value is ever sent, never a configured one, and never one a shaper
  process inherited from the daemon's environment.
- One dispatch has one decision: the shaper and the agent it starts never differ, also when
  the flag is switched while shaping runs.

## Handoff

The later route stage (task-shaping Phase 7) uses the same run input, so a router call
carries the work unit with no further change.

## Cross-phase audit

- Phase 1: reads `task.workUnitId` and the shared constants.
- Phase 2: takes the launch's one decision and `sessionWorkUnitId`. This phase never reads the
  flag and never calls `launchWorkUnitId`. The worker's `WORK_UNIT_ID` and a shaper
  process's `WORK_UNIT_ID` are set by different code and carry the same value.
- Phase 3: shares no file except `docs/work-units.md`, in a different place.
- Task shaping: this phase adds an input and one call site. It reshapes neither the engine
  nor a transport.
- Source plan: owns section 7, and the header and `_meta` half of R4.
- Plan validation repair, round 3: the outcome, the steps, the compatibility notes and the
  exit criteria name the same carrier for each transport. An `http` shaper gets the header
  only.
- Inspector review of the plan's pull request: the seam passes the id the task's agent
  carries, so a shaper call never carries an id that the worker's own calls do not.
- Inspector review, round 2: the exit criteria follow the agent's launch record, not the flag
  at the moment of dispatch, and the tests cover a switch between an agent's start and its
  next task.
- Inspector review, round 3: shaping takes the launch's one decision and does not compute
  its own, and a local shaper process never inherits the daemon's `WORK_UNIT_ID`.
