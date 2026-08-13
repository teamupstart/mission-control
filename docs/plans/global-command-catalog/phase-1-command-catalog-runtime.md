# Phase 1: authoritative Command catalog and runtime cutover

## Outcome

Create the daemon-owned Global Command catalog, migrate every existing repository command into it,
add repository-neutral defaults, expose the bounded catalog through validated HTTP and the existing
SSE stream, and make workflow execution resolve from that catalog.

This phase has no intentional visual redesign. The existing Workflow Settings command editor must
remain fully operable through a compatibility projection until Phase 2 replaces it.

## Entry conditions and dependencies

- No earlier implementation phase is required.
- Read `docs/plans/global-command-catalog/plan.md` and `phased-plan.md` before editing.
- Re-read `docs/agent-guides/architecture.md` and `docs/agent-guides/change-contracts.md`.
- Inspect current `WorkflowConfig` consumers and current Persona/Session Action store-manager-route
  patterns. Treat the file names below as investigated pointers, not permission to bypass adjacent
  ownership conventions.

## Scope

### Included

- shared grouped Command view and strict update schemas;
- fresh SQLite schema and idempotent upgrade migration;
- store/manager with compare-and-swap updates and Registry notifications;
- four fixed slot projections, including empty slots;
- dedicated read/update HTTP routes;
- snapshot plus upsert SSE integration and exhaustive browser reduction;
- runtime resolution precedence: override, global default, unconfigured;
- compatibility projection and write adapter for `/api/workflows/config`;
- focused persistence, route, state, resolution, and migration tests;
- technical documentation required to keep configuration behavior accurate.

### Excluded

- Library shelf, editor, routing, or CSS;
- removing the command table from Settings;
- changing user-visible Check copy;
- new slot names, command suites, environment fields, secrets, timeouts, shell mode, or containers;
- separate Trust capabilities;
- changes to actual process spawning or check verdict semantics.

## Contracts inherited by later phases

1. Slot identities remain `test`, `lint`, `typecheck`, and `build` in the existing append-only order.
2. Graph nodes remain `kind: "check"`; attempt outcome schema and statuses remain unchanged.
3. The catalog is the only persisted command authority after migration.
4. Workflow policy remains separately owned by `checksEnabled` and `repoAllowlist`.
5. One slot update atomically replaces its nullable default argv and complete override list.
6. One grouped, bounded view per slot rides snapshot and upsert events.
7. Existing config reads and writes are a compatibility projection over the catalog, not another
   stored command list.

## Required catalog shape

Define a browser-safe view along these lines, using the repository's naming and branding
conventions after inspecting adjacent shared types:

```ts
interface WorkflowCommandOverride {
  repoRoot: string;
  command: string[];
}

interface WorkflowCommandView {
  slot: WorkflowCheckSlot;
  defaultCommand: string[] | null;
  overrides: WorkflowCommandOverride[];
  revision: number;
  createdAt: number;
  updatedAt: number;
}
```

The exact timestamp shape may follow Persona or Session Action views. The functional constraints
are fixed:

- every built-in slot is returned exactly once and in registry order;
- argv is copied at boundaries so callers cannot mutate store state;
- override paths are canonical strings and unique per slot;
- total overrides remain bounded by the current `WORKFLOW_LIMITS.checkCommands` ceiling unless a
  stricter per-slot limit is justified and documented;
- command length, argument count, empty argv, and path limits remain no looser than today;
- updates carry an expected revision and conflicts return the same status/code style as adjacent
  catalog managers.

## Persistence and migration

Add normalized SQLite ownership in `src/server/db.ts`, following the repository's fresh-schema plus
upgrade-path rule. A likely shape is one row per slot plus one row per override, with a composite
unique key for `(slot, repo_root)`. Do not add a database CHECK that would make appending a future
slot require rebuilding the table.

The store must provide, at minimum:

- list/project all slots in registry order;
- read one slot;
- replace one slot under an expected revision inside one transaction;
- seed missing built-in slot rows without altering existing ones;
- migrate legacy commands exactly once and transactionally.

Migration rules:

1. Read the stored Workflows config through the tolerant schema or an equivalently safe migration
   parser.
2. If the catalog has already been initialized or edited, do not import stale legacy entries over
   it.
3. Otherwise group every valid `checkCommands` entry by slot and insert it as an override with the
   same path and argv.
4. Leave every `defaultCommand` null. Never guess that one repository's command is machine-wide.
5. Preserve `checksEnabled`, `repoAllowlist`, `liveEnabled`, default workflow, and retention values.
6. Make a repeated startup a no-op and cover partial/invalid old blobs with safe fallback tests.
7. Once migration succeeds, new config persistence must omit or ignore the legacy command list so
   there is only one durable source.

Do not let a manager or Foreman process write SQLite outside the daemon's existing database
ownership.

## Manager, routes, and live state

Create the store and manager beside the workflow catalog modules. The manager should:

- initialize all four projected views into `Registry` during daemon startup;
- perform schema-validated CAS replacement through the store;
- emit one slot upsert only after a committed mutation;
- expose a read interface to runtime resolution and compatibility config without importing route
  or browser code.

Add strict Zod schemas in `src/shared/protocol.ts` and parse every mutation with `parseBody`. Provide
a bounded list/read route and one update route under `/api/workflow-commands` or the closest route
spelling consistent with the surrounding workflow family. Required HTTP behavior:

- list returns four slot views in registry order;
- read/update refuses an unknown slot;
- update validates nullable default plus complete overrides and expected revision;
- duplicate paths, empty argv, over-limit values, and stale revisions are visible refusals;
- update returns the committed full view.

Extend the existing live contract in all required places:

- `ServerEvent.snapshot` gains the four Command views;
- add one `workflow_command_upsert`-style event carrying a full slot view;
- `Registry` owns the map, includes it in `snapshot()`, and emits after manager writes;
- `MissionState` owns the browser map/list;
- `useEventStream` replaces it wholesale on snapshot and handles the upsert exhaustively;
- event fixtures, comparators, and snapshot tests are updated;
- no browser polling, content-free revision counter, or second catalog hook is introduced.

## Config compatibility seam

Phase 1 must not strand the current Settings form. Refactor workflow config internally into policy
plus a legacy-compatible response shape while preserving the route behavior existing callers rely
on.

Required behavior:

- `GET /api/workflows/config` composes `checkCommands` from catalog overrides only. Global defaults
  have no legacy row and therefore do not appear in that old field.
- `PUT /api/workflows/config` validates the whole current request, updates workflow policy, and maps
  the submitted legacy override list through the Command manager.
- The write is ordered or transactional so a failure cannot silently leave a response claiming
  policy and catalog state that were not both accepted. Reuse the repository's transaction/error
  patterns rather than inventing distributed rollback.
- Direct catalog writes and legacy config writes both converge on the same store and Registry
  events.
- No new command list is written back into `app_config` after cutover.
- Existing direct callers that omit fields continue to receive schema defaults exactly as current
  route tests establish.

If an implementation discovers atomic cross-owner writes cannot be expressed cleanly through the
current complete-config PUT, keep the command projection read-compatible and make the old command
field a dedicated adapter with explicit failure before policy persistence. Do not preserve two
authorities to avoid that refactor.

## Runtime resolution cutover

Refactor the pure resolution helper so execution receives the Command catalog entry and workflow
policy separately. Do not teach the runtime to query SQLite itself.

Resolution for `(slot, cwd, repoRoot, checkoutSubpath)`:

1. Evaluate only overrides for that slot.
2. Preserve all three existing applicability routes for plain checkouts, pooled worktrees, and
   checkout-relative monorepo subdirectories.
3. Choose the longest matching override path.
4. Return that argv and its working subpath.
5. If no override matches and a global default exists, return it with `workingSubpath: ""`.
6. If neither exists, return null so `runCheck` records the existing `skipped` outcome.

`runCheck` then asks the existing policy gate. Keep the ordering and semantics:

- unconfigured is reported before authorization;
- disabled Commands and untrusted repositories are `unavailable` passes with distinct notes;
- only a command that actually exits nonzero fails;
- runtime infrastructure errors remain infrastructure failures;
- the `CheckExecutionRequest` and execution implementation are unchanged unless a small type
  extraction is needed to pass the resolved working path.

Inject the manager/resolver into `WorkflowEngine` or the current runtime assembly in
`src/server/index.ts`, following existing dependency injection. No module-global store reads.

## Implementation map

Re-verify and likely touch:

- `src/shared/workflow.ts`
- `src/shared/protocol.ts`
- `src/shared/types.ts`
- `src/server/db.ts`
- a focused Command store/manager under `src/server/workflows/`
- `src/server/workflows/config.ts`
- `src/server/workflows/checks.ts`
- the engine constructor/call site that passes config into `runCheck`
- `src/server/registry.ts`
- `src/server/routes.ts`
- `src/server/index.ts`
- `src/web/useEventStream.ts`
- existing workflow config, HTTP, registry, event-stream, migration, and check-runtime tests

Do not rename the existing check execution, lease, process-group, or attempt-history modules.

## Test plan

Add or extend focused Node tests for:

- fresh database seeds four empty slot projections;
- upgrade migrates all valid old rows to overrides and no global defaults;
- upgrade is idempotent and does not overwrite an initialized catalog;
- invalid old config fails closed without taking startup down;
- CAS success and stale-revision refusal;
- atomic default and override replacement;
- duplicate path, invalid slot, invalid argv, path, and size rejection;
- HTTP list/read/update shapes and error codes;
- initial Registry snapshot and post-write upsert;
- `useEventStream` exhaustive snapshot/upsert reduction through existing test seams;
- nested override beats repository override;
- repository override beats global default;
- global default is used across repositories only after no override matches;
- nested override produces the same checkout-relative working subpath as today;
- no configured command still skips;
- disabled policy and missing Trust still report their distinct unavailable notes;
- legacy GET projects overrides, legacy PUT mutates the catalog, and no duplicate persistence
  remains.

Preserve and run existing check runtime, workflow graph, workflow HTTP, and Trust route tests. Any
fixture that constructs a full snapshot or `MissionState` must explicitly include the new bounded
collection.

## Verification gates

At minimum:

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
```

Use focused single-file tests during development with the documented `node --test --import tsx`
loader. This phase does not intentionally change visible UI, so it does not add a new Playwright
feature spec. If compatibility work changes rendered Settings behavior or copy, add the required
Playwright assertion rather than claiming the phase is backend-only.

## Merge and exit criteria

- The catalog is the only command persistence authority.
- All four slots are projected on fresh and upgraded databases.
- Existing repository commands survive as overrides with byte-equivalent argv and paths.
- Global defaults resolve after overrides and before unconfigured skip.
- Existing Settings authoring still works against the catalog.
- Snapshot and upsert events converge without polling.
- Existing process execution safeguards and workflow verdict semantics are unchanged.
- Required tests and gates pass, documentation touched by backend contract changes is accurate, and
  the phase can merge without Phase 2.

## Downstream handoff to Phase 2

Phase 2 may depend only on:

- the grouped `WorkflowCommandView` contract;
- the dedicated list/update routes;
- the snapshot/upsert-backed `MissionState.workflowCommands` collection;
- fixed slot ordering and revision semantics;
- the runtime resolution and migration being complete.

Phase 2 must not reach into the store, re-fetch a second catalog, write legacy `checkCommands`, or
change resolution and execution behavior while building the UI.

## Phase compatibility audit

- This phase is operable alone: current Settings remains the authoring surface and writes through
  the compatibility adapter.
- It owns the only destructive data transition and makes it idempotent before any UI consumes the
  result.
- It leaves graph, published version, outcome, and execution-runtime contracts untouched.
- It supplies every stable API Phase 2 needs and has no dependency on later components or copy.
