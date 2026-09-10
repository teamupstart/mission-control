# Recurring missions

A **recurring mission** is a durable template that files an ordinary backlog task on a
cadence: "audit dependencies every Monday at 8am". It is deliberately not a
[task source](dispatch-and-backlog.md#task-sources-pulling-work-into-the-backlog) - a source reads an *external*
system and dedupes against what it has already seen, where a schedule is internal state
whose identity is the pair `(schedule, instant)`.

Open **Missions** from the topbar button of the same name, beside Dispatch. The
button carries an attention badge when any enabled schedule needs you (a failed run, an
invalid repo, an overdue instant, a stuck reservation - all derived on the daemon, never in
the browser). The catalog is a wide operator overlay, not a settings category, and it owns
Escape like every other overlay; there is **no keyboard shortcut** for it in V1.

The overlay has three screens:

- **Missions** - a rail to search and filter (All / Healthy / Paused / Attention) the live
  list, and beside it one mission's detail: what it does (its name, its cadence as a
  sentence, and the task every run files), its **spine**, and a Configuration disclosure
  holding the exact stored cron, time zone, policies and task defaults. Its actions are
  Pause/Resume, Edit, Archive, and **Run now** (requests a manual occurrence, paused or not;
  it files a backlog task only when the schedule's policies and safety checks allow, and it
  never runs an agent).
- **Create / edit** - a configuration form (not a compose surface) in five groups: the task
  template, the cadence and time zone, laptop availability, the overlap, missed-run and
  completion guardrails, and preview-and-enable. The template's **After work** names the
  [Workflow](workflows.md) that runs when each generated task finishes, and rests on *None* -
  see [the after-work handoff](#the-after-work-handoff) below. The template's **Agent** may be left on *Inherit*, which
  takes the [task kind's agent](models.md#task-kinds) as each run fires rather than pinning a
  harness here - so repointing that kind moves a mission written months earlier. An inheriting
  mission cannot pin a Model (a model id belongs to one harness) and its Effort offers only the
  levels every harness has, since the one it will get is not known until the run. Readable presets (daily / weekdays / weekly / monthly)
  and an Advanced cron mode both resolve to the same validated five-field expression. The
  preview rail lists the next 10-50 occurrences with local time, UTC and DST shifts, plus a
  non-mutating standby simulation: give it a sleep window and it shows what the missed-run
  policy would do with every instant that came due while the laptop was off. Two explicit
  buttons: **Save paused** stores the configuration without starting the clock, and **Save &
  enable** re-previews the exact definition before enabling it, so a stale preview can never
  enable changed data.
- **Run history** - the spine on its own, for a generated task's deep link into a mission the
  live catalog no longer lists because it was archived. History survives archive.

### The spine

A mission's detail is arranged around **one time axis**, read downward: what has run, where
nothing did, `NOW`, and what is coming. It is composed from reads that already existed - the
paginated occurrence history (fetched on demand, never polled) and the preview enumeration -
so no new daemon route backs it.

Past occurrences carry their real outcome, delay, trigger and generated task, and expand in
place into the immutable audit of every field the ledger persisted. Future instants are a
quiet ladder of dates with only the next one speaking; DST transitions and collisions with
another enabled mission stay flagged. A **paused, archived or unreadable** mission draws no
future at all - the axis stops with the reason, because showing instants a mission will not
act on is the one thing this surface exists not to do.

A generated-task deep link seeks directly to its occurrence and also loads the newest
history page. When those ranges do not yet meet, the axis shows the unloaded interval and
offers **Load missing history** until the ranges connect. Live missions stay in catalog
detail; only an archived mission uses the standalone history screen. Schedule upserts reset
this history window from the server, so large catch-ups and recovered occurrences cannot
leave stale pagination boundaries behind.

Where an instant sat unclaimed, **the rail breaks**: a dashed segment carrying the real
duration and, inside it, the instants the ledger itself says were folded away. A gap is drawn
from persisted columns only (`scheduled_for`, `claimed_at`, `covered_by_id`); nothing infers
whether the machine was asleep, off, or merely stopped, because the database does not record
which. Small mechanical delays do not break the rail - a break is a much louder claim than a
"late" chip, and it is spent only on a window past every delay the local claim path produces.
Throughout, the schedule's own wall clock is the primary reading and UTC is the audit line
beneath it.

Generated tasks carry their origin across the operator task surfaces: a provenance chip or
compact glyph on the Board backlog card, the Sitrep backlog and recent outcomes, the Dispatch
editor (read-only - the provenance is immutable and never part of a task update), and, once a
task is bound to a session, on the session detail, the console detail, the board tile, and the rail. The
mark or its tooltip identifies the schedule (by name while it remains in the live catalog,
otherwise by ID) and scheduled time, and every mark deep-links to that run's history.

Under the screens sits the scheduler - a self-rescheduling loop that accounts for every
crossed instant exactly once, applies the missed-run and overlap policies, recovers both
crash windows around task creation, and files backlog tasks and nothing else - and a
validated localhost HTTP surface:

```text
GET  /api/schedules                        the live catalog
POST /api/schedules/preview                enumerate a cadence, writing nothing
POST /api/schedules                        create (save paused or enabled)
POST /api/schedules/:id/update             apply an edit as a new revision
POST /api/schedules/:id/set-enabled        pause or resume
POST /api/schedules/:id/run-now            request a manual occurrence, paused or not
POST /api/schedules/:id/archive            retire it, keeping its history
GET  /api/schedules/:id/occurrences        paginated run history (includes archived schedules)
```

Every mutation is validated by a shared zod schema and preview accepts the exact save
definition, so the browser cannot preview a cadence the save route would refuse. The catalog
is **live over the existing SSE stream** - a top-level `schedules` collection in the
snapshot, plus `schedule_upsert` / `schedule_remove` events - so it never polls; occurrence
history is the one page-oriented read, fetched on demand. Archiving emits a removal from the
live catalog *after* the durable write, and the archived schedule stays reachable through its
history route so a generated task can still deep-link to it. The plan is
[`docs/plans/recurring-missions/plan.md`](plans/recurring-missions/plan.md); a
sleep/wake dogfood checklist is in
[`docs/runbooks/recurring-missions-standby.md`](runbooks/recurring-missions-standby.md).

Three decisions are worth knowing now, because everything later is built on them:

- **A due instant creates a backlog task and stops there.** No schedule path will dispatch,
  cut a worktree, or type into a pane. If [Foreman](work-queues.md#backlog-autopilot-foreman-schedules-the-fleet)
  later picks the task up, the existing allowlist, dependency, capacity and pane-safety
  gates remain the only autonomous route to execution. The completion policy below does not
  soften this: it lets Foreman close a task Foreman was already running, and no schedule path
  gains a way to start one.
- **The guarantee is durable catch-up, not wall-clock.** The cadence lives in SQLite rather
  than in a timer, so a restart or a closed laptop loses no due instant - but no work runs
  while the machine is asleep, and the task is created *late* when it wakes. The catalog
  will show that delay rather than rounding it off. A real wall-clock guarantee needs an
  always-on host, which is a separate project.
- **One hour is the minimum interval, and seconds are not expressible.** Cadences are five
  cron fields; six-field seconds syntax is refused rather than parsed, and an expression
  whose runs come closer than an hour apart is refused with the cadence it would have had.
  A mistyped field should not be able to file 1,440 agent tasks in a day.

Time is calculated in exactly one place, `src/server/schedules/recurrence.ts`, which is the
only consumer of `cron-parser`. DST behaviour is pinned by fixtures against both US
transitions, Europe/London, and a southern-hemisphere zone, so a dependency upgrade that
moves somebody's 2am mission fails the suite instead.

### What the scheduler does when you were away

Every instant the cadence crossed is enumerated from a cursor kept in SQLite, and each one
gets exactly one durable outcome - it never matters how the machine came to be late, only
what the ledger still owes. Which of them create work is the mission's **missed-run
policy**:

| Policy | A fortnight of daily runs becomes |
|---|---|
| **Coalesce to latest** (default) | one task, for the most recent instant; the other thirteen are recorded as `coalesced`, each naming the run that stood in for it |
| **Create all** | one task per instant, capped at the newest 50 per catch-up - the cap bounds *tasks*, not history, so instants past it are still recorded |
| **Skip** | no task; every crossed instant is recorded as skipped |

Then the **overlap policy** asks whether this mission's previous work is still in flight -
a task in `backlog`, `dispatching` or `running`. **Skip if active** (the default) records
`skipped_overlap` and names the task in the way; **Allow** files regardless. A run that
`failed` never blocks: a mission whose last run went wrong still runs tomorrow.

### The after-work handoff

A mission's template names the **Workflow** that runs when the task a run files is finished,
and it rests on **None**: nothing runs after the task unless the mission says so.

That is deliberately not what an ordinary dispatch does. Dispatch may leave the field on
*Dispatch default* and inherit whatever `Settings -> Workflows` currently names, resolved when
the task is created. A recurring mission fires unattended, on a cadence, for as long as it is
enabled - so inheriting would mean a default chosen in Settings today silently arming a review
over a mission written months ago, on every run, with nobody watching. A mission states its
own answer instead, and the daemon passes it to task creation explicitly so `null` reaches it
as "no Workflow" rather than as an omission.

Three consequences worth knowing:

- **A mission stored before this field existed reads as None.** So does a `POST /api/schedules`
  that never mentions `template.workflowId`. The absent key says its author was never asked,
  and no run should arm a Workflow nobody picked.
- **A kind with no diff cannot arm one.** Scout and Plan set out to produce no delivered
  change, so the control stands down and the saved template holds `null` - a change-review over
  a task that never planned a diff reviews an empty one. Switching the kind back hands the
  previous choice straight back.
- **An archived Workflow is kept, not erased.** A mission naming a Workflow the library no
  longer publishes still shows it in the editor and on its detail, so the next save cannot
  silently convert it into "no handoff". A run that fires meanwhile finishes without one.

### When a run finishes but its task does not

`skip-active` asks whether the previous task is still in flight, and it takes the task's
word for it. That is a problem for exactly the missions this feature is for, because every
route a task has to `done` without a person reads a **merged pull request** - and a run with
nothing to ship never opens one. Sweep the inbox and find it empty; audit the dependencies
and find them fine; write the report and submit it. The work is over, the task is still
`running`, and from then on every occurrence is recorded as `skipped_overlap` naming a task
that stopped doing anything weeks ago. Nothing errors. The mission simply never runs again,
and the catalog goes on calling it healthy.

The **completion policy** closes that:

| Policy | What ends a generated task |
|---|---|
| **Complete the task automatically** (`auto-on-conclusion`) | Foreman's own settled verdict may conclude it, as well as a merge or you |
| **Leave it open** (`manual`) | a merged pull request, or you - the only behaviour before this existed |

"Foreman concluded the run" means one of exactly two of its recorded wrap-up outcomes:
`empty` (the session changed nothing, so there is nothing to commit, push or open a pull
request for) and `retired` (consumed with no wrap-up action - a scout report, a review-only
artifact, another non-shipping settled turn). A `held` verdict is Foreman saying the work is
*unfinished*; `verification_failed` means no model judged it at all; `asked`,
`workflow_claimed` and `direct_handoff` all mean shipping is still under way and the merge
paths still own the completion. None of those conclude anything. The list lives in
`foremanConcludedMission` (`src/shared/schedules.ts`), beside the policy it serves.

Four properties worth knowing:

- **The completion is terminal, and the agent is closed with it.** The task going `done` and
  its session being finished with are one boundary, not two events that happen to follow each
  other. A concluded run's session is asked to stop, it leaves through the same eviction every
  other session leaves by, and it is out of the active-session list within four minutes of the
  completion time on the row. Nothing Mission Control would deliver reaches it in the meantime,
  a prompt typed straight into its pane is normally refused before it starts a turn, and a later
  prompt cannot reopen the task. The pane refusal has stated exceptions - it fails open, and an
  agent whose hooks are not installed never asks - in which case the turn starts and is cut
  short instead. See [when a concluded run's agent goes](#when-a-concluded-runs-agent-goes).
- **The policy that applies is the one the run was filed under.** It is read from the
  immutable revision the occurrence names, not from the schedule's current row, so editing
  or archiving a mission cannot retroactively conclude work already in flight.
- **A run that did open a pull request still names it.** The url is written to the task's
  `outcomeUrl`; its `outcome` text stays Foreman's own sentence, so the row says both what
  concluded it and what it produced. This is the only chance to record either, because
  `completableByMerge` excludes `done`: once the guardrail lands the row, the merge
  reconciler will never revisit it. The `empty` case has no pull request by construction,
  which is the case the guardrail exists for.
- **New missions default to automatic; everything already stored stays manual.** The wire
  default on `POST /api/schedules` is `manual`, so a caller written before this field existed
  keeps saving the behaviour it was written for, and no mission an operator already owns
  changes what it does. The editor's *new mission* default is the other one, because a
  mission written today is one whose cadence is the whole point.

### When a concluded run's agent goes

Completing the task used to be the whole of it, and the agent was left running. For a mission
on an hourly cadence that compounds quickly: the session keeps its runtime and its whole
context, it still counts against the fleet, and it is still promptable - so a follow-up typed
half an hour later reopened a run the operator had already watched finish, on a session that
had outlived its own next occurrence.

So the completion writes a **closure** the daemon owes that session, and keeps it until the
session is actually gone:

- The guarantee is **four minutes from the completion time on the task row** - not from when
  the daemon got around to it - and the session is out of the active-session list by then. An
  exited row may remain in the SDK history; no live session does.
- It is four minutes **of daemon uptime**, and that is a real qualification rather than a
  hedge. Nothing enforces a deadline while Mission Control is not running: a daemon that is
  stopped, asleep or restarting is not closing anything, and after a restart it deliberately
  waits for its first completed discovery sweep before it acts, because until the process table
  has been read a missing session has not been observed to be gone. A closure interrupted that
  way is resumed rather than lost, but it lands late by however long the outage was.
- A stop that was *serviced* is not a session that has *left*. The closure clears only once the
  daemon has observed the session leave, through the same eviction path every other session
  leaves by. Anything short of that is retried.
- **The teardown starts in the request that concluded the run.** Not on a later sweep: the
  agent is asked to stop, and a pane is destroyed, before Foreman's own call returns. So there
  is no interval in which the run is over, the card is still up, and nothing has begun closing
  it - which is the interval the reported failure lived in.
- **A late prompt is refused before it starts a turn.** Refusing delivery covers everything
  Mission Control would send, and that is not everything that can happen: type into the pane
  yourself and none of it applies - which is exactly how a concluded run once took a prompt
  half an hour later and finished another whole generation. So the agent is asked. Claude runs
  a `UserPromptSubmit` hook before it processes anything, and for a session with a closure
  still owed the daemon answers with a refusal: the prompt is not processed, no generation
  opens, and you are told why at your own terminal. The keystrokes landed - nothing can
  un-type them - but no turn begins.
- **That refusal is narrow and fails open.** Only a session the durable closure ledger says is
  owed a close is ever refused, and only `UserPromptSubmit`. A daemon that is down, slow, or
  answers anything unexpected lets the prompt through exactly as before, because every failure
  path returns "carry on" rather than needing to remember to.
- **A turn that starts anyway is still cut short.** Where a pane outlives its first kill - a
  multiplexer that refuses, a driver on its way down, an agent whose hooks are not installed -
  an agent that starts working brings its closure forward to now rather than waiting for the
  next attempt, and the generation does not complete. On the SDK path none of this arises:
  there is no pane, this daemon's own routes are the only way in, and they refuse.
- **A stop that never answers is given up on.** Asking a driver to stop waits for it to go all
  the way down, and a wedged one never answers at all. Each attempt therefore has a bound: past
  it the daemon stops waiting, records the attempt as refused, and carries on to the decision
  below. Without that, one stuck driver would hold the closure open for ever and the escalation
  built for an agent that will not go would be the one thing that never ran.
- **Asking is not the last resort.** A multiplexer can refuse a kill, and a driver can accept a
  stop and then not go. Three minutes in, the daemon stops asking and retires the session
  itself - through that same eviction, so the card leaves and everything keyed on it settles
  normally, inside the four minutes. The refusal is written to the daemon log with the session
  it names. Mission Control can promise you the *session* is gone; if a pane's multiplexer
  genuinely refused to kill its process, that process is no longer something Mission Control
  can speak for, and passive discovery may later re-adopt it as a new sighting. The task it ran
  stays `done` either way.
- It is durable, so **an interrupted or restarted daemon resumes it** - and acts only after its
  first completed discovery sweep, because until the process table has been read a missing
  session has not been observed to be gone. The completion and the closure it owes are written
  in one transaction, so there is no instant at which a run is finished and nothing records
  that its agent still needs closing.
- **While a closure is outstanding it is visible.** The task stays `done` and its row says
  automatic cleanup is retrying and why - including the quiet case, where nothing errored and
  the agent simply did not go - rather than the daemon calling a live agent closed.
- **The checkout is not part of this.** An `empty` run committed nothing, so the worktree may
  hold work; it stays, the ordinary
  [30-day retention clock](worktrees-and-checks.md#task-worktree-retention) owns it, and
  **Clean up** on the task row is still yours. The session's fate never waits on the tree's.

None of it applies to a mission left on **manual**: nothing concluded the run, so nothing is
owed, and the session is yours until you close it.

Two more properties, both deliberate:

- **Pausing accrues no debt.** A resumed mission starts from the resume instant, not from
  the one it was parked on, so a month off does not wake up owing thirty runs.
- **A crash cannot lose or duplicate a run.** The reservation and the id of the task it is
  going to create are written in one transaction *before* the task exists, so a daemon that
  dies mid-run either finds the task already filed (and just closes the ledger) or files it
  on the id it reserved. Neither path can produce a second task.
