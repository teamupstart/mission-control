# Plan: Backlog autopilot - Foreman schedules the backlog

Status: implemented
Owner: ai-harness
Related: [`../foreman-watcher/plan.md`](../foreman-watcher/plan.md) (the tier ladder and
the queue drain this mirrors), [`../dispatch/plan.md`](../dispatch/plan.md) (the backlog and
the two ways work reaches an agent).

## Goal

The backlog is a list of things you want done and a board that shows you idle agents
next to it - and nothing closes that gap but your hand. Foreman already drains a
*session's* work queue; this drains the *fleet's* backlog.

Foreman reads the whole backlog, works out which items depend on which, and then
schedules one at a time: onto an agent that is already idle when there is one, or into
a fresh worktree when there is not - and never past a ceiling you set on how many
agents may be running at once.

## What the human sets

Two knobs, both in the Foreman popover beside the work-queue knobs:

- **Auto-schedule the backlog** (`autoBacklog`, default off).
- **Max agents** (`maxSessions`, default 3, range 1-20). The ceiling autopilot will
  not launch past. It counts **every live agent session on the machine**, not just the
  ones Mission launched - "max agents" is a statement about the machine's load, and a
  count that ignored the six sessions you started by hand would not be one.

`maxSessions` deliberately does **not** block *your* dispatches. Refusing a button you
clicked because a background scheduler reserved the budget is a worse surprise than
briefly exceeding it; autopilot simply stops launching until the fleet comes back under
the line.

## Why the Foreman, and why live-only

Launching an agent is not free and not silent: it cuts a worktree and starts a process
that will write code unattended. Handing a task to an *existing* agent is stronger still
- it types a whole prompt into a pane a human may be sitting in front of.

So autopilot clears the same bar an auto-wrap-up does, and for the same reason:

- Foreman `enabled`, and `autoBacklog` on.
- Mode is **live**. In `dry-run` and `semi-auto` autopilot still **plans** - it works
  out the dependencies and marks what it would do next on the board - but it never
  launches or types. Dry-run means dry-run.
- The task's `repoRoot` is on the **repo allowlist**, judged with the shared
  `foremanAllowlisted`, so the board explains the decision with the same predicate the
  server gates on.

## Architecture

Four pieces, in the shape the queue drain already established: a shared vocabulary, a
pure decision machine, a model call, and a worker that only does I/O.

### `src/shared/backlog.ts` - the predicates both sides read

`planStale`, `blockersFor`, `readyBacklog`, `nextUpTaskId`. Shared for the reason
`foremanAllowlisted` is: the scheduler decides with these and the Backlog column
*explains* that decision with them, so a copy that drifted would have the board promise
a launch that never comes - or mark a card ready that the machine will not touch.

### `src/server/foreman/backlog-machine.ts` - `decideBacklogTick` (pure, no I/O)

Returns exactly one action per tick: `plan`, `assign`, `dispatch`, or `none` with a
reason. Precedence, in order:

1. autopilot off → `none`.
2. backlog empty → `none`.
3. the stored plan does not cover every backlog item → `plan` (unless planning has
   already failed its cap, see below).
4. walk ready items in plan order; the first one with a genuinely free agent in its
   repo → `assign`.
5. otherwise the first ready item, if the fleet is under `maxSessions` → `dispatch`.
6. otherwise `none`, saying which of those it was.

Assignment is checked before capacity on purpose: it consumes no new session, so it is
correct at the ceiling and cheaper below it.

**Capacity** is `live sessions + tasks mid-provision`. The second term is the one that
matters: a task that has been dispatched but whose agent has not been discovered yet is
an agent, and counting only the session list would launch a second one into the gap.

**A free agent** is a stricter thing than an idle-looking one: `reportBucket === "idle"`,
`settledIdle` past the settle window, `hooksSeen` (an autopilot that cannot observe a
session must not type a whole task into it), a pane to type into, an empty work queue,
no non-terminal task already bound to it, the same `repoRoot` as the task, and
allowlisted. `TaskManager.assign` re-checks the ones it can, because a session can go
busy between the decision and the POST.

### `src/server/foreman/backlog-plan.ts` + `backlog-prompt.ts` - the dependency read

A fresh tool-less `claude -p` (Sonnet by default, `FOREMAN_BACKLOG_MODEL` to override)
is shown every backlog item's title and intent and returns an order plus a `dependsOn`
list per item. Tool-less for the reason the reviewer is: the prompt embeds task text a
human typed, and the model only needs to emit JSON.

The reply is **not trusted as written**. `sanitizePlan` drops ids that are not in the
backlog, drops self-references, drops dependencies on tasks nobody has heard of,
**breaks cycles**, and **appends any backlog item the model forgot**. The last two are
not tidiness: a cycle deadlocks the backlog forever, and a missing entry leaves the plan
permanently stale, which is an infinite replanning loop - both silent.

Planning re-runs only when the plan stops covering the backlog, so a steady backlog
costs nothing. Three consecutive failures and the machine stops asking and falls back
to **serial mode**: one autopilot dispatch at a time, oldest first. Serial execution is
dependency-safe by construction, so a broken planner degrades to slow rather than to
wrong.

### `src/server/backlog.ts` + routes - where the plan lives

`app_config` under `backlog.plan`, read through a zod parse so a corrupt or older value
degrades to "no plan" rather than to a bad schedule. `GET`/`PUT /api/backlog/plan`,
because the Foreman worker never touches the DB.

### The worker

One fleet-level step per pass, above the per-session targets - the backlog is about
sessions that do not exist yet, so it has to run on a pass where no live session wants a
tick. It does I/O only: read, ask the machine, perform the one action, log.

Two guards live in the worker rather than the machine because they are about *this
process's* recent history, not about the state of the world: a 60s `recentlyActed` set
so a laggy read cannot double-launch a task, and a change-only logger so a steady
`none` does not write a line every four seconds.

## What the board shows

`BacklogColumn` gains, from the same shared predicates:

- a **blocked** chip on cards with unmet dependencies, titled with what they wait on,
- a **next up** marker on the item autopilot would take next,
- and, for a blocked card, its Launch button reads as the override it is.

The Foreman popover gains the two knobs plus a live `3 / 5 agents` readout and a
`4 ready · 2 blocked` line, so "why is nothing launching?" is answerable without
reading a log.

## Testing

- `backlog-machine.test.ts` - the precedence table: off, empty, stale plan, assign
  preferred over dispatch, at-capacity, blocked-only, serial fallback, dry-run.
- `backlog-plan.test.ts` - `sanitizePlan` on a cycle, a self-dep, an unknown id, a
  missing entry; `blockersFor` across every dependency status; `planStale`.
- `backlog-routes.test.ts` - the plan round-trips through `buildApp` and a bad body is
  refused.

## Out of scope

- Autopilot **completing** a task. An agent that finishes still hands its work to the
  existing wrap-up triggers; nothing here marks a task done on its own.
- A hard fleet cap on manual dispatch (see above).
- Cross-repo dependencies. Items in different repos are independent to the scheduler;
  the planner may still say one waits on another, and that is honoured.
