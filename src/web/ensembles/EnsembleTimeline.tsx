import type { EnsembleRunDetailResponse } from "./types.ts";
import { relativeTime } from "../lib/format.ts";
import { titleCaseEnum } from "./format.ts";

/**
 * The run's orchestration history: stage attempts (with their retries and errors), the
 * evaluations they scheduled, the human decisions recorded, and the append-only event log.
 * This is the generic, strategy-neutral view of what the engine did; the strategy result view
 * renders the MEANING of an evaluation, this renders that it happened.
 */
export function EnsembleTimeline({
  detail,
}: {
  detail: EnsembleRunDetailResponse;
}): React.JSX.Element {
  const stages = [...detail.stageAttempts].sort((a, b) => a.createdAt - b.createdAt);
  const events = [...detail.events].sort((a, b) => b.ts - a.ts);
  return (
    <div className="ensemble-timeline">
      {stages.length > 0 && (
        <div className="ensemble-timeline-block">
          <h5>Stages</h5>
          <ul className="ensemble-stage-list">
            {stages.map((stage) => (
              <li key={stage.id} className={`ensemble-stage ensemble-stage-${stage.status ?? "unknown"}`}>
                <span className="ensemble-stage-kind">{stage.driverKind ?? "stage"}</span>
                <code className="ensemble-stage-id">{stage.stageId}</code>
                <span className="ensemble-stage-attempt">attempt {stage.attempt}</span>
                <span className="ensemble-pill">
                  {stage.status ? titleCaseEnum(stage.status) : "Unknown"}
                </span>
                {stage.error && <span className="ensemble-stage-error">{stage.error}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {detail.evaluations.length > 0 && (
        <div className="ensemble-timeline-block">
          <h5>Evaluations</h5>
          <div className="ensemble-table-scroll">
            <table className="ensemble-table">
              <thead>
                <tr>
                  <th>Method</th>
                  <th>Runner · model</th>
                  <th>Subjects</th>
                  <th>Attempt</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {detail.evaluations.map((evaluation) => (
                  <tr key={evaluation.id}>
                    <td>{evaluation.method}</td>
                    <td>
                      {evaluation.runnerId ?? "-"}
                      {evaluation.modelId ? ` · ${evaluation.modelId}` : ""}
                    </td>
                    <td>{evaluation.subjectArtifactIds.length}</td>
                    <td>{evaluation.attempt}</td>
                    <td>{evaluation.status ? titleCaseEnum(evaluation.status) : "Unknown"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {detail.decisions.length > 0 && (
        <div className="ensemble-timeline-block">
          <h5>Decisions</h5>
          <ul className="ensemble-decision-log">
            {[...detail.decisions]
              .sort((a, b) => b.version - a.version)
              .map((decision) => (
                <li key={decision.id}>
                  <span className="ensemble-pill">
                    {decision.status ? titleCaseEnum(decision.status) : "Unknown"}
                  </span>
                  <span>
                    {decision.actor ? titleCaseEnum(decision.actor) : "Unknown"} · v{decision.version}
                  </span>
                  {decision.rationale && <p className="ensemble-decision-rationale">{decision.rationale}</p>}
                </li>
              ))}
          </ul>
        </div>
      )}

      {events.length > 0 && (
        <div className="ensemble-timeline-block">
          <h5>Events</h5>
          <ul className="ensemble-event-log">
            {events.map((event) => (
              <li key={event.id}>
                <span className="ensemble-event-kind">{event.kind}</span>
                <span className="ensemble-muted">{relativeTime(event.ts)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
