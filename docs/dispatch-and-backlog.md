# Dispatch an agent

The dashboard isn't just a mirror - you can launch new agents from it. Click **＋
Dispatch** or press <kbd>+</kbd> to start the guided pass, answer its questions (or press
<kbd>⇥</kbd> to use the ordinary form), and describe the task. For a harness-owned task the
daemon:

1. provisions an **isolated worktree** for the task from the daemon's
   [native pool](worktrees-and-checks.md#native-pools), or a disposable `git worktree` on a
   fresh `harness/…` branch when native policy is disabled or capacity positively refuses, so
   an agent never shares a working tree with another session,
2. resolves the chosen harness's [session runtime](sessions.md#session-runtimes-terminal-or-the-agent-sdk)
   at launch, then takes exactly one path. **Terminal** launches the agent
   (`claude`/`codex`/`pi`) in a terminal home rooted there - a named multiplexer home when
   one is installed (tmux adds a second **shell pane split beside it** for ad-hoc
   git/build/inspection), or a terminal tab in that worktree when no multiplexer is
   available. It waits for that exact discovered session to become ready, verifies it is
   still live, and injects your task as its first prompt. Pi instead receives both a
   generated session ID and the task through its native positional launch message, which Pi
   submits after initializing its TUI. Mission Control binds that generated ID for later
   transcript attribution without waiting for Pi's lazily-created session file or injecting
   the prompt into the pane a second time. Because that launch message is Pi's only channel,
   it is also where Pi is told about [repository memory](repository-memory.md): when the
   worktree carries a `.agents/memory/MEMORY.md`, one pointer line is composed ahead of your
   task. Claude and Codex need no such thing - they load the repo's root doc, and the
   reference line in it, themselves. **Agent SDK** (Claude and Codex today) instead
   starts the embedded driver with the task as turn one. It creates no terminal home and
   needs no discovery, readiness wait, paste, or delivery retry; the driver's binding is the
   readiness signal.

If either launch path cannot prove it started as requested, dispatch fails instead of
calling an unverified task running.

An enabled conductor repository offers one different launch owner: **pipeline**. It creates
the ordinary durable task row, derives conductor's canonical idea slug, and stores that exact
provider run identity before it starts the configured Engineer host. Dispatch refuses an intent
with no canonical slug, an unreadable provider run set, a worktree already using the slug, or
another live Mission Control task that already owns the same provider, repository, and slug. A
retry clears the old identity and recomputes it from the current intent and provider configuration.

The shipped host is **Claude Agent SDK**. Mission Control starts one managed Claude session at the
repository and sends the exact `/engineer <intent>` command as turn one. It creates no Mission
Control worktree or terminal home. **Settings → Conductor → Launch runtime** can instead select
**Terminal**, which keeps the compatibility path: `conduct-ts engineer --idea "<intent>"` opens in
a real terminal rooted at the repository, with live stdin and inherited `CLAUDECODE` removed so
Conductor is not nested inside the daemon's Claude session. An SDK preflight or launch error fails
the task visibly and never falls back to Terminal. This setting controls only the Engineer host;
Conductor's background build daemon keeps its own tmux supervision.

Conductor owns worktree creation and every downstream agent, model, and effort choice in both
modes. Agent, Model, Effort, attached repositories, After work, and the generic runtime picker
therefore remain unavailable for Pipeline. Pipeline tasks also stay out of Foreman's backlog
autopilot. The SDK host is the task's current session, so Focus, questions, cancellation, and
restart recovery use the ordinary managed-session paths. A Terminal task instead records its
home and no session id.

Neither host is a completion authority. An idle or merged SDK host cannot finish the task, and a
host disappearing after the exact run appears only removes the stale session pointer. The task
reaches done only when its exact provider projection becomes processed, at which point its pull
request becomes the outcome link. A lost SDK host fails the task if that exact run never appeared.
The Terminal home stays recorded until standard cleanup releases it. A Terminal task saved by an
older build with no precomputed run identity can still bind once when a child in that home appears
inside a projected provider worktree. A discovered child can confirm a matching prebound identity,
but cannot replace it with a different run.

## The guided pass

The form has eight controls, and for most dispatches five of them are already right. Guided
dispatch asks the four choices that start the work as a keyboard pass inside that same dialog,
then hands over the ordinary form with the answers set and the caret in the task box:

| Step | Choices | Keys |
|---|---|---|
| **Repo** | every repository in the workspace, seeded from the last dispatch | type to filter by repository name, <kbd>↑</kbd><kbd>↓</kbd> to move, <kbd>↵</kbd> to take the highlighted repository |
| **Kind** | ship, scout, plan, pipeline in a conductor-enabled repository, and chat | <kbd>p</kbd>, <kbd>t</kbd>, <kbd>l</kbd>, <kbd>e</kbd>, <kbd>c</kbd>, arrows plus <kbd>↵</kbd>, or a position digit |
| **Harness** | Claude Code, Codex, Pi | <kbd>c</kbd>, <kbd>x</kbd>, <kbd>i</kbd>, arrows plus <kbd>↵</kbd>, or a position digit |
| **After work** | dispatch default, None, or any active published Workflow | <kbd>d</kbd>, <kbd>n</kbd>, the printed Workflow letter, arrows plus <kbd>↵</kbd>, or a position digit |

A common dispatch is <kbd>+</kbd> <kbd>↵</kbd> <kbd>p</kbd> <kbd>c</kbd> <kbd>↵</kbd>, then
the task. Digits are ordinary filter characters during Repo and position shortcuts in the
three closed lists. <kbd>⌫</kbd> deletes from the Repo filter; in later steps it goes back one
question and un-answers it. <kbd>⇥</kbd> leaves the pass from any step, keeps every answer so
far, and focuses the task box. <kbd>⌘↵</kbd> dispatches from the form as before.

<kbd>Esc</kbd> is progressive from every question: the first press ends the guided pass and
leaves the answers in the ordinary form; a second closes Dispatch. During Repo, the existing
combobox consumes that first press to dismiss its list and the pass ends with it. The three
closed-list questions route the same first press through the dialog.

Guided dispatch is **on by default**. An installation that never chose a value picks it up on
upgrade, while an explicit off choice stays off. The switch in the modal's header is the one
to reach for mid-dispatch. **Settings → Dispatch** is its durable home: it carries the same
checkbox, deep-links at `#/settings/dispatch`, and puts the preference in ⌘K under **Guided
dispatch**, where a search result flips it in place. Both surfaces write one value, so they
cannot disagree.

Nothing moves while it runs. The modal keeps its width and every field keeps its position;
the questions float over the control they are about, the way that control's own dropdown
would, and everything else recedes. A strip under the header carries the answers, each one a
button that goes back to its question, and it leaves when the pass does - so the form you
finish in is the ordinary one.

**The mouse works too, everywhere it looks like it should.** Click an option in the list, or
click an answered rung to go back to it, or ignore the list entirely and use the field's own
control - the question it is about stays live, and using it answers it and moves the pass on
just as the keyboard would. **Clear** puts the form back where it opened, which for a guided
dispatch means back at the first question. The Task box is inert while those questions own
the dialog, but image drops are not: drop an image anywhere on the window and it attaches to
that same Task draft without advancing the pass.

Closing the modal is not an undo. Reopening resumes at the current question with the
answered rungs and form values intact; if the pass already handed over, it reopens on that
completed form without asking the questions again. **Clear** starts the pass over, and a
successful **Dispatch now** or **Add to backlog** starts the next task with a fresh pass.

**It is a different way to fill the form, never a second opinion about what a dispatch
means.** Every answer is written through the same control the form offers, so the rules below
still apply exactly as they are written - including the kind-to-after-work rule, which is why
Kind is asked before After work: by the time that question is on screen a scout, plan, or chat has
already moved the selection to **None**, and the question says so - naming the kind you just
chose - rather than silently landing there.

Two dispatches never run it: editing a task already in the backlog, whose answers exist
already, and **Ensemble**, whose body replaces Crew and After work outright. The switch is not
offered in either - it appears exactly where flipping it would do something, so it is never a
control that saves a preference and visibly does nothing. Settings is its durable home.

## Attaching more than one repository

Some work does not fit in one repo: a contract change and its consumers, a lockstep API
migration, an integration that has to land on both sides at once. **+ Add another repo**
under the Repo field attaches secondary repositories to the task.

One dispatch then produces **one** session, not one per repo:

- Its working directory is the **primary** repo's worktree. Every existing correlation -
  the task/session join, hook and MCP ingest, the report panel - is unchanged, because the
  primary repo stays the task's `repoRoot`.
- Each attached repo gets its **own worktree**, provisioned under that repository's native policy.
  Native slots are detached; disposable Git fallbacks are cut on the **same branch name**, which
  makes the resulting pull requests legible as a single piece of work. A task mixing native and
  disposable providers can therefore hold both detached and named worktrees, so the manifest
  states each repository's branch individually.
- The agent is granted **write access** to all of them at launch: Claude through
  `--add-dir` (and the Agent SDK's equivalent), Codex through its sandbox writable roots.
  The dispatch modal offers the control only for a harness that can hold write access
  outside its own working directory, and the daemon refuses the request for one that
  cannot. Pi does not support it today.
- The task's intent is **prefixed with a manifest**: where each repo's worktree is, which
  one is primary, the branch each is on, and two standing instructions - read each repo's
  own `AGENTS.md`/`CLAUDE.md` before touching it (only the primary's loads automatically),
  and open one pull request per repository actually changed.

Provisioning is all-or-nothing. If any repo's worktree cannot be created, the ones already
taken are handed back - pooled trees returned to their pools, plain worktrees removed - and
the dispatch fails rather than starting an agent with half its repositories.

Two consequences worth knowing:

- **Foreman needs every repo allowlisted.** A multi-repo task is schedulable by the backlog
  autopilot only when *all* of its repositories are in the Foreman allowlist, not just the
  primary. Consent for one project is not consent for another.
- **Multi-repo tasks are dispatch-only.** They cannot be dragged onto an agent that is
  already running. The extra worktrees, and the agent's write access to them, are granted
  when a session launches, and neither harness can widen a running session's write scope.

**Every repository's pull request is tracked separately.** All the urls a `gh pr create`
prints are read, not just the first, and the branch poller asks `gh` inside each attached
worktree as well as the primary's - so a pull request opened in the second repository is
adopted for review and counted for completion exactly like the primary's. The card and the
console show one line per repository, naming that repo's pull request and whether it is open
or merged; a repository with none yet says so rather than being left out.

**A multi-repo task completes only when every repository it CHANGED has merged.** A
repository counts as changed when it has a pull request on this task, or when its worktree's
head has moved off the commit its branch was cut at - the primary included, on the baseline
recorded for it when the task was dispatched. A repo whose branch never moved is exempt and
holds nothing up; a pull request closed without merging never satisfies the rule, so the task
stays visible for you to deal with rather than quietly finishing. `Outcome` then names every
pull request that landed, and the outcome link stays the primary's.

Merging itself is unchanged. Each pull request still merges on its own verdict, whenever it
alone is ready - there is no coordinated cross-repo merge, so siblings can land minutes apart
and the task's own completion is what tells you the whole piece of work is in.

A post-merge retro follow-up copies this exact repository set from its completed source task,
but none of the source worktrees, branches, pull-request bindings, or outcomes. Approved memory
changes therefore open one new pull request per repository changed by the retro, while an
unchanged attached repository opens none. The source task and all of its merged reviews remain
complete and untouched.

**Every repository you changed gets its own full review.** When the session's work reaches a
workflow - the Foreman completion boundary, or your own submit - Mission Control starts one
review run per repository the task changed, and they run at the same time. A repository the
task never touched gets no run at all, and never appears as one. Each run reviews that
repository's worktree, pins that repository's pull request, spends its own repair budget, and
gates that repository's merge and nothing else: a finding in one repository restarts that
repository's review alone, and a review still in progress never holds up a sibling
repository's pull request. Which repositories count as changed is the same rule completion
uses, with one deliberate difference - a worktree nothing has read yet is reviewed rather
than skipped, because shipping unreviewed work is the worse mistake.

The card and the console header then show **one workflow chip per review**, each naming its
repository, so two reviews of one session are never mistaken for one. A single-repo task's
chip is unchanged and carries no repository name.

The one thing the reviews share is the agent's turn. They deliver into one pane, so at most
one of them types into the session at a time and the others queue explicitly until the turn
is free - a queued review says so rather than appearing stalled.

**Model** starts on the default configured for the chosen harness (see [Default
model](#default-model)) and names it, so you can see what the task will run on without
opening Settings. Pick a different one to override it for this task alone - more
horsepower for a gnarly refactor, something cheap and fast for a one-line fix - and the
daemon passes that model through the selected runtime (`--model <id>` in a terminal,
the driver's model option on the Agent SDK). Switching **Agent** resets the model,
since model ids are harness-specific. Leaving the named **Default - …** choice selected
stores no model at all rather than pinning today's, so a task you shelve now picks up the
default in force when it's actually dispatched.

**Effort** sits immediately after Model and follows the same rule: it starts on the
chosen harness's default, can be overridden for one task, and switching Agent resets it.
Terminal-runtime Claude launches with `--effort <level>`; an embedded Claude launch passes
the same selection through the SDK and can change it live. Codex receives the corresponding
`model_reasoning_effort` launch override; Pi receives `--thinking <level>`. Leaving the
named **Default - …** choice selected keeps the task tied to the effort default in force
when it launches.

**After work** can arm any active published Workflow for the task. You can make that
selection and add the task to the backlog while Foreman is off. When the task is dispatched,
Foreman must be enabled and the selected harness must support its completion boundary; the
Workflow is then bound to the session and starts when Foreman reports **Complete**. Set the
machine-wide choice under **Settings → Workflows → Dispatch default** to preselect it for
every new single-agent dispatch. New installations start on the built-in
**No-Mistakes Review** workflow. That default stores the workflow identity rather than today's version, so
each new binding takes the newest immutable version shipped at the time (see
[Built-in workflows](workflows.md#built-in-workflows)) while older bindings stay pinned. The dispatch
form can override that choice for one task, including an explicit **None** that finishes
without a Workflow.

Choosing **scout**, **plan**, or **chat** under **Kind** moves that selection to **None** for
you, because none sets out to deliver a change and so none has a diff for a review Workflow
to run over. Switching back to **ship** hands back the exact choice the switch put aside, so
the reversal loses nothing, including through several diffless kinds in a row where the
selection you started with is what comes back. It is a default rather than a lock: pick a
Workflow after choosing one of those kinds and it sticks, and a choice you make by hand is never
reverted by a later kind switch. This is a behavior of the dispatch form, so it applies to
the kind you pick there and not to the inheriting paths below.

**chat** starts a conversation rather than a delivery. The task box becomes **What would you
like to talk about?**, and that opener is required and delivered exactly as written. A chat
launches immediately from the manual single-agent Dispatch form. It cannot be added to the
backlog, carry dependencies, be created by a Recurring Mission or task source, or be selected
for an Ensemble member. Mission Control adds no task-kind prompt appendix, Mission MCP tool,
artifact, or archive contract.

With **After work** left at **None**, chat completion stays human-ended. Foreman can recognize
that the agent has answered, but it does not offer or send an automatic completion action; the
session stays live for later turns until you choose **Complete**. If you explicitly select a
Workflow, that Workflow follows the same completion boundary and safeguards as other work.

**scout** also changes what "finished" means for that task: a scout is asked, in its own
prompt, to write one self-contained static page at `docs/reports/<slug>/report.html`
and submit it, and it cannot be marked done until Mission Control has captured and verified
that page into a durable [scout archive](archives.md). Its worktree is not reclaimed
until that archive exists either, so the answer survives the checkout. No pull request is
expected, and the conversation is not archived.

**plan** changes what the agent is told, the way scout does, and in the opposite direction. A
plan task's intent arrives exactly as you wrote it, followed by a contract that hands the work
to the [HTML Plans skill](skills-and-settings.md): write the plan at `docs/plans/<name>/plan.md`
with a rendered `plan.html` beside it, ask for the review - and for every open choice in it -
through `request_plan_decisions` rather than in prose, and end that review with the phased
implementation follow-up. Choose it and the phases are written beside the plan and scheduled as
dependency-linked backlog tasks that release when the plan's pull request merges.

The contract **points at** that skill rather than restating it, which is the one place plan
differs from scout in kind and not just in wording. A scout's contract repeats its skill,
because a scout's report is enforced by the archive and had to hold with every skill switched
off. A plan's does not, so **HTML Plans and Phased Plan both have to be switched on** before a
plan can be dispatched. With either one off the dispatch is refused on the form, naming the
toggle and where to find it, rather than launching an agent that would improvise a plan nobody
asked for. Backlogging a plan task is always allowed - the check is asked again at the moment
it launches.

A plan finishes on Foreman's ordinary boundary and is offered the ordinary wrap-up a ship task
gets, so the plan lands as a pull request. That is deliberate rather than incidental: the
scheduled phase tasks carry paths rather than content, and those paths have to resolve on the
default branch before any phase can start.

The plan also **outlives the checkout it was written in**. When anything is about to destroy
that checkout - Reclaim, Remove, Cancel, Reschedule, or the startup pass after a restart the
agent did not survive - the plan directories this task wrote are captured into the
[archive library](archives.md) first, as ordinary files on your machine that stay readable
after the worktree, the task card, and even the database are gone. Which directories those are
comes from the task's own diff, so an unrelated plan sitting in the same checkout is never
swept up. Unlike a scout, nothing about a plan **waits** on that: the task reaches done on its
own boundary, and a plan task that wrote no plan at all releases its worktree cleanly rather
than holding it.

**pipeline** hands the whole run to the enabled external engine. It preselects **None** for
After work because Mission Control has no task worktree or agent completion boundary to hand
to a Workflow. In the guided pass, choosing it completes the pass immediately because the
Harness and After work questions do not apply. A pipeline launch owns one repository, so
choosing it also clears repositories attached while another kind was selected. Its eventual
pull request is still adopted by
[GitHub Inspector](inspector-and-shipping.md#only-our-pull-requests) from the pipeline
projection and appears in Shipped.
The same projected run is also the task's completion boundary: the first child agent proves
the durable task-to-run join for a task created by an older build. New dispatches persist the
provider, repository, and canonical idea slug before their configured Engineer host starts. A
processed exact projection settles either runtime without treating the SDK host or a downstream
child as the completion owner. Opening a pull request concludes the provider run but does not by
itself satisfy declared task dependencies, which retain their merge-only rule.

Once the task has a session, this selection is frozen so the task row and
the already-armed Workflow cannot disagree. MCP-created tasks, task-source sweeps, and
Recurring Missions inherit the same machine default when they create an ordinary task of a
kind those surfaces support.
Internal Ensemble member and replacement tasks opt out because an Ensemble's optional
Workflow belongs only at its final N-to-one handoff.

The repo picker is a **searchable index of your workspace** - the daemon scans
`~/workspace` (override with `MISSION_WORKSPACE_DIRS`) for git checkouts, so you select the
repo to base the task on rather than typing a path. Type to filter; arrow/enter to pick.

It opens on **the repo your last dispatch went to**, since work comes in runs - three
tasks into the same checkout, then a switch - and that's one fewer field to fill in for
every task but the first. The seed is remembered per-machine and survives a reload, and
it moves only when a *new* dispatch is accepted (shelving counts; saving an edit to an
old backlog task doesn't). It's a starting point, not a lock: type or pick another and
that repo becomes the seed instead.

Leave **Title** blank and the daemon names the task for you: a fresh, tool-less Claude call on
Haiku, using the Agent SDK transport by default, summarizes your task text into a few words - "Fix flaky worktree cleanup on Reset",
not the top of your first paragraph. It runs *before* dispatch and the dispatch waits on
it, because the title supplies the git branch and the launched session's name (including a
terminal home name on the terminal runtime), and later task-title edits do not propagate
to either. The card appears immediately under a title taken from your first line and
updates to the model's a beat later. If `claude` is
missing, logged out, or slow, that first-line title just stands - nothing breaks, and the
dispatch still goes.

The new session then shows up on the grid like any other, with an **intent chip** for the
task it is running. A terminal-runtime session stays out of the way until you click
**Focus**; an Agent SDK session has no tab and offers **Continue in terminal** instead.
Choose **Add to backlog** instead of **Dispatch now** to shelve a task without launching
it yet. Chat is the exception: only **Dispatch now** is offered.

That chip states only what the session's own name does not. A dispatch names the session
after its task, so the title is usually already the heading above the chip and is not
repeated inside it; you see it there when the two differ, which is what an agent that has
finished one task and taken another looks like. The **kind** is drawn for every kind except
**ship** - `ship` is the default every dispatch, sweep, Recurring Mission and MCP call
takes, so a badge on every card said nothing, and no badge now means `ship`. A kind you
chose on purpose, including **scout**, **plan**, or **chat**, is worth reading, so it is drawn.

Which means the chip is often not drawn at all, and that is the point rather than an
omission: an ordinary running ship task on the session it named has nothing to add to the
name above it, and an empty tinted bar says less than no bar. It appears as soon as it is
carrying something - a chosen kind, a title the session's name does not hold, the
[recurring-mission](recurring-missions.md) origin mark, the merge outcome, or (on Cards)
a `dispatching…` or `failed` word - and it carries the task's status as its colour
whenever it is there.

The form leads with the brief: repo, then the task composer, with the crew row (Agent,
Kind, Model, Effort) beneath them and one shared hint in place of per-field boilerplate.
**Backlog details** - priority, labels, title, backlog autopilot, and dependencies - fold behind
a summary row that names what is set ("no priority · no labels · title summarized · autopilot
on · no dependencies"), so nothing the draft carries can hide; the fold opens automatically
when you edit a shelved task or the draft already holds one of them. Turn **Allow backlog
autopilot** off before **Add to backlog** to create the task disabled, where Foreman skips it
until you enable or manually launch it. **Dispatch now** still launches immediately.
Dependencies are chips
with a grouped **+ Add dependency** picker rather than a multi-select listbox, and an
unmet dependency raises an amber note beside them as well as renaming the primary button.
The **Single agent / Ensemble** toggle sits in the modal header, since it reshapes the
whole dialog. Chat calls the fold **Task details** and omits dependencies because they would
turn an immediate conversation into backlog work.

**Dependencies** can be selected from tasks already in the backlog and from active
sessions. They are durable scheduling constraints, not notes: if any selected dependency
is incomplete, **Dispatch now** becomes **Schedule after dependencies** and the new task is
forced into the backlog. Every task or standalone active session completes only when its
PR is observed **merged** - and for a task with
[several repositories attached](#attaching-more-than-one-repository), when *every*
repository it changed has; merely opening a PR does not release dependents, and an
ordinary **Mark done** does not either. A dependency edge itself names the prerequisite's
primary repository's pull request, but what releases it is the prerequisite's own
completion, which is the stronger condition. The explicit completion override is the exception:
use it only when the prerequisite's work is already in place (see [Resolve a stopped
dependency](#resolve-a-stopped-dependency)). Active sessions without observable hook
instrumentation are not eligible dependencies because Mission Control cannot distinguish
their next work episode from an earlier merged PR. The board and Sitrep name what a task is
waiting for, and neither manual launch, drag-to-assign, nor Foreman can start it early.
Reopen the backlog task to add or remove dependencies; cycles are refused.

Closing the dispatch form (<kbd>Esc</kbd>, a backdrop click, **Cancel**, or the ✕) **keeps
what you've typed** - reopen and a half-written task is still there, so you can glance at
the grid mid-thought without losing it. The draft is cleared only once the task is actually
dispatched or queued, or when you hit **Clear** to start a fresh one - either way the form
comes back seeded with that repo, not blank. A submit that fails leaves the form open with
your fields intact so you can retry.

The form also reports what **your machine** would hand the agent. A dispatched session
inherits your `~/.claude`, so a third-party plugin whose own setup is unfinished becomes the
dispatched agent's problem - and an unattended one has nobody to ask. Where Mission Control can
see that cheaply, the form says so in an amber note above the buttons, naming the consequence,
the command that fixes it, and the file it read. These notes **never block a dispatch**: unlike
an unmet dependency or an unavailable after-work Workflow, this is a fact about your machine you
may knowingly accept. They are read fresh on every open, so fixing the thing removes the note
without a restart, and a machine with nothing to report shows nothing at all. Today one check
ships, for the UpstartClaw core plugin - see
[Running Mission Control at Upstart](upstart.md#running-mission-control-at-upstart).

### A task's repo is the repo, not the worktree

Every path that files a task - the dispatch form, the MCP
[`create_task`](sessions.md#review-channel-mcp) tool, an edit to a shelved task, a [task
source](#task-sources-pulling-work-into-the-backlog) sweep - resolves what you give it to
the **main checkout**. A linked worktree resolves to the repo that owns it, so an agent
calling `create_task` from `$MISSION_HOME/worktree-pools/<pool>/<slot>` files against the main
checkout that owns it.

That walk-back is what makes the rest of the app agree with itself. A task's repo is what
[Foreman's allowlist](foreman.md#foreman-auto-responder) is asked about before autopilot will
schedule it, and the allowlist names repos you chose - never a pooled tree, which no
operator has ever seen the path of. Store the worktree and the item is in no trusted repo,
so it is passed over on every tick, silently and forever, while the popover's ready count
(which ignores the allowlist by design) still counts it. A pooled tree is also *reclaimed*
and handed to the next agent, so the row would outlive the directory it named.

A root that **cannot** be walked back to a main checkout - a `.git` that points somewhere
with no owning repo, like a submodule or a relocated git dir - is refused rather than
written and never scheduled. HTTP task creation and edits return `400 not a repo's main
checkout` naming the path; task-source sweeps report the same refusal in their result.

### Hand a shelved task to an agent that's already running

On the [Board](ui.md#layout-cards-console-or-board), **drag a backlog card onto an idle
agent with live hook instrumentation** in the same repo and it starts there instead of in
a new worktree. A passively confirmed Codex session can appear in the Idle column without
lighting up as a drop target: the rollout proves its displayed state, but not that the
reset and prompt handover can be observed safely. The task owns no checkout of its own -
the agent keeps the one it had - which is exactly why cancelling it later never runs
`git worktree remove` over a directory the harness didn't create.

**The drop resets that agent's checkout first**, the same reset the card's **reset**
control runs: `git reset --hard` onto origin's default branch, `git clean -fd`, release
the branch, and clear the context (`/clear` for Claude Code and Codex, `/new` for Pi; an
agent that declares no clear command has its context left alone rather than being sent a
command it does not speak). Without it the next task inherits the last one's branch and
context, putting two unrelated tasks in one PR.

So the drop **asks first whenever there's something to lose**: a dialog naming the agent's
queued work items, the branch being released, and the context being cleared, and nothing
happens until you confirm it. An agent with nothing to lose - no work queue, already
detached, which is how a pooled worktree is handed out - takes the task in one gesture,
with no dialog. What the dialog lists is what the daemon saw when it refused, not a second
look, so it can't disagree with what the confirmation then does.

**Committed work is never the thing you're asked about.** If the checkout holds anything
that isn't recoverable from origin - uncommitted files, untracked files, or commits no
`origin/*` ref has - the assign is **refused outright** and the task stays in the backlog
with a line saying what's in the way. Work that's been pushed doesn't block it: a branch
whose commits are on origin under its own ref can be fetched back by name, so an agent
that shipped is still a drop target (which is what a squash-merged PR needs, since the
landed commit has a different SHA and never appears on `origin/main`).

**The agent is renamed after the task it takes**, the way a dispatched one is named when
its session is cut - so a recycled agent's card is titled by its work rather than by
the pooled worktree it was handed out as, or by the task it finished ten minutes ago. The
name is cut to the rules of the backend *this* session lives in, which is not necessarily
the one a fresh dispatch would land on, and an Agent SDK session is renamed the same way it
is from the card - by writing its own durable name. This happens after the task has been
typed, and never fails the assign: if the session can't be renamed (nowhere to put a name, or
the name is already spoken for) the old name simply stands. It applies to [the backlog
autopilot's](work-queues.md#backlog-autopilot-foreman-schedules-the-fleet) assignments too, which
is where a stale name is most confusing - nobody watched that handover happen.

### One agent, one task at a time - but not one task per agent

**An agent runs tasks one after another, for as long as it's alive.** Finish one, take the
next: that's what recycling an agent means, and it's why the drop resets the checkout first.
What it never does is run two at once - the daemon refuses a drop onto an agent that already
has a task executing, saying which one, and the
[backlog autopilot](work-queues.md#backlog-autopilot-foreman-schedules-the-fleet) won't offer such an agent
work either. So an agent becomes available for its next task the moment its current one is
recorded finished, which for shipped work is when [its pull request
merges](inspector-and-shipping.md#when-a-tasks-pull-request-merges) - not when you get round to clicking anything.
Whether that agent is then *closed* is a separate preference (**Settings → Shipping**); by
default it stays, ready for the next drop.

**Each task keeps its own record.** The card shows the task the agent is executing, or the
one it most recently finished until it takes another; the previous task keeps its own
outcome, its own pull request and its own row. That's what makes a day's work on one agent
readable afterwards rather than a single row overwritten four times.

### Edit a shelved task

**Click a backlog task and it opens back up in the form that wrote it** - on the
[Board](ui.md#layout-cards-console-or-board)'s backlog column, by its name in the
[Roundup](attention-and-alerts.md#roundup) panel, or by its title in the Line's
[Backlog drawer](ui.md#the-stage-drawers). Every field is editable, including its dependencies and more
screenshots dropped onto it. Put **Model** or **Effort** back on its named **Default - …**
choice to un-pin it, so the task follows the corresponding harness default when it finally
launches. **Save** keeps it in the backlog;
**Dispatch now** saves and launches it in one go, so a task you shelved half-written can be
finished and sent without a second trip. **Revert** puts back the version the daemon still
holds, and closing the form keeps your edits the same way a half-written dispatch is kept.
**Delete** throws the task away from the same footer, so deciding against a task while you
are reading it does not send you to [Sitrep](attention-and-alerts.md#roundup) to find the
same row again; the card leaves every surface at once. It appears only when you are editing
a shelved task, since a new dispatch has no row behind it to delete, and a removal the
daemon refuses (a task that is running, or one whose worktree will not reclaim) leaves the
form open with the reason in it.
Clear the **Title** and it's derived afresh from the task text as you've now written it.

Above the fields, the form also says where this task stands in relation to the world outside
Mission Control: the issue it was [swept in from](#task-sources-pulling-work-into-the-backlog)
if it came from a task source, or - for a task you wrote here - the one action that files it
upstream as a [GitHub issue](#push-a-task-to-github).

**A save writes only the fields you changed**, so it can't undo work you didn't touch: set a
priority on the card while this form sits open on the same task and your save carries the
title alone, leaving the priority where the card put it. And a kept edit is only kept while
the task itself stands still - if the row changed while the form was closed, reopening it
shows the task as it now reads rather than a picture of how it used to. A task whose **repo
has since gone** - a reclaimed worktree, a project moved - stays editable too; only a repo
you actually change is checked against the [task-root rules above](#a-tasks-repo-is-the-repo-not-the-worktree).

Only *shelved* work can be rewritten. Once a task is dispatched its title has already
supplied the name of a git branch and launched session, so the daemon refuses the edit
rather than let the card drift from what is running - and a task that starts while you
have it open takes the form with it.

Every dispatched task is a durable record (repo, intent, kind, worktree, branch, outcome)
persisted in SQLite, so the backlog and a running agent's intent survive a daemon restart.
Set `MISSION_CLAUDE_BIN` / `MISSION_CODEX_BIN` if the agent CLI isn't on the daemon's PATH.

A restart can also land between accepting a dispatch and provisioning its first worktree.
When the persisted row has no worktree, provider, terminal home, terminal resource, or session,
and every attached repository has neither a worktree nor a provider, Mission Control knows no
agent could have launched: every worktree is recorded before either runtime starts. That narrow
state returns to the backlog with a visible explanation and a normal launch control, and its
next launch starts with a new dispatch timestamp. Once any launch resource exists, recovery
keeps the conservative behavior below instead of assuming whether an agent or checkout survived.

### When a task's agent goes away

Kill a session with <kbd>k</kbd>, close its terminal, or let the agent exit by itself, and
the task it was running **settles as soon as the session is evicted** - roughly eight
seconds, the linger that stops one hiccuping `ps` sweep from burying a live agent. It reads
according to the [merged-PR rule](inspector-and-shipping.md#when-a-tasks-pull-request-merges); without a recorded
merge, it reads `failed`, with `the agent's session ended with no outcome recorded`. Either
way, it drops out of every count that means "executing".

It settles; it is **not** torn down. The worktree, its branch and any terminal home name are
all kept, and the row says so (`its worktree was kept; Clean up or re-dispatch it`). Freeing
a checkout runs `git worktree remove --force` over whatever is in it, so that stays where
every other destructive path in the app puts it: behind the confirmed **Clean up** button on
the row, next to Mark done, which refuses to discard work for the same reason. A task that
never had a worktree of its own - one you handed to an agent that was already running - has
nothing to collect and says nothing about cleanup.

With no recorded merge, `failed` is the honest reading rather than a flattering one: an
agent that finished and exited looks exactly like one that crashed, and the only thing
actually observed is that the session went away without an outcome being recorded. Mark a
task done *before* the agent goes, and that outcome stands - an outcome you recorded is
never rewritten. A `failed` or `cancelled` row is not the last word, though: if its pull
request is later observed to merge, it is
[upgraded to done](inspector-and-shipping.md#a-merge-that-lands-when-nobody-is-watching).

The same reconciliation runs against the first process sweep after a restart, which is what
catches a task whose agent died while the daemon was down.

### Hold a backlog item back

Every backlog row carries an **on/off switch**: turn it off and the
[backlog autopilot](work-queues.md#backlog-autopilot-foreman-schedules-the-fleet) will not schedule that
item - not into a fresh worktree, not onto an idle agent. It's on the board's backlog card
next to the priority picker, on the same row in [Sitrep](attention-and-alerts.md#roundup), and on every row of the
Line's [Backlog drawer](ui.md#the-stage-drawers); all three draw the same control, so you can park
an item from wherever you happen to be reading the list.

**It's a hold on the machine, not on you.** **launch new agent** and dragging the card
onto an idle agent both still start a parked item; the button reads **launch anyway**, the
way it does on an item Foreman thinks is waiting its turn. Blocking a button you pressed
yourself to protect a background scheduler is the worse surprise, and it's the same call
`Max agents` makes.

That works because the switch is enforced in **two** places, and only one of them can be
opted out of. Foreman's scheduling paths never reach a parked item: both use the same ready
list, so neither the fresh-worktree launch nor the assign-onto-an-idle-agent shortcut can
see one. The daemon then refuses `POST /api/tasks/:id/dispatch` and `/assign` for a parked
item **unless the request explicitly claims an override** - which the dashboard's own
buttons do, and Foreman never does.

The refusing default is the point. The Foreman worker is a separate process you start by
hand, so it can outlive a daemon restart; one that predates this feature sends no override
and is stopped, without the daemon having to work out who it is talking to. An external
script or `curl` is refused the same way until it opts in, which is the right default for a
flag whose whole job is to stop unattended launches.

A parked card dims, says `autopilot will skip this`, and drops out of the
autopilot's `ready` count into its own `disabled` one in the Foreman popover - so an
autopilot with nothing to do can say *why* it has nothing to do rather than looking broken.
The Sitrep digest marks the row too (`- "On hold" (ship, disabled) - /repo`).

**Anything that depends on a parked item says so.** A disabled prerequisite reads as
`X is disabled` rather than `after X`, because it will never clear on its own - the same
distinction a cancelled or failed dependency gets, and both now carry their own one-click
fix instead of an investigation (see [Resolve a stopped
dependency](#resolve-a-stopped-dependency)).

**A parked item still takes part in the dependency read**, and keeps its place in the
400-item budget. Leaving it out looks like a saving and quietly breaks the paragraph
above: the planner drops any edge whose target it wasn't shown, so a parked
prerequisite's inferred dependencies would vanish on the next read and everything behind
it would go ready. Holding an item costs one plan entry it won't use, which is much the
cheaper of the two.

Like the rest of the launch configuration, the switch can only be changed while the task
is *in* the backlog; there's nothing left to schedule once it has started.

### Resolve a stopped dependency

A dependency is satisfied when it reaches `done`, or when it leaves the task list
entirely. A **cancelled or failed** prerequisite is neither: it will never finish on its
own, so everything declared or planned to wait on it sits in the backlog forever - the
state the [backlog autopilot](work-queues.md#backlog-autopilot-foreman-schedules-the-fleet) reports as
`blocked` with nothing in `ready`. It is a common way to arrive at a backlog that looks
full and schedules nothing: a prerequisite whose work merged under another PR, and whose
task row was then cancelled rather than marked done, strands every phase behind it.

So a dependent card carries a **warning button** (the danger-tone triangle) whenever a
stopped task is blocking it - **directly, or anywhere up its still-backlogged chain**.
The chain part matters: the card that *declared* the dead edge is not always the one you
are looking at, and a phase three links downstream is just as stuck without knowing why.
The walk stops at a prerequisite that already launched, because its earlier dependencies
no longer gate downstream work. The warning follows the blocked downstream on the board's
backlog card, on the same row in [Sitrep](attention-and-alerts.md#roundup), and on the Line's
[Backlog drawer](ui.md#the-stage-drawers) row, so the fix is reachable from wherever you are
reading the list.

Opening it names the stopped prerequisite and offers two ways out:

- **Reschedule** puts that task back into the backlog to run again
  (`POST /api/tasks/:id/reschedule`) - the "it still needs doing" answer. Only a
  `cancelled` or `failed` task is eligible; the row is reset to a clean, re-enabled backlog
  item (any leftover worktree reclaimed first, as `Clean up` does) so the relaunch is not
  poisoned by a stale outcome or a dead branch. The dependent's block becomes an ordinary
  `after X` wait that clears when the rescheduled work lands.
- **Mark done** records the prerequisite as complete with `satisfyDependents` set
  (`POST /api/tasks/:id/complete`) - the "its work already landed" answer, for the merged-
  under-another-PR case above. It releases the dependents immediately, and is the same
  operator override of the merge gate that [Mark done](#when-a-tasks-agent-goes-away)
  offers elsewhere.

Either action targets the *dead* task, so resolving it once frees every dependent behind
it, not just the card you clicked from.

### Priority and labels

A task can carry a **priority** and any number of **labels**. Both are optional, both
default to nothing, and neither is ever inferred - a task is marked because you marked it.

| Priority | Sorts | Reads as |
|---|---|---|
| **Blocker** | 1st | the only one in the danger colour, outlined so it is findable across a full board |
| **High** | 2nd | |
| **Medium** | 3rd | |
| *(unset)* | 4th | the default - no chip is drawn at all |
| **Low** | last | a deliberate demotion, *below* work nobody has looked at |

That ordering is the one surprising part, and it's deliberate: **unset sorts above Low,
not at the bottom**. `Low` means "I looked at this and it can wait", so it belongs under
work nobody has triaged yet - and a backlog you have never triaged keeps exactly the
oldest-first order it always had.

**Labels** are plain strings, not key/value pairs - `infra`, `flaky`, `Type: Bug`. They're
trimmed, de-duplicated case-insensitively (the first spelling wins, so a tag swept from
another system keeps its case), capped at 32 characters each and 12 per task. The dispatch
form takes them comma-separated and previews the chips you'll actually get, so a trailing
comma or a repeat is visibly a no-op.

The **backlog column** on the board sorts by priority and lets you retriage in place - the
chip on each card is a picker, and changing it re-sorts the column under your cursor. The
Line's [Backlog drawer](ui.md#the-stage-drawers) carries the same picker on its ready rows. The
**Sitrep** shows both marks on every backlog row, and `Copy as markdown` carries them
(`- [blocker] "Fix the thing" (ship) {infra, flaky} - /repo`).

Priority and labels are annotation - nothing is provisioned from them - so they can be
changed at any point in a task's life, including while its agent is running
(`PATCH /api/tasks/:id`). They are deliberately *not* shown on session cards yet: the
card, rail and tile each have their own mark vocabulary and adding a fourth signal to all
three is its own change.

### Harness cards

**Settings → Harnesses** draws **one card per harness** - Claude Code, Codex, Pi - each in
the harness's own accent, holding that harness's default **model** and default **effort**
side by side and a sentence restating what a dispatch of that harness will actually do.
While **Auto mode on dispatch** is enabled, cards whose harness can arm its declared
auto-mode posture through launch arguments or an embedded driver show **auto mode on**; an
excluded harness instead shows **no auto mode**, with the reason available on the badge.
The cards derive from the harness list, so a new harness lights up here as one more card
with no layout change and no stylesheet edit. The master toggle sits above them and selects
each supported harness's declared auto-mode posture. Claude's terminal launch carries
`--permission-mode auto`, while its embedded driver applies the same mode directly. Codex's
embedded driver applies **Approve for me** through app-server; a terminal launch uses
Codex's own widened-sandbox launch treatment instead. Claude's terminal mode is on the
launch argv, not typed in afterwards, so it holds even when a fresh worktree's folder-trust
dialog is still covering the session's mode-line footer.

### Default model

**Each card's model select** sets the model that harness launches on when a
dispatch doesn't name one - one per harness, because a Claude model id is not
something Codex can run. The dispatch form starts on it, so choosing well here is usually
the last time you have to think about models; the per-task picker is for the exceptions.

All three ship as **Harness default**, which means Mission Control passes **no `--model` flag
at all** and the CLI keeps using whatever you configured in the harness itself
(`/model`, `~/.claude/settings.json`, `~/.codex/config.toml`, or
`~/.pi/agent/settings.json`). That's a real setting, not
an empty one - it's how you tell Mission Control to stay out of the way, and you can
always put a card's select back to it.

The default is read **when a task launches**, not when it's created, so changing it also
changes what a task already sitting in the backlog will run on. Like every setting in
this section it applies **only to sessions Mission Control dispatched** - a session you
started yourself and the app merely discovered is never touched.

**A change takes effect on the next dispatch, with no restart.** The daemon re-reads this
config on every launch, and saving it publishes a `harnesses_config_changed` event, so a
second dashboard tab and an already-open dispatch form both re-read the defaults at once
rather than going on naming a model you have moved away from. A session **already running**
keeps the model it launched with - that is deliberate, so a restart cannot change a model
mid-conversation; only the next dispatch picks up the new value.

**Which model wins.** Three tiers, narrowest first:

1. **The task's own model**, chosen in the dispatch form. An explicit choice, so it always wins.
2. **Foreman's per-harness backlog model** (*Settings → Foreman → "&lt;harness&gt; backlog
   tasks"*), which applies **only** to a launch Foreman starts from the backlog. Leaving it on
   the harnesses default is what makes this card govern Foreman's launches too.
3. **This card's default model**, else no `--model` flag at all.

Tier 2 applies to **one launch** and is never written onto the task, so a task Foreman
launched still follows this card the next time it runs - and a rescheduled task carries no
model it was never explicitly pinned with. If a Foreman-launched agent is not using the model
set here, check tier 2 first - that is the setting overriding it.

Every dispatch-time picker reads the same [browser model catalog](harnesses-and-terminals.md#dispatch-time-model-catalogs).
Claude Code and Codex keep the shipped rows from `src/shared/model.ts`. Pi instead mirrors every
model reported by the configured local Pi account, grouped by provider, while the shipped Pi rows
remain its immediate and failure fallback. The browser performs one aggregate read when it loads,
and **Retry Pi models** forces a refresh without polling.

Loading or discovery failure never disables a picker or dispatch. A saved value missing from the
current response, including one set by a newer build or a direct `PUT` to
`/api/harnesses/config`, remains selected as **not currently reported** and still applies. The
catalog explains that it is using a last-known or built-in list instead of treating absence as
revocation.

### Default effort

**Each card's effort select** sets the reasoning level that harness starts
with when a dispatch does not name one. Claude Code and Pi
offer `low`, `medium`, `high`, `xhigh`, and `max`; Codex offers `low`, `medium`, `high`,
and `xhigh`.

All three ship as **Harness default**, so Mission Control passes no effort override and the
CLI keeps its own configured choice. Like the model default, this is resolved when the
task launches: changing it applies to already-shelved tasks unless a task selected its
own effort in the dispatch form.

### Session runtime

**Each card's runtime select** chooses how a dispatched session of that harness is *driven*:
in a **Terminal pane**, or embedded on the **Agent SDK**. New installations use the Agent SDK
for Claude and Codex; Pi stays in a Terminal pane because it has no embedded driver. You can
change either supported harness back to Terminal - see
[Session runtimes](sessions.md#session-runtimes-terminal-or-the-agent-sdk) for what each choice
changes, what it costs, and how to hand a session back to a terminal.

The row renders only for a harness that actually has a driver behind it (Claude and Codex
today); the others say so on the card rather than offering a control that would change
nothing. Like
the model and effort defaults beside it, it is read **when a task launches** and reaches only
the sessions Mission Control dispatches. A stored value this build cannot read, or one naming
a runtime it has no driver for, falls back to Terminal and says so on the card instead of
quietly launching something else.

## Task sources (pulling work into the backlog)

Tasks can be typed into the dispatch form or created through the MCP `create_task` tool.
Meanwhile work already exists somewhere: open issues, a triage board, an on-call queue. A
**task source** reads one of those on a schedule and files what it finds into the
[backlog](#dispatch-an-agent).

**A sweep files backlog rows and nothing else.** It never dispatches an agent, never cuts
a worktree, never resets a checkout and never types into a session. That is what makes
turning one on a much smaller decision than [GitHub Inspector](inspector-and-shipping.md#inspector-automated-pr-review) or
[Shipping](inspector-and-shipping.md#shipping-yolo-mode): the worst a broken source can do is put junk in a list you
then read and delete. The sweep itself never auto-dispatches. Once filed, a task follows the
separately configured [backlog autopilot](work-queues.md#backlog-autopilot-foreman-schedules-the-fleet)
like any other backlog row. That is why each source can turn **Allow backlog autopilot** off
and make all of its future tasks arrive parked for review instead.

Work goes the other way exactly once, and only when you send it: **[Push a task to
GitHub](#push-a-task-to-github)**, from a backlog task's own editor. That is a per-task
click, never something the sweep loop does - see there for why the asymmetry is deliberate.

**[Settings](skills-and-settings.md#settings) → Task sources** (the ⚙ gear, or <kbd>⌘</kbd><kbd>,</kbd>) configures
them, as master-detail: a directory summarizing which sources are healthy, awaiting a current
sweep, paused, or need attention, beside the editor for the one you selected. Search it or
filter by health and source type; the metrics strip above counts the whole set either way.
Add one from the inline form above the list by picking a kind and the repo its tasks should
be filed against; it arrives **switched off**, because adding a source is configuration and
turning it on is consent. Per source:

| Control | What it does |
|---|---|
| **Enable** | whether the background loop sweeps it. Off, it still sweeps on demand |
| **Files tasks against** | the repo swept tasks are based on, resolved server-side so a typo can't enter |
| **Sweep every** | how often, clamped to 1 minute - 24 hours. Default 15 minutes |
| **Most tasks per sweep** | hard cap, default 25. What it drops is logged and reported, never silently truncated |
| **What a swept task looks like** | the agent, kind, priority and labels every task from this source carries, plus whether backlog autopilot may schedule it. Turn **Allow backlog autopilot** off to make new tasks from this source arrive [parked](#hold-a-backlog-item-back) for review; they can still be enabled or launched manually |
| **Sweep now** | run it once, right now, and see what it filed |
| **Check it works** | can this source reach its upstream with the credential it needs, and does its filter run? Each kind checks - and names - its own: `gh` for GitHub issues, the `jira` CLI or a `JIRA_API_TOKEN` for Jira |
| **Forget seen items** | make everything this source has filed fileable again |

Pausing clears the source's previous health, so re-enabling it cannot inherit a stale
healthy result. It remains pending until the next sweep; a manual sweep run while paused
already counts as that fresh result.

### GitHub issues

The first kind, and the shape every other one follows. **Auth is the `gh` CLI**, run inside the repo, so this
feature stores no token, opens no OAuth flow and adds no new secret - if `gh auth status`
works in that checkout, the source works.

| Filter | Meaning |
|---|---|
| **Repository** | `owner/repo`; blank uses the checkout's own `origin` |
| **Labels (any of)** | match issues carrying **any** of these. Blank matches all |
| **Assignee** | anyone / assigned to me / unassigned. One choice, not two switches - "assigned to me *and* unassigned" selects nothing, so it isn't expressible |
| **Milestone** | restrict to one milestone |
| **Issues per sweep** | how many `gh` is asked for |
| **Copy labels** | put the issue's GitHub labels on the task, case intact |
| **Priority from a label** | map a GitHub label to a [priority](#priority-and-labels), e.g. `P0` → Blocker. The first mapped label the issue carries wins |

Each issue becomes one task: its title, and an intent carrying the issue's **URL and body**,
so the agent's first prompt has the actual text rather than a number to go and look up.

**A broken `gh` never reads as "no issues".** A non-zero exit, unparseable output or an
abandoned sweep is reported as an error on the source and shown in the panel - because an
empty sweep and a broken one are otherwise indistinguishable, and the difference is a week
of silence.

### Push a task to GitHub

The one thing that goes **outward**. Open a shelved task in [its own
editor](#edit-a-shelved-task) and, above the fields, **Create GitHub issue** files it as an
issue in the repo a configured GitHub source points at. The task **stays in the backlog**;
what changes is that it now carries a link to the issue, shown in that same spot - which is
also where a task that was *swept in* shows the issue it came from.

The issue carries the task's **title**, its **text** as the body, and one label for each of
the source's **Labels (any of)** filter labels - so the issue this files matches the filter
that would find it, rather than creating work its own source cannot see. Nothing else about
the task goes upstream: not its priority, not its repo path, not its status.

The action appears only when a **GitHub Issues source is configured for that task's repo**;
otherwise the spot says so, and names what to add. There is no sourceless fallback, because
"which repository, with which credential" is exactly what a source already answers. Jira
sources do **not** accept pushes - creating a Jira issue means a project key, an issue type
and whatever fields that project marks required, which is a configuration surface of its own
- so a Jira source is never offered here rather than failing when pressed.

Three rules worth knowing before you press it:

- **A label that does not exist on the repo is a hard failure.** `gh` refuses the whole
  create, and its own message - naming the label - is printed beside the button, which stays
  live. Nothing was published, so fixing the label or the filter and pressing again cannot
  duplicate anything.
- **The issue is never filed twice by the sweep that could see it.** The push writes the
  source's [seen ledger](#a-task-you-delete-stays-deleted) row and the task's link in one
  transaction, so the next sweep of that source skips the issue it just created. As with
  everything in that ledger it outlives the task: push a task, delete it, and no sweep files
  it back.
- **"Check GitHub before retrying" means check GitHub before retrying.** If `gh` never
  reports back - a timeout, a killed process - the issue may exist and there is no way to
  tell from here. That answer says so and **removes** the button rather than disabling it,
  because the only safe next move is to look. A press that was merely *refused* is the
  opposite case and keeps its button. The two are told apart by the daemon, not by reading
  the sentence.

Save your edits first: the issue is composed from the task **as the daemon holds it**, so
the button is disabled (and says why) while the form has unsaved changes.

### Jira

Points at a **JQL filter** and files each issue it matches as one backlog task. Same
contract as the GitHub source in every way that matters: it files backlog rows and nothing
else, it never dispatches, and a task you delete stays deleted.

| Field | Meaning |
|---|---|
| **Jira site** | your Jira Cloud host, e.g. `your-org.atlassian.net`. Paste a whole browser URL if it's easier - it is parsed and reduced to its host. Two refusals guard the credential: a value carrying one (`your-org.atlassian.net@elsewhere.example`) is **refused rather than reduced**, because that string names `elsewhere.example` as the server; and the REST rung will only authenticate to **Jira Cloud** unless you name the host in `JIRA_ALLOWED_HOSTS` (below). Defaults to `upstartnetwork.atlassian.net` |
| **JQL filter** | the query, exactly as Jira's own search bar takes it. **Blank sweeps nothing**, and the panel says so rather than letting it look healthy |
| **Issues per page** | how many issues **one request** asks Jira for. Over REST a sweep keeps asking until the filter is exhausted, so this is a request size rather than a limit on what it finds; over the `jira` CLI it *is* the whole request, because that CLI cannot be asked for a second page (below). What actually gets *filed* is bounded by **Most tasks per sweep** above |
| **Take each task's priority from the Jira issue's own** | maps Jira's priority onto the [task's](#priority-and-labels): Highest/Blocker/Critical/`P0` → Blocker, High/Major/`P1` → High, Medium/`P2` → Med, Low/Lowest/Minor/`P3`/`P4` → Low. A name from a custom scheme leaves the source's default in place rather than inventing one. Off, every swept task takes the source's default |

Everything else a Jira query needs - project, status, assignee, labels, ordering - is
already *in* the JQL, so it isn't re-expressed as controls beside it. One place to say one
thing.

Each issue becomes one task: its summary as the title, and an intent carrying
`Jira issue MC-123: <summary>`, the **browse URL**, and the issue's **description**, so the
agent's first prompt has the actual text rather than a key to go and look up. Descriptions
arrive from Jira Cloud as ADF (a document tree, not a string) and are flattened to the text
a human wrote; anything past 4000 characters is truncated and says so.

**A sweep reads the whole filter, not its first page** - over REST. It pages until the result set
is exhausted, and the [ledger](#a-task-you-delete-stays-deleted) is what stops the next sweep
re-filing any of it, so a queue of 400 issues drains at **Most tasks per sweep** per sweep instead
of stopping after the first page forever. One sweep processes at most **1000 issues** over at most
**50 requests**, whichever it reaches first; a filter bigger than that has a tail no sweep can
reach, so it says so on the source rather than truncating silently.

**The `jira` CLI cannot page, and the source no longer pretends it can.** That CLI ignores the
offset half of its own `--paginate` argument against Jira's search API, so asking for a second
page returns the first one again. This source therefore makes **one** CLI request - asking for one
issue more than the page size, which is an exact test for whether anything follows - and then:

- **fits in one request** → that is the whole filter, and the sweep is complete;
- **more than that, and `JIRA_API_TOKEN` + `JIRA_EMAIL` are set** → the REST rung takes the filter
  from the top and pages it properly;
- **more than that, with no credential** → the request it *did* read is filed, plus a sentence
  saying the tail is out of reach and naming the two ways to change that (set the variables, or
  narrow the JQL). Work still arrives; it is just bounded, and it says so.

**Auth is a ladder, and no rung of it stores a secret.**

1. Your **`jira` CLI** ([`ankitpokhrel/jira-cli`](https://github.com/ankitpokhrel/jira-cli),
   `brew install ankitpokhrel/jira-cli/jira-cli` then `jira init`), if it's on the daemon's
   `PATH`. It already knows your site and your login, so this is the `gh` trade again.
2. Otherwise **`JIRA_API_TOKEN` + `JIRA_EMAIL`** from the daemon's own environment, against
   Jira's REST search API. Both are needed - basic auth is the pair - and neither is ever
   written to Mission Control's database.

If the CLI is installed but can't answer (a common half-configured machine: `jira` on
`PATH`, `jira init` never run, tokens exported for shell helpers), the credential is tried
as a **fallback** rather than the source being declared broken with a working path unused.
When neither works, both reasons are reported.

**Where the token may go is constrained, not just where it comes from.** The REST rung sends
`JIRA_API_TOKEN` in an `Authorization` header, so it will only do that for a **Jira Cloud** host
(`*.atlassian.net`). A self-hosted instance - or anything else - must be named in
`JIRA_ALLOWED_HOSTS` in the daemon's environment, comma-separated, with `*.example.internal`
allowed for a whole domain. Otherwise the source refuses **before making any request** and says so.

That is not only about typos. `PUT /api/task-sources/config` is a localhost route and this daemon
dispatches agents onto the same machine, so a config write is a way to *aim* the credential: a
lookalike host in a pasted runbook, or a prompt-injected agent writing a source, would otherwise
exfiltrate the token rather than merely misconfigure a sweep. **The `jira` CLI rung is unaffected**
either way, because it authenticates with its own configuration and never receives this token - so
a self-hosted Jira reached through the CLI needs no allowlist entry at all.

Two operational notes. The environment is the **daemon's**, read when it sweeps - exporting
the variables in a shell after the daemon started does not reach it, so restart the daemon
(`make restart`) after adding them. And behind a TLS-inspecting VPN the REST rung needs the
proxy's CA in `NODE_EXTRA_CA_CERTS` in that same environment; certificate verification is
never disabled to work around it.

**A broken credential never reads as "no issues".** That is the whole reason `preflight`
exists, and **Check it works** distinguishes, each naming one thing to go and do:

| What it says | What to do |
|---|---|
| `set a JQL query in this source's settings` | the filter is empty - paste one |
| `no way to reach Jira: install the CLI … or set JIRA_API_TOKEN and JIRA_EMAIL` | neither rung is available |
| `JIRA_API_TOKEN is set but JIRA_EMAIL is not` | half a credential, named as the half that's missing |
| `the jira CLI is installed but not configured … run jira init` | installed, never pointed at a site |
| `the jira CLI is not authenticated` / `Jira rejected the JIRA_API_TOKEN / JIRA_EMAIL credential (HTTP 401)` | the credential is wrong or expired |
| `Jira could not run this query (HTTP 400) - <what Jira said>` | the JQL is the problem, not the credential |
| `could not reach Jira at <host> (ECONNREFUSED)` | wrong host, or the VPN/CA above. The code in brackets is the cause - `ENOTFOUND` is a typo'd host, a certificate error is `NODE_EXTRA_CA_CERTS` |
| `the jira CLI did not answer within 20s - it may be waiting for input` | the CLI is prompting, which a background sweep cannot answer. Run it once by hand to see what it wants |
| `the Jira site must be a host, not a URL carrying a credential` | the site names one server and would send the token to another - set it to the host on its own |
| `refusing to send JIRA_API_TOKEN to <host>` | that host is not Jira Cloud and is not in `JIRA_ALLOWED_HOSTS`. Name it there if it really is your Jira; the CLI rung keeps working regardless |
| `this jira CLI does not support --paginate` | too old to be asked for a bounded request at all. `brew upgrade jira-cli`, or set the two variables so the REST rung is used instead |
| `this filter is larger than one sweep can read` | more than 1000 issues (or 50 requests) match, so the tail is unreachable - narrow the JQL |

A sweep reports the same sentences on the source itself, so a failure that happens at 3am
is still legible at 9am - plus two that only a sweep can reach, since they are about paging
and a preflight reads a single page:

| What the source says | What to do |
|---|---|
| `this filter has more issues than the N one jira CLI request returns` | the CLI cannot page (above). The newest N are filed; set `JIRA_API_TOKEN` + `JIRA_EMAIL` so the REST rung can reach the rest, or narrow the JQL |
| `Jira returned the same page again instead of the next one` | a REST cursor that is not advancing - suspect a caching proxy between the daemon and Jira |

The one non-zero exit that is *not* a failure: `jira-cli` exits non-zero to say "no result
found for given query", which is a filter that is simply up to date and stays **healthy**.

### A task you delete stays deleted

Each source keeps its own ledger of what it has already filed, keyed on the item's id in
the external system. **That ledger outlives the task.** Delete a swept task and the next
sweep does *not* re-file it - otherwise the source would be impossible to say no to, and
Delete would be a snooze button that doesn't even snooze.

The way back is deliberate: **Forget seen items** on that source clears its ledger, and the
next sweep files everything again. Removing a source clears it too, so re-adding one
doesn't leave it permanently silent.

One thing a source deliberately does not do: it does not **re-sync** an item that changes
upstream. A sweep files new work; it does not reconcile old work, which would have to decide
what happens when a human has edited the task since. The only write that leaves this machine
is the one you ask for by name - [Push a task to GitHub](#push-a-task-to-github) - and it
creates an item, once, and then leaves it alone. Closing an issue when its task is marked
done is the same reconciliation problem in the other direction, and is not a feature.
