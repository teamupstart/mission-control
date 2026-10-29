# Phase 1: Resident profiles and launch

Part of [the phased plan](phased-plan.md) for [Residents](plan.md).

## Outcome

An operator can author a resident profile on the new `#/residents` page and launch it from
**Dispatch > Resident** or from the page. The launch is a task of the new kind `resident`, runs
only in the Agent SDK (Claude Code or Codex), receives the persona and instructions as standing
instructions, uses the profile's model and effort, and runs in a task worktree of the chosen
repository. After turn one it idles like `chat` and ends on **Complete & close**. There is no loop
yet; that is Phase 3.

## Entry criteria and dependencies

- The planning pull request containing this file has merged.
- No phase prerequisites.

## Scope

- Shared contracts: profile revision schema, section registry, run and launch schemas.
- Persistence: `resident_profiles`, `resident_profile_revisions`, `resident_runs` (base columns).
- Daemon: `ResidentStore`, `ResidentManager`, routes, SSE `residentProfiles` collection,
  settings-backup domain for profiles.
- Task kind `resident` with repository required (`repoAvailability: "workspace"`).
- Launch composer with the contributor registry and the persona/instructions contributor.
- Browser: `#/residents` route page with profile rail and editor (core sections), the
  Dispatch **Resident** mode, `launchResident()` helper, palette entry.

### Non-goals

Marker, pin, dock and Console band (Phase 2); loop, compaction, guardrails (Phase 3); skills and
MCP (Phases 4 and 5); session control (Phase 6); repo-less launch (Phase 7).

## Repository findings and inherited contracts

- Dispatch mode lives in `src/web/lib/dispatch-mode.ts` (`DispatchLaunchMode`,
  `DispatchOpeningSchema`, strict `DispatchModeSchema`); `DispatchLayer` in
  `src/web/components/DispatchModal.tsx` owns the toggle.
- `TASK_KINDS` (`src/shared/types.ts`) is append-only; the exhaustive registries are listed in the
  source plan. `test/task-kinds.test.ts` forbids hand-written kind sets.
- `chat` is the lifecycle precedent: `KIND_REQUIRES_EXPLICIT_WORKFLOW` and
  `automaticWrapupBlock()` in `src/server/foreman/wrapup-eligibility.ts` keep Foreman from
  completing idle work.
- `Dispatcher.dispatch` and `dispatchEmbedded` (`src/server/dispatcher.ts`) call
  `SdkSupervisor.start()` with `standingInstructions`; `standingInstructionsForLaunch`
  (`src/server/instructions/resolve.ts`) composes repository instructions.
- Profile storage follows `mission_schedules` and `mission_schedule_revisions`; editor layout
  follows `PersonaLibrary` and `PersonaEditor` (`src/web/workflows/`), with `ModelField` and the
  agent and effort selects from `ScheduleEditor`.

## Implementation steps

1. **Shared contracts** in `src/shared/residents.ts` (no `node:` imports):
   - `ResidentProfileRevisionSchema` built from `RESIDENT_PROFILE_SECTIONS`, a registry of named
     section schemas. Phase 1 registers `identity` (name, description), `persona`
     (`personaId`), `instructions` (Markdown), `execution` (`agent` limited to harnesses whose
     capabilities declare an SDK driver and are Claude Code or Codex, `model`, `effort`), and
     `workspace` (`defaultRepoRoot` or null). Later sections are optional with defaults.
   - `ResidentProfile` (id, name, revision, archivedAt, current revision body), `ResidentRun`
     (including `profileRevision` and `settings`, the pinned revision's body), and
     `LaunchResidentSchema` (`repoRoot`, optional `instructions`, optional `requestId`).
   - The pinned-revision rule: a live run's settings come only from its pinned revision. The
     current revision is used for new launches and to flag "profile changed since launch".
   - Request schemas in `src/shared/protocol.ts` for create, update (with `expectedRevision`),
     archive and launch; every route uses `parseBody`.
2. **Task kind.** Append `resident` to `TASK_KINDS`. Answer every exhaustive registry: label and
   accent in `TASK_KIND_INFO`; `TASK_KIND_BEHAVIOR.resident` with `repoAvailability:
   "workspace"`, `launch: "harness"`, `autopilot: false` and a constraint string; no diff, no
   backlog, null workflow default, null contract, no capture, explicit-workflow-required, no
   Mission MCP tools yet (Phase 3 adds one), and a guided key. Refuse `resident` in `DispatchSchema`, `McpCreateTaskSchema`, schedules and task
   sources: residents are created only by the resident launch route.
3. **Persistence** in `src/server/db.ts`: create the three tables in the fresh schema and in
   `migrate()`; `resident_runs` base columns are `id`, `profile_id`, `profile_revision`,
   `task_id`, `persona_snapshot` (JSON: persona id, name, guidance at launch), `run_instructions`,
   `created_at`, `ended_at`. No `REFERENCES`; indexes after columns exist.
4. **Store and manager** in `src/server/residents/`:
   - `store.ts`: CAS create, update, archive, read by id, list live, and
     `revision(profileId, revision)` for any pinned revision; revisions immutable.
   - `manager.ts`: `ResidentManager.launch(profileId, input)` validates the profile, repository
     and harness SDK support, snapshots the persona, writes the run, then creates the task
     through `TaskManager.create` with kind `resident`, runtime forced to SDK, model and effort
     from the profile, and intent equal to the opening turn (Phase 1: "Begin your standing task.").
     It returns task and run. A failed task creation leaves no live run.
   - Run end: subscribe to the existing durable task completion and `session_remove` paths to
     stamp `ended_at`; add the startup twin required by the architecture guide.
5. **Launch composer** in `src/server/residents/launch.ts`: `RESIDENT_LAUNCH_CONTRIBUTORS`, an
   ordered list whose entries add to the SDK launch. Phase 1 registers `personaInstructions`,
   which appends a resident section (persona guidance, profile instructions, run instructions)
   after `standingInstructionsForLaunch`'s output and records it through the existing
   `session_standing_instructions` path. The dispatcher asks the composer for resident tasks at
   one call site; it never branches on harness ids.
6. **Routes** in `src/server/routes.ts`: `GET /api/residents/profiles`, `POST` create,
   `PATCH /:id`, `DELETE /:id` (archive), `POST /:id/launch`. SSE: a bounded `residentProfiles`
   collection (live profiles, capped at 200) with a `resident_profile_upsert` and
   `resident_profile_remove` pair; exhaustive cases in `src/web/useEventStream.ts`, snapshot and
   `registry.snapshot()` updated, an explicit `LINE_INPUT_EVENTS` decision (not a member).
7. **Settings backup**: a `resident-profiles` domain in `SETTINGS_BACKUP_DOMAINS` and a catalog
   in `src/server/settings-backups/catalogs.ts`, with counts, preview and restore that write a new
   revision and archive rows absent from the snapshot.
8. **Browser**:
   - `src/web/residents/launch.ts`: `launchResident(profileId, input)`, the only launch call.
   - Route `#/residents` (and `#/residents/:profileId`) in `useWorkflowRoute.ts`, an
     `AppPageShell` entry, an `ACTIONS` keybinding and a palette provider row. Not a
     `PAGE_SEGMENTS` entry.
   - `ResidentsPage` with a `LibraryRail`-based profile list and `ResidentProfileEditor`, which
     renders `RESIDENT_EDITOR_SECTIONS` (Phase 1: identity, persona, instructions, execution,
     workspace) and a **Launch** button.
   - Dispatch: add `"resident"` to `DispatchLaunchMode`, `DispatchOpeningSchema` and
     `DispatchModeSchema`; Resident mode shows profile cards, repository, optional run
     instructions, a read-only launch summary and **Edit profile**, and submits through
     `launchResident`.
9. **Documentation**: `docs/residents.md` (profile, launch, lifecycle), and the third mode in
   `docs/dispatch-and-backlog.md`, the glossary, the README feature list, and the new registries
   and identifiers in `docs/agent-guides/change-contracts.md`.

## Compatibility

Existing databases gain three empty tables. Unknown task kinds still degrade to `ship` on read,
so a downgraded build reads a resident task as `ship`; this matches the existing kind policy.

## Tests and verification

- `node --test --import ./test/setup-state.mjs --import tsx` on new `test/residents-*.test.ts`:
  schema round-trips and section defaults, CAS conflicts, archive, launch validation
  (unsupported harness, missing repository, Pi refused), persona snapshot, standing-instruction
  composition and resume replay from the pinned revision after the profile is edited, kind
  registry answers, refusal of `resident` on other creation
  paths, upgrade from a pre-feature database, backup capture and restore.
- `test/task-kinds.test.ts`, `test/keybindings.test.ts`, `test/tooltip-coverage.test.ts` stay green.
- Playwright `e2e/specs/residents-launch.spec.ts` with the fake agents: create a profile on
  `#/residents`, launch it from Dispatch > Resident, see the session with its persona section,
  and **Complete & close** it; `expectContentClearsBorder` for the Dispatch mode.
- `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke`, `npm run test:e2e`.

## Exit criteria

A resident authored in the UI launches into the SDK with persona, instructions, model and
effort; it never auto-completes; it ends cleanly through **Complete & close**; profiles survive
a daemon restart and a settings backup round trip.

## Downstream handoff

Later phases rely on, and must not change: `ResidentManager.launch` as the only launch path,
`launchResident()` as the only browser launch call, the pinned-revision rule and
`ResidentStore.revision`, the three registries
(`RESIDENT_PROFILE_SECTIONS`, `RESIDENT_EDITOR_SECTIONS`, `RESIDENT_LAUNCH_CONTRIBUTORS`), the
run row as the durable identity, and the standing-instructions placement.

## Cross-phase audit record

- Written first; owns every registry the concurrent phases extend.
- Repository required here by design; Phase 7 owns relaxing it.
- Final audit: every source-plan requirement and recorded decision maps to exactly one phase in
  the index's decision table; Phases 2 to 7 extend only the registries named here.
- Repair round 1: the pinned-revision rule and `ResidentStore.revision` are owned here, so
  every later runtime reader inherits one source of live settings.
