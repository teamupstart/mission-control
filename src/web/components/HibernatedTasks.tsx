import { useState } from "react";
import type { Task } from "@shared/types.ts";
import { api } from "../lib/api.ts";
import { BLOCKER_KIND_LABELS } from "../lib/blocker.ts";
import { relativeTime } from "../lib/format.ts";
import { useNow } from "../useNow.ts";
import { AgentDot } from "./session-bits.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * The Backlog's Hibernated section (issue #1547): every task whose agent the operator stopped
 * to free its memory, waiting for their Resume.
 *
 * In the Backlog rather than on the board because a hibernated task has no running agent, and
 * the board's columns are about running agents. It sits ABOVE the queued work so a blocked
 * task the operator parked is the first thing the column shows, not the last.
 *
 * Every hibernated task is drawn whether or not the preview flag is on: switching a preview off
 * must not hide a conversation somebody hibernated, or leave them no way to resume it.
 */
export function HibernatedSection({ tasks }: { tasks: Task[] }): React.JSX.Element | null {
  if (tasks.length === 0) return null;
  return (
    <section className="bl-hib" aria-label="Hibernated tasks">
      <h3 className="bl-hib-head">
        <MoonGlyph size={10} />
        <span>Hibernated</span>
        <span className="bl-hib-n">{tasks.length}</span>
      </h3>
      <ul className="bl-hib-list">
        {tasks.map((task) => (
          <HibernatedCard key={task.id} task={task} />
        ))}
      </ul>
    </section>
  );
}

/** The moon every hibernated surface wears, beside the word. Colour is never the only cue. */
export function MoonGlyph({ size = 11 }: { size?: number }): React.JSX.Element {
  return (
    <svg className="moon-glyph" width={size} height={size} viewBox="0 0 12 12" aria-hidden="true">
      <path d="M7.4 1.1a4.95 4.95 0 1 0 3.5 7.2A4.1 4.1 0 0 1 7.4 1.1z" fill="currentColor" />
    </svg>
  );
}

function HibernatedCard({ task }: { task: Task }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const record = task.hibernation ?? null;
  const since = record?.hibernatedAt ?? task.updatedAt;
  // Ticks only while the age is counted in seconds or minutes; a day-old one has nothing to move.
  const now = useNow(Date.now() - since < 3_600_000);
  const failure = record?.failure ?? null;
  const when = new Date(since).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });

  async function resume(): Promise<void> {
    setBusy(true);
    setError(null);
    const result = await api.resumeHibernatedTask(task.id);
    setBusy(false);
    if (!result.ok) setError(result.error ?? "Mission Control could not resume this task");
  }

  // The recorded failure is the durable answer and survives a reload; a refusal that recorded
  // nothing (already resuming, a dropped connection) is this click's own, so it is shown too.
  const extra = error && !(failure && error.includes(failure.reason)) ? error : null;
  return (
    <li className={`bl-hib-card${failure ? " is-failed" : ""}`} aria-label={`Hibernated task: ${task.title}`}>
      {/* The title on a line of its own, so a narrow column wraps it rather than cutting it. */}
      <span className="bl-hib-row">
        <AgentDot agent={task.agent} />
        <span className="bl-hib-title">{task.title}</span>
      </span>
      {record?.blocker && (
        <span className="bl-hib-blocker">
          <span className="bl-hib-blocker-kind">{BLOCKER_KIND_LABELS[record.blocker.kind]}</span>
          <span className="bl-hib-blocker-reason">{record.blocker.reason}</span>
        </span>
      )}
      <span className="bl-hib-foot">
        <Tooltip
          label={`Hibernated ${when}${task.branch ? ` on ${task.branch}` : ""}. Its agent is stopped and uses no memory.`}
        >
          <span className="bl-hib-meta">
            <MoonGlyph size={9} />
            <span>Hibernated {relativeTime(since, now)}</span>
          </span>
        </Tooltip>
        <Tooltip
          label={failure
            ? "Try again to reopen this task's conversation in its worktree"
            : "Start its agent again and reopen this conversation in the same worktree"}
        >
          <button type="button" className="bl-hib-resume" disabled={busy} onClick={() => void resume()}>
            {busy ? "Resuming…" : failure ? "Retry" : "Resume"}
          </button>
        </Tooltip>
      </span>
      {failure && (
        <span className="bl-hib-failure" role="alert">
          Could not resume: {failure.reason}. Its worktree and conversation are kept.
        </span>
      )}
      {extra && (
        <span className="bl-hib-failure" role="alert">
          {extra}
        </span>
      )}
    </li>
  );
}
