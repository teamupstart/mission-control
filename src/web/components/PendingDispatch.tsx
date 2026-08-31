import { dispatchPhase, type DispatchPhase } from "@shared/session.ts";
import { fullTaskTitle } from "@shared/title.ts";
import type { Task } from "@shared/types.ts";
import { repoLeaf } from "../lib/format.ts";
import { AgentDot } from "./session-bits.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * The placeholder for a task that has been dispatched and has no session yet, drawn where
 * its session's own row will land: a tile at the top of the Board's `working` column, and a
 * rail row at the top of the Console rail's `working` group.
 *
 * WHY IT LIVES IN THE FLEET, and not in a band above it. This used to be `StartingStrip`, a
 * band of dashed pills between the Line and the layouts. The band closed the real hole - a
 * dispatched task was drawn NOWHERE for several seconds, which reads as a dropped dispatch -
 * but it paid for it twice over:
 *
 *  - It moved the page twice per dispatch. The band renders nothing when it is empty, so it
 *    took its height out of the fleet when a dispatch started and handed it back when the
 *    session landed. Measured at 54px for one dispatch and 95px for five.
 *  - The card teleported. The pill sat at the top of the page and the card it became appeared
 *    in a column, so the handover read as one object disappearing and a different one
 *    arriving rather than as a placeholder being filled in.
 *
 * Drawn from the TASK, and never as a synthetic `Session`. Nothing here enters
 * `orderSessions`/`fleetRows`, so no placeholder is arrow-key reachable and App's selection
 * reconciliation - which reconciles against the raw session list - has nothing new to delete.
 * That was the original objection to putting this in the fleet, and it is answered by these
 * being plain elements the column renders beside its rows rather than rows in the order.
 *
 * Each one disappears of its own accord: `provisioningTasks` drops a task the moment its
 * `sessionId` lands, which is the same event that draws the real row.
 *
 * WHICH GROUP. `working`, because a session's first confirmed state is `starting`, which
 * `stateDisplay` tones as `working`. A terminal session can arrive with `stateConfirmed`
 * false and land one group down in `unconfirmed` until its first reading; the placeholder
 * does not try to predict that, and the row simply appears in the group the session actually
 * reports. That is a one-group correction rather than the whole-page jump the band had.
 */

/** What the phase says, in words. The only copy in the app that names a provisioning step. */
const PHASE_COPY: Record<DispatchPhase, (task: Task) => string> = {
  prepare: () => "Provisioning its worktree",
  launch: (task) => `Launching ${task.agent}`,
  discover: (task) => `Waiting for ${task.agent} to appear`,
  handover: () => "Handing over the task",
};

/** How far along the four-segment meter sits, by phase. */
const PHASE_INDEX: Record<DispatchPhase, number> = {
  prepare: 0,
  launch: 1,
  discover: 2,
  handover: 3,
};

/**
 * The title, which is the one thing about the words these rows change.
 *
 * An untitled dispatch carries `deriveTitle(intent)` until a model summarises it, and often
 * for good: the intent's first line, title-cased word by word and cut hard at
 * `TITLE_MAX_CHARS` with a trailing ellipsis. Rendered raw that produced a mid-sentence
 * title with its own ellipsis followed by a second one in the status word, in a row with
 * hundreds of empty pixels to the right of it.
 *
 * `fullTaskTitle` is already the shared answer to exactly this, and is already what
 * denormalises `TaskSummary.fullTitle` for session cards: it returns the complete first line
 * when the stored title is that deterministic fallback, and leaves an explicit or
 * model-written title exactly as persisted. So the row asks for the full line and lets its
 * own width decide the cut - one ellipsis, drawn by the layout, at whatever the surface can
 * actually show. The complete line stays reachable on hover.
 */
function pendingTitle(task: Task): string {
  return fullTaskTitle(task.title, task.intent);
}

/**
 * Four segments, one per milestone the daemon broadcasts. Filled behind the phase, breathing
 * on it, an empty track ahead of it.
 *
 * Decoration: every surface that draws it also states the phase in words beside it, so this
 * is the one thing here a screen reader should not read out.
 */
function PhaseMeter({ phase }: { phase: DispatchPhase }): React.JSX.Element {
  const at = PHASE_INDEX[phase];
  return (
    <span className="pend-meter" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className={`pend-seg${i < at ? " is-done" : i === at ? " is-live" : ""}`}
        />
      ))}
    </span>
  );
}

/**
 * The Board's placeholder: a tile-shaped ghost, at the tile's width and roughly its height,
 * so the card that replaces it does not resize the column.
 *
 * Dashed and tinted rather than solid: this is a card for a thing that does not exist yet,
 * and the border says so before any of the words do. Two skeleton bars stand in for the goal
 * line and the runtime row - two, not five, because the point is that the tile is the right
 * SHAPE and a full skeleton would promise rows the landing card may not have.
 */
function PendingTile({ task }: { task: Task }): React.JSX.Element {
  const phase = dispatchPhase(task);
  const title = pendingTitle(task);
  return (
    <div className="tile tone-working pend-tile" data-phase={phase}>
      <span className="tile-head">
        <AgentDot agent={task.agent} />
        <Tooltip label={title}>
          <span className="tile-name">{title}</span>
        </Tooltip>
      </span>
      <span className="pend-phase">
        <PhaseMeter phase={phase} />
        {PHASE_COPY[phase](task)}
      </span>
      <span className="pend-skel pend-skel-a" aria-hidden />
      <span className="pend-skel pend-skel-b" aria-hidden />
      <span className="tile-foot pend-foot">
        {/* The branch appears the moment the worktree is leased, which is also the moment
            the phase advances - so the foot fills in as the row progresses rather than
            reserving space for a value that may never arrive. */}
        <span className="pend-branch">{task.branch ?? "no branch yet"}</span>
        <Tooltip label={task.repoRoot}>
          <span className="pend-repo">{repoLeaf(task.repoRoot)}</span>
        </Tooltip>
      </span>
    </div>
  );
}

/**
 * The Console rail's placeholder, and the Board's when a column has been drilled into.
 *
 * Modelled on `RailRow`'s two-line shape so the ghost and its neighbours read as one list,
 * minus everything a task cannot know yet: no marks, no PR, no last-seen. A div rather than
 * a button, because there is nothing to open.
 */
function PendingRailRow({ task }: { task: Task }): React.JSX.Element {
  const phase = dispatchPhase(task);
  const title = pendingTitle(task);
  return (
    <div className="rail-row tone-working pend-rail" data-phase={phase}>
      <AgentDot agent={task.agent} />
      <Tooltip label={title}>
        <span className="rail-name">{title}</span>
      </Tooltip>
      {/* The phase goes on the row's SECOND line, which is where a real row puts what it is
          doing right now - and it has to, because the rail's right column is sized for
          "working" and "8m ago". Put there, `Waiting for claude to appear` took the row's
          width and crushed the title to four characters, which the e2e frame caught on a
          first dispatch onto an empty fleet.

          The repository follows it, because with repository grouping on the placeholders sit
          above the frames - they are not sessions, so they are in no repository span - and
          this is the rail's only line that can say where the task is going. */}
      <span className="rail-sub">
        {PHASE_COPY[phase](task)}
        <span className="pend-sep" aria-hidden>·</span>
        {repoLeaf(task.repoRoot)}
      </span>
      <span className="rail-right">
        <span className="rail-state-line">
          {/* The word a session in this state would show, so the rail's state column reads
              continuously down the group: `starting`, then `working`, then `idle`. */}
          <span className="rail-state pend-state">starting</span>
        </span>
        <span className="rail-meta pend-meta">
          <PhaseMeter phase={phase} />
        </span>
      </span>
    </div>
  );
}

/**
 * Every placeholder in one fleet surface, as a labelled list.
 *
 * ONE component for both layouts, and the reason is the accessible name: `Starting` is what
 * a screen reader reads over these, and what `e2e/specs/dispatch-pending-placeholder.spec.ts`
 * selects by. Two call sites building their own wrapper would be two names one edit apart.
 *
 * A real `list`/`listitem` pair rather than a bare div: the rows are not interactive, so
 * without it a placeholder is an unlabelled div a screen reader walks straight past, and the
 * only announcement of a dispatch the operator just made would be its absence. `list` also
 * carries the count, which is the one number that matters here.
 *
 * A nested flex column rather than `display: contents`, so the placeholders keep the column's
 * own gap between themselves and the cards below.
 */
export function PendingList({
  tasks,
  variant,
}: {
  tasks: readonly Task[];
  /** `tile` for a board column, `rail` for the console rail and a drilled-in column. */
  variant: "tile" | "rail";
}): React.JSX.Element | null {
  if (tasks.length === 0) return null;
  return (
    <div className={`pend-list pend-list-${variant}`} role="list" aria-label="Starting">
      {tasks.map((task) => (
        <div role="listitem" key={task.id}>
          {variant === "tile" ? <PendingTile task={task} /> : <PendingRailRow task={task} />}
        </div>
      ))}
    </div>
  );
}
