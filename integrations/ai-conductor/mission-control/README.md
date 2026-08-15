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
`~/.mission-control/token`, which the daemon writes with `0600` permissions on first run.

| Variable | Default | When you need it |
| --- | --- | --- |
| `MISSION_CONTROL_URL` | `http://127.0.0.1:7317` | The daemon is on another port or host. |
| `MISSION_CONTROL_TOKEN` | the daemon's token file | conductor runs as another user, in a container, or on another machine. |
| `MISSION_CONTROL_WORKTREE` | resolved from the working directory | See [Which run an event belongs to](#which-run-an-event-belongs-to). |
| `MISSION_CONTROL_REPO` | unset | Same. |

**Never commit a token.** There is no configuration file here for one, deliberately.

## It does nothing yet

ai-conductor's plugin registry discovers `kind: visualizer` plugins, and nothing in
production starts them - `src/index.ts` wires only the built-in OTel visualizer inline, and
the daemon entrypoint wires none. So this plugin is found, its manifest is checked, and
`start()` is never called.

That is fine and expected. Mission Control observes conductor by reading its files, which
needs no plugin at all; installing this early costs nothing and does nothing. When the
visualizer lifecycle wiring lands upstream, it begins delivering with no further change here.

## What it is for

Conductor persists 44 of its 74 event kinds to each worktree's `.pipeline/events.jsonl`.
Mission Control tails that file, so for those 44 this plugin buys **latency and nothing
else** - the same facts, sooner.

The other 30 are the point. `gate_verdict`, `loop_halt`, `halt_cleared`,
`pipeline_closeout`, `protected_artifact_reseal` and the rest of the unpersisted set reach
`daemon.log` as text and nowhere else. For those, this plugin is the only durable record
there is.

## What it will not do

It runs inside conductor's process, unsupervised, on a release train nobody at Mission
Control controls. So:

- **Handlers are synchronous and O(1).** `ConductorEventEmitter.emit()` awaits whatever a
  handler returns, so a handler that did I/O would put this plugin's network latency on the
  engine's critical path. Handlers append to an array and return; sending happens on a timer.
- **Nothing throws.** The emitter swallows handler errors, so throwing would be invisible
  here and expensive elsewhere. Failures are counted and warned about once per process.
- **The buffer is bounded** at 5000 events, oldest dropped first, because a daemon that is
  not running must not grow the memory of a process that runs for days.
- **A failed delivery is retried, not discarded.** The batch goes back to the front of the
  queue and is retried with backoff (up to 30s between attempts), so a daemon restart costs
  latency rather than data. The buffer ceiling still applies to the requeue, so a daemon that
  stays down costs bounded memory - it just spends it on the oldest events instead of
  discarding them at the door. The one exception is a `413`: that batch is too large and will
  be exactly as large next time, so it is dropped rather than parked at the head of the queue
  for ever.
- **Delivery is otherwise best-effort, and the limit of that is worth stating.** An event
  this never delivers - the buffer ceiling dropped it, a conductor release added a kind this
  build never subscribed to - is picked up by Mission Control's file tail, which is why the
  tail is never switched off, only slowed down. **But the tail can only recover what conductor
  wrote down.** For the 30 event kinds it does not persist, this plugin is the only durable
  record, which is exactly why a failed batch is retried instead of trusted to the tail.

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

`event` is the engine's record, verbatim. Mission Control stores it opaquely and reads two
fields it may not carry (`type`, `ts`), so a kind newer than either side is carried rather
than refused. `seq` is this plugin's own per-run counter - Mission Control keeps it as
evidence and assigns its own ordinal, because the file tail's coordinate is a byte offset and
the two spaces are unrelated.

**The envelope is frozen.** It evolves by appending optional fields and in no other way: an
operator can be running a copy of this directory taken from a build months older than the
daemon serving it.

## Upgrading

Re-copy the directory after a conductor upgrade. `harness_version` in `plugin.yml` pins the
tested range and conductor refuses an out-of-range plugin loudly rather than starting one
that half-works. New event kinds are not forwarded until this build's list is regenerated -
until then Mission Control's file tail picks them up on its backfill sweep, which is a delay
and not a loss.

The full picture is in `docs/pipelines.md` in the Mission Control repository.
