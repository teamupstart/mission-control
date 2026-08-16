# Pipelines

Some work is not driven by a single agent taking a task from start to finish. A **pipeline
engine** walks a feature through a fixed, gated sequence of steps in its own worktree, runs
its own agents, keeps its own state on disk, and stops for a human when a gate refuses.

Mission Control does not replace such an engine and does not merge with one. It **observes**:
for the repositories an operator has consented to, it reads the engine's own state files and
projects what it finds, so pipeline work is visible beside everything else on the fleet. It
also **acts through the engine's own CLI** - see [control verbs](#control-verbs) - which is a
different thing from writing the engine's files, and deliberately so.

One engine is supported today, [ai-conductor](#ai-conductor), and the integration is built as
a provider axis (`PIPELINE_PROVIDER_IDS` in [`src/shared/pipeline.ts`](../src/shared/pipeline.ts))
so a second one is an append rather than a rewrite.

## What it will and will not do

Three rules, and each of them is load-bearing rather than cautious:

- **Never a second writer.** Nothing in `src/server/pipelines/` writes a file the engine owns.
  Engine state is lease- and CAS-guarded by the engine itself, and its CLI is the only
  sanctioned way to change it - so every [control verb](#control-verbs) spawns that CLI and
  reads what it printed. The park marker, the grant record and the pause marker are all
  written by the engine, in response, exactly as they are when a person types the same thing.
  A second program racing its atomic renames corrupts a feature; it does not merge with it.
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

Once the row exists, it holds four cards, because different things can be false and an
operator who sees no pipelines has to be able to tell which:

- **The engine** - whether the binary was found, where, which version, and how many
  repositories it says it manages. It also prints where the registry was looked for, because
  a misdirected `$AI_CONDUCTOR_REGISTRY` otherwise shows up as an empty list with no error.
  **Check again** re-runs the probe immediately rather than waiting out its cache.
- **Observe pipelines** - the master switch. Turning it off stops every repository at once
  *without forgetting which ones you chose*, so turning it back on restores exactly that set.
- **Foreman triage** - a separate switch, off by default. When both it and Foreman are on,
  Foreman may unpark only a halt classified exactly `mechanical`, through the same daemon
  action route the dashboard uses. `needs-human`, `protected-artifact`, `legacy`,
  `unclassified`, and future classes remain operator work by default. Every attempted action
  is recorded in Foreman's episode ledger through the daemon; the standalone worker never
  opens SQLite.
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
| `.worktrees/<slug>/.pipeline/events.jsonl` | The engine's event ledger, tailed incrementally by byte offset. It contributes the running token spend of a feature in flight; halts and gate verdicts come from the files above, because the engine does not persist those events. |
| `.worktrees/<slug>/.docs/shipped/<slug>.md` | What the feature COST, as the engine's own rollup committed it when the feature shipped. Read only once a run is finished, and only then. See [cost](#what-a-feature-cost). |
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

## Runs → Pipelines

The [Runs page](workflows.md#watching-a-run) gains a page-level kind tab once a repository is
being observed: **Workflows** is the page it always was, and **Pipelines** is what the engine
is driving. Both tabs carry a count.

**The tab has to be earned, and by a different fact from the Settings row.** That row is keyed
on the engine being *installed*; this tab is keyed on a repository being *read* - master switch
on, repository switched on. With nothing switched on there is no tab strip at all, the Runs
page is byte for byte the one that shipped before this feature, and nothing on it asks the
daemon anything about pipelines. Turning a repository on makes the tab appear without a
reload, and turning the last one off takes it away again in the same request.

The rail groups **per repository**, under a chip naming what the engine's own daemon is doing
there. That chip is not decoration: `waiting` and `eligible` look identical in the engine's
state file and differ only by whether anything is alive to advance the run, so the chip is
what separates "give it a moment" from "your engine daemon is not running". Within a
repository, runs are grouped by [where they sit](#where-a-run-sits) with halted first - the
only group waiting on a person - and sorted by slug inside each group, so a finishing step
never moves the row you were reaching for.

Opened without naming a run, the tab lands on **the most urgent run on the fleet**, which is
not the same as the first row of the rail. The rail is grouped per repository because that is
how it is read, but urgency does not stop at a repository boundary: a halted run in the second
repository outranks a merely building one in the first. Repository order breaks a tie inside a
group, and slug order inside that.

### One run

The detail is drawn in the **workflow run diagram's own grammar**, from the same components -
the same cards, the same seams, the same status tones - because it is deliberately the same
picture rather than a lookalike:

- a header with the live eyebrow (`DECIDE · Plan · step 10 of 22`), the engine's own key for
  the feature as the title, and chips for tier, track, where it sits, and its pull request;
- **attempt cards** where a workflow run shows its round tabs. An attempt IS a recorded
  kickback: a run with none has one attempt and draws no cards at all, and one refusal that
  re-opened several gates is one attempt rather than several;
- a horizontal **Spec → SETUP → UNDERSTAND → DECIDE → BUILD → SHIP → Pull request** strip, one
  card per phase, each step a row carrying its state and its gate's verdict. A step the run's
  tier or track skipped is drawn dashed like a disabled command rather than hidden - it still
  occupies a slot in the engine's state - and so is the engine's one retained no-op;
- labelled wires between the cards, and the **kickback rule** stated once underneath rather
  than drawn as four return edges nobody can read;
- **Gate verdicts** below the strip: one row per answer, with its reason and the step that
  re-opened it. A gate the engine recorded as a *skip* is never drawn as a pass, though the
  engine writes both as `satisfied: true`.

Gate verdicts are fetched for the run you have open rather than carried on the projection.
The projection rides every reconnect for every run on the fleet and is held under a per-run
wire budget (`test/pipeline-sse.test.ts`), so evidence travels with the one surface that
draws it and a fleet where nobody has a pipeline open pays nothing for the fact that it
exists.

Steps this build has never heard of are drawn after every step it knows, in the state the
engine reported, under an **Unknown steps** card. That is the frozen step table's tolerance
rule made visible: a conductor release that adds a step degrades this display and never
breaks the page.

## Control verbs

The run detail's header and each halted [inbox row](#a-halted-pipeline-in-the-inbox) carry the
verbs the engine offers. **Every one of them spawns the engine's own CLI**, in the consented
repository root, and is judged by what that CLI PRINTED:

| Verb | What it runs | Scope |
| --- | --- | --- |
| Start daemon | `daemon start -D` | repository |
| Stop daemon | `daemon stop` | repository |
| Pause daemon | `daemon pause` | repository |
| Resume daemon | `daemon resume` | repository |
| Park | `daemon park <slug>` | one feature |
| Unpark | `daemon unpark <slug>` | one feature |
| Grant DECIDE re-entry | `decide-grant --slug <slug> --step <step> --reason <why>` | one feature |

**The exit code is not the answer.** ai-conductor's `engineer` verbs print a usage guide and
exit 0 for a missing required flag - its own CLI reference calls that out - and a malformed
`decide-grant`, a malformed `reseal` and a slug-less `daemon park` are rejected by its argv
detectors *before* the verb runs, so what prints is a generic refusal that never mentions what
was asked for. Every verb therefore carries a predicate over the engine's output, and a clean
exit with no confirmation is reported as a failure with the engine's own words attached
(`src/server/pipelines/conductor/control.ts`). `daemon stop` is the interesting one: it prints
nothing when it works and prints its failures to *stdout*, so silence is its confirmation.

A failure shows that transcript where you pressed the button: **the exact command the daemon
spawned, and what the engine printed**, clipped to 4000 characters and scrolled inside its own
block. Without them the sentence would be "it exited cleanly without confirming this", which is
true and reads identically for a version skew, a wrong working directory and a feature the
engine has never heard of - the engine's own line about a subcommand nobody asked for is what
tells them apart. A confirmation clears itself after a few seconds; a failure stays until you
dismiss it, because a transcript on a timer is one you race rather than read.

Five things follow that are worth knowing before pressing anything:

- **Only useful verbs are offered.** The daemon verbs shown are the ones the daemon's observed
  state makes meaningful - a running daemon offers Pause and Stop, never Start. The engine
  tolerates all four regardless (`pause` on a paused daemon prints `already paused`, and that
  is treated as a success), so this decides what is useful rather than what is permitted. The
  same rule takes the feature verbs off a feature the engine has already processed: it would
  accept a park or a grant on one and print a success line, and a button whose only effect is
  that sentence is one an operator learns to distrust.
- **A grant is licensed by the halt it answers.** Park and unpark apply to any live feature -
  parking is how you take one out of the engine's hands, halted or not. A DECIDE re-entry grant
  is offered only where the halt class asks for one, which today means `needs-human`: it is a
  standing authorization for the engine to walk through a decision gate unattended, and on a
  run that never stopped at one it spends that gate before it is reached. The run header and
  the inbox read the same halt-class table, and **the daemon holds the rule too** - a grant for
  a run with no such halt is `409` from `POST /api/pipelines/action`, because hiding a button
  decides what an operator is offered, not what the loopback API accepts.
- **`plan` can never be granted, and Mission Control says so rather than relaying a refusal.**
  The picker lists every DECIDE step *except* `plan`, with the reason printed under it. A
  re-planning pass would rewrite an approved decision with nobody at the gate, which is the
  failure the re-entry gate exists to prevent; the engine refuses it in four independent
  places, and nothing is spawned to be told that.
- **A grant records why you allowed it, in your words.** The engine stores the rationale with
  `grantedBy: operator`, and that is the whole audit trail of an autonomous DECIDE re-entry -
  so the form asks, and the button cannot be pressed until it is answered. Mission Control
  never supplies a default sentence.
- **A verb re-reads the repository immediately.** Every verb changes something the projection
  reads from files, so the pass runs in the same request and the row, the rail's daemon chip
  and the inbox all move without a reload. It runs even when the verb *failed*, on both sides -
  the daemon re-projects and the surface re-reads the daemon chip it polls - because a verb
  that reported no confirmation may still have done part of its work. A failure that left the
  chip on the old state until its next poll would be the surface disagreeing with the
  projection the same request just wrote.

An inbox row offers only what its halt's class calls for - a grant and an unpark for
`needs-human`, an unpark for `mechanical`, the reseal ceremony for `protected-artifact` - and
never the repository-wide daemon verbs, because a row about one feature must not be able to
stop every feature in the checkout. That table is `PIPELINE_HALT_ACTIONS`, and it is the one
the run header consults as well: two surfaces deciding separately which verbs a run deserves
agree only until somebody edits one of them.

### Hosted consoles

Two things are not requests with answers, and both open a **terminal Mission Control hosts**,
on whichever backend you pick from the same chooser the session launchers use:

- **Open daemon console** runs `daemon connect`, which attaches to the engine daemon's own
  session read-only. Deliberately not `daemon connect --attach-into <tmux target>`: that flag
  sends an attach into a tmux pane that already exists, and hosting the terminal here means
  there is no target to mint - and no tmux, on the emulator backends.
- **Open reseal terminal** runs `reseal --slug … --path … --reason …`, optionally with
  `--clear-halt`. The engine **refuses to re-seal without a TTY** - a deliberate guard, since
  its providers feed their children through stdin, so a build agent cannot re-seal the artifact
  it was told not to touch. The ceremony therefore happens where a person can read it. It is
  offered on a run whose halt is `protected-artifact`, not permanently: a standing button for
  breaking a seal invites breaking one.

**Every `--path` must resolve inside the feature's own worktree**, and one that does not is
refused before any argv is composed - no terminal opens. This is a containment check rather
than tidying: `reseal` breaks a cryptographic seal and can be told to clear the halt that seal
raised, so a path is refused if it is absolute, if it resolves outside the worktree once `..`
segments collapse, or if a symlink in its existing prefix lands outside. What reaches the
engine is the relative path that check verified, not the string that arrived.

Both windows are held open after the command exits (`press enter to close`), because both print
their outcome and return - including the refusal an operator most needs to read.

## What a feature cost

A run in flight shows the **running total** its event ledger has reported so far, tailed by
byte offset across passes and daemon restarts. When the feature ships, that estimate is
replaced by the engine's own committed figure from `.docs/shipped/<slug>.md`, and the same
figure enters Mission Control's [spend ledger](cost-and-usage.md) as **automation** spend under
the role `ai-conductor pipelines`.

Three decisions behind that, each of which had a plausible alternative:

- **The engine's arithmetic, not ours.** Its rollup counts each dispatch once by matching a
  `provider_attempt` against the `step_completed` that followed it. A second implementation of
  that matching - incremental, in another program, over a file being appended to - is a copy of
  the engine's arithmetic that would quietly disagree with it.
- **One row per feature, replaced rather than appended.** The ledger row is keyed on the
  feature, so re-reading the same repository every few seconds - or rebuilding the projection
  from scratch - cannot double-count anything.
- **An incomplete figure is stored as unpriced, and so is a missing one.** If the engine could
  not meter every dispatch, or metered some without a price, the dollars are a subtotal. If its
  record carries no `cost_usd` line at all - an older release, a rollup that priced nothing, a
  value that does not parse - there is no figure to carry. All three record the tokens and say
  `unpriced` on the spend strip. A missing price is never read as `$0.00`: on every surface that
  is indistinguishable from a feature that genuinely cost nothing, and only one of the two is a
  claim anybody made. Every other missing line is a count, where absent and zero do mean the
  same thing, and those default to zero.

The writer id is `conductor`, appended to the ledger's writer vocabulary
([change contracts](agent-guides/change-contracts.md)); a run that has not shipped contributes
no row at all, which is a different claim from a row of zeroes.

### Links

`#/runs` and `#/runs/<run-id>` keep meaning a workflow run, exactly as before.
`#/runs/pipeline` opens the Pipelines tab, and `#/runs/pipeline/<repo>/<slug>` opens one
feature - where `<repo>` carries the provider together with the repository root, so two
engines observing one checkout cannot share a link. A link to a feature that is no longer
being observed says so and offers the Settings panel, rather than falling back to a blank
pane.

## On the fleet

An engine spawns real agents into real panes. Mission Control's discovery cards any agent
process with a tty and daemon ancestry, so those agents were already on the fleet before this
feature - as **ordinary cards**, indistinguishable from an agent waiting for your next
instruction, complete with a composer writing into a `--print` process that reads nothing at
all. This section is about telling the two apart.

**The correlation is the worktree, and only the worktree.** A discovered session whose working
directory is inside an observed run's worktree is that run's; anything else is not. Nothing is
matched on a branch name, a task, a slug in a title, or anything else the operator can type:
the engine cuts the worktree and records its path in its own state file, so containment is the
one fact both programs already agree on. Nested worktrees resolve to the **deepest** enclosing
run, and a repository root that is not itself a worktree correlates nothing - which is what
lets an ordinary agent work in the same checkout, untouched.

Two consequences worth stating, because both are deliberate:

- **Correlation follows consent.** Switch a repository off and every card in it goes back to
  being an ordinary card in the same request. Nothing about the session changes - same pane,
  same transcript, same history - it simply stops being described as an engine's.
- **Dispatched sessions are never correlated.** A session Mission Control launched itself keeps
  its composer even if it happens to sit in a conductor worktree. It is *your* agent; the fact
  that a directory has a `.pipeline/` in it does not make it somebody else's.

A correlated card carries:

- **A pipeline chip** (`⇶ add-widgets · Build`) naming the run and the step the engine is on,
  which opens the run in Runs. Two engine-driven agents on one board are told apart by the
  feature they are working on rather than by their pane ids.
- **A sentence where the composer was.** Not a disabled box - the two are different claims. A
  greyed-out composer says "not right now", which is what a busy agent's looks like, so an
  operator waits for it to come back; this one never does, because the process is running under
  `--print` and reads nothing. The card says *Driven by ai-conductor - act through its run in
  Runs* and links there. The same fact refuses the mode picker and the work queue, through one
  predicate (`messageBlockReason` in [`src/shared/pane.ts`](../src/shared/pane.ts)).
- **Its permission posture, still drawn.** Shown and no longer pickable. An agent running under
  a permissive posture must not look *safer* than it is merely because nobody can change it
  from here.
- **A frame around its run.** Sessions of one run cluster under a header naming it, on the
  board and in the console rail, exactly as an ensemble's members do. An ensemble membership
  outranks a pipeline correlation when a session somehow has both: the ensemble is a binding
  Mission Control made, the correlation is a path coincidence the engine's layout produced.

The conversation window's **Workflows** tab draws the run as a **vertical ladder** for such a
session - the same rungs and the same status chips as a workflow run's ladder, folded from the
same phase model the Runs page's horizontal strip uses, so the two surfaces cannot drift. Phase
groups are collapsible and arrive collapsed except the one the run is in: a 22-step engine drawn
flat is a column longer than the conversation beside it, and the question this pane answers is
*where has my agent got to*. The current step is haloed and says `current` in a word, not only
in styling. Its one control is **Open in Runs**.

### A halted pipeline in the inbox

A **halt** is where the engine stopped and will not resume on its own. It is the one obligation
on the machine with no session behind it - the engine stops dispatching, so the agent that hit
the gate has usually exited by the time anybody looks - which made it, before this, the most
definitively stuck thing on the fleet that the [attention inbox](attention-and-alerts.md) could
not show.

Each halted run is one row in the inbox and raises **to answer** by one. The row carries the
feature, the provider, the halt's **class**, the engine's own sentence about what stopped it,
and the runbook section that owns that class:

| Class | What it means |
| --- | --- |
| `needs-human` | Only an operator can clear it; the engine will not re-kick it. |
| `mechanical` | The engine may re-kick it on its own once the cause clears. |
| `protected-artifact` | A sealed decision artifact changed under the engine. |
| `legacy` | Raised before the engine classified halts. Read the reason and decide. |
| `unclassified` | The engine recorded no class, so nothing here guesses one. |

The class comes from the engine's own `HALT.class` sidecar; the readings and the runbook
pointers are Mission Control's, and live in
[`src/shared/pipeline.ts`](../src/shared/pipeline.ts) beside the halt-class tuple so a class
added to the vocabulary cannot ship without one. Its **Open run** link is a real address, so a
halted run opens in a second window without losing the inbox.

The row is answered **in place**, with the [verbs](#control-verbs) its own class calls for and
nothing wider. It does not disappear when a verb succeeds: unparking lets the engine dispatch
again, and it is the engine clearing the halt that resolves the row - through the projection's
own event, so what leaves the inbox is a row the daemon agrees is finished rather than one the
browser hid on its own.

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
on every tick. Everything else - the step statuses, the `HALT` marker, `DONE`, `.daemon/` -
is read on every pass regardless.

A push does not lift that. It schedules a **pass**, so the state files are folded a tick
early and the dashboard moves at once; whether that pass also reads the run's `events.jsonl`
is the demotion policy's call and nobody else's. Two reasons, and the second is the one that
matters: the pushed events are already in the ledger, written by the route before the pass
was scheduled, so tailing on their account would re-read a file to find what the daemon is
already holding - and the plugin flushes every 250ms, so "read the ledger of whatever was
just pushed" is "read it several times a second", which is a *faster* cadence than the tick
this was meant to relax, on precisely the runs it was relaxed for.

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
| `malformed` | Not a valid envelope, or naming a `slug` this repository is not driving. Counted and dropped; one bad line never fails the batch. |
| `unconsented` | For a repository this operator has not switched on. Stored nowhere. |

That last row is the one worth stating plainly: **ingest is downstream of consent.** A push
naming a repository nobody enabled is dropped, and leaves no trace on the health line. The
push path is not a second way to start observing a checkout.

**A slug has to name a run that exists.** The `slug` is checked against the worktrees the
provider is actually driving - the same listing, with the same `.pipeline/` requirement, that
the file tail builds runs from - and a push naming anything else is counted as `malformed` and
stored nowhere. This is a retention rule rather than an authenticity one: the ledger is
bounded by retiring rows alongside the runs a pass enumerates, so a row under a slug no pass
can ever produce is a row nothing would retire. When the worktrees cannot be listed at all,
the push is refused rather than trusted, and the file tail backfills whatever was turned away.
That is the opposite of the call the projection makes on the same unreadable directory, where
"we could not look" must not retire anything - and both follow from one rule: an unreadable
directory is not evidence for the durable act in front of you.

A batch over 4 MB is refused with `413`. The declared `Content-Length` is checked first, so an
oversized batch is turned away before it is read at all; the body is then measured in **bytes**
rather than JavaScript string length, because a body of multi-byte characters costs up to three
times what `String.length` reports. The producer runs unattended inside another program, and
the daemon is single-threaded.

### The ledger

`pipeline_events` records every engine event Mission Control has observed, from whichever
path observed it first. It is append-only: a row's identity, its ordinal and its body are
written once and never rewritten. The single mutation is convergence - the second path to see
an event stamps its own coordinate into `also_seq`, null to a value, once - which records an
observation rather than editing an event.

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
- **Convergence is by event, not by number - and it is claimed, not compared.** A
  `fingerprint` over the event's CONTENT is what lets two paths recognise one event:
  canonicalized by sorting keys at every level, and with the fields a *writer* adds stripped
  out first - `ts`, `activeInterval` and `observedIntervals`, listed as
  `OBSERVATION_ONLY_FIELDS` in [`src/server/db.ts`](../src/server/db.ts). Those three are not
  an implementation detail of the hash - they are what make it possible at all: conductor's
  `EventPersister` writes `{ ...event, activeInterval?, observedIntervals?, ts }`, so the
  record in `events.jsonl` and the record the plugin sends are different objects describing
  one event, and a hash over either one whole could never match the other. What the engine
  emitted is the event's identity; when it was written down, and how long the writer held it,
  are facts about the observation.
  It cannot be the whole answer even so, because conductor stamps no sequence number: a step
  that is retried emits a record byte-identical to its first attempt, so "same fingerprint"
  and "same event" are not the same question. An arriving event therefore converges onto the
  oldest row with its fingerprint that the *other* path wrote and this one has not claimed;
  when there is none, it is a new occurrence and gets its own row. Both paths see occurrences
  in order, so the Nth from one lands on the Nth from the other however they interleave.
  What this gives up is named: a path re-offering an event under a *new* coordinate - a
  rewritten `events.jsonl` whose lines shifted - stores a second row for one event. A
  duplicate row costs nothing, because nothing in the projection is derived from this table;
  a dropped event is the one thing that cannot be recovered, and for the 30 kinds conductor
  never writes down there is nowhere to recover it from.

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
| `· file tail (plugin quiet)` | The plugin has delivered here before and has stopped. The tail is back on its ordinary cadence and picks up everything conductor wrote down - which is 44 of its 74 event kinds; anything the plugin did not deliver from the other 30 was never written anywhere and is not recoverable. This is also what a revoked token or a crashed engine looks like, which is why it does not read as "never". |

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `MISSION_CONDUCTOR_BIN` | `conduct-ts` | The engine binary the probe resolves. Follows the usual `MISSION_` / `FLEET_` / `HARNESS_` chain. |
| `MISSION_PIPELINE_TICK_MS` | `5000` | How often consented repositories are re-read. Floored at `1000`. |
| `MISSION_PIPELINE_PROBE_TTL_MS` | `30000` | How long a cached engine probe answers the Settings route before it is re-run. Floored at `1000`. |
| `MISSION_PIPELINE_INGEST_LIVE_MS` | `600000` | How long after a pushed event a run still counts as live. Ten minutes because conductor emits at step boundaries and a build or a test suite runs for many of them - a shorter window would read every long step as "the plugin stopped". Floored at `1000`. |
| `MISSION_PIPELINE_BACKFILL_MS` | `60000` | How long a live run may go without a full event-ledger read. The backstop that makes demotion safe: it is what picks up events the installed plugin never subscribed to. Floored at `1000`. |
| `MISSION_PIPELINE_INGEST_REFRESH_MS` | `150` | How long a burst of pushed events coalesces before the repositories it named have their state files folded. |
| `AI_CONDUCTOR_REGISTRY` | `~/.ai-conductor/registry.json` | Read **bare**, without a `MISSION_` prefix, because it is the variable the engine itself reads - a machine already configured for conductor needs nothing new. Names the file, not its directory. |

Consent itself is stored in the daemon's database (`app_config`, key `pipelines`), alongside
the Foreman, Skills, Harnesses, Task sources, Models and GitHub Inspector settings.

## Dispatch, Inspector, and Foreman

An enabled repository adds **pipeline** to the Dispatch kind picker. Dispatch runs
`conduct-ts engineer --idea "<intent>"` in the main checkout through Mission Control's terminal
launcher, with `CLAUDECODE` removed. It never uses the Agent SDK, provisions no Mission Control
worktree, and leaves conductor in charge of agent, model, effort, and stdin. The task is a
manual dispatch surface only; backlog autopilot does not schedule it.

When a projected run first reports `pr_url`, Mission Control adopts that pull request into the
existing GitHub Inspector ledger with source `pipeline`, provided its owner and repository
match a GitHub remote configured in the projected checkout. No second review or shipping path
is created: the ordinary Inspector lifecycle, Shipped page, and shipping gates take over.

Foreman's optional mechanical triage reads halted runs over HTTP, reserves an episode through
the daemon before acting, and calls `POST /api/pipelines/action`. Exact equality with
`mechanical` is the automation gate. Any other or future class fails closed and remains in the
Attention inbox for the operator. The daemon re-checks Foreman's master switch and the separate
pipeline-triage permission on the halt feed, episode reservation, and Foreman-tagged action, so
turning either switch off closes an in-flight automation race without disabling operator verbs.
