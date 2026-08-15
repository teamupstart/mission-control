# Pipelines

Some work is not driven by a single agent taking a task from start to finish. A **pipeline
engine** walks a feature through a fixed, gated sequence of steps in its own worktree, runs
its own agents, keeps its own state on disk, and stops for a human when a gate refuses.

Mission Control does not replace such an engine and does not merge with one. It **observes**:
for the repositories an operator has consented to, it reads the engine's own state files and
projects what it finds, so pipeline work is visible beside everything else on the fleet.

One engine is supported today, [ai-conductor](#ai-conductor), and the integration is built as
a provider axis (`PIPELINE_PROVIDER_IDS` in [`src/shared/pipeline.ts`](../src/shared/pipeline.ts))
so a second one is an append rather than a rewrite.

## What it will and will not do

Three rules, and each of them is load-bearing rather than cautious:

- **Read only.** Nothing in `src/server/pipelines/` writes a file the engine owns. Engine
  state is lease- and CAS-guarded by the engine itself, and its CLI is the only sanctioned
  way to change it. Control verbs - pause, park, grant, resume - arrive in a later phase and
  will spawn that CLI rather than edit its files.
- **Absent by default, then off by default.** An operator with no engine installed and
  nothing configured sees **no Conductor UI at all** - no Settings row, no panel, no
  command-palette entry, and `#/settings/conductor` falls back the way an unknown category
  does. Once the engine is found on the daemon's `PATH` the category appears, and everything
  in it is still off:
  detection is automatic, consent is not. With nothing switched on, a watch tick reads one
  config value and a `PATH` walk once a minute, and no probe spawns, no file is opened and no
  event crosses the stream.
- **The engine's files are the source of truth.** The `pipeline_runs` table is a cache, in
  the same family as the archive index: every column is derived from files still on disk, so
  deleting it costs one refresh pass. Nothing may be stored there that is not already under
  the engine's control - a note or a label of your own belongs on a task. This holds when
  events are being *pushed* too: see [Live events](#live-events).

## Settings → Conductor

**The category has to be earned.** Mission Control looks for the engine binary on the
daemon's `PATH`; on a machine that has never had one and has never been configured, there is
no Conductor row in the Settings rail, no panel behind it, and no palette entry -
`#/settings/conductor` falls back to the default category the way an unknown category does.
That is the plan's criterion, and it is keyed on *installed* rather than on *enabled*: a row
offering to observe software somebody does not have is a new thing on their screen however
off it ships.

The check is a `PATH` walk rather than a probe, so it costs no subprocess, and the watch loop
re-runs it about once a minute - installing conductor makes the row appear while you are
still looking for it, with no restart.

**The complete condition is "an engine on `PATH`, OR any stored Conductor configuration."**
That second half is what keeps the row reachable after the engine is removed, and it counts
the master switch as well as the repository list - so a fleet that once turned Conductor on
and later uninstalled the engine keeps the surface that can turn it off again, even with no
repository configured. Withdrawing consent must never require reinstalling software to reach
the switch. Only the case where the engine is absent *and* nothing was ever configured
produces no UI at all.

Once the row exists, it holds three cards, because three different things can be false and an
operator who sees no pipelines has to be able to tell which:

- **The engine** - whether the binary was found, where, which version, and how many
  repositories it says it manages. It also prints where the registry was looked for, because
  a misdirected `$AI_CONDUCTOR_REGISTRY` otherwise shows up as an empty list with no error.
  **Check again** re-runs the probe immediately rather than waiting out its cache.
- **Observe pipelines** - the master switch. Turning it off stops every repository at once
  *without forgetting which ones you chose*, so turning it back on restores exactly that set.
- **Repositories** - one row per repository, each with its own switch and a health line
  naming the engine daemon's state and the number of pipelines found, halted ones called out.
  A row that is not being read names the control that would change that, and the two ways of
  being off are not the same sentence: with the master switch off it says so, because a row
  whose own switch is visibly checked must never be told to switch it on.

Listing a repository is configuration; switching it on is consent. Withdrawing it takes
effect in the same request: the projection rows, the live catalog entries and the health line
all go at once, rather than on some later tick.

A repository that the engine has since de-registered stays listed while its consent stands -
otherwise the consent would be in force with nothing on screen that could withdraw it.

## ai-conductor

Verified against ai-conductor `8b51392d`. Mission Control reads, per consented repository:

| Path | What it is |
| --- | --- |
| `.worktrees/<slug>/` | One feature's worktree. The slug is the plan stem, which is the engine's own canonical key. Directories with no `.pipeline/` (its spec-authoring and autoresolve worktrees) are not pipelines and are skipped. |
| `.worktrees/<slug>/.pipeline/conduct-state.json` | Per-step statuses as flat top-level keys, plus `last_step`, `complexity_tier`, `track` and `pr_url`. |
| `.worktrees/<slug>/.pipeline/gates/<step>.json` | One gate's verdict. A `skipped: ` reason prefix marks a step that was skipped rather than one whose evidence passed. |
| `.worktrees/<slug>/.pipeline/HALT`, `HALT.class` | Why it stopped. The first non-empty line of `HALT` is the reason; an absent or unrecognised class reads as `unclassified`. |
| `.worktrees/<slug>/.pipeline/DONE` | The engine's converged marker. |
| `.worktrees/<slug>/.pipeline/events.jsonl` | The engine's event ledger, tailed incrementally by byte offset. It contributes the token spend per step; halts and gate verdicts come from the files above, because the engine does not persist those events. |
| `.daemon/` | At the **repository** root, not inside a worktree: the pidfile, `PAUSED`, `parked/`, `grants/` and `processed/`, all shared by every feature in that repository. |

Mission Control ships a **frozen copy** of the engine's 22-step sequence and its four
out-of-band steps, for display order and phase grouping only. It is never an authority: a
step name this build does not know renders in the state the engine reported and sorts after
every known one, so a conductor release that adds a step degrades the display and never
breaks the page.

### Where a run sits

Each run is classified into one group, and the precedence is deliberate:

| Group | Means |
| --- | --- |
| `parked` | An operator set it aside. Outranks everything, including a halt - they saw the halt when they parked it. |
| `halted` | A gate refused and the engine stopped. Outranks an in-progress step, because a run that halted mid-step is not still working. |
| `processed` | It converged, was marked complete, or the engine daemon recorded it shipped. Below `halted`: finished and then refused is not finished. |
| `building` | A step is running now. |
| `waiting` | Nothing is running and nothing will be - the engine daemon is paused, or none is running in this repository. A step still marked `in_progress` counts as waiting when no daemon is alive, because that marker outlives the process that wrote it and a crashed daemon leaves one behind for good. A *paused* daemon is the exception: pause is honoured between steps, so a step already in flight really is still `building`. |
| `eligible` | Nothing is running and something could start. |

The last two look identical in the state file and differ only by what `.daemon/` says. That
is the distinction an operator acts on: one means "give it a moment" and the other means
"your engine daemon is not running".

## Live events

Reading files on a cadence always works and needs nothing installed. It also means Mission
Control finds out that a step finished up to one tick after it did. A **visualizer plugin**
closes that gap: the engine tells Mission Control what happened, as it happens.

The plugin ships from this repository, under
[`integrations/ai-conductor/mission-control/`](../integrations/ai-conductor/mission-control/) -
a directory of artifacts Mission Control ships *into other tools*, which is why it is not
under `dist/` (not a build output) and not under `skills/` (not something an agent reads).

**Installing it changes nothing about what is true, only about when it is known.** With the
plugin installed, uninstalled, misconfigured or crashed, the projection is folded from the
same files by the same code. That is not a safety margin - it is the design, and the reasons
are in the engine rather than in caution:

- ai-conductor does not persist every event it emits. Its halts, its gate verdicts and its
  `halt_cleared` never reach `events.jsonl` at all, so a reader that took them from events
  would never see one. They come from state files, on every pass, whatever the plugin is
  doing.
- Its event bus has no wildcard subscription, so the plugin subscribes to an enumerated list
  built when it was copied. A conductor release that adds an event kind emits something the
  installed plugin never asked for - and that event still reaches `events.jsonl`.

So the file tail is never switched off. What live ingest changes is its **cadence**: while
events are arriving for a run, its event ledger is read on a slow backfill sweep instead of
on every tick, and a push reads it immediately. Everything else - the step statuses, the
`HALT` marker, `DONE`, `.daemon/` - is read on every pass regardless.

### The route

`POST /ingest/conductor`, in the same token-guarded ingest family as `/hooks/:event` and
`/v1/metrics`: `x-harness-token` on the first line, no loopback check.

The body is NDJSON - one envelope per line - because the producer is a visualizer inside
somebody else's event loop, appending a line per event and flushing what it has:

```json
{ "repo": "/w/demo", "worktree": "/w/demo/.worktrees/a-feature", "slug": "a-feature", "seq": 12, "event": { "type": "step_completed", "step": "build" } }
```

`event` is stored verbatim and read for two fields it may not carry (`type`, `ts`). Nothing
validates its shape: conductor's event union is TypeScript-only, unversioned and seventy-odd
members long, so a schema here would be a second copy of a contract with no first copy, and
its first effect would be to refuse the events of a conductor release newer than this build.
A record naming no `type` is stored under the kind `unknown`.

The route answers `200` with counts rather than `204`, because the plugin's whole failure
posture is to swallow transport errors quietly - so posting a batch by hand and reading these
back is how an operator finds out whether their install works:

| Count | Means |
| --- | --- |
| `received` | Lines the batch contained. |
| `stored` | Events new to the ledger. |
| `duplicate` | Already observed, by an earlier push or by the file tail. |
| `malformed` | Not a valid envelope. Counted and dropped; one bad line never fails the batch. |
| `unconsented` | For a repository this operator has not switched on. Stored nowhere. |

That last row is the one worth stating plainly: **ingest is downstream of consent.** A push
naming a repository nobody enabled is dropped, and leaves no trace on the health line. The
push path is not a second way to start observing a checkout.

A batch over 4 MB is refused with `413` before it is parsed - the producer runs unattended
inside another program, and the daemon is single-threaded.

### The ledger

`pipeline_events` records every engine event Mission Control has observed, from whichever
path observed it first. It is append-only: a row is inserted or ignored, never updated and
never re-keyed.

It is the only thing this integration stores that is *not* re-derivable from the engine's
files, and that is exactly why it exists - conductor's daemon-scope events reach `daemon.log`
as text and nowhere else, so for those the push is the only durable record there is.

Two details are worth knowing before reading the table:

- **The key is `(provider, repo_root, slug, seq)`, and `seq` is Mission Control's own.** The
  two paths see the same events by two unrelated coordinates: the tail's is a byte offset
  into `events.jsonl`, the plugin's is a counter of its own, and conductor stamps no sequence
  number on anything. Keying on a producer's number would mean one space where two unrelated
  ones were being written - so a pushed event whose counter happened to equal an old byte
  offset would be dropped as a duplicate. What each producer said is kept beside the row.
- **Convergence is by event, not by number.** A `fingerprint` over the record with its keys
  sorted is what makes one event one row however many times it is seen. Two observations that
  hash apart cost one extra row and nothing else, because nothing in the projection is
  derived from this table.

Retention: a run's events are retired with the run - a worktree the engine tore down, or a
repository whose consent was withdrawn - plus a cap of 2000 events per run, newest kept. The
table is bounded by the runs that still exist rather than by how long the daemon has been up.

### Installing the plugin

Copy or link the directory into conductor's plugin home, and give it this daemon's URL and
token:

```sh
cp -R integrations/ai-conductor/mission-control ~/.ai-conductor/plugins/mission-control
```

Configuration is by environment, never by a committed file. The token is read from Mission
Control's own state directory by default, so on the usual single-machine setup there is
nothing to copy:

| Variable | Default | Meaning |
| --- | --- | --- |
| `MISSION_CONTROL_URL` | `http://127.0.0.1:7317` | The daemon to post to. |
| `MISSION_CONTROL_TOKEN` | read from `~/.mission-control/token` | The shared secret. Set it explicitly when the engine runs as another user or on another machine. |

**Until ai-conductor starts the visualizer plugins its registry already discovers, this
plugin is dormant** - it is found, its manifest is read, and nothing calls `start()`. That
wiring is a separate change in the ai-conductor repository. Installing the plugin before it
lands is harmless and does nothing; the file tail carries observation exactly as it does
today.

The Settings health line says which of the three states a repository is in:

| Clause | Means |
| --- | --- |
| `· file tail` | No plugin has ever pushed here. The shipped state, and the permanent one for anyone who has not installed it. |
| `· live events` | Events are arriving now, so the tail has relaxed to its backfill sweep. |
| `· file tail (plugin quiet)` | The plugin has delivered here before and has stopped. Nothing is lost - but this is also what a revoked token or a crashed engine looks like, which is why it does not read as "never". |

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `MISSION_CONDUCTOR_BIN` | `conduct-ts` | The engine binary the probe resolves. Follows the usual `MISSION_` / `FLEET_` / `HARNESS_` chain. |
| `MISSION_PIPELINE_TICK_MS` | `5000` | How often consented repositories are re-read. Floored at `1000`. |
| `MISSION_PIPELINE_PROBE_TTL_MS` | `30000` | How long a cached engine probe answers the Settings route before it is re-run. Floored at `1000`. |
| `MISSION_PIPELINE_INGEST_LIVE_MS` | `600000` | How long after a pushed event a run still counts as live. Ten minutes because conductor emits at step boundaries and a build or a test suite runs for many of them - a shorter window would read every long step as "the plugin stopped". Floored at `1000`. |
| `MISSION_PIPELINE_BACKFILL_MS` | `60000` | How long a live run may go without a full event-ledger read. The backstop that makes demotion safe: it is what picks up events the installed plugin never subscribed to. Floored at `1000`. |
| `MISSION_PIPELINE_INGEST_REFRESH_MS` | `150` | How long a burst of pushed events coalesces before the runs it named are read. |
| `AI_CONDUCTOR_REGISTRY` | `~/.ai-conductor/registry.json` | Read **bare**, without a `MISSION_` prefix, because it is the variable the engine itself reads - a machine already configured for conductor needs nothing new. Names the file, not its directory. |

Consent itself is stored in the daemon's database (`app_config`, key `pipelines`), alongside
the Foreman, Skills, Harnesses, Task sources, Models and Inspector settings.

## Where this is going

This page describes what has landed. The
[integration plan](plans/conductor-sdlc-integration/plan.md) and its
[phase split](plans/conductor-sdlc-integration/phased-plan.md) describe the rest: a Pipelines
tab on the Runs page with its own diagram, recognition of engine-driven sessions on the fleet,
halts as attention items, control verbs, live event ingest, and dispatch.
