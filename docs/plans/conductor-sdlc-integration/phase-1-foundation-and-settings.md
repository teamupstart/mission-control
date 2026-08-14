# Phase 1: Foundation and settings

## Outcome

Mission Control recognizes ai-conductor: the daemon probes for the engine, reads its per-repo
state files into a durable projection, streams that projection to the browser over SSE, and a
new Settings panel lets the operator consent per repository. After this phase an operator can
enable a conductor repo in Settings and see a live health line (engine version, daemon state,
run counts). No other UI surface changes yet; everything arrives disabled.

## Entry criteria and dependencies

- Direct prerequisites: none (first phase).
- The planning session's PR has merged, so this plan and its phase files exist on the default
  branch.

## Scope

- New `src/shared/pipeline.ts`: `PIPELINE_PROVIDER_IDS = ["ai-conductor"] as const`
  (append-only), `PipelineProviderId`, `PipelinePhase`, `PipelineStepState`,
  `PipelineHaltClass`, the `PipelineRun` interface, and `PIPELINE_PROVIDER_INFO` (label, blurb)
  mirroring `TASK_SOURCE_KIND_INFO`. Exact shapes are in [plan.md](plan.md) under "Shared
  contracts". Include MC's frozen copy of conductor's 22-step order and step-to-phase map
  (SETUP 1, UNDERSTAND 1, DECIDE 9, BUILD 5, SHIP 6, plus the four out-of-band steps) for
  display sorting; unknown step names must be tolerated and sort after known ones.
- Additive optional `Session` field in `src/shared/types.ts`:
  `pipeline: { provider: PipelineProviderId; slug: string; step: string | null } | null`, plus
  the matching `SESSION_FIELD_COMPARATORS` entry. This phase defines the contract; nothing
  stamps it yet (phase 3 does).
- Two new `ServerEvent` kinds in `src/shared/types.ts`: `pipeline_upsert { run: PipelineRun }`
  and `pipeline_remove { provider, repoRoot, slug }`, plus a `pipelineRuns` collection in the
  `snapshot` event. Handle both in `src/web/useEventStream.ts` before the never-check and store
  the collection in browser state (a `Map` keyed `provider:repoRoot:slug` or similar).
  Extend the compile-probe exhaustiveness tests the way the most recent event family did.
- New `src/server/pipelines/` module:
  - `index.ts`: `PIPELINE_PROVIDERS: Record<PipelineProviderId, PipelineProvider>` registry and
    the watch loop that, for each enabled repo, refreshes runs and emits
    `pipeline_upsert`/`pipeline_remove` on change.
  - `conductor/probe.ts`: engine binary on PATH, version, registry read (prefer the
    `engineer projects` JSON verb, fall back to `~/.ai-conductor/registry.json` respecting
    `$AI_CONDUCTOR_REGISTRY`).
  - `conductor/state.ts`: parsers for `.worktrees/<slug>/.pipeline/conduct-state.json`
    (per-step statuses, `last_step`, `complexity_tier`, `track`, `pr_url`),
    `gates/<step>.json` (`{ satisfied, reason?, checkedAt, kickback? }`), `HALT` /
    `HALT.class` / `DONE` markers, and `.daemon/` (pidfile, `PAUSED`, `parked/`, `grants/`,
    schemaVersion-1 `gated.json` and `blocked.json`). Every parser is total: malformed or
    missing input degrades to nulls, never throws out of the module.
  - `conductor/tail.ts`: byte-offset incremental reads of each worktree's `events.jsonl`,
    resumable across daemon restarts (persist offsets in the projection row).
  - `conductor/normalize.ts`: fold state plus tailed events into `PipelineRun`, including the
    `group` classification (building, eligible, waiting, halted, parked, processed).
  - The module never writes any conductor-owned file. Read-only observation in this phase; the
    CLI-spawning control surface is phase 4.
- One new table in `src/server/db.ts` `openDb()` migrations: `pipeline_runs`, the projection
  cache keyed `(provider, repo_root, slug)` (UNIQUE index; every column under it NOT NULL per
  the change contracts), storing the serialized `PipelineRun` plus the tail byte offset. The
  projection must be rebuildable from conductor's files at any time; treat a schema mismatch by
  dropping and re-projecting, never by trusting stale rows. The daemon remains the only SQLite
  writer.
- Settings: a `conductor` category in `SETTINGS_CATEGORIES`
  (`src/web/lib/settings-registry.ts`, scope `machine`) and a panel modeled on
  `TaskSourcesPanel.tsx`: detection card (engine found or not, version), master enable toggle,
  per-repo enable switches for repos the registry reports, and a health line (daemon state, run
  count). All persisted daemon-side alongside the existing daemon-backed settings. Default:
  everything off; "adding is configuration, enabling is consent".
- Server routes for the panel (`src/server/routes.ts` under `/api/`, loopback-guarded like their
  neighbors): read probe/detection state, read and write enablement.
- Fixtures: a canned conductor state tree in `e2e/fixtures/` (a fixture repo containing
  `.worktrees/<slug>/.pipeline/` and `.daemon/` files) plus a fake `conduct-ts` binary
  following the `fake-agents.ts` pattern, reusable by every later phase.

## Non-goals

- No Runs page surface (phase 2), no session stamping or attention items (phase 3), no control
  verbs (phase 4), no ingest route or plugin (phase 5), no dispatch kind (phase 6).
- No conductor-repo changes.

## Repository findings

Verified at `dc2d99a`:

- Append-only ID tuples with `Record` exhaustiveness are the house pattern
  (`TASK_KINDS`/`TASK_SOURCE_KINDS` around `src/shared/types.ts:1459`); follow it.
- `ServerEvent` is a discriminated union (around `src/shared/types.ts:2375`, 28 kinds) with a
  never-check in `src/web/useEventStream.ts` (around line 395); the compiler enforces the two
  new arms.
- `src/shared/` must stay browser-safe: no `node:` imports.
- Migrations are idempotent `migrate()` steps with `addColumn` helpers in `src/server/db.ts`;
  UNIQUE-index columns targeted by `ON CONFLICT` must be NOT NULL.
- `SETTINGS_CATEGORIES` lives at `src/web/lib/settings-registry.ts:90`; every control row needs
  a stable `data-anchor="<category>/<slug>"` (the sidebar render test fails on violations).
- Conductor facts (verified at ai-conductor `8b51392d`): `conduct-state.json` has no phase
  field (derive phase from the step map); `gated.json`/`blocked.json` carry `schemaVersion: 1`
  and are written atomically; the registry file is versioned v1; `engineer` verbs exit 0 even
  on malformed invocations, so never trust exit codes alone.

## Implementation steps

1. Add `src/shared/pipeline.ts` with the contracts above; extend `Session` and
   `SESSION_FIELD_COMPARATORS` in `src/shared/types.ts`.
2. Add the two `ServerEvent` kinds and the `snapshot` collection; fix every compile error that
   fans out (registry snapshot assembly, `useEventStream.ts` arms, exhaustiveness tests).
3. Add the `pipeline_runs` migration to `src/server/db.ts` with an upgrade test that opens a
   pre-feature database.
4. Build `src/server/pipelines/conductor/{probe,state,tail,normalize}.ts` with unit tests in
   `test/` driven by canned fixture trees (parsers, normalizer, group classification,
   rebuild-from-files, tail resumption).
5. Build `src/server/pipelines/index.ts`: provider registry, enablement config, the watch loop
   (poll cadence with cheap mtime checks is fine; use judgement), emit sites wired through the
   daemon's existing event bus.
6. Add the `/api/` routes and the Settings category and panel; persist enablement daemon-side.
7. Add the `e2e/fixtures/` conductor tree and fake `conduct-ts`; write the Playwright spec.

## Data and compatibility

- `PIPELINE_PROVIDER_IDS` is append-only from its first commit; record it in
  `docs/agent-guides/change-contracts.md` in this phase, together with the new event kinds and
  the `pipeline_runs` key.
- A database from before this phase must open cleanly; a database from this phase must open in
  a build without later phases (later tables arrive in their own phases).
- Disabled state is byte-identical to today: no probe spawns, no watch loop, no SSE traffic.

## Tests and verification

- Unit: parsers (well-formed, truncated, missing, malformed), normalizer, projection rebuild,
  tail offsets across restart, enablement routes.
- E2E (`e2e/`): Settings enable flow - open Settings, see the detection card for the fixture
  engine, enable a repo, health line reflects the fixture daemon state and run count; disable
  returns to inert. Selectors by role and label only.
- Commands: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`,
  `npm run smoke`, `npm run test:e2e`.

## Merge and exit criteria

- All Definition of done items in the project AGENTS.md.
- README and `docs/` updated for the new Settings panel and configuration.
- With conductor absent or disabled, every existing test and surface behaves exactly as before.
- One reviewable PR against `main`; its merge releases phases 2 and 5.

## Downstream handoff

Later phases may rely on, and must not change without updating every consumer:

- `src/shared/pipeline.ts` shapes and `PIPELINE_PROVIDER_IDS` (append-only).
- `Session.pipeline` field shape and its comparator entry.
- `pipeline_upsert` / `pipeline_remove` / `snapshot.pipelineRuns` semantics.
- `pipeline_runs` table key `(provider, repo_root, slug)` and rebuildability.
- The `src/server/pipelines/` module layout and the read-only guarantee.
- The `e2e/fixtures/` conductor tree and fake `conduct-ts` entry points.

## Cross-phase audit record

- 2026-08-14: initial version. Session field and comparator placed here (contract-first) with
  stamping deferred to phase 3; `pipeline_events` deliberately not created here - it belongs to
  phase 5, which owns ingest, so this phase's upgrade path must not reference it.
