# Work unit id - Phase 4: Shaping hand-off

## Outcome

When Mission Control shapes a task at dispatch, every shaper call carries the task's work
unit: the `x-work-unit-id` header and `params._meta.work_unit_id` to an MCP or HTTP
shaper, and `WORK_UNIT_ID` to a shaper that runs as a local process. A `get_guidance`
call made by Mission Control is then found by the same query as the worker's own calls.

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
3. **Dispatch seam.** Where dispatch starts the shaping run for a task, pass
   `activeWorkUnitId(task)`.
4. **Transports.** Confirm each one, and add what is missing:
   - `http` and `mcp` over streamable HTTP: header `x-work-unit-id` on every request;
   - every `mcp` `tools/call`: `params._meta.work_unit_id`;
   - the header and the `_meta` key always carry the same value, the run's one work unit;
   - `command`, and `mcp` over a local process: `WORK_UNIT_ID` in the environment;
   - a configured header or variable of the same name, compared without case, is removed
     first, with or without a work unit;
   - the value is not a reference and is never redacted.
   Use the constants in `src/shared/work-unit.ts`.
5. **Dry run.** A test run from Settings has no task. It passes no work unit.
6. **Docs.** A "Work unit" paragraph beside the trace context text in
   `docs/task-shaping.md`, and a "Task shaping" section at the end of
   `docs/work-units.md`.

## Data, API and compatibility

- No schema change, and no change to the shaper request or result.
- A shaper that ignores the header, `_meta` key or variable is unaffected.
- Flag off, or a task with no id: nothing is added to any call.

## Tests and verification

- Engine: a run given a work unit hands the same value to every call, across two
  repositories; a run given none hands null.
- Dispatch seam: flag on, the fixture shaper receives the task's id; flag off, it receives
  none; a dry run sends none.
- Transports, one present case and one absent case each, unless the remote transports
  phase already has them: `http` header; streamable-HTTP `mcp` header on every request of
  a call and `_meta` on `tools/call`, with equal values; stdio `mcp` environment and
  `_meta`; `command` environment. A configured `x-work-unit-id` header is not sent when
  the run has no work unit. A reply that echoes the id comes back unredacted and unmarked.
- No browser spec: this phase has no dashboard surface.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`.

## Merge and exit criteria

- Flag on: a fixture `get_guidance` shaper called at dispatch receives the task's id in
  the header and in `_meta`, and a command shaper receives it in its environment.
- Flag off, a dry run, or no id: no call carries one.
- Only the launch's own value is ever sent, never a configured one.

## Handoff

The later route stage (task-shaping Phase 7) uses the same run input, so a router call
carries the work unit with no further change.

## Cross-phase audit

- Phase 1: reads `task.workUnitId` and the shared constants.
- Phase 2: uses `activeWorkUnitId`. The worker's `WORK_UNIT_ID` and a shaper process's
  `WORK_UNIT_ID` are set by different code and carry the same value.
- Phase 3: shares no file except `docs/work-units.md`, in a different place.
- Task shaping: this phase adds an input and one call site. It reshapes neither the engine
  nor a transport.
- Source plan: owns section 7, and the header and `_meta` half of R4.
