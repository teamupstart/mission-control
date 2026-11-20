import { useEffect, useState } from "react";
import { currentShaping, type ShapingShaperSummary, type TaskShaping } from "@shared/shaping.ts";
import type { Session } from "@shared/types.ts";
import { useFeatureFlag } from "../useFeatureFlag.ts";
import { fetchTaskShaping, type TaskShapingView } from "../lib/api.ts";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * What task shaping added to THIS session's turn one, and whether anything was degraded.
 *
 * Every surface here reads one record: `session.task.shaping`, the task's latest launch that
 * reached a worker. It is drawn only while it names the session being drawn - the same rule
 * `currentShaping` applies to every task read - so a redispatch whose record could not be
 * committed shows nothing rather than the previous launch's context or `degraded`.
 */

/** The record this session received, or null when it received none or the flag is off. */
export function sessionShaping(session: Pick<Session, "id" | "task">): TaskShaping | null {
  const record = session.task?.shaping;
  if (!record) return null;
  return currentShaping({ shaping: record, sessionId: session.id });
}

function entriesLabel(entries: number): string {
  return `${entries} ${entries === 1 ? "entry" : "entries"}`;
}

/** The reason a degraded record is degraded, in one sentence for a tooltip or a marker. */
export function shapingDegradedReason(record: TaskShaping): string {
  const problems = record.shapers.filter((shaper) => shaper.outcome !== "ok");
  if (problems.length === 0) return "Task shaping reported a problem.";
  return problems.map((shaper) => `${shaper.label}: ${shaper.reason ?? OUTCOME_WORDS[shaper.outcome]}`).join(" ");
}

const OUTCOME_WORDS: Record<ShapingShaperSummary["outcome"], string> = {
  ok: "Answered",
  degraded: "Reported degraded",
  failed: "Failed",
  timed_out: "Timed out",
  invalid: "Invalid reply",
  unavailable: "Unavailable",
};

function seconds(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${Math.round(ms / 100) / 10} s`;
}

/** The session-header chip: "Context: N entries", or an amber "Context degraded". */
export function ShapingChip({ session }: { session: Pick<Session, "id" | "task"> }): React.JSX.Element | null {
  const enabled = useFeatureFlag("task-shaping");
  const [open, setOpen] = useState(false);
  const record = enabled ? sessionShaping(session) : null;
  const taskId = session.task?.id ?? null;
  // A session switched underneath an open viewer closes it rather than showing another's record.
  useEffect(() => setOpen(false), [session.id]);
  if (!record || !taskId) return null;
  const degraded = record.state === "degraded";
  const label = degraded ? "Context degraded" : `Context: ${entriesLabel(record.entries)}`;
  const tip = degraded
    ? `See the context this session received. ${shapingDegradedReason(record)}`
    : "See the context this session received.";
  return (
    <>
      <Tooltip label={tip}>
        <button
          type="button"
          className={`shaping-chip${degraded ? " is-degraded" : ""}`}
          aria-label={label}
          onClick={(event) => {
            event.stopPropagation();
            setOpen(true);
          }}
        >
          {label}
        </button>
      </Tooltip>
      {open && <ShapingViewer taskId={taskId} record={record} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * Split the delivered section back into its entries for display. Each entry starts on a
 * heading the engine wrote for a shaper this record names, so a body that happens to contain
 * a heading-like line of some other label stays inside its entry.
 */
export function shapingEntries(text: string, labels: readonly string[]): Array<{ heading: string; body: string }> {
  const normalized = labels.map((label) => label.replace(/\s+/g, " ").trim().slice(0, 200)).filter(Boolean);
  const starts: number[] = [];
  for (let at = text.indexOf("\n\n### "); at !== -1; at = text.indexOf("\n\n### ", at + 1)) {
    const line = text.slice(at + 2, text.indexOf("\n", at + 2) === -1 ? undefined : text.indexOf("\n", at + 2));
    if (normalized.some((label) => line.startsWith(`### ${label}: `))) starts.push(at + 2);
  }
  return starts.map((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1]! - 2 : text.length;
    const block = text.slice(start, end);
    const newline = block.indexOf("\n");
    return newline === -1
      ? { heading: block.slice(4), body: "" }
      : { heading: block.slice(4, newline), body: block.slice(newline + 1) };
  });
}

/** "Context this session received": every shaper's outcome, every entry, and the notes. */
export function ShapingViewer({
  taskId,
  record,
  onClose,
}: {
  taskId: string;
  record: TaskShaping;
  onClose: () => void;
}): React.JSX.Element {
  const [view, setView] = useState<TaskShapingView | null | "loading">("loading");
  useEffect(() => {
    const abort = new AbortController();
    setView("loading");
    void fetchTaskShaping(taskId, abort.signal).then((next) => {
      if (!abort.signal.aborted) setView(next);
    });
    return () => abort.abort();
  }, [taskId, record.at, record.sessionId]);
  // The route answers for the task's current session. A reply that describes another launch
  // than the one this chip was drawn from is not shown as this session's.
  const delivered = view === "loading" ? null : view;
  const text = delivered && delivered.summary.sessionId === record.sessionId && delivered.summary.at === record.at
    ? delivered.text
    : null;
  const entries = text ? shapingEntries(text, record.shapers.map((shaper) => shaper.label)) : [];
  return (
    <Overlay
      id={OVERLAY_IDS.shapingContext}
      onClose={onClose}
      className="modal shaping-modal"
      role="dialog"
      ariaLabel="Context this session received"
    >
      <>
        <h3>Context this session received</h3>
        <p className="settings-hint">
          Recorded when turn one reached this session. Task shaping added it after the task&apos;s
          own instructions, and it cannot relax them.
        </p>
        <div className="modal-bleed shaping-body">
          <p className={`shaping-state${record.state === "degraded" ? " is-degraded" : ""}`}>
            {record.state === "degraded" ? "Degraded" : "OK"}: {entriesLabel(record.entries)}, {record.bytes} bytes, in{" "}
            {seconds(record.durationMs)}.
          </p>
          {record.truncated && (
            <p className="shaping-note" role="note">
              Truncated: some context did not fit and was cut or left out
              {record.limit ? ` (${record.limit.reason}, so the section had ${record.limit.bytes} bytes).` : "."}
            </p>
          )}
          <ul className="shaping-shapers" aria-label="Shapers">
            {record.shapers.map((shaper) => (
              <li key={shaper.id} className={`shaping-shaper is-${shaper.outcome}`} aria-label={`${shaper.label}: ${OUTCOME_WORDS[shaper.outcome]}`}>
                <span className="shaping-shaper-head">
                  <strong>{shaper.label}</strong>
                  <span className="shaping-outcome">{OUTCOME_WORDS[shaper.outcome]}</span>
                </span>
                <span className="shaping-shaper-facts">
                  {shaper.stage} · {shaper.origin} · {seconds(shaper.durationMs)} · {entriesLabel(shaper.entries)}
                  {shaper.version ? ` · version ${shaper.version}` : ""}
                  {shaper.truncated ? " · truncated" : ""}
                </span>
                {shaper.reason && <span className="shaping-reason">{shaper.reason}</span>}
                {shaper.redacted && (
                  <span className="shaping-note" role="note">A credential value was removed from this shaper&apos;s reply.</span>
                )}
              </li>
            ))}
          </ul>
          {view === "loading" ? (
            <p className="shaping-empty">Loading what was delivered…</p>
          ) : entries.length > 0 ? (
            <ol className="shaping-entries" aria-label="Entries delivered in turn one">
              {entries.map((entry, index) => (
                <li key={`${index}:${entry.heading}`} className="shaping-entry">
                  <span className="shaping-entry-head">{entry.heading}</span>
                  <pre className="shaping-entry-body" tabIndex={0}>{entry.body}</pre>
                </li>
              ))}
            </ol>
          ) : (
            <p className="shaping-empty">No context was added to turn one.</p>
          )}
        </div>
        <footer className="modal-foot">
          <Tooltip label="Close">
            <button data-dialog-default type="button" className="btn" onClick={onClose}>
              Close
            </button>
          </Tooltip>
        </footer>
      </>
    </Overlay>
  );
}

/** The board card's marker: present only when this session's launch was shaped and degraded. */
export function ShapingTileFlag({ session }: { session: Pick<Session, "id" | "task"> }): React.JSX.Element | null {
  const enabled = useFeatureFlag("task-shaping");
  const record = enabled ? sessionShaping(session) : null;
  if (record?.state !== "degraded") return null;
  return (
    <Tooltip label={`Context degraded. ${shapingDegradedReason(record)}`}>
      <span className="tile-flag tf-shaping" tabIndex={0}>context degraded</span>
    </Tooltip>
  );
}

/** The rail row's marker, glyph only: the rail has one line of room. */
export function ShapingRailMark({ session }: { session: Pick<Session, "id" | "task"> }): React.JSX.Element | null {
  const enabled = useFeatureFlag("task-shaping");
  const record = enabled ? sessionShaping(session) : null;
  if (record?.state !== "degraded") return null;
  return (
    <Tooltip label={`Context degraded. ${shapingDegradedReason(record)}`}>
      <span className="rail-shaping" role="img" aria-label="Context degraded">◬</span>
    </Tooltip>
  );
}
