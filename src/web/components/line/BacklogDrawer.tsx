import { useMemo, useState } from "react";
import type { BacklogBlocker, BacklogIndex } from "@shared/backlog.ts";
import {
  backlogIndex,
  blockersIn,
  deadBlockersFor,
  dependentsIn,
  readyBacklog,
} from "@shared/backlog.ts";
import { backlogTasks } from "@shared/session.ts";
import { PRIORITY_LABELS, TASK_PRIORITIES } from "@shared/task.ts";
import type { BacklogPlan, ForemanStatus, Task, TaskPriority } from "@shared/types.ts";
import { api } from "../../lib/api.ts";
import {
  autopilotReadout,
  blockedLabel,
  blockersNeedYou,
  plannerFacts,
  type PlannerFact,
} from "../../lib/backlog-copy.ts";
import { relativeTime } from "../../lib/format.ts";
import { DeadBlockerButton, ScheduleSwitch } from "../session-bits.tsx";
import { Tooltip } from "../Tooltip.tsx";
import { LineDrawer, LineDrawerEmpty } from "./LineDrawer.tsx";
import { NextUpPlanner } from "./NextUpPlanner.tsx";

/**
 * BACKLOG - the queue in the order the operator arranged, and the moves that change it.
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
 *     verbatim - the operator's `backlogRank` order, filtered to what can start right now -
 *     which is the exact list `backlog-machine.ts` schedules from and the exact derivation
 *     the strip's own sentence is folded from. The head of it IS "next up"; there is no
 *     separate marker computation to drift from the one the board draws. The stored plan
 *     supplies the dependency edges the filter asks about and never the position.
 *  2. **It reads what the browser already holds.** Unlike Intake and Shipped, this drawer
 *     fetches nothing on open: the task list arrives over SSE and `foreman.backlogPlan` is
 *     already polled every 4s by `useForeman`. A stage click costs one render.
 *  3. **Every action is an existing route, through the existing shared leaf.** Launch is
 *     `dispatchBacklog`, park/resume is `ScheduleSwitch` over `updateTask { enabled }`, and
 *     priority is the same `updateTask { priority }` the board's picker writes. A refusal is
 *     reported on the drawer and the row STAYS, because a triage surface that dropped a row
 *     on a failed call would be lying about the queue.
 *  4. **Three bands, and only the first one gets the triage lever.** Ready rows are the ones
 *     a human is choosing between, so they carry the priority select; blocked and parked rows
 *     carry the one move that would change their state at all - resolve the dead prerequisite,
 *     or flip the switch back on. Priority is annotation and moves nothing, so a picker on a
 *     row that cannot run whatever you set it to informs no decision anyone is making.
 *
 *     The controls that DO change the order live on the board's card (`BacklogColumn`), which
 *     is the surface reordering happens on. Duplicating them here would be a second place to
 *     get the anchor arithmetic right for no question this panel is being asked.
 *
 *  5. **It explains itself, one layer down.** The `next up` mark is a trigger
 *     (`NextUpPlanner`): press it and the drawer says WHY that row is the row - Foreman's
 *     own recorded reason, quoted, over the facts this file computed to draw the list. The
 *     footer carries the other half of the same question - whether anything is going to
 *     act on this order at all - as a live readout and the `autoBacklog` switch itself,
 *     which is the config the Foreman popover's checkbox writes and never a second copy
 *     of it.
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
function partition(tasks: Task[], plan: BacklogPlan | null, index: BacklogIndex): Row[] {
  const ready = readyBacklog(tasks, plan);
  const readyIds = new Set(ready.map((t) => t.id));
  const row = (task: Task, band: Band): Row => ({
    task,
    band,
    blockers: blockersIn(task, index),
    deadBlockers: deadBlockersFor(task, index),
  });
  // One order for both bands now (`backlogTasks` is `byBacklogRank`), which is why this is a
  // plain set difference rather than a re-sort: a blocked row sits exactly where the operator
  // left it, and moves into the ready band in place when it unblocks.
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

/** What the planner says about the head of the ready band, derived once by the drawer. */
interface PlannerRead {
  planned: boolean;
  reason: string | null;
  facts: PlannerFact[];
  readyCount: number;
}

function BacklogRow({
  row,
  planner,
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
  /**
   * Set on the ONE item at the head of the ready band - what autopilot takes next - and
   * null on every other row. Carrying the read rather than a `nextUp` boolean is what
   * keeps this component presentational: the mark and the panel behind it are the same
   * claim, so the row would have had to be handed the plan to derive one of them anyway.
   */
  planner: PlannerRead | null;
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
  const nextUp = planner !== null;
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
        {/* The mark, and the way into the reasoning behind it. Phase 1 drew a static pill
            here and reserved this one element for the planner; everything else on the row
            is still the row's. The pill keeps the board card's `.bl-next` colour so the
            same fact reads the same way on every surface that draws it. */}
        {planner && (
          <NextUpPlanner
            task={task}
            planned={planner.planned}
            reason={planner.reason}
            facts={planner.facts}
            readyCount={planner.readyCount}
            busy={busy}
            onLaunch={onLaunch}
          />
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
            these are the rows a human is choosing between. */}
        {band === "ready" && (
          <span className={`bl-prio${task.priority ? ` prio-${task.priority}` : " is-unset"}`}>
            <Tooltip label={`Priority for "${task.title}" - a triage mark, not its place in the queue`}>
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
  /**
   * `ForemanConfig.autoBacklog`, or null until the config poll answers.
   *
   * The CONFIG value and not `status.autopilot.on`, though the daemon fills the second
   * from the first: the config is what `useForeman.update` writes optimistically, so the
   * switch moves under the finger instead of four seconds later. The status object drives
   * the sentence beside it, where being one poll behind costs nothing.
   */
  autoBacklog,
  /** The daemon's derived readout, or null before the first status poll lands. */
  autopilot,
  /** Whether the machine would actually launch: Foreman on, and in live mode. */
  autopilotLaunches,
  onClose,
  onEditTask,
  onOpenSitrep,
  onSetAutoBacklog,
}: {
  tasks: Task[];
  backlogPlan: BacklogPlan | null;
  now: number;
  autoBacklog: boolean | null;
  autopilot: ForemanStatus["autopilot"] | null;
  autopilotLaunches: boolean;
  onClose: () => void;
  onEditTask: (taskId: string) => void;
  onOpenSitrep: () => void;
  /** Resolves false when Foreman refuses the patch, which the drawer then reports. */
  onSetAutoBacklog: (next: boolean) => Promise<boolean>;
}): React.JSX.Element {
  // Per-task rather than one flag for the panel: two rows are two decisions, and a switch
  // that went inert because somebody launched a different task reads as a broken control.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [autoBusy, setAutoBusy] = useState(false);

  const { rows, index } = useMemo(() => {
    // One index for the whole pass, and the planner's "unblocks N" reads the same one:
    // `blockersIn` is the only definition of what blocks what, forwards or backwards.
    const built = backlogIndex(tasks, backlogPlan);
    return { rows: partition(tasks, backlogPlan, built), index: built };
  }, [tasks, backlogPlan]);
  const ready = rows.filter((r) => r.band === "ready");
  const held = rows.filter((r) => r.band !== "ready");

  /**
   * The planner's read of the head of the queue, or null when nothing is ready.
   *
   * Derived here rather than inside the popover for the reason every leaf in this file is
   * presentational: the drawer already holds the ordered band and the index, and a panel
   * that re-derived either could disagree with the rows it is drawn over.
   */
  const planner = useMemo((): PlannerRead | null => {
    const band = rows.filter((r) => r.band === "ready").map((r) => r.task);
    const head = band[0];
    if (!head) return null;
    const entry = index.entries.get(head.id) ?? null;
    return {
      planned: entry !== null,
      reason: entry?.reason ?? null,
      facts: plannerFacts({
        task: head,
        ready: band,
        unblocks: dependentsIn(head, tasks, index),
        now,
      }),
      readyCount: band.length,
    };
  }, [index, now, rows, tasks]);

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
      planner: id === ready[0]?.task.id ? planner : null,
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
          {/* The autopilot line takes the slot Phase 1's static sentence about the Sitrep
              held. A live readout of the thing that empties this queue is worth more
              footer than a caption for the button beside it, which says the same thing in
              its own tooltip - and the footer is one line, so the two could not both
              have it. The button itself has not moved. */}
          <Tooltip
            label={
              autoBacklog
                ? "Foreman is taking ready tasks on its own - click to stop it"
                : "Let Foreman hand ready tasks to idle agents on its own"
            }
          >
            <button
              type="button"
              className={`bl-auto-switch${autoBacklog ? " is-on" : ""}`}
              role="switch"
              aria-checked={autoBacklog === true}
              // Named for the setting and not for its state, because the state is what
              // `aria-checked` is for - and it is the SAME setting as the Foreman
              // popover's "Auto-schedule the backlog", written through the same config.
              aria-label="Backlog autopilot"
              disabled={autoBacklog === null || autoBusy}
              onClick={() => {
                setAutoBusy(true);
                void onSetAutoBacklog(!autoBacklog).then((ok) => {
                  setAutoBusy(false);
                  // Onto the same alert line a refused row write lands on, and for the
                  // same reason. `useForeman` reverts the optimistic value when Foreman
                  // says no, so without this the switch springs back on its own with
                  // nothing said - which is indistinguishable from a broken control.
                  setError(ok ? null : "could not change the autopilot");
                });
              }}
            >
              <span className="bl-auto-track" aria-hidden />
            </button>
          </Tooltip>
          <span className="line-drawer-foot-note">
            {autoBacklog === null
              ? "Autopilot · reading Foreman's settings…"
              : autopilotReadout({
                  on: autoBacklog,
                  status: autopilot,
                  launches: autopilotLaunches,
                })}
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
