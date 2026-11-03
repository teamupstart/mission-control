import { useContext, useEffect, useState } from "react";
import { reportBucket } from "@shared/session.ts";
import type { Session } from "@shared/types.ts";
import type { ResidentLoopStatus, ResidentRunSummary } from "@shared/residents.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import { controlResident } from "./api.ts";
import type { ResidentSessionMark } from "./marker.ts";
import { ResidentRestartPromptContext } from "./restart-prompt.ts";

const actionDescriptions = {
  pause: "Pause automatic resident iterations after the current turn",
  resume: "Resume automatic resident iterations when guardrails allow",
  "run-now": "Request the next resident iteration now, subject to guardrails",
  restart: "Start a fresh resident run using the latest profile revision",
};

/**
 * A resident's loop: its state, iteration, next wake, why it paused or woke, and which
 * compaction layers its harness has. One sentence on the card, band and page; `tags` draws the
 * same facts for the dock's resident card - the short facts as tags, the reasons as the
 * sentences they are (a guardrail's reason runs to a full sentence, which no tag holds), and the
 * compaction layers as one line under them.
 */
export function ResidentLoopStatusLine({ loop, session, tags = false }: {
  loop: ResidentLoopStatus & Partial<Pick<ResidentRunSummary, "compaction">>;
  session?: Session | null;
  tags?: boolean;
}): React.JSX.Element {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (loop.nextWakeAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [loop.nextWakeAt]);
  const held = loop.loopState !== "paused" && session && reportBucket(session) === "needs-you";
  const label = held ? "waiting on you" : loop.loopState;
  const remaining = loop.nextWakeAt === null ? null : Math.max(0, Math.ceil((loop.nextWakeAt - now) / 1000));
  const next = held || remaining === null ? null : `next in ${remaining < 60 ? `${remaining}s` : `${Math.ceil(remaining / 60)}m`}`;
  if (tags) {
    const reasons = [loop.pauseReason, loop.wakeReason].filter((reason): reason is string => !!reason);
    return <span className="resident-loop-status resident-loop-tags" aria-label="Resident loop status">
      <span className="resident-loop-tag-row">
        <span className={`resident-loop-tag is-${loop.loopState}`}>{label}</span>
        <span className="resident-loop-tag">iteration {loop.iteration}</span>
        {next && <span className="resident-loop-tag">{next}</span>}
      </span>
      {reasons.map((reason) => <span key={reason} className="resident-loop-reason">{reason}</span>)}
      {loop.compaction && <span className="resident-compaction-layers">
        <span className="resident-compaction-layer">Compaction before wakes <b>{loop.compaction.betweenIterations ? "active" : "unavailable"}</b></span>
        {" · "}
        <span className="resident-compaction-layer">Native backstop <b>{loop.compaction.nativeBackstop ? "active" : "unavailable"}</b></span>
      </span>}
    </span>;
  }
  return <span className="resident-loop-status" aria-label="Resident loop status">
    {label} · iteration {loop.iteration}
    {next && ` · ${next}`}
    {loop.pauseReason && ` · ${loop.pauseReason}`}
    {loop.wakeReason && ` · ${loop.wakeReason}`}
    {loop.compaction && <span className="resident-compaction-layers">Compaction before wakes: {loop.compaction.betweenIterations ? "active" : "unavailable"}. Native backstop: {loop.compaction.nativeBackstop ? "active" : "unavailable"}.</span>}
  </span>;
}

/** Every resident surface sends the same run controls and renders the same refusal. */
export function ResidentLoopControls({ mark, menu = false }: { mark: ResidentSessionMark; menu?: boolean }): React.JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const promptToComplete = useContext(ResidentRestartPromptContext);
  if (!mark.loop) return null;
  const act = async (action: "pause" | "resume" | "run-now" | "restart") => {
    setBusy(true); setError(null);
    try {
      await controlResident(mark.runId, action);
      // Restart leaves the original task open; offer to complete it now, from wherever this was.
      if (action === "restart") promptToComplete?.(mark.taskId);
    }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  const paused = mark.loop.loopState === "paused";
  const button = (label: string, action: "pause" | "resume" | "run-now" | "restart") =>
    <Tooltip label={actionDescriptions[action]}>
      <button type="button" role={menu ? "menuitem" : undefined} className="btn btn-ghost" disabled={busy}
        onClick={() => void act(action)}>{label}</button>
    </Tooltip>;
  return <span className="resident-loop-controls" onClick={(event) => event.stopPropagation()}>
    {button(paused ? "Resume" : "Pause", paused ? "resume" : "pause")}
    {button("Run now", "run-now")}
    {mark.changedTo !== null && button("Restart on new profile", "restart")}
    {error && <span role="alert" className="resident-loop-error">{error}</span>}
  </span>;
}
