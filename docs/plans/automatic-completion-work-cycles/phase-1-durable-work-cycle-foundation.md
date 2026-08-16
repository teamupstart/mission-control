# Phase 1: Durable work-cycle foundation

## Outcome and value

Mission Control gains one durable, cross-harness identity for a completed agent work cycle. Terminal
and SDK sessions expose the same monotonic generation and completion time, duplicate idle/end noise
does not advance it, and the state survives daemon restart. Automatic prompted completion does not
change in this phase.

This gives the later cutover a stable lifecycle fact instead of asking intent or output evidence to
stand in for a completed turn.

## Entry criteria and direct dependencies

- The planning artifacts in `docs/plans/automatic-completion-work-cycles/` have merged to the default
  branch.
- Tactical task `5439ebd4-e346-4d57-b778-ecb2ebec8e67` has merged, or the pull request records why it
  was superseded and which of its regression cases were preserved.
- This phase has no implementation dependency on Phase 2.

## Scope

- Define one generic work-cycle signal behind harness adapters.
- Persist current work-cycle state with an additive migration.
- Update Registry lifecycle ingestion for terminal hook and SDK driver paths.
- Expose the current cycle to the HTTP-only Foreman consumer through a browser-safe shared contract,
  without adding UI.
- Recover current state safely across daemon restart and logical session-key rotation.
- Document the new architecture contract and test the lifecycle boundary.

## Non-goals

- Do not change prompted selection, `prompted_goal`, workflow completion claims, workflow repair
  delivery, queue drain, or direct wrap-up behavior.
- Do not add a second dispatcher, worker, event bus, or unbounded turn-event ledger.
- Do not require an agent tool call.
- Do not add a dashboard field or control.

## Repository findings and inherited contracts

- `HookSpec` in `src/server/harness/types.ts` is the correct owner for raw hook-to-generic
  translation. Claude and Codex event vocabularies must remain in their adapter modules.
- `Registry.applyHook` and `Registry.applyDriverEvent` are the two lifecycle ingress paths. The latter
  already documents `turn_done` as the same idle fact a terminal `Stop` hook carries.
- `session_events` cannot accept SDK rows without changing `hooksEverSeen`, which currently treats any
  row as proof of hooks. Use a dedicated current-state table rather than quietly changing that
  contract.
- `session_work_episodes` is task and pull-request ownership. Do not overload it with per-turn state.
- `settledIdle` remains the consumer-side ordering gate. This phase records the lifecycle edge and
  does not replace the settle window.
- Shared wire code under `src/shared/` must remain browser-safe and import no `node:` modules.

## Implementation steps

1. Add a browser-safe work-cycle summary and normalized lifecycle vocabulary in the existing shared
   and harness-owned contracts. Prefer an optional additive session projection for mixed daemon and
   worker startup compatibility. Define active and completed semantics without exposing raw
   `Stop`, `UserPromptSubmit`, or agent names to consumers.
2. Extend Claude and Codex hook adapters to report generic work activity and completed-turn edges.
   Machine task notifications still count as work activity even though Claude goal capture filters
   them from human intent. Idle notifications must not produce completed-turn edges.
3. Add an additive SQLite table for current work-cycle state, keyed by the logical session identity
   the Registry can resolve. Store a monotonic generation, whether work is active since the last
   completion, completion time, and update time. Add the matching row mapper and narrowly scoped
   accessors beside the migration path in `src/server/db.ts`.
4. Update Registry's terminal hook and SDK driver ingestion to pass through one internal transition
   helper. Work signals arm the cycle. A normalized turn end advances the generation only when work
   was armed, clears active state, persists before projection, and emits the refreshed session once.
5. Define logical key rotation and restart behavior explicitly. A `/clear` or driver rebind must not
   carry a consumed/completed turn onto a new conversation key. A daemon restart while work is active
   must retain enough state for the later turn end to advance once. Several ends without intervening
   work remain one generation.
6. Project the current summary through the existing session API shape used by the Foreman client, but
   render nothing in the dashboard. Missing state is null/absent and means consumers must fail closed.
7. Update the architecture or work-queue technical documentation to name Registry as the sole owner
   of normalized work-cycle state and to distinguish it from intent episodes and task work episodes.

The file names above are the investigated route, not a specification. Follow existing ownership and
registry patterns if the implementation reveals a more compatible placement.

## Data, API, migration, and compatibility

- The migration is additive and must work for both fresh and upgraded databases.
- Keep `session_events` unchanged unless its hook-only contract is explicitly migrated with a source
  discriminator and all readers are updated in the same pull request. A dedicated current-state table
  is the preferred, smaller route.
- The public/session field is additive and should be optional or nullable so a worker and daemon
  restarted in either order fail closed rather than crash on shape mismatch.
- Generation is monotonic within a logical conversation key. Key rotation begins a new identity; do
  not compare numeric generations across keys.
- Persist the active bit as well as the completed generation so duplicate end suppression and daemon
  restart behavior agree.
- Do not hand-edit generated protocol output. Change sources and regenerate only where the repository's
  generator requires it.

## Tests and verification

Add focused tests that prove:

- Claude terminal activity then `Stop` advances once;
- Codex terminal activity then `Stop` advances once;
- SDK working then `turn_done` has the same result;
- a machine task notification counts as work activity without becoming human intent;
- an idle notification does not advance;
- duplicate turn-end events without intervening work do not advance;
- late tool activity after a turn end does not invent a completed cycle;
- restart preserves active work and the latest generation;
- logical conversation-key rotation starts fresh state;
- fresh and upgraded databases expose the new table and preserve existing rows;
- `hooksEverSeen` behavior is unchanged.

Run at minimum:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/harness-hooks.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/sdk-cost-single-count.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/hooks-seen.test.ts
node --test --import ./test/setup-state.mjs --import tsx <new-work-cycle-tests>
npm run typecheck
npm run lint
```

Run any focused Registry, SDK store, and database migration files touched by the final implementation.
If the shared session wire shape changes build output, also run `npm run build` and `npm run smoke`.

## Merge and exit criteria

- One pull request contains the normalized contract, durable current-state migration, Registry
  ingestion, projection, documentation, and all focused tests.
- The repository is operable with Phase 1 merged alone. Prompted completion behavior remains unchanged.
- Terminal Claude, terminal Codex, and SDK paths pass the same lifecycle assertions.
- Restart, duplicate suppression, key rotation, and upgraded-database tests pass.
- Typecheck and lint pass, plus build/smoke when the shared runtime bundle changed.
- CI is green and all valid review findings are resolved before merge.

## Downstream handoff

Phase 2 may rely on:

- one shared summary type carrying logical key, generation, active/completed state as finally named;
- one Registry-owned transition path for terminal and SDK lifecycle;
- one durable accessor that reads the current generation under daemon ownership;
- the invariant that generation advances only for a completed, previously active work cycle;
- restart and key-rotation semantics pinned by tests.

Phase 2 must not add another lifecycle detector, query raw harness event names, reinterpret evidence
fingerprints as turn ids, or alter the Phase 1 generation rules to fit prompted policy.

## Cross-phase audit record

- Initial audit against the source plan: this phase owns normalization, persistence, Registry
  ingestion, restart recovery, and generic exposure. It intentionally owns no prompted behavior.
- Compatibility decision: a dedicated current-state table is preferred because adding SDK events to
  `session_events` would invalidate the hook-only any-row query. If implementation chooses the wider
  migration instead, the pull request must document and test every updated reader.
- Boundary decision: the consumer cutover stays in Phase 2. Combining it here would make lifecycle
  correctness and shipping-trigger correctness impossible to review independently after the tactical
  fix rebase.
- Phase 2 reconciliation: the consumer plan requires the final Phase 1 read shape to expose logical
  key, generation, and completion currency to both the worker snapshot and daemon transaction. That
  matches this phase's projection and accessor ownership. No Phase 2 requirement changes generation
  advancement, duplicate suppression, restart, or key-rotation semantics, so the handoff remains
  compatible without editing Phase 1 scope.
