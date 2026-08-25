import type { PipelineRun, PipelineStepState, SessionPipelineLink } from "@shared/pipeline.ts";
import { Tooltip, type TooltipContent } from "../components/Tooltip.tsx";
import {
  pipelinePhaseMeter,
  pipelineStepStatus,
  type PipelinePhaseSegment,
  type PipelineStepRow,
} from "./pipeline-run-model.ts";

/**
 * How far an engine-driven run has got, as five segments on a board card.
 *
 * WHAT THIS REPLACES. A correlated card used to say exactly one word about a 22-step feature:
 * its cluster head names the run and the step it is on. So the card could not answer any of
 * the three questions an operator scanning a board actually has - how far along is this
 * feature, has anything failed and where, and what did this run's tier or track skip. The
 * information was already in the browser and drawn only on a page somebody had to navigate
 * to. This is a bar, about 7px tall, that answers all three at a glance.
 *
 * WHY A HORIZONTAL BAR AND NOT A LADDER. The tile already carries the workflow stage ladder,
 * and `docs/plans/workflow-card-progress/` settled that a vertical ladder belongs to a detail
 * pane because height is the axis a detail pane has. A second ladder here would read as the
 * same thing twice, and the board's axis is width.
 *
 * A PURE RENDERER over `pipelinePhaseMeter`. Every claim it makes - which phase is current,
 * what tone a phase wears, which steps have no segment - is folded there, over the existing
 * `pipelineStrip` / `pipelinePhaseStatus` derivation. Nothing in this file re-derives one,
 * which is what stops the card and the Runs page from disagreeing about what a colour means.
 *
 * NO SLUG BUTTON IN THE CAPTION, deliberately. `clusterOf` (`src/web/lib/fleet-order.ts`) puts
 * every correlated tile inside a `.board-cluster` whose `PipelineClusterHead` is already a
 * button reading `⇶ <slug>` and already opens the run in Runs. A second control saying the
 * same word and going to the same place would be a duplicate tab stop directly beneath the
 * first. The run's identity is on this region's `aria-label` instead, which is what covers the
 * one case where no head is drawn: an ensemble membership outranks a pipeline correlation, so
 * a member that satisfied both is framed by its ensemble.
 */

/**
 * One glyph per step state, so a popover row does not rely on colour alone.
 *
 * A `Record` over the union rather than a switch with a default: a state appended to
 * `PipelineStepState` does not compile until somebody has drawn it, which is the same
 * obligation `pipelineStepStatus` carries for its label.
 */
const STEP_GLYPH: Record<PipelineStepState, string> = {
  done: "✓",
  in_progress: "●",
  failed: "✗",
  skipped: "–",
  stale: "↻",
  pending: "○",
};

/** One step, as a row of a phase's popover. */
function StepRow({ step, current }: { step: PipelineStepRow; current: boolean }): React.JSX.Element {
  const status = pipelineStepStatus(step.state);
  return (
    <span
      className={`tpm-pop-row workflow-${status.tone}${
        step.state === "skipped" ? " is-skipped" : ""
      }`}
    >
      <span className="g" aria-hidden>
        {STEP_GLYPH[step.state]}
      </span>
      <span className="n">{step.label}</span>
      {/* The step the engine is ON, said as a word rather than as a tone: this is the single
          fact the popover exists to deliver, and it has to survive a reader who never sees
          the stylesheet. */}
      {current && <span className="v">current</span>}
    </span>
  );
}

/**
 * One step as a sentence fragment, for the plain-text twin of a popover.
 *
 * The rows are the popover's whole content, so a description that stopped at "5 of 8
 * finished" would give a screen reader the arithmetic and withhold the answer - which step
 * failed, which was skipped. It is also the only layer at which `test/` can read them:
 * `renderToStaticMarkup` never paints the bubble, because the bubble is hover-only.
 */
function stepSentence(step: PipelineStepRow, lastStep: string | null): string {
  const state = pipelineStepStatus(step.state).label.toLowerCase();
  return `${step.label} ${state}${step.name === lastStep ? " (current)" : ""}`;
}

/** One phase's popover: what it wants, its steps, and the sentence under them. */
function segmentPopover(segment: PipelinePhaseSegment, lastStep: string | null): TooltipContent {
  const rows = segment.steps.map((step) => (
    <StepRow key={step.name} step={step} current={step.name === lastStep} />
  ));
  return {
    content: (
      <span className="tpm-pop">
        <span className="tpm-pop-hd">
          <span className="tpm-pop-name">{segment.phase}</span>
          <span className={`tpm-pop-stat workflow-${segment.status.tone}`}>
            {segment.status.label}
          </span>
        </span>
        {rows.length > 0 ? (
          rows
        ) : (
          <span className="tpm-pop-row">
            <span className="n">The engine has recorded nothing for this phase yet.</span>
          </span>
        )}
        {segment.footer && <span className="tpm-pop-foot">{segment.footer}</span>}
      </span>
    ),
    // The plain-text twin. Composed rather than stringified from the JSX above, because this
    // is what `aria-describedby` resolves to and markup in an accessible name is unreadable.
    description: [
      `${segment.phase}: ${segment.status.label}.`,
      segment.total === 0
        ? "The engine has recorded nothing for this phase yet."
        : `${segment.finished} of ${segment.total} steps finished.`,
      segment.total === 0
        ? ""
        : `${segment.steps.map((step) => stepSentence(step, lastStep)).join(", ")}.`,
      segment.current ? "This is the phase the run is in." : "",
      segment.footer ?? "",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

/**
 * The steps that own no segment, and why each has none.
 *
 * Grouped rather than merged into one list, because the two groups are on opposite sides of
 * the caption's arithmetic and a reader who counts the segments against `N` must not be left
 * with an unexplained discrepancy: an unknown step is inside `N`, an out-of-band one is beside
 * it. This marker is the ONLY place on the card either is readable, which is what stops
 * "counted in the total" from meaning "invisible".
 */
function extrasPopover(
  extras: { unknown: PipelineStepRow[]; outOfBand: PipelineStepRow[] },
  total: number,
  lastStep: string | null,
): TooltipContent {
  const groups: { name: string; why: string; steps: PipelineStepRow[] }[] = [
    {
      name: "Unknown steps",
      why: `This build has no entry for these, so they can name no phase. Counted in the ${total}.`,
      steps: extras.unknown,
    },
    {
      name: "Out of band",
      why: `Dispatched in response to something rather than walked past in sequence. Not counted in the ${total}.`,
      steps: extras.outOfBand,
    },
  ].filter((group) => group.steps.length > 0);
  return {
    content: (
      <span className="tpm-pop">
        {groups.map((group) => (
          <span className="tpm-pop-group" key={group.name}>
            <span className="tpm-pop-hd">
              <span className="tpm-pop-name">{group.name}</span>
              <span className="tpm-pop-stat">{group.steps.length}</span>
            </span>
            {group.steps.map((step) => (
              <StepRow key={step.name} step={step} current={step.name === lastStep} />
            ))}
            <span className="tpm-pop-foot">{group.why}</span>
          </span>
        ))}
      </span>
    ),
    description: groups
      .map(
        (group) =>
          `${group.name}: ${group.steps
            .map((step) => stepSentence(step, lastStep))
            .join(", ")}. ${group.why}`,
      )
      .join(" "),
  };
}

/**
 * How much of a segment is filled, as a percentage.
 *
 * Rounded to a tenth rather than passed raw: five of nine steps is 55.55555555555556, and a
 * seventeen-digit float in a `style` attribute is noise in every diff and every screenshot of
 * the DOM for a difference no display can render. A phase the run's state file never mentioned
 * has nothing to divide by and is empty rather than NaN.
 */
function fillPercent(segment: PipelinePhaseSegment): number {
  if (segment.total === 0) return 0;
  return Math.round((segment.finished / segment.total) * 1000) / 10;
}

export function PipelinePhaseMeter({
  run,
  link,
}: {
  run: PipelineRun;
  /** The session's own correlation, which is what names the run for assistive tech. */
  link: SessionPipelineLink;
}): React.JSX.Element | null {
  const view = pipelinePhaseMeter(run);
  if (!view) return null;
  const extraCount = view.extras.unknown.length + view.extras.outOfBand.length;

  return (
    <span
      className="tile-phase-meter"
      role="group"
      aria-label={`${link.slug} pipeline phases`}
    >
      <span className="tpm-cap">
        <span className="tpm-glyph" aria-hidden>
          ⇶
        </span>
        <span className={`tpm-now workflow-${view.captionTone}`}>{view.caption}</span>
        {/* THE HALT, unconditionally, as a WORD rather than only as the caption's colour.
            A halt is a fact about the run, not about a phase, so this is its home and a
            phase's popover carrying it too is an addition. Stating it here is what closes the
            case the projection's own `classifyGroup` names: a run that halted DURING a step
            has no failed phase, so before this the meter drew it as work in progress and said
            nothing about the halt anywhere. */}
        {view.halt && (
          <Tooltip
            label={{
              content: (
                <span className="tpm-pop">
                  <span className="tpm-pop-hd">
                    <span className="tpm-pop-name">Halted</span>
                    <span className="tpm-pop-stat workflow-failed">{view.halt.label}</span>
                  </span>
                  {/* Its own element rather than a `.tpm-pop-row`: a step row is one line and
                      ellipsises, which is right for a step's LABEL and wrong for prose - the
                      engine's reason is a sentence, and a halt whose reason reads "the scope
                      widened past the approved …" is the defect this marker exists to fix. */}
                  <span className="tpm-pop-reason">{view.halt.reason}</span>
                  <span className="tpm-pop-foot">{view.halt.blurb}</span>
                </span>
              ),
              description: `Halted - ${view.halt.label}. ${view.halt.reason}. ${view.halt.blurb}`,
            }}
          >
            <span className="tpm-halt workflow-failed" tabIndex={0}>
              halted
            </span>
          </Tooltip>
        )}
        {/* Only when a pile is non-empty. An empty marker, or a zero, would be a control that
            says nothing on the overwhelmingly common run that carries neither. */}
        {extraCount > 0 && (
          <Tooltip label={extrasPopover(view.extras, view.total, run.lastStep)}>
            <span className="tpm-extras" tabIndex={0}>
              {`+${extraCount}`}
            </span>
          </Tooltip>
        )}
        {/* Finished over the run's own sequential total, so the number agrees with the bar
            beneath it. The step INDEX would be a different figure, and a caption that
            disagreed with the fill it captions is the bug this note exists to prevent. */}
        <span className="tpm-count">{`${view.done}/${view.total}`}</span>
      </span>
      <span className="tpm-bar">
        {view.segments.map((segment) => (
          <Tooltip key={segment.phase} label={segmentPopover(segment, run.lastStep)}>
            {/*
              Focusable, so the per-step states are not mouse-only: they are the whole reason
              this meter has popovers, and `Tooltip` opens on focus as well as hover.

              `flexGrow` from the phase's own step count in THIS run - never a hardcoded
              split - with the `min-width` floor in the stylesheet keeping a one-step phase
              hittable. SETUP and UNDERSTAND hold one step each in the default sequence.
            */}
            <span
              className={`tpm-seg workflow-${segment.status.tone}${
                segment.current ? " is-now" : ""
              }${segment.status.degraded ? " is-degraded" : ""}`}
              style={{ flexGrow: segment.total }}
              tabIndex={0}
            >
              <i style={{ width: `${fillPercent(segment)}%` }} />
            </span>
          </Tooltip>
        ))}
      </span>
    </span>
  );
}
