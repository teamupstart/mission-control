# Residents

A **resident** is a long-running agent with a standing role. You author a **resident profile**
once - an optional Persona, instructions, a harness, model and effort, and a default repository - and
launch it from **Dispatch > Resident**. It runs as an ordinary session in the Agent SDK, keeps its
role through compaction and restarts, and ends only when you choose **Complete & close**.

This page describes profiles, launch, the persistent wake loop, repository-free residents,
[instruction changes a resident proposes](#changing-instructions-from-the-conversation) and its
retro, skill sources, session control, MCP servers and their dashboard controls. Skill selection remains a later phase of
[the residents plan](plans/persistent-agent-profiles/plan.md).

## Resident profiles

Open **Residents** from the ⌘K palette, with **Shift+A**, from **Manage residents** in the
[Residents dock](#the-residents-dock), or from **Edit profile** in Dispatch's Resident mode. The page lists your live profiles beside an editor.

| Section | What it decides | Default |
|---|---|---|
| Identity | The name (unique among live profiles) and an optional description | required |
| Persona | The Library Persona whose guidance becomes the resident's standing role | none |
| Instructions | Markdown added after the Persona's guidance; without a Persona, the whole role | empty |
| Harness, model and effort | Claude Code or Codex; the model and effort the harness offers | Claude Code, harness defaults |
| Workspace | The repository Dispatch pre-fills | none |
| Board presence | The marker color, its label, and **Pin to top of column** | first color, label from the name, pinned |
| Loop and guardrails | Loop prompt, cadence, requested-delay bounds, rolling caps and compaction | 5 minutes; 1 to 60 minute requests; 200 iterations and $20 per 24 hours; compact at 70% |
| Authority | **Control other sessions**: whether a desktop Launch click gives the run [session control](#session-control) | off |
| MCP servers | A pinned set or, on Claude Code, all native sources; whether the harness's global servers ride along, and which global or [custom](#custom-mcp-servers) servers are added; see [MCP servers](#mcp-servers) | pinned, inherit on, none selected |

A profile needs a Persona, profile instructions, or both: one with neither has no role and is
refused on save and at launch. Leave the Persona at **No Persona** to run a resident on its
profile instructions alone. The Persona dropdown also ends in **Create a new Persona**, which
opens a blank Persona in the Library.

Every save writes a new, immutable **revision**, compare-and-set on the revision the editor
opened, so two windows cannot overwrite each other silently. **Archive** removes a profile from
the list and from Dispatch and frees its name; nothing is deleted.

**Edits apply at the next launch.** A launch pins the profile's current revision, and a running
resident reads its settings only from that pinned revision. Editing the profile, or the Persona
it names, never changes a resident that is already running.

Pi is not offered: the first release supports Claude Code and Codex, and a profile can only be
saved for a harness with an Agent SDK driver.

## Built-in residents

Mission Control ships one resident ready to launch, installed on every machine:

| Resident | What it does |
|---|---|
| Agent Shepherd | Watches the backlog and running tasks and unblocks stuck work. It removes dependencies on work that already shipped and grants repair rounds while a workflow still finds real bugs. It keeps reviewers within the task's original intent. Decisions only a human can make go to you through `request_input`. It runs Claude Code with Sonnet 5.5 at extra-high effort, and **Control other sessions** is on |

Built-ins appear under **Built-in** in the Residents rail, and in the dock and in Dispatch beside
your own profiles. They are **app data, not your data**. Opening one shows it read-only: Save and
Archive are absent, every field is locked, and a line says why. **Duplicate to edit** opens a new,
unsaved profile named `<name> copy` with the same settings. Your copy is an ordinary profile:
editable, archivable, and never touched by an upgrade. Every saved profile also offers
**Duplicate**.

A built-in launches like any profile. **Upgrading Mission Control updates it**: when a new build
ships different settings, the daemon writes them as the built-in's next revision at startup. A
resident already running keeps the revision it launched with. Use **Restart on new profile** to
pick up the update. In the desktop app, that Restart click authorizes session control for the
new run when the new profile revision has **Control other sessions** on.

The daemon refuses edits and archives of a built-in even when they do not come from the editor.
New profiles and renames cannot take a built-in's name. A profile you authored under that name
before it shipped keeps the name and everything in it. Both stay listed: yours under **Yours**,
the built-in under **Built-in**. The dock and Dispatch tag the built-in, and its Launch button
reads `Launch <name> (built-in)`. Neither one hides the other. To run the built-in in place of
your own, launch it, or archive yours once you no longer need it. Built-ins do not count toward the 200
live-profile limit. Settings snapshots do not carry them, and a restore never archives one.

The instructions are [`residents/agent-shepherd.md`](../residents/agent-shepherd.md), compiled into
the build. See [`residents/README.md`](../residents/README.md) for how to change or add one.

The **Meet your residents** guided tour walks this page on Agent Shepherd, then opens the
[Residents drawer](#the-residents-drawer) and points at **Pin**. Start it from **Settings > Help &
tours** or the palette; the startup tour picker announces it once to profiles that predate it.
See [guided tours](ui.md#meet-your-residents).

## Launching a resident

**Dispatch > Resident** shows a card per live profile, the repository (pre-filled from the
profile's default), optional **Instructions for this run**, and a read-only summary of what the
launch carries. **Launch resident** starts it; the profile's **Launch** button opens the same
form on that profile.

Like a task dispatch, Dispatch closes as soon as Mission Control accepts the launch and the
resident's task exists, without waiting for its session to start. The resident keeps starting on
its task, and a launch that fails from there stays on the board as a **Did not start** tile in
**Working** with its reason - for example an MCP server that could not connect - and offers
**Launch again**, **Open profile**, **Report bug** and **Dismiss**. Launches of one profile that
fail for the same reason share one tile, and a later successful launch of that profile clears it.
See [when a dispatch does not start](dispatch-and-backlog.md#when-a-dispatch-does-not-start). A launch refused
before its task exists, such as an MCP set that cannot be pinned, keeps Dispatch open with the
reason. If Mission Control answers before the task exists, Dispatch stays open and checks on
that same launch until it does; you can close it, and launching again resumes that launch.

A launch is a task of kind `resident`:

- With a repository it runs in a task worktree. **No repository** creates a private working
  directory for this run under `$MISSION_HOME/residents/runs/<runId>/workspace/`. Both run
  in the **Agent SDK**, whatever the
  harness's configured runtime is. **Continue in terminal** is unavailable for it.
- It uses the profile's harness, model and effort. Per-kind defaults in **Settings > Models** do
  not apply, because the profile already answers them.
- Its opening turn is "Begin your standing task." The Persona's guidance (when the profile names
  one), the profile instructions and the run instructions travel as **standing instructions**, appended after any
  [repository standing instructions](skills-and-settings.md), on the harness's own channel:
  `systemPrompt.append` for Claude Code and developer instructions for Codex. They are recorded
  once at launch, shown under the session's **See standing instructions** control, and replayed on
  resume, so compaction or a daemon restart never loses who the agent is.
- It has no backlog, dependencies, schedule, autopilot, after-work Workflow or task-kind contract.
  Single agent Dispatch, MCP `create_task`, recurring missions and task sources do not offer it.

A launch is idempotent. Repeating a request - a second click, or a response lost on the way back
- returns the same resident rather than starting a second one, including when two identical
requests race. Reusing a launch for a different profile, repository or set of run instructions
is refused. An exact repeat is recognized by the repository path as it was typed, even after that
path stops resolving or a symlink in it is pointed elsewhere; any other spelling is compared by
the repository it resolves to. If a profile is archived while one of its launches is still
unanswered, Dispatch keeps that one launch available to retry exactly.

## Finding a resident

**Settings → Display → Residents → Where residents live** decides where running residents are
drawn. The choice is stored per machine beside **Layout** and applies live.

| Where residents live | What you see |
|---|---|
| **Drawer** (default) | Residents leave the Board columns and the Console rail and live in [the Residents drawer](#the-residents-drawer) on the right edge. While a conversation is open, a resident that needs you is also a row in the **Needs you** rail. A fresh install, and any install that never chose, gets the drawer. |
| **Board and Console** | Residents sit in the Board columns and the Console rail beside every other session, with their marker, and the top bar's **Residents** button opens [the Residents dock](#the-residents-dock). |

Either way a resident opens on the same full detail - Conversation, Work queue, Workflows,
Diff and Files, with the resident band - as the Board drill-in on the Board and in the detail
pane in Console:

- **⌥1…⌥9** open live resident 1 to 9, in the order the drawer and the dock list them (oldest
  launch first), from any page. They match the physical digit key, so they work on macOS, where
  Option+digit types a symbol, and they do nothing while a text field has focus. They cannot be
  rebound, and **⌘1…⌘9** keep numbering only fleet sessions.
- **⌘K** finds a live resident by name or label and opens its detail.
- The **Need you** count, desktop alerts and the chime include a resident that needs you in
  both placements.

In **Board and Console** placement, every mark below comes from the revision the run launched
with: editing the profile's color, label or pin changes the next launch, never a resident that
is already running.

- **Border glow.** Its Board card has a glowing outline in the profile's color, and a label
  chip beside its name - the label you set, up to four characters, or initials from the profile's
  name. `⤒` on the chip means it is pinned. The colored spine on the card's left edge is still
  the session's state, so a resident that needs you still reads amber there. In the Console rail
  the same chip sits before the name, with the color as an edge on the row's right side.
- **Pinned to the top of its column.** A pinned resident sorts first in whichever Board column
  its state puts it in, ahead of free and held sessions, and leads the Console rail the same
  way, whether or not the column is grouped by repository. The arrow keys and the
  <kbd>⌘</kbd>-number shortcuts follow that order. Turn the pin off under **Board presence** and
  a resident takes its place in the column's ordinary order like any other session: by name,
  within its repository's group when **Group by repository** is on.
- **Hiding the marker.** **Settings → Display → Session display → Resident marker** takes the
  glow and chip off cards and rail rows. The pin still applies, and the Console band and the
  dock still name the resident.

In **Drawer** placement there is no card or rail row for the marker or the pin to act on, so
**Resident marker** and the profile's **Pin to top of column** say they apply only in Board and
Console. The marker's color and label still draw the drawer's cards and the visitor card.

The **Console band** shows in both placements. Opening a resident shows a band under the
Console header: the label chip, the profile name, the Persona if it has one, the revision it
launched from and whether it is pinned. When the profile has been edited since the launch, the
band says **Profile changed since launch** and the new revision. When the resident's revision
turns **Control other sessions** on, the band says **control granted** or **control not
granted**, the latter beside the session control menu. **Profile** opens the profile on the
Residents page.

### The Residents drawer

In **Drawer** placement the top bar's **Residents** button, **Shift+H**, the ⌘K command **Open
the Residents drawer or dock**, and the edge tab on the window's right edge all open a 330px
drawer as a column on the right of Fleet, so the Board or Console narrows beside it. Nothing is
dimmed or covered, and the fleet's keys keep working. Opened from another page, it goes to Fleet
to show it. The keyboard lands on the selected resident's card, or, if that resident has ended,
on the first that needs you or the first listed. Opened before any resident has arrived, the
keyboard moves to the first card when it appears, unless you have pressed a key or clicked
somewhere else in the meantime. **✕**, **Shift+H** or the top-bar button closes it; Escape and a
click elsewhere do not. The edge tab shows ⌂ and the live
count, with no number when nothing is running. It lights in the Board's column colors: the
**Working** color while any resident is working, and the **Needs you** color while any resident
needs you. When both are true, Needs you takes the tab's edge and the ⌂, and Working stays lit as
a second edge around it. The colors come from the current skin. The top-bar button keeps its name
and count.

- **Manage residents.** A row of its own under the drawer's title, above the cards, holds
  **Manage residents**, which opens the Residents page to author, edit and archive profiles.
- **Cards.** One card per live resident, in its marker color, in the order the dock uses. The
  top line holds the chip, the name, a state dot, the resident's **⌥**-number and a fold caret.
  Under it are tags for the loop's state, iteration and next wake, and any pause or wake
  reason. Every card ends with **Open**, **Run now** and **Pause** or **Resume**, and a
  **Control** badge when the resident's revision asks for session control.
- **Working and Needs you.** While a resident is working, its card is edged and lightly tinted
  in the color of the Board's **Working** column; while it needs you, in the color of **Needs
  you**. Both colors come from the current skin, so they match that skin's columns. Otherwise
  the card wears its marker color.
- **Needs you group.** Residents that need you move to the top of the drawer, into a group
  framed in the **Needs you** color under a **Needs you** heading with how many are asking.
  With keycaps on, the heading prints <kbd>e</kbd>. <kbd>e</kbd> opens the review queue of the
  first fleet session asking, as it always has, and otherwise addresses the first resident in
  this group: its review queue, with its card selected, when it asked through a review, or its
  conversation with the cursor in the reply box when it needs you some other way, such as a menu
  it is parked on. That holds while a conversation is open and the resident is also a row in the
  **Needs you** rail, and a fleet session's review still comes first even when that resident is
  the one selected. <kbd>e</kbd> passes over the resident whose conversation is already open
  while another is asking, unless it has a review to open; when that one is the only resident
  asking, it puts the cursor back in its reply box. The rest of the residents follow below the
  group.
  A card keeps its **⌥**-number when it moves into or out of the group, so the numbers never
  shift while an ask is open, and <kbd>↑</kbd>/<kbd>↓</kbd> walk the cards in the order drawn.
- **Compressing a card.** Every card starts open. Clicking a resident's title, or
  <kbd>Space</kbd> on it, compresses the card the way a Board repository group folds: it keeps
  the title, one line of what the resident is doing, which follows its activity as it changes,
  and its controls, and drops the loop tags and any question. Clicking the title again opens
  it. Each card folds on its own, so you can stack more residents in the drawer. A fold lasts
  while the dashboard is open, through closing, reopening and pinning the drawer, and every
  card is open again after a reload.
- **Selection.** <kbd>↑</kbd>/<kbd>↓</kbd> move the selection without opening or compressing
  any card, and <kbd>Enter</kbd> opens the selected resident; a double-click on a title opens
  a resident too.
- **Opening the conversation.** Clicking anywhere in a card between its title and its actions -
  the loop tags, the status lines, or what the resident is asking or last said - opens the
  resident's conversation, as **Open** does. Selecting some of the text does not, and the
  actions keep their own clicks. A compressed card's one status line opens it too. Its latest
  message is clamped to three lines (the line the Console rail prints under its name).
- **What a resident is asking.** Above its actions, an open card shows what the resident is
  asking in place of its latest message: one row per pending review, in the **Needs you**
  color, with its kind as the review modal names it (input, decisions, plan or diff), its
  title and a line on what answering takes, such as a question's options. The card never
  draws the form itself.
  Clicking a row selects the card and opens the review modal on that resident's queue, the same
  modal <kbd>e</kbd> opens, where the question is answered, dismissed or moved to chat. A menu
  the session is parked on is one such row too, and clicking it opens the same review modal,
  which shows the menu's rows as the Conversation tab does, so pressing one answers it. Once
  nothing is left pending, the modal closes and the amber state and the visitor card clear.
- **No reply box.** A card has no free-form reply box.
  To write to a resident, open its conversation and use the Conversation tab's reply box.
- **Footer.** **Profiles** lists every live profile with **Launch** or **Launch…**, with the
  same launch behavior the dock has (see below). The dock and the drawer share one launch
  state, so closing either while a launch is starting never starts a second resident.
- **Pin.** Open, the drawer lasts until it is closed or the page reloads: a refresh or a
  restart closes it. **Pin** keeps it open through those too, and changes nothing on screen.
  The pin is stored per machine. **Unpin** leaves the drawer open until the next reload, and
  closing a pinned drawer unpins it.

**Escape returns to the card.** A resident opened from the drawer opens beside it, as the Board
drill-in or the Console detail pane, and the drawer stays on screen with that resident selected.
The Escape that leaves the detail moves focus to that resident's card. A resident opened by
**⌥N** or the palette with the drawer closed leaves the usual way.

**In the Needs you rail while a conversation is open.** While any session's detail is open -
the Board drill-in, or a selected row in Console - every resident that needs you is an ordinary
row in the **Needs you** rail, with its chip, its state and what it is asking, the open resident
included. Opening a resident that needs you drills the Board into a full **Needs you** rail
listing everything asking, so a click or an arrow key moves the conversation from one to the
next. The rows carry no <kbd>⌘</kbd>-number, so the fleet's numbers don't shift as a detail
opens and closes, and they stay in the rail whether or not the drawer is on screen. Escape out of
a resident's detail still moves focus to its drawer card while the drawer is open. A resident
that does not need you never joins the rail. Close the detail and the residents leave the rail
again: for the drawer's **Needs you** group while the drawer is on screen, or for a visitor card
while it is closed.

**Visitor card.** While the drawer is closed and no detail is open, a resident that needs you
shows a visitor card in the Board's **Needs you** column, or among the Console rail's sessions
that need you: a dashed outline in its marker color with the chip, the name and *Resident ·
opens its conversation*. Clicking it, or <kbd>Enter</kbd> on it, opens that resident's
conversation, as **⌥N** does, and leaves the drawer closed. The arrow keys reach it; the
<kbd>⌘</kbd>-numbers skip it, so they don't shift while its ask is open. It disappears while the
drawer is open or pinned, while any detail is open (the resident is a row in the rail then), and
once the resident no longer needs you. In Console, where selecting a row opens it, an arrow key
landing on the visitor card opens the resident's detail.

### The Residents dock

In **Board and Console** placement, **Residents** sits beside **Foreman** in the top bar. While
any resident is running it shows how many; with none running it shows no number. Click it, press
**Shift+H**, or choose **Open the Residents drawer or dock** in the ⌘K palette.

- **Live** shows each running resident as a card in its marker color. The card's top line has
  the chip, the name, the session's state and **Open**, which opens that session. Under it are
  the loop's state, iteration and next wake as tags, any pause or wake reason, and the resident's
  compaction layers. The footer holds **Pause** or **Resume** and **Run now**. A resident whose
  revision asks for session control also shows a **Control** badge at the end of the footer when
  control is granted, or **No control** beside the session control menu when it is not.
- **Profiles** lists every live profile with **Launch**. A profile with a default repository
  launches straight away, through the same launch call as Dispatch; while it starts the row reads
  *starting…*, and closing the dock does not lose it - launching again resumes that same launch,
  in the repository it was sent with even if the profile's default has changed since.
  If it is still starting after a minute, the dock stops waiting and the row reads *still
  starting*; **Launch** then checks on that same launch rather than starting a second resident.
  A profile without a default repository shows **Launch…**, which opens **Dispatch > Resident**
  on it so you can choose one.
- **Manage residents** opens the Residents page.

Escape or a click outside closes the dock. On a narrow window the button drops its word and keeps
the ⌂, plus the live count when there is one, and **Settings → Display → Top bar** can keep it
that way at every width.

## Session control

**Control other sessions**, under **Authority**, is off by default. Turned on, it lets a
resident's run receive the same grant as the
[session control menu](sessions.md#let-a-session-steer-other-sessions), so it can read and steer
your other live sessions. Your desktop click on **Launch resident** in Dispatch,
**Launch** in the Residents dock, or **Restart on new profile** gives
it a grant that lasts for the run and through a restart. The session control menu can still grant
control for one conversation, as it can for any session, and that grant ends at the next restart.

- **For that run only.** The click authorizes exactly that launch of that profile revision. It
  is consumed when the launch starts, cannot be replayed, and expires after 15 seconds. Editing
  the profile afterwards changes the next launch, not this run.
- **Through a restart, for the same conversation.** After Mission Control restarts, the grant
  comes back only if the resident resumes the same conversation in the same working directory,
  on the same work episode and task. A clear or a new conversation ends it, and a new launch of the profile
  needs its own Launch click.
- **Once the session is ready.** The grant is given when the resident's session has its
  conversation. Dispatch closes before that, and the Console band reads **control granted** once
  it is given. If the dock's launch answers before that, the dock says session control is not
  granted yet. If Mission Control
  restarts first, that launch is not granted and needs a new Launch click.
- **Until you turn it off.** Choose **Off** in the session control menu to revoke it. A restart
  does not bring it back.
- **Launched anywhere else, it starts without control.** Before you launch from the browser
  dashboard, Dispatch says the launch will not carry control. A desktop app attached to a daemon
  it did not start cannot pass the click on either. Dispatch still closes as soon as that launch
  is accepted, and the resident's Console band reads **control not granted**. A Launch from the
  dock reports *Started without session control*. The
  session control menu in the desktop app can still grant it for that conversation, the way it
  can for any session; that grant ends at the next restart.

The exact rule, and what cannot create a grant, is in [security](security.md#resident-launch-grants).

### Blocked sessions

A resident with session control can work the [blockers](sessions.md#blocked-sessions) other
sessions record when they wait on someone other than you. `read_sessions` adds a `blocker`
summary (`id`, `kind`, `reason`, `waitingOn`, `referenceUrl`, `startedAt`, `reply`) to every row of
its list and accepts `blocked: true` to list only blocked sessions; reading one session returns
its whole blocker, Markdown details included. `control_session` adds two actions:

- `{"action":"flag_blocker_reply","note":"...","referenceUrl":"..."}` marks a likely answer.
  It does not clear the blocker and sends nothing to the session; the card shows a
  **Reply flagged** pill and nothing else.
- `{"action":"clear_blocker","resolution":"..."}` clears it.

Both actions take an optional `blockerId`. Pass the `id` that `read_sessions` returned: when it
is supplied and the session has since cleared that blocker and reported a different one (even
within the same millisecond), the action is refused with 409 instead of touching the
replacement. A re-report keeps the id. Without `blockerId` the action applies to whatever
blocker stands at that moment, so a resident that omits it can flag or clear a blocker it never
read. The dashboard's Flag reply and Clear blocker always send it.

"Check again" is the ordinary `message` action. The built-in Agent Shepherd flags, then
messages, and never clears a blocker without evidence that its `resumeWhen` condition is met.

## Lifecycle

After each completed turn a resident waits for its next wake. Foreman never completes it
automatically. It ends when you choose **Complete & close** on its session,
or when its session goes away, which settles its task through the ordinary task lifecycle. The
Complete dialog first offers a [retro](#retro-before-completing) that turns your steering into
proposed instruction changes. A
failed launch, or one interrupted by a daemon restart before its session started, is recorded
with its reason and is never relaunched; launch the profile again.

A run without a repository has no Git worktree, diff, pull request, repository reset or repository group.
The Files panel browses its working directory directly, without Git or managed repository plans.
Listing is capped at 10,000 files and refuses trees exceeding 10,000 directories or 64 nested
levels. Traversal checks a 15-second budget between filesystem operations.
Directory scans run asynchronously against open directory handles and refuse symlinked
boundaries, including directories replaced while a listing is in progress.

The workspace survives daemon restarts while the run is active. When the run ends, Mission removes
that workspace after its session is gone and its SDK runtime has stopped. Failed launches also
remove their directories. Cleanup failures remain recorded and retry, including after restart;
the repository retention clock never applies to these directories. Files saved there are temporary.

## The persistent loop

The daemon owns every loop turn. After a completed turn it waits the pinned profile's cadence,
then sends its loop prompt. The default asks the resident to check what changed, act, and end
with a one-line status. The card, Console band, dock and live-run rows on the Residents page show
its state, cumulative iteration, next wake and the agent's wake reason.

The resident can call `schedule_next_iteration` with `delaySeconds` and an optional `reason`.
The delay is clamped to the profile's minimum and maximum. During a turn, the last new request
wins and its delay starts when the turn completes. It applies once; the following completion
uses the normal cadence unless the agent requests another delay. A late request replaces an
already waiting wake with now plus its delay.

The tool returns a `callId`. Replaying that id returns the original receipt without rescheduling,
even after a newer request or daemon restart. A new id is a new intent. The HTTP call has a
10-second timeout; an unknown outcome says the request may still apply and includes its id for
safe replay. Only a typed refusal or a refused connection proves nothing was recorded.

**Human input has priority.** Queuing a human message cancels the scheduled wake and pending
agent delay. After the human turn, the normal cadence applies unless the agent requests another
delay. An open review, input request or permission dialog holds wakes and shows **waiting on you**.
It preserves the scheduled wake and accepts pacing requests. Answering or dismissing the request
releases the hold automatically once the session is idle. An overdue wake fires once; a completed
turn uses its requested delay or the profile default. Detached review continuations preserve
pending pacing too. Only an operator Pause or a guardrail requires Resume; neither is cleared by
answering a review. Legacy automatic `needs-you` pauses recover on observation using the default
cadence because their old pacing intent was already discarded. Pausing does not interrupt an
already running turn.

All four surfaces offer **Pause**, **Resume** and **Run now**. Resume starts a fresh cadence;
Run now asks for an immediate idle wake, subject to the same human, compaction and budget checks.
When the resident is busy - a turn in progress, a human message waiting, an open request for
you, or a compaction - Run now queues the iteration instead of refusing. The status reads
**run queued** and the control becomes **Cancel queued run**. Whatever had priority finishes
first; the queued iteration then runs once, on the next idle moment, without waiting for the
cadence. The request is durable across reloads and daemon restarts. Pausing drops it, and Run
now on a paused, busy resident resumes the loop and queues.
After a profile edit, **Restart on new profile** ends the old run, so its session stops waking,
and launches the latest revision in a new conversation. The old task and session stay open, and
Restart ends by opening the Complete dialog for the old session, wherever you clicked it: complete
it there, or cancel to keep it. The old session's Console band also says it was restarted on the
new revision and offers **Open new session** and **Complete & close**, so you decide when the
replaced conversation closes. The offer stays until that task is completed, even if the new
session has since ended or never started, and survives a reload or daemon restart. Restart
preserves the repository choice and run instructions; a repository-free resident receives a fresh
private workspace. New conversation creation ensures every changed launch option takes effect.
If Restart is interrupted, recovery depends on whether it had reserved its replacement yet. Before
the reservation no replacement launch exists, so retrying Restart starts it. After the
reservation, a replacement whose session never started is a failed launch like any other (see
[Lifecycle](#lifecycle)): retrying Restart only reports that failure, so launch the profile again.
Either way the old session's band keeps **Complete & close**.
The replacement conversation does not inherit a session-control grant from the old run.
In the desktop app, the Restart click authorizes a fresh grant through the same path as Launch,
bound to the replacement request and the new profile revision. It grants control only if that
revision has **Control other sessions** on. A browser restart or a desktop app attached to a
daemon it did not start still launches without control; the session control menu can grant it
for that conversation.

### Compaction and guardrails

Before a wake at or above the context threshold, the daemon asks the harness to compact and
waits for a measured result below that threshold. Compaction and human turns do not count as
iterations. Missing or invalid context readings pause before a wake until a fresh measurement
is available and you resume. A compaction never sends the loop prompt until it is measured
below the threshold.

A compaction that makes no progress for ten minutes is interrupted, so the harness turn ends
and the session is idle again instead of working indefinitely. A failed compaction (stalled,
ended without a measured boundary, or refused by the harness) is retried after 1, 5 and then
15 minutes; the status names the failure and the next retry. A fourth consecutive failure
pauses with that reason, and Resume starts a fresh set of retries. A measured compaction resets
the count. Two failures pause at once: a compaction that could not be interrupted, because the
session may still be mid-turn, and one that finished above the threshold. A human message that
arrives during a failing compaction keeps precedence, and the next wake compacts again.

The editor and every live-run surface name the active compaction layers:

- **Claude Code:** compaction before wakes is active. The configured native backstop did not
  fire in the Claude Code 2.1.310 probe on 2026-10-30.[^claude-native-backstop-probe] The operator
  approved shipping with manual compaction only, so the native backstop remains unavailable.
  A long turn therefore has no profile-threshold native backstop.
- **Codex:** compaction before wakes and the native backstop are active. The latter is computed
  from the explicit model's context window in Codex's native model catalog. Launch refuses if
  that window is unavailable. The measured native token limit is saved with the SDK session
  and replayed on resume, so a later catalog refresh cannot remove the configured backstop.
  Older sessions without a saved limit must resolve it from the catalog once.
  Codex's compact operation does not accept a focus instruction;
  the focus field is used by Claude.

The default rolling 24-hour limits are **200 iterations** and **$20**. Clearing either cap in
the editor disables that cap for new runs. Launch is iteration one only after the session
actually starts. Claims, sent wakes and uncertain deliveries count toward the iteration window;
positively refused sends do not. Rows exactly 24 hours old no longer count. Spend uses Claude's
reported costs and Codex's estimated Standard API costs, including human and maintenance turns
in the same resident conversation. It is a between-turn limit, not an interruption of spend
inside a running turn. Unpriced models cannot retain a spend cap at save or launch, and unpriced
usage pauses a capped run instead of treating it as free. The profile's Model picker marks
unpriced choices as **spend cap unavailable**. Guidance beside Model and **Spend per 24 hours
(USD)** names both ways to recover: select a priced model or use **Clear spend cap**. The form
preserves your model and cap until you change them; clearing a cap disables that guardrail for
future launches only. When Model is **harness default**, a capped profile cannot be saved until
the harness settings load and its price availability is known. Pending or failed reads show
guidance beside both fields; select an explicit priced model or clear the cap to proceed without
that lookup, or reload to retry a failed read. GPT-6.1 Sol and Terra have verified Standard API pricing, including cached input,
cache writes and long-context rates ([Sol model reference](https://developers.openai.com/api/docs/models/gpt-6.1-sol),
[Terra model reference](https://developers.openai.com/api/docs/models/gpt-6.1-terra)).
Claude uses harness-reported costs, including for Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5;
its spend-cap availability is independent of the smaller shipped model picker list.

Reaching a cap pauses and appears in the attention inbox. Resume is refused until the rolling
window has room; the refusal names the earliest release time. Editing the profile cannot lift
a live run's pinned cap. Restart on new profile is the explicit way to adopt different settings.

### Restart recovery

The next wake, consumed completion generation, pacing requests and cumulative counters are
durable. A missed wake is rearmed once after SDK restoration. Each delivery is claimed before
sending, with a unique sequence and transcript offset. Only its own marker after that offset
confirms delivery after a crash. Missing or unreadable evidence becomes **wake delivery
unconfirmed**, counts conservatively, and pauses for you; it is never silently resent.

Sent and released delivery rows are retained for seven days. Unresolved claims are reconciled
before pruning, and uncertain deliveries stay until the run ends. Pruning never decreases the
cumulative iteration or reuses a sequence. Pacing receipts remain for the run's lifetime.

## Changing instructions from the conversation

A resident can propose changes to its own standing instructions, so a rule you work out with it
in conversation does not have to be copied into the editor by hand. Ask it to update its
instructions and it uses two Mission Control tools:

- `get_resident_instructions` returns the current text of the profile's instructions and of the
  Persona it names, their revisions, and whether each can be edited.
- `propose_resident_instruction_changes` asks you, as a `request_input` question, which of its
  proposed changes to apply, and waits for your answer. Each change replaces one exact passage,
  removes one, or appends a new one, in the profile instructions or in the Persona's guidance.

The question arrives on the same **input** card as any agent's `request_input` question. It shows
every change in full, exactly as it would be written, with one checkbox per change. Tick the ones
you want and choose **Submit**. Mission Control writes exactly those:

- Profile changes become the profile's next revision, as if you had saved them in the editor.
- Persona changes become the Persona's next revision. Every profile and task that uses that
  Persona reads it at its next launch.

Text in **Other** goes back to the resident as guidance and is never applied.
**Dismiss** or **Chat about it** writes nothing.

- **Only your answer applies a proposal.** Foreman and sessions with session control cannot
  approve one, and no tool lets a resident write its profile or Persona directly (see
  [security](security.md#resident-instruction-changes)). The answer applies when you give it, even
  if the resident's tool call timed out first.
- **Every selection applies.** A proposal is checked against the current text before you see it:
  each replaced passage must occur exactly once, no two changes may overlap, and even with every
  growing change applied the result must fit its limit: characters for profile instructions, UTF-8
  bytes for Persona guidance.
- **A stale proposal writes nothing.** If the profile or Persona a selected change edits was
  changed after the proposal was made, or a selected Persona change is for a Persona the profile no
  longer names, the answer applies none of it and the resident is told to read the text again. A
  selection that would leave the resident with no role, or exceed the instruction limits, also
  writes nothing.
- **Built-ins stay read-only.** A built-in resident's profile and a built-in Persona cannot be
  edited. Duplicate the resident to shape its instructions.

The running resident keeps the revision it launched with. Its band shows **Profile changed since
launch (now revision N)**; choose **Restart on new profile** when you want it to run on the change.

### Retro before completing

When you choose **Complete** on a resident that can still take a turn, the Complete dialog offers
**Run a retro first**. It types a retrospective into the resident's own conversation: the resident
reads its conversation back, finds where you corrected or redirected it, and proposes changes to
its instructions or Persona through the same `request_input` question. Choose what to apply,
then complete it.

The retro completes nothing and needs no skill, because the only write it can make is a proposal
you approve. It is offered whether or not you steered the resident, because Complete is the last
time its conversation can be read back. It is not offered for a built-in resident or for one that
can no longer receive a turn. It never writes [repository memory](repository-memory.md); a
resident's card does not offer the memory retro.

## MCP servers

**MCP servers** in the profile editor decides which MCP servers a resident starts with, besides
Mission Control's own, which every resident always has.

- **Server set** chooses between **Pinned at launch** (the default) and, on Claude Code, **All
  native sources (not pinned)**; see [All native sources](#all-native-sources). Codex offers only
  the pinned set, so the choice is not shown for it, and a profile on Codex that makes it is
  refused on save and at launch.
- **Inherit harness defaults** (on by default) adds every global server the harness configures
  when the resident launches: the user-scope `mcpServers` in Claude Code's `~/.claude.json` (or
  `$CLAUDE_CONFIG_DIR/.claude.json`), or the `mcp_servers` in Codex's own `config.toml`.
- **Add an MCP server** adds one of those global servers, or a [custom server](#custom-mcp-servers)
  that applies to the profile's harness. With inheritance off, the resident starts with only the
  selection. A selected server that is also inherited starts once.

Dispatch's launch summary says what the launch carries, such as `MCP: defaults + linear`, or
`MCP: all native sources (not pinned) + linear` for a profile on all native sources.

### All native sources

**All native sources (not pinned)** starts a Claude Code resident with everything Claude Code
loads on its own, as a terminal `claude` session on this machine and account would: user, local
and project MCP servers, plugin servers and claude.ai connectors (such as
`mcp__claude_ai_Slack__*`), beside Mission Control's own server and any custom server the profile
selects. Choosing it asks for confirmation first, because it gives up what the pinned set
guarantees:

- **Not frozen.** Claude Code reads its configuration and fetches the account's connectors at
  every start, so a server or connector added, changed or removed natively, or in claude.ai's
  settings, reaches a running resident at its next start or resume. Only the custom servers are
  snapshotted at launch.
- **Not checked.** Only Mission Control's own server and the profile's custom servers must connect
  before the resident starts, as in [What a run starts](#what-a-run-starts). A native server or
  connector that fails, is switched off or needs a login does not refuse the start; Claude Code
  reports it the way a terminal session does.
- **Broader reach.** An autonomous, looping resident can use every connector's account-level
  access, such as sending Slack messages as you.
- **Not isolated.** Native servers and connectors start from Claude Code's own configuration with
  its own stored logins, not through Mission Control's [scoped launcher](#custom-mcp-servers).

With it chosen, **Inherit harness defaults** and the global servers in **Add an MCP server** are
hidden: Claude Code loads its global servers itself. A global server already selected stays in the
profile, marked *loads natively*, and comes back into the set if you switch to **Pinned at
launch**. A global server residents cannot carry no longer refuses the launch, because Mission
Control does not resolve it. A custom server named like one of Claude Code's global servers is
still refused, because both would load under one name.

### What a run starts

A launch resolves the run's set once, from the revision it pins and each harness's configuration
as it is at that moment, and keeps a private copy of every definition and value. Every start and
every resume after that reads only the copy. This section describes the pinned set; a profile on
[all native sources](#all-native-sources) keeps a copy of its custom servers only, and the rules
below apply to them and to Mission Control's server:

- A global server added later, a field added to a native entry, an edited or deleted custom
  server, a changed secret or an edited profile never reaches a running resident. The next launch
  picks it up.
- Only the snapshot's servers start, plus Mission Control's own. Native MCP configuration is
  consulted, never loaded: a launch reads each harness's global servers to resolve the set, and
  Codex's configuration layers are read again to verify the run before any server starts, but a
  native definition reaches a resident only as its snapshot copy. On Claude Code a repository's
  `.mcp.json`, local-scope servers, plugin servers and claude.ai connectors do not load. On Codex,
  a server that only a trusted project's `.codex/config.toml` (or a system or managed
  configuration) defines is switched off for the run.
- A launch is refused, with the reason, when the set cannot be pinned: an inherited or selected
  global server residents cannot use, a custom server named like a global server of that harness,
  a selected server that no longer exists, a custom secret that is not set, or, on Codex, another
  configuration layer that changes one of the run's servers or forces a server on itself. On
  Claude Code a start is also refused when a server in the set does not connect, is switched off or
  waits on a login once Claude has started it, or when Claude cannot confirm the set within 60
  seconds; this applies equally to the relaunch Claude makes to recover from a lost login.
  Nothing is renamed or dropped silently. A remote server behind an OAuth login Claude Code has no
  usable token for - never signed in, or one it could not refresh - refuses the start saying it
  needs a login; sign in to it with `/mcp` in Claude Code and launch again. Claude Code remembers
  that verdict by server name for a while, so a later launch can be refused the same way until
  you sign in.
  When a remote server reached through the launcher does not connect, Claude Code's MCP log for
  the run's workspace has the launcher's reason, with the transport's error code. A code such as `SELF_SIGNED_CERT_IN_CHAIN`
  says the server presented a certificate chain the launcher does not trust; the common cause is
  a root, such as a TLS-inspecting proxy's, that is in neither Node's roots nor the system's
  certificate store, both of which the launcher trusts.

Each launcher credential is good for one start, so a server that exits during a session is not
restarted by the harness; it starts again with the session's next start, such as a resume.

A global server residents cannot use is shown as unavailable, with the reason, in the catalog and
the picker. That happens when it uses a field residents cannot carry (anything beyond the command,
arguments, environment, URL, headers, and the timeouts and tool filters each harness maps one to
one), reads a value from the agent's environment (`env_vars`, `bearer_token_env_var`,
`env_http_headers`), relies on an OAuth login Codex holds, would send its headers or query
values over plain `http` to another host, has a credential in an argument,
or uses a Claude Code `${VAR}` reference. A reference to a variable that is set reads a value the
resident's agent inherits too, so it would not be private to the server; define that server as a
custom server with a secret instead. A reference to an unset variable is refused unless it has a
`:-default`, which is used as written.

A Claude Code remote (`http` or `sse`) server with no headers, and no query, user name, password,
fragment or key-shaped path segment in its URL, reached over `https` or over plain `http` to this
machine, is handed to Claude Code as configured, whether it is inherited or selected, rather than
through the launcher. That is what lets a resident use a server you signed in to with OAuth in
Claude Code: Claude Code keeps that login under the server's name, type, URL and headers exactly as
configured, and only its own connection can present it. So such a server's URL appears in the
agent's launch-scoped MCP configuration. Renaming the server or changing its URL, even by a
trailing slash, asks for a new login. Every other usable global server still starts through the launcher,
which presents no login and keeps the URL private: any with a header, a query value or a fragment;
one on plain `http` to another host, because a login is a credential and travels in the clear only
on this machine; and one whose path has a segment shaped like a key (a known key prefix such as
`sk-`, a credential-named assignment such as `token=…`, a long token mixing letters and digits, a
UUID), because such a server authenticates by
its URL and that URL must not reach the agent. The check is deliberately wide: a false match only
keeps a server on the launcher.

How each harness is held to exactly this set, and what was measured, is in
[resident MCP isolation](harnesses-and-terminals.md#resident-mcp-isolation).

### Custom MCP servers

**Residents > Custom MCP servers** defines servers for residents and lists each harness's global
servers. A custom server has a name, the harnesses it applies to, and either a **stdio command**
(command, arguments, environment variables) or an **HTTP URL** (URL, query parameters, headers).

- **Secret** values are write-only. An environment variable or header marked secret, and every
  query parameter, is stored on this machine, shown afterwards only as *Set*, never returned by
  the dashboard, and never included in a settings snapshot. Leave a set value blank when editing to
  keep it, as long as the connection stays the same. Changing the command, the arguments, the URL,
  or a plain environment variable or header refuses the save, naming each set secret to enter
  again, so a value never follows the server to a different destination. Renaming the field
  clears it.
- An argument that looks like a credential (`--api-key=…`, `--token`, `TOKEN=…`, a URL with a user
  name or query, a bearer credential) is refused, naming the argument. Put the credential in a
  secret environment variable instead. Arguments are otherwise stored and backed up as written.
- A URL with a user name or password is refused; a URL's query becomes secret query parameters,
  and a parameter named twice is refused.
- Secret headers and query values travel only over `https`, or over plain `http` to this machine
  (`localhost`, `127.0.0.1`, `::1`); a server that would send them anywhere else in the clear is
  refused at save.
- Names are unique, are never `mission-control`, and may not equal a global server's name on a
  harness the server applies to. A dotted name such as `foo.bar` is one server on both harnesses.
- **Delete** removes the definition and its secrets. A running resident keeps the copy it launched
  with; a profile that still selects it cannot launch until the selection is removed.

A secret value never appears on a command line. It reaches only its own server, through Mission
Control's launcher, as that server's environment, headers or query; never the agent's environment,
a generated configuration file, a log or the transcript. A global server reaches the agent in one
of two ways:

- **Through the launcher**, for every usable global server except the one below. Its definition stays out
  of the agent's launch arguments and generated configuration: the agent is handed only a launcher
  entry naming the run, the server and a credential file. The launcher then starts a stdio server
  with its configured command and arguments, so those ordinary arguments appear on that server's
  own process, as they would if the harness started it.
- **Directly**, for a Claude Code remote (`http` or `sse`) server with no headers, no query, user
  name, password, fragment or key-shaped path segment in its URL, over `https` or loopback `http`
  (above). It carries no value, so Claude is handed the server
  itself: its name, type and URL as configured, an empty header table and its options. Its URL is
  therefore in the agent's launch-scoped MCP configuration, and Claude Code presents any OAuth
  login it holds for it.

See [security](security.md#resident-mcp-secrets).

When a run ends, its copy of the servers and their values, its launch tickets and its Codex
configuration overlay are removed once its session has stopped.

## Durable profile state

Each profile owns `$MISSION_HOME/residents/profiles/<profile-id>/state/`, independent of its
repository or run workspace. New runs and SDK restores reuse it. Renaming or editing a profile
keeps the same state; duplicating one creates a new identity with empty state. Concurrent runs
of one profile share it, so residents should coordinate writes to ledgers and watermarks.

The run receives `RESIDENT_STATE_DIR` and standing instructions explaining the directory.
Claude Code receives `autoMemoryDirectory` and `autoMemoryEnabled` in launch-scoped settings,
using this directory for its `MEMORY.md` and topic files. Existing per-run memories and handmade
state folders are not automatically imported. Copy desired notes into the profile directory.
The [Claude memory reference](https://code.claude.com/docs/en/memory#storage-location) describes
this setting. Codex receives the directory and instructions for explicit notes and ledgers.

Open a saved profile in **Residents**, then **View state** to see its path and files, including
text previews up to 256 KiB. **Refresh state** reloads the list. **Reset state** asks before
permanently clearing the files, including auto-memory. Complete and close every run first;
pausing a loop leaves its session alive, so reset refuses it. Reset keeps profile settings and
run history. Run completion, pauses, daemon restarts and profile archival retain the state.
Profiles are archived rather than hard-deleted, so archival retains their state too.

State files are machine-local and are not included in settings snapshots or database recovery
points. Back them up separately when moving an installation. The existing run history remains
the source of lifecycle records; no additional run-log file is maintained in this directory.

## Backups

Resident profiles are part of [automatic settings snapshots](configuration.md#automatic-settings-snapshots).
Custom MCP server definitions are too, under their own domain, without any secret value. Because
a snapshot cannot say which value went with a definition it brings back, a restore keeps a secret
only when it was already set when the snapshot was taken and the restore leaves its server's
connection unchanged. Every other value reads *Not set* until it is entered again: one replaced
after the snapshot, one whose server the restore points somewhere else, and every value on another
machine. A snapshot taken before custom MCP servers existed restores without touching them. Full-database
recovery points are scrubbed of every secret, and of every global server's definition in a run's
snapshot, before they are written; a run restored from one is refused those servers until it is
launched again.
Restoring a snapshot writes each changed profile as a new revision, reactivates profiles the
snapshot holds and archives live profiles it does not. Revisions that running residents pinned are
kept. A snapshot taken before residents existed restores without touching profiles.

A snapshot carries **every live profile** with its current revision, and only the **200 most
recently archived** ones. Archive never deletes a profile, so the full history grows without
limit and would eventually push snapshots past their size limit and stop automatic backups. In the multibyte-text backup fixture, 200 live and 200 archived
profiles with maximum instruction and loop text fit in about 15 MB. The snapshot file limit remains 16 MiB.

- **Restoring on the same machine** changes no archived profile the snapshot left out: restore
  only archives *live* profiles a snapshot omits, and every revision a run pinned is kept.
- **Restoring onto a fresh installation** recreates every live profile but not the archived ones
  past the newest 200. Nothing in Mission Control can reopen an archived profile, so no profile an
  operator can see or launch is lost.
- Settings snapshots never carried full history: they hold each profile's current revision, not
  earlier revisions or runs. To move the complete record to another machine, use a
  [full-database recovery point](database-and-migrations.md#full-database-recovery-points).

## How it is built

The registries later phases extend, the single launch path, the pinned-revision rule and the
launch and recovery guarantees are maintained in
[change contracts](agent-guides/change-contracts.md#resident-profiles).

[^claude-native-backstop-probe]: Mission Control workflow run
    `bfb6fe70-1862-4a6c-bfbd-ac54cb644b26`, round 6, segment 2,
    `probe-claude-20.log`, artifact `txt_4606a312dc45c5b01382778be74b210d`.
    The retained probe did not auto-compact at the requested 20% setting; explicit manual
    compaction emitted a boundary with 54,678 tokens before and 494 after.
## Skill sources

Open **Residents > Skill sources** to browse Mission Control's `skills/`, `~/.claude/skills`,
`~/.agents/skills`, and `$CODEX_HOME/skills` (or `~/.codex/skills` when unset). Claude entries
that resolve to a skill already indexed by Mission Control are omitted; independent
`mission-*` folders and links remain indexed.
The pre-installed html-plans, html-report, phased-plan, pull-request and retro skills appear
under **Mission Control**, read directly from the current app bundle. Stale global links to an
older app location do not remove those entries; choose **Mission Control** in the Source filter
to see them.
Register up to 16 additional absolute or home-relative folders. Removing a source only removes
its registration; it never deletes skill files.

The catalog is scanned at daemon startup and on **Rescan**. Adding or removing a source also
rescans. Search matches names, descriptions and folders; the Source filter narrows the list.
Malformed frontmatter, missing folders, unreadable files and bounded-scan limits appear beside
the source. Child symlinks whose targets no longer exist are skipped silently; valid linked
skills remain discoverable and missing source roots still report a problem. Grouped folders and symlinked skill folders are supported, but links to the home
directory or an ancestor are refused. The 5,000-entry scan budget includes ordinary and hidden
files as well as directories. A skill's stable identity
is its source id plus relative folder, so editing its name does not change its identity.
Registered directories are included in settings snapshots. Restoring an older snapshot without
that domain leaves the current registrations intact.

**Profile skill selection is currently unavailable for both Claude Code and Codex.** Neither
proposed per-launch mechanism passed the exact frozen-set check. The catalog does not change a
resident's launch or native skill discovery. Built-in source rows show the limitation instead
of inventing a selectable inventory. The approved policy remains: inheritance captures defaults
plus selections, selected-only captures selections, and both must resume from the same immutable
set. See the [capability measurements](harnesses-and-terminals.md#resident-skill-isolation).
