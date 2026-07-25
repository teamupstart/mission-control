import { useState } from "react";
import type {
  EnsembleBarrierSpec,
  EnsembleFinalizationProgress,
  EnsembleJson,
} from "@shared/ensemble.ts";
import type { EnsembleRunDetailResponse } from "./types.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import { relativeTime } from "../lib/format.ts";
import { shortSha, titleCaseEnum } from "./format.ts";

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
  const planStages = detail.run.plan?.stages ?? [];
  return (
    <div className="ensemble-timeline">
      {planStages.length > 0 && (
        <div className="ensemble-timeline-block">
          <h5>Stage plan</h5>
          <ul className="ensemble-stage-plan">
            {planStages.map((stage) => (
              <li key={stage.id} className="ensemble-stage-plan-item">
                <div className="ensemble-stage-plan-head">
                  <strong>{stage.label}</strong>
                  <code>{stage.id}</code>
                  <span className="ensemble-pill">{titleCaseEnum(stage.driverKind)}</span>
                  <span className="ensemble-muted">
                    {stage.maxAttempts} {stage.maxAttempts === 1 ? "attempt" : "attempts"} max
                  </span>
                </div>
                <dl className="ensemble-stage-plan-facts">
                  <div>
                    <dt>Dependencies</dt>
                    <dd>{stage.dependsOn.length > 0 ? stage.dependsOn.join(", ") : "None"}</dd>
                  </div>
                  <div>
                    <dt>Barrier</dt>
                    <dd>{barrierLabel(stage.barrier)}</dd>
                  </div>
                  <div>
                    <dt>Driver</dt>
                    <dd><code>{stage.driverKey}</code></dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        </div>
      )}

      {stages.length > 0 && (
        <div className="ensemble-timeline-block">
          <h5>Stage attempts</h5>
          <ul className="ensemble-stage-list">
            {stages.map((stage) => (
              <li key={stage.id} className={`ensemble-stage ensemble-stage-${stage.status ?? "unknown"}`}>
                <span className="ensemble-stage-kind">{stage.driverKind ?? "stage"}</span>
                <code className="ensemble-stage-id">{stage.stageId}</code>
                <span className="ensemble-stage-attempt">attempt {stage.attempt}</span>
                <span className="ensemble-pill">
                  {stage.status ? titleCaseEnum(stage.status) : "Unknown"}
                </span>
                <span className="ensemble-stage-command">
                  command <code>{stage.commandKey}</code>
                </span>
                {stage.error && <span className="ensemble-stage-error">{stage.error}</span>}
                <StagePayloads input={stage.input} output={stage.output} />
                {stage.driverKind === "finalize" && (
                  <FinalizationReceipt progress={readFinalizationProgress(stage.output)} />
                )}
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
                  <th>Error</th>
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
                    <td>
                      {evaluation.error ? (
                        <span className="ensemble-stage-error">{evaluation.error}</span>
                      ) : (
                        "-"
                      )}
                    </td>
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

function barrierLabel(barrier: EnsembleBarrierSpec): string {
  switch (barrier.kind) {
    case "none":
      return "None";
    case "members_settled":
      return `${barrier.minEligible} eligible from ${barrier.roleKeys.join(", ")}; requires ${barrier.requiredArtifacts.join(", ")}`;
    case "stages_succeeded":
      return `Stages succeeded: ${barrier.stageIds.join(", ")}`;
    case "human_decision":
      return "Human decision";
  }
}

function StagePayloads({
  input,
  output,
}: {
  input: EnsembleJson;
  output: EnsembleJson | null;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const inputView = boundedJson(input);
  const outputView = boundedJson(output);
  return (
    <div className="ensemble-stage-payloads">
      <Tooltip label={open ? "Hide this stage's bounded input and output" : "Show this stage's bounded input and output"}>
        <button
          className="btn btn-ghost"
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Hide input and output" : "Show input and output"}
        </button>
      </Tooltip>
      {open && (
        <div className="ensemble-stage-payload-grid">
          <div className="ensemble-stage-payload">
            <h6>Input</h6>
            <pre>{inputView.text}</pre>
            {inputView.truncated && <p className="ensemble-muted">Input truncated for display.</p>}
          </div>
          <div className="ensemble-stage-payload">
            <h6>Output</h6>
            <pre>{outputView.text}</pre>
            {outputView.truncated && <p className="ensemble-muted">Output truncated for display.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function boundedJson(value: EnsembleJson | null): { text: string; truncated: boolean } {
  const serialized = JSON.stringify(value, null, 2) ?? "null";
  const limit = 20_000;
  if (serialized.length <= limit) return { text: serialized, truncated: false };
  return {
    text: `${serialized.slice(0, limit)}\n…`,
    truncated: true,
  };
}

function FinalizationReceipt({
  progress,
}: {
  progress: EnsembleFinalizationProgress | null;
}): React.JSX.Element {
  if (!progress) {
    return <p className="ensemble-muted">No durable finalization receipt yet.</p>;
  }
  return (
    <div className="ensemble-finalization-progress" aria-live="polite">
      <h6>Finalization</h6>
      <dl>
        <div>
          <dt>Resume step</dt>
          <dd>{titleCaseEnum(progress.step)}</dd>
        </div>
        <div>
          <dt>Verified snapshot</dt>
          <dd>{progress.verifiedSnapshotSha ? <code>{shortSha(progress.verifiedSnapshotSha)}</code> : "Not yet"}</dd>
        </div>
        <div>
          <dt>Winner</dt>
          <dd>
            {progress.winner
              ? `${titleCaseEnum(progress.winner.mode)} · ${progress.winner.ready ? "ready" : "pending"}`
              : "Not materialized"}
          </dd>
        </div>
        <div>
          <dt>Losers reaped</dt>
          <dd>{progress.losersReaped ? "Yes" : "No"}</dd>
        </div>
        <div>
          <dt>Continuation</dt>
          <dd>
            {progress.continuationDelivered
              ? "Delivered"
              : progress.continuationInIntent
                ? "Included in replacement intent"
                : "Pending"}
          </dd>
        </div>
      </dl>
      {progress.error && <p className="ensemble-stage-error" role="alert">{progress.error}</p>}
    </div>
  );
}

const FINALIZATION_STEPS = [
  "verifying",
  "materializing",
  "reaping_losers",
  "handoff",
  "completed",
] as const;

function readFinalizationProgress(output: unknown): EnsembleFinalizationProgress | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const value = output as Record<string, unknown>;
  if (
    typeof value.step !== "string" ||
    !(FINALIZATION_STEPS as readonly string[]).includes(value.step)
  ) {
    return null;
  }
  const rawWinner = value.winner;
  const winner =
    rawWinner &&
    typeof rawWinner === "object" &&
    !Array.isArray(rawWinner) &&
    ((rawWinner as Record<string, unknown>).mode === "restored" ||
      (rawWinner as Record<string, unknown>).mode === "replacement")
      ? {
          mode: (rawWinner as Record<string, unknown>).mode as "restored" | "replacement",
          ready: (rawWinner as Record<string, unknown>).ready === true,
        }
      : null;
  return {
    step: value.step as EnsembleFinalizationProgress["step"],
    verifiedSnapshotSha:
      typeof value.verifiedSnapshotSha === "string" ? value.verifiedSnapshotSha : null,
    winner,
    continuationInIntent: value.continuationInIntent === true,
    losersReaped: value.losersReaped === true,
    continuationDeliveryKey:
      typeof value.continuationDeliveryKey === "string"
        ? value.continuationDeliveryKey
        : null,
    continuationDelivered: value.continuationDelivered === true,
    error: typeof value.error === "string" ? value.error : null,
  };
}
