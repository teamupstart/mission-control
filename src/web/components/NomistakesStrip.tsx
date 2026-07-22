import { useEffect, useState } from "react";
import type { NmActiveStep, NmFinding, NmRunSummary, NmStep } from "@shared/types.ts";
import { api } from "../lib/api.ts";
import { duration } from "../lib/format.ts";

const STEP_TONE: Record<string, string> = {
  completed: "nm-done",
  running: "nm-run",
  awaiting_approval: "nm-gate",
  fix_review: "nm-gate",
  pending: "nm-pending",
  skipped: "nm-skip",
  failed: "nm-fail",
};

/** The active-step record for `step`, or null when no-mistakes doesn't claim it's active. */
function activeFor(nm: NmRunSummary, step: NmStep | null): NmActiveStep | null {
  if (!step) return null;
  return nm.activeSteps.find((a) => a.step === step.step) ?? null;
}

/**
 * Compact surface of a no-mistakes run for a gated repo: the pipeline as status
 * dots, the active stage and findings summary while it runs, what that stage last
 * did in no-mistakes' own words, a live narration of what the skill is doing now
 * (from the session's transcript), the gate it's parked at, and the findings. The
 * active-stage, summary, and narration lines hide while parked.
 *
 * A parked gate is `awaiting_agent` - the run is waiting on the agent's
 * `axi respond`, which the `/no-mistakes` skill issues autonomously. So we only
 * prompt YOU (attention framing + approve / fix / skip buttons) when `needsYou`
 * says the agent has actually stopped at the gate; while it's still driving the
 * pipeline we show the same gate as a calm "agent resolving" line. The buttons
 * take the same decisions `no-mistakes axi respond` does; approve/skip confirm
 * first since they advance the pipeline toward pushing your branch.
 */
export function NomistakesStrip({
  sessionId,
  nm,
  needsYou,
  narration,
}: {
  sessionId: string;
  nm: NmRunSummary;
  needsYou: boolean;
  narration?: string | null;
}): React.JSX.Element {
  const label = nm.outcome ?? nm.status;
  // The active pipeline stage: the step currently running (only present when the
  // run isn't parked at a gate - that gets its own line below).
  const runningIdx = nm.steps.findIndex((s) => s.status === "running");
  const running = runningIdx >= 0 ? nm.steps[runningIdx]! : null;
  // What no-mistakes says that step is actually doing. The dots only carry a status,
  // and "running" is the same word for a step mid-work and a `ci` step that has been
  // watching an open PR for three hours - this line is what tells them apart.
  const active = activeFor(nm, running);
  return (
    <div className="nm-strip">
      <div className="nm-head">
        <span className="nm-brand">◇ no-mistakes</span>
        <span className={`nm-status nm-status-${nm.outcome ? "done" : nm.status}`}>{label}</span>
        {nm.awaitingAgent ? (
          <span className={needsYou ? "nm-parked" : "nm-resolving"}>{nm.awaitingAgent}</span>
        ) : (
          nm.findingsSummary && <span className="nm-summary">{nm.findingsSummary}</span>
        )}
      </div>

      <NmDuration nm={nm} />

      {running && (
        <div className="nm-stage">
          <strong>{running.step}</strong>
          <span className="nm-stage-pos">
            {" · "}
            step {runningIdx + 1} of {nm.steps.length}
          </span>
          {running.findings > 0 && (
            <span className="nm-stage-find">
              {" · "}
              {running.findings} finding{running.findings > 1 ? "s" : ""} so far
            </span>
          )}
        </div>
      )}

      {/* What that step last did, in no-mistakes' own words. This is the whole
          answer to "the PR is up and green, so why is this still blue?" - the `ci`
          step says it outright: "all CI checks passed - still monitoring until
          merged or closed". A dot can't say that; this line can. */}
      {active?.lastActivity && (
        <div
          className="nm-lastact"
          title={`${active.step} · active ${active.activeFor} · ${active.lastActivity}`}
        >
          ↳ {active.lastActivity}
        </div>
      )}

      {nm.steps.length > 0 && (
        <div className="nm-pipe" role="list">
          {nm.steps.map((s, i) => (
            <span
              key={i}
              role="listitem"
              className={`nm-dot ${STEP_TONE[s.status] ?? "nm-pending"}`}
              title={`${s.step}: ${s.status}${s.findings ? ` · ${s.findings} finding${s.findings > 1 ? "s" : ""}` : ""}${s.step === active?.step ? ` · ${active.lastActivity}` : ""}`}
            />
          ))}
        </div>
      )}

      {narration && !nm.gateStep && !nm.outcome && (
        <div className="nm-narration" title={narration}>
          ↳ {narration}
        </div>
      )}

      {nm.gateStep && (
        <div className={needsYou ? "nm-gateline" : "nm-gateline nm-gateline-calm"}>
          {needsYou ? "⏸ parked at " : "◷ agent resolving "}
          <strong>{nm.gateStep}</strong>
          {nm.gateSummary ? ` · ${nm.gateSummary}` : ""}
          {nm.gateRisk ? ` · ${nm.gateRisk} risk` : ""}
        </div>
      )}

      {nm.findings.length > 0 && (
        <ul className="nm-findings">
          {nm.findings.slice(0, 4).map((f) => (
            <FindingRow key={f.id} f={f} />
          ))}
          {nm.findings.length > 4 && <li className="dim">+{nm.findings.length - 4} more</li>}
        </ul>
      )}

      {nm.gateStep && needsYou && <GateActions sessionId={sessionId} nm={nm} />}
    </div>
  );
}

/**
 * `Date.now()`, re-read every second while `live`. A stopped clock keeps no timer,
 * so a finished run's strip costs nothing - and this is its own component (rather
 * than state on the card) so a second's tick re-renders the one line that moved,
 * not the whole session card.
 */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now()); // catch up on whatever passed while it wasn't ticking
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live]);
  return now;
}

/**
 * How long the run has been going, ticking each second - the wall-clock answer to
 * "is this gate taking too long?". Deliberately wall-clock: it counts the time a
 * run spends parked at a gate or waiting on the agent, because that time is just
 * as gone as the time spent running steps.
 *
 * A finished run freezes at what it took. It shows nothing at all when the run
 * can't be dated - an id that isn't a ULID, or a run already over when the daemon
 * first saw it (see timeRun) - since a wrong duration reads as truth.
 */
function NmDuration({ nm }: { nm: NmRunSummary }): React.JSX.Element | null {
  const live = nm.status === "running" && nm.startedAt != null;
  const now = useNow(live);
  if (nm.startedAt == null) return null;
  const end = live ? now : nm.endedAt;
  if (end == null) return null;
  const text = duration(end - nm.startedAt);
  return (
    <div
      className={`nm-elapsed${live ? " nm-elapsed-live" : ""}`}
      title={
        live
          ? `This no-mistakes run has been going ${text} (started ${new Date(nm.startedAt).toLocaleTimeString()})`
          : `This no-mistakes run took ${text}`
      }
    >
      <span className="nm-elapsed-glyph" aria-hidden>
        ◷
      </span>
      <span className="nm-elapsed-label">{live ? "running for" : "took"}</span>
      <span className="nm-elapsed-time mono">{text}</span>
    </div>
  );
}

function FindingRow({ f }: { f: NmFinding }): React.JSX.Element {
  return (
    <li title={f.description}>
      <span className={`nm-sev nm-sev-${f.severity}`}>{f.severity}</span>
      <span className="mono nm-file">{f.file}</span>
      <span className={`nm-actiontag nm-action-${f.action}`}>{f.action}</span>
      <span className="nm-desc">{f.description}</span>
    </li>
  );
}

type Mode = "idle" | "confirm-approve" | "confirm-skip" | "fix";

function GateActions({
  sessionId,
  nm,
}: {
  sessionId: string;
  nm: NmRunSummary;
}): React.JSX.Element {
  const findings = nm.findings;
  const findingKey = `${nm.id}:${nm.gateStep ?? ""}:${findings.map((f) => f.id).join(",")}`;
  const [mode, setMode] = useState<Mode>("idle");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [instructions, setInstructions] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set(findings.map((f) => f.id)));
  const [accepted, setAccepted] = useState<{
    action: "approve" | "fix" | "skip";
    findingIds: string[];
    findingKey: string;
  } | null>(null);

  // One review step can park repeatedly. A successful fix advances to a new set of
  // findings while the terminal still shows the prose from the prior round, so reset
  // the form from the finding identity rather than carrying its old checkboxes forward.
  useEffect(() => {
    setMode("idle");
    setErr(null);
    setInstructions("");
    setSelected(new Set(findings.map((f) => f.id)));
    setAccepted(null);
    // `findings` is represented by findingKey; depending on the array would reset on
    // every SSE snapshot even when the gate itself did not move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findingKey]);

  async function send(action: "approve" | "fix" | "skip"): Promise<void> {
    setBusy(true);
    setErr(null);
    const opts =
      action === "fix"
        ? { findings: [...selected], instructions: instructions.trim() || undefined }
        : {};
    const r = await api.nomistakesRespond(sessionId, action, opts);
    setBusy(false);
    if (r.ok) {
      setAccepted({ action, findingIds: action === "fix" ? [...selected] : [], findingKey });
      setInstructions("");
    } else {
      setErr(r.error ?? "failed");
    }
  }

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const submitting = nm.response?.status === "submitting" ? nm.response : null;
  const locallyAccepted = !nm.response && accepted?.findingKey === findingKey ? accepted : null;
  if (submitting || locallyAccepted) {
    const action = submitting?.action ?? locallyAccepted!.action;
    const ids = submitting?.findingIds ?? locallyAccepted!.findingIds;
    return (
      <div className="nm-submit-state" role="status">
        <strong>{action === "fix" ? "Fix submitted" : `${action} submitted`}</strong>
        {ids.length > 0 && <span className="mono"> {ids.join(", ")}</span>}
        <span> · waiting for no-mistakes to reach the next gate or finish.</span>
        <span className="dim"> The terminal can still show the earlier question while this runs.</span>
      </div>
    );
  }

  const prior = nm.response?.status === "submitted" ? nm.response : null;
  const roundNote = prior ? (
    <div className="nm-round-note">
      <strong>Previous {prior.action === "fix" ? "fix" : prior.action} submitted:</strong>{" "}
      {prior.findingIds.length > 0 && <span className="mono">{prior.findingIds.join(", ")}. </span>}
      The findings above are a newer review round and may not match the terminal&apos;s earlier question.
    </div>
  ) : null;

  if (mode === "fix") {
    return (
      <div className="nm-fix">
        {roundNote}
        {findings.length > 1 && (
          <div className="nm-fixsel">
            {findings.map((f) => (
              <label key={f.id} className="nm-check">
                <input type="checkbox" checked={selected.has(f.id)} onChange={() => toggle(f.id)} />
                <span className="mono">{f.id}</span>
              </label>
            ))}
          </div>
        )}
        <input
          className="nm-instr"
          placeholder="Optional guidance for the fix…"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
        <div className="nm-actrow">
          <button
            className="btn btn-send"
            disabled={busy || selected.size === 0}
            onClick={() => void send("fix")}
          >
            Fix {selected.size} finding{selected.size === 1 ? "" : "s"}
          </button>
          <button className="btn btn-ghost" onClick={() => setMode("idle")}>
            Cancel
          </button>
        </div>
        {err && <span className="nm-err">{err}</span>}
        {nm.response?.status === "failed" && (
          <span className="nm-err">{nm.response.error ?? "submission failed"}</span>
        )}
      </div>
    );
  }

  if (mode === "confirm-approve" || mode === "confirm-skip") {
    const action = mode === "confirm-approve" ? "approve" : "skip";
    return (
      <div>
        {roundNote}
        <div className="nm-actrow">
          <span className="nm-warn">
            {action === "approve"
              ? "Advance the pipeline (may push & open a PR)?"
              : "Skip this check?"}
          </span>
          <button className="btn btn-approve" disabled={busy} onClick={() => void send(action)}>
            Confirm {action}
          </button>
          <button className="btn btn-ghost" onClick={() => setMode("idle")}>
            Cancel
          </button>
          {err && <span className="nm-err">{err}</span>}
        </div>
      </div>
    );
  }

  return (
    <div>
      {roundNote}
      {nm.response?.status === "failed" && (
        <div className="nm-err">
          The last response was not delivered: {nm.response.error ?? "submission failed"}
        </div>
      )}
      <div className="nm-actrow">
        <button className="btn btn-approve" onClick={() => setMode("confirm-approve")}>
          Approve
        </button>
        <button className="btn btn-send" onClick={() => setMode("fix")}>
          Fix
        </button>
        <button className="btn" onClick={() => setMode("confirm-skip")}>
          Skip
        </button>
        {err && <span className="nm-err">{err}</span>}
      </div>
    </div>
  );
}
