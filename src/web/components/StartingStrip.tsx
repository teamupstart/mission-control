import { repoLeaf } from "../lib/format.ts";
import { Tooltip } from "./Tooltip.tsx";
import type { Task } from "@shared/types.ts";

/**
 * The cards for tasks that have been dispatched but have no session yet.
 *
 * This strip exists to close a hole the operator reads as a dropped dispatch. `POST
 * /api/tasks` inserts the row and broadcasts `task_upsert` in about 50ms, but the agent's
 * session does not exist until the title has been summarised by a model, a worktree has been
 * provisioned and the terminal home has been discovered. On a warm pool that title call is
 * the whole wait and it is measured in seconds; on a cold pool slot the provisioning behind
 * it runs `git worktree add` and the repository's setup command as well. For that entire
 * window the task was drawn NOWHERE: `backlogTasks` had already stopped matching it and
 * every other surface on this page reads `session.task`, which is still null.
 *
 * It renders ABOVE the layout switch and outside the `layoutHasContent` gate, beside the
 * Line and for the Line's reason - it is worth reading precisely when the board looks empty,
 * which is the state a first dispatch onto a quiet fleet produces.
 *
 * Deliberately NOT a synthetic `Session` injected into the fleet order. A placeholder there
 * would have to satisfy every required field on `Session`, be given a tone to group under,
 * be injected at three separate re-derivation sites, and would then be selectable by the
 * arrow keys - at which point the selection reconciliation effect, which reconciles against
 * the raw session list, would delete it again. A task is not a session, and this draws it as
 * what it is.
 *
 * Each row disappears of its own accord: `provisioningTasks` drops a task the moment its
 * `sessionId` lands, which is the same event that draws the real card. The title updates in
 * place when the model's replaces the heuristic one, because that is another `task_upsert`.
 */
export function StartingStrip({ tasks }: { tasks: Task[] }): React.JSX.Element | null {
  // Nothing to say and no space taken. Unlike the Line, which holds a fixed height because it
  // is always answering something, this is empty in the steady state and must not leave a
  // band of padding above the board for the seconds a day it has a row in it.
  if (tasks.length === 0) return null;
  return (
    <section className="starting-strip" aria-label="Starting">
      <ul className="starting-strip-list">
        {tasks.map((task) => (
          <li className="starting-strip-item" key={task.id}>
            {/* Decoration. The row states "Starting" in words below, so the spinner is the
                one thing here a screen reader should not read out. */}
            <span className="starting-strip-spinner" aria-hidden="true" />
            <span className="starting-strip-title">{task.title}</span>
            {/* The leaf is presentation only and two repos can share one, so the full path
                stays reachable - the rule `repoLeaf` states for every read-only repository
                label. Through `Tooltip` rather than a native `title`, which is themed and
                reachable by keyboard where the browser's own bubble is neither. */}
            <Tooltip label={task.repoRoot}>
              <span className="starting-strip-meta">
                {task.agent} · {repoLeaf(task.repoRoot)}
              </span>
            </Tooltip>
            {/* The status word, not a count and not a duration. How long provisioning has
                been running is not something the operator can act on, and a ticking clock on
                a card that lives a few seconds reads as a stall warning rather than progress. */}
            <span className="starting-strip-status">Starting…</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
