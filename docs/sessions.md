# How it works

Three layers, most-to-least automatic:

| Layer | Setup | Gives you |
|-------|-------|-----------|
| **Passive discovery** | none | inventory + names + branch + uptime, live - plus any [option menu](#answer-a-sessions-menu-from-the-dashboard) a session is parked on |
| **Claude hooks** | `npm run install-hooks` | precise state (working / idle / needs-input) + activity |
| **MCP review channel** | `claude mcp add …` (see below) | agents push diffs / plans / questions for you to decide |

One long-lived **daemon** (`src/server`) serves the React SPA (`src/web`) plus a
JSON API and an SSE stream on `127.0.0.1:7317`. A ~1.5s poller sweeps `ps` plus
every terminal backend it knows about (today `tmux list-panes`, `cmux tree`,
`wezterm cli list`, and Ghostty through AppleScript) and reconciles an in-memory registry
that broadcasts changes over SSE. Reviews and dispatched tasks are persisted in SQLite
(`node:sqlite`).

That same sweep re-reads the mutable Git facts in each session's checkout, including its
branch. Sessions the daemon runs itself (Agent SDK
`runtime`) are never carded by that sweep: it skips every agent process inside the daemon's
own subtree, because those are the daemon's own subprocesses rather than somebody's session.
Without that rule an embedded session's CLI subprocess - which inherits the terminal the
daemon itself was started from, since the Agent SDK owns the spawn - would appear a second
time as a terminal card, named after the daemon's tab and claiming its session's branch and
PR. Their Git facts are instead read directly from their working directory at launch or
restoration and refreshed on the same cadence.
This keeps the **PR chip** honest without a terminal session sharing the checkout. A pooled worktree is often leased with no branch at
all, and the PR poller finds a session's pull request by asking
`gh pr list --head <branch>`. Capturing either fact only once would leave live changes invisible.

The chip is that one pull request: the one on the branch of the checkout the session is
standing in. A session running a
[multi-repo task](dispatch-and-backlog.md#attaching-more-than-one-repository) owns one in each
repository it changed, and the poller asks `gh` inside every attached worktree as well - still
one call per checkout. Those do not crowd the chip, which keeps naming the session's own
checkout; they appear as the card's per-repository lines, and it is those the completion
quorum and Foreman's [PR follow-through](work-queues.md#keeping-a-pr-on-track) read.

### The title bar stays compact at half-screen

The **fleet pulse** is one readout, not a row of pills: the connection state leads it
(`live`, or `reconnecting`, which dims the figures beside it because they are then stale),
followed by the session counts and the **to answer** count, which is clickable and opens the
[attention inbox](attention-and-alerts.md#attention-inbox-one-place-to-drain-what-needs-you). It sits beside `need
you` and means something narrower: `need you` counts SESSIONS in an attention state, while `to
answer` counts the things you can actually settle - and it is the figure that has to match what
the click opens.

The leading connection segment is itself a button: it opens the
[Keep awake](#keep-awake-prevent-idle-system-sleep) dropdown, and while that mode is on the
segment reads **`live · awake`** (or **`live · awake failed`** when the assertion is not
held) - the connection word stays, because it still qualifies every streamed figure beside
it.

When the desktop window narrows, the bar progressively collapses secondary labels instead
of adding ragged rows. The filter becomes its **⌕** glyph; click it or press <kbd>/</kbd> to
reopen it, and it stays open while a filter is active. **Dispatch keeps its label at every
supported desktop width.** Collapsed controls keep their tooltips and accessible names.

The result stays on one row down to roughly half of a desktop screen. Narrower windows may
fall back to wrapping; phone layouts are not a supported target.

### Keep awake (prevent idle system sleep)

The pulse's leading **live** segment opens a compact **Keep awake** dropdown anchored to
the indicator. Its one switch keeps this Mac from going to sleep just because you stepped
away - so long-running agents, Recurring Missions catch-up, and the Foreman keep working
while the screen is dark.

What it does, exactly: the daemon owns an in-process IOKit
`PreventUserIdleSystemSleep` assertion, which prevents **user-idle system sleep** and
nothing else. The display still dims and locks on your normal schedule. Lid close,
choosing Sleep yourself, shutdown, power loss, and the thermal and low-battery safeguards
all still win - this is an idle-sleep inhibitor, not a wake scheduler, and it never keeps
the display awake or simulates activity. It does use more battery than letting the machine
sleep, and the dropdown says so.

While it is on, the indicator reads **`live · awake`** with a purple dot - the word
carries the mode, so color is never the only signal. A native load failure makes the control
unavailable for that daemon run. If assertion creation or release fails, the indicator reads
**`live · awake failed`** and the dropdown carries the bounded error. Mission Control does not
retry automatically or fall back to a command provider; another explicit switch action retries,
reconciling an exact retained handle before reacquiring when a release failed.

The mode is **deliberately transient**: on until Mission Control quits or restarts, never
persisted, never reacquired at boot. An orderly shutdown releases the assertion itself,
and a crash releases it too because IOKit assertions are owned by the daemon process.
The tradeoff is stated in the dropdown rather than hidden: a daemon restart
while you are away returns the mode to off. Keep awake is also independent of
[Away mode](attention-and-alerts.md#away-mode) - alert delivery and host power are different decisions, and
neither implies the other.

Because the **daemon** owns the assertion (not the Electron shell), the switch behaves
identically in every launch mode: browser dashboard, desktop app, adopted daemon, or a
LaunchAgent. Unsupported platforms show **unavailable on this system** instead of drawing
an on state, and while the dashboard is `reconnecting` the switch is disabled - a stale
`on` must never read as a current claim about the OS. Every open window converges on the
same observed state over the live channel. The manual verification runbook, including the
`pmset -g assertions` receipts, is [docs/runbooks/keep-awake.md](runbooks/keep-awake.md).

### Which terminal you use is declared, not assumed

Discovery names no terminal. It asks each registered backend what panes it can see and
joins them to agent processes by controlling tty, so a session is named by the
**innermost** backend holding its pane: a multiplexer session name (tmux, cmux) if there
is one, else a terminal tab title (WezTerm, Ghostty), else `<agent> <pid>`. A session can
hold a handle from each - a tmux pane lives *inside* a WezTerm pane - and both are kept,
because writes go to the innermost while raising a window is the outer one's job.

**Supported today**: tmux and [cmux](https://cmux.com) on the multiplexer axis, WezTerm and
Ghostty on the emulator axis. cmux needs one setting before the daemon can see it - it ships
refusing socket connections from processes it did not start itself, so set
`"automation": { "socketControlMode": "allowAll" }` in `~/.config/cmux/cmux.json` and
restart cmux. Without it your cmux sessions still appear, named `<agent> <pid>` like any
other unrecognised terminal.

The two axes are separate for that reason. A **multiplexer** has named sessions that
outlive any window and a copy-mode that can swallow keystrokes; a **terminal emulator**
raises windows and has no persistence. Neither is a subset of the other, and a backend
declares what it genuinely cannot do rather than stubbing it.

A session therefore carries a **list** of the panes it is reachable through, one per
backend, rather than a field per vendor - so a backend the dashboard has never heard of
is drawn, typed into and torn down like any other. Pane mechanics such as Focus ask one
predicate over that list instead of naming particular terminals. Delivery features such as
the Send box, mode picker, work queue and Foreman ask the runtime-aware predicate described
below; for today's terminal sessions the two answers are identical.

The same declaration decides how a session is **typed into and read**. A reply, a queued
prompt, a menu keystroke, a <kbd>⇧</kbd><kbd>Tab</kbd> and a pane read are all handed to
the backend holding the innermost pane, which renders them in its own convention - tmux
takes key names, WezTerm takes escape sequences - so nothing above that layer knows which
terminal it is talking to. Everything you send through tmux or WezTerm arrives as
written, including a message that begins with a dash. Those backends pipe payload text on
stdin, so prompts carrying a whole plan or phase document are not constrained by a
command-line size limit. The cmux and Ghostty adapters still carry text in command-line
arguments and can refuse a payload that reaches the operating system's argument limit;
that refusal is reported without claiming that any text reached the pane. A backend that
cannot be typed into at all refuses and names itself, rather than reporting that the
session has no terminal.

The same declaration decides a session's **lifecycle** - Focus, Rename, Kill, and where a
dispatched agent is launched in the first place. Focus is the clearest case, because it is
genuinely two steps on two axes: the multiplexer selects the pane, which decides what the
session *shows* and raises nothing, and then an emulator puts a window in front of you -
the tab already running a client for that session, else its own tab, else a fresh one
opened on the multiplexer's own attach command. A machine with a multiplexer and no
scriptable terminal still lands the first half and says plainly that it could not do the
second.

Rename and Kill split the same way *on the terminal runtime*. Renaming a multiplexer-hosted
session moves the session name *and* retitles every tab attached to it; renaming an
emulator-hosted one sets a tab title. An Agent SDK session sits outside this split entirely -
it has no home to move, so its name is a durable field of its own and no backend is consulted,
which is also why the characters tmux reserves are ordinary text in its title. Kill always
signals the agent, and additionally tears down the whole group
when the backend says it has one - a multiplexer session is a group, a terminal tab is
not, and that is declared rather than inferred from which vendor answered. If a Mission
Control task was running in that session, killing it also settles the task - see
[when a task's agent goes away](dispatch-and-backlog.md#when-a-tasks-agent-goes-away).

**Dispatch follows whichever backend you actually have.** With a multiplexer installed you
get what you always got: a detached session with a shell pane split beside the agent. With
none, the agent is launched into a terminal tab rooted at the same worktree, so a machine
without tmux can still dispatch instead of failing with a bare `ENOENT`. What a name may
be follows the backend too - the characters tmux cannot hold in a target spec are tmux's
rule, applied when a name is cut from a task title and when you type one into Rename, from
one declaration rather than two half-copies.

You pay nothing for backends you do not use: a terminal whose binary is not installed is
skipped from the filesystem, without a process being spawned for it on any tick.

Each backend also declares which inherited environment variables to drop before its CLI
runs. WezTerm drops `WEZTERM_UNIX_SOCKET`: a daemon started from a WezTerm pane inherits a
socket pinned to that GUI, and when the GUI restarts the socket goes stale and every tab
would otherwise fall back to a `claude <pid>` name that Focus cannot raise. cmux drops
`CMUX_WORKSPACE_ID` / `CMUX_SURFACE_ID` / `CMUX_TAB_ID`, which are not a socket pin but a
default *target*: a daemon started inside a cmux terminal would aim anything untargeted at
that one workspace. tmux declares nothing to drop - its `TMUX` names a server that is alive
by definition, and it is the same server the app types into.

A backend can also declare that it cannot be trusted about something, which is not the same
as lacking it. cmux 0.64.20 mis-reports the controlling tty of a workspace holding more than
one terminal split - it hands the newer split's tty to the older surface - and the tty is
the only thing joining a process to a pane. Rather than pass that on and bind a card to a
pane its agent is not in, the adapter reports no tty for those workspaces: the session still
appears, named `<agent> <pid>`. For the same reason a session **dispatched** into cmux gets
no companion shell pane, since opening one is what would trigger it.

**Ghostty**, on macOS, is one of those backends. It has no CLI worth the name -
`ghostty +new-window` answers "not supported on this platform" - so it is driven through
its AppleScript dictionary, which lists windows, tabs and surfaces. The first time the
daemon asks it anything, macOS raises an Automation prompt ("Mission Control wants to
control Ghostty"); allow it once. **Deny it and enumeration returns nothing, silently.**
Your terminal keeps working and its sessions fall back to `claude <pid>` names, so a
Ghostty tab that never gets named is the symptom to take to *System Settings → Privacy &
Security → Automation*. Nothing is asked of Ghostty at all while it is not running -
asking would launch it, and a terminal window opening on your desktop every 1.5 seconds is
not a poll.

Ghostty puts no tty on a surface, and the tty is the join everything else is built on, so a
Ghostty tab is matched to a session through the ttys its own GUI process hosts - and only
where exactly one match is possible. Two Ghostty tabs open on the same directory with an
agent in each are ambiguous, and **neither is named** rather than one being guessed: a
wrong match would raise someone else's tab and type your next prompt into it.

A matched Ghostty session is discovered, named, **typed into** and **focused** - replies,
queued prompts, the send chord and Focus all reach the surface. Two things it cannot do, and
both are Ghostty's own limits rather than missing plumbing. **Rename** refuses, saying so
("Ghostty can't retitle a tab"): its titles are read-only on every window, tab and surface,
so a tab it opens carries whatever the shell reports. And its **screen cannot be read**, so
anything built on reading a pane back is unavailable on a Ghostty session rather than quietly
wrong: the permission-mode chip, dialog detection, and the read-back that confirms a pasted
prompt was actually submitted. Run the agent under tmux, inside a Ghostty window or anywhere
else, if you want those too.

### Session runtimes (terminal, or the Agent SDK)

Everything above answers "which terminal holds this session". A separate question is how
Mission Control *talks* to it at all. That is a session's **runtime**, and there are two.

- **Terminal** - what every session you start yourself always is, and the default for Pi.
  It remains an explicit choice for dispatched Claude and Codex sessions. Delivery is a
  bracketed paste and an Enter; a permission prompt is a menu read off the screen.
- **Agent SDK** - the daemon runs the agent itself: Claude Code through
  `@anthropic-ai/claude-agent-sdk`, Codex through `codex app-server` (JSON-RPC over stdio).
  There is no pane. A permission prompt or an approval arrives as data, including what is
  being asked and the exact rows to offer, which the card renders directly.

Human messages from either conversation composer first enter Mission Control's **editable
outbox**, on both runtimes. The full message appears as a `You · queued` turn instead of a
count or a hidden driver queue. Press <kbd>↑</kbd> in an empty composer, or choose **Edit**,
to remove the newest queued message atomically and put its exact text back in the box. Other
queued messages stay in FIFO order.

Every multiline text box grows as text wraps or new lines are added. It keeps up to five
lines visible, including the end of the draft, then scrolls inside the box for longer input.
The field's original row count remains its empty-state floor.

Delivery begins only after the session positively reports idle and no question is covering
its input. An Agent SDK driver rechecks that condition at its own acceptance boundary, so a
message that is still shown as editable never joins a turn that is already running. Both
embedded harnesses would do exactly that with it: Codex through an explicit steer, Claude
Code by attaching it to the running turn, which then answers both and ends once. A terminal
session uses the
same Stop and task-complete lifecycle signals, plus passive transcript or rollout state,
then waits for prompt-pickup evidence after pasting. A refusal before any terminal text was
written returns the row to `queued`. If text may have landed but pickup cannot be proved,
the row becomes `delivery uncertain` and offers **Retry** and **Mark sent** instead of
risking a duplicate.

The outbox is stored in SQLite under the native conversation id when Mission Control knows
it, and otherwise under the discovered session id. It survives browser and daemon restarts.
A row that was being delivered when the daemon stopped recovers as `delivery uncertain` and
is never resent automatically. Reset discards rows that are still safely queued along with
the conversation drafts and work they described. If a claimed row may already have crossed
the runtime boundary, reset retains it as `delivery uncertain` for explicit resolution.
Work Queue automation, its explicit wrap-up send, and a human-approved Foreman draft retain
their direct acknowledged delivery path because their durable audit records claim the text
was delivered.

For dispatched Claude and Codex sessions, **Agent SDK is the recommended runtime**: it
replaces probabilistic paste-and-Enter delivery and screen-scraped questions with
acknowledged turns and structured requests. Terminal is not a deprecated operator surface:
sessions you start yourself are always terminal-backed, and terminal-runtime dispatch
remains an explicit per-harness choice. New installations default dispatched Claude and
Codex sessions to Agent SDK; Pi remains terminal-backed until it has an embedded driver.

The runtime is chosen **per harness, in Settings → Harnesses**, and it is read at dispatch
time, so flipping it mid-batch reaches the next session you launch. New installations use
`sdk` for Claude and Codex and `terminal` for Pi. There is no per-task override. It is also
scoped to dispatch, exactly like the model and effort defaults next to it: a Claude session
you started yourself is pane-backed whatever this says, because Mission Control does not own
your terminal.

**What the Agent SDK runtime changes.** A dispatched session appears as a card with no
pane string under its title (it wears an `◈ Agent SDK` chip instead), and:

- the task's prompt is the conversation's first turn - there is no paste to verify, no
  settle window, and no retry that can make an agent read its task twice;
- permission prompts and plan approvals render as one-click rows on the card. A single
  `AskUserQuestion` keeps those one-click choice rows and adds a separate custom-answer
  field; multi-question or multi-select asks show every question together and submit once.
  Each question accepts either its choice rows or non-empty custom text, and parallel asks
  wait their turn on the same card instead of replacing one another. Claude's own question
  tool is left enabled - the MCP ask-channel redirect exists because a menu on a child's
  terminal is unreadable, and here it is not;
- the permission-mode and reasoning-effort pickers control the live embedded conversation,
  just as they control a pane-backed one - though on Codex a reasoning-effort selection
  takes effect when the next turn starts rather than immediately, which the effort badge
  [says on its face](#levels-that-apply-on-the-next-turn);
- the transcript still comes from the same session file the interactive CLI reads -
  `~/.claude/projects/…` for Claude, the `~/.codex/sessions/…` rollout for Codex, which
  `thread/start` hands the daemon directly. The human-authored task text from the first
  accepted prompt seeds Goal after the driver reports that native conversation id; launch
  manifests and execution contracts stay out of the displayed objective. Later accepted
  human turns enter the same Goal reconciliation queue. Automated Foreman and workflow turns
  do not replace it. Cost and PR state reach the same card fields through those files and the
  driver too;
- **Focus** is replaced by **Continue in terminal** (below).

**What it costs.** The subprocess is the daemon's child, so restarting the daemon interrupts
whatever turn was in flight. The supervisor resumes the same conversation on the next start,
before anything else runs, including its Mission MCP tools. When durable state says a turn
was unfinished, it sends a cautious continuation that tells the agent to inspect the checkout
and avoid repeating completed work; it never replays the original task prompt. Recovery is
at-least-once across the database and vendor process boundary. A restored session whose
durable turn flag is clear sends no prompt; its driver binding confirms it as idle even when
the harness emits no assistant or result frame during an empty-prompt resume. Fresh launches
and interrupted restores remain starting until their ordinary driver lifecycle advances them.

**Automation works here, and works better.** Foreman reviews, answers and drives the work
queue on an embedded session exactly as it does on a pane-backed one, over the same routes -
and the differences all fall the same way:

- a queue item is delivered by one acknowledged call, so an item either was delivered or
  definitively was not. There is no "it may be sitting unsubmitted in the composer" state to
  hand back to you, and no waiting out someone's scroll-back;
- Foreman answers a structured ask by naming the option, and a multi-question
  `AskUserQuestion` by filling the whole form in one submission. On a terminal that form is
  refused outright - pressing a row only ticks a box - so this is an ask it can now answer
  rather than escalate;
- prose is deliverable. A terminal menu discards typed characters, so an answer that named
  no row could not be sent at all; an embedded ask takes free text where a question invites
  it, and takes "no, and here is why" as an answer;
- an embedded session is instrumented by construction - the driver *is* the pickup and
  completion channel - so it never has to wait to have reported a hook before it can hold a
  queue;
- **Reset** clears the conversation through the driver, and the wrap-up skill and the
  skills-reload broadcast reach it the same way. Cost comes off the driver's own `result`
  frame rather than the exporter an interactive session uses, and is counted once either way -
  see [one writer per session](#one-writer-per-session-chosen-by-runtime).

(The full design and its tradeoffs are in `docs/plans/agent-sdk-sessions/plan.md`.)

#### What an embedded Codex session does differently

Codex speaks a different protocol, and two of its answers are its own rather than the
runtime's.

- **Approvals, not permission prompts.** Codex asks when a command needs to escape its
  sandbox - network access, a write outside the workspace. That arrives as the same
  three-row ask (**Yes** / **Yes, and don't ask again** / **No**) on the card, carrying the
  command and the directory it would run in, and answering it releases the turn. If Codex
  also asks a question (`request_user_input`), it renders as a form exactly as Claude's
  does.
- **The permission profile is partly fixed for the life of a thread.** Approvals and the
  reviewer are per-turn settings, so switching between **Ask for approval** and **Approve
  for me** takes effect on the session's next turn. The *sandbox* is not: Codex cannot move
  a running thread between `read-only`, `workspace-write` and `danger-full-access`, so
  picking a profile that would need a different one is refused with a sentence saying to
  continue in a terminal and use `/permissions`. The card's profile chip is read back from
  the rollout either way. After the embedded driver accepts a same-sandbox change, the chip
  shows the selected next-turn posture immediately; the next rollout then confirms it.
- **Auto mode on dispatch** gives an embedded Codex the same posture it gives a terminal one
  (`workspace-write` with approvals on request), using Codex's native **Approve for me**
  reviewer. Requests that reviewer does not approve still arrive on the card.
- Codex's launch-scoped hooks are not injected: the event stream reports everything they
  did, so an embedded session needs neither them nor the
  `--dangerously-bypass-hook-trust` that rides with them. A Codex session dispatched in a
  terminal is unchanged.

The app-server protocol is experimental upstream. Its TypeScript bindings are generated from
the installed binary and committed (`src/server/harness/codex/app-server/protocol.ts`,
regenerated with `node scripts/codex-app-server-bindings.mjs`); a Codex upgrade that moves a
field is a regenerate-and-read-the-diff, not a hunt.

#### Continue in terminal

`⇧T`, or the button where **Focus** sits on a pane-backed card. It stops the driver and
reopens **the same conversation** in a terminal home in the same checkout -
`claude --resume <session id>` or `codex resume <thread id>`, whichever harness the card is.
Both vendors keep one session store across their programmatic and interactive surfaces,
which is what makes this a handoff rather than a lost conversation. Discovery adopts the new
process, and the task's binding follows it across even when discovery takes longer than the
handoff request waits.

The permission mode crosses with it. An embedded session's mode lives in the driver's own
options - nothing on disk records it - so a bare resume would reopen a session you were
running in auto back in the CLI's default mode. The handoff therefore re-asserts the stored
mode on the command line: `--permission-mode` for Claude, and `--sandbox` /
`--ask-for-approval` (plus the approvals-reviewer override that separates **Ask for
approval** from **Approve for me**) for Codex. The same carry applies when an exited
session's card resumes its conversation. Model and reasoning effort are deliberately not
re-stated; the resumed conversation carries those itself.

It is one way. After the handoff the terminal session is the one holding the conversation;
the embedded card goes away. Nothing is lost if the terminal cannot be opened - the error
tells you the exact resume command to run yourself.

### Interrupt: stop the turn without ending the session

<kbd>⌃</kbd><kbd>C</kbd>, or the **Interrupt** button beside Kill. It stops what the agent is
doing right now, drops every message still queued behind it, and puts the cursor in that
session's composer so the replacement instruction can be typed immediately.

The distinction from **Kill** is the whole point. Kill terminates the agent and settles its
task; the conversation, and all the context in it, is gone. Interrupt ends only the turn. The
session, its conversation, its checkout and its task are all still there a moment later, and
the next thing you type continues from everything the agent already knows.

The queue goes with it, and that is not incidental: a stop that left queued messages armed
would deliver them the moment the agent reported idle, restarting the work you just stopped.
Messages that have already left for the agent are kept, as are any whose delivery is marked
uncertain - the second kind is a question waiting for you, and interrupting is not an answer
to it.

The queue is dropped **only when a turn was genuinely stopped.** A card reports what it was
told a moment ago, so a turn can finish on its own between your keypress and the request
arriving - which is likeliest exactly when you press this, as a turn looks like it is
wrapping up. Nothing is stopped in that case and nothing is dropped, and the card says so:
"That turn had already finished, so nothing was stopped - anything queued will still be
delivered." Silently deleting queued messages there would destroy work that was about to be
delivered normally, not work anybody asked to restart.

**The key you press and the key the agent receives are not the same.** In the Claude Code,
Codex and Pi TUIs alike, <kbd>Esc</kbd> interrupts a running turn while <kbd>⌃</kbd><kbd>C</kbd>
clears the input line and, pressed twice, quits the CLI - so forwarding your literal
<kbd>⌃</kbd><kbd>C</kbd> into a terminal would kill the session it was meant to interrupt.
What Mission Control writes into a pane is <kbd>Esc</kbd>. An Agent SDK session is stopped
through its driver's own interrupt instead. One gesture, two mechanisms, and the card picks
the right one from the session's runtime.

Both runtimes are covered, on every agent that has them. Pi is terminal-only - it has no
embedded driver - so the pane keystroke is not one of two options for it but the only one
there can be.

**A terminal interrupt is fire-and-forget.** Nothing on that path reports back that the turn
actually ended: the keystroke is written and the pane is not asked. The card shows an
optimistic "interrupting" that the next real reading of the session replaces. An Agent SDK
interrupt is confirmed by the driver, so it settles immediately.

**A pane in tmux copy-mode refuses, and says so.** Copy-mode routes every key to tmux instead
of the agent, so the interrupt is declined rather than silently swallowed - and it is not
cancelled on your behalf, because <kbd>Esc</kbd> is the key that *leaves* copy-mode. Sending
it there would pull you out of the scrollback you were reading and leave the agent running,
which is worse on both counts. Leave copy-mode (<kbd>q</kbd>, or scroll to the bottom) and
press again.

<kbd>⌃</kbd><kbd>C</kbd> is also Copy on Windows and Linux, which the desktop app inherits.
**Whenever text is selected the browser keeps the keystroke** and performs the copy - whether
that is a half-written draft in the composer or a transcript line, a diff hunk or captured
terminal output you have dragged across. With nothing selected, it stops the agent. Like
every other shortcut it is rebindable in **Settings → Keyboard**.

The button is disabled when there is nothing to stop - an idle agent - and the tooltip says
which of the two reasons applies.

### What each agent can do is declared, not assumed

Claude Code, Codex and Pi are not the same product, and several features below reach
only the harnesses that support them. Rather than testing "is this Claude?" at each place,
every agent **declares** what it has: permission modes, skills, work queues, reasoning
effort controls, a command that clears its context, an MCP client. Absent is a first-class
answer.

That is why the differences you see are consistent rather than piecemeal. A Codex card
draws its permission picker using Codex's native `/permissions` menu, while
<kbd>⇧</kbd><kbd>Tab</kbd> still does nothing because Codex has no mode cycle to walk; its
work-queue drawer is available once that session's launch-scoped hooks have reported, so
[Foreman](foreman.md#foreman-auto-responder) can observe and drive it; and the
[skills](skills-and-settings.md#skills-every-session-mixed-reload-behavior) catalog links a skill into each
harness's own directory while nudging only the one that needs telling. Where the capability
*is* there the branch disappears entirely: a **reset** of a Codex checkout clears its
context with the same `/clear` a Claude one gets, because Codex declares that command too.

The declarations move as the harness does, and a capability is filled in only after it has
been pointed at a real install. Several of Codex's were `null` on the strength of a
plausible-sounding claim and turned out to be wrong when someone checked - it draws
readable option menus, its session file parses into conversation turns, it speaks
`/clear`, and it has a skills directory of its own. Each of those was one entry in a
record, and correcting it lit the feature up everywhere at once with no component and no
stylesheet touched.

The dashboard is declaration-driven too, down to the paint. An agent states its own
name, transcript byline and brand colour (`AGENT_IDENTITY`, `src/shared/agent.ts`), and
the stylesheet mentions no agent at all - the colour arrives as one `--agent-accent`
custom property, so a new harness colours its dot and its transcript byline with no CSS
written. Everywhere a sentence has to say *which* agents a feature reaches - the dispatch
form's agent picker, the skills rows, the auto-mode switch, the empty grid - that list is
computed from the capability, never typed out.

Adding a third agent means filling that declaration in. The types make it impossible to
add one and quietly inherit Claude's answers, and nothing about it needs a component or a
stylesheet edited to show up. **Pi** (`@earendil-works/pi-coding-agent`) is that third
agent, added as the migration's acceptance test: it discovers, names, focuses and takes
typed input, all from declaration alone. Its session format parses as rich conversation,
but an operator-started process supplies no identity that can safely bind it to one file.
Mission Control-dispatched Pi sessions receive an exact native session id and can use
transcript-derived state; operator-started ones visibly degrade to no transcript. It disables
what it lacks in the open: no MCP client, no work queue without hooks, and no permission-mode
chip, because its `manual`/`auto`/`readonly` approval modes are its own vocabulary rather than
the ones the chip is built for. The spike and the interface couplings it surfaced are written
up in `todo/pi-harness.md`.

### Precise status (Claude hooks)

Passive discovery can tell a session is *alive*, but process discovery alone cannot
say whether the agent is actively working, sitting idle, or waiting on you. Claude
Code **hooks** close that gap: a tiny bridge reports each lifecycle event to the daemon
so every card shows a live, precise state and a one-line activity. Codex can also
confirm working and idle passively from explicit lifecycle markers in its rollout file;
its hook-only safeguards remain separate, as described below.

**1. Install** (idempotent - it merges into `settings.json` in place, rewriting
only the hook arrays it changes, so your other settings, your own hooks, and
even comments are preserved; re-running when nothing changed doesn't touch the
file):

```sh
npm run install-hooks
```

Expected output:

```
Wired Mission Control hooks into /Users/you/.claude/settings.json
  events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop, SubagentStop, PreCompact, SessionEnd
  script: /Users/you/workspace/ai-harness/hooks/harness-hook.mjs
```

This adds one `command` hook per event to `~/.claude/settings.json`, each running
`hooks/harness-hook.mjs` with the event name. The bridge is fast, writes nothing
to stdout, swallows every error, and always exits 0, so a hook never blocks or
fails the agent even when the daemon is down.

The paths it bakes are absolute, and chosen to outlive the machine changing under
them. The `node` it writes is a stable alias (e.g. `/opt/homebrew/bin/node`) rather
than the versioned directory `process.execPath` resolves to, which the next
`brew upgrade node` deletes. And it refuses to run from a checkout inside a
native or legacy transient worktree pool: pool slots are reclaimed, and every hook baked from one
then fails every event in every session on the machine with `MODULE_NOT_FOUND`.
Install from a durable clone, or pass `--force` to override; `--uninstall` is
always allowed, so an abandoned slot can still clean up after itself.

Which events those are, and what each one means for a card, belongs to the agent rather
than to the installer: both live on `HARNESSES.claude.hooks`
(`src/server/harness/claude/hooks.ts`), which this script and the packaged app's
**Install Claude integrations…** both read. Only the payload mapping - Claude's hook JSON
keys - is in the bridge itself; the transport under it
(`src/shared/hook-bridge.mjs`) names no agent. An agent that reports nothing declares
`hooks: null` instead, and its cards are read passively, off discovery and whatever its
own session file says. Claude and Codex report hooks - Codex by a different route,
[below](#precise-status-for-codex-hooks-that-ride-on-the-dispatch). Pi declares
`hooks: null`; only a Mission Control-dispatched Pi has the exact transcript binding needed
for passive working/idle state.

**2. Start a new Claude Code session.** Claude reads hook config when a session
starts, so **sessions already running when you install won't report until you
restart them.** This is the #1 reason a busy agent is stuck on grey "running"
right after installing - the fix is simply a fresh session (or a full Claude
restart), not a code change.

**3. Verify.** In a new session, run anything; its card should flip from grey
**running** to blue **working** within ~1s. Or ask the daemon directly:

```sh
curl -s http://127.0.0.1:7317/api/sessions | grep -o '"instrumented":[a-z]*'
# "instrumented":true  while the session has fresh hook evidence
```

**Uninstall** (removes only our entries, leaves your other hooks intact):

```sh
npm run install-hooks -- --uninstall
```

This also clears any `mission-*` and `fleet-*` skill links out of **every declaring harness's
skills directory** - `~/.claude/skills`, `~/.agents/skills`, and `~/.pi/agent/skills` - as a
dev-teardown convenience, so a checkout you're walking away from leaves nothing loaded. It
does not turn the feature off: the config still says the skills are on, so a daemon
started from this checkout re-creates them. To switch skills off for good, use the
master switch in Settings → Skills.

<details>
<summary>What it writes to <code>settings.json</code></summary>

Tool events (`PreToolUse`, `PostToolUse`) get a `"*"` matcher; the rest match
every invocation. Paths are absolute (a durable alias for your `node`, and this
repo):

```jsonc
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "*", "hooks": [
        { "type": "command",
          "command": "\"/usr/local/bin/node\" \"/Users/you/workspace/ai-harness/hooks/harness-hook.mjs\" PreToolUse" }
      ]}
    ],
    "Stop": [
      { "hooks": [
        { "type": "command",
          "command": "\"/usr/local/bin/node\" \"/Users/you/workspace/ai-harness/hooks/harness-hook.mjs\" Stop" }
      ]}
    ]
    // ...one group per event: SessionStart, UserPromptSubmit, PostToolUse,
    //    Notification, SubagentStop, PreCompact, SessionEnd
  }
}
```

Each fired hook POSTs `{ agent, event, sessionId, cwd, env }` to
`http://127.0.0.1:7317/hooks/<event>` with the `~/.mission-control/token`. The daemon
binds it to the right card via the terminal pane env (`TMUX_PANE` /
`WEZTERM_PANE`) and maps the event to a state (see the table below). `agent` is what says
whose event vocabulary `event` is written in: a pane outlives the agent in it, so an
event is only ever applied to a card running the harness that sent it. It defaults to
`claude` when absent, since a bridge installed by an older checkout predates any other.

</details>

### Precise status for Codex (hooks that ride on the dispatch)

Codex reports too, and its ten events are declared on its own harness
(`src/server/harness/codex/hooks.ts`): `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `PermissionRequest`, `Stop`, `PreCompact`, `PostCompact`, `SubagentStart`
and `SubagentStop`. `PermissionRequest` is the one worth naming: it is Claude's
`Notification` by another name, the single event that means *a human has to answer this*,
so it maps straight to amber **needs input** rather than being swept into the working
fallback. Nothing else fires while a session is parked on it, which is exactly when a card
must not read as busy.

**There is nothing to install, and that cuts both ways.** Claude's hooks are written once
into `~/.claude/settings.json` and every session on the machine reports from then on.
Codex's are **launch-scoped**: the dispatcher builds one `-c hooks.<Event>=[…]` override
per event, pointing at the bundled bridge (`dist/satellites/codex-hook.mjs`, overridable
with `MISSION_CODEX_HOOK`), and passes them on the command line. So a **dispatched** Codex
session is instrumented from its first breath, and a Codex session **you** started
yourself sends nothing but still reports confirmed **working** and **idle** states from
explicit lifecycle markers in its rollout file. That passive evidence is enough to place
the session in the right board column and lets the editable outbox wait for confirmed idle
before delivering a human message. It does not enable task handover, work queues, or other
safeguards that specifically require live hooks. If the bridge bundle is missing because
`npm run build` never ran, the launch drops the overrides and runs uninstrumented rather
than failing.

Those overrides ride with `--dangerously-bypass-hook-trust`, and never without them.
Codex would otherwise stop at a trust prompt for hooks the dashboard itself just injected,
and a dispatched session has no human at the keyboard to answer it. The flag is
process-wide for that one launch, so it also clears hook trust for anything the dispatched
checkout's *own* Codex config declares - which is why it is spent only on a **dispatch**,
a launch you asked for into a repo you picked, and never on a session you started
yourself or on one the app merely discovered.

### Status line (optional)

Claude Code runs your `statusLine` command on every terminal render and pipes it a payload
the hooks never carry: the live model, thinking level, context window, and your
subscription's rate-limit windows. Wrapping that command lets the daemon read it too:

```sh
npm run install-statusline             # installs the hooks above, and wraps the status line
npm run install-hooks -- --uninstall   # unwraps it again (restoring your own command)
```

The wrapper delegates to whatever status line you already had - recorded in
`~/.mission-control/statusline-inner`, or `ccstatusline` if you had none - and prints only
that command's output, so your terminal looks exactly as it did. It is never installed for
you: a plain `npm run install-hooks`, and the packaged app's integrations, leave
`statusLine` untouched.

It makes the model / thinking / context figures on the cards exact (without it they come
from a passive transcript read), and supplies the [cost telemetry](#cost-telemetry) plan
meters for terminal Claude sessions. Embedded Claude SDK sessions have no terminal status
line; they fetch the same account windows through the SDK instead. For the passive context
meter, Mission Control applies each recognized model's default window: Fable 5, Opus 4.6+
and Sonnet 4.6+ use 1M, while Opus/Sonnet 4.5 and Haiku 4.5 use 200k. An explicit window
reported by Claude remains authoritative.

When Mission Control can safely read and write the live session, its thinking badge is
also a picker: click it to see the effort levels Mission Control can safely apply to the
selected model and choose one for that session. A successful change uses the harness's
native session-only control; it never changes that harness card's **Effort** select in
**Settings → Harnesses** or what future sessions start with. Until the current model and
effort have a trustworthy passive baseline, or when the pane cannot be written, the badge
stays read-only. The same picker appears on Cards, in Console detail, and on Board tiles.

#### Levels that apply on the next turn

Not every harness can move a conversation it is already having. Claude changes the running
conversation, so its badge simply reads the new level. **An embedded Codex session applies
reasoning effort when it STARTS a turn**, and a turn already under way cannot be moved onto
a new level - so a level chosen there takes effect on the next turn.

The badge says so rather than pretending either way. It reads `medium → high` with a
**next turn** tag and a dashed outline, meaning the conversation is running `medium` and
`high` is set for the turn after this one; the picker repeats the sentence above its
options. Two consequences are worth knowing:

- **A reply you send while the badge is pending joins the turn that is running**, and that
  turn keeps its old level. Wait for the session to go idle if you want the new level to
  apply to what you are about to ask for.
- **Nothing about the badge reverts on its own.** It stays pending until the session
  actually starts a turn, however long that takes and however often the rest of the card
  refreshes. When that turn starts, the badge settles on whatever the session really ran -
  normally the level you chose, or, if something else changed it in the meantime (a
  `/model` in a terminal on the same conversation, say), on that instead.

Changing your mind while a level is pending is a normal change: pick the level the
conversation is currently running and the pending one is dropped, so the next turn stays
where it is. Changing the model, clearing the context, or the session rebinding to a new
conversation all drop a pending level too - it was a promise about a conversation that no
longer applies. A pending level is not remembered across a daemon restart; the level itself
is (it is stored with the embedded session and re-asserted on the next turn), so the badge
settles as soon as that turn runs.

### Session status colors

Each card's status badge and its left edge stripe encode the session's state:

| Color | State | Meaning |
|-------|-------|---------|
| 🔵 blue | **working** | agent is actively running a prompt or tool |
| 🟢 green | **idle** | alive, waiting at an idle prompt |
| 🟠 amber | **needs input / needs review** | the agent (or a review item) is blocked on you |
| 🟠 amber | **needs an answer** | the session is parked on an [option menu](#answer-a-sessions-menu-from-the-dashboard) |
| ⚪ grey | **running** | alive, but precise state unknown - hooks aren't reporting |
| ⚫ dim | **exited** | the process is gone |

Blue / green needs a trustworthy lifecycle source: the [Claude
hooks](#precise-status-claude-hooks) you install once, the [Codex
hooks](#precise-status-for-codex-hooks-that-ride-on-the-dispatch) that ride on a dispatch,
or an exactly bound passive transcript such as a Mission Control-dispatched Pi session.
Without one, a card shows grey **running** - with one exception: **needs an answer** is read
off the terminal itself, so a session sitting on a menu goes amber whether or not it's
instrumented. That exception is the point: an uninstrumented session waiting on a
permission prompt is the most blocked thing on the board, and it used to report as grey
running forever. **Needs input / needs review** still comes from hooks or a review item.
The small colored dot next to each title is *not* a status - it's the brand color the agent
declares for itself (terracotta for Claude Code, green for Codex, blue for Pi).

Claude and Codex sessions carry a **permission mode** chip. Claude offers `manual`, `accept
edits`, or `plan` on the standard cycle, plus `bypass` / `auto` / `don't ask` for sessions
that enable them; <kbd>⇧</kbd><kbd>Tab</kbd> still cycles those modes. Codex offers its
native **Ask for approval**, **Approve for me**, **Full Access**, and **Read Only** profiles
through `/permissions`.
Clicking either chip opens the same dashboard picker and drives the harness's own control.
Like the thinking badge, it appears on Cards, in Console detail, and on Board tiles, so
triaging from the board does not mean opening a session to change its permissions. In
**Console detail it leads the header's runtime cluster** - mode, model, context, cost -
rather than sitting in the pane's footer: the posture governs the session, while the three
readings beside it are consequences of running under it. Before
Codex writes its first observable mode, the neutral `permissions` chip still opens the
picker. When the pane cannot be written the chip stays read-only.

### Open a terminal, or the agent's own CLI, on a session

Above every conversation sits the worktree that session is working in, and two buttons.

**Terminal** opens your login shell (`$SHELL`, else `/bin/sh`) in that worktree. Its menu
lists the four registered backends - **tmux**, **cmux**, **WezTerm** and **Ghostty** - and
reports which this machine can use. An unavailable backend stays listed with a **sentence**
saying why, because "not installed" and "installed, but nothing here can show its windows"
are different things to go and fix. tmux is the second of those: `tmux new-session` opens
**detached**, so its row is enabled only when an emulator is present to raise it, and then
says which one it will use. A button that reported success and put nothing on screen would
be worse than no button.

The **agent button** puts you on that conversation. Its shape follows what is safe: it is a
plain button when a live pane can be focused, and otherwise opens the same terminal chooser
as **Terminal** so you can pick where the resumed CLI appears.

Its behavior changes with the session:

- The session **already runs in a terminal** - it has a pane. Then the button has no menu
  at all; it takes you to that terminal. Opening a second `--resume` beside a live pane would
  put two agent processes on one conversation file, which no harness arbitrates.
- The session is [embedded](#session-runtimes-terminal-or-the-agent-sdk). **Continue in
  terminal** opens the chooser, stops the live driver, then reopens that exact conversation
  through the existing handoff lifecycle in the backend you selected.
- The agent has **exited**, but its checkout and conversation id survive. Its old pane
  handles are stale, so the chooser resumes the CLI in the selected backend. The daemon
  claims that resume exclusively and transfers any active task and terminal-resource
  ownership before the replacement session appears.

A session whose checkout the daemon could not read renders **Terminal** disabled with the
reason. A handoff or resume is disabled until it has both a checkout and a conversation id;
a live pane remains focusable without either. If the harness cannot resume the conversation,
the disabled agent button says so.

This appears on **every layout that shows a conversation** - Cards, Console detail, and the
Board's drilled-in pane - because it lives in the conversation panel itself rather than in
any one card.

### Answer a session's menu from the dashboard

When a session stops on an option menu - a **permission prompt**, an `AskUserQuestion`
clarification, a **plan decision**, the folder-trust check - the card renders that menu's
rows as **buttons**, with the question above them and each row's description beneath it.
Click one and the daemon answers it in the terminal. Not just plan mode, and not only the
ones Foreman declined: **every** menu a session is parked on is offered.

A **multi-select** `AskUserQuestion` renders as **checkboxes with a Submit button** instead,
because it is a form rather than a menu: in the terminal, Enter on one of its rows only
ticks that row's box, and nothing reaches Claude until its `✔ Submit` tab is confirmed. Tick
any number of rows, press **Submit answers**, and the daemon ticks what differs and walks
Claude's own submit path. If Claude has further questions, the next one takes the card's
place and you answer it the same way; if its review tab reports a question still unanswered,
the form is left up rather than sent half-filled.

**An answered question stays in the conversation.** The original pull request includes a
runtime capture of the form and the entry it leaves. Submitting an `AskUserQuestion` form on
an Agent SDK session writes the same gold entry a review answer writes - the questions
replayed with every option they offered, the ones you took marked, and any custom answer you
typed - placed at the point in time you answered. Permission prompts, plan approvals and
trust checks write nothing: an auto-mode session answers dozens of those an hour, none of
them chose between anything, and the next turn says what happened anyway. Foreman's answers
are recorded as Foreman's and stay out of your conversation, where they are already
[its own entry](foreman.md#foreman-auto-responder).

Without it the answer had nowhere to go. It reaches the agent by resolving the callback its
turn is blocked on, and the only trace in the transcript is a turn that is purely a tool
result - which every harness parser drops as machine noise. So the log showed the question as
a grey `AskUserQuestion` chip, then a silence, then the agent acting on a decision the reader
could not see, while the identical question asked over the review channel left a permanent
record.

This works for **Codex sessions too**, and that matters most for the ones nothing
instruments: Codex's hooks [ride on a
dispatch](#precise-status-for-codex-hooks-that-ride-on-the-dispatch), so for a Codex
session you started yourself a menu read off the pane is the *only* evidence Mission
Control can have that it has stopped and is waiting for someone. Its command-approval
prompt, its directory-trust check and its update prompt all render as buttons exactly like
Claude's. Each agent declares how its own screen reads (`harness.tui`), which is what lets
one grammar serve both - they differ, it turns out, by a single cursor glyph.

The menu is read straight off the pane on the same ~1.5s sweep that reads the permission
mode, so it needs **no hooks** and costs no extra work - and it clears the moment the menu
does. On a menu the card also marks the row the terminal's own cursor is on, so this view
and a tab open on the same session never disagree about what Enter would do. A dialog whose
pane stops being readable - the window closed, the tmux server restarted - clears within a
few sweeps rather than lingering as rows nothing can reach.

**The reply box is closed while a menu is up**, deliberately. A dialog isn't a text box: it
discards typed characters, and the Enter that follows confirms whichever row was already
highlighted. The outbox rechecks for a dialog at the terminal write boundary, so a queued
reply waits if a menu appears after the card's last refresh. The buttons are the only way to
answer one.

Because the card's copy of the menu is up to one sweep old, a click sends back the **label**
you were shown and the daemon re-reads the pane before pressing anything: if the screen has
moved on - the menu closed, the rows repainted, [Foreman](foreman.md#foreman-auto-responder) got there
first - the click is **refused and nothing is pressed** rather than landing on the wrong row.
That also makes racing Foreman safe, which is why every menu is offered rather than waiting
tens of seconds to see whether Foreman handles it.

### Scrolling a pane back pauses writes into it

Scroll a session's **tmux** pane back and tmux puts it in **copy-mode**, where it routes
every keystroke to itself: `send-keys` and `paste-buffer` both report success while the
agent receives nothing. So the daemon reads the pane's mode before it types and **refuses**
the write instead, naming the mode - a reply, a menu click, a
<kbd>⇧</kbd><kbd>Tab</kbd>, a queued item and a skills reload all wait rather than
vanishing. It refuses rather than dropping you out of copy-mode, because a pane in it is a
person reading their own scrollback. Leave it (<kbd>q</kbd>, or scroll back to the bottom)
and the write goes through on the next attempt; Foreman retries a parked queue item on its
own, and doesn't spend one of that item's delivery attempts on you.

The one case that isn't a clean no-op is scrolling *while* an item is being delivered: the
prompt is pasted, then the Enter that submits it is swallowed. The text is sitting in the
composer unsubmitted, and the error says exactly that - leave copy-mode and press
<kbd>Enter</kbd> yourself rather than re-sending, which would paste a second copy.

### Reading a session's whole conversation

The Conversation tab opens on the session's **recent** turns, and scrolls back through the
rest on demand. A card open reads a bounded tail rather than the file - a long session's
transcript runs to tens of megabytes, most of it tool output - so the panel is quick to
open whatever the session has been doing.

Every dated row carries its local clock time on the speaker's line, pinned to the right
edge of the log - **You** on the left, **9:42 AM** on the right - so the times read as one
column instead of landing wherever each speaker's name happens to end. The message itself
still runs the full width beneath, so the clock costs the conversation no measure. Hover a
time for the complete local instant with weekday, date, seconds, and timezone; the date is
there rather than on every row, where it would repeat unchanged down a whole session. A
transcript record with no timestamp shows none rather than inventing one; a folded run of
tool calls shows when that run began. Inline Foreman entries use the same absolute clock,
while the Foreman history drawer keeps its relative age. The original pull request includes a
runtime capture of the rendered layout.

Four voices share the log, told apart by colour rather than by label alone: the agent's turns
in its own harness accent, your typed replies in blue, Foreman's entries in purple, and - in
gold - the answers you gave its questions, whether it asked through the
[review channel](#review-channel-mcp) or through its
[own question form](#answer-a-sessions-menu-from-the-dashboard). The gold entries are
not transcript turns; like Foreman's, they happened beside the conversation and are placed by
when they happened, so an agent that blocked on a question for an hour shows your answer
after the hour of work, not before it. The original pull request includes a runtime capture of
how the four read against each other.

What the CLI writes into the conversation on its own behalf is not one of those voices and
never reaches the dashboard: the note it leaves in place of a pasted image, the payload it
attaches when a skill loads, its own resume nudge. The CLI marks those records as its own
in the transcript file, and the daemon's transcript reader drops them on that marker as it
parses - so they are gone before the conversation is sent, and no browser has to decide
anything about their wording. They had no author the daemon could attribute, so they used
to arrive wearing your byline, which made the conversation claim you had typed
`[Image: original 2360x12932…]` or *Continue from where you left off.*

Scroll to the top of the log and the page above loads automatically, then the page above
that, back to the session's first turn. **Load older messages** does the same on click,
for when you would rather not scroll. Nothing appears once you reach the beginning: a
short session shows no control at all.

What you have scrolled back to is kept for recently viewed sessions, so switching to the
Diff tab and back, collapsing a card, or moving between sessions usually returns you to
the history you had - not to the tail again. The cache lasts for the browser tab; an
evicted entry can always be fetched again by scrolling up.

A dropped connection or a daemon restart costs you nothing either: the panel reconnects
by telling the daemon how far it already has, and gets back only the turns written while
it was away. Your place in the conversation does not move. It starts over from the recent
turns in two cases only - the transcript was cleared or replaced under it (a `/clear`), or
the agent wrote more than a reconnect can honestly be said to have missed. Both are the
honest answer rather than a continuation with an invisible hole in it, and scrolling up
re-reads whatever was dropped.

In both Chat and Terminal, the composer prompt reads `mission (s) >` with the operator's
resolved **Send message** binding in parentheses. Rebinding that action changes both
prompts too, and an unset action leaves the parentheses out rather than teaching a key
that no longer works.

### Reading a conversation as a terminal

A conversation can be drawn two ways. **Terminal**, the default, draws the conversation as
one stream, the way the session actually ran. **Chat** draws a byline per speaker, prose in
bubbles, and tool calls as grey chips. In Terminal:

- what you sent is a prompt line, `you@mission ~/repo ❯ ...`, naming whoever typed it - a
  turn Foreman sent reads `foreman@mission`, never as though you asked for it. Foreman's
  purple node, host and bounded message panel carry the same provenance as its chat entry;
  a completion review also separates its original request, findings, suggested fixes and
  safety note so the actionable part is scannable without leaving the terminal stream;
- what the agent said is a block of stdout under a `claude / stdout` header;
- a run of back-to-back tool calls folds into one record - *claude executed 3 commands* -
  which opens to the literal commands and paths, rather than becoming rows in the log;
- above it a titlebar names the window, the agent, and the tty the session is on (or its
  runtime, for a session with no terminal), with an indicator that says whether the
  dashboard is attached to the transcript right now;
- below it a status line carries the session's run state, its pid, its branch, how much of
  the context window it has used, and the shortcuts for reaching its terminal, its diff,
  and completing or killing it.

The shortcut row prints only keys that do something on **this** session, in your own
bindings: a session running in a pane is offered `focus`, a driver-run one `terminal`
(Shift+T), and a session with no checkout is not offered `diff`, because there is nothing
to compare. `complete` is always offered on a live session even without a task, since the
chord opens the same dialog either way and that dialog is what explains there is nothing to
mark done. A finished session is offered nothing, because there is nothing left to do to
it. The row disappears entirely if you have turned keyboard hints off, since teaching the
chords is all it does.

Everything else is unchanged, because it is the same panel: the same box replies, the same
attachments drop onto it, find works the same way, the Activity and Yours rail is still
beside it, [the step the current turn is on](#the-step-the-current-turn-is-on) is still the
last thing in the log - drawn as the stream's own last entry, spine and all - and Foreman's
decisions and your review answers still appear in place. Only the drawing differs.

The status line says nothing it cannot prove. A session that reports no pid shows no pid
rather than `pid 0`; a session off a checkout shows no branch; a context share appears once
a harness has reported one. The folded record is held to the same rule as the Observed
activity rail below: it lists the calls the transcript recorded, and claims no result,
no exit code and no duration for any of them. Where it shows an elapsed time, that is the
span between the run's first and last recorded turn, and its tooltip says so.

**Settings → Display → Conversation** chooses the default for every session. Any single
conversation can be flipped on its own with the **Terminal view** button - above the log on
a card, in the detail's tab strip in Console and Board, where it appears only while the
Conversation tab is the one you are reading. It
wins over that default for that session until you close the tab - so one agent can be
read as a chat log while the rest stay in the terminal stream. Nothing about the
per-session choice is stored; a reload starts over from the default.

### The step the current turn is on

While a session is working, the last row of the log is not a turn: it is one dimmed line
carrying the agent's own report of what it is doing this second - `running Bash` - behind a
turning marker. The next real turn replaces it, the way a typing indicator is replaced by
the message it promised.

It is drawn only while there is something to report. `activity` is written on every
lifecycle event rather than only the busy ones, so a settled session's copy of it is a
status word (`idle`, `ended (logout)`) that the state badge already carries - and a session
whose hook channel has gone quiet holds whatever it last saw, which is a claim about the
present sourced from an hour ago. Neither draws a row. A session with queued messages shows
the row **above** them: a queued message has not been delivered yet, so the step running now
comes first.

The line is held to one line and clipped, with the full text on hover. That is a
requirement rather than a preference - the log follows its tail only while you are near the
bottom of it, and a row free to wrap would push you out of that window and quietly stop the
conversation following itself. A change to the reported step leaves a reader at the bottom
of the log still at the bottom of it.

**In the Console detail this replaced a band above the transcript.** The line used to sit in
fixed chrome at the top of the pane, where it cost the conversation its height whether or
not anything was running and described the present at the end of the pane furthest from
where the present arrives.

The session card keeps its own activity line, which is a field in the card's status block
rather than chrome above a conversation - a collapsed card has no log for a tail row to sit
in. Expanding one shows both: the card's line near the top, and the in-progress row at the
tail of the panel the expansion just opened.

### The rail beside the conversation

A rail sits to the right of the transcript under two tabs: **Activity**, which lists the
tool calls recorded in the conversation, and **Yours**, which indexes the messages you
sent. It shares its column with find - while find is open its results own the space
([below](#find-in-a-conversation)), and closing find gives the rail back on the tab you
left it on.

#### Activity

Not to be confused with the row above, which is a different feature with a different
source: **Activity** is derived from the transcript and claims nothing about what
is running, while the in-progress row is the session's live self-report about exactly that.
One says what was recorded, the other says what is happening.

The **Activity** tab lists the tool
invocations recorded in it - the time each appeared, the tool, and what it was invoked on
(`bash ls`, `read styles.css`), through the same projection the inline tool chips use, so
the two can never disagree. It answers "what actions has this agent attempted?" at a
glance, without scrolling a long conversation for the grey chips - including calls made
mid-paragraph on turns that are mostly prose, which the log does not fold into a tool run.

The name is the contract: each row means an invocation was **observed in the loaded
transcript**, nothing more. The rail is not a process monitor and does not claim results -
no running, succeeded, or failed, no durations, no output. The transcript records that a
call was made; whether it finished or how it went is not something the record can prove,
so the rail does not say it. Its window is the transcript's too: what you have loaded is
what it lists, so scrolling back through older turns adds their invocations, and a session
whose transcript cannot be resolved shows none rather than inventing any.

On a narrow conversation the rail collapses to a single row under the log - the transcript
keeps its reading width and height - and opens on a click when you want the list. The tabs
stay on that row while it is shut, so choosing one is never blocked behind opening it
first, and choosing one opens it.

#### Yours

**Yours** answers a different question: *what did I actually ask for?* It lists the
messages you sent, newest last, with the time and the first two lines of each. Clicking one
takes the transcript to that turn, which flashes where it landed. The row you picked stays
marked in the rail; the flash on the turn fades, because it answers "you were taken here"
rather than saying the message is in some state.

It is an **index, not a filter**. Nothing is removed from the conversation - the agent's
replies, its tool runs and everything else stay exactly where they were, which is the
point: in a supervised session your messages are a few percent of the turns, so what sits
*between* two of them is most of what happened. Jumping to one of your messages lands you
in that context rather than replacing it.

**Turns you did not type are listed too, dimmed and below yours, each naming its author.**
Much of the `user` side of a supervised session is not the operator: Foreman delivers work
items, Mission Control injects on your behalf, and workflow repair sends fix rounds. All
three arrive as ordinary user turns, indistinguishable in shape from something you typed,
so a list built on the turn's role would hand them back to you as your own words under a
tab called "Yours". The grouping is on authorship instead - the same rule the byline in the
log uses - and the rail says so at its foot.

One limit worth knowing, because it is the same one the byline has: authorship is recorded
in memory at the moment of delivery, so a turn delivered before the daemon last restarted
has no author left to read and falls back to reading as yours. The rail is never more wrong
than the transcript beside it, and never differently wrong.

### Find in a conversation

<kbd>⌘</kbd><kbd>F</kbd> searches the open conversation the way a browser's find searches a
page: it counts the occurrences, highlights every one, and steps between them. A bar
appears over the top-right of the log - it floats, so nothing you were reading moves -
and beside it a rail lists each match with the sentence around it and who said it.

<kbd>Enter</kbd> goes to the next match and <kbd>⇧</kbd><kbd>Enter</kbd> to the previous,
wrapping at both ends; the chevrons do the same with the mouse. Clicking a row in the rail
jumps straight to that match. The current match is the solid highlight, every other match a
tint of the same colour, so you can see where you are without reading the count.
<kbd>Esc</kbd> closes find and takes the highlights and the rail with it.

**The rail is there exactly when find is open.** There is no separate control for it, and
it is never dropped to reclaim space - on a narrow card it moves below the conversation
rather than disappearing. Closed, find costs a conversation nothing at all.

| Control | What it does |
|---|---|
| **Aa** | match case. Off by default, so `ghostty` finds `Ghostty` |
| **All / You / Agent / Tools** | which side of the conversation to search. A transcript is mostly folded tool output by volume, so **You** and **Agent** are how you find what was actually *said* - and **Tools** is how you find a file path |

**You** means the messages you typed, on the same authorship rule the Yours rail and the
bylines use - not every turn wearing the `user` role. Turns delivered by Foreman, Mission
Control or workflow repair are not under it; they remain under **All**, where their byline
names who sent them.

The query is literal, not a pattern: `foo(bar)` finds those seven characters.

Tool chips are searched too, because that is where the file paths are. Role bylines are
not - otherwise `you` would match the label above every message you ever sent. Foreman's
entries and your review answers are not searched either: they are cards rather than turns,
and a match inside one has no single string whose offsets a highlight could name.

One caveat the bar states rather than hides: the log holds the session's recent turns, not
the whole file (above), so find counts what is **loaded**. When there is more to load the
rail says so and offers the same **Load older** the scroll-back uses; load it and the
count grows to include it.

### Shadow reading: Claude's own session state

Claude Code ships `claude agents --json`, which lists every live session - background and
interactive, including ones you started by hand - with `pid`, `sessionId`, `cwd`, `status`
(`idle` / `busy` / `waiting`) and `waitingFor` (`permission prompt` vs `input needed`).
That overlaps three things this daemon works out the hard way: the `ps`-to-tty-to-pane
correlation, the permission-mode footer parse, and the heuristic that decides whether a
notification is a real question or an idle nudge.

It is **not** wired into discovery, because on the machine this was written on the two
views joined 11 of 11 sessions by `sessionId` but agreed on state for only 7 of them. The
join rate says the identity plumbing is redundant; the disagreement rate says the state is
not a drop-in replacement, and some of those gaps are probably bugs on our side - this is
the first time there has been a second opinion to check against.

So it runs as a **shadow**: off by default, and when on it only logs.

```bash
MISSION_AGENTS_SHADOW_MS=30000 npm run daemon
```

```
[agents-shadow] mission=6 claude=17 joined=6 unjoined=0 agree=3 disagree=3 skipped=0 claude-only=11
[agents-shadow]   sid=ae07d2ea pid=68926 mission=working claude=idle
```

`skipped` is counted separately so `agree + disagree` is never mistaken for the whole
population: it covers records Claude reported without a status, and sessions in a state
Claude has no analogue for (`awaiting_review` is a Foreman concept). Codex sessions are
excluded entirely - `claude agents --json` cannot see them. `claude-only` is the count of
sessions Claude knows about and this daemon does not, which is usually background agents.

Nothing here changes behaviour. It exists to turn "should we adopt this?" into a decision
backed by days of data rather than one sample.

### Goal

Every instrumented card with a captured prompt carries a one-sentence **Goal** under its
title, visible even while the card is collapsed. The Goal is the session's durable completion
objective, not a copy of the newest prompt or the step the agent happens to be working on.

**Console detail draws it in the same place** - under the session's name, with the other
facts that change rarely - rather than in a band above the transcript. There it takes one
line and ellipses, and hovering gives you the whole sentence along with whatever the Goal's
state has to add ("being refined", "automatic wrap-up is paused"). A harness that can never
carry a Goal still says so there, in the same slot.

The first substantive instruction establishes an immediate provisional objective with no
model call. Every substantive instruction, including that first one, enters a durable queue;
later instructions also update the tactical focus immediately. The daemon then reconciles the
queue in capture order, one instruction at a time, using the prompt and a small conversation
window. Rapid prompts are never coalesced, so an objective change cannot disappear behind later
steering.

An instruction still in the editable pending-turn outbox has not reached this pipeline. Once
the agent accepts it, the instruction leaves the outbox, enters the reconciliation queue, and
can update the card's tactical focus immediately. Agent SDK delivery records that boundary
directly from the driver's acknowledgement; terminal delivery observes it through the
harness's prompt hook.

Each reconciliation records one of five relationships:

- **initial** establishes the first objective;
- **steer** changes the method, priority, sequence, or next step without shrinking the
  objective;
- **amend** extends the existing completion contract;
- **replace** supersedes the old outcome; and
- **unclear** keeps the existing objective while completion remains ambiguous.

No command or special vocabulary is required. The model infers the relationship from the
instruction and conversation. An amendment is accepted only when its proposed contract
explicitly retains the existing objective as its prefix; a narrower amendment stays
unresolved. An effective amendment or replacement updates the Goal and advances its objective
version, while steering changes only the latest focus.

The reconciliation call is rate-limited to at most once a minute per session. Its provider
and model are selected in **Settings → [Models](models.md#models-what-the-apps-own-model-work-runs-on)**;
out of the box it uses the **local `claude` CLI, not the Anthropic API**, with no API key in
Mission Control. If the provider is missing, logged out, slow, or returns an unsafe amendment,
the last durable objective stays visible and the unresolved instruction remains ahead of later
ones. Prompted automatic wrap-up stays paused until every instruction has a resolved,
unambiguous relationship. The same fail-closed rule covers migrated state whose missing prompt
text cannot be recovered.

What it deliberately isn't:

- **Not** what the session is doing this second. That's the activity ticker, which reads
  on its own line on a card and at
  [the tail of the log](#the-step-the-current-turn-is-on) in the Console detail - "running
  Bash" is not a goal. The goal changes rarely and the ticker changes constantly, which is
  why they no longer share a band.
- **Not** derived from anything but your prompts. Background task notifications arrive
  through the same hook and are filtered out; they're actually the majority of it. Agent SDK
  deliveries also carry authorship, so Foreman and workflow instructions do not replace your
  Goal.
- `/clear` starts a new session, so it wipes the goal; `/compact` keeps the same session
  and leaves it alone.

**Codex cards carry a Goal too**, and both tiers reach them. Agent SDK sessions for Claude
and Codex capture their accepted launch and human follow-up prompts directly at the driver
boundary. Terminal sessions capture prompts from their harness hooks; the refiner then reads
the same transcript or rollout file the conversation pane does. An uninstrumented session
you started yourself has no prompt to show and stays blank. Pi can read conversation turns
too, so it has no permanent `GOAL_UNSUPPORTED` refusal; it does not yet push a prompt event,
however, so current Pi cards do not seed a Goal. The permanent-refusal map is null for all
three harnesses, and only agents whose harness can never read turns get an unsupported
sentence.

### Cost telemetry

You run a fleet; this values its usage consistently without pretending a subscription has
a per-request dollar bill. Codex session estimates are automatic, and so are Claude sessions
Mission Control **runs** - an embedded session's cost is read off the driver's own message
stream, which no setting can switch off. What the telemetry toggle below buys you is the
sessions Mission Control merely **discovered**: a `claude` you started yourself in a terminal
has no driver, so its cost reaches the ledger over OpenTelemetry or not at all. It is off by
default; switch it on in **Settings → Cost**, or from the CLI:

```sh
npm run install-telemetry     # adds an env block to ~/.claude/settings.json
npm run install-hooks -- --uninstall   # removes that block - and the hooks, and the
                                       # status line wrapper. To switch off only the
                                       # cost telemetry, use Settings → Cost.
```

Once any session or automation source has data, every priced session card carries a **cost
badge** beside its model / thinking / context row, and the topbar grows a **cost chip** -
`≈$12.40 · $3.10/hr`, in the machinery purple cost wears everywhere. Clicking it opens the
**Spend** popover, which carries the rest:

| Figure | Where | What it is |
|---|---|---|
| **Fleet today** | chip and popover | Claude- plus Codex-estimated session usage since local midnight |
| **Rate now** | chip and popover | the last hour of that same session estimate |
| **Tokens today** | popover | session input, output and cache, every tier summed |
| **Per shipped PR** | popover | today's session estimate over pull requests either agent opened today, with the count it was divided by. Counts only PRs we can [prove we opened](inspector-and-shipping.md#inspector-automated-pr-review) |
| **Automation** | popover | API-equivalent estimated cost for the Foreman's and GitHub Inspector's own model calls since midnight, with the per-role split printed under it |
| **Runway** | popover, and the chip's colour | per rate-limit window: how much is used and how long the rest lasts at the pace it has been spent so far. The bar is consumption, the figure beside it is the projection. Each row names the provider whose quota it is, since Claude and Codex report their own |

The runway is the only forward-looking number in the app, and it is an average
extrapolated forward - which is why it is written `~41 min`, and why a window the current
pace does not exhaust reads **clears** rather than a made-up time. It is projected from
the window's own percentage and nothing else: the estimated cost rate and the quota are different
meters, so deriving one from the other would be a confident number about the wrong thing.
An average cannot see a burst; a fleet that idled all morning and then started six
sessions reads as calm for a while.

The chip is the one thing cost keeps permanently on screen, so it is also what carries the
warning: when a quota window is projected to run out it turns amber and then red, trades
its rate for the reading that escalated it (`≈$12.40 · 96%`), and names that window in its
accessible name rather than leaving the alarm to colour alone. It does **not** escalate on
the dollars - those thresholds are per session, and a fleet clears them most afternoons, so
a chip wired to them would be red by lunchtime every day. A fleet with no usage and no quota
reading at all renders no chip, rather than a confident `$0.00`. `Esc` or a click outside
closes the popover; `Cost settings →` in its footer opens **Settings · Cost**.

Six transports feed these figures, each kept to the facts it actually reports:

| Source | Provides |
|---|---|
| **Claude Agent SDK `result` frame** | what each turn of a session Mission Control runs cost, from the frame's own `total_cost_usd` and per-model `modelUsage`, keyed to the turn's `uuid` so a replayed frame cannot double-count. Read off the stream the driver already holds, so it needs no exporter, no endpoint and no setting |
| **OpenTelemetry** | the same figures for sessions Mission Control did NOT start: Claude Code's locally calculated `claude_code.cost.usage` and `claude_code.token.usage` by tier, per session, model, and `query_source` |
| **statusLine payload** | your Claude subscription's `five_hour` / `seven_day` rate-limit windows for terminal sessions; OTel has no quota metric |
| **Claude Agent SDK usage** | the same account windows for embedded SDK sessions, refreshed when the session resumes after a daemon restart and after each completed turn |
| **Codex rollout file** | quota windows plus request-level `last_token_usage`, including model, cached input, cache writes, output, and reasoning output. A durable byte cursor and event identity make restarts/replays idempotent |
| **Headless run envelopes** | the app's OWN model calls: Claude's Agent SDK `result` frame reports its cost and per-model tokens by default, the supported `claude -p --output-format json` escape hatch carries the same envelope, and `codex exec --json` reports tokens on `turn.completed`. Read straight from the process the run already returns, so no exporter or endpoint is involved |

#### One writer per session, chosen by runtime

A driven session's subprocess is ordinary Claude Code, so when its exporter is working, both
it and the driver can report the same turn. Exactly one of them is allowed to, and which one
is decided by how the session runs rather than by which harness it is:

| Session | Written by | Because |
|---|---|---|
| Mission Control **runs** it (Agent SDK) | the driver's `result` frame | it cannot be switched off from outside the app, and it needs no export interval to arrive |
| Mission Control **discovered** it (terminal) | OpenTelemetry | nothing drives it, so its own export is the only report that exists |
| Codex, either way | the rollout-file reader | it sees request-level usage the driver never receives |

The exporter yields for a key a driven session owns, so a turn is recorded once whichever
transport is healthy. That ownership **expires after an hour of no driver activity**, which
matters because the same conversation can change hands: a session driven through the Agent SDK
may later be continued as a plain `claude --resume` in a terminal, where nothing drives it and
the exporter is the only party that can report its cost. Neither the session table nor the
ledger forgets on its own, so without an expiry the guard would go on silencing that session's
only reporter for months. An hour is far longer than the gap between a turn and its export
(capped at 60s), so it costs nothing in the case it exists for.

This replaced a rule that gave Claude a single writer - the exporter -
for every session. That rule had one failure mode and no error path for it: an exporter that
stops producing takes every Claude session's cost to zero, and because the ledger cannot tell
*nothing was spent* from *nobody wrote it down*, the dashboard reads `$0.00` with nothing
amiss anywhere. If that happens now, only discovered sessions are affected, and **Settings →
Cost** says so in as many words instead of leaving the gap to be inferred from a total that
looks complete.

That warning is judged on the export ARRIVING, recorded as each one lands rather than inferred
from the rows it produced. Both alternatives are unsound: a driven session's datapoints are
deliberately discarded, so a healthy exporter on an embedded fleet writes no row at all, and rows
live for 180 days, so "has one ever existed" would keep reporting healthy for months after the
exporter fell silent - the very regression the warning is for. It also has to see recent session
spend before it fires, because silence on a machine nobody is using reports nothing missing, and a
panel that warns about a quiet weekend is one you learn to scroll past.

#### What the app spends on itself

The Foreman and the GitHub Inspector call models on their own schedule, with nobody asking them
to. That spend is real - on a busy fleet it is the largest thing running when you are not
looking - and until it was attributed it was also invisible: a `codex exec --ephemeral` run
writes no rollout file and exports nothing, while a headless Claude run *does* export
OpenTelemetry, but under the fresh session id every headless run mints, so it landed in the
ledger under a key belonging to no card and was silently counted as session spend.

Both now report themselves per subsystem and role. The Foreman's triage, full review,
work-item verification, and backlog planning are separate from the GitHub Inspector's PR reviews
and follow-up replies. Hover **Automation today** for that split. Keeping the roles separate
is the point: it makes "is shadow triage worth what it costs" and "did that prompt fix
land" questions the app can answer, which one undifferentiated automation bucket could not.

**This is a separate line, not part of the fleet total.** Session cost is work you asked
for; this is the overhead of having that work watched, and it moves while nothing else is
happening - rolled together, a quiet morning with a busy GitHub Inspector would read as fleet
activity with no way to see which half moved. The two are each independently true and can
be added by anyone who wants one number.

The runs are valued exactly as everything else is: Claude runs carry the cost the CLI
calculated (`reported`), Codex runs are priced from the same versioned Standard API
snapshot an interactive Codex session uses (`api-equivalent`), and a model with no verified
rate stays honestly unpriced. Each row is keyed to the run's own id - Claude's
`session_id`, `codex exec`'s `thread_id` - so a retried report cannot double-count, and a
Claude run's OpenTelemetry twin is recognised by that same id and excluded from session
spend rather than billed twice.

The Foreman worker never writes the database, so it reports over
`POST /api/usage/automation`; the daemon prices and records the report. Valid reports are
buffered durably in the state directory before delivery, retried with backoff, and recovered
after a worker restart. Because each entry represents spend from a run that already
finished, the buffer has no retention limit: it trades unbounded growth during a daemon
outage for never discarding spend, and its small entries drain as soon as the daemon
acknowledges them. **Waiting is the default for every failure**, and only a body the daemon
has definitively refused - a schema rejection, or a runner it has no pricing for - is set
aside - and only that daemon's own verdict counts, because only it is durable. A daemon
mid-rolling-upgrade that has no `/api/usage/automation` yet, a rate limit, a timeout, a
payload limit that may belong to a proxy rather than the daemon, a status nothing here
anticipated: all of those simply hold, and land by themselves once the condition clears,
with nobody involved. That direction is deliberate, because the
only unacceptable outcome is losing an already-paid-for run, and holding one costs a stalled
queue that resolves itself. A definitively rejected report is still not deleted: it moves to
a `foreman-spend-quarantine.<id>.json` file so it cannot stall the reports behind it, and
stays there for you to re-send. Nothing drains that file automatically, since re-queueing a
body the daemon has already refused would loop forever; the worker logs an error naming the
file when it puts something there. If that file is ever unreadable - corruption, a
hand-edit - its bytes are moved aside to a `.unreadable-*` name rather than replaced, since
every entry in it is a run that was already paid for. The daemon holds up the other end of that contract: it
acknowledges a report only when the row was written or there was genuinely nothing to write,
and answers 422 for one it cannot record at all - a runner a newer worker named that this
build has no pricing for - so the sender quarantines it instead of treating silence as
success. The buffers are not a second ledger, and duplicate
delivery is harmless because each row is keyed to the run's own id. Attribution deliberately reads the fresh
run's returned envelope instead of giving runs a reusable session id: the Foreman must review
many sessions without one conversation's context bleeding into the next.

Terminal Claude plan meters need the [opt-in statusLine wrapper](#status-line-optional)
(`npm run install-statusline`); embedded Claude SDK sessions repopulate them automatically.
That SDK lookup is optional live enrichment: a failure neither interrupts the session nor
clears the last valid account gauge, and it never writes cost - a driven session's cost comes
from its `result` frames and a discovered one's from OpenTelemetry, never from this lookup.
The estimated-cost figures don't need the wrapper, and Codex's windows need
neither - they ride in the exact rollout file reported by app-server and read by the same
runtime metadata poller that supplies model and context figures. Telemetry and the terminal
wrapper remain separate opt-ins because they are two different asks of your config - one adds
an `env` block, the other rewrites the command that draws your terminal line. Only `--telemetry`
adds the block and only `--uninstall` removes it: re-running `npm run setup` or any other
installer leaves an existing block exactly as it found it, so **Settings → Cost** stays the one
switch.

A plan meter disappears once its window resets rather than holding the last percentage -
a quota that has already rolled over is not a figure worth showing, and the same rule
already governs an account with no rate limits to report.

**Every dollar figure is one API-equivalent estimate.** Session cards mark it `≈$`; so does
the cost chip, and the Spend popover says so once in its footer rather than five times.
**Automation** follows the valuation described above. Claude Code calculates its rows from request usage; Mission Control prices
Codex requests at an immutable snapshot of OpenAI Standard API rates, including cache and
long-context rules.
Estimator provenance remains on each session, but both values have the same economic
meaning: neither is Pro, Max, or ChatGPT plan spend, credits consumed, or an invoice. The
session and automation windows degrade independently. If any row in either window has no
verified price, that window reads **partial**; an incomplete session window also withholds
cost/PR rather than presenting a known subtotal as the complete estimate.

Enabling it writes six keys into your `~/.claude/settings.json` `env` block (see
[Configuration](configuration.md#configuration)); the edit is surgical, your other settings and comments
are left byte-for-byte intact, and switching it off removes only the keys it added. It
has to be a settings-level `env` rather than a per-spawn variable because Mission Control
sees sessions it didn't start.

Ledger rows are kept for **180 days** and pruned by age alone - a finished session's cost
is exactly when the record starts being interesting.

Codex ingestion covers the main rollout only. Separate subagent rollouts are not assigned
to a parent by cwd or timing because that relationship is not proven. The standard-price
snapshot currently recognizes `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, and
`gpt-5.5`; a new model intentionally stays unpriced until its official rate is added.
Claude's estimate can include provider-priced server tools such as web search; Codex
rollouts do not currently expose every separately billed hosted-tool fee.

### Review channel (MCP)

```sh
npm run build                    # builds the MCP server bundle
claude mcp add -s user mission-control -- node /ABSOLUTE/PATH/dist/mcp/server.mjs
codex mcp add mission-control -- node /ABSOLUTE/PATH/dist/mcp/server.mjs
```

(`npm run install-hooks` prints the exact `claude` command with your paths. The desktop
app's **Install Claude integrations…** does both at once, because each harness declares its
own CLI, its own env flag and whether it even has a scope to register under - Codex has one
registration and no `-s user|project` to choose between. A harness with no MCP client at all
would be reported as such rather than silently skipped.)

> **Adding or changing a tool means rebuilding the bundle.** Both the registration above and
> the dispatched-session `--mcp-config` launch the *built* `dist/mcp/server.mjs`, never
> `src/mcp/server.ts` directly - so a new or edited tool in the source is invisible to every
> session until `npm run build` (or just `npm run build:mcp`) refreshes that file, after which
> you start a **new** session to pick it up. Re-running `claude mcp add` is not needed: the
> registration records the *path*, and the rebuild replaces the file it points at (re-add only
> when the server *name* changes). The dev stack is the same trap in disguise - `npm run dev` /
> `make start` auto-reload the daemon from source, but the MCP bundle is not on that watch, so
> an MCP tool change still needs a manual rebuild. `dist/` is gitignored, so a `git pull` that
> brings you a new tool never brings you a bundle that serves it.
>
> **The drift is reported rather than left to be noticed.** Three things watch for it, because
> the failure it produces is silent - a scout told to call `submit_scout_artifacts` cannot
> finish its task without it, and an absent tool ends the work with no error anywhere:
>
> - The daemon completes a real MCP handshake against the bundle at startup and logs
>   `Mission Control's MCP server at … does not publish …` when it is behind the source.
> - A dispatch or assignment that **requires** a tool - every scout, every ensemble member -
>   is refused before the agent spawns, naming the tool and `npm run build`.
> - `npm run smoke` fails if the built bundle's published tools do not match
>   `MISSION_MCP_TOOLS` exactly, in either direction.

This registers a stdio MCP server (`src/mcp/server.ts`) that each session launches. It exposes
the standard review, reporting, and status tools, plus task-scoped submission tools a session
receives only when its work needs one: [`submit_ensemble_result`](ensembles.md#multi-agent-ensembles) for an
ensemble member, [`submit_scout_artifacts`](archives.md) for a scout, and
`submit_workflow_evidence` for a workflow-bound ship task whose immutable graph contains a
Persona. The workflow tool registers contained gitignored screenshots and focused UTF-8 text
or log artifacts by issued repository slot or across all applicable repositories before task
completion. It never tells the agent to commit evidence. A ship task without such a workflow
keeps its prior Mission MCP launch and receives no evidence instructions:

Registered evidence is visible in the session card's shared **Image evidence** composer before
**Ship it** or the built-in No-Mistakes review starts. A person can remove a stale registration,
add screenshots by choosing, dropping, or pasting, and assign captions and repository scopes
without moving the files into git. The same conversation-owned list appears in the initial
workflow binding dialog before a binding exists, so the first review cannot capture an unseen
stale item. The composer keeps unfinished uploads and edits across a
closed confirmation or a failed submission, then clears only after the daemon accepts the
review request.

The MCP tools are:

- `share_plan(title, plan)` - show a markdown plan (non-blocking)
- `request_plan_decisions(title, plan, decisions)` - show a plan with selectable
  options (radios / checkboxes) and **block** until the human submits their choices or
  dismisses that decision set without an answer
- `request_review(title, diff)` - show a diff and **block** for approve / changes
- `create_task(title, intent, dependsOnTaskIds?, dependsOnCurrentSession?)` - add a ship task
  for the current repo to the backlog with the default agent/model/effort, returning its id so
  later tasks can carry durable dependency edges. The calling agent is usually standing in a
  worktree; the task is filed against the **repo that owns it** - see [A task's repo is the
  repo, not the worktree](dispatch-and-backlog.md#a-tasks-repo-is-the-repo-not-the-worktree)
- `request_input(question, options?)` - ask a question and **block** for the answer.
  With `options` the human gets clickable choices (radios, or checkboxes with
  `multiSelect`, plus an optional free-text "Other") and can dismiss a stale set without
  submitting it; without them, a text box
- `report_product_issue(type, title, details, attachmentUploadIds?)` - only after the user
  explicitly asks for a Mission Control product report, prepare a public GitHub issue and
  **block** on a dashboard review containing the exact daemon-derived repository, labels, body,
  and safe environment summary. The only publishing choice is **Submit public issue**; Dismiss
  and any non-human or malformed answer publish nothing. Reports are text-only in this release,
  so `attachmentUploadIds` must be empty. Success returns the exact issue URL, a CLI refusal says
  retrying is safe, and an unknown outcome says to check GitHub before trying again
- `report_status(activity)` - update the session's activity line
- `submit_workflow_evidence(images?, artifacts?)` - register bounded gitignored screenshots
  and UTF-8 text or log files for the selected Persona workflow. Every item supplies a stable
  client id, caption, checkout-relative path, and `repositoryScope` set to an issued repository
  slot or `all`. At least one item is required. The daemon resolves and re-hashes the source;
  the caller never supplies an absolute path, digest, submission id, or storage location

Mission Control-authored task and workflow execution prompts carry a standing, conditional
authorization for already-scoped work. If the task or current workflow asks for a pull request,
the agent may commit the scoped work, push its task branch, and create or update that pull
request in the issued repository without asking for another confirmation. This is not an
instruction to create a pull request, an explicit no-PR instruction still wins, and merge,
other repositories, and other external writes remain unauthorized. Prompt authorization is
also separate from sandbox approval posture and does not widen it.

A newly delivered ship task narrows that standing authorization for its initial implementation
turn. The agent implements and verifies the change, reports that the work is complete, and
stops without committing, pushing, opening or updating a pull request, or waiting for pull
request CI. That settled completion is the handoff to Foreman. Foreman either starts the
selected workflow or sends the direct pull-request follow-up; a workflow can later deliver its
own Pull Request action. Only that later Foreman or workflow instruction starts the commit,
push, pull-request, and CI work. This keeps a bound workflow ahead of shipping without taking
away the standing authorization the later instruction needs.

When `submit_workflow_evidence` is exposed, the prompt likewise authorizes the exact
server-validated call for task-produced, checkout-relative files and issued repository scopes.
That includes `repositoryScope: "all"` only when Mission Control issued it. The agent calls the
tool directly instead of asking for approval of the payload or Mission Control destination.
Repository resolution, path and symlink checks, type and size limits, UTF-8 validation, and
live-session attribution remain authoritative. Workflow resubmission belongs to Mission
Control's engine or the Runs UI, so an agent completes the repair and does not ask the human to
resubmit it.

Because the MCP server is a child of the agent, it inherits the terminal env and
binds every call to the correct session automatically.

Each option-based question or plan decision set is an independent review. Dismiss resolves
only that review, persists without a fabricated answer, and releases its blocked tool call.
These reviews keep the session under **Needs you** while any set remains pending; submitting
or dismissing the final set clears that review-based signal.

**A blocking tool waits as long as you do, and asking twice does not queue twice.** Every tool
marked **block** above is waiting on a person, which can be minutes or hours. The MCP client in
front of it does not wait that long on its own: it abandons the tool call on its own timeout and
hands the model an error for a question that is still on screen and still answerable, and the
model's natural recovery is to ask again word for word. Two things keep that from reaching you:

- While it waits, the daemon's long poll reports in to the client after every round trip, as a
  standard MCP **progress notification** against the token that client supplied. A client that
  receives one restarts its timeout for that request, so a wait that keeps reporting in is never
  abandoned for taking too long. A client that asks for no progress gets none, and simply behaves
  as it did before.
- If a retry happens anyway - a client that ignores progress, a dropped connection, a daemon
  restart - **an identical ask from the same session, while the first is still unanswered,
  re-attaches to the question that is already open** rather than opening a second one. You see
  one card, you answer it once, and every call still listening is released by that one answer.

The re-attach is deliberately narrow: it matches only a **pending** review with the same kind,
the same wording, and the same offered options. A question you already answered is never reused,
so an agent that legitimately asks the same thing again later gets a fresh card; a different
session's identical question is never folded into yours; and changing the options makes it a
different question, because the options are what you are choosing between.

**Your answer stays in the conversation.** Submitting a review writes a gold entry into that
session's conversation, at the point in time you answered. What the entry shows depends on
how you were asked:

| You answered | The entry shows |
|---|---|
| **A question with options** (`request_input` with `options`, or `request_plan_decisions`) | the question replayed as a form - every option it offered, with the one(s) you took marked - plus any free-text **Other** |
| **A direct-text question** (`request_input` with no options) | the text you submitted |
| **A diff or plan** (`request_review`, `share_plan`) | what you did - approved, or requested changes - and the note you left, if any |
| **A dismissal** | that you closed it without choosing, and nothing more |

It is a record, not a control: nothing on it can be clicked, and a resolved review cannot be
answered twice. The original pull request includes a runtime capture of both shapes rendered in
a conversation, beside an ordinary user turn and a Foreman one.

This exists because the answer had nowhere else to go. It reaches the agent as an MCP tool
result, and a transcript turn that is purely a tool result is dropped by every harness parser
as machine noise - so the log used to show the agent's question as a grey tool chip, then a
silence, then the agent carrying on as though something had been decided. Where there were
options, the entry is rendered from the choices as stored rather than from the answer string
sent to the agent, because that string names only what you picked and cannot say what you
picked it from. Where there were none, that string *is* the whole answer, so it is shown as
you wrote it.

Only **your** resolutions appear there. Foreman resolves reviews through the same channel,
and its answers are already in the conversation as [its own entry](foreman.md#foreman-auto-responder),
so they are not also shown as yours. Answers recorded before this shipped carry no actor and
are left out rather than credited to you on the strength of their status.

A review is bound to the session that asked it, so **the agent going away settles it too**.
When a session is evicted - killed, its terminal closed, or simply gone by the time the
daemon comes back up - anything it was blocked on is recorded as `orphaned` rather than left
pending. It keeps its question and body in the history; it stops being counted as somebody
waiting on you. That is deliberately not the same status as a dismiss: you declining to
choose and the agent no longer being there to hear a choice are different facts, and only
the first is evidence of your intent.

Registering it by hand as above covers sessions **you** start. Sessions the dashboard
dispatches get it automatically - see [The ask channel](#the-ask-channel).

### The ask channel

Claude sessions the dashboard dispatches into the **terminal runtime** do not use Claude's
built-in `AskUserQuestion`. It is disallowed on the spawn, and the agent is pointed at
`request_input` instead, so a clarifying question arrives as structured arguments in the
dashboard rather than as a menu drawn on a terminal nobody is watching. Agent SDK sessions
keep the built-in tool because its questions already arrive as structured driver requests;
see [Session runtimes](#session-runtimes-terminal-or-the-agent-sdk). Either way the answer
lands in the session's conversation as the same gold entry - the two channels differ in how
the question reaches you, not in what is written down afterwards.

A Codex Agent SDK launch that successfully registers the bundled Mission MCP server also
appends one developer instruction: when the operator needs to review alternatives, select an
option, or answer another discrete multiple-choice question, call `request_input` with
`options` and wait for the response instead of presenting the choices only as prose and
ending the turn. Mission Control reads Codex's effective configured developer instruction
first and preserves it ahead of this appendix. If the MCP server is unavailable, or that
effective instruction cannot be read safely, the appendix is omitted so the launch never
points Codex at an unavailable tool or replaces the operator's customization.

For the terminal runtime, four flags go on together or not at all
(`src/server/ask-channel.ts`): `--mcp-config`
supplies the tool, `--allowed-tools` pre-approves it so calling it doesn't itself raise a
permission prompt, `--disallowed-tools` removes the built-in, and `--append-system-prompt`
carries the redirect that tells the agent where to go instead, inline.

If **anything** prevents the full set - the MCP bundle is missing (`npm run build` never
ran), or the state directory cannot be written - then **none** of them are passed and the
session keeps the built-in menu. An agent with nowhere to ask is worse than one with a menu
we can read, so every failure disarms the whole channel rather than half of it, and setting
up the *ask channel* never fails the dispatch: it is best-effort, and the daemon logs which
condition it hit.

A launch that **requires** a Mission tool is the exception, and it is a different question.
Asking is best-effort because a session that keeps the built-in menu is merely the status quo;
submitting is not, because a scout with no `submit_scout_artifacts` and an ensemble member with
no `submit_ensemble_result` have no way to finish their task at all. So those launches are
checked twice before the agent spawns - that the registration reached the argv, and that the
bundle it names actually **publishes** the tools, established by a real MCP handshake against
that exact file. Either check failing fails the dispatch, names the tool and points at
`npm run build`, and tears the worktree down for a clean retry. See
[Adding or changing a tool means rebuilding the bundle](#review-channel-mcp) for why a bundle
can be present and still be behind the source.

The redirect is not optional. Measured on live sessions, `--disallowed-tools` on its own
does not send the agent anywhere - it asks its question in prose and ends the turn. It rides
inline on `--append-system-prompt` rather than in a file: that flag is listed plainly in
`claude --help`, so there is nothing to probe for, and tmux passes the whole prompt through
as one unmodified argv element. That combination is verified end to end, not inferred - a
dispatched agent given a question-inviting prompt calls `request_input` with structured
options and blocks, with no permission prompt, and resumes when the review is answered in the
dashboard. The tradeoff is that a dispatched agent's `ps` line carries the prompt, which is
fine - it is a static instruction with no secrets in it.

Sessions **you** start are untouched: they keep the built-in menu, which the dashboard
still reads off the pane and answers. Codex is untouched too - these are Claude's flags.

*Which* MCP server those flags point at is decided in one place, `src/server/mission-mcp.ts`:
the built bundle's path, the runtime that can execute it (a real `node`, or the Electron
binary in node mode when there isn't one), the name it is registered under, and - for a launch
that requires tools - whether that bundle really serves them. Claude reads
that as a `--mcp-config` file; Codex, when a launch asks for it, reads the same answer as
`-c mcp_servers.mission-control.*` overrides. Either way it is scoped to that one launch and
leaves whatever **Install integrations** registered machine-wide alone.
