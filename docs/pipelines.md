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
  the engine's control - a note or a label of your own belongs on a task.

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
added to the vocabulary cannot ship without one. The row is **read-only**: clearing a halt is
the engine's CLI, and those verbs arrive with the rest of the control surface. Its **Open run**
link is a real address, so a halted run opens in a second window without losing the inbox.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `MISSION_CONDUCTOR_BIN` | `conduct-ts` | The engine binary the probe resolves. Follows the usual `MISSION_` / `FLEET_` / `HARNESS_` chain. |
| `MISSION_PIPELINE_TICK_MS` | `5000` | How often consented repositories are re-read. Floored at `1000`. |
| `MISSION_PIPELINE_PROBE_TTL_MS` | `30000` | How long a cached engine probe answers the Settings route before it is re-run. Floored at `1000`. |
| `AI_CONDUCTOR_REGISTRY` | `~/.ai-conductor/registry.json` | Read **bare**, without a `MISSION_` prefix, because it is the variable the engine itself reads - a machine already configured for conductor needs nothing new. Names the file, not its directory. |

Consent itself is stored in the daemon's database (`app_config`, key `pipelines`), alongside
the Foreman, Skills, Harnesses, Task sources, Models and GitHub Inspector settings.

## Where this is going

This page describes what has landed. The
[integration plan](plans/conductor-sdlc-integration/plan.md) and its
[phase split](plans/conductor-sdlc-integration/phased-plan.md) describe the rest: control verbs
(the run detail's header and the inbox row both keep a slot for them), live event ingest, and
dispatch.
