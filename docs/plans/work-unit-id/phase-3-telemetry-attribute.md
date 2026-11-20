# Work unit id - Phase 3: Telemetry attribute

## Outcome

With the preview on, every span Mission Control exports for a task-bound session carries
the attribute `work_unit_id`, unhashed and identical in every lane. One query on it returns
the session spans of a plan and all its phases. The exception to hashing is named in one
list, checked by the catalog lint and stated in the privacy documentation.

## Entry criteria and dependencies

- Phase 2 is merged (it provides the flag and `activeWorkUnitId`).

## Scope

- A named list of refs that are exported as they are, and its one member.
- The ref on every span-bearing session and task event, and its capture.
- Three lint rules.
- The privacy contract in the documentation.

Not here: metrics (the id is never a metric dimension), the agents' own spans, a span for
the shaping run, any launch path.

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
  from a `SessionTrack`, which has `taskId`. The module has `host.getTask`. Effort selected
  and session operation do not declare `task_id`, but their track is in scope.
  `workflowAuthorContext` and `pr-observations.ts` build refs too.
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
6. **Capture.** One helper in `sessions.ts` returns `activeWorkUnitId(host.getTask(taskId))`.
   Add its result to the refs at every site: start, segment, turn, end, kill, effort
   selected and session operation (from the track's task), dispatch finished, restore,
   task outcome, `workflowAuthorContext`, and PR observations. With the flag off, or for a
   session with no task, the ref is absent, so nothing is stored or exported.
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
- Flag off: no ref is captured, so the exported payloads are unchanged.
- The id is not a metric dimension, so metric cardinality does not change.

## Tests and verification

- `test/telemetry-contract.test.ts`: the shipped catalog passes; one fixture per rule
  fails (an unlisted unscoped key, an event with `task_id` and a span but no
  `work_unit_id`, the id as a metric dimension).
- Projection: the same event projected for two lanes has the same `work_unit_id` and
  different `mission.ref.task_id`; there is no `mission.ref.work_unit_id`; a malformed
  value is dropped; an event without the ref is unchanged.
- Capture: start, turn and end for a task-bound session carry the ref; a discovered
  session carries none; with the flag off none do; effort selected and session operation
  carry it from the track.
- `test/telemetry-stack.integration.ts`: the exported span has the attribute with the raw
  id.
- No browser spec: this phase has no dashboard surface.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`.

## Merge and exit criteria

- Flag on: every exported span for a task-bound session has `work_unit_id` equal to the
  task's id, in every lane, and never in hashed form.
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
- Phase 2: uses `activeWorkUnitId`, so the flag has one gate. This phase touches no launch
  path.
- Phase 4: no shared file except `docs/work-units.md`, where the two sections sit apart.
- Source plan: owns R3 and D4.
