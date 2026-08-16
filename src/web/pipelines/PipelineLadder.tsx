import {
  PIPELINE_HALT_CLASS_INFO,
  PIPELINE_PROVIDER_INFO,
  pipelineStepInfo,
  type PipelineGateVerdict,
  type PipelineRun,
  type SessionPipelineLink,
} from "@shared/pipeline.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import { PipelineStatusChip, Rung } from "../workflows/pipeline-bits.tsx";
import {
  PIPELINE_GROUP_LABELS,
  PIPELINE_GROUP_TONES,
  pipelineEyebrow,
  pipelinePhaseStatus,
  pipelineStepStatus,
  pipelineStrip,
  pipelineVerdictStatus,
  type PipelinePhaseCard,
  type PipelineStepRow,
} from "./pipeline-run-model.ts";

/**
 * One pipeline run, read as the VERTICAL ladder the conversation window draws.
 *
 * The pipeline twin of `WorkflowLadder`, and deliberately the same component vocabulary
 * rather than a lookalike: the rungs are the shared `Rung`, the status chips are the shared
 * `PipelineStatusChip`, and the phase model is the one the horizontal detail on the Runs page
 * folds (`pipelineStrip`). An operator who has read one ladder can read this one, and the two
 * cannot drift on what "Done, 2 skipped" means, because neither derives it.
 *
 * WHY A LADDER RATHER THAN THE STRIP. The Runs page has a page's width and draws the run
 * horizontally; this pane is a column beside a conversation. The workflow reader made exactly
 * this call for exactly this reason, and the second surface repeating it is the whole point of
 * decision 5 in the plan.
 *
 * PHASE GROUPS ARE COLLAPSIBLE, and they arrive collapsed except for the one the run is in.
 * A 22-step engine drawn flat is a column of rungs longer than the conversation beside it,
 * and the question this pane answers is "where is my agent up to" - which is one phase.
 *
 * A pure renderer. Fetch ownership stays in `SessionWorkflowsPane`'s host, which is the same
 * split `WorkflowLadder`/`WorkflowLadderPanel` make.
 */
export function PipelineLadder({
  link,
  run,
  gates,
  onOpenRun,
}: {
  /** The session's own correlation - always present, and the only thing that cannot be late. */
  link: SessionPipelineLink;
  /**
   * The run's projection, or null while the fleet has not sent it.
   *
   * Null is an ordinary state rather than an error: the link rides the session's own frame and
   * the projection is a separate collection, so a card can know its slug a tick before the run
   * arrives. The ladder says what the link alone can say and keeps the deep link working,
   * because the address is built from the link and never from the run.
   */
  run: PipelineRun | null;
  /**
   * Gate evidence, when the host has fetched it. Empty is not "no gates" - it is also "not
   * read yet" - so nothing here says a gate is missing; a step simply carries no verdict chip.
   */
  gates: readonly PipelineGateVerdict[];
  onOpenRun: () => void;
}): React.JSX.Element {
  const provider = PIPELINE_PROVIDER_INFO[link.provider];
  const strip = run ? pipelineStrip(run.provider, run.steps, gates) : null;
  // The phase the run is in right now, which is the one group that opens by default.
  const current = run?.lastStep
    ? pipelineStepInfo(run.provider, run.lastStep)?.phase ?? null
    : null;

  return (
    <section
      className="wf-ladder-panel pipeline-ladder"
      aria-label={`${link.slug} pipeline steps`}
    >
      <header className="wf-ladder-head">
        <span className="wf-ladder-name">⇶ {link.slug}</span>
        <span className="wf-ladder-version">{provider.label}</span>
        {run && (
          <span className={`wf-ladder-runstate workflow-${PIPELINE_GROUP_TONES[run.group]}`}>
            {PIPELINE_GROUP_LABELS[run.group]}
          </span>
        )}
        {run && <span className="wf-ladder-round">{pipelineEyebrow(run)}</span>}
      </header>

      {run?.halt && (
        <p className="wf-ladder-bypass pipeline-ladder-halt">
          <b>{PIPELINE_HALT_CLASS_INFO[run.halt.class].label}</b> {run.halt.reason}
        </p>
      )}

      {!run && (
        <p className="wf-ladder-sentence">
          {provider.label} is driving this session. Its run has not reached this dashboard yet.
        </p>
      )}

      {strip && (
        <ul className="wf-ladder">
          {strip.phases.map((phase) => (
            <PhaseRung
              key={phase.phase}
              card={phase}
              lastStep={run!.lastStep}
              open={phase.phase === current}
            />
          ))}
          {/*
            Out-of-band and unknown steps sit AFTER every phase and say which they are, for
            the reason the horizontal detail draws them beside the strip rather than inside
            it: an out-of-band step was dispatched in response to something and never had a
            slot, so drawing it in a phase would claim the run walked past it, and an unknown
            step is the tolerance rule made visible rather than a step silently dropped.
          */}
          {strip.outOfBand.length > 0 && (
            <ExtraRung
              name="Out of band"
              sub="dispatched in response, not in sequence"
              steps={strip.outOfBand}
              lastStep={run!.lastStep}
            />
          )}
          {strip.unknown.length > 0 && (
            <ExtraRung
              name="Unknown steps"
              sub="this build has no entry for these"
              steps={strip.unknown}
              lastStep={run!.lastStep}
            />
          )}
        </ul>
      )}

      <div className="wf-ladder-actrow">
        {/*
          The one control on this pane, and it is a link out rather than a verb: everything an
          operator can DO to a pipeline is the engine's, and the buttons that spawn its CLI
          are a later phase's. A greyed-out control that cannot act is worse than none.
        */}
        <Tooltip label="Open this pipeline in Runs - its steps, its gate verdicts, and what it is waiting on">
          <button className="wf-ladder-open" type="button" onClick={onOpenRun}>
            Open in Runs
          </button>
        </Tooltip>
      </div>
    </section>
  );
}

/**
 * One phase, as a rung that opens onto its steps.
 *
 * A `<details>` rather than a button plus state, so the disclosure is the browser's: it is
 * keyboard-reachable, it announces its own expanded state, and it survives this component
 * re-rendering on every projection frame - which a `useState` here would not, because a run
 * that is moving re-renders several times a second.
 */
function PhaseRung({
  card,
  lastStep,
  open,
}: {
  card: PipelinePhaseCard;
  lastStep: string | null;
  open: boolean;
}): React.JSX.Element {
  const status = pipelinePhaseStatus(card.steps);
  // A phase with no steps at all is a phase this run's state file never mentioned. Drawn
  // as waiting rather than dropped, so the ladder is the engine's whole sequence and a
  // reader can see what has not started.
  const shown = status ?? { tone: "stopped" as const, label: "Not started" };
  return (
    <Rung name={card.phase} status={shown}>
      {card.steps.length > 0 && (
        <details className="pipeline-ladder-phase" open={open}>
          <Tooltip label={`Show the ${card.phase} steps the engine recorded, and their gates`}>
            <summary>
              {card.steps.length} step{card.steps.length === 1 ? "" : "s"}
            </summary>
          </Tooltip>
          <ul className="pipeline-ladder-steps">
            {card.steps.map((step) => (
              <StepRow key={step.name} step={step} current={step.name === lastStep} />
            ))}
          </ul>
        </details>
      )}
      {card.steps.length === 0 && (
        <p className="wf-ladder-why">The engine has recorded nothing for this phase yet.</p>
      )}
    </Rung>
  );
}

/** The trailing rungs: steps that have no slot in the sequence, and steps this build cannot place. */
function ExtraRung({
  name,
  sub,
  steps,
  lastStep,
}: {
  name: string;
  sub: string;
  steps: readonly PipelineStepRow[];
  lastStep: string | null;
}): React.JSX.Element {
  return (
    <Rung name={name} sub={sub} status={{ tone: "stopped", label: `${steps.length}` }}>
      <ul className="pipeline-ladder-steps">
        {steps.map((step) => (
          <StepRow key={step.name} step={step} current={step.name === lastStep} />
        ))}
      </ul>
    </Rung>
  );
}

/**
 * One step, with its gate's answer beside it when there is one.
 *
 * `current` is the halo the plan asks for, and it is drawn as a CLASS plus a word rather than
 * styling alone: "the step the engine is on" has to survive a reader who never sees the
 * stylesheet, and it is the single fact this whole pane exists to deliver.
 */
function StepRow({
  step,
  current,
}: {
  step: PipelineStepRow;
  current: boolean;
}): React.JSX.Element {
  const status = pipelineStepStatus(step.state);
  return (
    <li
      className={[
        "wf-ladder-member-row",
        "pipeline-ladder-step",
        current ? "is-current" : "",
        step.deprecated ? "is-disabled" : "",
      ].filter(Boolean).join(" ")}
    >
      <span className="wf-ladder-member-name">{step.label}</span>
      {current && <span className="pipeline-ladder-current">current</span>}
      {step.unknown && <span className="wf-ladder-member-meta">Unknown step</span>}
      {step.deprecated && <span className="wf-ladder-member-meta">Retired no-op</span>}
      <PipelineStatusChip status={status} />
      {step.verdict && <PipelineStatusChip status={pipelineVerdictStatus(step.verdict)} />}
    </li>
  );
}
