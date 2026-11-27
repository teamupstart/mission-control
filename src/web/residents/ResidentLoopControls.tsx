import { Fragment, useContext, useEffect, useState } from "react";
import type { Session } from "@shared/types.ts";
import { residentRestartRequestId } from "@shared/residents.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import { useFeatureFlag } from "../useFeatureFlag.ts";
import { authorizeResidentLaunch } from "../lib/session-control-authorization.ts";
import { controlResident, type ResidentControlAction } from "./api.ts";
import { residentLoopActions, residentLoopPresentation, type ResidentLoopDetails } from "./loop-presentation.ts";
import type { ResidentSessionMark } from "./marker.ts";
import { ResidentRestartPromptContext } from "./restart-prompt.ts";

const actionDescriptions = {
  pause: "Pause automatic resident iterations after the current turn",
  resume: "Resume automatic resident iterations when guardrails allow",
  "run-now": "Request the next resident iteration now, subject to guardrails. A busy resident runs it once idle",
  "cancel-run-now": "Drop the queued iteration; the resident keeps its normal cadence",
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
  loop: ResidentLoopDetails;
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
  const activeHours = useFeatureFlag("resident-active-hours");
  const { tone, label, iteration, next, queued, reasons, compaction, summary, compactionSummary } = residentLoopPresentation(loop, session, now, activeHours);
  if (tags) {
    return <span className="resident-loop-status resident-loop-tags" aria-label="Resident loop status">
      <span className="resident-loop-tag-row">
        <span className={`resident-loop-tag is-${tone}`}>{label}</span>
        <span className="resident-loop-tag">{iteration}</span>
        {next && <span className="resident-loop-tag">{next}</span>}
        {queued && <span className="resident-loop-tag is-queued">{queued}</span>}
      </span>
      {reasons.map((reason, index) => <span key={index} className="resident-loop-reason">{reason}</span>)}
      {compaction && <span className="resident-compaction-layers">
        {compaction.map((layer, index) => <Fragment key={layer.label}>
          {index > 0 && " · "}<span className="resident-compaction-layer">{layer.label} <b>{layer.status}</b></span>
        </Fragment>)}
      </span>}
    </span>;
  }
  return <span className="resident-loop-status" aria-label="Resident loop status">
    {summary}
    {compactionSummary && <span className="resident-compaction-layers">{compactionSummary}</span>}
  </span>;
}

export interface ResidentLoopFeedback {
  busy: boolean;
  error: string | null;
}

export interface ResidentLoopFeedbackBinding {
  value: ResidentLoopFeedback | undefined;
  onChange: (feedback: ResidentLoopFeedback) => void;
}

const idleFeedback: ResidentLoopFeedback = { busy: false, error: null };

/** Every resident surface sends the same run controls and renders the same refusal. */
export function ResidentLoopControls({ mark, menu = false, feedback }: {
  mark: ResidentSessionMark;
  menu?: boolean;
  feedback?: ResidentLoopFeedbackBinding;
}): React.JSX.Element | null {
  const [localFeedback, setLocalFeedback] = useState(idleFeedback);
  const { busy, error } = feedback ? feedback.value ?? idleFeedback : localFeedback;
  const setFeedback = feedback?.onChange ?? setLocalFeedback;
  const promptToComplete = useContext(ResidentRestartPromptContext);
  if (!mark.loop) return null;
  const act = async (action: ResidentControlAction) => {
    if (action === "restart" && mark.changedTo !== null) {
      // A replacement is a new launch. Arm its own click before awaiting anything; the
      // manager checks the new pinned revision's authority, never the old run's grant.
      authorizeResidentLaunch({
        requestId: residentRestartRequestId(mark.runId),
        profileId: mark.profileId,
        revision: mark.changedTo,
      });
    }
    setFeedback({ busy: true, error: null });
    let failure: string | null = null;
    try {
      await controlResident(mark.runId, action);
      // Restart leaves the original task open; offer to complete it now, from wherever this was.
      if (action === "restart") promptToComplete?.(mark.taskId);
    }
    catch (err) { failure = err instanceof Error ? err.message : String(err); }
    finally { setFeedback({ busy: false, error: failure }); }
  };
  // The click only stops propagation so a press does not also open the row beneath.
  return <span className="resident-loop-controls" role="presentation" onClick={(event) => event.stopPropagation()}>
    {residentLoopActions(mark).map(({ label, action }, index) => (
      <Tooltip key={index} label={actionDescriptions[action]}>
        <button type="button" role={menu ? "menuitem" : undefined} className="btn btn-ghost" disabled={busy}
          onClick={() => void act(action)}>{label}</button>
      </Tooltip>
    ))}
    {error && <span role="alert" className="resident-loop-error">{error}</span>}
  </span>;
}
