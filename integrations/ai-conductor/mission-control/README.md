# Mission Control visualizer for ai-conductor

A `kind: visualizer` plugin that pushes ai-conductor's events to a local Mission Control
daemon as they happen, so pipeline state on the dashboard is current rather than up to one
poll old.

It ships from the Mission Control repository, not from ai-conductor, because it is coupled to
Mission Control's ingest contract rather than to conductor's internals.

## Install

```sh
cp -R integrations/ai-conductor/mission-control ~/.ai-conductor/plugins/mission-control
```

A symlink works too, and keeps the copy current with your checkout.

Nothing else is needed on the usual setup: the plugin reads the daemon's token from
`~/.mission-control/token`, which the daemon writes with `0600` permissions on first run. It
is read on first use rather than at startup, so installing this before Mission Control has
ever run is fine - and it is read **again** whenever the daemon answers `401`, so a rotated
secret costs one refused batch rather than every batch after it. Conductor's process outlives
a daemon restart, and a daemon coming up on a fresh state directory mints a new token; nothing
tells the plugin, so the refusal is what it learns from. A token passed as
`MISSION_CONTROL_TOKEN` or to `createMissionControlVisualizer` is never re-read - that one has
a source this file knows nothing about.

| Variable | Default | When you need it |
| --- | --- | --- |
| `MISSION_CONTROL_URL` | `http://127.0.0.1:7317` | The daemon is on another port or host. |
| `MISSION_CONTROL_TOKEN` | the daemon's token file | conductor runs as another user, in a container, or on another machine. |
| `MISSION_CONTROL_WORKTREE` | resolved from the working directory | See [Which run an event belongs to](#which-run-an-event-belongs-to). |
| `MISSION_CONTROL_REPO` | unset | Same. |

**Never commit a token.** There is no configuration file here for one, deliberately.

## Live lifecycle

ai-conductor 0.104.0 starts registered `kind: visualizer` plugins on the same
`ConductorEventEmitter` that its built-in writers use, after event persistence is attached,
and awaits each plugin's bounded `stop()` during shutdown. This plugin therefore observes the
existing Conductor event spine. It does not introduce a second emitter or a second projection
authority.

Mission Control still observes Conductor's files independently. Installing the plugin changes
when the daemon learns about a transition and preserves events Conductor does not persist; it
does not change which files own run state.

The generic Engineer lifecycle is different from an implementation run. Its event already
carries a versioned Engineer run id, correlation id, attempt identity, repository, and
run-local revision. The plugin forwards that identity directly and never invents a worktree
or implementation slug. Mission Control persists an independent per-attempt cursor and uses
`conduct-ts engineer run-replay` as the durable backstop for a missed push.

## What it is for

Conductor persists 76 of its 104 event kinds to each worktree's `.pipeline/events.jsonl`.
Mission Control tails that file, so for those 76 this plugin buys **latency and nothing
else** - the same facts, sooner.

The other 28 are the point. `build_review_reduced_coverage_accepted`, `gate_verdict`,
`halt_cleared`, `pipeline_closeout`, `protected_artifact_reseal` and the rest of the
unpersisted set have no `events.jsonl` record. For those, this plugin is the only Mission
Control event record there is.

The 15 versioned `engineer_*` kinds are also forwarded. Unlike the older unpersisted
implementation kinds, they have a sanctioned durable replay journal in ai-conductor. Live
delivery buys latency for them; replay after the stored run-local revision owns correctness.

## What it will not do

It runs inside conductor's process, unsupervised, on a release train nobody at Mission
Control controls. So:

- **Handlers are synchronous and O(1).** `ConductorEventEmitter.emit()` awaits whatever a
  handler returns, so a handler that did I/O would put this plugin's network latency on the
  engine's critical path. Handlers append to an array and return; sending happens on a timer.
- **Nothing throws.** The emitter swallows handler errors, so throwing would be invisible
  here and expensive elsewhere. Failures are counted and warned about once per process.
- **The buffer is bounded** at 5000 events, oldest dropped first, because a daemon that is
  not running must not grow the memory of a process that runs for days. A batch being
  RETRIED is the exception: it sits at the front, and the ceiling is applied to the newest
  entries instead, so a delivery failure cannot discard the events it was carrying.
- **A failed delivery is retried, not discarded, for as long as the plugin is running.** The
  batch goes back to the front of the queue and is retried with backoff (up to 30s between
  attempts), so a daemon restart costs latency rather than data. The buffer ceiling still
  applies to the requeue, so a daemon that stays down costs bounded memory - it just spends it
  on the oldest events instead of discarding them at the door. A `413` is not an exception to
  this: it says the BATCH is too large, not that the events are unwanted, so the send size
  halves and the events are kept. The only genuinely undeliverable case *while running* is a
  single event over the daemon's 4 MB ceiling, which fits in no batch at any size; that one is
  dropped and counted, because retrying it would block every event behind it for ever.
- **Shutdown is bounded, and it is where "retried, not discarded" stops.** `stop()` is awaited
  by conductor's shutdown path, so the whole drain runs under a 2s deadline and the in-flight
  request is aborted when it expires. A daemon that accepts a connection and never answers
  costs the engine two seconds, not its exit. Inside the deadline a failed batch is put back
  and retried until the budget is gone, with a short growing pause between attempts that made
  no progress - a daemon being restarted refuses instantly and is usually back well inside two
  seconds, so the first refusal is not the answer. **When the deadline expires there is
  no later.** `stop()` returns, conductor exits, and whatever is still buffered goes with the
  process - the batch is in memory rather than on a retry schedule, and this plugin writes
  nothing to disk. `stats().buffered` is the count that was lost. For the 76 kinds conductor
  persists, Mission Control's file tail still has them and this is a delay; for the other 28
  it is a real loss, bounded to the case where the daemon was unreachable for the two seconds
  of the engine's exit.
- **Delivery is otherwise best-effort for the events conductor persists, and only for those.**
  An event of a persisted kind that this never delivers - the buffer ceiling dropped it, a
  conductor release added a kind this build never subscribed to - is picked up by Mission
  Control's file tail, which is why the tail is never switched off, only slowed down. For
  those events, undelivered means late. **The tail can only recover what conductor wrote
  down**, and it writes down 76 of its 104 event kinds. For the other 28 - reduced-coverage
  acceptances, gate verdicts, halt clears, closeouts, and protected-artifact reseals - this
  plugin is the only Mission Control event record there will be, so "best-effort" for them
  means exactly what it says: an event this drops is gone. That is why a failed batch is
  retried rather than trusted to the tail, and why the shutdown deadline above is the
  boundary worth knowing about rather than a footnote.

## Which run an event belongs to

The awkward part, and it is conductor's shape rather than an oversight:
`VisualizerPlugin.start(emitter)` is handed an emitter and nothing else, and a
`ConductorEvent` carries no repository, worktree or feature on it. The built-in OTel
visualizer sidesteps this by being constructed inline with the run's identity in hand; a
plugin the registry discovered has no such constructor call.

So the plugin resolves identity in this order:

1. `MISSION_CONTROL_WORKTREE`, which pins one run.
2. A `.worktrees/<slug>` ancestor of the working directory - true whenever conductor was
   started inside the worktree it is driving.
3. `MISSION_CONTROL_REPO` plus a slug the event itself names. Several kinds carry `slug`,
   `featureSlug` or `feature`; those are addressable in a daemon driving many features at
   once, and the rest are not.

If none of them answers, the plugin **forwards nothing** and says so once. A guessed
repository would be worse than silence: Mission Control drops events for repositories nobody
consented to, so the guess would not be a security hole - it would be a plugin that appears
installed, delivers nothing, and gives no way to tell why.

### Wiring it per feature

A conductor entrypoint that starts a visualizer per feature-scoped bus already holds the
worktree path (`startFeatureEventPersistence` is handed it). Passing it here removes the
guessing entirely, and is the recommended shape for the upstream lifecycle wiring:

```js
import { createMissionControlVisualizer } from '~/.ai-conductor/plugins/mission-control/index.mjs';

const visualizer = createMissionControlVisualizer({ worktree: worktree.path });
visualizer.start(featureEvents);
// ...
await visualizer.stop();
```

## The wire contract

One NDJSON line per event, posted to `POST /ingest/conductor` with `x-harness-token`:

```json
{ "repo": "/w/demo", "worktree": "/w/demo/.worktrees/a-feature", "slug": "a-feature", "seq": 12, "event": { "type": "step_completed", "step": "build" } }
```

An Engineer event uses the additive identity envelope and deliberately has no implementation
worktree or slug:

```json
{ "repo": "/w/demo", "seq": 4, "engineerRunId": "run-123", "correlationId": "commission-123", "engineerAttempt": 1, "attemptKey": "launch-123", "event": { "schemaVersion": 1, "type": "engineer_step_started", "engineerRunId": "run-123", "correlationId": "commission-123", "attemptKey": "launch-123", "attempt": 1, "previousEngineerRunId": null, "repoRoot": "/w/demo", "revision": 4, "ts": "2026-08-28T12:00:00.000Z", "step": "plan", "stepAttempt": 1 } }
```

Mission Control accepts that line only for an already bound, active commission attempt in a
repository the operator consented to observe. The envelope and event identities must agree.
Unknown v1 kinds advance the replay cursor as opaque evidence without changing projection
state. An unsupported schema preserves the last good projection and records an actionable
compatibility error.

For an implementation envelope, `event` is the engine's record, verbatim. Mission Control
stores it opaquely and reads two fields it may not carry (`type`, `ts`), so a kind newer than
either side is carried rather than refused. `seq` is this plugin's own per-run counter - Mission Control keeps it as
evidence and assigns its own ordinal, because the file tail's coordinate is a byte offset and
the two spaces are unrelated.

**The envelope is frozen.** It evolves by appending optional fields and in no other way: an
operator can be running a copy of this directory taken from a build months older than the
daemon serving it.

## Upgrading

Re-copy the directory after a conductor upgrade. `harness_version` in `plugin.yml` pins the
tested range and conductor refuses an out-of-range plugin loudly rather than starting one
that half-works. The implementation-run list is pinned to ai-conductor 0.104.0 (`1631544a`),
and the additive Engineer contract is pinned to Phase 1 at `8685e121`. Both are checked
exhaustively by Mission Control's contract suite. New event kinds are not forwarded until
this build's list is regenerated. For a kind conductor persists, the file tail picks it up on
its backfill sweep meanwhile, which is a delay and not a loss; for a new kind it does *not*
persist, nothing observes it at all until the list is regenerated. Re-copying promptly is
what keeps that window short.

The full picture is in `docs/pipelines.md` in the Mission Control repository.
