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

Foreman reads the backlog's planning head - up to 400 items, including parked ones - to
preserve its dependency graph, then schedules enabled, ready items one at a time: onto an
agent that is already idle when there is one, or into a fresh worktree when there is not -
and never past a ceiling you set on how many agents may be running at once.

## What the human sets

Three knobs, all in the Foreman popover beside the work-queue knobs:

- **Auto-schedule the backlog** (`autoBacklog`, default off).
- **Max agents** (`maxSessions`, default 3, range 1-20). The ceiling autopilot will
  not launch past. It counts **every live agent session on the machine**, not just the
  ones Mission launched - "max agents" is a statement about the machine's load, and a
  count that ignored the six sessions you started by hand would not be one.
- **Open PRs keep an idle agent off the backlog** (`backlogRespectOpenPrs`, default
  on). An idle agent whose branch still carries an *open* PR is not free; a merged PR
  never blocks. Autopilot only - a human's drag onto that agent still works. The why
  lives on the schema field in `src/shared/protocol.ts` and in the README.

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

`planStale`, `blockersFor`, `readyBacklog`, `nextUpTaskId`. `blockersFor` combines
operator-declared prerequisites with Foreman's inferred plan; `declaredBlockers` exposes
the authoritative subset to every manual scheduling route. Shared for the reason
`foremanAllowlisted` is: the scheduler decides with these and the Backlog column
*explains* that decision with them, so a copy that drifted would have the board promise
a launch that never comes - or mark a card ready that the machine will not touch.
`readyBacklog` omits disabled items once for both autopilot action paths.
`plannableBacklog` deliberately retains them in the 400-item read limit: `sanitizePlan`
drops inferred edges whose target was not in its input, so hiding a parked prerequisite
would delete dependencies pointing at it and make its dependents ready on the next replan.
A parked item therefore keeps a plan entry it will not use.

### `src/server/foreman/backlog-machine.ts` - `decideBacklogTick` (pure, no I/O)

Returns exactly one action per tick: `plan`, `assign`, `dispatch`, or `none` with a
reason. Precedence, in order:

1. autopilot off → `none`.
2. backlog empty → `none`.
3. the stored plan does not cover every planning item → `plan` (unless planning has
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
no *open* PR on its branch (`backlogRespectOpenPrs`, on by default; a merged PR does
not block), no non-terminal task already bound to it, the same `repoRoot` as the task,
the same harness the task was filed for (a Codex task is never typed into a Claude pane
unasked, though a human's drag still may), and allowlisted. `TaskManager.assign`
re-checks the ones it can, because a session can go busy between the decision and the
POST - and it now resets the agent's checkout before typing, refusing when the reset
would destroy work (see the README's autopilot section and `agentIsFree`).

### `src/server/foreman/backlog-plan.ts` + `backlog-prompt.ts` - the dependency read

A fresh tool-less `claude -p` (Sonnet by default, `FOREMAN_BACKLOG_MODEL` to override)
is shown every planning item's title, intent, and unresolved operator
dependencies. It returns an order plus an inferred `dependsOn` list per item. Tool-less
for the reason the reviewer is: the prompt embeds task text a human typed, and the model
only needs to emit JSON.

The reply is **not trusted as written**. `sanitizePlan` drops ids that are not in the
backlog, drops self-references, drops dependencies on tasks nobody has heard of,
**breaks cycles**, and **appends any planning item the model forgot**. The last two are
not tidiness: a cycle deadlocks the backlog forever, and a missing entry leaves the plan
permanently stale, which is an infinite replanning loop - both silent.

Operator-declared edges are fixed input to that repair: the model cannot remove or reverse
them, and an inferred edge that would close a cycle against them is cut. Among inferred
edges, only the ones that actually close a cycle are cut, so every other dependency the
model stated survives whatever order it listed the items in. The entries are then emitted
in dependency order.

Planning re-runs only when the plan stops covering the backlog, so a steady backlog
costs nothing. Its time budget SCALES with the backlog (`60s + 20s` an item, capped at
10 min; `FOREMAN_BACKLOG_TIMEOUT_MS` pins a flat one). It has to: the model writes one
entry per task, so the read costs seconds for a handful of items and minutes for two
dozen. A fixed cap is an expiry date, not a tuning value - the original 90s worked until
a backlog grew past it and then failed totally and silently, because a read that never
completes stores no plan, and a backlog with no plan is re-read on every tick and
scheduled never.

Three consecutive failures and the machine stops asking and falls back
to **serial mode**: one task in flight at a time, oldest first, assigns included.
Serial execution is dependency-safe by construction, so a broken planner degrades to
slow rather than to wrong. "In flight" is judged against the SESSION LIST, not the task
row alone: a `running` task is only reconciled when the daemon restarts, so an agent
whose terminal was closed leaves a row that stays `running` for as long as the daemon
lives, and counting it made serial mode a dead end rather than a degradation - one dead
row parked the whole backlog indefinitely. A task with no session yet still counts; that
window is exactly what the cap is protecting. The fallback is a cooldown, not a latch -
after `FOREMAN_BACKLOG_RETRY_MS` exactly one fresh attempt is let through, so a transient
outage heals itself without a hung planner blocking the shared loop for three full-budget
calls per cooldown. A daemon that refuses the plan WRITE keeps its own count and its own
backoff (`FOREMAN_BACKLOG_STORE_BACKOFF_MS`, doubling), since a refused write is not a
broken planner - but at the same cap it causes the same DEGRADATION, so a permanently
broken route schedules serially instead of switching the autopilot off.

One read is ONE model call, over `PLANNABLE_LIMIT` (400) items of the backlog's head,
including parked items. They must stay in the read because `sanitizePlan` drops inferred
edges whose target it was not shown; omitting a parked prerequisite would erase those
dependencies and make its dependents ready. Reading a longer backlog in batches was built
and then removed: the calls run on the Foreman worker's single loop,
which also drives queue drain and needs-you triage, so N batches is N times the span in
which nothing else in the fleet is attended to - the same failure the planner's
one-probe-per-cooldown rule exists to bound, arriving by another door. The limit is held
below `BacklogPlanSchema`'s `.max(500)`, since a plan the route refuses is a write that
fails every time.

Above the limit the tail is unplanned, and `readyBacklog` already answers for it:
unnamed items are unblocked and go last, oldest first. The accepted cost, stated rather
than implied - staleness is coverage, so while the backlog is that long every
dispatch promotes an unplanned item into the head and the next tick spends one dependency
read. One call, only above the limit, against a bounded worst case on the shared loop.

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
`none` does not write a line every four seconds. The acted set is passed INTO the
machine as an input rather than checked against its answer, so a task we have not seen
land skips itself instead of parking the whole backlog behind it.

The daemon is the backstop for the worker-side ready filter. Dispatch and assign both
refuse a parked backlog task unless the request claims `overrideDisabled`; the schemas
default an omitted flag to false. Dashboard launch and drag-to-assign calls claim the
override because they are explicit operator actions. Foreman's client never claims it,
so an older worker that sends a legacy body is refused after a daemon upgrade too.

## What the board shows

`BacklogColumn` gains, from the same shared predicates:

- an **on/off** switch that holds an item out of autopilot while dashboard manual actions
  claim `overrideDisabled`,
- a **blocked** chip on cards with unmet dependencies, titled with what they wait on,
- a distinct **disabled** blocker state when the unmet prerequisite is parked,
- a **next up** marker on the item autopilot would take next,
- **launch anyway** for a card blocked only by Foreman's inferred plan,
- and **waiting for dependencies** with no manual override for an operator-declared
  prerequisite.

The Foreman popover gains the knobs above plus a live `3 / 5 agents` readout and a
`4 ready · 2 blocked · 1 disabled` line, so "why is nothing launching?" is answerable
without reading a log.

## Testing

- `backlog-machine.test.ts` - the precedence table: off, empty, stale plan, assign
  preferred over dispatch, assignment at the ceiling, capacity including mid-provision,
  blocked-only, un-allowlisted, serial fallback, dry-run.
- `backlog-plan.test.ts` - `sanitizePlan` on a two- and a three-task cycle, a self-dep,
  an unknown id, a forgotten entry; `blockersFor` across every dependency status;
  ordering and `planStale`.
- `task-dependencies.test.ts` - declared prerequisites remain enforced across manual and
  automatic scheduling, session disappearance, restart, and PR-merge reconciliation.
- `backlog-plan-http.test.ts` - the plan round-trips through `buildApp`, cannot be
  back-dated, replaces rather than merges, and a malformed body is refused.

## Out of scope

- Autopilot **completing** a task. An agent that finishes still hands its work to the
  existing wrap-up triggers; nothing here marks a task done on its own.
- A hard fleet cap on manual dispatch (see above).
- Cross-repo scheduling coordination beyond honoring declared or inferred dependencies.
