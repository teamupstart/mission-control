import type {
  EnsembleMember,
  EnsembleRun,
  EnsembleStageAttempt,
  EnsembleSummary,
} from "@shared/ensemble.ts";
import { projectEnsemblePipeline } from "./pipeline.ts";

export function EnsemblePipeline({
  run,
  summary,
  members,
  stageAttempts,
}: {
  run: EnsembleRun;
  summary?: EnsembleSummary | null;
  members: readonly EnsembleMember[];
  stageAttempts: readonly EnsembleStageAttempt[];
}): React.JSX.Element | null {
  const view = projectEnsemblePipeline({
    run,
    summary,
    stageAttempts,
    memberCount: members.length,
  });
  if (view.steps.length === 0) return null;

  return (
    <section className="ensemble-pipeline" aria-label="Run pipeline">
      <ol>
        {view.steps.map((step, index) => (
          <li
            key={step.id}
            className={`ensemble-pipeline-step is-${step.state}`}
            // A blocked step is still where the run IS, so it keeps `aria-current`: the run
            // stopped at it, it did not move past it.
            aria-current={step.state === "active" || step.state === "blocked" ? "step" : undefined}
          >
            <span className="ensemble-pipeline-marker" aria-hidden>
              {step.state === "complete" ? "✓" : index + 1}
            </span>
            <span className="ensemble-pipeline-copy">
              <strong>{step.label}</strong>
              {step.detail && <span>{step.detail}</span>}
            </span>
          </li>
        ))}
      </ol>
      {view.barrier && (
        <p className="ensemble-pipeline-barrier" role="status">
          {view.barrier}
        </p>
      )}
    </section>
  );
}
