# Foreman (auto-responder)

The dashboard tells you *who needs you*; **Foreman** can start draining that queue for
you. It's an optional agent that watches the `needs-you` bucket and, for each blocked
Claude Code or Codex session it has both [been invited
into](#which-sessions-foreman-may-act-in) and can drive, reads the transcript to understand
the goal **and the session's terminal screen to see the ask itself**. Foreman then:

- **auto-answers** the routine calls - implementation trade-offs (defaulting to the most
  correct, secure, non-duplicative option) and non-destructive access requests;
- **escalates** the genuine forks - a call that hinges on your intent, or anything
  destructive/risky - as a framed **decision brief** with its recommendation, and pings you;
- writes a 1-2 sentence **Purpose** on every session it inspects - the recent context
  bearing on *this* decision, shown in the session detail. It reads the session's
  [Goal](sessions.md#goal) rather than re-deriving it, so the two don't say the same thing twice.

The screen matters more than it sounds: a prompt that is *waiting on you* - a menu, a
permission dialog - isn't written to the transcript until it returns, so the transcript
routinely ends **before** the very question Foreman is there to answer. Reading the pane is
what lets it answer the ask rather than hand it back to you having only read the history.

The screen is also *how* a menu gets answered. A dialog isn't a text box: it discards typed
characters, and the Enter that follows them confirms whichever row was already highlighted -
the default, not the reply. So Foreman answers a menu the way you would, by walking the
cursor onto the row it picked and pressing Enter only while the pane still shows that row
selected. An answer it can't pin to a row on screen is **escalated to you** - with its
reasoning kept as the recommendation - rather than typed at a menu that would discard it.
You get the same affordance for the same reason: a menu on any session is offered to you as
[clickable rows](sessions.md#answer-a-sessions-menu-from-the-dashboard) too, and whichever of you
reaches it second is refused rather than pressing the wrong row. Because a visible menu puts
a session in `needs-you` on its own, Foreman can pick up a Claude session parked on one that
no hook has reported yet: Claude's hooks are machine-scoped, so the visible menu supplies the
missing state without crossing a launch boundary. That gap is real and measurable: Claude
reports `AskUserQuestion` as *work in progress* when the menu opens and only says it is
waiting for you about six seconds later, so an ask caught in between used to be handed
straight back to you as "no reply channel", with an answer Foreman had already written. The
menu's own rows identify the ask, so one question costs one review however the hooks land.
Codex hooks are launch-scoped instead: an operator-started Codex menu remains available as
clickable rows for you, but is explicitly excluded from Foreman automation.

### Which sessions Foreman may act in

**Foreman only participates in sessions it was invited into.** Hooks answer whether Foreman
*can* drive a session; the invite answers whether it *may*, and the two are not the same
question. Claude installs its hooks machine-wide, so every personal Claude chat on your
machine reports one - which is not consent, and used to be read as consent.

A session is invited when any of these is true:

| Invite | Which sessions |
|--------|----------------|
| `sdk` | **Embedded** sessions. Mission Control runs them, so they are invited by definition. |
| `dispatch` | **Dispatched** terminal sessions. Recorded automatically once the spawn is confirmed. |
| `operator` | Sessions **you** invited, explicitly. |
| *(none)* | Everything else - every session merely discovered on your machine, and any session whose invite you withdrew. |

In an uninvited session Foreman does nothing at all: no Purpose note, no decision brief, no
queue tick, no wrap-up prompt, no pull-request follow-through, and no backlog assignment. It
does not appear in the top bar's queue-depth count either, so the badge only ever counts work
Foreman will actually pick up. The daemon enforces this a second time at the boundary it
owns: a Foreman-marked write into an uninvited session is refused outright, so a stale or
misbehaving worker cannot reach a pane it was never invited to.

That same boundary yields to a person composing a reply. Foreman does not post while any
dashboard send box for the session is focused, or until one minute has passed since the
person last edited that box. Human and Workflow messages are unaffected.

None of this touches what **you** can do. Messaging a session by hand, dragging a task onto
it, and answering its reviews yourself are unchanged and are never invite-gated - an invite
governs the background loop, not your own hands.

An **operator invite grants everything except backlog assignment**: triage, wrap-up, and
pull-request follow-through, but the autopilot still hands whole new tasks only to `sdk` and
`dispatch` sessions. Inviting Foreman to help with what a session is *already doing* must not
read as permission to start something else in it.

#### Inviting and withdrawing

The far-right slot in a session's detail tab strip is the control, and it has one meaning at
a time:

| The slot reads | The session is | Clicking it |
|----------------|----------------|-------------|
| **＋ Invite foreman** (purple) | uninvited | invites Foreman, with no confirm step |
| **Foreman intent** | invited, nothing decided yet | opens Foreman's drawer |
| **Foreman · N** | invited, with N decisions | opens the same drawer, on the history |

**Withdraw invite** lives in that drawer's header, beside its close control - the record of
what Foreman has been doing here is where you decide it should stop. Withdrawing works on
*every* session, embedded ones included, and it survives a restart. Re-inviting restores
whatever the session would have had on its own: a withdrawn embedded session goes back to
`sdk`, backlog eligibility included, rather than being permanently downgraded to `operator`.
The one residue is a withdrawn *dispatched terminal*, which re-invites as `operator` until
its next dispatch.

An uninvited session says so rather than going quiet: its work queue and any Foreman note
left behind explain that Foreman is not in this session and point at the rail. An exited
session shows no invite control at all - there is nothing left there to invite it to.

Both are also plain routes, if you would rather script it: `POST
/api/sessions/:id/foreman-invite` and `DELETE /api/sessions/:id/foreman-invite`, neither
taking a body.

> **On upgrade:** invites begin empty, so terminal sessions already running when you upgrade -
> including ones Mission Control dispatched earlier - start **uninvited**, and Foreman goes
> quiet on them. Re-dispatching restores the invite automatically, or invite them from the
> rail; embedded sessions are unaffected.

Each session is reviewed in a **fresh headless model call**, using Claude's Agent SDK transport
by default, so context never bleeds between reviews. Foreman ships **enabled but inert**, and the distinction is the whole point:
it starts in **dry-run**, its repository allowlist starts empty, and its worker is a separate
process the packaged app supervises. So on a fresh install Foreman types nothing, sends nothing
and runs nothing - it *drafts* answers onto the session detail until you trust it. `enabled` flipped on
because it is a prerequisite gate rather than an action: while it shipped off, a **Foreman
Complete** workflow binding could not be created at all, which left
[the repair loop](workflows.md#the-repair-loop-end-to-end) unreachable on a fresh install no matter what
you configured in Workflow settings. If you have ever switched Foreman off in Settings, that
answer is persisted and survives - the new default only reaches installs that never answered.

The packaged desktop app starts and supervises the worker automatically. In a source-only
development stack, start that plain HTTP-only process with:

```sh
npm run foreman
```

Control it from the **Foreman** control in the top bar (beside Alerts): enable it, then
pick a mode.

| Mode | What it does |
|------|--------------|
| **dry-run** (default) | drafts a reply onto the session detail; never sends |
| **semi-auto** | drafts a reply with a one-click **Approve & send** on the session detail |
| **live** | sends the reply on your behalf - but only in repos you've **allowlisted** |

Live sending is gated by an explicit **repo allowlist**, granted in
**Settings → [Trust](skills-and-settings.md#trust-who-may-act-in-which-repository)** (the Foreman panel shows the
count and links there). With an empty allowlist Foreman never types into any live session. In
Live mode the popover shows a read-only **Live in N repos · manage in Settings →** link
straight to it. An entry allowlists the **repo**, not just the directory: a session in a
*worktree* of an allowlisted repo is cleared too, wherever that worktree sits on disk.
That's what makes live mode usable: dispatched agents and native pooled checkouts run in
worktrees parked far from the repo, so a directory-only rule would draft forever on the
very repo you cleared.
A worktree of a repo you haven't allowlisted is still refused. A separate
**Auto-approve non-destructive access** switch (on by default) governs whether it may
approve access/permission asks - turn it off and those escalate to you instead.
Destructive or risky asks (force-push, secret access, prod deploy, data drops, disabling a
safety check) are **always** escalated, never auto-approved.

The same allowlist gates unattended backlog launches across every repository attached to a
task. When a running Live Foreman with backlog autopilot on lacks one of those grants, the
task's Board, Backlog drawer, and Sitrep rows name what is missing and link to the Trust
matrix; [manual launch remains available](dispatch-and-backlog.md#resolve-missing-repository-trust-for-autopilot).

Everything Foreman does surfaces where you're already looking. When an agent's ordinary
review form already owns the decision, Foreman does not draw a second answer card or an
**Approve & send** path beside it. Instead the option its recommendation names wears a
**◆ Foreman's pick** mark, so which one it chose reads at a glance, and the form gets a
closed **View Foreman recommendation** control for the reasoning behind that pick. Opening
it shows Foreman's prose in a bounded sidecar. The marked option is never preselected, and
the original form remains the only place that can send an answer. When Foreman's prose names
no offered option, nothing is marked and only the control appears. If Foreman raised an
unrelated decision,
the separate note stays visible because its marker names a different ask. An escalation also
fires a browser **alert**. The top-bar chip shows the mode, whether the worker is running, and
the queue depth.

For a draft or escalation that has no canonical review form, the session detail keeps the existing
**◆ decision** or **✎ draft** flag. Its expanded note carries the brief, recommendation and
the applicable **Approve & send / Dismiss** controls. An answered session carries a
`✓ Foreman answered: …` audit line.

Foreman's completion checks use the session detail's [durable Goal](sessions.md#goal), while its latest tactical
focus remains separate.

**A dispatched `ship` task is judged at the boundary Mission Control gave it.** Foreman hands
the verifier the task kind's completion contract as trusted policy beside the durable Goal:
implementation, required repository documentation, focused verification and evidence
registration are what "complete" means on the first delivered turn, while commit, push,
pull-request creation, review follow-through and CI are explicitly deferred to whoever owns
completion next. So a Goal that also says "open a pull request" is satisfied when the
implementation is, because that clause was deferred - and nothing else about the bar changes.
The contract comes from the task's durable `Kind`, never from transcript prose, so personal
sessions and every other kind are judged exactly as before. See
[work queues](work-queues.md) for the whole prompted path.

For a dispatched `ship` task, that verifier also receives the session's registered Workflow
evidence from the current resolved intent episode. Mission Control states the registered count,
kind, generation, timestamp and size as trusted structure; session-chosen names, file locators,
and captions remain inside the untrusted evidence fence. Evidence from an older work
generation remains usable within the same intent episode, while legacy unstamped evidence and
evidence from another episode are excluded. A zero count explicitly leaves the evidence-registration
clause unsatisfied; a nonzero count is not automatic approval, and the verifier still judges whether
the items cover what the task requested. If the implementation is complete and every blocking gap
only says verification proof is unavailable, registered same-episode evidence lets Foreman claim a
`foreman_complete` Workflow anyway. The Workflow runs the authoritative checks; a Manual binding,
no binding, no registered evidence, an incomplete verdict, or any other blocking gap still holds.
Command evidence uses an opaque public locator, so a raw command with inline credentials cannot
enter the staging API or Foreman prompt; the exact command remains in its bounded captured artifact.

**Each consumed completion records why it stopped.** The queue row carries the current
generation's outcome - `held`, `workflow_claimed`, `asked`, `direct_handoff`, `retired`,
`empty`, or `verification_failed` - with a bounded summary and, for a hold, its blocking gaps.
New decisions also carry the intent episode and consecutive held round. Each persisted gap keeps
its verifier kind, severity, and strike count, so the next completed generation in that same
episode can show the verifier which demands have already survived a recovery turn. A legacy
decision without episode metadata remains readable but feeds no verifier history.
It is written by the same statement that consumes the generation, and replaced by the next
one; the Foreman episode ledger below remains the history of what Foreman *did*.

**Pre-PR recovery applies only to invited, task-owned `ship` sessions.** Its popover
switch, **Keep pre-PR ship tasks moving**, defaults on, but permission is still the intersection
of Foreman enabled, **Live** mode, a trusted repository, a current running or dispatching managed
ship task, an explicit Foreman invite, a drivable hook-instrumented session, and a completed
settled-idle work cycle. A human ask, a work-queue item, a pending turn, an active Workflow, or
any open task-owned pull request in any attached repository wins and makes the shepherd hold.
The first quiet window is **20 minutes** by default and is configurable from 1 to 1440 minutes
under **Settings → Foreman → Safety**.

When prompted completion records a real held verdict for an eligible managed ship task, Foreman
does not wait for that first quiet window. It claims recovery through the same daemon-owned ledger
and relays the reviewed blocking-gap payload in the same worker pass. This immediate route uses the
existing **Keep pre-PR ship tasks moving** switch and every ownership, delivery, live-mode, and
repository-trust gate above. A task-less session or any session a human owns remains silent. The
quiet-window shepherd is unchanged and remains the backstop when immediate delivery could not be
claimed or reached no pane.

Known states use structural instructions: relay the verifier's held gaps, resume an empty
checkout, or continue an already-authorized direct shipping handoff whose pull request did not
appear. Only an idle checkout with ambiguous non-empty changes starts one fresh tool-less Review
model call. Its output is checked again against the pre-PR authority boundary and may request
implementation, documentation, tests, or evidence only. It cannot authorize commit, push,
pull-request creation, merge, cleanup, another task, another repository, or an answer for the
human. A repeated verification infrastructure failure escalates without a recovery send.
Transient reviewer or evidence failures claim no recovery attempt. They are recorded on the
session, retried after a one-minute cooldown, and escalate after three consecutive failures.

Foreman claims each exact recovery in the daemon before typing. A held-gap first send is immediate;
other first sends wait for the configured quiet window. Sends two and three retain the fixed
**40-minute** and **80-minute** intervals. After the third
send the next due pass records a visible escalation and types nothing. A confirmed non-delivery
releases the same attempt for retry; an unknown delivery remains spent so a lost response cannot
become a duplicate send after restart. Every attempt and escalation uses the existing session
drawer and fleet decision ledger, where its reason, attempt, delivery result, next wait, quiet age,
and completion context remain inspectable. The shepherd stops permanently for that task as soon
as any task-owned pull request is observed; ordinary PR follow-through owns the later phase.
The three-send budget belongs to the task, logical conversation, intent episode, and recovery
reason. Work-cycle generations remain part of each delivery marker, so markers are still exact
per-delivery idempotency keys, but a hold-deliver-hold cycle in one episode advances the existing
budget instead of starting again at attempt one. A newly accepted human prompt creates a new
episode, retires the old gap history, and starts a fresh budget.

**Settings → Foreman** groups its durable controls into four tabs: **Posture** for the cheap
tier, **Models** for the provider and four Foreman roles, **Launches** for the three
per-harness task-agent launch models, and **Safety** for the completion safeguards and pre-PR
recovery threshold. Each tab shows how
many settings it holds, and each field's explanation appears on hover or focus - as the
control's tooltip and accessible description - rather than printing under the field. The
current Foreman posture stays above the tabs so a stopped worker is always visible. **Live
repositories** and **Right now** stay below them as read-only cards; the repository card
shows the grant count and links to **Settings → Trust**, where repository access is edited.
The read-only **Standing guidance** card reports its current source and links to the single
editor at **Library → Personas → Foreman**. Settings does not fetch or write that document.

Two default-on safeguards under **Settings → Foreman → Safety** decide which
finished work never reaches an automatic completion action:

- **Skip automatic completion for Scout tasks** uses the task's durable `Kind`. A Scout is
  retired once its findings are ready, without showing Ship it, running No-Mistakes Review,
  or typing the Straight-to-PR instruction.
- **Skip automatic completion for mockups and review artifacts** recognizes explicit output
  contracts such as `Output: mockups`, natural-language requests for reports, plans, research,
  wireframes or prototypes, and completed diffs containing only conventional artifact paths.
  Mixed contracts that also request source code, tests, components or another implementation
  action still follow the configured completion path.

The safeguards are independent. A task matching either one is retired while that switch is
on; turn a switch off to let that class of work use the ordinary **Trigger on → Then** action.

**A `chat` task with no explicit Workflow always stays human-ended.** Foreman may recognize
its completion boundary, but it retires that automatic pass without offering or sending a
shipping action. The agent remains available for another conversational turn until you choose
**Complete**. Explicitly selecting a Workflow in Dispatch opts that chat into the ordinary
completion path, including the review-artifact safeguard above.

**A `plan` task is exempt from the second safeguard**, and only from that one. Its objective
says "write a plan" and its diff lands entirely under `docs/plans/`, so it would match both
halves of the review-artifact test and be retired - which is the wrong answer for this kind. A
mockup is produced *for* a review and then discarded; a plan is a durable document whose
landing on the default branch is what releases the phase tasks depending on its paths. So a
completed plan task reaches the ordinary **Ship it / Straight to PR** handling a ship task
gets. The exemption is keyed on the durable `Kind`, so a **ship** task that produces only
mockups - or only plans - is judged exactly as it was before.

In the [Console and Board](ui.md#layout-console-or-board-in-settings) detail, a standalone Foreman
decision is arranged differently because a permanent conversation gives it somewhere better
to sit: the note is rendered **in the transcript**, as a turn at the point it spoke, and what
you still *owe* is a one-line strip above it. When the same ask already has a normal review,
that strip and the matching live transcript entry yield to the review's optional recommendation
control instead, so the conversation never presents two simultaneous decisions about one ask.
The complete episode remains available in **Foreman · N** history. A standalone strip unmounts
once its note is answered or dismissed; its inline entry stays.

**Answering the question yourself retires the note.** A pinned decision is a claim on your
attention, and answering the ask spends it: the agent is unblocked and the suggestion answers
a closed question. So submitting the agent's own form, picking a row on its menu, or
answering, approving or dismissing its review clears the note as part of the same action -
no second click on **Dismiss**. It is matched to the *ask*, not to the session, so an
escalation raised about something else - a session stuck with no reply channel - stays put
and stays yours. The decision is kept in the **Foreman · N** history as one you closed
without using Foreman's answer, exactly as pressing **Dismiss** always recorded it.

**Approve & send** appears only where there is somewhere to send it. A note Foreman escalated
*because* it had no reply channel offers **Dismiss** and says so - the alternative was a button
that silently closed the note, which reads as having sent something. The same sentence covers a
question resolved somewhere the daemon cannot see it, such as a reply typed straight into a
tmux pane; a resolution that goes through the dashboard retires the note outright. Foreman also re-checks the
session before pinning a decision at all: a review takes up to a few minutes, and if the
session moved on in that time the decision is filed in the **Foreman · N** history instead of
waiting for a click on a question that has already closed. Those decisions are recorded as
**stale** rather than as skips - Foreman had an answer, and the clock beat it.

Every decision is also **kept**, which the note alone never was - a note is one upserted row,
so each write erased the last one and approving erased the words that had just been sent.
Foreman now records each decision it faces: the question the session was blocked on, what it
concluded, and what actually went back. That question is the part worth recording - for a
terminal ask (a permission prompt, a menu) the child's screen is the only place it ever
exists, per the transcript gap above. The **Foreman · N** rail at the end of the detail's tab
row opens that history: rows lead with the *ask* rather than the verdict, and opening one
shows the ask verbatim beside Foreman's reasoning and the resolution, credited to whoever
actually made the call. Records age out after a retention window.

That drawer also starts with **Current intent**, even when Foreman has made no decisions yet.
It shows the completion objective and version, the latest tactical focus, the latest
relationship or reconciliation state, and Foreman's rationale. This is the inspectable source
for what Foreman currently believes the session is trying to finish; the rows below it remain
the decision history.

Only one worker drives the sessions at a time. A manually started worker beside the packaged
app is safe: the second process acquires no **lease** and idles as a standby, taking over automatically if the
leader dies. That matters because two workers would double-answer a prompt - or, with work
queues below, type the same work instruction into a live agent twice.

### Its standing instructions (`FOREMAN.md`)

Foreman ships with a built-in judgment policy, which is deliberately generic. Beside it sits a
second, editable half: **standing instructions** written in plain prose, telling it how *you*
want these calls made. They are read into every review, every work-item verification, **and the
[cheap tier](#the-cheap-tier)** - that last one matters, because the cheap tier answers routine
permission asks on its own and never escalates them, so instructions it couldn't see would be
silently skipped on the highest-volume path in the system.

The defaults ship as [`personas/FOREMAN.md`](../personas/FOREMAN.md), under the app root beside the
rest of the [persona documents](../personas/) - ordinary markdown you can read and edit. Write what
you would say if you were looking over its shoulder:

```markdown
## What I care about, in order
1. Correctness, then simplicity, then maintainability. Development cost is nearly last.
2. One abstraction over N special cases. If the options all amount to repeating an
   implementation per case, ask for a single unified API instead of picking one.

## Judging whether work is done
Hold these as **blocking**, not advisory:
- A bug fix with no end-to-end reproduction.
- A capability that did not update `README.md` in the same change.
```

Two things make these different from the `AGENTS.md` / `CLAUDE.md` that Foreman *already* reads:

- **They are direction, not evidence.** The standards docs reach the verifier fenced as material
  to judge, and a finding against them is `advisory` - so it never sends an agent back for
  another round. These reach it as instructions to follow, so they are the only way to say "this
  particular thing is not done until X" and have it actually block.
- **They can only raise your bar, never lower it.** They can make Foreman more careful -
  escalate something it would have answered, demand more before calling work finished, weigh a
  trade-off your way. They cannot authorize a destructive action, widen what it may approve on
  your behalf, retire an escalation rule, or dictate the literal text it sends to a session. That
  division is deliberate: prose shapes *judgement*, while the switches above grant *authority*,
  each with its own confirmation and its own repo allowlist. A sentence in a text box should not
  do a switch's job.

With no instructions the section renders as nothing at all, and a test pins that adding them
changes only that block, leaving the rest of every prompt byte-for-byte identical.

Edit the document at **Library → Personas → Foreman** or open
`#/library/personas/foreman` directly. The fixed System profile exposes only the
operator-owned prose. Foreman's name, description, built-in policy, safety checks, output
contracts, provider/model settings, operational posture, and repository authority remain
application-owned or link to their existing Settings and Trust controls. Foreman is not a
workflow or ensemble Persona.

The source readout distinguishes three durable states:

- **Built-in default** uses the exact `personas/FOREMAN.md` shipped with the app.
- **Customized** uses the exact stored Markdown, even when it happens to equal the default.
- **No standing guidance** is an intentional empty save. It does not fall back to the default.

Save uses compare-and-swap against the loaded ETag. A focus refresh adopts a newer clean
document, but preserves a dirty local draft and reports a conflict. **Reload latest** takes
the newer saved text; **Keep editing** preserves every local character and rebases the next
explicit Save on the known current ETag. Copy and Download always use the local draft,
including during a conflict. **Reset to built-in default** is a separately confirmed
operation, not an empty save, and restores the shipped document. The browser and route share
the 64,000 JavaScript-character ceiling with the server contract.

Each Foreman evaluation captures the effective standing guidance once when it starts. A save,
clear, or reset affects later evaluations; work already in flight finishes with the document
it captured. This prevents one evaluation from mixing two revisions while still making the
next call observe the operator's latest choice.

### Which model Foreman runs as

Foreman spawns a fresh, tool-less headless call for four different jobs, and each one picks its
own provider **and** its own model. Both live on
**[Settings → Models](models.md#foremans-four-roles)**, with every other call this app makes on
your account - Foreman's own panel keeps a pointer to them and nothing else. Run Review and Verify
on one account and the two cheap calls on another, or leave a row on *Inherit* and let it follow
the **All roles** row above it, which in turn follows the app-wide provider default when it is unset. An
environment variable set in the daemon's shell is not silently dropped anywhere on that ladder.

The separate **Launches** tab did not move and does not control any of those calls. It chooses the
models of task agents Foreman starts from the backlog, which is unrelated to the model that reads
dependencies.

Claude uses one fresh Agent SDK query by default; [`MISSION_CLAUDE_TRANSPORT=print`](configuration.md)
keeps the one-shot `claude -p` path available as an operator-pinned escape hatch.

| Call | Default | Config key | What it does |
|---|---|---|---|
| Review | `claude-opus-5` | `reviewModel` | Judges a stuck session's pending question - answer, escalate, or leave it |
| Verify | `claude-opus-5` | `verifyModel` | Reads the diff and decides whether a queued work item is done |
| Triage | `claude-haiku-4-5` | `triageModel` | The [cheap tier](#the-cheap-tier)'s Tier 1 router - buckets the ask, never solves it |
| Backlog | `claude-sonnet-5` | `backlogModel` | Reads the [backlog](work-queues.md#backlog-autopilot-foreman-schedules-the-fleet) once per change and says what depends on what. It supplies edges, never position - [the order is yours](dispatch-and-backlog.md#the-backlog-order-is-the-one-you-set) |

Each field resolves the same way - the full ladder, and what changing a provider does or does not
clear, is in [Models](models.md#foremans-four-roles): **your setting, then the environment
variable, then the shipped default**. Clearing a field means "fall back", not "run with no model" - so emptying the
box hands the decision to `FOREMAN_REVIEW_MODEL` (or the default), it never spawns the CLI
without a `--model`. The panel prints which of the three is in force, because an environment
variable set in the daemon's shell outranks the box and would otherwise be invisible from the
browser.

Any id the selected provider's CLI accepts works - the fields are free text, not a fixed list.

Codex structured calls pass the same provider-neutral JSON Schema used by Claude through
`codex exec --output-schema`. The schema is written to a private temporary file for that one
run and removed on success, failure, spawn error, or timeout.

That schema is rendered **strict**: every object lists every one of its properties in
`required` and sets `additionalProperties: false`, at every depth. Codex hands it to strict
Structured Outputs, which rejects anything less with `invalid_json_schema` and fails the whole
call rather than degrading it. A field that is semantically optional stays optional by being
nullable instead of absent, so the model can still decline it - it answers `null`, which the
reading side treats exactly as it treated a missing key. Nothing is forced to be invented. Codex still runs ephemeral,
read-only, without command tools or approvals. If `codex exec` exits nonzero, Foreman keeps a
bounded reason from Codex's JSON failure event rather than dropping stdout or exposing the
stream's agent messages, which can contain operator task text.

> Before this existed, Review and Verify passed no `--model` at all and silently inherited
> whatever the CLI happened to be logged in as. If you relied on that, set the two fields to
> match it; otherwise they now pin to Opus explicitly.

### The cheap tier

Not every blocked session needs the expensive reviewer, so a **cheap tier** sits in front of
it and spends the big model only where judgment is actually required. **Tier 0** is pure code
and costs nothing: a plan/diff review is always yours to approve, so it's disposed with a
Purpose and no model call at all. **Tier 1** is a cheap router (Haiku) that reads a trimmed
transcript and *buckets* the ask rather than solving it. Only the genuine judgment calls route
up to the full **Tier 2** review, which is unchanged.

The tier is **asymmetric on purpose**. It may hand a session back to you (skip) or ask you
(escalate) freely, but it may auto-answer only one tightly bounded category - routine,
non-destructive access - and that answer flows through the *same* mode + allowlist +
auto-approve gate the full reviewer's answers do, so it can never send under a looser config
than Opus would. Five code backstops the router cannot override sit behind it: the destructive
denylist above forces an escalation, low confidence routes up, a window with nothing to scan
counts as *unknown* rather than safe and routes up. The fifth is delivery: the router never
names a menu row, so its answer to a permission prompt (which is a menu) routes up to the full
reviewer that can name one, rather than putting every routine approval in front of you.

Pick the posture with the **Cheap tier** control in **Settings → Foreman**:

| Cheap tier | What it does |
|------|--------------|
| **on** (default) | the cheap tier disposes the easy cases; the full review fires only on route-up |
| **shadow** | runs the cheap tier *alongside* the full review, acts on the **full review**, and **records** every divergence - so its accuracy is measured before you trust it |
| **off** | every new prompt gets a full review (the pre-tier behavior) |

**on** ships as the default because **shadow** is the measurement posture, and a default is
the wrong place for one: it is the most expensive of the three - two concurrent model calls
per decision, one of which cannot act by construction - and it only pays for itself if you
come back and read the divergence column. Pick **shadow** when you want that number for your
own fleet; the safety envelope is the same either way, because a cheap-tier answer passes
through the same mode + allowlist + auto-approve gate the full reviewer's answers do. An
install that already has a posture saved keeps it - this default is read only where nobody
ever chose.

**Shadow's measurement is in the panel**, in the decisions ledger's *Cheap tier* column.
The panel shows that column only while **shadow** is selected, because that is the only
posture that takes a second measurement. Each measured row carries what the cheap tier
would have done and how that compared, and `cheap-over-eager` - after applying the same
delivery gate as **on**, the cheap tier would have answered where the full review would
not - is called out in red. That is the number to watch before flipping to **on**, and it
is the whole reason the posture exists. Within the column, **off** rows stay blank because
they made no cheap call, **on** rows stay blank because the cheap tier was the decision
rather than a second opinion, and rows recorded before this shipped stay blank because no
measurement was persisted. None of those blanks is reported as agreement.

The tier that produced the verdict is reported separately, and honestly: under shadow it
is always the full review, because that is the verdict that acted.

The worker log carries the same thing for anyone watching one session live: every acted
session logs the tier that decided it (`[tier 2] answer/access -> answered (sent)`), and
shadow mode adds a divergence line per session (`shadow cheap-over-eager (cheap=… opus=…)`).

### What Foreman has been deciding

**Settings → Foreman** carries the fleet-wide **decisions ledger**: every prompt Foreman
has faced, across every session, newest first. Each of these was already being recorded;
until now the only way to read any of it was one session at a time, through that session's
Foreman drawer, so there was no answer anywhere to *what has this thing actually been
doing* - which is the question you open its settings to ask before giving it more rope.
The count strip above the table filters it: **escalated**, **drafted**, **answered**,
**left alone**. The last 100 decisions are shown, and episodes are kept for 30 days, so the
list reaches back only as far as the cap allows - 25 rows to a page, walked with **Newer**
and **Older**, in the [same table](inspector-and-shipping.md#dry-run) the GitHub Inspector and Shipping panels use.

A row leads with **what the decision was for**, not with what was literally asked. The
verbatim ask is not an identity - `Needs approval: Bash` and `running AskUserQuestion` cover
most of a busy ledger between them - so Foreman's own one-line reading of the ask carries the
row and the literal text sits under it as the recognition cue.

Beside the outcome, each row says **why the tier ladder landed there**: `needs judgment`,
`low confidence`, `human-only, risky`, `no recent turns`, `no menu row named`, `routine
access`. The cheap tier has always computed this and only ever logged it; escalated *because
the router was unsure* and escalated *because the ask looked destructive* are two different
stories, and the ledger could previously tell only the word they share. Hover for the full
sentence and the string that was recorded.

**Outcome says what actually happened**, which is finer-grained than the four dispositions
the tiles group by. `skipped` used to cover three unrelated events, and on a real ledger the
majority of it was neither of the two you would guess:

| Outcome | What it means |
| --- | --- |
| **answered** | A reply was delivered - by Foreman, or by you approving a draft. |
| **drafted** | Foreman wrote a reply and is holding it for your confirmation. |
| **escalated** | Handed to you, and nobody has answered it yet. |
| **declined** | Foreman judged the call yours and left it alone. |
| **stale** | Foreman *reached a verdict* and the session moved on before it could be delivered, so nothing was sent. A race, not a judgment - the verdict it reached is still on the record. |
| **dismissed** | Foreman escalated it to you, and you closed it without answering. |

The last three all file under the **left alone** tile, which is what they have in common:
nobody ever answered them.

**Open a row** for the whole decision - the ask verbatim, the child's screen as Foreman read
it, the reviewer's brief and recommendation, and what was actually sent back, credited to
whoever made the call. That is the same card the session drawer shows, fetched one decision
at a time: the ledger itself ships a **summary**, with each ask reduced by the daemon to the
one line the table shows, so the captured terminal screens - by far the largest thing in the
table - never ride the 4-second poll.

The rows scroll **inside** the table rather than running down the page, so the count strip
stays reachable while you read the list it filters.

The panel also states, in words, **whether Foreman is running at all**. A worker holds a
lease and renews it; when nothing does, Foreman is enabled, set to whatever mode you chose,
and nothing is executing it - a state that until now looked exactly like a quiet fleet.
That reading outranks the mode in the posture line, because a mode nothing is running is
not the fact you need first. The live figures beside it - sessions needing you, when the
last decision was, the backlog autopilot's budget, and the dependency planner's effective
provider, model, health, and failure count - are under **Right now**, and are
deliberately a different population from the historical ledger above. When backlog
autopilot is off, the planner row says **idle (autopilot off)** instead of presenting its
last circuit snapshot as an active degradation.

The top-bar Foreman popover carries the actionable version of that planner status inside
**Backlog**. A degraded planner names its last bounded error and the next automatic retry.
**Retry planner now** rearms one immediate probe without restarting Mission Control. Changing
the effective Foreman Provider or Backlog model also clears the old provider's strikes and
forces an immediate probe, even when the stored plan still covers the backlog. A failed
probe returns to the same serial safety fallback; recovery is reported only after a fresh
plan is successfully stored.

Turning Foreman on, its mode, the work queues and the on-drain action stay in the topbar
Foreman control: those are the things you reach for while watching the fleet, and the
panel is the durable posture.

### Mechanical pipeline triage

**Settings → Conductor → Foreman triage** is a separate, default-off permission for external
pipeline halts. Both it and Foreman's master switch must be on when the halt is read, when its
episode is reserved, and when the provider action is sent. The worker may call the existing
pipeline action route only for a halt whose class is exactly `mechanical`; today that action is
**Unpark**, which releases the feature for the engine to retry. Every `needs-human`,
`protected-artifact`, `legacy`, `unclassified`, or unknown class stays in the Attention inbox
for you.

This permission does not put pipeline tasks into backlog autopilot and does not grant DECIDE
re-entry. Foreman reads the daemon's halt view and posts its episode and action over HTTP. The
daemon remains the only SQLite writer, and each attempted provider action is reserved in the
decision ledger before the engine is called so a lost response cannot cause a duplicate act.
