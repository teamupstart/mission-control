import { useState } from "react";
import type { NmFinding, NmRunSummary } from "@shared/types.ts";
import { api } from "../lib/api.ts";

const STEP_TONE: Record<string, string> = {
  completed: "nm-done",
  running: "nm-run",
  awaiting_approval: "nm-gate",
  fix_review: "nm-gate",
  pending: "nm-pending",
  skipped: "nm-skip",
  failed: "nm-fail",
};

/**
 * Compact surface of a no-mistakes run for a gated repo: the pipeline as status
 * dots, the active stage and findings summary while it runs, a live narration of
 * what the skill is doing now (from the session's transcript), the gate it's
 * parked at, and the findings. The active-stage, summary, and narration lines
 * hide while parked.
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

      {nm.steps.length > 0 && (
        <div className="nm-pipe" role="list">
          {nm.steps.map((s, i) => (
            <span
              key={i}
              role="listitem"
              className={`nm-dot ${STEP_TONE[s.status] ?? "nm-pending"}`}
              title={`${s.step}: ${s.status}${s.findings ? ` · ${s.findings} finding${s.findings > 1 ? "s" : ""}` : ""}`}
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

      {nm.gateStep && needsYou && <GateActions sessionId={sessionId} findings={nm.findings} />}
    </div>
  );
}

function FindingRow({ f }: { f: NmFinding }): React.JSX.Element {
  return (
    <li>
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
  findings,
}: {
  sessionId: string;
  findings: NmFinding[];
}): React.JSX.Element {
  const [mode, setMode] = useState<Mode>("idle");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [instructions, setInstructions] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set(findings.map((f) => f.id)));

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
      setMode("idle");
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

  if (mode === "fix") {
    return (
      <div className="nm-fix">
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
      </div>
    );
  }

  if (mode === "confirm-approve" || mode === "confirm-skip") {
    const action = mode === "confirm-approve" ? "approve" : "skip";
    return (
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
    );
  }

  return (
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
  );
}
