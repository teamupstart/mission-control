# Phase 3: HTTP and Live-State Surface

## Outcome and value

Expose the proven schedule service as a complete, validated control-plane surface:

- create, update, preview, enable/disable, Run now, archive, and paginated history routes;
- a top-level live schedule collection in Registry, the SSE snapshot, and browser
  `MissionState`;
- post-commit schedule upsert/remove events wired through Phase 2's notifier; and
- typed browser API functions that Phase 4 can consume without inventing payloads.

At the end of this phase the feature is operable through localhost HTTP and observable
through the existing EventSource, even though no Scheduled Catalog React surface exists
yet. The manager, route, and live-state contracts are therefore reviewable before UI work.

## Entry criteria and direct dependencies

Direct phase dependency: Phase 2 — Exact-Once Scheduler and Durable Catch-Up.

Before implementation:

1. Confirm Phase 2 merged; rebase onto that merge.
2. Run the Phase 1 and Phase 2 targeted suites unchanged.
3. Re-read [`plan.md`](plan.md), [`phased-plan.md`](phased-plan.md),
   [`phase-1-durable-schedule-foundation.md`](phase-1-durable-schedule-foundation.md), and
   [`phase-2-exact-once-scheduler.md`](phase-2-exact-once-scheduler.md).
4. Inspect the then-current `buildApp` signature, which on the investigated main branch
   already includes Persona and Workflow managers after the planning checkout's older
   arguments.
5. Inspect all current `ServerEvent` consumers and snapshot fixtures before adding variants.
6. Confirm the Phase 2 service and notifier method names; adapt at the boundary rather
   than duplicating manager logic.

## Scope

### In scope

- Schedule request/query zod schemas and inferred payload types in shared protocol.
- Localhost schedule HTTP routes.
- Registry-owned live active-schedule map and notifier methods.
- `ServerEvent` schedule variants and snapshot extension.
- Browser `MissionState` and `useEventStream` cases.
- Schedule API client helpers.
- HTTP, protocol, SSE, snapshot, and browser-state tests.

### Explicit non-goals

- No catalog, editor, preview screen, history screen, topbar button, or CSS.
- No overlay registration yet.
- No keyboard shortcut.
- No second event stream and no catalog polling.
- No schedule SQL or recurrence calculation in route handlers.
- No direct Foreman or Electron route.
- No OS wake or remote runner.

## Repository findings and inherited contracts

- Every mutating route must define a zod schema in `src/shared/protocol.ts` and use
  `parseBody`.
- The app's `/api/*` and `/events` loopback middleware already protects new routes when
  they are registered on the same Hono instance.
- A new top-level ServerEvent collection requires changes in all four places:
  `ServerEvent.snapshot`, `Registry.snapshot()`, `MissionState`, and the `snapshot` case in
  `useEventStream`.
- Every new `ServerEvent` variant requires an exhaustive `useEventStream` case.
- The live channel is SSE only. History is the exception because it is page-oriented,
  selected on demand, and not live catalog state.
- `Registry` is already the task/review/session event source. It should implement Phase 2's
  notifier rather than create a schedule-specific EventEmitter.
- Phase 2 has already validated recurrence, canonicalized repositories, and made mutations
  durable. Routes validate shape and map service outcomes to HTTP; they do not repeat
  policy.
- App construction on current main has more dependencies than this planning checkout.
  Append the schedule service in a way that preserves existing call sites and tests.

## Authoritative wire contract

Routes:

```text
GET  /api/schedules
POST /api/schedules/preview
POST /api/schedules
POST /api/schedules/:id/update
POST /api/schedules/:id/set-enabled
POST /api/schedules/:id/run-now
POST /api/schedules/:id/archive
GET  /api/schedules/:id/occurrences?before=&limit=
```

The history response is `ScheduleHistoryPage` and includes the full schedule even when it
is archived. That is the deep-link path Phase 4 uses from an old generated task.

SSE:

```ts
| { type: "schedule_upsert"; schedule: MissionSchedule }
| { type: "schedule_remove"; id: string }
```

The `snapshot` variant gains:

```ts
schedules: MissionSchedule[]
```

Only non-archived schedules appear in the live collection. Archive emits remove after the
durable archive write. Direct occurrence history remains readable.

## File- and component-level implementation steps

### 1. Add shared protocol schemas

Extend `src/shared/protocol.ts` using shared schedule enums and existing task schema
fragments where possible.

Define:

- a normalized `ScheduleTemplateSchema`;
- one `ScheduleDefinitionSchema` reused by preview, create, and update;
- `CreateScheduleSchema`;
- `UpdateScheduleSchema`;
- `SchedulePreviewSchema`;
- `SetScheduleEnabledSchema`;
- explicit empty-object schemas for Run now and archive;
- `ScheduleHistoryQuerySchema` for `before` and `limit`; and
- inferred exported payload types used by server and web.

Validation requirements:

- required, trimmed schedule name and task title;
- non-empty intent;
- canonical field bounds consistent with dispatch for labels, model, effort, priority,
  kind, and agent;
- exactly five cron fields at the shape layer, with semantic validation still delegated to
  the Phase 2 service;
- non-empty IANA timezone string;
- V1 execution mode accepts only `local-catchup`;
- V1 runner id is null/omitted;
- preview count is 10–50;
- standby simulation either provides both ordered timestamps or neither;
- `limit` is bounded and `before` is a valid opaque/numeric cursor according to the Phase 1
  history contract; and
- bodyless actions reject unknown keys instead of hand-parsing arbitrary JSON.

Do not create a browser-only validation schema. Preview and save must accept the same
definition.

### 2. Make Registry the live schedule notifier

Extend `src/server/registry.ts`:

1. Load non-archived schedules from Phase 1 storage in the constructor.
2. Add `getSchedule`, `listSchedules`, `upsertSchedule`, and `removeSchedule` methods.
3. In `upsertSchedule`, update the map and emit `schedule_upsert`.
4. In `removeSchedule`, delete and emit only if an entry was present.
5. Add schedules to `snapshot()`.
6. Keep schedule occurrence history out of Registry.

Pass Registry as Phase 2's `ScheduleNotifier` when constructing the manager/service in
`src/server/index.ts`. Verify all notifier calls remain post-commit.

If manager construction currently precedes something Registry needs, resolve the
dependency in `index.ts`; do not let Registry own the scheduling timer or TaskManager.

### 3. Extend shared ServerEvent and SSE snapshot

In `src/shared/types.ts`:

- add `schedules` to the snapshot variant;
- add schedule upsert/remove variants;
- import schedule types from `@shared/schedules.ts` without introducing a circular runtime
  import.

The existing SSE handler should continue to send `registry.snapshot()` and forward
Registry events. Do not create new SSE endpoints.

Update every snapshot literal and test fixture exposed by typecheck. Reports may receive
the larger snapshot structurally but should not begin rendering schedules unless their
types require an explicit projection.

### 4. Add route handlers as thin adapters

Add the routes to `src/server/routes.ts`.

For each mutation:

1. Call `parseBody` with the matching protocol schema.
2. Call one Phase 2 service method.
3. Return its durable result.
4. Map known errors consistently:
   - malformed/semantic validation: 400;
   - no such or archived schedule where action is disallowed: 404;
   - edit/claim race or state conflict: 409;
   - unexpected failure: 500 with a safe message.

Specifics:

- `GET /api/schedules` may return `registry.listSchedules()` so it matches the live
  snapshot.
- preview is non-mutating; test that row counts and Registry events do not change.
- create/update rely on the service's repo canonicalization and return the canonical path.
- set-enabled recomputes the next cursor through the service.
- Run now accepts `{}` and works paused.
- archive accepts `{}`, is idempotent, and removes from live Registry only after commit.
- occurrence history validates query values and returns archived schedule context.

Add the schedule service as the final `buildApp` dependency. Make it optional only if
needed to preserve broad legacy test construction; production must always pass it, and
schedule route tests must pass a real/fake implementation explicitly. Do not silently
construct a second manager inside `buildApp`.

### 5. Add browser schedule state

In `src/web/useEventStream.ts`:

1. Import `MissionSchedule`.
2. Add `schedules: MissionSchedule[]` to `MissionState`.
3. Maintain a schedule map.
4. Replace it from `snapshot.schedules`.
5. Handle `schedule_upsert`.
6. Handle `schedule_remove`.
7. Return the collection.
8. Preserve the runtime unknown-event warning and the compile-time `never` exhaustiveness
   branch.

Do not fetch `/api/schedules` from this hook. EventSource reconnect and snapshot remain the
only catalog refresh mechanism.

### 6. Add typed browser API helpers

Extend `src/web/lib/api.ts` with:

- `previewSchedule`;
- `createSchedule`;
- `updateSchedule`;
- `setScheduleEnabled`;
- `runScheduleNow`;
- `archiveSchedule`; and
- `fetchScheduleHistory`.

Reuse the existing `request`/`fetchJson` error mapping. Preserve structured field or
conflict errors when the server supplies them.

`fetchScheduleHistory` is explicitly on-demand. Do not add an interval, effect-level
poller, or global history collection.

### 7. Add route and stream tests

Add focused test files rather than expanding one integration file without bound:

- `test/schedule-http.test.ts`;
- `test/schedule-sse.test.ts` or extensions to existing EventSource state tests;
- protocol schema tests; and
- snapshot contract tests.

Use a real Phase 2 service with an isolated DB for end-to-end route/storage behavior where
feasible, and a fake service for precise HTTP mapping.

## Data/API/migration and compatibility details

- This phase has no schema migration.
- Old browser/new daemon skew: an old browser reaches the runtime unknown-event warning and
  ignores schedule events; the rest of the dashboard remains usable.
- New browser/old daemon skew: `snapshot.schedules` may be absent at runtime despite the
  compile-time contract. Normalize an absent value to `[]` only if existing version-skew
  policy calls for it; otherwise document that bundled Electron keeps versions aligned.
- Archived schedules are absent from live state but remain available through history.
- Event ordering follows durable operations. A task may emit before the schedule's terminal
  occurrence refresh during creation; the UI must tolerate that short ordering because both
  reconnect into a consistent snapshot/history state.
- Preview and history are reads; they do not emit ServerEvents.
- The service remains the only mutation owner; Registry is the live cache/notifier, not a
  second persistence authority.
- No route leaks full task intent through logs.

## Tests and verification

Run:

```text
node --test --import tsx test/schedule-http.test.ts
node --test --import tsx test/schedule-sse.test.ts
node --test --import tsx test/schedule-manager.test.ts
node --test --import tsx test/http-integration.test.ts
node --test --import tsx test/overlay-registry.test.ts
npm run typecheck
npm run build:server
npm run build:web
```

Required assertions:

- every mutation rejects malformed bodies through `parseBody`;
- create/update canonicalize repo roots and reject invalid task roots;
- create/update reject unsupported execution modes and non-null runner ids;
- preview accepts the same definition as save and performs no writes/events;
- preview count and standby timestamps are bounded/validated;
- save paused and save enabled produce correct cursors;
- pause/resume recomputes from the correct anchor;
- Run now works paused and leaves cron cursor unchanged;
- archive is idempotent, emits remove after commit, and preserves direct history;
- invalid history cursors/limits are rejected;
- snapshot includes schedules;
- reconnect snapshot replaces stale schedule map contents;
- upsert/remove events mutate `MissionState`;
- the `useEventStream` switch remains exhaustive;
- catalog state has no polling call; and
- all existing `buildApp` call sites still typecheck and current HTTP suites pass.

`overlay-registry.test.ts` is included as a regression guard even though the new overlay is
Phase 4; this phase must not break the existing registry while adding ServerEvent state.

## Merge and exit criteria

Phase 3 may merge when:

- every listed route exists with shared zod validation;
- route handlers contain no recurrence, policy, or direct schedule SQL;
- Registry is the Phase 2 notifier and emits only after durable success;
- snapshot and both schedule event variants are complete end to end;
- `MissionState.schedules` is EventSource-owned with no poll loop;
- archived history can be fetched through its stable response shape;
- the browser API exposes every operation Phase 4 needs;
- no React surface or overlay id has been added;
- no Foreman/Electron code changed; and
- targeted suites, previous-phase suites, typecheck, and server/web builds pass.

## Downstream handoff

Phase 4 may rely on:

- `MissionState.schedules` as the sole live catalog collection;
- stable typed API helpers for every operator action;
- history responses carrying archived schedule context;
- service errors preserving field/conflict information;
- schedule health and last-occurrence summaries already being present in each live row;
- task and TaskSummary provenance already traveling through SSE; and
- no keyboard shortcut being reserved.

Phase 4 must not:

- calculate cron, DST, catch-up policy, or health thresholds independently;
- poll `/api/schedules`;
- add occurrence history to the SSE snapshot;
- bypass the overlay registry; or
- mutate a scheduled task's immutable provenance from the dispatch editor.

## Cross-phase audit record

- 2026-07-23: Re-read Phase 2 and used its service/notifier seam; routes and Registry do not
  reopen schedule policy or SQL.
- 2026-07-23: Kept archived schedule context in the history response, which satisfies the
  source plan's task deep-link requirement without adding a separate detail route.
- 2026-07-23: Added all top-level collection changes together: ServerEvent snapshot,
  Registry snapshot, MissionState, and EventSource snapshot/event cases.
- 2026-07-23: Inspected current-main's expanded `buildApp` dependencies and required the
  schedule service to append after them rather than overwrite the planning checkout's
  older signature.
- 2026-07-23: Confirmed Phase 4 needs no server-side contract changes for catalog, editor,
  preview, history, archive, task links, or attention badge.
