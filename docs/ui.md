# The Line (the pipeline strip above the fleet)

A permanent strip sits above every fleet layout: **intake → backlog → working → review
→ decide → shipped**. Six stages, wired left to right, each carrying a glyph, a count and one
sentence - the fleet's whole pipeline in one glance, in the order work actually moves through
it. A stage turns **amber when it is waiting on you**, and the wire feeding it lights with it.

It draws at one of two **densities**, and the shipped default is the shorter one:

| Density | Band | What it draws |
|---------|------|---------------|
| **Condensed** (default) | ~38px | One row of six segments: glyph, name, count. No sentences, no wires. Whatever is amber has its sentence promoted to the right of the row, beside that stage's glyph. |
| **Expanded** | ~86px | Two rows: the same six stages as cards, each with its sentence underneath, wired left to right. |

The strip is `flex: none` inside a shell that does not scroll, so the **~47px** between the
two is handed straight to the conversation pane below - about 11% more of the window on a
900px-tall display. Condensing hides no facts: every count, colour and drawer is unchanged,
and each stage's sentence stays in its tooltip and in its accessible name.

Fold it with the **caret at the right of the strip**, with <kbd>Shift+L</kbd> from the fleet,
or from **Settings → Display → The Line**. All three write one per-machine preference
(`app_config.ui.lineDensity`), so it survives a reload and cannot disagree with itself.

| Stage | The count is | The sentence says | Amber when |
|-------|--------------|-------------------|------------|
| ⇊ **Intake** | Enabled [task sources](dispatch-and-backlog.md#task-sources-pulling-work-into-the-backlog) plus enabled [Recurring Missions](recurring-missions.md#recurring-missions) | When the most recent source last swept, and when the next mission is due | A source failed its last sweep, or a mission's health is `attention` |
| ☰ **Backlog** | Tasks with status `backlog` | What [autopilot](work-queues.md#backlog-autopilot-foreman-schedules-the-fleet) would take next, and how many are blocked | Nothing in the backlog is ready - every item is [parked](dispatch-and-backlog.md#hold-a-backlog-item-back) or waiting on a prerequisite, so capacity will never clear it |
| ▶ **Working** | Sessions that have not exited | The split: needs you / working / idle | Any session needs you - the same [`reportBucket`](sessions.md#session-status-colors) the Roundup counts with |
| ⌁ **Review** | [Workflow runs](workflows.md#watching-a-run) that are not `completed`, `cancelled` or `failed` | The workflow doing most of them, then the split: **`N needs you · N stalled`** | A run is `blocked`, or its session action is parked on one of the three wait reasons only a person can clear |
| ⧉ **Decide** | [Ensemble runs](ensembles.md#multi-agent-ensembles) that have not finished | Which strategy, how many artifacts are ready, or who it is waiting on | The daemon flagged the run (`awaiting_decision`, a failure, or a member sitting on your answer) |
| ⚑ **Shipped** | Pull requests your agents adopted **this week** | The **per-PR cost** from today's [cost telemetry](sessions.md#cost-telemetry) | Never. Shipping is not an obligation |

Two windows on the Shipped stage, and it says which is which: the count is the **week**,
because a Monday morning would otherwise read as zero on a fleet that shipped four things on
Friday, while the per-PR figure is **today's** - the only window `FleetCost` offers, and
dividing a day's spend by a week's pull requests would mean nothing.

**Review says its amber half as two numbers**, because one was a lie of aggregation. A fleet
of 32 live runs where one wanted an answer and 31 were dead read as `32 waiting on you`, which
is a figure nobody can act on - so it became the reason to ignore the strip rather than the
reason to open it. It now reads `1 needs you · 31 stalled`: **needs you** is a run a person's
answer still moves, **stalled** is a run that is `blocked` and will not resume from here. The
two are mutually exclusive and add up to exactly the old single figure - a run that is both
blocked *and* parked on your answer counts as **stalled**, because the attempts behind that
question were cancelled when it blocked, so answering it moves nothing. The Review drawer's
header prints the same two numbers from the same fold, and the stage stays amber while either
is non-zero.

**The strip never computes anything.** Every count, sentence and tone is folded on the daemon
and pushed as one `line_summary` SSE event, change-gated exactly like the cost figures - so an
unchanged fleet emits nothing. That is not an implementation detail: two of the six stages read
inputs that never cross the wire at all (task-source sweep recency, the GitHub Inspector's adoption
ledger), and every other stage reuses the daemon's *existing* derivation - `reportBucket`,
`readyBacklog`, `ensembleNeedsAttention`, `deriveScheduleHealth` - rather than inventing a
second opinion that agrees until it doesn't.

Clicking a stage either opens a **drawer** in place or takes you to the surface that already
reads it:

| Stage | Click opens |
|-------|-------------|
| ⇊ Intake | **Drawer** - every task source and recurring mission, with its health line |
| ☰ Backlog | **Drawer** - the queue in the order you arranged, which is the order autopilot takes it in, with the triage moves on each row, escalating to the [Sitrep](attention-and-alerts.md#roundup) |
| ▶ Working | The fleet, with the filter cleared, so the count and the sessions agree again |
| ⌁ Review | **Drawer** - one ladder per live run |
| ⧉ Decide | **Drawer** - the condensed decision dossier, one row per live ensemble, with confirmed cancellation; its header also counts unacknowledged failed runs until they are dismissed from the full ensemble page |
| ⚑ Shipped | **Drawer** - the week's adopted pull requests, newest first, escalating to the [Ship log](library-and-line.md#the-ship-log) |

Hovering a stage gives you what it is for, plus its sentence in full - at either density, and
when expanded the visible line is clipped to one row so the strip's height never moves. The
strip holds a fixed height **per density**: what changes the band is pressing the caret, never
a workflow name getting longer or a stage going quiet. The flowing dots on the wires respect
`prefers-reduced-motion`: with it set, the wires stay and the dots go - condensed draws no
wires at all, so the setting does not arise there.

### The stage drawers

A drawer opens **between the strip and the board**, pushing the board down; closing it hands
the space straight back. It is not an overlay and it is not inside a layout. The supported
session layouts keep their geometry in every drawer state, which the geometry tests measure.

- **Toggle.** A second click on the same stage closes it. So does <kbd>esc</kbd>, and so does
  the **✕** in its header. Clicking a *different* stage swaps the content in place rather than
  closing and reopening. Only one drawer is ever showing.
- **The cap is hard.** The body is capped at three rows, or 38vh on a short window, whichever
  is smaller, and scrolls inside itself past that. Every row is still in the panel - the cap is
  on the drawer, not on the list - so nothing is silently dropped from a triage surface. A
  drawer can never bury the board.
- **Keyboard.** Focus moves into the drawer as it opens and returns to the stage button when it
  closes. <kbd>esc</kbd> closes it only while the keyboard is inside it or on the strip, so a
  drawer left open while you work in the console reader does not eat the <kbd>esc</kbd> that
  hands the keyboard back to the rail - and any modal above it takes the key first.
- **Leaving the fleet closes it.** Every route out - "Open run", "All ensembles →", the topbar -
  drops the drawer, so returning to the fleet does not resurrect a panel you had finished with.

Each drawer is a **triage projection**, and **none of them reads run detail** - a drawer that
fetched one detail per row would fire N bounded HTTP reads on a single strip click. Review,
Decide and Backlog are drawn entirely from state the fleet already holds - the SSE summaries,
the task list, and the backlog plan Foreman polls every four seconds - and fetch nothing at
all. **Intake and Shipped each make exactly one read**, on the click that opens them and never
otherwise, because their inputs never cross the wire: task-source health and the GitHub Inspector's
adoption ledger are the two stages the daemon folds from data the browser has no copy of. Both
therefore hold **three** states rather than two - loading, failed, and the answer - since
`fetchJson` resolves null on every failure, and a drawer that read that as "nothing here" would
report an unreachable daemon as a healthy empty intake or a quiet week.

Review, Decide and Backlog can also *act*. Review acts only where the summary by itself proves the run
has stopped and the route needs no argument beyond the run id - which is what keeps `Reattach`
(needs a session), resolving a delivery (needs a delivery and a choice) and disabling a
reviewer (needs a stage member) on the full page, one click deeper. Decide can cancel a run
after confirmation because the summary carries everything the generic ensemble cancel action
needs; decisions, retries and member actions remain on the full dossier. Backlog carries the three
moves triage is actually made of, each on a route that already existed: dispatch, the
enable/disable switch, and the priority picker. **A refused request is reported on the drawer
and the row stays** - on both of them, for the same reason: a triage surface that dropped a row
on a failed call would be lying about the queue it is describing.

| Drawer | Each row says | Escalates to |
|--------|---------------|--------------|
| **Review** | The session, the workflow and version, the repair round, a compact pipeline of chips (evidence → reviewers → session action → GitHub Inspector), and what the run is doing - **including why it stopped**, as `Blocked · session gone`. A run stopped on *you* is marked amber; a run that has stopped and will not move on its own is marked red. Three or more runs stopped for the *same* reason are one bar instead of three rows. A run an ensemble handed off wears its **⧉ from an ensemble** provenance, which opens that ensemble | The one remedy that run's state actually takes - `Dismiss`, `Retry`, `Resubmit`, `Restart…`, or `Dismiss all` for a bar - then `Open run` → `#/runs/:id`, `All runs →` → `#/runs`, and `Bind a workflow…` opens the binding dialog |
| **Decide** | What was at stake, elapsed, the candidate progress dots, and what the run wants next. The ones awaiting an answer sort first. A terminal failure remains in the header attention count until **Dismiss failure** acknowledges it without deleting its history | `Decide` (awaiting an answer) or `Open full dossier` → `#/ensembles/:id`, `All ensembles →` → `#/ensembles` |
| **Backlog** | One queued task: its title (which reopens the [Dispatch](dispatch-and-backlog.md#dispatch-an-agent) form over it), its kind, agent and age, and the marks for its state: **next up**, what it is waiting on, **parked**, and the amber [missing repository-trust notice](dispatch-and-backlog.md#resolve-missing-repository-trust-for-autopilot) when live autopilot lacks a required grant. The ready band is in [the order you set](dispatch-and-backlog.md#the-backlog-order-is-the-one-you-set), so the top row is what autopilot takes next; blocked and parked follow. **next up** is a button: it opens the [planner](#the-autopilot-planner), which says what Foreman knows about that row | `Launch now` dispatches it into a fresh worktree, the switch parks or resumes it, the picker sets its priority, a dead prerequisite resolves from the row it is blocking, and **Manage trust** opens the existing Trust matrix. The footer carries the [autopilot switch and its readout](#the-autopilot-planner), and `Sitrep →` opens the [Roundup](attention-and-alerts.md#roundup) |
| **Intake** | Each source's last sweep and what it filed, or the error it failed with; each mission's cadence, next firing, and health | `Settings` → task sources, `Open` → [Recurring Missions](recurring-missions.md#recurring-missions) |
| **Shipped** | One adopted pull request: its merge state as a **mark and a word** (merged / open / gone), its title - falling back to the branch, then to its own number - over `owner/repo#N`, the session that opened it, and when. Newest adoption first, over the same rolling seven days the count above it is folded from. Chips in the header split the week **All / Merged / Open / Gone** with their counts, and are toggles | The pull request itself on GitHub, and `Ship log →` → [`#/shipped`](library-and-line.md#the-ship-log) |

#### The Backlog queue

**The Backlog drawer answers the stage's own promise, which the Sitrep never did.** The stage
sentence says *what autopilot would take next, and how many are blocked* - a claim about one
list in one order - and the click used to open the [Roundup](attention-and-alerts.md#roundup), a whole-fleet report
that carries a backlog section on the way past. The drawer is that list instead: the **ready**
band is `readyBacklog` verbatim, the same derivation `backlog-machine.ts` schedules from and
the same one the strip's sentence is folded from, so the row wearing **next up** is the task
the autopilot actually takes next and not a second opinion about it. **Blocked** and **parked**
follow, each row saying why in the [same words the board card uses](dispatch-and-backlog.md#hold-a-backlog-item-back).

**The bands carry no captions over them**, and that is the cap's doing rather than an
oversight. The body is capped at *exactly* three rows so that it ends on a row boundary and no
half-row peeks over the edge; two captions inside that budget leave 2.2 rows showing, and the
sliver reads as a broken panel rather than a capped one. So the bands are said three other
ways, none of which costs the body a pixel: the header counts them, every row wears its own
state as a mark, and each band is a **named list** for a reader who cannot see the marks.

The header counts `4 ready · 1 blocked · 1 parked`, dropping whatever is zero, and goes amber
with **nothing ready** on exactly the strip's own condition: items are queued and none of them
can start, so capacity will never clear it. **Only ready rows carry the priority picker** - a
row that cannot run is a row whose triage mark has nothing to inform yet - while a
parked row keeps its switch and a row blocked by a cancelled or failed prerequisite keeps the
[resolve button](dispatch-and-backlog.md#resolve-a-stopped-dependency), which targets the dead task and so releases
every dependent rather than just that row. A task that is both parked *and*
blocked is filed under **parked**, because that is the half you can clear from here, and its
row prints both marks so resuming it does not silently fail to reach the ready band.

An eligible row whose repositories are not all allowlisted uses a third, single-line identity
slot for its amber notice, including on a row that also says `after X`. The line names the
missing grants, keeps **Manage trust** inline, and ellipsizes without changing the fixed row
height or three-row drawer cap. Parked rows keep their own explanation; persisted launch
errors win the slot instead of gaining a second notice.

#### The autopilot planner

The drawer says *what* autopilot would take next by putting the queue in
[your](dispatch-and-backlog.md#the-backlog-order-is-the-one-you-set) order and marking its
head. The head is the head **because that is where you put it** - so the panel behind the
mark is not a justification of the position, it is what Foreman knows about the task
sitting in it. The panel is anchored under the mark and carries four things:

- The task itself - priority, title, kind and agent, and an excerpt of its intent.
- **Foreman's own recorded reason**, quoted and attributed. Every plan entry has carried a
  `reason` since the [autopilot](work-queues.md#backlog-autopilot-foreman-schedules-the-fleet) shipped;
  this is the first surface that shows it. It explains the task's *dependencies*, not its
  position - the plan supplies edges and the position is yours. When the plan named the
  task but recorded no reason, the panel says that; when the plan does not name it at all,
  the panel says so rather than implying a decision nobody made.
- **The computed facts**, checkable against the rows behind the panel: its priority and how
  many ready items carry a higher one, its age and whether it is the oldest, that nothing
  upstream blocks it, and how many tasks finishing it would unblock. These deliberately do
  not flatter the queue: priority does not decide position, so a `low` task legitimately
  leads a `blocker`, and the panel reports that rather than claiming the top row is the
  most important one.
- **`Launch now`**, the same dispatch the row carries. The panel closes on the click; the
  drawer stays, and the row leaves the ready band when the daemon says so.

There is no *skip once*: the autopilot's cooldowns are in-memory worker state rather than an
operator concept, and the deferral that *is* one is the [park switch](dispatch-and-backlog.md#hold-a-backlog-item-back)
on the row behind the panel. <kbd>Esc</kbd> closes the planner first and the drawer second -
one press per layer - and a click anywhere outside it, or a scroll, puts it away.

**The footer says whether anything is going to act on that order at all.** It carries the
backlog autopilot's switch and a live readout: `Autopilot on · 2/3 agents · takes the top row
on its own`, or `full, waiting for one to free up`, or `nothing ready to take`, or - armed
behind a Foreman that is off or not in Live mode - `nothing launches until Foreman is live`.
It is **the same switch** as **Auto-schedule the backlog** in the
[Foreman popover](work-queues.md#backlog-autopilot-foreman-schedules-the-fleet): one config field, one
route, either surface. The readout deliberately does not repeat the header's
ready/blocked/parked counts, which are the same three numbers stated forty pixels above it.

#### The Review drawer's rows

**A Review row is named by whoever it is, not by whatever is left.** A workflow run outlives
the session it reviewed - when a session is removed the run is blocked and its live name goes
with it - so the row falls back in three steps: the live session's name, then the title the
binding captured when it was bound, then the conversation key. Only the third is an id, and it
is drawn as one rather than as a title.

**Runs that stopped for the same reason fold into one bar.** Thirty-one rows that all read
`Blocked · session gone` are not thirty-one facts, and scrolling them is the reader's whole
budget for the surface. At **three or more** sharing a `phase`, Review draws a single bar
saying the reason once, counting them once, naming the first three and counting the rest
(`Run 1 · Run 2 · Run 3 · +27`), with one **Dismiss all**. **Two is still two rows** - a pair
is not a pile, and folding it would save one line while costing you both rows' chips, round
counters and remedies. Only `blocked` runs fold: a live run and a run parked on *your* answer
are the rows you came for, and neither is ever put behind a caret. The bar's **caret expands
it in place**, so every member is still reachable - the drawer's cap is on the panel, never on
the list.

**Everything Review can do is destructive-safe.** `Dismiss`, `Restart…` and `Dismiss all`
confirm first, in the same dialog and the same words the run page uses; `Restart…` still
demands the exact phrase the daemon does, and `Dismiss all` **echoes the count** it is about
to end. A refused request is reported on the drawer itself and the row stays - a triage
surface that dropped a row on a failed call would be lying about the fleet. `Dismiss all`
fires one cancel per run through that same per-run route rather than a batch one, so a partial
failure is reported as one - `2 of 30 runs could not be dismissed` - the cancelled runs leave,
the refused ones stay, and the bar recounts from what is actually still there.

Only `Dismiss` batches. `Restart…` demands a typed phrase each time and batching it would
launder thirty deliberate acts into one; `Retry` fires provider calls, and a batch button is a
way to fire thirty of them by accident. A bar over runs with no argument-free remedy at all -
five runs holding GitHub Inspector findings, say - still earns its place by saying the reason once,
and carries no control.

Two chips the Review drawer deliberately cannot draw: **how many** reviewers a run has, and a
stage the run has not reached. A run summary carries no graph, so "reviewers 2 of 4" would be
a denominator invented in the browser - the row says who is reviewing right now and points at
the run for the rest. Chips for a session action or a GitHub Inspector gate appear only when the run
actually has one, which makes their absence informative rather than grey furniture. A run
whose session disappeared shows **Reviewers stopped** in grey rather than an amber
**Reviewers**: those attempts were cancelled where they stood, so they are not waiting.

## Report product feedback

The ☺ glyph in the topbar's tool cluster - beside Settings and Alerts - and **Report product
feedback…** in the palette's **Do** group open the same dialog. There is one of it, and one
draft behind it, so it does not matter which door you use.

The form is five report types (**Bug**, **Feature request**, **Documentation**, **Usability**,
**Other**), a one-line title, and a details box whose prompt changes with the type while
keeping whatever you have already written - deciding halfway through that this is a usability
problem rather than a bug should not cost you the paragraph that made that clear.

**Everything you write here becomes a public GitHub issue.** The warning saying so is the
first thing in the dialog and never scrolls away. Do not paste credentials, customer data,
file paths, or anything out of a private repository.

Before the button lights up, the dialog shows you exactly what will be published: the target
repository, the title, the three labels, the environment line, and the rendered issue body.
None of that is composed in your browser - it is fetched from Mission Control, which is also
the only thing that chooses it. The browser sends a type, a title and details, and nothing
else. See [Public product issue reporting](security.md#public-product-issue-reporting) for
what the environment line may contain and what it never contains.

**Publishing takes two presses and a system dialog.** **Report publicly** does not publish. It
asks Mission Control to confirm, and Mission Control puts a system dialog in front of you naming
the repository and quoting your title, defaulting to Cancel. Say no and nothing is published and
your draft is untouched. Say yes and the button renames itself to name that repository - **Publish
to owner/name** - with a line beside it saying the same. That second press is the one that files a
public issue, and nothing is fetched in between, so what you read is what goes. Editing anything
takes the confirmation back and the button returns to **Report publicly**; so does leaving it for
two minutes.

**A daemon running outside the desktop app cannot publish.** It has no way to show you that
dialog, so it says so when the form opens rather than at the moment you press. The full public
body is still on screen, so you can file it yourself. See
[Public product issue reporting](security.md#public-product-issue-reporting) for why the
confirmation cannot live in the browser.

**Screenshots are visibly unavailable.** The region is there, and it explains why: the GitHub
CLI has no first-party attachment support yet, and [cli/cli#13256](https://github.com/cli/cli/issues/13256)
tracks it upstream. Paste, drag-and-drop and file selection are all inert until that lands.
Describe what you saw in Details instead.

Your draft **survives closing the dialog**. Close it to go and re-read the thing you are
reporting and the words are still there when you come back. Two things clear it: **Clear**,
which you press on purpose, and a confirmed submission, after which the next opening starts
empty because that report is already filed.

Four things can come back, and they are deliberately different:

| Outcome | What you see | What to do |
| --- | --- | --- |
| **Reported** | The target repository and a **View GitHub issue** link | Nothing. The draft is retired; reopening starts fresh |
| **Refused** | What GitHub CLI objected to, with the draft untouched | Fix it and confirm again - nothing was published |
| **Cannot report** | The specific missing piece - `gh auth login`, an unreachable repository, a label the target does not have | An operator fixes the configuration; the button stays disabled until preflight passes |
| **Unknown** | "Check the target repository before reporting this again", and a disabled button | Go and look. The issue may or may not exist, and a second press is how a duplicate gets filed under your name |

In [demo mode](demo-mode.md) the form opens and refuses: nothing is ever published from a
demonstration.

## The palette (⌘K)

<kbd>⌘</kbd><kbd>K</kbd> is the connective tissue across the primary pages: **one input** over
everything the [Library](library-and-line.md#the-library) holds, everything the [Line](#the-line-the-pipeline-strip-above-the-fleet) is running, and
every [setting](skills-and-settings.md#settings). Type a few letters and land on the shelf card, the live run, or
the control - from wherever you are.

It opens **over whatever page you are on** and never navigates to open. <kbd>Esc</kbd>, a
click on the dimmed backdrop, or <kbd>⌘</kbd><kbd>K</kbd> again closes it and leaves the page
exactly as it found it. The chord is rebindable like every other shortcut
(**Settings → Keyboard**); the search box at the top of the Settings rail opens the same
palette, and shows the current chord as its hint.

Results are grouped by what pressing <kbd>Enter</kbd> will *do*, and every row wears a **kind
chip** and a second line saying what the thing is, or what it is doing right now:

| Group | Kinds | The second line says |
| --- | --- | --- |
| **Jump to** | `page`, `workflow`, `run`, `ensemble`, `persona`, `action`, `mission` | The authored fact for an asset (version and reviewer count, provider and model, cadence); the **live state** for a run or an ensemble - the same sentence its own page reads, and for a run the session it is reviewing, so four runs of one workflow are four different rows |
| **Do** | `strategy`, `command` | Launch an ensemble on a strategy, dispatch an agent, bind a workflow to a session, open a blank draft on a Library shelf, [report product feedback](#report-product-feedback), or start a guided tour |
| **Settings** | `setting` | The category and what the control does, plus its current value where the palette can flip it |

Rows that need an answer - an ensemble awaiting your decision, a mission that is unhealthy, a
workflow whose draft will not validate - are **amber and sort to the top of their group**, so
searching doubles as a status check. Nothing here is recomputed in the browser: an ensemble's
attention flag, a mission's health and a run's status sentence are all read from the surfaces
that already own them, so the palette can never describe a run differently from the run page it
takes you to.

| Key | Does |
| --- | --- |
| <kbd>↑</kbd> <kbd>↓</kbd> | Move the selection. <kbd>Home</kbd> and <kbd>End</kbd> jump to the ends |
| <kbd>Enter</kbd> | Open the selected row - or flip it, for a settings toggle the palette can flip in place |
| <kbd>Tab</kbd> | Filter by kind. It cycles through the kinds in the current results and back out to everything, so the same key clears it. The active filter is named beside the caret |
| <kbd>Esc</kbd> | Close, without going anywhere |

Matching is **plain substring** over each row's title, its state line, its kind and its
keywords - so the same query always returns the same rows in the same order, no fuzzy
guessing. Before you type anything it previews what needs you, then everything you can start.

Two things it deliberately does not do. It **never fetches**: every row is built from the live
SSE collections the dashboard already holds, so typing a letter is not a network event and the
palette can never be more stale than the page beside it. Production rows **only open doors that
already exist**: every production "Do" row lands on the same modal a button somewhere else
opens, and every "Jump to" row on a route the app publishes. The temporary tour row below is
the explicit comparison-spike exception.

The `page` kind has exactly one member, and that is a statement about the app rather than an
unfinished list: the [Ship log](library-and-line.md#the-ship-log) is the only full page with no door in the
permanent chrome. The one door it does have is two clicks inside the fleet - the Line's ⚑
Shipped stage opens its [drawer](#the-stage-drawers), whose header escalates here - so
<kbd>⌘</kbd><kbd>K</kbd> and its hash are how it is reached from anywhere else in the app.
Fleet, the Library, Runs and Scouts are one press of the segmented control away, and a
palette row beside a visible door would only be a second door. Scouts has one anyway,
because the words an operator reaches for - investigation, findings, evidence, research -
are none of them the page's name; that row is a static destination, and the archive
catalog itself is searched inside the page rather than indexed into the palette.

Archived assets are not indexed, because the shelf a hit would land on does not list them.
Task sources appear under Settings rather than as their own kind, which is where the Library's
Sources card points too. Sessions and backlog tasks are not searchable kinds yet - a run row
borrows its session's name, but that is a label, not an index - and they are the next kinds
the provider registry behind the palette is built to take.

### Guided tours

Mission Control runs at most one tour at a time, from one engine. A tour is a **definition**
registered under a `TourId`: its stops, what each stop needs on screen, what it says while
that is still arriving, and where it goes when the fleet moves underneath it. Everything a
tour is discovered through is derived from that registration - the Settings rail's **Help &
tours** footer draws one row per registered tour, the palette's **Do** group draws one command
row per registered tour, and both hand the engine a tour id. There is no per-tour Settings
row, palette provider, overlay, controller, or target registry.

Three engine properties are worth stating because tours are written against them:

- **The engine's cursor is a stable stop id plus a beat, not an index.** Driver's own active
  index updates only after a transition commits, and React state can arrive inside that
  window, so the engine keeps its own cursor authoritative and a refresh cannot land the
  operator on a different stop than the one they asked for. Driver is still *told* an index -
  it has no other vocabulary - but that index is derived from the cursor at the moment of the
  call rather than stored, so a definition that gains, loses, or reorders a beat cannot
  renumber a cursor out from under a running tour.
- **A stop may spotlight up to two elements in turn.** Back and Next walk those beats before
  they walk stops, while the progress rail counts stops - so a two-look stop reads as one step.
- **A stop may deliberately have no target at all**, which renders a centered card that still
  offers Back, Next, and Exit tour.

Semantic targets are namespaced by the tour that owns them (`see-work:line`), so two tours can
want the same target name without either one spotlighting the other's. Each target declares
whether it is page-scoped or task-scoped beside its name; a task-scoped target registers only
the owner belonging to the task the active run created.

Starting a tour is a **preflight**: the entry route transition runs before any tour state is
committed, so a dirty draft raises the existing leave dialog with no tour active and the
ordinary route flow owns the answer. Only a transition the app accepted commits a run.

Each tour's own task family is addressed by tour id -
`POST /api/tours/:tourId/dispatch`, `/preview`, and `/tasks/:id/complete`. The body still
chooses only a repository; the daemon's tour registry fixes the prompt, agent, model, kind,
Workflow posture, and MCP tool list. An unknown tour, or an operation a tour did not declare,
is refused before any task is created rather than falling through to general dispatch, and
cleanup refuses a task whose title, labels, and intent prefix are not the recipe's own.

Three tours are registered, and none stores progress or resumes. A fresh profile starts
**See the work** once automatically, then records that the orientation has been shown so it
does not reopen over later work. Exiting one restores the page, the asset, and the control it
started from, and each tour can always be started manually at stop one.

The tour names, stage titles, stage descriptions, and stage definition lists have one authored
location per tour: [`tours/see-work.md`](../tours/see-work.md),
[`tours/library.md`](../tours/library.md), and [`tours/setup.md`](../tours/setup.md). Their H1 is
the tour name, each H2 is a stage title,
and the prose below it is the stage description. Edit those Markdown files and run
`npm run tours`; `src/web/tour/content.generated.ts` is generated build input and is never
edited by hand. Navigation, readiness, fallbacks, and button behavior remain in the matching
TypeScript definition because they are executable tour behavior rather than editable copy.

#### See the work

**See the work** starts automatically once for a fresh profile, or from the Settings rail's
**Help & tours** footer and **Start See the work tour** in the palette's **Do** group. It teaches
the operating half of the product and runs an isolated evaluation of `driver.js@1.8.0`. It has
no resume state, new top-bar control, or chapter beyond this one guided sequence:

1. **Fleet and the Line** spotlights the permanent pipeline strip.
2. **Board View** switches through the existing layout owner and spotlights the real Board.
3. **Session detail** opens an existing session's Board drill-in and describes Conversation,
   Work queue, Workflows, Diff, and Files as one desk. When the tour starts on an empty fleet,
   it launches one fixed temporary Chat conversation in the first available repository while
   the first two stops are shown, then opens that real session here. The prompt asks only for
   a short orientation to the five desk surfaces and explicitly forbids tools, commands, and
   file changes. If the Chat launch, session, or target is unavailable, the same labelled
   dialog is centered and keeps Back, Next, and Exit tour available.
4. **Open Dispatch** spotlights the existing Dispatch control, then opens the real modal.
5. **Choose the kind** spotlights the modal's existing Kind selector and explains Chat as an
   open-ended conversation, Scout as an investigation without a diff, Plan as a reviewed plan
   that can schedule its work, and Ship as delivery of a reviewable change.
6. **Brief ready** fills and spotlights the real task input while the modal keeps Repo and Crew
   visible. The temporary tour draft is isolated from the operator's saved Dispatch draft.
7. **Choose what follows** spotlights the real **After work** selector with **None** selected
   and explains that Workflows run reusable review and follow-up steps after an agent finishes.
8. **Dispatch the task** spotlights the real **Dispatch now** button without dimming the rest
   of the form. The operator clicks that button to schedule one fixed read-only Ship task on
   Codex pinned to `gpt-5.6-terra`. This is a real model call and can spend model tokens. On an
   empty fleet, the temporary Chat conversation is a separate real model call using Codex's
   configured default model. Each temporary daemon route accepts only a repository; it owns
   the prompt, kind, and no-Workflow posture. Only the Ship route grants the required
   `request_input` MCP tool.
9. **Working** spotlights that task's real Board tile while its session runs.
10. **Needs You** follows the same tile when the agent's review request reaches the existing
   Mission Control review channel.
11. **Choose and submit** opens the real review modal and pauses until the operator selects an
   option and submits. The response tells the demo session to do no more work.
12. **Idle** follows the tile after the answered session settles.
13. **Complete or run a retro** spotlights the existing detail action row and explains that a
   retro keeps the task open while the session proposes memories for review.
14. **Complete the tour** opens the real Complete dialog with `Tour demo` prefilled as its
   generic Outcome note. The dialog shows **Run a retro first** and **Complete & close**, but
   keeps both inert during the tour. **Complete tour** records the fixed outcome and closes the
   session without running a retro.

The tour skin echoes the Line rather than introducing a new product surface. An amber frame
traces the active area, while the coachmark uses the existing panel tokens, a quiet amber wash,
and a fourteen-segment pipeline rail in its header. Past segments stay muted amber, the current
segment glows, and the footer keeps Exit separate from the Back and primary actions.

The run snapshots the complete route, layout, selection, Board drill-in,
filter, and open Line drawer before it moves anything. The route is the authority - it already
carries the Library shelf and the asset a surface has open - so restoration replays one value
rather than a per-tour list of fields. Exit tour, backdrop dismissal,
<kbd>Esc</kbd>, completion, and controller errors all restore that snapshot. Every terminal
path records fixed outcomes and stops both temporary sessions when they exist: `Tour
conversation` for the empty-fleet Chat preview and `Tour demo` for the Ship walkthrough. Exit
during provisioning first cancels each launch race and then marks its task done. If cleanup is
refused, the snapshot still returns immediately and a centered error dialog retains focus with
**Retry cleanup** until every temporary session closes. Neither task
edits files, runs workflow Commands, sends application messages beyond the Chat preview's
fixed opening prompt, answers a review, enables Foreman, changes Trust, saves assets, creates
a pull request, or runs a retro.

#### Author what runs

**Author what runs** in the same **Help & tours** footer, or **Start Author what runs tour**
in the palette, teaches the AUTHORING half: the Library's four editable assets, and the
workflow that composes them into a definition of done. It is fifteen stops and nineteen
spotlights - five stops spend two beats on one lesson - plus a centered closing card.

It walks the shelves BOTTOM-UP, which is dependency order rather than reading order: Personas,
then Actions, then Commands, then Workflows, because a workflow is built out of the first
three and the builder's node palette is exactly those three assets. The Library's own shelf
order is left alone; a page reordered to match a tour would be the tour dictating the product.

1. **The Library** opens `#/library` and names the six shelves with a short description of each.
2. **The Persona library** opens a shipped built-in Persona and spotlights the rail's System,
   Built-in and Yours groups.
3. **What a Persona is** spends two beats on one lesson: the property chips, then the guidance
   Markdown that IS the asset.
4. **Editing one** spotlights the promoted verb, which on a built-in reads **Duplicate to
   edit** - the ownership rule stated by the control rather than by a sentence.
5. **The Action library** opens a shipped built-in Session action on the same rail and
   workspace grammar.
6. **Optional: Associated a skill to an action** spotlights the labelled **Session action contract**
   region - the `requires skill` and `completes when` chips and the sentence they form - and
   then the instruction editor.
7. **A Command slot** opens `#/library/commands/test` and spotlights the default rule.
8. **Overrides, and saving one** spotlights the add-override row, then **Save Command**, whose
   point is that saving executes nothing.
9. **The builder** opens the built-in **No-Mistakes Review** and spotlights the workflow rail
   and node palette.
10. **Draft and published** spotlights the Pipeline/Graph toggle, then the **disabled**
    Publish button - the draft-versus-published lesson without a draft existing.
11. **No-Mistakes Review** walks the five stages on the authored pipeline strip.
12. **Binding it** spotlights **Bind to a session…** and names the postures version 10 ships.
13. **A run, moving** opens `#/runs/:id` on one run that has already ended and spotlights its
    pipeline strip, then its review worklist.
14. **Where a run is watched** returns to the fleet, opens that run's session and its
    **Workflows** tab, and spotlights the vertical stage ladder.
15. **That is the authoring half** is a centered card that offers the other tour without
    starting it.

**The run it opens is one that already happened.** The tour selects the newest **terminal**
run of the built-in No-Mistakes Review whose session is still in the live collection, from the
summaries the dashboard already holds over SSE - no second request, nothing created, and no
model call. Terminal means any of the three ends a run can reach - `completed`, `cancelled` or
`failed` - and not `completed` alone. The stops are about the shape of a run that has stopped
moving, which all three share; a cancelled run draws the same pipeline strip, worklist and stage
ladder that a completed one does, and the selector rejects only a run that is still open. The
workflow match is exact, so an operator's own duplicate of No-Mistakes does not qualify: a run
of another workflow need not carry any of the five stages stop 11 just walked.

**The version has to agree too.** Published versions are immutable and older ones are kept, so
the newest terminal run on a machine can easily be a run of version 9 while the built-in has
since shipped version 10. Stops 11 and 12 walk the *current* version's stages and postures, so
a run of any other version does not qualify - describing a different pipeline as the one just
taught is worse than the fallback, which points at the built-in graph still on screen. The rule
is agreement with the current published version rather than the highest number, and a built-in
with no published version at all leaves the run chapter in its fallback.

Both clauses matter. A run outlives the session it reviewed - the binding is orphaned and the
summary keeps a durable `sessionName` for exactly that case - so an ended run with no session
left is the common case rather than the rare one, and stop 14 opens that session's Workflows
tab. When no run qualifies, stops 13 and 14 stay real stops with Back, Next and Exit, and
explain the same two surfaces against the built-in graph still on screen. When the session is
evicted between the two stops, stop 14 falls back in place and names the run's durable session
name.

**It writes nothing.** Every editing affordance it spotlights is on a built-in, where the
promoted verb is **Duplicate to edit** and Publish is disabled, so the tour has nothing to save
and can never raise the unsaved-changes gate. It creates no task, session, workflow, binding,
or run, which is why it declares no server-side recipe at all: `POST /api/tours/library/*` is
refused with the same answer an invented tour id gets. If the operator is already holding a
dirty draft when they start it, the entry-route preflight raises the existing leave dialog with
no tour active.

#### Set up this machine

**Set up this machine** starts from the Settings rail's **Help & tours** footer or **Start Set
up this machine tour** in the palette. It opens **Settings → Setup** and walks six concise stops:
the panel, dependency families, status meanings, remedies, **Re-check**, and a centered close.
Every spotlight is page-scoped because the panel has one rendered owner.

The tour is explanatory and read-only. It does not click a remedy, execute a command, install a
tool, or write progress. Its status language matches the live panel: **Ready** reports evidence,
**Missing** reports an absent tool, **Needs setup** reports a present but unusable tool, and
**Unknown** means the check could not finish.

**Comparison finding:** Driver.js supplies spotlight geometry, bounded `waitForElement`
progression, a centered missing-target fallback, labelled dialog semantics, and initial focus,
but version 1.8.0 does not contain Tab inside the popover and its built-in close affordance is
icon-only. A narrow React adapter adds modal and progress semantics, an explicit Exit tour
button, Tab and Shift+Tab containment, invoker focus restoration, and registration with Mission
Control's overlay stack. The real review modal temporarily becomes the top registered layer;
the adapter extends containment across that modal and the coachmark while leaving Escape to
peel the review before the tour. Its `onDestroyed` hook can also be skipped when an immediate
exit occurs before the active step is committed, so the adapter finalizes its own exit paths
directly. This is an adapter around the library rather than a general tooltip framework, and
it is now the one adapter every tour shares.
Reduced-motion preference turns off both Driver.js animation and the spike's transitions.

## Layout (console or board in Settings)

The Settings rail begins its machine-level session tools with **Setup**. That panel reports five
families of external tooling, keeps satisfied tools to a compact evidence line, and gives missing
or incomplete tools their capability impact and a link or copyable remedy. **Re-check** reads the
machine again without running any remedy. An App-level reminder appears once on first launch and
again for newly broken required rows. It links here, can be dismissed durably, and does not add a
second probe or polling loop. The daemon binds dismissal to the displayed checks snapshot, so a
tab cannot suppress a repair-regression sequence that another tab already observed.

The same fleet has two supported shapes. **Settings → Display → Layout** (the ⚙ gear, or <kbd>⌘</kbd><kbd>,</kbd>)
lets you switch live between them, and the choice persists per machine:

| Layout | Shape | Good for |
|--------|-------|----------|
| **Console** | A dense rail of every session with one always-open detail pane beside it. | Working *one* session while keeping an eye on the rest - the conversation is permanent, not a click away. |
| **Board** | A column per state; clicking a card - or pressing <kbd>Enter</kbd> on the one the arrow keys are on - drills that column into the console's detail. | Reading the fleet's shape at a glance. "How many need me" is a column's height, not eight badges. |

Stored preferences for the retired `grid` layout migrate to Console when loaded. New
configuration accepts only Console or Board, so the dashboard cannot render the retired layout.
Switching layouts does not change the underlying sessions. Controls repeated across
surfaces come from the *same* leaf pieces so their behavior stays aligned. What changes is
how they're arranged - dense overview surfaces select a subset, while Console and the
Board's drill-in expose the complete detail, while Console keeps the conversation permanently
available:

- **Console** gives the selected session a tabbed detail - **Conversation / Work queue /
  Workflows / Diff / Files**. The
  **Conversation tab is the transcript and its reply box, and nothing else**: the workflow
  ladder lives in **Workflows** (<kbd>y</kbd>), which is the tab that answers *how is this
  run going* while Conversation answers *what was said*. The controls for getting *at* this
  session - **Terminal view** and the two launchers - sit in the **tab strip** rather than
  in a band above the transcript, since that row already runs the full width and its job is
  adjacent: the launchers choose *how* you view a session exactly as the tabs choose *what*.
  On a narrow pane that row gives way in order - the tabs' chord hints, then the toggle's
  word, then the launchers' words and chord hints, then Foreman's word - so it stays one
  line, every tab keeps its own word, and every control keeps its name for a screen reader
  and its tooltip for a pointer. The chords keep working at every width.
  The **Board** drills into that same detail when you open a tile. In Console and Board, the
  Diff tab contains the complete checkout diff reader; the footer action and <kbd>d</kbd>
  reveal it in place.
- **The console's two extras are Foreman's**, and both need a conversation to exist:
  its notes render inline in the transcript, and a **Foreman · N** rail at the far end of
  the tab row opens their history. The rail is deliberately *not* a sixth tab - Work queue,
  Workflows and Diff are things the session *has*, while Foreman is an observer talking
  *about* it.
- On the **board**'s overview <kbd>v</kbd> (expand) opens the drill-in the way
  <kbd>Enter</kbd> does, and closes it again. In the console, and in the board once you're
  drilled in, the open detail *is* the selected session, so there is nothing left to expand,
  and its controls are on screen permanently instead of on a bar that floats over them.
- **Selecting is opening in the console**, and the keyboard walks it left to right. Click a
  rail row - or walk it with <kbd>↑</kbd>/<kbd>↓</kbd> - to switch sessions; the selected row
  wears a bright selector frame so it never gets lost against a busy state. Press
  <kbd>Tab</kbd> to step INTO the open detail: it lands on the conversation pane, which takes
  a soft ring, and <kbd>↑</kbd>/<kbd>↓</kbd> scroll it. Each further <kbd>Tab</kbd> moves one
  tab right - Conversation, Work queue, Workflows, Diff, Files - with <kbd>↑</kbd>/<kbd>↓</kbd>
  scrolling whichever is showing, and it clamps at the last rather than tabbing away.
  <kbd>⇧</kbd><kbd>Tab</kbd> walks back the same way, and from the conversation hands the
  keyboard to the rail. The reader is chosen by where focus actually is, so a single
  <kbd>Tab</kbd> reaches it whatever a click last left focused - except while you are typing
  in the filter or the reply box, where <kbd>Tab</kbd> stays native. In the focused inline
  Diff reader the arrows move through its file list instead.
  In Files Preview, <kbd>d</kbd> pages the rendered document down and <kbd>u</kbd> pages it
  back up, both from the file list and after <kbd>Tab</kbd> enters the document. Preview claims
  <kbd>Tab</kbd> instead of walking controls rendered inside the file. <kbd>⇧</kbd><kbd>Tab</kbd>
  or <kbd>Esc</kbd> returns to the selected file, and <kbd>Tab</kbd> enters Preview again. The
  letter keys stand down while you are typing.
  <kbd>Cmd/Ctrl+F</kbd> over a document searches THAT document rather than the conversation -
  see [Find in a document](#find-in-a-document). It is the one Files chord that stays live in
  the extracted window and from inside the editor, because it carries a modifier.
  <kbd>Esc</kbd> peels back one layer at a time - reader to rail, then deselect, emptying
  the pane. **The board's drill-in reads the same**: opening a card morphs its column into
  this rail-plus-reader, and every key here behaves identically there.
- **The board separates the two**, because its overview is worth reading without being
  dragged through every transcript on the way. The arrow keys move a visible cursor from
  tile to tile and open nothing; <kbd>Enter</kbd> drills the selected one into the console
  detail, and <kbd>Esc</kbd> comes back out with the cursor still on the tile you left. Once
  you're in, the arrow keys keep moving the open detail through the board - the drill-in
  is always the selected session. Clicking a tile still does both in the one gesture.
  Acting on the cursor works either way: <kbd>s</kbd>, <kbd>⇧</kbd><kbd>F</kbd>, <kbd>q</kbd> and
  <kbd>k</kbd> pressed on the overview drill in and then do what they say. The one exception
  is <kbd>⇧</kbd><kbd>Tab</kbd>, which cycles the selected tile's permission mode in place
  without opening its detail.
- **You choose what a session draws.** **Settings → Display → Session display** is a
  checklist of every optional item a session states about itself. Under **Board card** sit
  the card's own - goal, live activity, workflow, model, context meter, reasoning effort,
  permission mode, cost, branch, worktree and last seen - and unchecking one applies to
  every card in every column immediately. A live preview card sits in the panel and redraws
  as you toggle, so you can see what you are trading without
  leaving Settings. Two things are deliberately not on the list. The **attention flags** -
  a draft or escalated note, a review, a queued turn, a pull request, an Inspector verdict,
  a recurring mission, an ensemble - are always drawn, because no preference should be able
  to make a session that needs you look like one that does not; each of them already draws
  nothing when it has nothing to say. Nor are the things that *are* the card: the tone
  spine, the name, the agent dot and the **held** tag. The **defaults draw exactly the card
  the previous release drew**, so upgrading moves nothing; the one new item, the
  **worktree**, starts off. Switched on, it prints the checkout's directory name in the
  branch row with the whole path on hover - the leaf rather than the path, because a pool
  worktree path is sixty characters of bookkeeping and that row is two cells sharing one
  line. The choice is per browser and stored through the daemon, so it survives a reload;
  a second dashboard tab already open picks it up on its next load rather than live, which
  is true of every Display preference.
- **The same panel governs the conversation header.** Under **Conversation header** in that
  checklist sit the console detail's two facts above the transcript - the session's
  **working directory** and its **Git branch**. Both ship visible, so nothing moves until you
  ask. Switch both off and the whole band stops rendering, giving its height back to the
  conversation - **but only when nothing else is in it.** That band is also where a task's
  chip and its pull requests go, so an ordinary dispatched session collapses it while a
  scout task, a session re-assigned to a later task, a task carrying an outcome link, a
  scheduled task and a multi-repo task each keep it. The panel says so where you choose.
  These two switches are separate from the card's **Branch** and **Worktree** items on
  purpose: you can keep the path on the card and drop it from the console, have it in both
  places, or have it in neither.
- **Cards are grouped by the repository they belong to, and it ships on.** Each column
  collects its cards under a heading naming the repository's directory, with a colour drawn
  from the path so a project keeps the same colour across reloads and machines. The heading
  says how much of the repository you are looking at - `2 agents` when all of it is here, or
  `2 of 7` when the rest is elsewhere on the board - and clicking it folds the group away
  while you read the rest of the column. The **Console** rail groups the same way, because the
  board's focused column *is* that rail once you drill in. Grouping is on the repository, not
  the checkout: a linked worktree groups with the repository it was cut from, so two checkouts
  of one project read as one project. Sessions outside a repository stay loose at the foot of
  the column rather than under an invented heading.
  A repository never crosses a column, for the reason a cluster never does: work of one project
  that is waiting on you sits in **needs you**, with that repository's heading repeated there,
  instead of dragging its working siblings out of the column that says what they are - which is
  what the `2 of 7` rollup exists to tie back together. Within the idle column the free/held
  rule sits *above* the grouping, so a repository with one free agent and one a workflow is
  holding is drawn once on each side of it. The colour is a scanning aid rather than an
  identifier: the palette has six entries, so two repositories on a busy board can share one,
  and the heading's name is what tells them apart. Arrow keys walk straight past the headings.
  Turn the whole thing off with **Group by repository** in Settings → Display → Layout, and
  every column returns to one flat, tone-ordered list.
- **An [ensemble](ensembles.md#multi-agent-ensembles)'s members are drawn together, in every layout.**
  Sibling candidates of one run used to scatter through the fleet like unrelated work; now one
  ordering decides where every session goes, and it puts them adjacent. On the **Board** they
  sit inside a framed group whose header names the run, its strategy, where it is in operator
  words ("reviewing", "waiting on you"), one dot per member of the roster, and an attention
  rollup - **N needs you** when a member *in that frame* is holding a question, or a quieter
  outlined **N elsewhere** when the run has one in another column. Click the header to open the
  run. The **Console** rail (and the board's drill-in, which is the same rail) gets a slimmer
  version above the members' rows - the title, the stage word, the dots and a compact `!N`
  attention count, but not the strategy, which at the rail's narrowest would cost the run's own
  name the room it needs (it stays in the hover copy, and on every member row's chip). Arrow
  keys walk straight past the header, so navigation is unchanged.
  A cluster never crosses a Board column: if one member is waiting on your answer it sits in
  **needs you** with the run's header repeated there, rather than dragging its working siblings
  out of the column that describes what they are. Dragging a backlog card onto a clustered tile
  works exactly as it does anywhere else - the frame is a drawing, not a drop target.
- **A [pipeline](pipelines.md#on-the-fleet) engine's sessions are drawn together the same way.**
  A discovered agent working inside an observed run's worktree wears a `⇶` chip naming the run
  and its current step, groups under a header that opens the run, and loses its composer - it
  is a `--print` process and reads nothing typed at it. Its permission posture is still shown,
  because an agent nobody can retune must not look safer than it is. A session with both an
  ensemble membership and a pipeline correlation frames as the ensemble's.
- **The idle column separates free agents from ones a workflow is holding.** A session bound
  to a live [Workflow](workflows.md#workflows-and-personas) run sits at `idle` for most of that run's life: it finished
  its turn, and the run is off working checks, judges and reviewers before it sends the next
  round. The runtime reading is right - the agent really is doing nothing - but it is not
  *free*, and the column used to count it as capacity. It now sorts below a **held by a
  workflow** rule, under its own count: the head reads **N free · M held** instead of one
  number that means neither, and each held tile wears a purple spine and a **held** tag so it
  stays legible once the rule has scrolled away. The tile's
  [active-rung preview](workflows.md#watching-a-run) already says *which* run and *where
  it is*; the rule answers the question that preview cannot, which is whether you may give this
  agent anything. Held-ness is a join, not a session state - a run whose status has reached
  `completed`, `cancelled` or `failed` releases its session back to free immediately, and a
  held session that stops to ask a question moves to **needs you** like any other, because
  there the operator is the one who has to act. The **Console** rail draws the same rule, since
  it renders the same ordering. A held tile also refuses the
  backlog drag: dropping a card
  hands work over by resetting the agent, and a held agent's next turn belongs to its run - so
  during a drag the card lights up only over agents that are genuinely free.
- **Killing a session closes its detail** once shutdown is accepted, without waiting for an
  Agent SDK subprocess and event stream to finish draining. The board goes straight back to
  its columns, and the console empties its pane. The session reads **stopping** during that drain, then **exited** until its ordinary
  eviction; durable task, workflow, and review cleanup still begins only on `session_remove`.
- **Double-click a column head to widen that column.** A board column is sized for a
  glance, and sometimes a glance is not enough: titles wrap to three lines, goals clamp at
  two, and a blocked chip ellipses after four words. Double-clicking the head - or pressing
  the **‹›** toggle that appears in it on hover - gives that one column roughly twice a
  normal column's share of the board, and its cards **reflow** rather than stretch: the
  title takes the full width on its own line and every mark below it joins one line, so a
  card gets *shorter* as it gets wider and more of them fit on screen. Double-click again,
  or press **›‹**, to put it back. One column at a time, and the neighbours keep their own
  minimum width, so widening the Backlog never squeezes the column holding the live agents
  down to nothing. It's a gesture rather than a setting: it isn't persisted, and opening a
  session drills in exactly as it did before.
- **The filter box (<kbd>/</kbd>) narrows the whole board, backlog included.** A query is a
  case-insensitive substring match against a session's title, status and agent - and, on the
  board, against a backlog task's title, status, agent and labels. So `ghostty` finds the
  queued *P5: Ghostty terminal emulator adapter* whether or not any live session matches, and
  the board stays on screen to show it. Console draws no tasks, so there a query
  matching only backlog items correctly reads as "nothing matches".
- **The arrow keys follow the shape** - see below.

## How much conversation you see

For the Conversation panel's complete, paged history, see
[Reading a session's whole conversation](sessions.md#reading-a-sessions-whole-conversation).

One-shot context readers such as Foreman's reviewer and the goal refiner keep the opening
turns plus the most recent ones, and mark the middle as elided when necessary. The work
queue's verifier instead reads forward from the item's delivery point, keeps up to 48
recent turns, and reports when it had to drop an older prefix.

## Open a checkout file outside Mission Control

The Files workspace reads and edits the checkout in place, and its HTML preview is
deliberately inert: the sandbox gets no scripts and no network access. One kind of link
still works, because a multi-page mockup is built out of it: an anchor that resolves to
another file in this checkout opens that file in the preview, exactly as the same link
would in a Markdown preview. Every other link is inert rather than followed - a srcdoc
document resolves relative URLs against the dashboard itself, so letting one navigate
showed the SPA fallback's blank shell where the mockup used to be. Fragment links scroll
in place, as always.

The inert sandbox is the right trade for a preview pane and the wrong one for a mockup
with any JavaScript in it, so the file toolbar carries **Open in ▾** - it hands the file
on screen to an application outside the dashboard, where the document is just a document
again and resolves its own relative assets.

**Browser** is the target this build ships. It is not `open <file>`: the platform's default
handler routes by file TYPE, which lands an `.html` mockup in your browser and lands
`routes.ts` in whatever editor claims `.ts`. The Files list holds every file in the
checkout, so a row that says "Browser" resolves the application you actually chose for the
web - on macOS the bundle LaunchServices hands `https` to, on Linux what
`xdg-settings` reports (falling back to `xdg-open`, which can no longer name the
application, and says so rather than guessing). The row names what it found, so you can see
*Browser · Chrome* before clicking.

- **What opens is what you are looking at.** Autosave is 750ms behind the keystroke and
  every target reads the file from disk, so a pending save is flushed and waited on first.
  If it cannot be written - offline, or a conflict with an edit made outside the dashboard -
  nothing opens and the toolbar says so, rather than quietly showing the previous version.
- **Files the editor cannot open still open here**, which is the point for images, PDFs and
  anything over the 2 MiB editor limit: the workspace says "binary files cannot be opened"
  and the browser shows them perfectly well.
- **What the browser then does with the file is the browser's call.** It renders what it
  knows - HTML, images, PDF, SVG, plain text - and *downloads* what it doesn't: Chrome puts
  a `.yml` or a `.ts` in your Downloads folder rather than displaying it. That is worth
  knowing before you reach for this on source, and it is the gap a future **Editor** target
  fills; nothing here second-guesses it with an extension allowlist, because which types a
  browser renders differs between browsers and changes under you.
- **Availability is answered by the daemon's host**, not by the browser you are reading the
  dashboard in - it is the daemon that launches the application. A target that cannot run
  there is greyed out with the reason attached ("not supported on win32 yet"), which is the
  difference between a broken button and a missing dependency.
- **Nothing about the checkout crosses HTTP.** The daemon launches a local application
  against a local path; it does not serve the bytes. Serving them would put
  checkout-controlled HTML on the daemon's own origin, where its scripts would reach every
  action route on the port.
- **Adding a target is a file and two entries.** `OPEN_TARGET_IDS` / `OPEN_TARGET_INFO`
  (`@shared/open-targets.ts`) say what a target is called and promises; an implementation
  under `src/server/open-targets/` says how to resolve and launch it. The menu is a fold
  over that list, so an editor or a JetBrains IDE needs no component, stylesheet or route
  change. Both records are `Record<OpenTargetId, …>`, so a declared target that nothing can
  launch does not compile.

## Conversation rendering

The Conversation is drawn as a **terminal stream** by default - prompt lines in, stdout out,
tool runs folded into one record, inside a frame with a live status line. It can instead be
drawn as a **chat log**. **Settings → Display → Conversation** sets the default for
every session, per machine; the **Terminal view** button flips that one session for as long
as the tab is open - in the strip above the conversation on a card, and in the detail's tab
strip in Console and Board. Both renderings are the same panel over the
same transcript, so find, the Observed activity rail, scroll-back, attachments and the
reply box behave identically in either. See
[Reading a conversation as a terminal](sessions.md#reading-a-conversation-as-a-terminal).

## Message formatting

Agents write markdown, so the transcript renders it: headings, lists, tables, and fenced
code blocks with syntax highlighting drawn from the dashboard's own palette. The same
renderer draws shared plans and Foreman's briefs, so a fence looks the same wherever you
read it.

**Settings → Display → Format messages** turns it off, and the choice persists per
machine. Off shows the literal text an agent emitted, backticks and all - useful when
you're checking exactly what was said before pasting it somewhere that isn't a markdown
renderer. Formatting is display-only either way: it never changes what the agent wrote or
what gets sent when you reply, and copying a code block still yields exactly the
characters inside the fence.

Two deliberate limits. A fence with **no language tag is left uncoloured** rather than
guessed at - agents emit plenty of fences that aren't code (log tails, file trees, error
dumps), and a confident wrong guess reads worse than no colour. And **single newlines stay
line breaks** in chat turns, which is what the transcript did before it parsed markdown,
so no existing message reflows into a run-on paragraph.

Links in a formatted transcript that resolve inside that session's checkout open in the
same session's Files workspace. Console and Board reveal their integrated Files tab.
Checkout-relative links and absolute paths beneath the
checkout are accepted, including optional line and column suffixes. External links keep
their normal browser behavior, and resolved paths outside the checkout never open. HTML,
Markdown, and browser image formats (APNG, AVIF, BMP, GIF, ICO, JPEG, PNG, SVG, and WebP) open
in Preview by default, while other file types open in the editor - so a generated page or image
a session links to is read as its rendered output, and source is read as source. Raster images are
read only; SVG keeps its source Editor alongside Preview. The
Preview and Editor buttons publish which of the two is showing as their pressed state, so the
view a file landed in is legible to a screen reader and not only to the eye. While the integrated
Files tab is open, press <kbd>p</kbd> for Preview or <kbd>e</kbd> for Editor. These fixed,
tab-local shortcuts may overlap actions on other surfaces, and they stand down while you are
typing or while an overlay is open. HTML preview
remains inert: its document renders immediately, then a bounded set of checkout-local
stylesheets is inlined through the contained file reader without granting the sandbox scripts
or network access. A slow stylesheet read therefore delays styling, not the document itself.

The boundary beside the Files list is draggable, so a long document can take space back from
the list or a deeply nested checkout can give the list more room. The Diff tab uses the same
divider between Changed files and the selected patch. Focus either divider and use the Left or
Right arrow for a precise adjustment; hold Shift for a larger step. Double-click restores that
viewer's default split.

### Find in a document

Press <kbd>⌘F</kbd> (or <kbd>Ctrl+F</kbd>) while a document is open in the Files workspace and a
find bar appears over it. Type to see the match count, step with <kbd>Enter</kbd> and
<kbd>Shift+Enter</kbd> - wrapping at both ends - toggle case with **Aa**, and close with
<kbd>Esc</kbd>. Reopening keeps the last query, selected, so typing replaces it. The chord works
in the integrated Files tab and in the extracted Files window, and it never switches the detail
to Conversation: while a document is on screen, the workspace owns it.

It is the same find in **Markdown preview** and in the **Editor**: one query and one case flag,
surviving the Preview/Editor toggle, with your place carried across by source line. **The count
is per surface**, because the two surfaces show different strings. A markdown document's rendered
text has fewer occurrences than its source - a query matching only the destination of
`[label](matching-url)` counts one in the Editor and none in Preview - and both numbers are
correct for what their surface shows. A Preview claiming that match would be offering one it
cannot highlight or step to.

In the Editor this find replaces CodeMirror's own search panel outright, so the app has exactly
one find rather than a second one with different chrome and a different count.
<kbd>F3</kbd> and <kbd>⌘G</kbd> keep meaning find-next and find-previous, stepping the same ring.
The Persona, Session action and Foreman profile editors are unaffected: they have no find session
of their own, so they keep CodeMirror's panel.

An **HTML preview** is a sandboxed document this app cannot read into, so its matches are counted
over the file's source and the block containing the current match is revealed and outlined -
which is why the bar says **by block** there. Character-accurate find inside that frame is a
later change.

### Comment on a line

**Comment** in the Files toolbar turns on comment mode (<kbd>m</kbd>, in the integrated tab)
for any file with source to read. With it on, clicking a line number - or a block of the
rendered preview - opens a box under that line. An image has no lines and shows the control
disabled with that as the reason.

**This works in Preview as well as in the Editor.** A comment names a line and quotes it, but
turning the control on over a rendered Markdown or HTML document takes nothing away and shrinks
nothing: the document keeps the whole pane, you point at the block you have something to say
about, and the box **docks over the preview** at the line that block was written on, carrying
the range and the source it quotes in its own header. You stay in Preview; **Preview** stays the
pressed view; <kbd>e</kbd> is one key away if you meant to edit. On a phone-width window the box
spans the foot of the pane instead of floating in its corner.

The box is not a modal. It does not cover the app, it does not trap focus, and it does not stand
the session shortcuts down - you are meant to keep reading the document while you write about
it. In the **Editor** it opens where it always has, in the document under the line you clicked.

What you write is saved from the first keystroke as a *draft* - it is a real row in the
daemon's state, not a string in the browser tab, so closing the file, reloading the page, or
closing the extracted Files window does not lose it. **Comment** submits it into that
session's review queue, and it stays in the file as a marker.

**A comment has to quote something, so a blank line borrows the nearest line that speaks.**
Clicking one quotes a range rather than the empty line alone: down to the next line with text
on it, or - when the blank line is last, with nothing below - up to the line above. The panel
names the range it took, so you can see what you are commenting on before you write.

The marker goes on the range's **first** line. Reaching down, that is still the blank line you
clicked, and the marker sits there. Reaching up, from a blank line at the end of the file, the
range starts above and the marker sits on that line instead - one line up from the click.

A file of nothing but blank lines has nothing to anchor to at all, and says so instead of
writing a comment that could never point anywhere.

A marker is a small button at the end of the line it is about, and its accessible name says
which comment it is, which line it is on and what state it is in - queued, answered, moved, or
resolved, and how many replies it carries. (At the end of the line rather than in the gutter
because CodeMirror hides both its gutters from assistive technology, which is right for line
numbers and would have made this control unreachable.) Clicking one expands the thread: the
original comment, every reply in time order, and a box to add another. A line carrying more
than one thread steps through them on each click, and closes on the last. <kbd>Esc</kbd> closes
the panel, and <kbd>⌘</kbd><kbd>Enter</kbd> submits from either box.

**Comments** in the toolbar opens the file's comment index as a side rail. It lists every
thread on the selected file in source order, including resolved threads, with its location,
state, message count, and most recent text. Selecting a row expands that thread and centers
its anchor in the current reader: the rendered block in Preview and the source line in Editor.
The rail is navigation rather than the review queue, so a thread remains findable after it is
sent, answered, or resolved.

**Resolve** closes a thread, and only a person ever does - a thread does not close itself and
an agent cannot close one. Closed threads stop being drawn inline, but remain in the
**Comments** rail. Selecting one brings its marker and thread back into the file, where it
offers **Reopen**. **Resolved** still controls whether all closed markers are drawn together;
it appears only while comment mode is on and the file has at least one closed thread.

**In Preview, point at what you are reading.** With comment mode on, hovering a block of the
rendered document outlines it, and the block you land on is the innermost one under the pointer -
so a paragraph inside a quote is one target, not three.

- In **Markdown Preview** - a paragraph, heading, table, list, code block or Mermaid diagram -
  a small **+** appears in the margin beside it. Its name says which lines it covers ("Comment
  on lines 7 to 9").
- In **HTML Preview** the block itself is the target: click anywhere in it. What counts as a
  block is whatever the browser laid out as one - a paragraph, a table cell, a form, a
  fieldset, an address, an open dialog, and equally a `span` the document styled into a block.
  A diagram is one target rather than each of its strokes, and anything hidden is not a target
  at all. A link inside a block you are commenting on does not navigate while comment mode is
  on.

Either way it opens the same box, docked over the preview, at the line that block was written
on - and the comment anchors to **source lines** and quotes **source text**,
because that is what the agent is being sent and what a later edit is checked against. A block
anchor quotes the whole block, so what you see in the composer is the paragraph or the table as
it is written in the file, markup and all.

Two things follow from a rendered document being a render:

- **A comment on a rendered block covers the whole block.** The marker lands on its first line,
  and the Editor shows it there.
- **An HTML block can be refused.** The preview is a sandboxed frame the dashboard cannot
  read into, so a click is resolved against the file on disk. If the agent has rewritten the file
  under a render still on screen, that block no longer exists to point at, and the refusal says
  so and offers **Refresh**, which re-reads the selected file and reloads its preview in place. It
  never guesses at a nearby line. Repeated wording and duplicate headings are not a problem at all
  - blocks are matched by position, never by text.

The Files toolbar responds to the width of the file pane itself. As that pane narrows, the path
ellipsizes further, metadata and shortcut hints step out, and control spacing tightens. The
Preview and Editor switch remains whole, and the other file actions remain visible rather than
overlapping it.

**A rendered document can reopen the thread already anchored to a block.** Markers remain an
Editor surface because an HTML preview is a sandboxed frame the dashboard cannot draw into, but
the **Comments** rail supplies the file-local index beside Preview. Point at a block that already
has a thread and that thread opens in the dock for a reply or **Reopen**; it never files a second
thread. **Review (N)** remains the session-wide outbox across files and opens the thread you pick.

The exception is a comment you started and never submitted. A **draft** is not an existing
comment - it is your composer with half a sentence in it, and the review queue does not list one
- so pointing at its block reopens it with what you wrote still in it.

### Walk the agent through your review

**Review (N)** in the Files toolbar opens the queue: every comment this session holds, in the
order it will be delivered, across every file. **Start review** sends the first as its own turn.
The next goes when the agent has finished with it - a reply, or, failing that, the session
settling idle for long enough that it has clearly moved on. One comment is ever outstanding, and
that is the whole design: you see each answer before the next comment goes.

Each comment arrives carrying its file, its line range, the text it quotes, and **which comment
of how many it is**. That last part is not decoration. An agent told "comment 3 of 12, answer
this one only, the remaining 9 follow" does not restructure the whole document on comment three,
which is the one thing a single batched message does better and the only thing this design has
to buy back.

**The queue stays yours while it drains.** Reorder it with the arrows, rewrite a comment that
has not gone yet, drop one, or **Pause**. Pause takes effect after the comment currently out
with the agent resolves; nothing already sent is recalled, because the agent has read it. That
comment still finishes on its own - a pause stops the queue, it does not freeze the one turn
already in flight - and only you resume the rest.

"One comment outstanding" is really one turn in the session's *whole* outbox, not one review
comment. Type an ordinary message into the conversation mid-review and the next comment waits
behind it rather than joining it in the queue. Nothing is asked of you: it goes as soon as your
message has been delivered. The exception is a message Mission Control could not confirm - that
one waits for you, so the review pauses and says where to go rather than sitting silently.

Those three controls are offered on a queued comment and never on the one in flight - its bytes
are already committed, so the daemon refuses all three there rather than pretend otherwise.

**A comment whose quoted text the agent has since deleted is held rather than sent, and says
why.** Before each send, every unsent comment is re-anchored against the file as it now stands.
A comment whose text merely moved goes silently, at its new line. One whose text is gone is held
at the head, the review pauses, and the reason names the comment and the file. **Drop it and
comment again on the text that is actually there** - that is the way past. Note what does not
work, because the queue offers it: **Edit** rewrites what a comment *says*, not the text it
*quotes*, so editing a held comment leaves it held. A comment's quoted text is fixed when you
write it.

The warning itself has a **Dismiss** control. Dismissing it clears the explanation across open
Files surfaces, but leaves the review paused and the comment queued. It does not stand in for
**Drop** or **Resume**. If you later resume while the quote is still missing, the new check
holds the comment and shows the warning again.

**Resume** is not a way past either. It re-runs the check against the file as it stands, so a
comment whose quote is still missing is held again with the same reason. That is deliberate:
the quote is the only thing telling the agent which text a comment is about, so a comment
quoting text that is not in the file is one the agent cannot act on, and sending it anyway
would be worse than holding it. Resume does clear the hold when the quote has come back - if
the agent restored the text, or you put it back yourself, the comment simply goes.

A comment further down the queue is marked *moved* in place and you meet it when it reaches the
head.

The review also pauses when the session cannot take a message at all, when the file a comment is
anchored to has left the checkout, when there is nothing left to send, and when Mission Control
could not confirm a comment reached the agent - that last one is the ordinary **Retry** and
**Mark sent** pair in the conversation, and choosing either on *that comment's* turn resumes the
review. Resolving some other message you had queued does not, and neither lifts a pause you
pressed yourself.

Nothing here lives in the browser. A daemon restart mid-review resumes rather than re-sends: a
comment that was in flight when the daemon went down surfaces as a paused review awaiting one
confirmation, rather than being recorded as delivered when it may never have been read.

**The agent answers in the thread, on the line, live.** Each comment arrives naming the id it
was delivered with - `MC-a41f.2`, the comment's handle plus which delivery of it this is - and
the agent answers by quoting that id back through Mission Control's `respond_to_file_comments`
tool. The answer appears in that comment's thread without a refresh, in the integrated Files
tab and the extracted Files window alike, and it is what releases the next comment. The queue
stops advancing on an inference that the session has gone quiet and starts advancing on a real
completion.

The **Files** tab raises a pip when an answer lands, counting replies nobody has read yet -
not how many comments are still queued, which is your own work. Expanding the thread clears it,
in both windows.

The trailing `.2` is what makes a reply answer a *turn* rather than a thread, and it matters
because a thread can go out more than once - it times out, you follow up, it goes round again.
A reply quoting an earlier delivery is still filed on the thread, because it is a real answer
and losing it would lose the agent's work, but it advances nothing: a comment you have already
followed up on keeps its place in the queue and the follow-up is still delivered.

An agent can also say it **acted** on a comment rather than only answering it. That marks the
thread as handled and never closes it - only you resolve a comment.

**A session with no such tool still works, and is not told to call one.** Mission Control's
tools reach sessions the dashboard launched and sessions on a machine where the integration is
installed; a session you started yourself without it has none, and neither does one whose
built MCP bundle is too old to publish the tool. Each comment is checked against that bundle
before it goes out, so a session that cannot call it is asked to quote the comment's id back in
its next turn instead - an instruction naming a tool that is not there is one an agent follows
into silence.

The id is then the fallback: an answer that opens by quoting it is filed into that thread out
of the conversation when the comment's window closes. It is less precise in one specific way -
free text recovers which comment was answered but not reliably which delivery - so a recovered
answer is filed and the queue advances on the ordinary idle signal instead. What cannot be
established either way is whether a particular running process registered the server; that is a
property of a process Mission Control did not necessarily start, which is why the fallback
covers a session that simply ignores the tool exactly as it covers one that never had it.

**Opening a file at a line works now.** A `path:line` link from a conversation, a diff, or a
review finding scrolls the editor to that line rather than opening the file at the top, and the
walkthrough uses the same route to take you to each comment as it goes out.

Markdown in the Files **Preview** has one additional capability: a fenced block tagged exactly
`mermaid` renders automatically as a local diagram. Each diagram runs in its own opaque,
no-network sandbox and exposes a numbered accessible name. A malformed block reports its error
beside readable source without hiding the rest of the file. Blocks over 50,000 characters and
blocks after the first 32 in one document stay as source with a limit notice. **Editor** always
shows and saves the exact Markdown, including every fence, and returning to Preview renders the
latest buffer. Untagged fences, every other language tag, and Mermaid fences in conversations,
shared plans, Foreman briefs, Personas, workflow actions, and reports remain code. Rendering uses
the bundled Mermaid package only; it sends no source or labels to a remote service. External image
and active-link constructs are rejected before rendering and remain readable through the block's
source fallback.

**The Diff tab has the same door.** The bar naming the file you are reading carries an
**Open in Files** action, on every file, which opens that file in the Files tab beside it -
the same route, the same containment rules. Press <kbd>l</kbd> while the diff reader owns
focus to take that action without leaving the keyboard. The binding is customizable and its
resolved key is printed on the button. Two files it will not open, and it says which rather
than failing on the click: a **deleted** file, which has no copy left in the checkout to read,
and a file **outside the session's working directory**. The second is possible because the
two readers measure paths from different places - git writes them relative to the repository
root, while the Files tab lists the working directory it was opened in - so a session started
in a subdirectory can see changed files that its Files tab has no route to.
The path is rebased through the repository root rather than handed over as written, which is
what keeps a shared relative path like `src/index.ts` from opening the wrong file, and it is
used exactly as git wrote it, so a file named `notes:12` opens as itself rather than as
`notes`.

That second refusal is a decision rather than a gap. Making those files openable means
rooting the Files workspace at the repository root, which would widen the daemon's read and
write containment from the working-directory subtree to the whole repository for every
session - a larger and more security-relevant change than the affordance it serves. Every
dispatched session works in a worktree, whose root **is** the repository root, so nothing is
refused there.

**Paths the agent merely typed are links too.** Markdown gives an agent no way to say
"this word is a file" other than writing a link, and agents don't - they write
`docs/plans/x/plan.md` bare in a sentence or in backticks, because that is how it reads in
a terminal. Those open the same Files workspace, on the same click, with the same
containment rules; a `:line` or `:line:column` suffix rides along, and `./x` resolves like
`x`. They wear the colour of the text around them and pick up an underline under the
pointer, so a paragraph naming six files still reads as a paragraph.

A path becomes a link **only if this session's checkout actually has that file**, and that
membership is the whole test - not what the name looks like. Every file the Files tab
lists is reachable, with no excluded extension and no excluded shape, so `Makefile`,
`.env`, `gradlew` and `docs/My Plan.md` link exactly like `src/App.tsx` does, while a word
that is merely path-shaped does not. The set of files is the same one the Files tab shows
you (`git ls-files`, tracked plus untracked, capped at 10,000 entries), so a path the tab
cannot show you is never offered as one you can open.

Matching runs on whole words: a name is never linked inside a longer one, and where
several listed files could match at the same spot the longest wins, so a name is never
linked as a fragment of the one that was written.

There is no minimum length either, and the consequence is worth knowing before it
surprises you: in the rare checkout that contains a **one-character** file, the English
article "a" links too, because it is the relative path to that file. Every one of those
links is correct - it opens a file that is really there - and the alternative was a file
the Files tab lists and the conversation beside it cannot reach.

Everything else stays the text the agent wrote: anything outside the checkout, and the
contents of fenced code blocks - a diff or a file tree is left as a code block rather than
turned into a wall of links. Paths in a session with no working directory, and in every
surface with no session behind it (shared plans, Foreman briefs, the Markdown file
preview), are left alone for the same reason: there is nothing there to open them in.

**How often the checkout gets listed.** The path links and the written-link resolver share
one listing request per session, so those two can never disagree about what exists. The
Files tab is not on that shared request: opening it lists the checkout itself and publishes
the result into the same index, which keeps the answers in step without making it one
request - open a session's conversation and then its Files tab and the daemon is asked
twice. Refreshing the file list invalidates the cached listing so the next reader re-lists,
and the previous one stays in force until the new one lands, rather than un-linking the
open transcript while it is in flight.

The original pull request includes the end-to-end capture of this click flow.

## Tooltips

Every control in the dashboard says what it does on hover. Buttons, links, selects,
checkboxes, radios, disclosure rows, and the status chips whose text is clipped all carry a
tooltip; the ones bound to a shortcut name the key too, so the chord is learnable from the
control rather than only from the Keyboard panel.

They are one component (`src/web/components/Tooltip.tsx`) rather than the browser's `title`
attribute, which this replaced everywhere. `title` renders in OS chrome, so it was the one
surface in the app the theme could not reach; its delay is the platform's and not tunable;
and it never appears on keyboard focus, so half the fleet's controls described themselves
only to a mouse. The shared bubble matches the app's surface, border and shadow tokens,
opens on focus as well as hover, flips below the trigger near the top of the window, and
slides sideways to stay on screen at the edges - with its caret still pointing at the
control it belongs to.

Two details worth knowing:

- **Disabled controls keep their tooltip**, which is where it matters most - a dead Send
  says "No pane to send to" rather than leaving you to guess. Directly disabled triggers
  get a hover anchor; controls disabled by a fieldset put the hover target on their row.
- **Every label is also a real accessible description**, wired to its control with
  `aria-describedby`, so a screen reader reaches the same sentence a pointer does.

Free-text fields are deliberately left alone: they carry a visible label or placeholder
that is on screen the whole time, and repeating it on hover is noise. Anything you *act*
on has one, and `tooltip-coverage.test.ts` fails the build if a new control arrives
without one, or if a native `title` attribute creeps back in.

## Context menus

Right-click selected text, an external link, or an editable text field to open Mission
Control's context menu. A selection offers **Copy**. A link offers its visible text and URL as
separate copies when they differ, plus **Open link**. A text field offers **Cut** and **Copy**
when text is selected, and always offers **Paste** and **Paste as quote**. Clipboard writes use
the same fallback and confirmation as the app's visible Copy controls. If a browser refuses a
clipboard read, the menu keeps the field focused and points to <kbd>⌘</kbd><kbd>V</kbd>.

The same DOM menu is used in a browser tab and in the desktop app. In the desktop app,
**Open link** goes through the preload bridge and opens in the system browser instead of
navigating the Mission Control window. Hold <kbd>Shift</kbd> while right-clicking to ask the
browser for its native developer menu instead.

<kbd>⇧</kbd><kbd>F10</kbd> opens the menu beside the focused item, including from inside a text
field. A keyboard with a dedicated Menu key opens it too. Arrow keys move between rows,
<kbd>Enter</kbd> invokes one, and <kbd>Esc</kbd> closes the menu and restores focus. A pointer
right-click outside the current document selection clears that selection before resolving the
menu, so **Copy** never refers to text away from the pointer.

## Keyboard shortcuts

The dashboard is keyboard-driven - use the arrow keys to navigate Board, to walk
the Console rail or scroll its open reader, then act without reaching for the mouse. The table
names the layouts where a shortcut's target exists:

| Key | Action | Scope |
|-----|--------|-------|
| <kbd>↑</kbd> <kbd>↓</kbd> <kbd>←</kbd> <kbd>→</kbd> | In **Console** and the **Board** drill-in <kbd>↑</kbd>/<kbd>↓</kbd> walk the rail selection, or scroll the reader's active tab once you <kbd>Tab</kbd> into it (and move through files while its inline Diff reader is focused); along and across the columns in the **Board** overview. On **Scouts**, <kbd>↑</kbd>/<kbd>↓</kbd> open the adjacent report in the current results when focus is outside a text field or selector. With nothing selected, the first arrow selects the first session | Anywhere |
| <kbd>Tab</kbd> | **Console & board drill-in:** step into the open detail and one tab right each press - Conversation → Work queue → Workflows → Diff → Files - clamping at the last rather than tabbing away. The reader takes a soft ring and <kbd>↑</kbd>/<kbd>↓</kbd> scroll whichever tab shows; <kbd>⇧</kbd><kbd>Tab</kbd> walks back, and from the conversation (or <kbd>Esc</kbd>) hands the keyboard to the rail | Open detail (Console or Board) |
| <kbd>Enter</kbd> | Open the selected session's detail. **Board** opens the drill-in; Console already shows the selected session. On a focused link or button Enter activates that instead, as it always does | Anywhere |
| <kbd>Esc</kbd> | Peel back exactly one layer per press - first close an open panel, dialog, or away digest, then leave a focused text box, hand a Console reader back to its rail, or leave the drill-in with the cursor still on it (**Board**), then deselect. In guided dispatch's Repo step, the first press closes the repo list and leaves the pass for the ordinary form; a second closes the modal | Anywhere |
| <kbd>Esc</kbd> | Leave the [authoring surface](library-and-line.md#getting-back-out-of-an-authoring-surface) for `#/library`, one layer per press: an open dialog closes itself, then a focused editor or field is left, then the page. An unsaved draft raises the same leave-with-unsaved-changes question the **← Library** row does | Library: a Persona, Action, Command or workflow |
| <kbd>f</kbd> | Open **Fleet** | Anywhere |
| <kbd>w</kbd> | Open the **Library** | Anywhere |
| <kbd>r</kbd> | Open **Workflow Runs** | Anywhere |
| <kbd>↑</kbd> <kbd>↓</kbd> | Select the previous or next workflow run and load it immediately in the reader | Workflow Runs rail |
| <kbd>Tab</kbd> | From the selected run, enter the workflow at its first authored stage. Further Tabs advance through the stages | Workflow Runs rail and pipeline |
| <kbd>↑</kbd> <kbd>↓</kbd> <kbd>←</kbd> <kbd>→</kbd> | Select the previous or next authored stage | Workflow Runs pipeline |
| <kbd>Enter</kbd> | Load a completed stage's recorded details in the Review worklist | Workflow Runs pipeline |
| <kbd>⇧</kbd><kbd>S</kbd> | Open **Scouts** - the archive of finished investigations | Anywhere |
| <kbd>⇧</kbd><kbd>P</kbd> | Open or close **Sitrep** | Fleet |
| <kbd>+</kbd> | Start the guided dispatch pass. <kbd>Tab</kbd> reaches the ordinary form in one key | Anywhere |
| type, <kbd>↑</kbd><kbd>↓</kbd>, <kbd>Enter</kbd> | Filter repositories by name, move through the matches and take one | Guided dispatch: Repo |
| <kbd>p</kbd> / <kbd>t</kbd> / <kbd>l</kbd> / <kbd>c</kbd> | Choose ship / scout / plan / chat | Guided dispatch: Kind |
| <kbd>c</kbd> / <kbd>x</kbd> / <kbd>i</kbd> | Choose Claude Code / Codex / Pi | Guided dispatch: Harness |
| <kbd>d</kbd> / <kbd>n</kbd> / printed letter | Choose the dispatch default, None or a published Workflow | Guided dispatch: After work |
| <kbd>1</kbd>…<kbd>9</kbd> | Take that position in Kind, Harness or After work. Digits type into the filter during Repo | Guided dispatch |
| <kbd>Backspace</kbd> | Delete a Repo-filter character, or go back one question from a later step | Guided dispatch |
| <kbd>Tab</kbd> | Leave the guided pass, keep every answer and focus the task box | Guided dispatch |
| <kbd>/</kbd> | Focus the filter box (sessions, plus the board's backlog), or **Scouts** search while on that page | Anywhere |
| <kbd>⌘</kbd><kbd>K</kbd> | Open [the palette](#the-palette-k) over workflows, runs, ensembles, Personas, actions, missions and settings - it opens where you are and never navigates to open; press again to close | Anywhere |
| <kbd>⇧</kbd><kbd>F10</kbd> or the Menu key | Open the [context menu](#context-menus) for the focused item or text field | Anywhere |
| <kbd>e</kbd> | Open the review queue waiting on you. Uses the selected session when it is the one asking; otherwise jumps to the first session in fleet order that is. Unclaimed when nothing anywhere is waiting. This is the keyboard equivalent of clicking the amber **to review** badge | Any session with a pending review |
| <kbd>v</kbd> | On the **Board** overview, show the selected card's full workflow or collapse it back to the active-rung preview. This is the keyboard equivalent of **Show full workflow** / **Collapse workflow** and never opens Conversation or another session-detail tab | Selected Board card with a workflow |
| <kbd>g</kbd> | Show the selected session's conversation. **Console / Board drill-in** reveals the Conversation tab; the **Board** overview opens the drill-in, which starts there | Selected session |
| <kbd>y</kbd> | Show the selected session's **Workflows** tab and workflow ladder. On the **Board** overview it drills in first; <kbd>w</kbd> opens the Library instead | Selected session |
| <kbd>d</kbd> | Use the current **Delete** button. A focused row wins, followed by the current item or the only visible Delete control; the shortcut does nothing rather than guess between unrelated destructive rows | Focused row or active surface with Delete available |
| <kbd>⇧</kbd><kbd>D</kbd> | Open the selected session's Console/Board Diff tab | Selected session |
| <kbd>m</kbd> | Turn [comment mode](#comment-on-a-line) on or off in the integrated Files tab, and show the file's source so there are lines to click | Integrated Files tab on a file with source |
| <kbd>u</kbd> / <kbd>d</kbd> | Page the rendered file preview up or down. Preview claims <kbd>d</kbd> before the global Delete action | Integrated Files tab in Preview mode |
| <kbd>Esc</kbd> or <kbd>⇧</kbd><kbd>Tab</kbd> | Return from the rendered file preview to the selected file; <kbd>Tab</kbd> enters Preview again | Focused integrated Files preview |
| <kbd>l</kbd> | Open the file displayed in the Diff reader in Files | Focused Diff reader |
| <kbd>⇧</kbd><kbd>F</kbd> | Open Files for the selected Console/Board detail | Selected session |
| <kbd>⇧</kbd><kbd>O</kbd> | Search checkout files; use the arrows and Enter to open one in Files | Selected session |
| <kbd>s</kbd> | Send a message to the selected session | Selected session |
| <kbd>↑</kbd> | Recall the newest editable queued message into the box, with the caret at the end. The box must be empty and have no attachments | Empty message composer |
| <kbd>t</kbd> | Open the **Terminal** launcher for the selected session's worktree. In Console and Board the launcher is in the detail's tab strip and answers from any tab | Selected session |
| <kbd>a</kbd> | Open the selected session's **Codex / Claude** launcher: focus its existing terminal pane, or choose a terminal in which to resume it | Selected session |
| <kbd>p</kbd> | Focus the selected session's pane | Selected session |
| <kbd>⇧</kbd><kbd>T</kbd> | **Continue in terminal**: hand the selected Agent SDK session to a terminal, continuing the same conversation. One way, and does nothing on a session that already has a pane | Selected session |
| <kbd>q</kbd> | Show / hide the selected session's work queue | Selected session |
| <kbd>⇧</kbd><kbd>Tab</kbd> | In the reader (Console or board drill-in) walk one tab left, and from the conversation hand focus back to the rail. On the rail it cycles the permission mode (Claude only), as everywhere; on the **Board** overview it cycles the selected tile's mode in place without opening its detail | Selected session |
| <kbd>⇧</kbd><kbd>R</kbd> | Rename the selected session, or the archive open on Scouts | Selected session or scout |
| <kbd>c</kbd> | Complete the selected session's task, optionally add an outcome note (blank records `completed`), then request session shutdown; press <kbd>Enter</kbd> to confirm. The detail closes once shutdown is accepted while an Agent SDK session drains in the background. Offers to unblock the tasks declared to wait on it, which is otherwise only possible by merging a PR | Selected session |
| <kbd>k</kbd> | Request shutdown of the selected session and close its detail once accepted (press <kbd>Enter</kbd> to confirm) | Selected session |
| <kbd>⌃</kbd><kbd>C</kbd> | [Interrupt](sessions.md#interrupt-stop-the-turn-without-ending-the-session) the selected session: stop the turn it is running, drop everything queued behind it, and put the cursor in its composer. No confirm - the conversation survives. Works from inside the composer, and from the Board overview without opening a detail. **Yields to a live text selection**, so <kbd>⌃</kbd><kbd>C</kbd> still copies whenever anything is selected. Works on both runtimes: an Agent SDK turn is stopped through its driver, a terminal one by writing <kbd>Esc</kbd> into the pane. A pane sitting in tmux copy-mode refuses and names the way out | Selected working session |
| <kbd>⌃</kbd><kbd>R</kbd> | Reset the selected session's checkout to origin and clear its context, if its agent has a clear command (confirms first) | Selected session |
| <kbd>↑</kbd> <kbd>↓</kbd> <kbd>←</kbd> <kbd>→</kbd> | Move between Session, the stages, their reviewers and End. <kbd>Home</kbd> / <kbd>End</kbd> jump to either terminus | [Workflows](workflows.md#workflows-and-personas) → Pipeline |
| <kbd>⌥</kbd><kbd>←</kbd> <kbd>⌥</kbd><kbd>→</kbd> | Move the focused stage earlier or later in the chain | [Workflows](workflows.md#workflows-and-personas) → Pipeline |
| <kbd>⌥</kbd><kbd>↑</kbd> <kbd>⌥</kbd><kbd>↓</kbd> | Move the focused reviewer within its stage | [Workflows](workflows.md#workflows-and-personas) → Pipeline |
| <kbd>Delete</kbd> | Remove the focused reviewer or stage, after a confirmation naming what goes | [Workflows](workflows.md#workflows-and-personas) → Pipeline |

Every shortcut managed by the shortcut list is **customizable**. Open **Settings** - the ⚙ gear
in the top bar, or (in the desktop app)
**Mission Control → Settings…** / <kbd>⌘</kbd><kbd>,</kbd> - then click a shortcut and press the new key
(optionally with <kbd>⌘</kbd> / <kbd>⌃</kbd> / <kbd>⌥</kbd> / <kbd>⇧</kbd>). On a letter,
<kbd>⇧</kbd> counts as a modifier - <kbd>⇧</kbd><kbd>O</kbd> is a binding in its own right and
plain <kbd>o</kbd> does *not* trigger it. On a key that already shifts into another character
(<kbd>+</kbd>, <kbd>?</kbd>), just press that character. Bindings persist per machine, and
trying to reuse an assigned key is refused inline. You can reset any one shortcut (or all
of them); if another custom binding has claimed that shortcut's default, resetting clears
the override and leaves the shortcut unset until its default is free. The arrow keys,
<kbd>Enter</kbd>, <kbd>Esc</kbd>, the Menu key and bare <kbd>Tab</kbd> drive structural navigation
and can't be reassigned; <kbd>⇧</kbd><kbd>F10</kbd> is the customizable context-menu action and
<kbd>⇧</kbd><kbd>Tab</kbd> remains bindable. The pipeline
editor's four rows above and the Files tab's <kbd>p</kbd> / <kbd>e</kbd> / <kbd>m</kbd> / <kbd>u</kbd> / <kbd>d</kbd> controls
are in-surface keys rather than fleet chords - they only exist while their surface is active - so
they are fixed for the same reason. The Files tab's <kbd>e</kbd> does overlap the review chord, and
wins while that tab is open: an in-surface key is claimed on the capture phase, so the surface you
are looking at keeps its own letter. Rebind **Open reviews** if you would rather have it there.
Comment mode takes <kbd>m</kbd> and shadows nothing. The mnemonic letter was <kbd>c</kbd>, which
completes the selected session's task - and while shadowing a fleet chord in a surface is exactly
what <kbd>p</kbd> and <kbd>e</kbd> already do, both of those shadow actions you can take again a
second later from anywhere. Complete ends a session, and a tab that quietly withheld it for as long
as you were reading a file is not the same trade. <kbd>m</kbd> was unclaimed, so comment mode takes
it and no fleet action loses its key.

### Keycaps on the buttons

The buttons those shortcuts drive print the key on their own face - Terminal and
Codex / Claude in the Console and Board detail's tab strip; Focus, Diff, Reset, Interrupt,
Complete and Kill in the Console
footer; the Console's Conversation, Work queue, Diff and Files tabs; the Files toolbar's Preview,
Editor and Comment controls; Dispatch and the Fleet,
Library and Runs segments in the top bar; the Board tile's workflow disclosure; the Diff reader's
Open in Files action; the **← Library** row at the top of every Library authoring rail; and the
settings rail's search box. Visible **Delete** controls carry the same resolved keycap; compact
icon-only Delete controls name it in their tooltip. They
show the *resolved* chord, so a rebind moves what they say and an unset action shows no keycap.
A narrow Console or Board detail is the one place they come off on their own: the tabs' keycaps
are the first thing that row gives up to stay on one line, and the chords keep working.

**Settings → Keyboard → Show keybindings on buttons** turns them off once you've learnt
them. Small icon-only controls (such as the ⚙ gear) never
carry one - a keycap would be larger than the icon - and name their key in the tooltip
instead.
