import { useState } from "react";
import type {
  EnsembleBarrierSpec,
  EnsembleEvaluation,
  EnsembleFinalizationProgress,
  EnsembleJson,
  EnsembleLlmCall,
} from "@shared/ensemble.ts";
import type { EnsembleRunDetailResponse } from "./types.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import { duration, fmtUsd, relativeTime } from "../lib/format.ts";
import { fmtBytes, shortSha, titleCaseEnum } from "./format.ts";

/**
 * The run's orchestration history: stage attempts (with their retries and errors), the
 * evaluations they scheduled, the human decisions recorded, and the append-only event log.
 * This is the generic, strategy-neutral view of what the engine did; the strategy result view
 * renders the MEANING of an evaluation, this renders that it happened.
 */
export function EnsembleTimeline({
  detail,
  subjectLabel,
}: {
  detail: EnsembleRunDetailResponse;
  subjectLabel: (artifactId: string) => string;
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
          <ul className="ensemble-evaluation-list">
            {detail.evaluations.map((evaluation) => (
              <EvaluationEvidence
                key={evaluation.id}
                evaluation={evaluation}
                calls={detail.llmCalls.filter((call) => call.evaluationId === evaluation.id)}
                subjectLabel={subjectLabel}
              />
            ))}
          </ul>
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

function EvaluationEvidence({
  evaluation,
  calls,
  subjectLabel,
}: {
  evaluation: EnsembleEvaluation;
  calls: EnsembleLlmCall[];
  subjectLabel: (artifactId: string) => string;
}): React.JSX.Element {
  const uncertainty = evaluationUncertainty(evaluation.result?.body ?? null, subjectLabel);
  const orderedCalls = [...calls].sort(
    (a, b) => a.attempt - b.attempt || a.startedAt - b.startedAt,
  );
  return (
    <li className="ensemble-evaluation">
      <div className="ensemble-evaluation-head">
        <strong>{evaluation.method}</strong>
        <span className="ensemble-pill">
          {evaluation.status ? titleCaseEnum(evaluation.status) : "Unknown"}
        </span>
        <span>attempt {evaluation.attempt}</span>
        <span>
          Actual provider · model: {evaluation.runnerId ?? "unknown"} ·{" "}
          {evaluation.modelId ?? "unknown"}
        </span>
      </div>
      {evaluation.error && <p className="ensemble-stage-error">{evaluation.error}</p>}

      <div className="ensemble-evaluation-section">
        <h6>Subject artifact set</h6>
        <ul className="ensemble-evaluation-subjects">
          {evaluation.subjectArtifactIds.map((artifactId) => (
            <li key={artifactId}>
              <span>{subjectLabel(artifactId)}</span>
              <code>{artifactId}</code>
            </li>
          ))}
        </ul>
      </div>

      <div className="ensemble-evaluation-section">
        <h6>LLM call attempts</h6>
        {orderedCalls.length > 0 ? (
          <div className="ensemble-table-scroll ensemble-evaluation-calls">
            <table className="ensemble-table">
              <thead>
                <tr>
                  <th>Attempt</th>
                  <th>Provider · model</th>
                  <th>State</th>
                  <th>Duration</th>
                  <th>Input / output</th>
                  <th>Cost</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {orderedCalls.map((call) => (
                  <tr key={call.id}>
                    <td>{call.attempt}</td>
                    <td>{call.runnerId} · {call.modelId}</td>
                    <td>{call.state ? titleCaseEnum(call.state) : "Unknown"}</td>
                    <td>{call.durationMs === null ? "-" : duration(call.durationMs)}</td>
                    <td>{fmtBytes(call.inputBytes)} / {fmtBytes(call.outputBytes)}</td>
                    <td>{call.costUsd === null ? "Not reported" : fmtUsd(call.costUsd)}</td>
                    <td>{call.errorCode ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="ensemble-muted">No LLM calls recorded for this evaluation.</p>
        )}
      </div>

      <div className="ensemble-evaluation-section">
        <h6>Uncertainty</h6>
        {uncertainty.length > 0 ? (
          <ul className="ensemble-evaluation-uncertainty">
            {uncertainty.map((item, index) => <li key={index}>{item}</li>)}
          </ul>
        ) : (
          <p className="ensemble-muted">No explicit uncertainty fields recorded.</p>
        )}
      </div>

      {evaluation.result && (
        <EvaluationResultPayload
          payloadVersion={evaluation.result.payloadVersion}
          body={evaluation.result.body}
        />
      )}
    </li>
  );
}

function evaluationUncertainty(
  body: EnsembleJson,
  subjectLabel: (artifactId: string) => string,
): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const record = body as Record<string, EnsembleJson>;
  const items: string[] = [];
  if (record.evidenceTruncated === true) {
    items.push("Artifact evidence was truncated.");
  }
  if (Array.isArray(record.caveats)) {
    for (const caveat of record.caveats) {
      if (typeof caveat === "string") items.push(caveat);
    }
  }
  if (typeof record.uncertainty === "string") {
    items.push(record.uncertainty);
  } else if (Array.isArray(record.uncertainty)) {
    for (const uncertainty of record.uncertainty) {
      if (typeof uncertainty === "string") items.push(uncertainty);
    }
  }
  if (typeof record.confidence === "number") {
    items.push(`Confidence: ${Math.round(record.confidence * 100)}%`);
  }
  if (Array.isArray(record.scorecards)) {
    for (const scorecard of record.scorecards) {
      if (!scorecard || typeof scorecard !== "object" || Array.isArray(scorecard)) continue;
      const artifactId = scorecard.artifactId;
      const confidence = scorecard.confidence;
      if (typeof artifactId === "string" && typeof confidence === "number") {
        items.push(`${subjectLabel(artifactId)} confidence: ${Math.round(confidence * 100)}%`);
      }
    }
  }
  return items.slice(0, 50);
}

function EvaluationResultPayload({
  payloadVersion,
  body,
}: {
  payloadVersion: number;
  body: EnsembleJson;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="ensemble-evaluation-result">
      <Tooltip label={open ? "Hide this evaluation's bounded result payload" : "Show this evaluation's bounded result payload"}>
        <button
          className="btn btn-ghost"
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Hide result payload" : `Show result payload · v${payloadVersion}`}
        </button>
      </Tooltip>
      {open && <EvaluationResultBody body={body} />}
    </div>
  );
}

function EvaluationResultBody({ body }: { body: EnsembleJson }): React.JSX.Element {
  const view = boundedJson(body);
  return (
    <>
      <pre>{view.text}</pre>
      {view.truncated && <p className="ensemble-muted">Result payload truncated for display.</p>}
    </>
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
        <StagePayloadEvidence input={input} output={output} />
      )}
    </div>
  );
}

function StagePayloadEvidence({
  input,
  output,
}: {
  input: EnsembleJson;
  output: EnsembleJson | null;
}): React.JSX.Element {
  const inputView = boundedJson(input);
  const outputView = boundedJson(output);
  return (
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
