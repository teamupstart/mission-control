import type { ReactNode } from "react";
import {
  PIPELINE_HALT_CLASS_INFO,
  PIPELINE_PROVIDER_INFO,
  pipelineStepInfo,
  type PipelineGateVerdict,
  type PipelinePhase,
  type PipelineRun,
} from "@shared/pipeline.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import { relativeTime, repoLeaf } from "../lib/format.ts";
import {
  PipelineFrame,
  PipelineStatusChip,
  ReviewerRow,
  StageCard,
  StageSeam,
  TerminusCard,
} from "../workflows/pipeline-bits.tsx";
import {
  PIPELINE_GROUP_LABELS,
  PIPELINE_GROUP_TONES,
  pipelineAttempts,
  pipelineEyebrow,
  pipelineKickbackRule,
  pipelinePhaseStatus,
  pipelinePhaseSummary,
  pipelineStepStatus,
  pipelineStrip,
  pipelineVerdictStatus,
  pipelineVerdicts,
  type PipelineStepRow,
} from "./pipeline-run-model.ts";
import type { PipelineRunDetailState } from "./usePipelineRunDetail.ts";

/**
 * One pipeline run, drawn in the workflow diagram's grammar.
 *
 * The strip is built from `pipeline-bits.tsx` - the same leaves the workflow editor and the
 * workflow run monitor draw from - rather than from a second set of cards that look like
 * them. That module exists precisely so two surfaces showing the same shape cannot drift
 * into two dialects, and this surface is showing the same shape ON PURPOSE: the approved
 * plan asks for the pipeline detail in the workflow diagram's visual grammar. Nothing in
 * those leaves is modified to accommodate this caller; every slot used here is one they
 * already offered.
 *
 * What is NOT borrowed is the reading furniture around the strip. The header, attempt cards
 * and verdict list carry their own `pipelines-` prefix rather than reusing `wf-run-*`,
 * because sharing those classes would make a later change to this surface a change to the
 * workflow run page - which is the one thing this phase promises never to do.
 */

/**
 * What each wire between two cards crosses.
 *
 * The boundary an operator reads, in the same gate-pill idiom the workflow strip uses for
 * "submitted" and "all pass". Keyed by the phase the wire ENTERS, plus the two termini, and
 * provider-generic exactly as `PIPELINE_PHASES` is - what a phase is called is shared, and
 * only the steps inside it are one engine's vocabulary.
 */
const SEAM_INTO: Record<PipelinePhase, string> = {
  SETUP: "plan filed",
  UNDERSTAND: "worktree cut",
  DECIDE: "context read",
  BUILD: "spec approved",
  SHIP: "code written",
};

/** The wire out of the last card, into the pull request. */
const SEAM_INTO_PR = "run finished";

/** The label for one step's row, and the sentence under it. */
function stepMeta(row: PipelineStepRow): string | null {
  if (row.verdict?.reason) return row.verdict.reason;
  if (row.deprecated) return "retained no-op - the engine keeps the slot and does no work in it";
  if (row.unknown) return "this build has no entry for this step";
  return null;
}

function StepRow({ row }: { row: PipelineStepRow }): React.JSX.Element {
  return (
    <ReviewerRow
      name={row.label}
      meta={stepMeta(row)}
      status={pipelineStepStatus(row.state)}
      // Dashed, like a disabled command: a deprecated slot and a step this run's tier or
      // track skipped both occupy a place in the engine's own state without doing work in
      // it, and hiding either would leave a strip that does not match the state file.
      disabled={row.deprecated || row.state === "skipped"}
      notice={
        row.unknown ? <span className="pipelines-unknown-mark">Unknown step</span> : null
      }
      actions={
        row.verdict ? <PipelineStatusChip status={pipelineVerdictStatus(row.verdict)} /> : null
      }
    />
  );
}

/** The attempt cards, where the workflow detail shows its round tabs. */
function Attempts({
  run,
  gates,
}: {
  run: PipelineRun;
  gates: readonly PipelineGateVerdict[];
}): React.JSX.Element | null {
  const attempts = pipelineAttempts(gates);
  // One attempt is not a history, and a lone card reading "Attempt 1" would be a control
  // shape promising a scrubber that has nothing to scrub.
  if (attempts.length < 2) return null;
  const label = (step: string): string => pipelineStepInfo(run.provider, step)?.label ?? step;
  return (
    <section className="pipelines-attempts" aria-label="Attempts">
      <h4>Attempts</h4>
      <div className="pipelines-attempt-row">
        {attempts.map((attempt) => (
          <article
            key={attempt.index}
            className={`pipelines-attempt${attempt.current ? " is-current" : ""}`}
            // The current attempt is the one the run is on, which is a fact about the run
            // rather than about what is selected - these cards select nothing.
            aria-current={attempt.current ? "true" : undefined}
          >
            <span className="pipelines-attempt-name">Attempt {attempt.index}</span>
            <span className="pipelines-attempt-line">
              {attempt.kickback
                ? `${label(attempt.kickback.from)} sent it back to ${attempt.kickback.to
                    .map(label)
                    .join(", ")}`
                : "the run's first pass"}
            </span>
            {attempt.kickback?.at != null && (
              <small>{relativeTime(attempt.kickback.at)}</small>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

/** The gate evidence, where the workflow detail places its review worklist. */
function GateVerdicts({
  run,
  state,
}: {
  run: PipelineRun;
  state: PipelineRunDetailState;
}): React.JSX.Element {
  const verdicts =
    state.state === "ready" ? pipelineVerdicts(run.provider, state.detail.gates) : [];
  return (
    <section className="pipelines-section" aria-label="Gate verdicts">
      <h4>Gate verdicts</h4>
      {state.state === "loading" && <p className="pipelines-note">Reading the engine's gates…</p>}
      {/* Deliberately does NOT claim the worktree is gone. The browser cannot tell a 404
          from a daemon it could not reach - `fetchJson` answers null for both - so naming
          one of them would be a guess printed as a fact, and the wrong guess is the one that
          tells somebody their run was torn down when their laptop dropped a packet. It says
          what is true of both, and that it heals itself: the read runs again on the run's
          next projection frame. */}
      {state.state === "missing" && (
        <p className="pipelines-note">
          The gate evidence could not be read just now - the worktree may be gone, or the
          daemon may not have answered. This retries as the run moves; the strip above is the
          last projection of it.
        </p>
      )}
      {state.state === "ready" && verdicts.length === 0 && (
        <p className="pipelines-note">
          No gate has answered for this run yet. The engine writes one file per gate as it
          reaches them.
        </p>
      )}
      {verdicts.length > 0 && (
        <ul className="pipelines-verdicts">
          {verdicts.map((verdict) => (
            <li
              key={verdict.step}
              className={`pipelines-verdict is-${
                verdict.skipped ? "skipped" : verdict.satisfied ? "satisfied" : "refused"
              }`}
            >
              <span className="pipelines-verdict-head">
                <strong>{pipelineStepInfo(run.provider, verdict.step)?.label ?? verdict.step}</strong>
                <PipelineStatusChip status={pipelineVerdictStatus(verdict)} />
              </span>
              {verdict.reason && <p className="pipelines-verdict-reason">{verdict.reason}</p>}
              {verdict.kickbackFrom && (
                <p className="pipelines-verdict-kickback">
                  Re-opened by{" "}
                  {pipelineStepInfo(run.provider, verdict.kickbackFrom)?.label ??
                    verdict.kickbackFrom}
                </p>
              )}
              <small>
                {verdict.checkedAt === null
                  ? "no time recorded"
                  : `answered ${relativeTime(verdict.checkedAt)}`}
              </small>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function PipelineRunView({
  run,
  detail,
  /**
   * The header's trailing control slot - RESERVED, and empty in this phase.
   *
   * Phase 4 fills it with the engine's control verbs (pause, park, grant, resume). It is a
   * prop rather than an empty element so that nothing renders until there is something to
   * render: a greyed-out button that cannot do anything is worse than no button, and a
   * later phase should not have to restructure this header to add one.
   */
  actions = null,
}: {
  run: PipelineRun;
  detail: PipelineRunDetailState;
  actions?: ReactNode;
}): React.JSX.Element {
  const gates = detail.state === "ready" ? detail.detail.gates : [];
  const strip = pipelineStrip(run.provider, run.steps, gates);
  const engine = PIPELINE_PROVIDER_INFO[run.provider];

  return (
    <div className="pipelines-run">
      <header className="pipelines-run-head">
        <div className="pipelines-run-identity">
          <p className="pipelines-run-eyebrow">{pipelineEyebrow(run)}</p>
          <h3 className="pipelines-run-title">{run.slug}</h3>
          <p className="pipelines-run-facts">
            <span className={`workflow-chip workflow-${PIPELINE_GROUP_TONES[run.group]}`}>
              {PIPELINE_GROUP_LABELS[run.group]}
            </span>
            {run.tier && <span className="pipelines-chip">Tier {run.tier}</span>}
            {run.track && <span className="pipelines-chip">{run.track}</span>}
            {run.prUrl && (
              <Tooltip label="Open this run's pull request">
                <a
                  className="pipelines-chip is-link"
                  href={run.prUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Pull request <span aria-hidden>→</span>
                </a>
              </Tooltip>
            )}
          </p>
          <small>
            {engine.label} · {repoLeaf(run.repoRoot)} · updated {relativeTime(run.updatedAt)}
          </small>
        </div>
        {actions}
      </header>

      {run.halt && (
        <p className="pipelines-run-halt" role="status">
          <b>{PIPELINE_HALT_CLASS_INFO[run.halt.class].label}</b> {run.halt.reason}
        </p>
      )}

      <Attempts run={run} gates={gates} />

      <PipelineFrame
        ariaLabel={`Pipeline for ${run.slug}`}
        repair={pipelineKickbackRule(run.provider)}
      >
        <TerminusCard kind="session" name="Spec" subtitle="What the engine was given" />
        <StageSeam gate={SEAM_INTO.SETUP} />
        {strip.phases.map((card, index) => (
          <div className="wf-pipeline-slot" key={card.phase}>
            <StageCard
              name={card.phase}
              subtitle={pipelinePhaseSummary(card.steps)}
              status={pipelinePhaseStatus(card.steps)}
            >
              {card.steps.length === 0 ? (
                <p className="wf-pipeline-empty">No step of this phase is in the run's state.</p>
              ) : (
                <ul className="wf-pipeline-members">
                  {card.steps.map((step) => (
                    <StepRow key={step.name} row={step} />
                  ))}
                </ul>
              )}
            </StageCard>
            {/* The wire out of the last placed phase carries "run finished" only when the
                next card really is the pull request. With unknown steps drawn in between it
                is unlabelled: that card is where steps this build cannot place are parked,
                not a boundary the run crossed, and labelling it would put the same handoff
                on two different wires. */}
            <StageSeam
              gate={
                strip.phases[index + 1]
                  ? SEAM_INTO[strip.phases[index + 1]!.phase]
                  : strip.unknown.length > 0
                    ? null
                    : SEAM_INTO_PR
              }
            />
          </div>
        ))}
        {/* After every phase this build can place, which is the whole tolerance rule made
            visible: a conductor release that adds a step draws it here, in the state the
            engine reported, rather than taking the page down. */}
        {strip.unknown.length > 0 && (
          <div className="wf-pipeline-slot">
            <StageCard
              name="Unknown steps"
              subtitle={`${strip.unknown.length} not in this build's table`}
              status={{
                tone: "stopped",
                label: "Unplaced",
                tooltip: `${engine.label} reported steps this build has no entry for. They are drawn in the state it reported.`,
              }}
            >
              <ul className="wf-pipeline-members">
                {strip.unknown.map((step) => (
                  <StepRow key={step.name} row={step} />
                ))}
              </ul>
            </StageCard>
            <StageSeam gate={SEAM_INTO_PR} />
          </div>
        )}
        <TerminusCard
          kind="end"
          name="Pull request"
          subtitle={run.prUrl ? "opened" : "not opened yet"}
          status={
            run.prUrl
              ? { tone: "passed", label: "Open" }
              : { tone: "stopped", label: "Not yet" }
          }
        />
      </PipelineFrame>

      {strip.outOfBand.length > 0 && (
        <section className="pipelines-section" aria-label="Out-of-band steps">
          <h4>Out of band</h4>
          {/* Beside the strip rather than in it: these are dispatched in response to
              something rather than in sequence, so a slot between two phases would say the
              run walked past a step that was never on its path. */}
          <p className="pipelines-note">
            Dispatched in response to something rather than in sequence, so they have no slot
            in the strip above.
          </p>
          <ul className="wf-pipeline-members">
            {strip.outOfBand.map((step) => (
              <StepRow key={step.name} row={step} />
            ))}
          </ul>
        </section>
      )}

      <GateVerdicts run={run} state={detail} />
    </div>
  );
}
