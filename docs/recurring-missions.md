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
  completion guardrails, and preview-and-enable. The template's **Agent** may be left on *Inherit*, which
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

Three properties worth knowing:

- **The completion is an inference, and it is reversible.** It is recorded the same way
  `settleIfEpisodeFinished` records one, so an agent that starts working on that very task
  again reopens it. Foreman concluding a generation is strong evidence, not proof.
- **The policy that applies is the one the run was filed under.** It is read from the
  immutable revision the occurrence names, not from the schedule's current row, so editing
  or archiving a mission cannot retroactively conclude work already in flight.
- **New missions default to automatic; everything already stored stays manual.** The wire
  default on `POST /api/schedules` is `manual`, so a caller written before this field existed
  keeps saving the behaviour it was written for, and no mission an operator already owns
  changes what it does. The editor's *new mission* default is the other one, because a
  mission written today is one whose cadence is the whole point.

Two more properties, both deliberate:

- **Pausing accrues no debt.** A resumed mission starts from the resume instant, not from
  the one it was parked on, so a month off does not wake up owing thirty runs.
- **A crash cannot lose or duplicate a run.** The reservation and the id of the task it is
  going to create are written in one transaction *before* the task exists, so a daemon that
  dies mid-run either finds the task already filed (and just closes the ledger) or files it
  on the id it reserved. Neither path can produce a second task.
