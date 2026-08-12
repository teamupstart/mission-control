# The Line (the pipeline strip above the fleet)

A permanent ~90px strip sits above every fleet layout: **intake → backlog → working → review
→ decide → shipped**. Six stages, wired left to right, each carrying a glyph, a count and one
sentence - the fleet's whole pipeline in one glance, in the order work actually moves through
it. A stage turns **amber when it is waiting on you**, and the wire feeding it lights with it.

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
inputs that never cross the wire at all (task-source sweep recency, the Inspector's adoption
ledger), and every other stage reuses the daemon's *existing* derivation - `reportBucket`,
`readyBacklog`, `ensembleNeedsAttention`, `deriveScheduleHealth` - rather than inventing a
second opinion that agrees until it doesn't.

Clicking a stage either opens a **drawer** in place or takes you to the surface that already
reads it:

| Stage | Click opens |
|-------|-------------|
| ⇊ Intake | **Drawer** - every task source and recurring mission, with its health line |
| ☰ Backlog | **Drawer** - the queue in the order autopilot would take it, with the triage moves on each row, escalating to the [Sitrep](attention-and-alerts.md#roundup) |
| ▶ Working | The fleet, with the filter cleared - so the count and the cards agree again |
| ⌁ Review | **Drawer** - one ladder per live run |
| ⧉ Decide | **Drawer** - the condensed decision dossier, one row per live ensemble |
| ⚑ Shipped | **Drawer** - the week's adopted pull requests, newest first, escalating to the [Ship log](library-and-line.md#the-ship-log) |

Hovering a stage gives you what it is for, plus its sentence in full - the visible line is
clipped to one row so the strip's height never moves. The flowing dots on the wires respect
`prefers-reduced-motion`: with it set, the wires stay and the dots go.

### The stage drawers

A drawer opens **between the strip and the board**, pushing the board down; closing it hands
the space straight back. It is not an overlay and it is not inside a layout - **session cards
are the same cards at the same size in every drawer state**, which the geometry tests measure
rather than assert.

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
otherwise, because their inputs never cross the wire: task-source health and the Inspector's
adoption ledger are the two stages the daemon folds from data the browser has no copy of. Both
therefore hold **three** states rather than two - loading, failed, and the answer - since
`fetchJson` resolves null on every failure, and a drawer that read that as "nothing here" would
report an unreachable daemon as a healthy empty intake or a quiet week.

Review and Backlog can also *act*. Review acts only where the summary by itself proves the run
has stopped and the route needs no argument beyond the run id - which is what keeps `Reattach`
(needs a session), resolving a delivery (needs a delivery and a choice) and disabling a
reviewer (needs a stage member) on the full page, one click deeper. Backlog carries the three
moves triage is actually made of, each on a route that already existed: dispatch, the
enable/disable switch, and the priority picker. **A refused request is reported on the drawer
and the row stays** - on both of them, for the same reason: a triage surface that dropped a row
on a failed call would be lying about the queue it is describing.

| Drawer | Each row says | Escalates to |
|--------|---------------|--------------|
| **Review** | The session, the workflow and version, the repair round, a compact pipeline of chips (evidence → reviewers → session action → Inspector), and what the run is doing - **including why it stopped**, as `Blocked · session gone`. A run stopped on *you* is marked amber; a run that has stopped and will not move on its own is marked red. Three or more runs stopped for the *same* reason are one bar instead of three rows. A run an ensemble handed off wears its **⧉ from an ensemble** provenance, which opens that ensemble | The one remedy that run's state actually takes - `Dismiss`, `Retry`, `Resubmit`, `Restart…`, or `Dismiss all` for a bar - then `Open run` → `#/runs/:id`, `All runs →` → `#/runs`, and `Bind a workflow…` opens the binding dialog |
| **Decide** | What was at stake, elapsed, the candidate progress dots, and what the run wants next. The ones awaiting an answer sort first | `Decide` (awaiting an answer) or `Open full dossier` → `#/ensembles/:id`, `All ensembles →` → `#/ensembles` |
| **Backlog** | One queued task: its title (which reopens the [Dispatch](dispatch-and-backlog.md#dispatch-an-agent) form over it), its kind, agent and age, and the marks for its state - **next up**, what it is waiting on, **parked**. The ready band is in [plan order](work-queues.md#backlog-autopilot-foreman-schedules-the-fleet), so the top row is what autopilot takes next; blocked and parked follow. **next up** is a button: it opens the [planner](#the-autopilot-planner), which says why that row is the row | `Launch now` dispatches it into a fresh worktree, the switch parks or resumes it, the picker sets its priority, and a dead prerequisite resolves from the row it is blocking. The footer carries the [autopilot switch and its readout](#the-autopilot-planner), and `Sitrep →` opens the [Roundup](attention-and-alerts.md#roundup) |
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
can start, so capacity will never clear it. **Only ready rows carry the priority picker** -
priority orders the queue, and setting it on a row that cannot run orders nothing - while a
parked row keeps its switch and a row blocked by a cancelled or failed prerequisite keeps the
[resolve button](dispatch-and-backlog.md#resolve-a-stopped-dependency), which targets the dead task and so releases
every dependent rather than just that row. A task that is both parked *and*
blocked is filed under **parked**, because that is the half you can clear from here, and its
row prints both marks so resuming it does not silently fail to reach the ready band.

#### The autopilot planner

The drawer says *what* autopilot would take next by putting the queue in the machine's own
order and marking its head. **The mark is a button, and pressing it says why.** The panel it
opens is anchored under the mark and carries four things:

- The task itself - priority, title, kind and agent, and an excerpt of its intent.
- **Foreman's own recorded reason**, quoted and attributed. Every plan entry has carried a
  `reason` since the [autopilot](work-queues.md#backlog-autopilot-foreman-schedules-the-fleet) shipped;
  this is the first surface that shows it. When the plan named the task but recorded no
  reason, the panel says that. When the plan does not name the task at all - the unplanned
  tail `readyBacklog` appends oldest-first - it says the fallback ordering put it there,
  rather than implying a decision nobody made.
- **The computed facts**, checkable against the rows behind the panel: its priority and how
  many ready items outrank it, its age and whether it is the oldest, that nothing upstream
  blocks it, and how many tasks finishing it would unblock. These deliberately do not
  flatter the plan: dependencies beat priority, so a `low` task legitimately leads a
  `blocker`, and the panel reports that rather than claiming the top row is the most
  important one.
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
five runs holding Inspector findings, say - still earns its place by saying the reason once,
and carries no control.

Two chips the Review drawer deliberately cannot draw: **how many** reviewers a run has, and a
stage the run has not reached. A run summary carries no graph, so "reviewers 2 of 4" would be
a denominator invented in the browser - the row says who is reviewing right now and points at
the run for the rest. Chips for a session action or an Inspector gate appear only when the run
actually has one, which makes their absence informative rather than grey furniture. A run
whose session disappeared shows **Reviewers stopped** in grey rather than an amber
**Reviewers**: those attempts were cancelled where they stood, so they are not waiting.

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
| **Do** | `strategy`, `command` | Launch an ensemble on a strategy, dispatch an agent, bind a workflow to a session, or open a blank draft on a Library shelf |
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
palette can never be more stale than the page beside it. And it **only ever opens a door that
already exists** - every "Do" row lands on the same modal a button somewhere else opens, and
every "Jump to" row on a route the app publishes.

The `page` kind has exactly one member, and that is a statement about the app rather than an
unfinished list: the [Ship log](library-and-line.md#the-ship-log) is the only full page with no door in the
permanent chrome. The one door it does have is two clicks inside the fleet - the Line's ⚑
Shipped stage opens its [drawer](#the-stage-drawers), whose header escalates here - so
<kbd>⌘</kbd><kbd>K</kbd> and its hash are how it is reached from anywhere else in the app.
Fleet, the Library and Runs are one press of the segmented control away, and a palette row
beside a visible door would only be a second door.

Archived assets are not indexed, because the shelf a hit would land on does not list them.
Task sources appear under Settings rather than as their own kind, which is where the Library's
Sources card points too. Sessions and backlog tasks are not searchable kinds yet - a run row
borrows its session's name, but that is a label, not an index - and they are the next kinds
the provider registry behind the palette is built to take.

## Layout (cards, console, or board)

The same fleet, three shapes. **Settings → Display → Layout** (the ⚙ gear, or <kbd>⌘</kbd><kbd>,</kbd>)
switches between them live, and the choice persists per machine:

| Layout | Shape | Good for |
|--------|-------|----------|
| **Cards** (default) | Every session a card in a responsive grid; one expands in place to fill the screen. | The general case, and the most detail per session without clicking. |
| **Console** | A dense rail of every session with one always-open detail pane beside it. | Working *one* session while keeping an eye on the rest - the conversation is permanent, not a click away. |
| **Board** | A column per state; clicking a card - or pressing <kbd>Enter</kbd> on the one the arrow keys are on - drills that column into the console's detail. | Reading the fleet's shape at a glance. "How many need me" is a column's height, not eight badges. |

Switching layouts does not change the underlying sessions. Controls repeated across
surfaces come from the *same* leaf pieces so their behavior stays aligned. What changes is
how they're arranged - dense overview surfaces select a subset, while Console and the
Board's drill-in expose the complete detail - and the console's permanent conversation
earns two surfaces a card has nowhere to put:

- **Cards** renders the full session card. The **Console** gives
  the selected session a bespoke, tabbed detail instead - **Conversation / Work queue /
  Workflows / Diff / Files** - because a split pane has room a card doesn't: the conversation
  is permanent, and the sections that share a card's height in the grid get a tab each. The
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
  The **Board** drills into that same detail when you open a card.
  In Console and Board, the
  Diff tab contains the complete checkout diff reader; the footer action and <kbd>d</kbd>
  reveal it in place. Cards keep the diff in a modal viewer.
- **The console's two extras are Foreman's**, and both need a conversation to exist:
  its notes render inline in the transcript, and a **Foreman · N** rail at the far end of
  the tab row opens their history. The rail is deliberately *not* a sixth tab - Work queue,
  Workflows and Diff are things the session *has*, while Foreman is an observer talking
  *about* it. A card keeps the full note block instead, since it has no transcript to inline
  into.
- **Cards** is the only layout with an in-place focus mode, so its floating command bar is
  unique to it. On the **board**'s overview <kbd>e</kbd> (expand) opens the drill-in the way
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
  <kbd>Esc</kbd> peels back one layer at a time - reader to rail, then deselect, emptying
  the pane. **The board's drill-in reads the same**: opening a card morphs its column into
  this rail-plus-reader, and every key here behaves identically there.
- **The board separates the two**, because its overview is worth reading without being
  dragged through every transcript on the way. The arrow keys move a visible cursor from
  tile to tile and open nothing; <kbd>Enter</kbd> drills the selected one into the console
  detail, and <kbd>Esc</kbd> comes back out with the cursor still on the card you left. Once
  you're in, the arrow keys keep moving the open detail through the board - the drill-in
  is always the selected session. Clicking a tile still does both in the one gesture.
  Acting on the cursor works either way: <kbd>s</kbd>, <kbd>⇧</kbd><kbd>F</kbd>, <kbd>q</kbd> and
  <kbd>k</kbd> pressed on the overview drill in and then do what they say. The one exception
  is <kbd>⇧</kbd><kbd>Tab</kbd>, which cycles the selected tile's permission mode in place
  without opening its detail.
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
  keys walk straight past the header, so navigation is unchanged. **Cards** sorts siblings next
  to each other but grows no frame: its arrow keys are geometric against the live CSS grid
  tracks, and a header cell would silently break <kbd>↑</kbd>/<kbd>↓</kbd>.
  A cluster never crosses a Board column: if one member is waiting on your answer it sits in
  **needs you** with the run's header repeated there, rather than dragging its working siblings
  out of the column that describes what they are. Dragging a backlog card onto a clustered tile
  works exactly as it does anywhere else - the frame is a drawing, not a drop target.
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
  it renders the same ordering, and **Cards** wears the same spine and tag on its cards - that
  layout draws no section rule, so the mark is its whole answer. A held tile also refuses the
  backlog drag: dropping a card
  hands work over by resetting the agent, and a held agent's next turn belongs to its run - so
  during a drag the card lights up only over agents that are genuinely free.
- **Killing a session closes its detail** once shutdown is accepted, without waiting for an
  Agent SDK subprocess and event stream to finish draining. The board goes straight back to
  its columns, the console empties its pane, and Cards leaves focus mode with the card still
  selected. The card reads **stopping** during that drain, then **exited** until its ordinary
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
  the board stays on screen to show it. Cards and Console draw no tasks, so there a query
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

The Conversation is drawn as a **chat log** by default and can be drawn as a **terminal
stream** instead - prompt lines in, stdout out, tool runs folded into one record, inside a
frame with a live status line. **Settings → Display → Conversation** sets the default for
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
same session's Files workspace. Console and Board reveal their integrated Files tab; Cards
reuse the extracted Files window. Checkout-relative links and absolute paths beneath the
checkout are accepted, including optional line and column suffixes. External links keep
their normal browser behavior, and resolved paths outside the checkout never open. HTML and
Markdown open in Preview by default, while every other file type opens in the editor - so a
generated page a session links to is read as the page it is, and source is read as source. The
Preview and Editor buttons publish which of the two is showing as their pressed state, so the
view a file landed in is legible to a screen reader and not only to the eye. HTML preview
remains inert: a bounded set of checkout-local stylesheets is inlined through the contained
file reader, without granting the sandbox scripts or network access.

**The Diff tab has the same door.** The bar naming the file you are reading carries an
**Open in Files** action, on every file, which opens that file in the Files tab beside it -
the same route, the same containment rules. Two files it will not open, and it says which
rather than failing on the click: a **deleted** file, which has no copy left in the checkout
to read, and a file **outside the session's working directory**. The second is possible
because the two readers measure paths from different places - git writes them relative to
the repository root, while the Files tab lists the working directory it was opened in - so a
session started in a subdirectory can see changed files that its Files tab has no route to.
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
you (`git ls-files`, tracked plus untracked, capped at 2000 entries), so a path the tab
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

## Keyboard shortcuts

The dashboard is keyboard-driven - use the arrow keys to navigate Cards and Board, to walk
the Console rail or scroll its open reader, then act without reaching for the mouse. The table
names the layouts where a shortcut's target exists:

| Key | Action | Scope |
|-----|--------|-------|
| <kbd>↑</kbd> <kbd>↓</kbd> <kbd>←</kbd> <kbd>→</kbd> | Around the grid in **Cards**; in **Console** and the **Board** drill-in <kbd>↑</kbd>/<kbd>↓</kbd> walk the rail selection, or scroll the reader's active tab once you <kbd>Tab</kbd> into it (and move through files while its inline Diff reader is focused); along and across the columns in the **Board** overview. With nothing selected, the first arrow selects the first session | Anywhere |
| <kbd>Tab</kbd> | **Console & board drill-in:** step into the open detail and one tab right each press - Conversation → Work queue → Workflows → Diff → Files - clamping at the last rather than tabbing away. The reader takes a soft ring and <kbd>↑</kbd>/<kbd>↓</kbd> scroll whichever tab shows; <kbd>⇧</kbd><kbd>Tab</kbd> walks back, and from the conversation (or <kbd>Esc</kbd>) hands the keyboard to the rail | Open detail (Console or Board) |
| <kbd>Enter</kbd> | Open the selected session's detail. **Cards**: focus-expands or collapses the selected card. **Board**: opens the drill-in. Console already shows the selected session. On a focused link or button Enter activates that instead, as it always does | Anywhere |
| <kbd>Esc</kbd> | Peel back exactly one layer per press - first close whatever's open on top of the grid (a panel, a dialog, the away digest), then leave a focused text box, then collapse an expanded card (**Cards**), hand a Console reader back to its rail, or leave the drill-in with the cursor still on it (**Board**), then deselect | Anywhere |
| <kbd>f</kbd> | Open **Fleet** | Anywhere |
| <kbd>w</kbd> | Open the **Library** | Anywhere |
| <kbd>r</kbd> | Open **Workflow Runs** | Anywhere |
| <kbd>⇧</kbd><kbd>P</kbd> | Open or close **Sitrep** | Fleet |
| <kbd>+</kbd> | Dispatch an agent | Anywhere |
| <kbd>/</kbd> | Focus the filter box (sessions, plus the board's backlog) | Anywhere |
| <kbd>⇧</kbd><kbd>F10</kbd> or <kbd>Menu</kbd> | Open the context menu for the focused text, external link, or text field. In a field it offers Cut, Copy, Paste, and Paste as quote as applicable. Right-click opens the same menu; <kbd>⇧</kbd>+right-click keeps Chromium's native menu | Anywhere |
| <kbd>⌘</kbd><kbd>K</kbd> | Open [the palette](#the-palette-k) over workflows, runs, ensembles, Personas, actions, missions and settings - it opens where you are and never navigates to open; press again to close | Anywhere |
| <kbd>e</kbd> | On the **Board** overview, show the selected card's full workflow or collapse it back to the active-rung preview. This is the keyboard equivalent of **Show full workflow** / **Collapse workflow** and never opens Conversation or another session-detail tab | Selected Board card with a workflow |
| <kbd>g</kbd> | Show the selected session's conversation. **Console / Board drill-in**: reveals the Conversation tab. **Board** overview: opens the drill-in, which starts there. **Cards**: expands the card, where the transcript already lives. Only ever reveals - <kbd>Enter</kbd> owns the Cards toggle | Selected session |
| <kbd>y</kbd> | Show the selected session's **Workflows** tab and workflow ladder. On the **Board** overview it drills in first. Cards draws no tab strip and never showed the ladder, so the chord is unclaimed there; <kbd>w</kbd> opens the Library instead | Selected session (Console or Board) |
| <kbd>d</kbd> | Open the selected session's diff (in the Console/Board Diff tab, or the Cards modal) | Selected session |
| <kbd>⇧</kbd><kbd>F</kbd> | Open Files for the expanded card or the selected Console/Board detail | Selected expanded/detail session |
| <kbd>⇧</kbd><kbd>O</kbd> | Search checkout files; use the arrows and Enter to open one in Files | Selected session |
| <kbd>s</kbd> | Send a message to the selected session (on an expanded card, jumps to the reply box already there) | Selected session |
| <kbd>↑</kbd> | Recall the newest editable queued message into the box, with the caret at the end. The box must be empty and have no attachments | Empty message composer |
| <kbd>t</kbd> | Open the **Terminal** launcher for the selected session's worktree. In Console and Board the launcher is in the detail's tab strip and answers from any tab; on a card, if its conversation is not visible this reveals it first, then opens the terminal chooser | Selected session |
| <kbd>a</kbd> | Open the selected session's **Codex / Claude** launcher: focus its existing terminal pane, or choose a terminal in which to resume it - revealing the conversation first only where the launcher lives above it | Selected session |
| <kbd>p</kbd> | Focus the selected session's pane | Selected session |
| <kbd>⇧</kbd><kbd>T</kbd> | **Continue in terminal**: hand the selected Agent SDK session to a terminal, continuing the same conversation. One way, and does nothing on a session that already has a pane | Selected session |
| <kbd>q</kbd> | Show / hide the selected session's work queue | Selected session |
| <kbd>⇧</kbd><kbd>Tab</kbd> | In the reader (Console or board drill-in) walk one tab left, and from the conversation hand focus back to the rail. On the rail it cycles the permission mode (Claude only), as everywhere; on the **Board** overview it cycles the selected tile's mode in place without opening its detail | Selected session |
| <kbd>⇧</kbd><kbd>R</kbd> | Rename the selected session - its terminal home, or an Agent SDK session's own durable name | Selected session |
| <kbd>c</kbd> | Complete the selected session's task, optionally add an outcome note (blank records `completed`), then request session shutdown; press <kbd>Enter</kbd> to confirm. The detail closes once shutdown is accepted while an Agent SDK session drains in the background. Offers to unblock the tasks declared to wait on it, which is otherwise only possible by merging a PR | Selected session |
| <kbd>k</kbd> | Request shutdown of the selected session and close its detail once accepted (press <kbd>Enter</kbd> to confirm) | Selected session |
| <kbd>⌃</kbd><kbd>C</kbd> | [Interrupt](sessions.md#interrupt-stop-the-turn-without-ending-the-session) the selected session: stop the turn it is running, drop everything queued behind it, and put the cursor in its composer. No confirm - the conversation survives. Works from inside the composer, and from the Board overview without opening a detail. **Yields to a live text selection**, so <kbd>⌃</kbd><kbd>C</kbd> still copies whenever anything is selected. Works on both runtimes: an Agent SDK turn is stopped through its driver, a terminal one by writing <kbd>Esc</kbd> into the pane. A pane sitting in tmux copy-mode refuses and names the way out | Selected working session |
| <kbd>⌃</kbd><kbd>R</kbd> | Reset the selected session's checkout to origin and clear its context, if its agent has a clear command (confirms first) | Selected session |
| <kbd>↑</kbd> <kbd>↓</kbd> <kbd>←</kbd> <kbd>→</kbd> | Move between Session, the stages, their reviewers and End. <kbd>Home</kbd> / <kbd>End</kbd> jump to either terminus | [Workflows](workflows.md#workflows-and-personas) → Pipeline |
| <kbd>⌥</kbd><kbd>←</kbd> <kbd>⌥</kbd><kbd>→</kbd> | Move the focused stage earlier or later in the chain | [Workflows](workflows.md#workflows-and-personas) → Pipeline |
| <kbd>⌥</kbd><kbd>↑</kbd> <kbd>⌥</kbd><kbd>↓</kbd> | Move the focused reviewer within its stage | [Workflows](workflows.md#workflows-and-personas) → Pipeline |
| <kbd>Delete</kbd> | Remove the focused reviewer or stage, after a confirmation naming what goes | [Workflows](workflows.md#workflows-and-personas) → Pipeline |

Every shortcut except the arrow keys, <kbd>Enter</kbd>, <kbd>Esc</kbd>, and the dedicated
<kbd>Menu</kbd> key is
**customizable**. Open **Settings** - the ⚙ gear in the top bar, or (in the desktop app)
**Mission Control → Settings…** / <kbd>⌘</kbd><kbd>,</kbd> - then click a shortcut and press the new key
(optionally with <kbd>⌘</kbd> / <kbd>⌃</kbd> / <kbd>⌥</kbd> / <kbd>⇧</kbd>). On a letter,
<kbd>⇧</kbd> counts as a modifier - <kbd>⇧</kbd><kbd>O</kbd> is a binding in its own right and
plain <kbd>o</kbd> does *not* trigger it. On a key that already shifts into another character
(<kbd>+</kbd>, <kbd>?</kbd>), just press that character. Bindings persist per machine, and
trying to reuse an assigned key is refused inline. You can reset any one shortcut (or all
of them); if another custom binding has claimed that shortcut's default, resetting clears
the override and leaves the shortcut unset until its default is free. The arrow keys,
<kbd>Enter</kbd>, <kbd>Esc</kbd>, the <kbd>Menu</kbd> key, and bare <kbd>Tab</kbd> drive layout navigation and Console
reading, and can't be reassigned; <kbd>⇧</kbd><kbd>Tab</kbd> remains bindable. The pipeline
editor's four rows above are in-surface keys rather than fleet chords - they only exist
while a card in that strip has focus - so they are fixed for the same reason.

### Keycaps on the buttons

The buttons those shortcuts drive print the key on their own face - Terminal and
Codex / Claude in the conversation toolbar (the strip above a card's conversation, and the
Console and Board detail's tab strip); Send, Focus, Files, Queue, Reset, Interrupt,
Complete and Kill on a card; Focus, Diff, Reset, Interrupt, Complete and Kill in the Console
footer; the Console's
Conversation, Work queue, Diff and Files tabs; a card's `diff` pill; Dispatch and the Fleet,
Library and Runs segments in the top bar; the Board card's workflow disclosure; and the settings
rail's search box. They
show the *resolved* chord, so a rebind moves what they say and an unset action shows no keycap.
A narrow Console or Board detail is the one place they come off on their own: the tabs' keycaps
are the first thing that row gives up to stay on one line, and the chords keep working.

**Settings → Keyboard → Show keybindings on buttons** turns them off once you've learnt
them. Small icon-only controls (the ⚙ gear and the expand chevron) never
carry one - a keycap would be larger than the icon - and name their key in the tooltip
instead. The command bar is unaffected either way: it is nothing but keycaps.
