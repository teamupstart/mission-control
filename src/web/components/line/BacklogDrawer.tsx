import { useMemo, useState } from "react";
import type { BacklogBlocker } from "@shared/backlog.ts";
import { backlogIndex, blockersIn, deadBlockersFor, readyBacklog } from "@shared/backlog.ts";
import { backlogTasks } from "@shared/session.ts";
import { PRIORITY_LABELS, TASK_PRIORITIES } from "@shared/task.ts";
import type { BacklogPlan, Task, TaskPriority } from "@shared/types.ts";
import { api } from "../../lib/api.ts";
import { blockedLabel, blockersNeedYou } from "../../lib/backlog-copy.ts";
import { relativeTime } from "../../lib/format.ts";
import { DeadBlockerButton, ScheduleSwitch } from "../session-bits.tsx";
import { Tooltip } from "../Tooltip.tsx";
import { LineDrawer, LineDrawerEmpty } from "./LineDrawer.tsx";

/**
 * BACKLOG - the queue in the order autopilot would take it, and the moves that change it.
 *
 * This stage opened the SITREP for its whole life before now, and the Sitrep is a good panel
 * answering a different question. It reads the whole fleet - who needs you, who is working,
 * what is idle - and carries a backlog section on the way past. The stage above this drawer
 * promises something narrower and much more specific: *what autopilot would take next, and
 * how many are blocked*. That is a claim about ONE list, in ONE order, and the panel that
 * answers it should be the list in that order.
 *
 * Four decisions shape the file.
 *
 *  1. **The daemon's order, not a second one.** The ready band is `readyBacklog(tasks, plan)`
 *     verbatim - plan-entry order first, then the unplanned tail oldest-first - which is the
 *     exact list `backlog-machine.ts` schedules from and the exact derivation the strip's own
 *     sentence is folded from. The head of it IS "next up"; there is no separate marker
 *     computation to drift from the one the board draws.
 *  2. **It reads what the browser already holds.** Unlike Intake and Shipped, this drawer
 *     fetches nothing on open: the task list arrives over SSE and `foreman.backlogPlan` is
 *     already polled every 4s by `useForeman`. A stage click costs one render.
 *  3. **Every action is an existing route, through the existing shared leaf.** Launch is
 *     `dispatchBacklog`, park/resume is `ScheduleSwitch` over `updateTask { enabled }`, and
 *     priority is the same `updateTask { priority }` the board's picker writes. A refusal is
 *     reported on the drawer and the row STAYS, because a triage surface that dropped a row
 *     on a failed call would be lying about the queue.
 *  4. **Three bands, and only the first one gets the ordering levers.** Ready rows are the
 *     ones actually being ordered, so they carry the priority select; blocked and parked rows
 *     carry the one move that would change their state at all - resolve the dead prerequisite,
 *     or flip the switch back on. Offering a priority picker on a row that cannot run whatever
 *     you set it to is a control that answers a question nobody asked.
 *
 * The wider read has not gone anywhere: the footer escalates to the Sitrep in one click.
 */

/** Which band a backlog item is in. Exactly one, so the drawer's counts add up to its list. */
type Band = "ready" | "blocked" | "parked";

interface Row {
  task: Task;
  band: Band;
  blockers: BacklogBlocker[];
  deadBlockers: Task[];
}

/**
 * The whole backlog, partitioned and ordered, from one pass over one index.
 *
 * PARKED WINS OVER BLOCKED when an item is both, and that is the honest way round: a parked
 * item is held back by a switch the operator themselves flipped, which is a fact about them
 * rather than about the graph, and it is the only one of the two they can clear from this row.
 * The row still prints the blocker beside the parked pill, so nothing is hidden - resuming it
 * moves it up one band rather than into the ready list, and it says so before you click.
 */
function partition(tasks: Task[], plan: BacklogPlan | null): Row[] {
  const index = backlogIndex(tasks, plan);
  const ready = readyBacklog(tasks, plan);
  const readyIds = new Set(ready.map((t) => t.id));
  const row = (task: Task, band: Band): Row => ({
    task,
    band,
    blockers: blockersIn(task, index),
    deadBlockers: deadBlockersFor(task, index),
  });
  // `backlogTasks` is priority-then-age, which is the right order for the second band and the
  // wrong one for the first: the ready band's whole point is that it is in PLAN order.
  const rest = backlogTasks(tasks).filter((t) => !readyIds.has(t.id));
  return [
    ...ready.map((t) => row(t, "ready")),
    ...rest.filter((t) => t.enabled).map((t) => row(t, "blocked")),
    ...rest.filter((t) => !t.enabled).map((t) => row(t, "parked")),
  ];
}

/**
 * The header's mono line: `4 ready · 1 blocked · 1 parked`, minus whatever is zero.
 *
 * Zero segments are dropped rather than printed, because this line is read at a glance and
 * `0 blocked · 0 parked` is two facts spent saying nothing. The one zero that DOES need
 * saying - nothing is ready - is said in the amber half instead, where the strip already
 * says it.
 */
function bandCount(rows: Row[]): string {
  const counts: Array<[Band, number]> = [
    ["ready", rows.filter((r) => r.band === "ready").length],
    ["blocked", rows.filter((r) => r.band === "blocked").length],
    ["parked", rows.filter((r) => r.band === "parked").length],
  ];
  const said = counts.filter(([, n]) => n > 0).map(([band, n]) => `${n} ${band}`);
  return said.length > 0 ? said.join(" · ") : "nothing queued";
}

function BacklogRow({
  row,
  nextUp,
  now,
  busy,
  onEdit,
  onLaunch,
  onSetEnabled,
  onSetPriority,
  onReschedule,
  onComplete,
}: {
  row: Row;
  /** True on the one item at the head of the ready band - what autopilot takes next. */
  nextUp: boolean;
  now: number;
  busy: boolean;
  onEdit: () => void;
  onLaunch: () => void;
  onSetEnabled: (next: boolean) => void;
  onSetPriority: (next: TaskPriority | null) => void;
  onReschedule: (deadId: string) => void;
  onComplete: (deadId: string) => void;
}): React.JSX.Element {
  const { task, band, blockers, deadBlockers } = row;
  // Amber down the leading edge only where a person is genuinely the missing part - a dead or
  // disabled prerequisite. Two rows this deliberately does NOT tone, against the mockup:
  //
  //  - waiting on a prerequisite that is still going to finish. That row is LATER, not stuck,
  //    and amber in this app means "you have to do something".
  //  - parked. The switch that holds it was flipped by the operator on purpose; marking their
  //    own decision as an obligation is how a colour stops meaning anything. It dims instead,
  //    which is what the board card does with the same fact.
  //
  // The QUEUE can still be amber while no row is - the header goes amber when nothing at all
  // is ready, which is the strip's rule and a statement about the list rather than any item.
  const needsYou = blockersNeedYou(blockers);
  return (
    <li
      className={`line-bl-row${needsYou ? " is-waiting" : ""}${nextUp ? " is-next" : ""}${
        band === "parked" ? " is-parked" : ""
      }`}
    >
      <span className="line-bl-who">
        {/* The title is the way back into the form that wrote it, exactly as the board card's
            is - triage almost always means rereading the thing before deciding about it. */}
        <Tooltip label={task.intent || `Open "${task.title}" for editing`}>
          <button type="button" className="line-bl-title" onClick={onEdit}>
            {task.title}
          </button>
        </Tooltip>
        <span className="line-bl-meta">
          {[task.kind, task.agent, relativeTime(task.createdAt, now)].filter(Boolean).join(" · ")}
        </span>
      </span>
      <span className="line-bl-marks">
        {/* A STATIC pill, deliberately. It is the head of `readyBacklog` and says so, and
            nothing here explains the choice - the Sitrep and the board say the same word the
            same way. (The autopilot planner replaces this element with its trigger; nothing
            else on the row is its business.) */}
        {nextUp && (
          <Tooltip label="Foreman's autopilot would pick this up next">
            <span className="bl-next">next up</span>
          </Tooltip>
        )}
        {/* Said on a parked row too, not just a blocked one: an item can be both, and a row
            that printed only the pill for the band it landed in would promise that resuming
            it puts it at the front of the queue. */}
        {blockers.length > 0 && (
          <Tooltip label={`Waiting on: ${blockers.map((b) => b.title).join(", ")}`}>
            <span className={`bl-blocked${needsYou ? " is-stopped" : ""}`}>
              {blockedLabel(blockers)}
            </span>
          </Tooltip>
        )}
        {band === "parked" && (
          <Tooltip label="Held back by the switch on this row - autopilot will skip it">
            <span className="bl-off">parked</span>
          </Tooltip>
        )}
      </span>
      <span className="line-bl-ops">
        {/* The way OUT of a dead prerequisite, wherever the row sits: `deadBlockersFor` walks
            the chain, so this appears on rows whose own blocker chip says a plain "after X". */}
        <DeadBlockerButton
          deadBlockers={deadBlockers}
          busy={busy}
          onReschedule={onReschedule}
          onComplete={onComplete}
        />
        {/* The priority control IS the mark, never a read-only chip with an editor beside it -
            the board card settled this argument and the reasoning carries: two of them meant
            the same task said "BLOCKER" and "Blocker" inches apart. Ready rows only, because
            priority orders the queue and these are the rows in it. */}
        {band === "ready" && (
          <span className={`bl-prio${task.priority ? ` prio-${task.priority}` : " is-unset"}`}>
            <Tooltip label={`Priority for "${task.title}" - decides where it sits in the queue`}>
              <select
                aria-label={`Priority for ${task.title}`}
                value={task.priority ?? ""}
                disabled={busy}
                onChange={(e) => {
                  const next = e.target.value;
                  // "" clears the field back to unset; null is what the API takes for that.
                  onSetPriority(next === "" ? null : (next as TaskPriority));
                }}
              >
                <option value="">priority</option>
                {TASK_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABELS[p]}
                  </option>
                ))}
              </select>
            </Tooltip>
          </span>
        )}
        {/* Park and resume are ONE control and it is the shared one, so the switch you flip
            here is the switch you see on the board and in the Sitrep. A pair of Park/Resume
            buttons would have been a second affordance for a write that already has one. */}
        {band !== "blocked" && (
          <ScheduleSwitch
            enabled={task.enabled}
            taskTitle={task.title}
            busy={busy}
            onChange={onSetEnabled}
          />
        )}
        {band === "ready" && (
          <Tooltip label={`Dispatch "${task.title}" into a fresh worktree, ahead of the queue`}>
            <button type="button" className="btn" disabled={busy} onClick={onLaunch}>
              {busy ? "launching…" : "Launch now"}
            </button>
          </Tooltip>
        )}
      </span>
    </li>
  );
}

export function BacklogDrawer({
  /** EVERY task, not just the backlog: dependencies point at tasks that already left it. */
  tasks,
  /** Foreman's reading of the backlog, or null when it has none. */
  backlogPlan,
  /** Injected so every relative age is a pure function of props, as on the other drawers. */
  now,
  onClose,
  onEditTask,
  onOpenSitrep,
}: {
  tasks: Task[];
  backlogPlan: BacklogPlan | null;
  now: number;
  onClose: () => void;
  onEditTask: (taskId: string) => void;
  onOpenSitrep: () => void;
}): React.JSX.Element {
  // Per-task rather than one flag for the panel: two rows are two decisions, and a switch
  // that went inert because somebody launched a different task reads as a broken control.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(() => partition(tasks, backlogPlan), [tasks, backlogPlan]);
  const ready = rows.filter((r) => r.band === "ready");
  const held = rows.filter((r) => r.band !== "ready");
  const nextUpId = ready[0]?.task.id ?? null;

  /** Run one row's mutation, holding that row inert until it lands and reporting a refusal. */
  async function act(
    taskId: string,
    write: () => Promise<{ ok: boolean; error?: string }>,
    fallback: string,
  ): Promise<void> {
    setBusy((open) => new Set(open).add(taskId));
    const result = await write();
    setBusy((open) => {
      const next = new Set(open);
      next.delete(taskId);
      return next;
    });
    // Cleared on success, so one recovered failure does not leave a stale complaint over a
    // queue that is now moving.
    setError(result.ok ? null : (result.error ?? fallback));
  }

  const rowProps = (row: Row): Parameters<typeof BacklogRow>[0] => {
    const id = row.task.id;
    return {
      row,
      nextUp: id === nextUpId,
      now,
      busy: busy.has(id),
      onEdit: () => onEditTask(id),
      onLaunch: () =>
        void act(id, () => api.dispatchBacklog(id, true), "could not dispatch that task"),
      onSetEnabled: (next) =>
        void act(id, () => api.updateTask(id, { enabled: next }), "could not change that"),
      onSetPriority: (next) =>
        void act(id, () => api.updateTask(id, { priority: next }), "could not set that priority"),
      // Both dead-prerequisite resolutions target the DEAD task, never the row they were
      // reached from: fixing it releases every dependent, not just this one. The BUSY key
      // stays this row's, because this row is the one whose controls are waiting.
      onReschedule: (deadId) =>
        void act(id, () => api.rescheduleTask(deadId), "could not reschedule that task"),
      onComplete: (deadId) =>
        void act(id, () => api.completeTask(
          deadId,
          "Marked done from a blocked dependent - its work is already in place.",
          undefined,
          true,
          true,
        ), "could not complete that task"),
    };
  };

  return (
    <LineDrawer
      stage="backlog"
      count={bandCount(rows)}
      // The strip's own amber rule, to the word: a backlog with items in it and none of them
      // ready is a queue that capacity will never clear, which is the one backlog state that
      // needs a person.
      attention={rows.length > 0 && ready.length === 0 ? "nothing ready" : ""}
      notice={error ? <p className="line-drawer-alert" role="alert">{error}</p> : null}
      onClose={onClose}
      footer={(
        <>
          <span className="line-drawer-foot-note">
            Blockers across the whole fleet, and what every agent is doing, live in the Sitrep.
          </span>
          <Tooltip label="Open the Sitrep - the whole fleet, its reviews, and the backlog with its blockers">
            <button type="button" className="btn btn-ghost" onClick={onOpenSitrep}>
              Sitrep <span aria-hidden>→</span>
            </button>
          </Tooltip>
        </>
      )}
    >
      {rows.length === 0 ? (
        <LineDrawerEmpty>
          Nothing is queued. Dispatch files a task here when you shelve it instead of launching
          it, and Intake's sources and recurring missions file their own.
        </LineDrawerEmpty>
      ) : (
        // Two LISTS and no visible captions over them, which is a deliberate departure from
        // the mockup's "Ready · plan order" / "Blocked · parked" headings. The frame caps this
        // body at exactly three rows and says why: the cap lands on a row boundary so that no
        // half-row peeks over the edge. Two 22px captions inside that budget leave 2.2 rows
        // showing, and the sliver reads as a broken panel rather than a capped one - which is
        // the one thing the cap exists to avoid. The bands are still said, in three places
        // that cost the body nothing: the header counts them, every row wears its own state
        // as a mark, and each list is NAMED for a reader who cannot see either.
        <>
          {ready.length > 0 && (
            <ul className="line-drawer-rows" aria-label="Ready, in the order autopilot would take them">
              {ready.map((row) => <BacklogRow key={row.task.id} {...rowProps(row)} />)}
            </ul>
          )}
          {held.length > 0 && (
            <ul className="line-drawer-rows" aria-label="Blocked and parked">
              {held.map((row) => <BacklogRow key={row.task.id} {...rowProps(row)} />)}
            </ul>
          )}
        </>
      )}
    </LineDrawer>
  );
}
