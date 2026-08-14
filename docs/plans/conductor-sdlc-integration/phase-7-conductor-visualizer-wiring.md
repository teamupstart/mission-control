# Phase 7: Conductor visualizer lifecycle wiring (ai-conductor repository)

## Outcome

ai-conductor starts the visualizer plugins its registry already discovers, in both entrypoints.
This is the one upstream change the integration needs: it turns the dormant plugin seam into a
live one, so the Mission Control visualizer plugin (shipped by phase 5) begins pushing events to
`POST /ingest/conductor`, and MC's file tail demotes to backfill.

## Repository and scheduling

**This phase lands in the ai-conductor repository, not in ai-harness.** It cannot be scheduled
from the planning session (`create_task` files tasks in the calling session's repository), so it
is dispatched deliberately from the Mission Control dashboard with the ai-conductor repository
attached. It produces one pull request, in ai-conductor, through conductor's own spec-first
intake like any feature there.

If it merges without its siblings: nothing breaks anywhere - conductor starts zero registered
plugins for operators who installed none, and MC keeps observing via the file tail. If phase 5
merges without this phase: equally nothing breaks - the MC plugin ships dormant. The two are
independent merge units coupled only by conductor's already-published visualizer contract and
the ingest envelope phase 5 freezes, which is why this phase should be dispatched only after
phase 5 has merged.

## Entry criteria and dependencies

- Phase 5 merged in ai-harness (the ingest envelope `{ repo, worktree, slug, seq, event }` is
  frozen and the plugin exists to be started).
- No dependency on phases 2, 3, 4, or 6.

## Scope

- Start registered `visualizer` plugins in `src/index.ts`: build the started-visualizer list
  beside the built-in OTel visualizer's inline wiring, start each discovered plugin with the
  event emitter, stop them on shutdown.
- Give `daemon-cli.ts` the same start/stop-with-flush pass over the daemon bus (which today
  wires no visualizers at all).
- Failure posture: a plugin that throws on start is logged and skipped; a plugin that throws
  in a handler is detached after bounded warnings. A misbehaving visualizer must never stall
  or crash the engine or the daemon.
- Respect the existing `harness_version` gate in plugin discovery: an out-of-range plugin is
  refused loudly, not started.
- Optional companions to propose in the same intake (conductor's reviewers decide): a
  `seq`/`schemaVersion` field on persisted events, and declaring the working but undeclared
  `daemon pause`/`resume` verbs in the help tree.

## Non-goals

- No MC-specific logic in conductor: the wiring is generic over the visualizer contract. No
  event-schema changes beyond the optional companions. No new plugin kinds.

## Repository findings

Verified at ai-conductor `8b51392d`:

- The plugin registry discovers six plugin kinds including `visualizer`
  (`{ name, start(emitter), stop() }`, per-type `.on()` subscription, no wildcard), but no
  production code path starts discovered visualizers: `src/index.ts` wires only the built-in
  OTel visualizer inline, and `daemon-cli.ts` wires none.
- The daemon bus has no persister (daemon-scope events reach `daemon.log` text only), so
  daemon-side visualizer wiring is the only way daemon-scope events leave the machine.
- The event-spine convention: extend the union, never build a parallel channel. Starting
  registered visualizers is inside the seam's documented intent.

## Implementation steps

1. Extract the start/stop-with-flush pattern the OTel visualizer already gets, generalize it
   over `registry.list('visualizer')`.
2. Apply it in `src/index.ts` and `daemon-cli.ts`.
3. Tests per conductor's own conventions: a stub visualizer records lifecycle and events in
   both entrypoints; a throwing visualizer is contained.
4. Follow conductor's spec-first intake (this repo runs the harness on itself).

## Tests and verification

- Conductor's own suite and gates; the stub-visualizer lifecycle tests above.
- Manual verification against MC: with the phase 5 plugin installed and a token configured,
  events arrive at a local MC daemon and the run row updates live.

## Merge and exit criteria

- One reviewable PR in ai-conductor, green on conductor's CI, merged through its intake.
- With no plugins installed, behavior is byte-identical to today.

## Downstream handoff

- None in ai-conductor. In ai-harness, no scheduled phase depends on this; its merge upgrades
  phase 5's ingest from dormant to live automatically.

## Cross-phase audit record

- 2026-08-14: initial version. Kept as a single-repo ai-conductor phase rather than a
  multi-repo merge unit with phase 5: the coupling contract (visualizer API) is already
  published by conductor, both halves are independently operable, and each PR is reviewable
  alone, which fails the test for forcing one merge unit.
