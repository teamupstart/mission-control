import { useEffect, useState } from "react";
import type { ResidentLoopStatus, ResidentRunSummary } from "@shared/residents.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import { controlResident } from "./api.ts";
import type { ResidentSessionMark } from "./marker.ts";

const actionDescriptions = {
  pause: "Pause automatic resident iterations after the current turn",
  resume: "Resume automatic resident iterations when guardrails allow",
  "run-now": "Request the next resident iteration now, subject to guardrails",
  restart: "Start a fresh resident run using the latest profile revision",
};

export function ResidentLoopStatusLine({ loop }: { loop: ResidentLoopStatus & Partial<Pick<ResidentRunSummary, "compaction">> }): React.JSX.Element {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (loop.nextWakeAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [loop.nextWakeAt]);
  const remaining = loop.nextWakeAt === null ? null : Math.max(0, Math.ceil((loop.nextWakeAt - now) / 1000));
  return <span className="resident-loop-status" aria-label="Resident loop status">
    {loop.loopState} · iteration {loop.iteration}
    {remaining !== null && ` · next in ${remaining < 60 ? `${remaining}s` : `${Math.ceil(remaining / 60)}m`}`}
    {loop.pauseReason && ` · ${loop.pauseReason}`}
    {loop.wakeReason && ` · ${loop.wakeReason}`}
    {loop.compaction && <span className="resident-compaction-layers">Compaction before wakes: {loop.compaction.betweenIterations ? "active" : "unavailable"}. Native backstop: {loop.compaction.nativeBackstop ? "active" : "unavailable"}.</span>}
  </span>;
}

/** Every resident surface sends the same run controls and renders the same refusal. */
export function ResidentLoopControls({ mark, menu = false }: { mark: ResidentSessionMark; menu?: boolean }): React.JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!mark.loop) return null;
  const act = async (action: "pause" | "resume" | "run-now" | "restart") => {
    setBusy(true); setError(null);
    try { await controlResident(mark.runId, action); }
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
