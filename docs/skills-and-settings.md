# Half-written text is kept

A session card **keeps what you've typed** until it is successfully submitted. Conversation
messages then remain visible in the editable outbox until delivery. Three boxes hold a draft:

- the **Work queue** panel's add box,
- the **reply** box under the transcript on an expanded card, and
- the **send** box - opened by <kbd>s</kbd> on the selected session, or by **Send** on the
  card.

A card only ever has **one** box to send from - at any moment, in every state. The rule
keys off whether a reply box actually *exists*, not off whether the card is expanded:
whenever the transcript is carrying one, <kbd>s</kbd> and **Send** put the cursor *there*
rather than opening a second, and a send box already open closes itself the moment a reply
box appears. When there's genuinely no reply box - an expanded card whose transcript can't
be read renders no reply row - **Send** opens the card's own box, which is exactly right:
one box either way. Nothing is lost when one closes, because the text is in the draft map;
press **Send** again and it's waiting in it.

Each survives everything that isn't you deleting text: **collapsing the card** (opening any
other card collapses this one - only one is expanded at a time), a **filter** that hides the
card, and **Cancel** / <kbd>Esc</kbd> on the send box. Glance at the grid mid-sentence and
come back - your text is still there, exactly as the [dispatch form](dispatch-and-backlog.md#dispatch-an-agent)
treats a half-written task.

A draft is forgotten on **successful submission**: a send that creates a durable pending
turn for the reply and send boxes, or an **Add** that lands for the queue box. **Resetting
the session** also forgets the reply and send drafts - a reset discards the task those boxes
were replying to, so their half-written text goes with it, and an open reply box empties on
the spot rather than keeping stale text behind the closing modal. The **queue add box is
kept** through a reset, since it composes new work rather than a reply to the discarded task.
A send that *fails* deliberately keeps your text - it's all you have and you're about to retry
it. Drafts are per session and never bleed from one card into another.

Once **Send** succeeds, the composer draft becomes a durable queued turn. The full conversation
turn stays visible beneath the conversation while Mission Control owns it. The compact Send
surface shows a single-line, ellipsized preview of that same queued text. Recalling it with
<kbd>↑</kbd> moves the full text back into the same draft system with the caret at the end.
If the recall response is lost after the daemon may have committed it, the browser restores
the exact text it already held and warns you to confirm the queued copy disappears before
sending; an explicit stale-revision conflict leaves the composer untouched.
Recalled attachment uploads return as their already-inserted file paths; the thumbnail strip
is not reconstructed.

Two things worth knowing:

- The scope is this **browser tab**. A reload starts over; drafts aren't stored anywhere.
- **Images are the exception - only the text comes back.** A screenshot dropped on the queue
  add box is gone once you close the drawer, and one on the reply box once the card
  collapses, so attach yours when you're ready to send. (The
  [dispatch form](dispatch-and-backlog.md#dispatch-an-agent) is the one that keeps its attachments across a close.)

## Skills (every session, mixed reload behavior)

Settings (the topbar gear, or ⌘,) has a **Skills** catalog: read what a skill does,
switch it on, and it applies to **every** session on this machine whose harness has a
skills directory - including sessions this app never launched. How a running session notices
the change depends on its harness.

Skills are ordinary native harness skills, living in `skills/<id>/SKILL.md` in this repo
so they're versioned and reviewed with the app. Enabling one symlinks it into
`mission-<id>` under **each declaring harness's own directory** - `~/.claude/skills` for
Claude, `~/.agents/skills` for Codex, and `~/.pi/agent/skills` for Pi - which is that
agent's own loading path; the harness never reimplements it.

The opt-in **Pull Request** row applies whenever a session prepares, opens, or reports a
PR. Inspector-gated workflows also require it for **Prepare PR in session** and invoke it
through the bound harness's native skill syntax, so that final handoff is enforced rather
than left to model selection. Its reviewer-ready description contract has two sections: a
concise, bullet-forward **For Humans** for the why, feature description, tradeoffs, known gaps,
evidence, and recommended follow-ups; and **For Agents** for direct links to the plan and
technical documentation, technical context those documents do not cover, and deliberately
handled failure modes. It does not inventory changed tests or repeat design detail already
covered by the linked documents. The full contract lives in
[`skills/pull-request/SKILL.md`](../skills/pull-request/SKILL.md).

The opt-in **Retro** row carries the retrospective procedure: read a finished session back
from its transcript, propose at most three durable memories, have each one approved, edited,
or rejected, and commit the approved ones into the target repository's
[`.agents/memory`](repository-memory.md). It is what the retro request delivers into a session,
and the retro **fails closed while it is switched off** - `POST /api/sessions/:id/retro` answers
409 with the sentence that names this toggle, whether it would have typed the instruction into a
live session or filed a retro task for a dead one. Neither happens, because this skill carries
the human-approval step rather than merely describing it. Switch it on before running a retro.
The procedure lives in [`skills/retro/SKILL.md`](../skills/retro/SKILL.md).

The opt-in **Phased Plan** row investigates an approved plan against the repository, writes
merge-aware phase documents beside it, and schedules one dependency-linked backlog task per
phase. The HTML Plans review always offers this as its final selectable follow-up; choosing it
passes the approved plan and submitted decisions into
[`skills/phased-plan/SKILL.md`](../skills/phased-plan/SKILL.md).

The opt-in **HTML Report** row applies to the other half of the work - the sessions that are
asked to find something out rather than to change something. An investigation, scout, audit or
research answer is written as one self-contained page at `docs/reports/<slug>/report.html` and
the session logs its checkout-relative path, which the conversation turns into a link that opens
the report in the Files tab, rendered rather than as source. The page carries no JavaScript on
purpose: the Files preview is a sandboxed iframe that runs only its own two bridge scripts, so a
report that built itself at runtime would be blank in the one place it is most likely to be read.
The contract lives in [`skills/html-report/SKILL.md`](../skills/html-report/SKILL.md).

This row is opt-in and a **scout task does not depend on it**. A scout is told to write and
submit its page by its own prompt, composed by the daemon at the moment the task is delivered,
so the requirement arrives with the global toggle off and with no skills installed at all. The
skill is how to write a good report; the scout contract is whether one exists, and it is
enforced by [archives](archives.md) rather than by a setting.

**Being loaded and being noticed are two capabilities, and only the second differs.** A
Claude session re-reads its directory only when told, so the daemon types `/reload-skills`
into its pane when it next goes quiet. Codex declares no reload command, because it
watches its own directory - which means a Codex session picks the change up with nothing
typed at it at all, and is deliberately excluded from the pane broadcast rather than sent a
slash command that would land in its composer as text. Pi's reload is launch-scoped: a Pi
session dispatched by Mission Control has an injected identity, so its exact transcript can
prove idle and the daemon can safely type `/reload`; an operator-started Pi session has no
such binding and picks changes up only on its next launch or restart.

Three things worth knowing before you switch one on:

- **The blast radius is the point, and it's global.** These are your own directories,
  shared by every agent of that kind on the machine. The harness only ever creates or
  removes entries under its own `mission-` prefix (and the `fleet-` one it used
  before the rename), and only ones that are symlinks - your own skill directories are
  untouchable by construction, not by
  care. **Turning the master switch off is the real uninstall**: it's the only control
  that both removes every link and records that you wanted them gone, so nothing brings
  them back. Removing the links any other way is temporary - the daemon reconciles
  every declared directory against this config on every start, so a config still saying
  "on" re-creates them. (The tray's "Remove Claude integrations" is hooks and the MCP
  server only; it does not touch skills.)
- **Enabling a skill loads it; it does not oblige the agent to use it.** Native skills
  are model-invoked, so each row carries an **enforcement badge** saying which rung it
  sits on. "When relevant" means exactly that.
- **The "N sessions will pick this up" count is about the reload nudge, not about
  reach.** It counts the sessions the daemon will type at, which is the ones whose harness
  declares a reload command and whose per-session readiness source is currently available.
  It excludes Codex sessions that watch automatically and operator-started Pi sessions that
  require a restart, while counting identity-bound dispatched Pi sessions. Reach is the
  `skills` capability; the count is the reload-readiness contract, and they are
  deliberately different questions.

### The daemon is no longer strictly reactive

**Read this before adding another autonomous writer.** Until skills shipped, the daemon
typed into a pane only downstream of a route call - which meant downstream of a person.
The only unprompted typing in the system was quarantined in [Foreman](foreman.md#foreman-auto-responder),
a separate, leased, opt-in worker process. The skills reload loop
(`src/server/skills/reload.ts`) ends that invariant: it runs *in* the daemon, holds no
lease (the port bind is the mutex - two daemons can't both hold `:7317`), and types on
its own schedule.

The gate that makes it safe is not paperwork. `injectPrompt` presses Enter
unconditionally, and a Claude dialog is a **select list, not a text prompt**: pasted
text is swallowed and the Enter activates whichever option is highlighted. Fired
across every session, that's an unattended answer to a permission prompt nobody read, in every
pane at once. So a reload requires `settledIdle` (a *reported* idle, not the
uninstrumented default) **and** a pane read confirming Claude's mode line is on screen,
which a dialog or menu replaces. If you add a second autonomous writer, it needs the
same gate, and it needs `withPaneLock` in `actions.ts` - the reload loop is why that
guard covers every pane write rather than just permission-mode cycling.

[Task sources](dispatch-and-backlog.md#task-sources-pulling-work-into-the-backlog) are the worked example of the
other answer. The sweeper also runs in the daemon, holds no lease and acts on its own
schedule - and it needs **none** of that gate, because **it never types**. It writes
backlog rows: no pane is read, no keystroke is sent, nothing is provisioned. That is why
the test is "does it type?" rather than "is it autonomous?". The moment a source can type,
this whole argument has to be redone for it.

The mutual exclusion is the **port bind**, and it holds for the default port: a second
`npm start` can't take `:7317`, so there's exactly one reload loop. It does *not* hold
for `MISSION_PORT=<other>`. A daemon on a spare port is a second, fully autonomous writer
aimed at the same real panes - discovery finds the same sessions whatever port you serve
on, and an isolated `MISSION_HOME` makes it *worse*, because its ack table is empty and it
believes every session is owed a reload. If you're testing against a spare port, know
that its reload loop is live from the moment it boots.

## Settings

Settings is a **page**, not a modal: `#/settings/<category>` in the URL, reached from the ⚙
gear in the top bar, from **Mission Control → Settings…** / <kbd>⌘</kbd><kbd>,</kbd> in the
desktop app, or by opening the link directly. <kbd>Esc</kbd> returns you to the fleet, the
gear takes you back the same way, and browser back/forward walk the categories you visited.
While the page is up the session and panel shortcuts stand down, so nothing you type here can
drive the fleet behind it. The direct Fleet, Library and Runs shortcuts remain available when
focus is not in a text field.

The rail is grouped by **blast radius**, and each group carries a badge saying how far its
settings reach. That is the question a flat list of thirteen peers could not answer: which of
these stays in this browser, and which of them acts publicly under your account.

| Group | Reach | Categories |
|-------|-------|-----------|
| **This screen** | This browser | **Display** (layout + message formatting), **Keyboard**, **Dispatch** |
| **Sessions** | This machine | **Harnesses**, **Skills** (writes `~/`), **Cost** (writes `~/`) |
| **Background work** | This machine | **Foreman**, **Workflows**, **Task sources**, **Models** |
| **Leaves the machine** | Acts on GitHub | **Inspector**, **Shipping**, **Trust** |

The badge on a group is the general case; the badge in a panel's own header is that
category's precise claim, which can be stronger - Skills sits under *This machine* and
symlinks into `~/.claude/skills` and `~/.agents/skills`, so its own badge says `Writes ~/`.

Two things changed shape when the page arrived. **Layout and Appearance merged into
Display**: both are one browser's preferences about how this screen draws the fleet, and a
category holding a single checkbox sat as a visual equal of the one that merges pull
requests. And **Task sources is master-detail** - the directory of configured sources beside
the one you are editing, instead of a drill-in that hid the other three while you repaired
the one that failed. Adding a source is an inline form above that list; it still resolves the
repo before the source exists, and the source still starts switched off.

**Workflows** joined the rail later, from a floating drawer on the page the run list used to
share with the builder. It carries
the same four things the drawer did - the [Live delivery](workflows.md#live-repair-delivery-and-foreman-completion)
switch and its explicit warning, the scope of repositories Live delivery may send in (a grant
**count** and a **Manage in Trust** link, since the list itself became a
[Trust](#trust-who-may-act-in-which-repository) column), the
[retention](workflows.md#retention-history-exports-and-workflow-health) limits (shortening one still asks
first), and the health counters - on the same routes, with nothing about the config changed. What
it gains by being here is everything a drawer could not have: a rail row, a scope badge, a deep
link, and a place in ⌘K, so the one switch in this app that can type into somebody's live agent
session is findable by searching for what it does. The runs page header keeps a link to it.

**Dispatch** joined last, and it is the one row holding a single checkbox - **Guided
dispatch**, which is the same preference the **Guided** switch in the dispatch modal's header
writes. That reads against the paragraph above, so here is the reasoning. Display absorbed a
lone checkbox because message formatting *is* how this screen draws the fleet, which is the
whole of what Display claims to be; how the dispatch form asks its questions is not. The other
category whose blurb says "dispatch" is Harnesses, and that one is *This machine* and
daemon-backed - filing a browser-local preference there would have put it under a badge
promising it changes what the daemon does, for sessions this page never opened. A thin row
costs less than a badge that overclaims. What the row buys is the thing the header switch
could not: the preference is now in ⌘K by name, flippable from a search result without
leaving the page you are on, and `#/settings/dispatch` is a link you can keep.

**Inspector, Shipping and Foreman are consoles**, not forms: the controls sit in a narrow
column and a per-item ledger takes the wide one, under a strip of counts. That is the
split those three panels needed and the other ten do not - their knobs are set once,
while their ledgers are read repeatedly and answer the only questions those subsystems
raise (*what did the review say*, *why has nothing merged*, *what has Foreman been
deciding*). As a 12px list at the foot of a vertical form, the ledger was the least
legible thing on the page and the most important. **Every tile in the count strip is a
filter**, and there is a tile for every state a row can be in, so the numbers always add
up to the rows underneath - a strip that ignored the closed pull requests read "1 with
findings, 0, 0, 0" over a table of fifty.

**Workflows takes the same cards without the split**, because the console shape is three
separable things and a panel should take the ones it has the data to be honest about. It has
no ledger to put in a wide column: the runs page already owns the run list, with paging,
live updates and per-run actions, and a second copy in a settings panel would disagree with
the real one the first time either changed. So its single column stays a single column, and
its health strip **navigates instead of filtering** - each tile opens the nearest
corresponding run-list view, with a status filter where one exists, rather than pretending to
select rows this panel does not have. Those tiles count fleet-wide totals over different
populations and deliberately do not add up to anything.

Foreman's ledger is **fleet-wide**, which is the one thing no other surface shows: every
decision it has faced across every session, newest first, where before this the record
was readable only one session at a time through that session's drawer. Its strip is
folded from those rows and not from the live-session counts in the topbar - the two are
different populations by design, and a tile that disagreed with the rows under it would
make every other number on the panel worth nothing.

Deep links work for every category, and the whole list is stable enough to paste into an
issue: `#/settings/shipping`, `#/settings/task-sources`, `#/settings/models`. A link naming
a category this build does not have falls back to Display rather than a blank pane - the one
browser-scoped category, so a stale link can never open a panel that acts on GitHub.

**Status dots** on the rail say what each subsystem is doing without opening it, and they
move over the live channel - no polling, and right whenever the app is open, not only while
a panel is on screen. **Inspector** is green when it is switched on and live (reviews post
to GitHub); **Shipping** is amber when YOLO mode is armed; **Task sources** is red when a
source failed its last sweep; **Foreman** is purple when the auto-responder is on; **Trust**
is amber when YOLO is armed with a merge-without-review blind spot. The topbar ⚙ **gear
inherits the worst of them** - red over amber over green - so a subsystem that needs you
shows from the fleet; the gear's tooltip names what the dot means. Before the first status
arrives (a cold tab, a reconnect) the dots stay dark rather than claim an all-clear.

### Reaching a setting from the palette

Roughly seventy controls span the thirteen categories, so search is how you reach one you
half-remember without knowing which panel it lives in - and that search is the app-wide
<kbd>⌘</kbd><kbd>K</kbd> palette, not a settings-only box. See
[The palette (⌘K)](ui.md#the-palette-k) for the whole surface; what matters here is what it does
with a settings row.

Open it from anywhere, or from the **search box at the top of the rail**, which shows the
current chord as its hint; the topbar ⚙ gear keeps its one job of navigating to the page.
The settings index covers **controls, not content**: every switch, picker, model field and
sub-panel is in it, but repo names and PR numbers are not. A row **jumps** to its category
and flashes the exact control it named, so landing on "Soak time" puts you on the field
rather than at the top of Shipping.

Two of the boolean controls - **Format messages** and **Track Claude estimated cost** -
**flip inline** from the row without leaving the palette. The others jump, and that is the
honest answer rather than a shortcoming: a switch can only be flipped from a row when its
current value has actually been read, and the configs behind **Auto mode on dispatch** and
**Enable Mission Control skills** are polled by the Settings page alone. A palette that
opens over the fleet has not read them, so it takes you to the panel that has.

The **risky set** - YOLO mode, the Inspector's enable and mode, Live workflow delivery and
workflow Commands - never flips from a row under any circumstances: it always jumps,
so the consent copy that explains what merges, gets published, or runs branch-authored code
is on screen when it changes.

### Trust (who may act in which repository)

Four subsystems act outside this app, and each keeps its own list of the repos it is allowed
to act in: Foreman sends live, Workflows deliver repairs and run Commands, the Inspector posts
reviews, and Shipping (YOLO) merges. **Settings → Trust** (`#/settings/trust`) is one table
over all four - a row per repository, a column per grant - so the whole surface of "what may
act where" is on one screen instead of scattered across four panels. Columns run local blast
radius first (Foreman, Workflows), then GitHub (Inspector, YOLO).

- **It is a view, not a new store.** Each column is the subsystem's existing allowlist;
  ticking a cell writes to that subsystem's own config through the same route its panel used
  to, and the daemon's four consent gates are unchanged. The Foreman, Workflows, Inspector and
  Shipping panels now show a grant **count** and a **Manage in Trust** link where their repo
  editors used to be - a grant is not the same permission in each column, which is the whole
  reason they stay four lists.
- **One column carries two capabilities**, and says so. Workflows stores a single allowlist
  that gates both Live repair delivery and Command-node execution, so the matrix draws
  one cell and its tooltip names both. Two columns over one stored list would flip together
  and lie about being separate grants; splitting them for real would take two stored lists
  first. Each capability still has its own switch in **Settings → Workflows**, so the cell is
  necessary for both and sufficient for neither.
- **Adding is configuration; enabling is consent.** Adding a repo (resolved and canonicalized
  first, so a typo is refused) stages an empty row and grants **nothing** - every cell starts
  off, one deliberate click each. A staged, ungranted repo is remembered per machine so it
  survives a reload before you come back to grant it.
- **Repository labels use directory names.** Read-only repository labels normally show only
  the final directory name; hover the label to see its complete path. If a Trust warning names
  two repositories with the same directory name, it shows their full paths in the warning so
  the entries remain distinguishable. Repository inputs keep the full path because that is the
  value being edited.
- **Worktrees count too.** A grant names the **repo**, so a session in any worktree of a
  granted repo is covered, wherever that worktree lives on disk.
- **The blind spot is visible.** If YOLO may merge in a repo the Inspector may not review,
  nothing there can ever qualify - the merge cell and the empty review cell both go amber, and
  a footnote offers the two fixes in place: **grant the review**, or **revoke the merge**.
  Shipping's own dependency warnings link straight here. The rail's Trust dot carries it, so
  the trap is visible from any other category.
- **So is the heaviest grant.** While workflow Commands are switched on, every granted
  Workflows cell flies a **double dagger** and a footnote names those repositories: a Command
  node may run branch-authored code there with the daemon's filesystem authority, and it is
  not a sandbox. **Turn Commands off** is offered in place. This one is not a contradiction like
  the merge trap - nothing is stuck - it is flagged because a cell reading "allowed" cannot
  show that on its own and the confirm dialog was agreed to once, months ago. The rail's Trust
  dot carries this one too.
- **The warning outlives the connection.** Both surfaces remember the last **confirmed**
  arming, so a failed config poll cannot retire them. This is a deliberate exception to the
  daemon-reading rule everywhere else in Settings, where a failed read becomes "unknown" and
  replaces the last good value: that is right for a switch, whose stale posture must never be
  drawn as current, and wrong for a safety claim, which would then switch itself off five
  seconds after the daemon went quiet. Nothing about an unreachable daemon disarms the switch
  it is storing. While the config is unreadable the footnote says so and stops naming
  repositories - it cannot see which - but it does not go silent, and it is never invented:
  a page that has never read a config claims nothing.
