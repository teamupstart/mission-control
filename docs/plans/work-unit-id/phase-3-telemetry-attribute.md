# Work unit id - Phase 3: Telemetry attribute

## Outcome

Every span Mission Control exports for a session that emits a work unit carries the
attribute `work_unit_id`, unhashed and identical in every lane. A session emits the work
unit its agent was started with (Phase 2), so a span never carries an id that the agent's
own MCP calls do not carry. One query on the attribute returns the session spans of a plan
and all its phases. The exception to hashing is named in one list, checked by the catalog
lint and stated in the privacy documentation.

## Entry criteria and dependencies

- Phase 2 is merged (it provides the flag, the launch record and `sessionWorkUnitId`).

## Scope

- A named list of refs that are exported as they are, and its one member.
- The ref on every span-bearing session and task event, and its capture.
- Three lint rules.
- The privacy contract in the documentation.

Not here: metrics (the id is never a metric dimension), the agents' own spans, a span for
the shaping run, any change to what a launch does, any read of the flag.

## Repository findings

- An event is a `TelemetryEventDefinition` in `src/shared/telemetry-catalog.ts`. `refKeys`
  lists the refs it may carry. Its span descriptor has `attributes` (facts, exported as
  `mission.<fact>`) and `refAttributes` (refs, exported hashed as `mission.ref.<key>`).
- `Collector.span` in `src/server/telemetry/projection.ts` hashes every ref with
  `scopedRef`. It is the only place that does, because the per-lane salt lives there.
- Neither path yields a plain `work_unit_id` attribute, which is why this phase adds a
  third.
- Span-bearing events that declare `session_id` or `task_id`: session started, restore
  finished, dispatch finished, segment opened, effort selected, session operation, turn
  finished, session ended, kill requested, task outcome, PR observed, and the workflow
  events in `src/shared/telemetry-sources/workflows.ts`. The usage event has no span.
- Only `mission.session.start` is in the session's trace. The others are roots of their
  own traces, so each needs the attribute itself.
- Capture sites are in `src/server/telemetry/sessions.ts`. They build refs with `refsOf`
  from a `SessionTrack`, which has `taskId`. Effort selected and session operation do not
  declare `task_id`, but their track is in scope. `workflowAuthorContext` and
  `pr-observations.ts` build refs too.
- A session's start is captured when the session is first announced. That is before the
  dispatcher gets control back and before the task points to the session. So `startTrack`
  takes the task from the launch intent (`noteDispatchLaunch`, recorded before the spawn)
  or, for a restore, from the supervisor's association (`restoringSessions`): "Only the
  durable supervisor association or the launch intent supplies task identity". A session
  announced with neither has no task at that moment.
- The module's host (`SessionTelemetryHost`) offers `subscribe` and `getTask`.
- `telemetryCatalogProblems()` is the lint, run by `test/telemetry-contract.test.ts`.
  `FORBIDDEN_METRIC_DIMENSIONS` lists ids that may not be metric dimensions.
- `TELEMETRY_LIMITS.maxRefs` is 64. The workflow events declare 19 refs.
- The promise to amend is in `docs/observability.md`, "What travels, and what never does":
  ids are "opaque per-destination identifiers derived with a profile salt".

## Steps

1. **The list.** In `src/shared/telemetry.ts` add `UNSCOPED_REF_KEYS = ["work_unit_id"]`.
   Its comment states the exception: these refs are exported as they are, to every lane,
   and why.
2. **The descriptor.** Add an optional `unscopedRefAttributes` to the span descriptor.
3. **The catalog.** Add `work_unit_id` to `refKeys` and to `unscopedRefAttributes` of every
   event in the list above, including the shared workflow definition. Follow the catalog's
   rule for versions when a declaration is added.
4. **The lint.** In `telemetryCatalogProblems()`:
   - an `unscopedRefAttributes` entry must be in `UNSCOPED_REF_KEYS` and in the event's
     `refKeys`, and must not also be in `refAttributes`;
   - an event that has a span and declares `session_id` or `task_id` must declare
     `work_unit_id` unscoped;
   - add `work_unit_id` to `FORBIDDEN_METRIC_DIMENSIONS`.
5. **The projection.** Hand unscoped refs to the collector separately from scoped ones. In
   `Collector.span`, write `attributes["work_unit_id"]` only when the key is on the list
   and the value passes `isWorkUnitId`. Otherwise drop it. Never write
   `mission.ref.work_unit_id`.
6. **Capture.** One helper in `sessions.ts` returns the work unit a track's session emits.
   Capture never reads the flag.
   - At the start. A session is announced before its task is bound, and some launches
     announce a session with no task identity at all, so `sessionWorkUnitId` has nothing
     to compare with yet. The start span therefore reads the session's launch record
     itself. Phase 2 installs it before the session's first event is published, for every
     kind of launch that announces a session: a dispatch, a pipeline host, a restore, a
     managed resume and a runtime transfer target. The record was written from that
     launch's decision, so it is the id the agent was started with, and no kind of launch
     needs a path of its own. Add a read of the record to the host for this.
   - After the start. The helper reads the session's launch record through
     `sessionWorkUnitId(session, task)` from Phase 2, which is the id the session's agent
     was started with while its task has that id. A successful resume or transfer replaces
     the record, so later spans follow the new process. A failed one changes nothing.
   - Add the helper's result to the refs at every site with a track: start, restore,
     segment, turn, end, kill, effort selected, session operation and
     `workflowAuthorContext`.
   - Dispatch finished reports a launch attempt. It carries that launch's decision whether
     the launch succeeded or failed, like the shaper calls of the same attempt (Phase 4).
     When it reports a task that went to an agent that was already running, it carries
     `sessionWorkUnitId` for that agent.
   - Task outcome and PR observations have no track. They read the record of the session
     the task points to (`Task.sessionId`), and carry no ref when the task points to no
     session.
   - The ref is absent for a session with no task, for a resident's session (its task has
     no id, decision D6), and for a session whose agent was started without the variable.
     Nothing is stored or exported for them.
7. **Docs.**
   - `docs/observability.md`: amend "What travels, and what never does" to name the one
     exception, and add a "Work unit id" subsection after "Trace context for embedded
     agents": what it is, that it is the same in every lane and in other services, that it
     embeds its mint time, and when it is absent.
   - `docs/telemetry-analytics.md`, `docs/observability-dashboards.md` and the "What is
     sent" part of `docs/upstart.md`: one sentence each where they describe join ids.
   - The `scopedRef` comment in `src/server/telemetry/identity.ts` and the comment in
     `Collector.span`: say that the unscoped list is the only exception.
   - `docs/work-units.md`: a "Telemetry" section directly after "Reading a work unit".

## Data, API and compatibility

- No schema change. The local journal stores the ref with the others, for its normal
  retention.
- Additive on the wire: one more span attribute. No existing attribute changes.
- Every lane that exports traces carries it (D4): local, user and product.
- A session whose agent was started with the flag off has no launch record, so no ref is
  captured and its exported payloads are unchanged. With the flag never switched on, no
  payload changes at all.
- Work in flight. A session whose agent was started with the flag on keeps the ref after
  the flag is switched off, until its next start, exactly as its agent keeps the variable.
  One started with the flag off gains the ref only at its next start.
- The id is not a metric dimension, so metric cardinality does not change.

## Tests and verification

- `test/telemetry-contract.test.ts`: the shipped catalog passes; one fixture per rule
  fails (an unlisted unscoped key, an event with `task_id` and a span but no
  `work_unit_id`, the id as a metric dimension).
- Projection: the same event projected for two lanes has the same `work_unit_id` and
  different `mission.ref.task_id`; there is no `mission.ref.work_unit_id`; a malformed
  value is dropped; an event without the ref is unchanged.
- Capture: start, turn and end for a session that emits a work unit carry the ref; a
  discovered session, a resident's session and a session whose agent was started without
  the variable carry none; effort selected and session operation carry it from the track;
  a task outcome carries it while its task points to a session that emits it.
- A switch in flight: a session whose agent was started with the flag on keeps the ref
  after the flag is switched off and loses it at its next start; one started with the flag
  off has none after the flag is switched on and gains it at its next start.
- A reused agent: a task typed into an agent that has no launch record carries no ref.
- The start span: for a dispatched session, a restored session and a newly registered
  runtime transfer target, each announced before any task is bound to it, `work_unit_id` on
  the session-start span equals the `WORK_UNIT_ID` the agent was started with.
- Dispatch finished for a launch that failed carries that launch's decision.
- `test/telemetry-stack.integration.ts`: the exported span has the attribute with the raw
  id.
- No browser spec: this phase has no dashboard surface.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`.

## Merge and exit criteria

- Every exported span for a session that emits a work unit has `work_unit_id` equal to that
  id, which is its task's, in every lane, and never in hashed form. A resident's spans have
  none, and neither have the spans of a session whose agent was started without the
  variable.
- A span never carries a work unit that the session's agent does not carry in its
  environment, across a switch of the flag and across a reused agent.
- The session-start span carries the id the agent was started with.
- A span that reports a launch attempt carries that attempt's decision, whether or not an
  agent started.
- Only a well-formed `wu_` id can be exported unhashed. The lint fails a second unscoped
  key that is not on the list.
- A new span-bearing event with a session or task ref cannot be added without the
  attribute.
- The documentation states the exception where it states the rule.

## Handoff

Nothing later depends on this phase. A future event that carries a session or task ref
inherits the rule from the lint.

## Cross-phase audit

- Phase 1: reads `Task.workUnitId` and `isWorkUnitId`. No change there.
- Phase 2: reads the launch record through `sessionWorkUnitId`, so capture and the launch
  environment follow one decision and this phase never reads the flag. This phase changes
  nothing a launch does and adds nothing to one: it reads the record.
- Phase 4: no shared file except `docs/work-units.md`, where the two sections sit apart.
- Source plan: owns R3 and D4.
- Plan validation repair, round 1: a resident's session carries no ref (D6).
- Inspector review of the plan's pull request: capture follows what the agent was started
  with instead of the flag and the task record, so a switch of the flag or a reused agent
  cannot put an id on a span that the agent's MCP calls do not carry.
- Inspector review, round 4: the start span carries the id the agent was started with,
  although a session is announced before its task is bound. A span that reports a launch
  attempt carries that attempt's decision.
- Inspector review, round 5: the start span reads the launch record itself, so it is right
  for every kind of launch that announces a session, a runtime transfer target included.
