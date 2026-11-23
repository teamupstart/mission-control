import { useEffect, useState } from "react";
import {
  announcedSkills,
  currentShaping,
  type ShapingShaperSummary,
  type ShapingSkillSummary,
  type TaskShaping,
  type TaskSkillPrompt,
} from "@shared/shaping.ts";
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

/**
 * The record this session received, or null when it received none or the record names another
 * session. It does not read the `task-shaping` flag; every caller here applies that gate itself.
 */
export function sessionShaping(session: Pick<Session, "id" | "task">): TaskShaping | null {
  const record = session.task?.shaping;
  if (!record) return null;
  return currentShaping({ shaping: record, sessionId: session.id });
}

function entriesLabel(entries: number): string {
  return `${entries} ${entries === 1 ? "entry" : "entries"}`;
}

function skillsLabel(skills: number): string {
  return `${skills} ${skills === 1 ? "skill" : "skills"}`;
}

/**
 * The chip's words for a record that is not degraded: "Context: 3 entries", "Context: 3 entries,
 * 2 skills" once routed skills were announced, or "Skills: 2" when only skills were.
 */
export function shapingChipLabel(record: TaskShaping): string {
  const skills = announcedSkills(record).length;
  if (skills === 0) return `Context: ${entriesLabel(record.entries)}`;
  if (record.entries === 0) return `Skills: ${skills}`;
  return `Context: ${entriesLabel(record.entries)}, ${skillsLabel(skills)}`;
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

/** Where a shaper came from, in the words Settings uses for it. */
const ORIGIN_WORDS: Record<ShapingShaperSummary["origin"], string> = {
  registered: "registered",
  discovered: "found on disk",
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
  // The viewer belongs to the task and launch record the operator opened it on. A session that
  // switches, releases its task or takes another one closes it, rather than reopening it later
  // on a record nobody clicked.
  useEffect(() => setOpen(false), [session.id, taskId, record?.at, record?.sessionId]);
  if (!record || !taskId) return null;
  const degraded = record.state === "degraded";
  const label = degraded ? "Context degraded" : shapingChipLabel(record);
  const tip = degraded
    ? `See the context this session received. ${shapingDegradedReason(record)}`
    : "See the context this session received.";
  return (
    <>
      <Tooltip label={tip}>
        <button
          type="button"
          className={`task-context-chip${degraded ? " is-degraded" : ""}`}
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
 * What the viewer can say about the delivered text. `none` only when the route answered for
 * this exact launch with no text, or the record itself counts no entries; a missing reply, or
 * one that describes a different launch, is `unavailable`, never "no context was added".
 */
export function deliveredState(
  view: TaskShapingView | null | "loading",
  record: TaskShaping,
): { kind: "loading" } | { kind: "text"; text: string } | { kind: "none" } | { kind: "unavailable" } {
  if (view === "loading") return { kind: "loading" };
  const matches = view !== null && view.summary.sessionId === record.sessionId && view.summary.at === record.at;
  if (matches && view.text) return { kind: "text", text: view.text };
  if (matches || record.entries === 0) return { kind: "none" };
  return { kind: "unavailable" };
}

/**
 * "Context this session received": every shaper's outcome, the section exactly as turn one
 * carried it, and the notes. The section is shown as delivered, never split back into entries:
 * the engine owns its format, and a shaper's body may contain any heading it likes.
 */
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
  const delivered = deliveredState(view, record);
  return (
    <Overlay
      id={OVERLAY_IDS.shapingContext}
      onClose={onClose}
      className="modal task-context-modal"
      role="dialog"
      ariaLabel="Context this session received"
    >
      <>
        <h3>Context this session received</h3>
        <p className="settings-hint">
          Recorded when turn one reached this session. Task shaping added it after the task&apos;s
          own instructions, and it cannot relax them.
        </p>
        <div className="modal-bleed task-context-body">
          <p className={`task-context-state${record.state === "degraded" ? " is-degraded" : ""}`}>
            {record.state === "degraded" ? "Degraded" : "OK"}: {entriesLabel(record.entries)}, {record.bytes} bytes, in{" "}
            {seconds(record.durationMs)}.
          </p>
          {record.truncated && (
            <p className="task-context-note" role="note">
              Truncated: some context did not fit and was cut or left out
              {record.limit ? ` (${record.limit.reason}, so the section had ${record.limit.bytes} bytes).` : "."}
            </p>
          )}
          <ul className="task-context-shapers" aria-label="Shapers">
            {record.shapers.map((shaper) => (
              <li key={shaper.id} className={`task-context-shaper is-${shaper.outcome}`} aria-label={`${shaper.label}: ${OUTCOME_WORDS[shaper.outcome]}`}>
                <span className="task-context-shaper-head">
                  <strong>{shaper.label}</strong>
                  <span className="task-context-outcome">{OUTCOME_WORDS[shaper.outcome]}</span>
                </span>
                <span className="task-context-shaper-facts">
                  {shaper.stage} · {ORIGIN_WORDS[shaper.origin]} · {seconds(shaper.durationMs)} · {entriesLabel(shaper.entries)}
                  {shaper.version ? ` · version ${shaper.version}` : ""}
                  {shaper.truncated ? " · truncated" : ""}
                </span>
                {shaper.sha256 && (
                  // Which definition ran: the manifest's bytes for a folder shaper, the stored entry for a registered one.
                  <span className="task-context-definition">
                    Definition{" "}
                    <Tooltip label={`sha256 ${shaper.sha256}`}>
                      <code tabIndex={0}>sha256 {shaper.sha256.slice(0, 12)}</code>
                    </Tooltip>
                  </span>
                )}
                {shaper.reason && <span className="task-context-reason">{shaper.reason}</span>}
                {shaper.redacted && (
                  <span className="task-context-note" role="note">A credential value was removed from this shaper&apos;s reply.</span>
                )}
              </li>
            ))}
          </ul>
          {record.skills && record.skills.length > 0 && (
            <RoutedSkills
              skills={record.skills}
              shapers={record.shapers}
              afterWork={view !== null && view !== "loading" && view.summary.at === record.at ? view.afterWork ?? null : null}
              loading={view === "loading"}
            />
          )}
          {delivered.kind === "loading" ? (
            <p className="task-context-empty">Loading what was delivered…</p>
          ) : delivered.kind === "text" ? (
            <section className="task-context-delivered" aria-label="Delivered in turn one">
              <span className="task-context-delivered-head">Delivered in turn one</span>
              <pre className="task-context-delivered-text" tabIndex={0}>{delivered.text}</pre>
            </section>
          ) : delivered.kind === "unavailable" ? (
            <p className="task-context-empty" role="note">
              The delivered text could not be loaded for this launch. The outcomes above are its record.
            </p>
          ) : (
            <p className="task-context-empty">No context was added to turn one.</p>
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

const SKILL_STATE_WORDS: Record<ShapingSkillSummary["state"], string> = {
  announced: "Announced",
  superseded: "Superseded",
  unavailable: "Unavailable",
  unsupported: "Unsupported",
  dropped: "Left out",
};

const SKILL_WHEN_WORDS: Record<string, string> = {
  "task-start": "at the start",
  during: "during the work",
  "after-work": "after the work",
};

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Whether, and when, an after-work skill was prompted, in one phrase. */
export function afterWorkPromptWords(prompt: TaskSkillPrompt | null, name: string, loading: boolean): string {
  if (loading) return "Checking whether it was prompted…";
  if (!prompt) return "Not prompted yet: Mission Control prompts it when the work is complete.";
  switch (prompt.state) {
    case "delivered":
      return prompt.skills.includes(name)
        ? `Prompted${prompt.deliveredAt !== null ? ` at ${clockTime(prompt.deliveredAt)}` : ""}.`
        : `Not prompted: ${prompt.reason ?? "it did not resolve when the work was complete."}`;
    case "queued":
      return "Prompt queued: it goes to the session when the current turn ends.";
    case "held":
      return "Prompt held until Foreman's wrap-up is answered.";
    case "waiting":
      return `Prompt waiting for the session to take it${prompt.reason ? `: ${prompt.reason}` : "."}`;
    case "skipped":
      return `Not prompted: ${prompt.reason ?? "no skill was left to prompt."}`;
    case "not_delivered":
      return `Not delivered: ${prompt.reason ?? "the prompt could not be sent."}`;
  }
}

/**
 * "Skills for this task" in the viewer: every routed skill with when it applies, why the router
 * chose it, which router, whether Mission Control could check it, and what became of it. An
 * after-work skill also says whether and when it was prompted.
 */
export function RoutedSkills({
  skills,
  shapers,
  afterWork,
  loading = false,
}: {
  skills: readonly ShapingSkillSummary[];
  shapers: readonly ShapingShaperSummary[];
  /** The launch's prompt row, null when none was written, or undefined for a dry run, which prompts nothing. */
  afterWork: TaskSkillPrompt | null | undefined;
  loading?: boolean;
}): React.JSX.Element {
  const routerLabel = (id: string) => shapers.find((shaper) => shaper.id === id)?.label ?? id;
  return (
    <section className="task-context-skills" aria-label="Skills for this task">
      <span className="task-context-delivered-head">Skills for this task</span>
      <ul className="task-context-shapers" aria-label="Routed skills">
        {skills.map((skill) => (
          <li
            key={skill.name}
            className={`task-context-shaper task-context-skill${skill.state === "announced" ? " is-ok" : ""}`}
            aria-label={`${skill.name}: ${SKILL_STATE_WORDS[skill.state]}`}
          >
            <span className="task-context-shaper-head">
              <strong><code>{skill.name}</code></strong>
              <span className="task-context-outcome">{SKILL_STATE_WORDS[skill.state]}</span>
            </span>
            <span className="task-context-shaper-facts">
              {SKILL_WHEN_WORDS[skill.lifecyclePoint] ?? skill.lifecyclePoint} · routed by {routerLabel(skill.shaper)} ·{" "}
              {skill.verified ? "verified in the skill catalog" : "not verified"}
              {skill.repositories.length > 0 ? ` · ${skill.repositories.join(", ")}` : ""}
            </span>
            <span className="task-context-definition">
              Reason <code>{skill.reasonId}</code>
            </span>
            {skill.reason && <span className="task-context-reason">{skill.reason}</span>}
            {skill.state === "announced" && skill.lifecyclePoint === "after-work" && afterWork !== undefined && (
              <span className="task-context-note" role="note">{afterWorkPromptWords(afterWork, skill.name, loading)}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
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
