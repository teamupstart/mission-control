# Phase 5: Live event ingest and the visualizer plugin

## Outcome

Pipeline state updates arrive as pushed events instead of file polling: MC's daemon exposes a
token-guarded ingest route, stores conductor events in an append-only ledger, and folds them
into the projection live. The Mission Control visualizer plugin for conductor ships from this
repository, installable into `~/.ai-conductor/plugins/mission-control/`. Until the conductor-side
lifecycle wiring lands upstream (the companion phase in the ai-conductor repository), the plugin
is dormant and the phase 1 file tail keeps carrying observation; once it lands, the tail demotes
to backfill.

## Entry criteria and dependencies

- Direct prerequisite: Phase 1 (shared contracts, `pipeline_runs` projection, normalize fold,
  tail).
- Runs concurrently with phases 2, 3, 4, and 6; it shares no owned files with them beyond
  additive, non-conflicting edits to `src/server/routes.ts` and `src/server/db.ts`.

## Scope

- **Ingest route**: `POST /ingest/conductor` in `src/server/routes.ts`, placed beside
  `/hooks/:event` in the ingest family. First line: `x-harness-token` check, exactly like its
  neighbors (this family is deliberately token-only, not loopback-guarded, around
  `routes.ts:2179-2209` at `dc2d99a`). Body: NDJSON batch of Zod-validated envelopes
  `{ repo, worktree, slug, seq, event }`. Unknown event kinds are stored opaquely with
  `kind: "unknown"` rather than rejected: conductor's 74-kind event union is TypeScript-only
  and unversioned, so tolerance is mandatory. Malformed lines are counted and dropped with one
  bounded warning, never a 500 for the whole batch.
- **Ledger table**: `pipeline_events` in `src/server/db.ts` migrations, append-only, keyed
  `(provider, repo_root, slug, seq)` with `seq NOT NULL` and a UNIQUE index (the change
  contracts require NOT NULL under a UNIQUE index targeted by `ON CONFLICT`). Ingested events
  carry the producer's seq; the phase 1 tail assigns byte offsets as seq for events it
  backfills, and `ON CONFLICT DO NOTHING` makes the two paths converge without duplicates.
  The daemon remains the only SQLite writer.
- **Fold and demotion**: ingested events run through `conductor/normalize.ts` and emit
  `pipeline_upsert` immediately. When ingest is live for a worktree (events observed recently),
  the tail's poll cadence for that worktree relaxes to a slow backfill sweep; when ingest goes
  quiet, the tail resumes as primary. State-file reads (halt markers, daemon markers) continue
  regardless: files stay the source of truth and the projection stays rebuildable.
- **The plugin**, shipped from this repo under `integrations/ai-conductor/mission-control/`
  (a new top-level home for artifacts MC ships into other tools; not under `dist/`, not under
  `skills/`):
  - `plugin.yml`: `kind: visualizer`, `harness_version` pinned to the tested conductor range so
    a breaking conductor upgrade refuses loudly instead of misbehaving quietly.
  - A default-exported instance implementing conductor's `{ name, start(emitter), stop() }`
    visualizer contract. `start()` subscribes per event type over the enumerated list it was
    built with (conductor's bus has no wildcard), batches NDJSON, POSTs to
    `/ingest/conductor` with the operator's token, and swallows transport failures after one
    bounded warning - the posture conductor's own OTel visualizer takes. Event types newer
    than the plugin's build are simply not subscribed; the file tail is the backfill.
  - An install path documented in the Settings panel's Conductor page and docs: copy or link
    the directory into `~/.ai-conductor/plugins/mission-control/` with the MC base URL and
    token configured (never committed).
- **Settings surface**: the phase 1 health line gains an ingest indicator (live, backfill,
  never-seen) per repo.

## Non-goals

- No conductor-repo changes here: the lifecycle wiring that makes conductor start registered
  visualizers is the companion phase in the ai-conductor repository, dispatched separately.
  This phase must be fully operable without it (tail remains primary).
- No new UI beyond the ingest indicator.

## Repository findings

Verified at `dc2d99a` (MC) and `8b51392d` (conductor):

- The ingest family (`/hooks/:event`, `/v1/metrics`) authenticates by `x-harness-token` only;
  `requireLoopback` covers `/api/*` and `/events`, not this family. Follow the family.
- Conductor's plugin registry discovers `kind: visualizer` plugins but nothing in production
  starts them (the dormant seam): only the built-in OTel visualizer is wired inline in
  conductor's `src/index.ts`, and the daemon entrypoint wires none. The daemon bus also has no
  persister (daemon-scope events reach `daemon.log` text only), which is why the tail plus
  state files must stay authoritative even after ingest lands.
- Conductor events carry no schemaVersion; per-worktree `events.jsonl` is the durable form.

## Implementation steps

1. `pipeline_events` migration plus upgrade test (a phase 1 database opens cleanly; a
   pre-feature database opens cleanly).
2. Ingest route with Zod envelope, NDJSON batch handling, token check first line; HTTP tests
   for auth, batch, unknown kinds, malformed lines, duplicate seq.
3. Fold-and-emit path with dedupe against tail offsets; unit tests for convergence (same
   events via tail and ingest produce one ledger row and one projection state).
4. Tail demotion heuristics; unit tests for live/quiet transitions.
5. The plugin directory, built and typechecked against conductor's published plugin contract;
   unit tests for batching and failure posture run MC-side with a stub emitter.
6. Settings ingest indicator plus its spec.

## Data and compatibility

- `pipeline_events` is append-only; `(provider, repo_root, slug, seq)` never reorders or
  renames (change contracts).
- The ingest envelope `{ repo, worktree, slug, seq, event }` is the wire contract the plugin
  and the route share; it is frozen at this phase's merge and recorded in the change
  contracts. The companion conductor phase consumes it as-is.
- The route is additive; no existing route changes shape.

## Tests and verification

- Unit and HTTP tests as above; the compile-probe exhaustiveness tests are untouched (no new
  ServerEvent kinds in this phase).
- E2E: a fixture NDJSON poster feeds the ingest route and the run row updates live without
  waiting a tail poll; a bad token is refused; the ingest indicator transitions.
- Commands: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`,
  `npm run smoke`, `npm run test:e2e`.

## Merge and exit criteria

- Definition of done per AGENTS.md; docs cover the route, the ledger, and the plugin install.
- Fully operable with no conductor-side change: tail remains primary, plugin ships dormant.
- One reviewable PR. No phase in this repository depends on it; the companion conductor phase
  should be dispatched only after this merges (it needs the envelope frozen).

## Downstream handoff

- The ingest envelope and `/ingest/conductor` semantics: the companion conductor phase and any
  future provider plugin build against them; append-only evolution only.
- The `integrations/ai-conductor/mission-control/` directory as the plugin's home.
- The tail-demotion contract: ingest liveness never disables state-file reads.

## Cross-phase audit record

- 2026-08-14: initial version. Placed concurrent with phases 2-4: its only shared files are
  `routes.ts` and `db.ts`, where all edits are additive and non-overlapping with phase 4's
  action routes and cost INSERTs; either merge order is safe. Seq convergence with the phase 1
  tail (byte offsets as seq) restated here because both writers target one UNIQUE key.
