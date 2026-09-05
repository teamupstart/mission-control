import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentType,
  PrState,
  Session,
  SessionCost,
  SessionMeta,
  Task,
  TaskPriority,
  TaskRepoPrSummary,
} from "@shared/types.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { GOAL_UNSUPPORTED } from "@shared/goal.ts";
import { costTone } from "@shared/cost.ts";
import { PRIORITY_LABELS } from "@shared/task.ts";
import {
  compactTokens,
  contextTone,
  fmtUsd,
  repoLeaf,
  sessionTitleDetail,
  type StateDisplay,
} from "../lib/format.ts";
import type { BacklogTaskNoticeView } from "../lib/backlog-copy.ts";
import { useSessionRuntimeDisplay } from "../lib/interrupting.ts";
import { formatScheduledFor } from "../lib/schedules.ts";
import { api } from "../lib/api.ts";
import { Keycap } from "./Keycap.tsx";
import { Tooltip } from "./Tooltip.tsx";
import { InlineRenameEditor } from "./InlineRenameEditor.tsx";
import { EffortPicker, EffortReading } from "./EffortPicker.tsx";
import type { WorkflowRunSummary } from "@shared/workflow.ts";
import { ensembleStageWord, type EnsembleSummary, type TaskEnsembleLink } from "@shared/ensemble.ts";
import {
  PIPELINE_PROVIDER_INFO,
  pipelineStepInfo,
  type PipelineCommission,
  type PipelineRunLink,
  type PipelineRun,
  type SessionPipelineLink,
} from "@shared/pipeline.ts";
import { PIPELINE_GROUP_LABELS } from "../pipelines/pipeline-run-model.ts";

/**
 * The small, presentational pieces a session is drawn from - the agent dot, the
 * goal line, the PR chip, the state badge, the title (with its rename editor), the
 * runtime pills - plus the task chips (priority, labels), which live here for the same
 * reason even though they hang off a Task rather than a Session: the board's backlog
 * column and the roundup panel both draw them, and two copies is how they drift.
 *
 * Every drawing is a consumer here: the Console detail, Board tile and rail row arrange
 * these SAME bits rather than importing one another or keeping
 * private copies. Compact drawings may use a different vocabulary, but their decision and
 * leaf variant still live here. That matters because the tile is rendered by ONE layout
 * while the detail serves both, so a private copy can silently miss another layout.
 *
 * `test/session-leaf-parity.test.ts` pins each drawing to its shared leaves;
 * `test/pr-chip-parity.test.ts` pins the PR decision across all four.
 */

/**
 * Where this session was found, phrased for the small grey subtitle.
 *
 * The pane id rides along only for a MULTIPLEXER, and that asymmetry is about the axis
 * rather than about tmux: a multiplexer names a SESSION that may hold many panes, so which
 * pane this card is only answerable by saying it, while an emulator names the tab itself
 * and has nothing left to disambiguate. Both shipped backends read exactly as they always
 * did; a third one inherits whichever rule its axis already states.
 */
export function subtitle(session: Session): string {
  if (session.runtime === "sdk") return RUNTIME_LABEL;
  const namer = session.terminals.find((h) => h.backend === session.nameSource);
  if (namer?.kind === "multiplexer") return `${namer.backend} · ${namer.paneId}`;
  return session.nameSource;
}

/**
 * What an embedded session is called where a pane string would go.
 *
 * "Agent SDK" rather than the `sdk` the `NameSource` spells, because this line answers
 * "where is this session?" for a human, and the honest answer is that there is nowhere to
 * go and look - it runs inside Mission Control. Named once and shared by all four
 * surfaces, so the three mark vocabularies say the same word.
 */
export const RUNTIME_LABEL = "Agent SDK";

const RUNTIME_TITLE =
  "This session runs on the Agent SDK, inside Mission Control - there is no terminal pane to focus. Continue in terminal hands it to one.";

/**
 * WHERE this session is, under its title - the card's and the console detail's vocabulary
 * for the same fact the rail spells as a glyph and the tile as a flag.
 *
 * One leaf for both spellings rather than a chip added BESIDE the pane string, because
 * they answer the same question and a card carrying both would say it twice. An embedded
 * session takes the chip treatment because it is the answer that changes what the rest of
 * the card can offer: no pane means no Focus, no Rename, and "look at it in the terminal"
 * means running a command rather than switching tabs.
 */
export function SessionWhere({ session }: { session: Session }): React.JSX.Element {
  if (session.runtime !== "sdk") {
    return <span className="name-source">{subtitle(session)}</span>;
  }
  return (
    <Tooltip label={RUNTIME_TITLE}>
      <span className="name-source runtime-chip" aria-label={RUNTIME_TITLE}>
        <span className="runtime-glyph" aria-hidden>
          ◈
        </span>
        {/* Its own element so the LABEL is what shrinks on a narrow card. Left as the
            chip's bare text it is an atomic box: the pill would be clipped mid-word with
            no ellipsis, because the ellipsis belongs to whatever is overflowing. */}
        <span className="runtime-name">{RUNTIME_LABEL}</span>
      </span>
    </Tooltip>
  );
}

/** The board tile's `.tile-flag` spelling of the same fact. */
export function RuntimeTileFlag({ session }: { session: Session }): React.JSX.Element | null {
  if (session.runtime !== "sdk") return null;
  return (
    <Tooltip label={RUNTIME_TITLE}>
      <span className="tile-flag runtime-flag" aria-label={RUNTIME_TITLE}>
        ◈ {RUNTIME_LABEL}
      </span>
    </Tooltip>
  );
}

/**
 * The rail's glyph, which is all the room a rail row has.
 *
 * Returned as a STRING rather than an element, because the rail composes its marks into
 * one `join(" ")`ed span - the same shape `costIsNotable`'s `≈$` takes there.
 */
export function runtimeRailMark(session: Session): string | null {
  return session.runtime === "sdk" ? "◈" : null;
}

/**
 * The agent's brand colour, handed to CSS as one custom property.
 *
 * Every surface that wants to wear a harness's colour sets this and then styles against
 * `var(--agent-accent)`. The alternative - what this replaced - was an `agent-${agent}`
 * class per harness, which meant a new harness rendered a colourless dot until someone
 * noticed and hand-wrote a rule in a 7,800-line stylesheet. Nothing fails when that is
 * forgotten, which is exactly why it kept being forgotten.
 *
 * The fallback in the stylesheet is `--neutral`, not a vendor colour: a surface that
 * forgets to set this looks unremarkable rather than looking like Claude.
 */
export function agentAccentStyle(agent: AgentType): React.CSSProperties {
  return { "--agent-accent": AGENT_IDENTITY[agent].accent } as React.CSSProperties;
}

export function AgentDot({ agent }: { agent: Session["agent"] }): React.JSX.Element {
  return <span className="agent-dot" style={agentAccentStyle(agent)} aria-hidden />;
}

export type WorkflowRunTone = "running" | "waiting" | "blocked" | "passed" | "failed";

export function workflowRunTone(run: WorkflowRunSummary): WorkflowRunTone {
  if (run.status === "completed") return "passed";
  // `waiting_for_action` is deliberately NOT in this list. Every status here is a run that
  // owes something to a human - repair the work, open a PR, wait out a review - and the
  // chip's waiting tone is the fleet's mark for "your move". An action turn is the daemon's
  // own instruction being worked on by the session, so it tones as running, and the label
  // below says which of the two it is.
  if ([
    "waiting_for_session",
    "waiting_for_pr",
    "waiting_for_inspector",
    "waiting_for_new_head",
    "waiting_for_evidence_readiness",
  ].includes(run.status)) return "waiting";
  if (run.status === "blocked") return "blocked";
  if (run.status === "failed" || run.status === "cancelled") return "failed";
  return "running";
}

export function workflowRunLabel(run: WorkflowRunSummary): string {
  const tone = workflowRunTone(run);
  if (tone === "passed") return "Approved";
  if (run.gate === "waiting_pr") return "Waiting for PR";
  if (run.gate === "waiting_inspector") return "GitHub Inspector gate";
  if (run.gate === "findings") return "GitHub Inspector findings";
  if (run.status === "waiting_for_evidence_readiness") return "Evidence preflight";
  if (tone === "waiting") return "Review changes";
  if (tone === "blocked") return "Workflow blocked";
  if (tone === "failed") return run.status === "cancelled" ? "Preview cancelled" : "Preview failed";
  // Named rather than folded into the round counter beside it. A run parked on an action is
  // not a review in progress, and `Preview · R1` beside a session that has just been handed
  // an instruction tells an operator nothing about why nothing is moving.
  if (run.status === "waiting_for_action") return "Session action";
  return `Preview · R${run.round}`;
}

export function WorkflowChip({
  run,
  repoLabel,
  onOpen,
}: {
  run: WorkflowRunSummary | null;
  /**
   * The repository this run reviews, drawn before the label when a session has more than one.
   * Omitted for the single-run session, whose chip is then byte-identical to what it was.
   */
  repoLabel?: string | null;
  onOpen?: () => void;
}): React.JSX.Element | null {
  if (!run) return null;
  const label = workflowRunLabel(run);
  return (
    <Tooltip
      label={
        repoLabel
          ? `${run.workflowName} v${run.workflowVersion} on ${repoLabel}: ${label}`
          : `${run.workflowName} v${run.workflowVersion}: ${label}`
      }
    >
      <button
        className={`workflow-chip workflow-${workflowRunTone(run)}`}
        onClick={(event) => {
          event.stopPropagation();
          onOpen?.();
        }}
      >
        <span aria-hidden>⌁</span>
        {/* A real space between the name and the label, not a CSS gap: this button's text IS
            its accessible name, and a flex gap would weld "second-repoReview changes". */}
        {repoLabel
          ? <><span className="workflow-chip-repo">{repoLabel}</span>{" "}</>
          : null}
        {label}
      </button>
    </Tooltip>
  );
}

/**
 * Every review a conversation is carrying, one chip each.
 *
 * One chip for the fleet's single-repo sessions, drawn exactly as one `WorkflowChip` always
 * was - no repository name, no wrapper, no change to the markup a person or a spec reads.
 *
 * A multi-repo task's session gets one per repository it changed, each named, because they
 * are genuinely independent reviews: separate repair budgets, separate gates, separate pull
 * requests, and routinely different states at the same moment. A surface that drew only the
 * newest would report one repository's "Approved" over another's unfinished repair.
 */
export function WorkflowChips({
  runs,
  onOpen,
}: {
  runs: readonly WorkflowRunSummary[] | null | undefined;
  onOpen?: (runId: string) => void;
}): React.JSX.Element | null {
  if (!runs || runs.length === 0) return null;
  const named = runs.length > 1;
  return (
    <>
      {runs.map((run) => (
        <WorkflowChip
          key={run.id}
          run={run}
          repoLabel={named ? repoLeaf(run.repoRoot) : null}
          onOpen={onOpen ? () => onOpen(run.id) : undefined}
        />
      ))}
    </>
  );
}

/**
 * The mark that says this agent is not yours to talk to: an external engine is driving it.
 *
 * The one thing on a correlated card that is not also true of an ordinary session, and it has
 * to be legible at a glance, because the surrounding card looks EXACTLY like an ordinary
 * one - the engine spawns a real agent into a real pane, so every other affordance a person
 * reads (name, state badge, transcript) is drawn from the same facts. Without this chip a
 * conductor-driven `--print` claude is indistinguishable from an agent waiting for your next
 * instruction, which is the carding hazard this phase exists to close.
 *
 * Says the slug and the step, not the provider, because that is what tells two of them apart
 * on one board; the provider is on the tooltip, where a person who has not met one before
 * finds out what is driving it.
 */
export function PipelineChip({
  link,
  onOpen,
}: {
  link: SessionPipelineLink | null;
  onOpen?: () => void;
}): React.JSX.Element | null {
  if (!link) return null;
  const provider = PIPELINE_PROVIDER_INFO[link.provider];
  const step = link.step ? pipelineStepInfo(link.provider, link.step)?.label ?? link.step : null;
  return (
    <Tooltip
      label={`${provider.label} is driving ${link.slug}${
        step ? ` - on ${step}` : ""
      }. Open its run in Runs; this agent reads no input here.`}
    >
      <button
        className="pipeline-chip"
        onClick={(event) => {
          event.stopPropagation();
          onOpen?.();
        }}
      >
        <span aria-hidden>⇶</span>
        {/* Real spaces rather than a flex gap: this button's text IS its accessible name, and
            a gap would weld "add-widgetsBuild" into one word for a screen reader. */}
        {` ${link.slug}`}
        {step ? <span className="pipeline-chip-step">{` · ${step}`}</span> : null}
      </button>
    </Tooltip>
  );
}

/** Task ownership copy, deliberately distinct from the externally-driven worker chip. */
export function taskPipelineRunSentence(link: PipelineRunLink, observed: boolean): string {
  return observed
    ? `This task continues in ${link.slug}. Open its run in Runs.`
    : `This task plans ${link.slug}. Open its run in Runs.`;
}

export function TaskPipelineRunChip({
  link,
  observed,
  onOpen,
}: {
  link: PipelineRunLink | null;
  observed: boolean;
  onOpen?: () => void;
}): React.JSX.Element | null {
  if (!link) return null;
  const label = taskPipelineRunSentence(link, observed);
  return (
    <Tooltip label={label}>
      <button
        className={`task-pipeline-chip ${observed ? "observed" : "planned"}`}
        aria-label={label}
        onClick={(event) => {
          event.stopPropagation();
          onOpen?.();
        }}
      >
        <span aria-hidden>↝</span>
        {` ${link.slug}`}
      </button>
    </Tooltip>
  );
}

export function PipelineCommissionChip({
  commission,
  line,
  onOpen,
}: {
  commission: PipelineCommission | null;
  line: string;
  onOpen?: () => void;
}): React.JSX.Element | null {
  if (!commission) return null;
  const label = `${line}. Open the complete commission in Runs.`;
  return (
    <Tooltip label={label}>
      <button className="task-pipeline-chip commissioned" aria-label={label} onClick={onOpen}>
        <span aria-hidden>↝</span>
        {` ${line}`}
      </button>
    </Tooltip>
  );
}

export function PipelineCommissionRailMark({
  commission,
  line,
  onOpen,
}: {
  commission: PipelineCommission | null;
  line: string;
  onOpen?: () => void;
}): React.JSX.Element | null {
  if (!commission) return null;
  const label = `${line}. Open the complete commission in Runs.`;
  return (
    <Tooltip label={label}>
      <button
        className="rail-task-pipeline commissioned"
        aria-label={label}
        onClick={(event) => {
          event.stopPropagation();
          onOpen?.();
        }}
      >
        <span aria-hidden>↝</span>
      </button>
    </Tooltip>
  );
}

export function TaskPipelineRunTileFlag({
  link,
  observed,
  onOpen,
}: {
  link: PipelineRunLink | null;
  observed: boolean;
  onOpen?: () => void;
}): React.JSX.Element | null {
  if (!link) return null;
  const label = taskPipelineRunSentence(link, observed);
  return (
    <Tooltip label={label}>
      <button
        className={`tile-flag task-pipeline-flag ${observed ? "observed" : "planned"}`}
        aria-label={label}
        onClick={(event) => {
          event.stopPropagation();
          onOpen?.();
        }}
      >
        {observed ? `↝ ${link.slug}` : `planned ${link.slug}`}
      </button>
    </Tooltip>
  );
}

export function TaskPipelineRunRailMark({
  link,
  observed,
  onOpen,
}: {
  link: PipelineRunLink | null;
  observed: boolean;
  onOpen?: () => void;
}): React.JSX.Element | null {
  if (!link) return null;
  const label = taskPipelineRunSentence(link, observed);
  return (
    <Tooltip label={label}>
      <button
        className={`rail-task-pipeline ${observed ? "observed" : "planned"}`}
        aria-label={label}
        onClick={(event) => {
          event.stopPropagation();
          onOpen?.();
        }}
      >
        <span aria-hidden>↝</span>
      </button>
    </Tooltip>
  );
}

/**
 * The frame header over the sessions of one pipeline run, for the board and the console rail.
 *
 * The pipeline twin of `EnsembleClusterHead` / `EnsembleRailGroup`, and a separate component
 * rather than a widened one because almost nothing they draw carries over: an ensemble's
 * header is about a comparison in flight (strategy, stage word, one dot per candidate), and a
 * pipeline's is about one feature walking a gated sequence. What IS shared is the shape - a
 * button that names the run and opens it - so the class names are the same and the two look
 * alike in the column, which is the point.
 *
 * `run` may be null for the same reason the ensemble head's summary may be: a card knows its
 * link from its own session frame, and the run's projection is a separate collection that can
 * land a tick later. The slug is on the link, so the header never has to wait to say which
 * run this is.
 */
export function PipelineClusterHead({
  run,
  slug,
  variant,
  onOpen,
}: {
  run: PipelineRun | null;
  /** The engine's key for the feature, from the member link - always available. */
  slug: string;
  /** `board` draws the two-line cluster head; `rail` draws the one-line rail group. */
  variant: "board" | "rail";
  onOpen?: () => void;
}): React.JSX.Element {
  const halted = run?.halt ?? null;
  const tooltip = halted
    ? `${slug} - halted: ${halted.reason}`
    : run
      ? `${slug} - ${PIPELINE_GROUP_LABELS[run.group].toLowerCase()}${
          run.lastStep ? ` on ${pipelineStepInfo(run.provider, run.lastStep)?.label ?? run.lastStep}` : ""
        }. Open it in Runs.`
      : `${slug} - open this pipeline in Runs`;
  const step = run?.lastStep
    ? pipelineStepInfo(run.provider, run.lastStep)?.label ?? run.lastStep
    : null;
  if (variant === "rail") {
    return (
      <Tooltip label={tooltip}>
        <button
          className={`rail-ensemble-group rail-pipeline-group${halted ? " needs-you" : ""}`}
          aria-label={tooltip}
          onClick={onOpen}
        >
          <span className="reg-glyph" aria-hidden>
            ⇶
          </span>
          <span className="reg-title">{slug}</span>
          {step && <span className="reg-stage">{step}</span>}
          {halted && <span className="reg-needs">halted</span>}
        </button>
      </Tooltip>
    );
  }
  return (
    <Tooltip label={tooltip}>
      <button
        className={`board-cluster-head board-pipeline-head${halted ? " needs-you" : ""}`}
        aria-label={tooltip}
        onClick={onOpen}
      >
        <span className="bch-line">
          <span className="bch-glyph" aria-hidden>
            ⇶
          </span>
          <span className="bch-title">{slug}</span>
        </span>
        <span className="bch-line">
          <span className="bch-meta">
            {run ? PIPELINE_GROUP_LABELS[run.group] : "Pipeline"}
            {step ? ` · ${step}` : ""}
          </span>
          {halted && <span className="bch-needs">halted</span>}
        </span>
      </button>
    </Tooltip>
  );
}

/**
 * What a repository frame's header says, in one place.
 *
 * `here` is how many of this repository's cards are in THIS frame and `total` how many it has
 * on the whole board, and the two come apart constantly - a repository is framed once per tone
 * column its sessions landed in, and once more per side of the idle column's free/held
 * boundary. So the short form is the part (`2 of 7`) and the long form says what the parts are,
 * which is the same division of labour `EnsembleClusterHead`'s rollup line already makes.
 *
 * When every session the repository has is in this one frame there is no part to report, and
 * `2 of 2` would be inviting an operator to go looking for the other zero. It says `2 agents`.
 */
export function repoGroupHeadline(
  repoRoot: string,
  here: number,
  total: number,
): { title: string; count: string; tooltip: string } {
  const title = repoLeaf(repoRoot);
  const whole = here >= total;
  return {
    title,
    count: whole ? `${here} agent${here === 1 ? "" : "s"}` : `${here} of ${total}`,
    tooltip: whole
      ? `${repoRoot} - ${here} session${here === 1 ? "" : "s"}, all of them here`
      : `${repoRoot} - ${here} of ${total} sessions in this repository, on this board`,
  };
}

/**
 * The frame header over the sessions of one repository, for the board and the console rail.
 *
 * The third member of the `EnsembleClusterHead` / `PipelineClusterHead` family, and a separate
 * component for the same reason those two are separate from each other: what it draws does not
 * carry over. An ensemble's header is about a comparison in flight and a pipeline's about a
 * feature's position, while this one is about identity - which project these cards belong to -
 * and identity is the one thing on this board with no progress, no stage and no verdict. What
 * IS shared is the shape, so it borrows the same classes and the three read as one kind of
 * structure in a column.
 *
 * ONE line, unlike the two-line head it borrows the box from. The cluster head needs two
 * because it carries a strategy, a stage word, progress dots and an attention badge; a
 * repository carries a name and a count, and putting the count on its own line spent a whole
 * row of every column in the board on four characters.
 *
 * A DISCLOSURE, not a link. The other two heads open their run, because a run is a thing
 * elsewhere in the app with a page of its own. A repository is not - so the useful action is
 * the one this header is already the top of: fold the group away while you read the rest of the
 * board. `expanded` and `onToggle` are the caller's, because the state is per FRAME rather than
 * per repository: folding a repository in the idle column must not fold away the sibling
 * waiting for you in "needs you".
 *
 * ONE markup for both surfaces, including the swatch - which the BOARD does not draw. The
 * board's frame carries the repository's colour on its own top and leading edges
 * (`.board-repo` in `styles.css`), so a dot beside the name there is the same fact twice; a
 * rail row has no frame to put an edge on, so the dot is the only colour it has. That is a
 * difference in what the two surfaces LOOK like, not in what this header IS, so it is settled
 * with one `display: none` in the stylesheet rather than with a branch here.
 */
export function RepoGroupHead({
  repoRoot,
  here,
  total,
  variant,
  expanded,
  onToggle,
}: {
  repoRoot: string;
  /** Cards in this frame. See `repoGroupHeadline`. */
  here: number;
  /** Cards this repository has on the whole board, from `repoSessionTotals`. */
  total: number;
  /** `board` draws the framed head; `rail` draws the one-line rail group. */
  variant: "board" | "rail";
  expanded: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const { title, count, tooltip } = repoGroupHeadline(repoRoot, here, total);
  const action = expanded ? "Collapse" : "Expand";
  // The accessible name carries the action as well as the subject, because that is what a
  // person operating this by keyboard needs to know before they press it - and `aria-expanded`
  // below states the same fact in the way a screen reader can announce on its own.
  const label = `${action} ${title} - ${tooltip}`;
  if (variant === "rail") {
    return (
      <Tooltip label={tooltip}>
        <button
          className="rail-ensemble-group rail-repo-group"
          aria-label={label}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <span className="brh-swatch" aria-hidden />
          <span className="reg-title">{title}</span>
          <span className="reg-stage">{count}</span>
          <RepoGroupCaret />
        </button>
      </Tooltip>
    );
  }
  return (
    <Tooltip label={tooltip}>
      <button
        className="board-cluster-head board-repo-head"
        aria-label={label}
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="brh-swatch" aria-hidden />
        <span className="bch-title">{title}</span>
        <span className="bch-meta">{count}</span>
        <RepoGroupCaret />
      </button>
    </Tooltip>
  );
}

/**
 * The disclosure caret, drawn rather than set.
 *
 * It was the `⌄` character, which sits on its own font baseline and therefore never lines up
 * with the one-line row it is in - the only part of this header that looked unfinished at every
 * size. Two sizes of the same problem, since the rail draws the same control.
 *
 * Keeps the `brh-chevron` class and takes its colour from `currentcolor`, so the rotation stays
 * where it already was: a single stylesheet rule hung off `[aria-expanded="false"]`, which is the
 * button's own state. A caret that pointed one way while the control announced the other is
 * exactly what driving it off a wrapper class would allow.
 *
 * `aria-hidden`, because the accessible name and `aria-expanded` on the button already say both
 * what this is and which way it points.
 */
function RepoGroupCaret(): React.JSX.Element {
  return (
    <svg className="brh-chevron" viewBox="0 0 12 12" aria-hidden focusable="false">
      <path
        d="M2.8 4.4 6 7.8l3.2-3.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function WorkflowRailMark({
  run,
  onOpen,
}: {
  run: WorkflowRunSummary | null;
  onOpen?: () => void;
}): React.JSX.Element | null {
  if (!run) return null;
  return (
    <Tooltip label={`${run.workflowName} v${run.workflowVersion}: ${workflowRunLabel(run)}`}>
      <span
        className={`rail-workflow workflow-${workflowRunTone(run)}`}
        onClick={(event) => {
          event.stopPropagation();
          onOpen?.();
        }}
      >
        ⌁
      </span>
    </Tooltip>
  );
}

// The Ensemble marks are the Workflow marks' sibling, deliberately drawn from a DIFFERENT
// datum and a DIFFERENT vocabulary so the two never conflate on one session. A Workflow mark
// answers the review/repair/gate state of one selected session; an Ensemble mark answers which
// member of a group this session is and how the group ranked it. The member projection already
// rides on `session.task.ensemble` (a `TaskEnsembleLink`), so - unlike Workflow, which joins a
// run to a session in App - these read it straight off the session, the way the Inspector marks
// read `session.inspector`, while taking a Workflow-style open handler for the click.
export type EnsembleMemberTone = "running" | "waiting" | "blocked" | "kept" | "out";

/**
 * `blocked` is its own tone rather than a reuse of `waiting`, and the distinction is the
 * whole point of the mark: `waiting` is "this candidate has submitted and the RUN is working
 * on it", which needs nothing from anyone, while `blocked` is "this candidate is waiting on
 * YOU". Both painted the same colour is exactly the disagreement between a red card and a chip
 * reading "working" that the wire signal was added to close.
 *
 * It is read off `TaskEnsembleLink.needsInput` - the server's own derivation - never re-derived
 * from `session.pendingReviews` here, so the chip and the run row's count cannot answer
 * differently (Phase 1's handoff).
 */
export function ensembleMemberTone(link: TaskEnsembleLink): EnsembleMemberTone {
  if (link.needsInput) return "blocked";
  switch (link.status) {
    case "retained":
    case "advanced":
      return "kept";
    case "eliminated":
    case "failed":
    case "withdrawn":
      return "out";
    case "submitted":
    case "reviewing":
      return "waiting";
    default:
      // pending, launching, active, or a status this build cannot name (null)
      return "running";
  }
}

/**
 * A short human phrase for this member's current standing.
 *
 * "needs an answer" wins over everything, including the server-derived `resultLabel`: a member
 * holding an unanswered question is the one state the operator can act on, and a chip reading
 * "submitted" over a session that is parked on a dialog is the same lie the tone above removes.
 * Otherwise it prefers `resultLabel` ("rank 1", "advanced", "retained") when it exists;
 * components render that string and never interpret strategy-specific JSON to derive one of
 * their own.
 */
export function ensembleMemberStateLabel(link: TaskEnsembleLink): string {
  if (link.needsInput) return "needs an answer";
  if (link.resultLabel) return link.resultLabel;
  switch (link.status) {
    case "retained":
      return "selected";
    case "advanced":
      return "advanced";
    case "eliminated":
      return "not selected";
    case "failed":
      return "failed";
    case "withdrawn":
      return "withdrawn";
    case "submitted":
      return "submitted";
    case "reviewing":
      return "in review";
    case "active":
      return "working";
    case "launching":
      return "launching";
    case "pending":
      return "queued";
    default:
      return "member";
  }
}

/**
 * The ONE hover sentence every ensemble mark shows, so the four session drawings cannot drift
 * on what a member's standing is or how it is explained (`session-leaf-parity.test.ts`).
 *
 * The denominator is `maxMembers`, the roster the operator chose, not `launchedMembers`, which
 * climbs wave by wave - "candidate 3 of 3" on a five-lane run that has launched three is a
 * sentence that changes meaning while nothing about the member did. The run clause is appended
 * only where a summary is reachable; it is the same `ensembleStageWord` the run detail, the run
 * list and the cluster headers use.
 */
function ensembleMemberTooltip(link: TaskEnsembleLink, summary?: EnsembleSummary | null): string {
  const head = `${link.strategyLabel}: candidate ${link.ordinal} of ${link.maxMembers} - ${ensembleMemberStateLabel(link)}`;
  const blocked = link.needsInput ? " (this candidate is waiting on your answer)" : "";
  const run = summary
    ? ` · run: ${ensembleStageWord(summary)}, ${summary.membersReady} of ${summary.maxMembers} in`
    : "";
  return `${head}${blocked}${run}`;
}

export function EnsembleChip({
  link,
  summary = null,
  onOpen,
}: {
  link: TaskEnsembleLink | null;
  /**
   * The run this member belongs to, when the surface can reach it. Optional because the link
   * alone is enough to draw the member's own standing; the summary only adds the RUN's progress
   * suffix, which is a fact about the group rather than about this session.
   */
  summary?: EnsembleSummary | null;
  onOpen?: () => void;
}): React.JSX.Element | null {
  if (!link) return null;
  const label = ensembleMemberTooltip(link, summary);
  return (
    <Tooltip label={label}>
      <button
        className={`ensemble-chip ensemble-${ensembleMemberTone(link)}`}
        aria-label={label}
        onClick={(event) => {
          event.stopPropagation();
          onOpen?.();
        }}
      >
        <span aria-hidden>⧉</span>
        {link.strategyLabel} · {ensembleMemberStateLabel(link)}
        {summary && (
          <span className="ensemble-chip-progress">
            {" "}
            · {summary.membersReady}/{summary.maxMembers} in
          </span>
        )}
      </button>
    </Tooltip>
  );
}

export function EnsembleTileFlag({
  link,
  summary = null,
  onOpen,
}: {
  link: TaskEnsembleLink | null;
  summary?: EnsembleSummary | null;
  onOpen?: () => void;
}): React.JSX.Element | null {
  if (!link) return null;
  const label = ensembleMemberTooltip(link, summary);
  return (
    <Tooltip label={label}>
      <button
        className={`tile-flag tf-ensemble ensemble-${ensembleMemberTone(link)}`}
        aria-label={label}
        onClick={(event) => {
          event.stopPropagation();
          onOpen?.();
        }}
      >
        <span aria-hidden>E</span> {link.ordinal}/{link.maxMembers} ·{" "}
        {ensembleMemberStateLabel(link)}
      </button>
    </Tooltip>
  );
}

export function EnsembleRailMark({
  link,
  summary = null,
  onOpen,
}: {
  link: TaskEnsembleLink | null;
  summary?: EnsembleSummary | null;
  onOpen?: () => void;
}): React.JSX.Element | null {
  if (!link) return null;
  const label = ensembleMemberTooltip(link, summary);
  // A span, not a button: the whole rail row is already a button, and a button inside a button
  // is invalid. This matches `WorkflowRailMark`; the row stays the keyboard-focusable element and
  // the aria-label names what the click opens.
  //
  // The tone class is the rail's whole share of the state signal - it has one line of room and a
  // name to fit in it - so a blocked member's `E` goes attention-coloured where the tile grows a
  // phrase. Same decision, three densities.
  return (
    <Tooltip label={label}>
      <span
        className={`rail-ensemble ensemble-${ensembleMemberTone(link)}`}
        aria-label={label}
        onClick={(event) => {
          event.stopPropagation();
          onOpen?.();
        }}
      >
        <span aria-hidden>E</span>
        {link.needsInput ? (
          <span className="rail-ensemble-label">needs you</span>
        ) : (
          link.resultLabel && <span className="rail-ensemble-label">{link.resultLabel}</span>
        )}
      </span>
    </Tooltip>
  );
}

/** One member's disposition in the dot row, in the order the dots are drawn. */
const ENSEMBLE_DOT_KINDS = ["blocked", "done", "working", "out", "pending"] as const;

type EnsembleDotKind = (typeof ENSEMBLE_DOT_KINDS)[number];

/**
 * How many dots of each disposition one run draws, from the summary's member counts.
 *
 * Phase 1 made `membersOut` / `membersNeedingInput` / `membersReady` PAIRWISE DISJOINT at the
 * source - a submitted member sitting on an unanswered question is counted blocked, not ready -
 * so "working" is the remainder this consumer computes and the total is `maxMembers` by
 * construction. `membersReady`, never `readyArtifacts`: the latter counts ARTIFACTS, and a
 * member that submitted twice would draw two dots for one agent.
 *
 * The clamping is defensive rather than load-bearing. It exists so a summary written by a build
 * with a different idea of these counts draws a short row instead of a row longer than the
 * roster; the exclusivity that makes it unnecessary lives on the wire.
 */
export function ensembleDotCounts(
  summary: Pick<
    EnsembleSummary,
    "launchedMembers" | "maxMembers" | "membersOut" | "membersNeedingInput" | "membersReady"
  >,
): Record<EnsembleDotKind, number> {
  const whole = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0);
  const cap = whole(summary.maxMembers);
  const blocked = whole(summary.membersNeedingInput);
  const done = whole(summary.membersReady);
  const out = whole(summary.membersOut);
  const working = Math.max(0, whole(summary.launchedMembers) - (blocked + done + out));

  const counts = { blocked: 0, done: 0, working: 0, out: 0, pending: 0 } as Record<
    EnsembleDotKind,
    number
  >;
  let room = cap;
  for (const [kind, want] of [
    ["blocked", blocked],
    ["done", done],
    ["working", working],
    ["out", out],
  ] as const) {
    const take = Math.min(want, room);
    counts[kind] = take;
    room -= take;
  }
  counts.pending = room;
  return counts;
}

/**
 * A run's progress as one dot per member of the roster.
 *
 * The ONE progress rendering (Phase 3's handoff): the board cluster header, the console rail's
 * cluster header and the Ensembles list row all mount this, so "how far along is this run" is
 * answered identically wherever it is asked. A second dot row somewhere else is the thing not
 * to write.
 *
 * The dots are AGGREGATES, not an ordered roster: they say how many members are in each
 * disposition and deliberately never claim which ordinal is which - the summary carries counts,
 * and inventing positions from them would be a picture the wire cannot support. The label says
 * so, so a reader cannot take the third square for candidate 3.
 */
type EnsembleDotInput = Pick<
  EnsembleSummary,
  "launchedMembers" | "maxMembers" | "membersOut" | "membersNeedingInput" | "membersReady"
>;

/**
 * The dot row said in words: "1 waiting on you, 2 submitted, 1 working, 1 not started".
 *
 * Shared because the dots are drawn in two ACCESSIBILITY situations, not one. In the Ensembles
 * list row the dot span is an ordinary descendant, so its own `role="img"` name is announced.
 * Inside a cluster header it is not: that header is a native `<button>` carrying an `aria-label`,
 * and an element's label REPLACES its subtree in the accessibility tree - so the dots' own name
 * is dropped and every state they draw goes with it. The header therefore folds this sentence
 * into its own name (`ensembleClusterHeadline`) rather than relying on the nested element, and
 * both readings come from here so they cannot describe the same dots differently.
 *
 * Empty string when there is nothing to say, so a caller can `filter(Boolean)` it into a list.
 */
export function ensembleDotSummary(summary: EnsembleDotInput | null): string {
  if (!summary) return "";
  const counts = ensembleDotCounts(summary);
  const said: string[] = [];
  if (counts.blocked > 0) said.push(`${counts.blocked} waiting on you`);
  if (counts.done > 0) said.push(`${counts.done} submitted`);
  if (counts.working > 0) said.push(`${counts.working} working`);
  if (counts.out > 0) said.push(`${counts.out} out`);
  if (counts.pending > 0) said.push(`${counts.pending} not started`);
  return said.join(", ");
}

export function EnsembleProgressDots({
  summary,
}: {
  summary: EnsembleDotInput | null;
}): React.JSX.Element | null {
  const said = ensembleDotSummary(summary);
  if (!summary || !said) return null;
  const counts = ensembleDotCounts(summary);
  // The caveat rides on the DOTS and not on the header's sentence: a row of squares invites
  // "the third one is candidate 3", where a spoken list of counts cannot be misread that way.
  const label = `${said} - counts, not positions: a dot names no candidate`;

  return (
    <Tooltip label={label}>
      <span className="ens-dots" role="img" aria-label={label}>
        {ENSEMBLE_DOT_KINDS.flatMap((kind) =>
          Array.from({ length: counts[kind] }, (_, i) => (
            <span key={`${kind}-${i}`} className={`ens-dot ens-dot-${kind}`} aria-hidden />
          )),
        )}
      </span>
    </Tooltip>
  );
}

/**
 * What a cluster header SAYS about its run, decided once for both densities.
 *
 * The board's frame and the rail's header are two vocabularies of the same header - the same
 * split the chip / tile flag / rail mark family makes - so the sentence a hover shows comes
 * from here and only the rendering differs.
 *
 * `fallbackLabel` is what the header is called before that run's SSE summary has arrived (the
 * member link's strategy label). A cluster exists the moment two sibling sessions do, which can
 * be a tick ahead of the summary; a header that rendered nothing until then would flicker a
 * frame in and out around tiles that never moved.
 *
 * It is also the header's ACCESSIBLE NAME - both densities pass it as `aria-label`, which
 * REPLACES their subtree for assistive tech - so it has to state everything the header shows,
 * including what its nested children would otherwise have said for themselves. Three things
 * used to fall out of it:
 *
 *  - the run's name, because the no-summary branch said only "Open this ensemble run" while the
 *    header visibly read "Best of N";
 *  - the attention count, read off the summary alone, so during that same SSE gap a screen
 *    reader missed a "1 needs you" badge that was on screen - it comes from `blockedHere` now,
 *    which is derived from member links and known whether or not the summary has landed;
 *  - every dot state but "submitted". The progress dots carry their own `role="img"` name, and
 *    that name is dropped inside a labelled button, so a run with working, out or pending
 *    members lost them entirely. The roster clause is `ensembleDotSummary`, the same sentence
 *    the dots use, so the two readings of one row cannot drift.
 *
 * The attention clause distinguishes HERE from ELSEWHERE for the reason the badges do: a header
 * is repeated in every tone column its members landed in, and "1 waiting on your answer" said in
 * the column that holds none of them is a sentence pointing at the wrong tiles. It states
 * LOCATION rather than repeating the count the roster clause already gave.
 */
export function ensembleClusterHeadline(
  summary: EnsembleSummary | null,
  fallbackLabel: string,
  blockedHere = 0,
): { title: string; tooltip: string } {
  const title = summary?.title ?? fallbackLabel;
  const { here, elsewhere } = ensembleAttentionInFrame(summary, blockedHere);
  const roster = ensembleDotSummary(summary);
  const where = [
    here > 0 ? `${here} in this column` : "",
    elsewhere > 0 ? `${elsewhere} in another column` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const sentences = [
    summary ? `Open ${title} - ${summary.strategyLabel}, ${ensembleStageWord(summary)}` : `Open ${title}`,
    roster ? `Roster of ${summary!.maxMembers}: ${roster}` : "",
    where ? `Waiting on your answer: ${where}` : "",
  ].filter(Boolean);
  return { title, tooltip: `${sentences.join(". ")}.` };
}

function ensembleAttentionInFrame(
  summary: EnsembleSummary | null,
  blockedHere: number,
): { here: number; elsewhere: number } {
  return {
    here: blockedHere,
    elsewhere: Math.max(0, (summary?.membersNeedingInput ?? 0) - blockedHere),
  };
}

/**
 * The header a cluster of sibling members wears, in the rail's density.
 *
 * Shared by the console rail and the board's drilled-in column for the reason `RailRow` itself
 * is: those two ARE the same rail, and a header written twice is the one that stops matching.
 * A `<button>` rather than a row, because unlike `RailRow` it is not nested inside one - the
 * deep link into the run is reachable from the keyboard here. It is NOT a session row: rail
 * navigation walks session ids (`layoutNav.ts`), so an arrow key steps straight past it.
 * Phase 3 step 6 deliberately omits the strategy label at this density; member rows retain it.
 */
export function EnsembleRailGroup({
  summary,
  fallbackLabel,
  blockedHere,
  onOpen,
}: {
  summary: EnsembleSummary | null;
  fallbackLabel: string;
  /** Members of this cluster, in THIS column, waiting on the operator. See `EnsembleClusterHead`. */
  blockedHere: number;
  onOpen?: () => void;
}): React.JSX.Element {
  const { title, tooltip } = ensembleClusterHeadline(summary, fallbackLabel, blockedHere);
  const attention = ensembleAttentionInFrame(summary, blockedHere);
  return (
    <Tooltip label={tooltip}>
      <button
        className={`rail-ensemble-group${attention.here > 0 ? " needs-you" : ""}`}
        aria-label={tooltip}
        onClick={onOpen}
      >
        <span className="reg-glyph" aria-hidden>
          ⧉
        </span>
        <span className="reg-title">{title}</span>
        {summary && <span className="reg-stage">{ensembleStageWord(summary)}</span>}
        <EnsembleProgressDots summary={summary} />
        {attention.here > 0 && <span className="reg-needs">!{attention.here}</span>}
        {attention.elsewhere > 0 && (
          <span className="reg-needs is-elsewhere">!{attention.elsewhere}</span>
        )}
      </button>
    </Tooltip>
  );
}

/**
 * The rule that splits a tone group's genuinely-free sessions from the ones an open workflow
 * run is holding.
 *
 * ONE component for the board column and the console rail, because the two sit either side of
 * the board's drill-in morph: the idle column becomes the rail, and a section rule that read
 * differently across that transition would look like the fleet had regrouped when only the
 * layout moved.
 *
 * Not a heading element and not focusable. Rail and board navigation both walk session ids
 * (`layoutNav.ts`), so an arrow key has to step over this without landing on it - the same
 * contract the cluster header row already has.
 *
 * `held` carries the sentence because the two sides are not symmetric: "free" needs no
 * explanation, while "held by a workflow" is a state the fleet has no other words for, and
 * saying it once per section beats repeating it on every tile below.
 */
export function FleetSectionHead({
  kind,
  count,
}: {
  kind: "free" | "held";
  count: number;
}): React.JSX.Element {
  return (
    <div className={`fleet-section fleet-section-${kind}`} role="presentation">
      <span className="fleet-section-line">
        <b>{kind === "free" ? "free" : "held by a workflow"}</b>
        <span className="fleet-section-n">{count}</span>
      </span>
      {kind === "held" && (
        // Count-agnostic on purpose. "Each finished its turn and is waiting..." was written for
        // the plural and reads as a grammar error over a section of one, which is the common
        // case. It is also the shorter of the two, and this wraps to three lines at the 250px a
        // board column gets by default.
        <span className="fleet-section-why">
          Waiting on a run that is still open - it sends the next round on its own.
        </span>
      )}
    </div>
  );
}

/**
 * The header the board's cluster frame wears: the run, where it is, and what it wants.
 *
 * The board has room the rail does not, so this is the one surface that spells the attention
 * rollup out rather than leaving it to a tone - and it spells TWO of them, because a cluster is
 * repeated in every tone column its members landed in and one badge would say the wrong thing in
 * all but one of them. "1 needs you" means a member in THIS frame is holding a question and the
 * tiles below it are what to click; "1 needs you elsewhere" means the run has one and it is in
 * another column, which is a pointer rather than an instruction. Painting both the same is how
 * the "gone" column ends up wearing an amber badge over a failed candidate.
 *
 * Two EXPLICIT lines, not one wrapping row: a board column is 250px by default, so
 * title-strategy-stage-dots-badge on one flex row reflowed differently every time a word changed
 * length and could start line two on a bare separator. Two lines rather than one grid, because a
 * grid track shared by the dots and the badge is sized by the wider of them - which is how the
 * elsewhere badge ended up squeezing the run title down to "Fix the ...".
 */
export function EnsembleClusterHead({
  summary,
  fallbackLabel,
  blockedHere,
  onOpen,
}: {
  summary: EnsembleSummary | null;
  fallbackLabel: string;
  /**
   * How many members of THIS frame are waiting on the operator - not the run's total, which the
   * summary carries. The two differ in exactly the case the tone-boundary rule creates.
   */
  blockedHere: number;
  onOpen?: () => void;
}): React.JSX.Element {
  const { title, tooltip } = ensembleClusterHeadline(summary, fallbackLabel, blockedHere);
  const attention = ensembleAttentionInFrame(summary, blockedHere);
  return (
    <Tooltip label={tooltip}>
      <button
        className={`board-cluster-head${attention.here > 0 ? " needs-you" : ""}`}
        aria-label={tooltip}
        onClick={onOpen}
      >
        <span className="bch-line">
          <span className="bch-glyph" aria-hidden>
            ⧉
          </span>
          <span className="bch-title">{title}</span>
          <EnsembleProgressDots summary={summary} />
        </span>
        {(summary || attention.here > 0 || attention.elsewhere > 0) && (
          <span className="bch-line">
            {summary && (
              <span className="bch-meta">
                {summary.strategyLabel} · {ensembleStageWord(summary)}
              </span>
            )}
            {attention.here > 0 ? (
              <span className="bch-needs">
                {attention.here} need{attention.here === 1 ? "s" : ""} you
              </span>
            ) : (
              attention.elsewhere > 0 && (
                <span className="bch-needs is-elsewhere">{attention.elsewhere} elsewhere</span>
              )
            )}
          </span>
        )}
      </button>
    </Tooltip>
  );
}

/** How many of these sessions are members waiting on the operator, per their own link. */
export function blockedMembersIn(sessions: readonly Session[]): number {
  return sessions.filter((s) => s.task?.ensemble?.needsInput).length;
}

/**
 * A generated task's schedule provenance, drawn in three surface vocabularies.
 *
 * The same session-level-signal shape as the Inspector and Workflow families above: one
 * DECISION (`scheduleOriginTooltip`, the hover copy) shared by a card/detail chip, a Board
 * tile flag, and a rail glyph, so the three surfaces cannot drift on what a scheduled task
 * says or how it is explained. The mark exists only on a task the scheduler filed - all
 * three read `task.scheduleId` and render nothing for manual, external-source, or
 * pre-feature work, exactly as `Task`/`TaskSummary` promise those fields move together.
 *
 * Clicking any of them opens Recurring Missions at this schedule's run history through
 * `onOpen`, which never touches session state - a provenance link is a deep link, not a
 * card action, so each stops propagation so it does not also select/expand the session or
 * start a backlog drag.
 */
export interface ScheduleProvenanceSource {
  scheduleId: string | null;
  scheduleOccurrenceId: string | null;
  scheduledFor: number | null;
}

interface ResolvedScheduleOrigin {
  scheduleId: string;
  occurrenceId: string | null;
  scheduledFor: number | null;
}

/** The provenance a generated task carries, or null for ordinary/manual/external work. */
export function scheduleProvenance(
  task: ScheduleProvenanceSource | null | undefined,
): ResolvedScheduleOrigin | null {
  if (!task?.scheduleId) return null;
  return {
    scheduleId: task.scheduleId,
    occurrenceId: task.scheduleOccurrenceId,
    scheduledFor: task.scheduledFor,
  };
}

/** The one hover sentence, shared by all three surfaces so their copy cannot diverge. */
function scheduleOriginTooltip(
  scheduleName: string | null,
  origin: ResolvedScheduleOrigin,
): string {
  const ids = origin.occurrenceId
    ? `schedule ${origin.scheduleId}, occurrence ${origin.occurrenceId}`
    : `schedule ${origin.scheduleId}`;
  const who = scheduleName
    ? `Scheduled by ${scheduleName}`
    : `Filed by a recurring mission (${ids})`;
  const when =
    origin.scheduledFor != null ? ` for ${formatScheduledFor(origin.scheduledFor)}` : "";
  return `${who}${when} - open its run history`;
}

/** The chip's visible text: the live name and time when we have them, "Scheduled" otherwise. */
function scheduleOriginText(scheduleName: string | null, scheduledFor: number | null): string {
  const base = scheduleName ?? "Scheduled";
  return scheduledFor != null ? `${base} · ${formatScheduledFor(scheduledFor)}` : base;
}

export interface ScheduleOriginProps {
  task: ScheduleProvenanceSource | null | undefined;
  /** Live catalog names by schedule id; absent for an archived or purged schedule. */
  scheduleNames?: ReadonlyMap<string, string>;
  /**
   * Deep-link into run history. `scheduledFor` is the occurrence's instant, passed so
   * history can seed its cursor and open the exact run without paging - see ScheduleHistory.
   */
  onOpen?: (scheduleId: string, occurrenceId?: string, scheduledFor?: number) => void;
}

/** Card and Console-detail vocabulary: a labelled pill. */
export function ScheduleOriginChip({
  task,
  scheduleNames,
  onOpen,
}: ScheduleOriginProps): React.JSX.Element | null {
  const origin = scheduleProvenance(task);
  if (!origin) return null;
  const name = scheduleNames?.get(origin.scheduleId) ?? null;
  return (
    <Tooltip label={scheduleOriginTooltip(name, origin)}>
      <button
        className="schedule-chip"
        onMouseDown={(event) => event.stopPropagation()}
        onDragStart={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onOpen?.(origin.scheduleId, origin.occurrenceId ?? undefined, origin.scheduledFor ?? undefined);
        }}
      >
        <span aria-hidden>◷</span>
        {scheduleOriginText(name, origin.scheduledFor)}
      </button>
    </Tooltip>
  );
}

/** Board overview-tile vocabulary: a compact `.tile-flag`. */
export function ScheduleOriginTileFlag({
  task,
  scheduleNames,
  onOpen,
}: ScheduleOriginProps): React.JSX.Element | null {
  const origin = scheduleProvenance(task);
  if (!origin) return null;
  const name = scheduleNames?.get(origin.scheduleId) ?? null;
  const label = scheduleOriginTooltip(name, origin);
  return (
    <Tooltip label={label}>
      <button
        className="tile-flag tf-schedule"
        aria-label={label}
        onClick={(event) => {
          event.stopPropagation();
          onOpen?.(origin.scheduleId, origin.occurrenceId ?? undefined, origin.scheduledFor ?? undefined);
        }}
      >
        ◷ scheduled
      </button>
    </Tooltip>
  );
}

/** Console-rail / Board drilled-in vocabulary: a bare glyph with an accessible name. */
export function ScheduleOriginRailMark({
  task,
  scheduleNames,
  onOpen,
}: ScheduleOriginProps): React.JSX.Element | null {
  const origin = scheduleProvenance(task);
  if (!origin) return null;
  const name = scheduleNames?.get(origin.scheduleId) ?? null;
  const label = scheduleOriginTooltip(name, origin);
  return (
    <Tooltip label={label}>
      {/* A mouse-only glyph, deliberately - NOT a focusable/role="button" control. The rail
          row is itself a native <button>, so any interactive descendant here would be an
          invalid nested control the a11y tree announces inconsistently (Inspector round on
          #241). It matches the sibling WorkflowRailMark / InspectorRailMark for that reason.
          The KEYBOARD-accessible path to this history deep link is the card chip, the console
          detail chip, and the board tile flag - all proper focusable buttons outside any row
          button. stopPropagation keeps a click off the row it sits inside. */}
      <span
        className="rail-schedule"
        onClick={(event) => {
          event.stopPropagation();
          onOpen?.(origin.scheduleId, origin.occurrenceId ?? undefined, origin.scheduledFor ?? undefined);
        }}
      >
        ◷
      </span>
    </Tooltip>
  );
}

/**
 * What this session is trying to solve, under the title.
 *
 * Sits OUTSIDE any expand gate on purpose - a sentence you have to click to read is not a
 * status line. Distinct from `.activity`, the ticker ("running Bash"): what it is FOR versus
 * what it is doing this second, so the goal reads as primary text and the ticker stays muted.
 */
export function GoalLine({ session }: { session: Session }): React.JSX.Element | null {
  const unsupported = GOAL_UNSUPPORTED[session.agent];
  if (unsupported) {
    return (
      <Tooltip label={`Goal is derived from a session's prompts. ${unsupported}`}>
        <p className="goal goal-none">No goal · {unsupported}</p>
      </Tooltip>
    );
  }
  if (!session.goal?.text) return null;
  const resolving =
    (session.goal.resolvedPromptRevision ?? 0) < (session.goal.promptRevision ?? 0);
  const unclear = session.goal.relationship === "unclear";
  const stateClass = resolving ? "resolving" : unclear ? "unclear" : session.goal.source ?? "heuristic";
  const detail = resolving
    ? `${session.goal.text} (reconciling the latest instruction with this objective)`
    : unclear
      ? `${session.goal.text} (latest instruction may change this objective; automatic wrap-up is paused)`
      : session.goal.source === "heuristic"
        ? `${session.goal.text} (initial objective, being refined)`
        : session.goal.text;
  return (
    <Tooltip label={detail}>
      <p className={`goal goal-${stateClass}`}>{session.goal.text}</p>
    </Tooltip>
  );
}

/**
 * What the Inspector has to say about this session's pull request, in one chip.
 *
 * Renders nothing at all unless the PR was ADOPTED, and that silence is meaningful: the
 * Inspector only adopts PRs it can prove Mission Control opened, so a card showing a PR
 * chip and no inspector chip is telling you that PR came from somewhere else and will
 * never be commented on.
 *
 * Counts rather than findings. The card's job is to say whether to go and look; the pull
 * request is where you look.
 */
export type InspectorTone = "insp-failed" | "insp-queued" | "insp-clean" | "insp-findings";

export interface InspectorChipView {
  mark: string;
  /**
   * A union rather than a string, because the rail FILTERS on it. These double as CSS
   * class names, so a rename that updated the helper and `styles.css` would silently
   * turn the rail's suppression off with no type error anywhere.
   */
  tone: InspectorTone;
  /**
   * Reviewed but posted nothing. Its own field rather than prose folded into `title`,
   * so every surface can render the distinction instead of only the one that happens to
   * check `mode` itself. This is the difference the feature's safety story rests on: a
   * bare `⌕ 3` must not read the same whether those three findings are public review
   * comments or were merely recorded.
   */
  dry: boolean;
  title: string;
}

export function inspectorChipView(inspector: Session["inspector"]): InspectorChipView | null {
  if (!inspector) return null;
  const dry = inspector.mode === "dry-run";
  const suffix = dry ? " (dry run - nothing was posted)" : "";
  if (inspector.failed) {
    return {
      mark: "!",
      tone: "insp-failed",
      dry,
      title: `GitHub Inspector: the last review of this pull request did not complete${suffix}`,
    };
  }
  if (inspector.round === 0) {
    // Glyph alone. "Adopted, not looked at yet" is the least urgent thing this chip can
    // say, and it should not cost a single character more than its own presence.
    return {
      mark: "",
      tone: "insp-queued",
      dry,
      title: `GitHub Inspector: adopted for review, not looked at yet${suffix}`,
    };
  }
  if (inspector.open === 0) {
    return {
      mark: "✓",
      tone: "insp-clean",
      dry,
      title: `GitHub Inspector: reviewed, nothing outstanding${suffix}`,
    };
  }
  return {
    mark: `${inspector.open}`,
    tone: "insp-findings",
    dry,
    title:
      `GitHub Inspector: ${inspector.open} open finding${inspector.open === 1 ? "" : "s"} ` +
      `after ${inspector.round} round${inspector.round === 1 ? "" : "s"}${suffix}`,
  };
}

/** The card/detail Inspector chip; all four drawings share `inspectorChipView`. */
export function InspectorChip({ session }: { session: Session }): React.JSX.Element | null {
  const view = inspectorChipView(session.inspector);
  if (!view || !session.inspector) return null;
  return (
    <Tooltip label={view.title}>
      <a
        className={`insp-chip ${view.tone}${view.dry ? " insp-dry" : ""}`}
        href={session.inspector.url}
        target="_blank"
        rel="noreferrer"
        // The glyph is decorative and the mark is a bare "3" or "✓" - and nothing at all
        // in the queued state - so without this the link has no accessible name. The
        // tooltip's `aria-describedby` is a description, and only while it is open.
        aria-label={view.title}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="insp-glyph" aria-hidden>
          ⌕
        </span>
        {view.mark && <span className="insp-label">{view.mark}</span>}
      </a>
    </Tooltip>
  );
}

/**
 * The rail's own terse vocabulary for the Inspector - glyph and count, no pill - shown
 * only once there's something to flag (a live rail row has one line of room and a name
 * to fit in it). Shares `inspectorChipView` and the same instant `Tooltip` as the card's
 * `InspectorChip` so the wording and the hover behavior can't drift between surfaces -
 * only the markup is terser here.
 */
export function InspectorRailMark({ session }: { session: Session }): React.JSX.Element | null {
  const view = inspectorChipView(session.inspector);
  // Unlike InspectorChip/InspectorTileFlag, this mark never dereferences
  // `session.inspector` itself - `view` being non-null already implies it was non-null.
  if (!view) return null;
  if (view.tone === "insp-clean" || view.tone === "insp-queued") return null;
  return (
    <Tooltip label={view.title}>
      <span
        className={`rail-insp ${view.tone}${view.dry ? " insp-dry" : ""}`}
        aria-label={view.title}
      >
        ⌕{view.mark}
      </span>
    </Tooltip>
  );
}

/**
 * The board tile's own vocabulary for the Inspector - a `.tile-flag` link, matching the
 * tile's other flags - but the same shared decision and the same instant `Tooltip` as
 * `InspectorChip` and `InspectorRailMark`. Unlike the rail, the tile shows every state
 * (including queued and clean), matching what `InspectorChip` shows on the card.
 */
export function InspectorTileFlag({ session }: { session: Session }): React.JSX.Element | null {
  const view = inspectorChipView(session.inspector);
  if (!view || !session.inspector) return null;
  return (
    <Tooltip label={view.title}>
      <a
        className={`tile-flag tile-flag-link ${view.tone}${view.dry ? " insp-dry" : ""}`}
        href={session.inspector.url}
        target="_blank"
        rel="noreferrer"
        aria-label={view.title}
        onClick={(e) => e.stopPropagation()}
      >
        ⌕{view.mark && ` ${view.mark}`}
      </a>
    </Tooltip>
  );
}

export interface PrChipView {
  url: string;
  /** `#264`, or a bare `PR` when the URL carried no parsable number. */
  label: string;
  tone: string;
  state: PrState;
  failing: boolean;
  /** Wording for the PR itself, independent of its checks. */
  title: string;
  /** Wording for the failing-checks affordance, wherever a surface has room for one. */
  failingTitle: string;
}

/**
 * The one "does this session have a pull request, and what does it say" decision, shared by
 * all four session drawings the way `inspectorChipView` is.
 *
 * The gate is `prUrl` and nothing else. It used to be spelled twice: `PrChip` asked for the
 * URL while the board tile and the rail asked for `prNumber`, so a pull request whose URL
 * did not parse to a number drew a chip on the card and the console and NOTHING on the
 * other two. They agree today only because `prNumber` is written exclusively as
 * `prNumberFromUrl(prUrl)` beside the URL itself - which is also why the tile's old "a
 * number but no URL yet" branch was unreachable, and is gone rather than restated here.
 * `label` is where the missing number is absorbed, so a surface renders the PR it has
 * rather than deciding for itself that it has none.
 */
export function prChipView(session: Session): PrChipView | null {
  if (!session.prUrl) return null;
  const state = session.prState ?? "open";
  const label = session.prNumber ? `#${session.prNumber}` : "PR";
  return {
    url: session.prUrl,
    label,
    tone: `pr-${state}`,
    state,
    failing: session.prChecks === "failing",
    title:
      state === "merged"
        ? `Pull request ${label} merged - open on GitHub`
        : `Open pull request ${label} - open on GitHub`,
    failingTitle: "A CI check failed on this pull request - open on GitHub",
  };
}

/** The PR chip, plus the "a CI check failed" alert beside it when checks are failing. */
export function PrChip({ session }: { session: Session }): React.JSX.Element | null {
  const view = prChipView(session);
  if (!view) return null;
  return (
    <>
      <Tooltip label={view.title}>
        <a
          className={`pr-chip ${view.tone}`}
          href={view.url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
        >
          <PrStateIcon state={view.state} />
          <span className="pr-num">{view.label}</span>
        </a>
      </Tooltip>
      {view.failing && (
        <Tooltip label={view.failingTitle}>
          <a
            className="pr-checks-alert"
            href={view.url}
            target="_blank"
            rel="noreferrer"
            aria-label={view.failingTitle}
            onClick={(e) => e.stopPropagation()}
          >
            <ChecksFailedIcon />
          </a>
        </Tooltip>
      )}
    </>
  );
}

/**
 * The rail's own vocabulary for the PR - the number alone, no icon and no separate checks
 * affordance, because the rail has one line of room and a name to fit in it. Same shared
 * decision as `PrChip` and `PrTileFlag`; only the rendering is this terse, exactly as
 * `InspectorRailMark` is to `InspectorChip`.
 *
 * This lived inline in `RailRow` with its own `prNumber` gate, which is the drift
 * `prChipView`'s comment describes. Failing checks fold into the tone the way the tile
 * does rather than adding an element.
 */
export function PrRailMark({ session }: { session: Session }): React.JSX.Element | null {
  const view = prChipView(session);
  if (!view) return null;
  const title = view.failing ? view.failingTitle : view.title;
  return (
    <Tooltip label={title}>
      <span className={`rail-pr ${view.tone}`}>
        {view.label}
        {view.failing && " ⚠"}
      </span>
    </Tooltip>
  );
}

/**
 * The board tile's own vocabulary for the PR - a `.tile-flag` link, folding the failing-
 * checks state into the same chip with a `⚠` suffix rather than `PrChip`'s separate alert
 * icon, since the tile has no room for a second element. Given the same instant `Tooltip`
 * as `InspectorTileFlag` rather than a native `title`, so two adjacent flags on the same
 * tile don't behave differently on hover. Same shared `prChipView` gate as the other three
 * drawings - see its comment for the `prNumber` gate this replaced.
 */
export function PrTileFlag({ session }: { session: Session }): React.JSX.Element | null {
  const view = prChipView(session);
  if (!view) return null;
  const title = view.failing ? view.failingTitle : view.title;
  return (
    <Tooltip label={title}>
      <a
        className={`tile-flag tile-flag-link ${view.tone}`}
        href={view.url}
        target="_blank"
        rel="noreferrer"
        // Without this the click also reaches the tile's own onClick and opens the
        // console behind the new tab. stopPropagation only: the link still has to navigate.
        onClick={(e) => e.stopPropagation()}
      >
        {view.label}
        {view.failing && " ⚠"}
      </a>
    </Tooltip>
  );
}

/** The status badge; a button that opens the reviews modal when there are pending reviews. */
export function StateBadge({
  session,
  onOpenReviews,
  display,
}: {
  session: Session;
  onOpenReviews?: () => void;
  display?: StateDisplay;
}): React.JSX.Element {
  // The transient stop lives beside the durable state rather than replacing it: one badge,
  // and the same one, so a card never grows a second place that says what a session is
  // doing. The Console detail draws this component, so it follows.
  const runtimeState = useSessionRuntimeDisplay(session);
  const st = display ?? runtimeState;
  if (session.pendingReviews > 0 && onOpenReviews) {
    return (
      <Tooltip
        label={`${session.pendingReviews} review${session.pendingReviews === 1 ? "" : "s"} waiting on you - open the queue`}
      >
        <button
          className={`badge badge-${st.tone} badge-btn`}
          onClick={(e) => {
            e.stopPropagation();
            onOpenReviews();
          }}
        >
          <span className="badge-dot" />
          {st.label} <Keycap action="review" />{" "}
          {/* Its own element so the console header's ladder can shed it: this button is the
              one thing that row is never allowed to hide, so what it gives up on a narrow
              pane is the chord hint and this arrow (`detailHeadLadder.ts`, rung 1). */}
          <span className="badge-go" aria-hidden>
            →
          </span>
        </button>
      </Tooltip>
    );
  }
  return (
    <span className={`badge badge-${st.tone}`}>
      <span className="badge-dot" />
      {st.label}
    </span>
  );
}

/**
 * The session title: either the inline rename editor, or the clickable title that opens
 * it (with the pencil affordance), or a plain heading when the session can't be renamed.
 * The name-source subtitle is a sibling the caller places, since the card wraps it with
 * the title and the console's detail head sets it beside them.
 */
export function SessionTitle({
  session,
  canRename,
  renaming,
  onRenameStart,
  onRenameClose,
}: {
  session: Session;
  canRename: boolean;
  renaming: boolean;
  onRenameStart?: () => void;
  onRenameClose?: () => void;
}): React.JSX.Element {
  const displayedName = session.name || "(unnamed)";
  const tooltipName = session.name ? sessionTitleDetail(session) : displayedName;

  if (renaming) return <RenameEditor session={session} onClose={() => onRenameClose?.()} />;
  if (canRename) {
    return (
      <h2>
        <Tooltip label={`Rename "${tooltipName}"`}>
          <button
            type="button"
            className="card-title-edit"
            onClick={(e) => {
              e.stopPropagation();
              onRenameStart?.();
            }}
          >
            <span className="card-title-name">{displayedName}</span>
            <span className="rename-pencil" aria-hidden>
              ✎
            </span>
          </button>
        </Tooltip>
      </h2>
    );
  }
  return (
    <Tooltip label={session.name ? tooltipName : "This session has no name"}>
      <h2>{displayedName}</h2>
    </Tooltip>
  );
}

/**
 * Inline title editor: the title swapped for a text box. Enter or ✓ commits, Escape or ✕
 * cancels, and clicking away blurs to cancel - so a rename only lands on an explicit save.
 * A failing rename keeps the editor open with the reason. On success the caller drops
 * rename mode; the registry's optimistic echo updates the title, so nothing here has to.
 */
export function RenameEditor({
  session,
  onClose,
}: {
  session: Session;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <InlineRenameEditor
      initialValue={session.name}
      ariaLabel="Rename session"
      onSubmit={(name) => api.rename(session.id, name)}
      onClose={onClose}
    />
  );
}

/** The three facts `RuntimeMetaRow` draws, each of which a host may leave out. */
export type RuntimeMetaPart = "model" | "effort" | "context";

/** Shared so the default prop is one frozen value rather than a new Set per render. */
const EMPTY_OMIT: ReadonlySet<RuntimeMetaPart> = new Set();

/**
 * The runtime row: model, thinking level, and a context-window pressure meter - the same
 * facts ccstatusline shows in the terminal. Each chip is independently omitted when unknown.
 *
 * A `<span>` (styled `display:flex`), not a `<div>`, so it's phrasing content: the board's
 * tile draws its whole body as spans. A layout that needs the effort control outside an
 * interactive tile flow can suppress it here and render the shared picker beside the row.
 */
export function RuntimeMetaRow({
  meta,
  session,
  omit = EMPTY_OMIT,
}: {
  meta: SessionMeta;
  session?: Session;
  /**
   * Parts this HOST does not want, which is not the same question as whether the fact is
   * known. Two unrelated callers ask it: the board renders its interactive effort control
   * as a sibling of this shared row, and the board's card items are individually hideable
   * by the operator (`lib/board-card.ts`). The console detail passes nothing and must keep
   * meaning "draw everything" - a card preference must never reach it.
   *
   * One set rather than a boolean per part, so the third and fourth caller do not each add
   * a `showX`, and so all three pills answer to the same mechanism rather than one of them
   * having a switch and the other two not.
   */
  omit?: ReadonlySet<RuntimeMetaPart>;
}): React.JSX.Element | null {
  const hasModel = Boolean(meta.model) && !omit.has("model");
  const hasEffort = Boolean(meta.thinkingLevel) && !omit.has("effort");
  const hasCtx = meta.contextPct != null && !omit.has("context");
  // Nothing LEFT to draw, which now covers both "the session has not reported it" and
  // "this host asked for it to be left out". An empty `.card-runtime` would still take its
  // flex gap on the row, so the early return has to widen with the prop.
  if (!hasModel && !hasEffort && !hasCtx) return null;
  const tone = contextTone(meta.contextPct);
  const ctxTitle =
    meta.contextTokens != null && meta.contextWindow != null
      ? `${compactTokens(meta.contextTokens)} / ${compactTokens(meta.contextWindow)} tokens in context`
      : `${meta.contextPct}% of the context window used`;
  return (
    <span className="card-runtime">
      {hasModel && (
        <Tooltip label={meta.modelId ? `Model: ${meta.modelId}` : `Model: ${meta.model}`}>
          <span className="rt-pill rt-model">
            {meta.model}
            {meta.longContext && <span className="rt-1m">1M</span>}
          </span>
        </Tooltip>
      )}
      {hasEffort &&
        (session ? (
          <EffortPicker session={session} />
        ) : (
          <Tooltip label={`Reasoning effort: ${meta.thinkingLevel}`}>
            <span className={`rt-pill rt-think rt-think-${meta.thinkingLevel}`}>
              {/* `EffortReading` owns what an effort pill prints, including the level's own
                  element - which the console header's ladder sheds while keeping the mark. It
                  is imported rather than restated so this static spelling and the picker's
                  cannot drift, which they did once. */}
              <EffortReading level={meta.thinkingLevel!} />
            </span>
          </Tooltip>
        ))}
      {hasCtx && (
        <Tooltip label={ctxTitle}>
          <span className={`rt-ctx rt-ctx-${tone}`}>
            <span className="rt-meter" aria-hidden>
              <span
                className="rt-meter-fill"
                style={{ width: `${Math.min(100, Math.max(0, meta.contextPct!))}%` }}
              />
            </span>
            <span className="rt-ctx-num">{meta.contextPct}%</span>
          </span>
        </Tooltip>
      )}
    </span>
  );
}

/**
 * One session's API-equivalent cost estimate, as a chip beside the runtime row.
 *
 * Sits next to `RuntimeMetaRow` rather than among the alert marks because cost is the
 * fourth runtime fact of the same kind as model, thinking level and context - something
 * true of the session right now, not something asking for you. Escalation is expressed by
 * the chip's own tone (see `costTone`), not by a second copy of the number in the tile's
 * `.tile-marks`; the rail, which has no room for a figure, carries a glyph instead.
 *
 * A `<span>`, not a `<div>`, for the same reason `RuntimeMetaRow` is: the board's tile
 * draws its whole body as spans, and this has to nest into that flow without being
 * invalid HTML.
 *
 * Renders NOTHING only when there is no summary or no usage. An unpriced session with tokens
 * keeps its token-only chip; a zero-dollar, zero-token summary stays absent because `≈$0.00`
 * would claim evidence the ledger does not carry.
 */
export function CostChip({ cost }: { cost: SessionCost | null }): React.JSX.Element | null {
  if (!cost) return null;
  const tokensIn = cost.input + cost.cacheRead + cost.cacheWrite;
  if (cost.costUsd === null) {
    const total = tokensIn + cost.output;
    if (total <= 0) return null;
    return (
      <Tooltip label={`${compactTokens(tokensIn)} in / ${compactTokens(cost.output)} out${cost.reasoningOutput ? ` (${compactTokens(cost.reasoningOutput)} reasoning)` : ""}. Standard API pricing unavailable${cost.pricingModels.length ? ` for ${cost.pricingModels.join(", ")}` : " because no exact model was recorded"}.`}>
        <span className="rt-pill cost-chip">{compactTokens(total)} tok</span>
      </Tooltip>
    );
  }
  if (cost.costUsd <= 0) return null;
  const tone = costTone(cost.costUsd);
  const missionEstimated = cost.basis === "api-equivalent";
  const models = cost.pricingModels.length ? cost.pricingModels.join(", ") : "unknown model";
  const versions = cost.pricingVersions.length ? cost.pricingVersions.join(", ") : "no pricing snapshot";
  return (
    <Tooltip
      label={
        missionEstimated
          ? `${fmtUsd(cost.costUsd)} API-equivalent estimate - ${compactTokens(cost.input)} uncached input, ` +
            `${compactTokens(cost.cacheRead)} cached input, ${compactTokens(cost.cacheWrite)} cache write, ` +
            `${compactTokens(cost.output)} output${cost.reasoningOutput ? ` (${compactTokens(cost.reasoningOutput)} reasoning, already included)` : ""}.\n` +
            `Model: ${models}. Pricing: ${versions}. Calculated by Mission Control; not ChatGPT plan spend or an invoice.`
          : `${fmtUsd(cost.costUsd)} API-equivalent estimate - ${compactTokens(tokensIn)} in / ` +
            `${compactTokens(cost.output)} out.\nCalculated by Claude Code; not subscription-plan spend or an invoice.`
      }
    >
      <span className={`rt-pill cost-chip cost-${tone}`}>≈{fmtUsd(cost.costUsd)}</span>
    </Tooltip>
  );
}

/** GitHub-style glyph for the PR chip: pull-request icon while open, merge icon once landed. */
export function PrStateIcon({ state }: { state: PrState }): React.JSX.Element {
  return state === "merged" ? (
    <svg className="pr-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden focusable="false">
      <path
        fill="currentColor"
        d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM4.25 4a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z"
      />
    </svg>
  ) : (
    <svg className="pr-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden focusable="false">
      <path
        fill="currentColor"
        d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"
      />
    </svg>
  );
}

/**
 * A multi-repo task's repositories, each with the pull request it has produced.
 *
 * The one drawing of "one PR per changed repo", shared by the card and the console for the
 * usual reason: the card is rendered by one layout and the detail by two, so a private copy
 * silently misses one of them.
 *
 * It renders NOTHING for a single-repo task. That is not an optimisation - it is what keeps
 * the markup of the tasks that are nearly all of them byte-identical to what it was before
 * per-repo tracking existed, and `repoPrs` is empty for exactly those tasks by construction.
 *
 * A repository with no pull request yet is drawn too, and deliberately: the whole promise the
 * dispatch modal makes is one pull request per repository you changed, and a list that
 * silently omitted the repo still missing one would hide the only thing an operator can act
 * on. It is also what the completion quorum is waiting for, said out loud.
 */
export function TaskRepoPrs({
  repoPrs,
}: {
  repoPrs: readonly TaskRepoPrSummary[];
}): React.JSX.Element | null {
  if (repoPrs.length === 0) return null;
  return (
    <span className="task-repo-prs">
      {repoPrs.map((entry) => {
        const number = prNumberIn(entry.prUrl);
        const label = number === null ? "PR" : `#${number}`;
        const state: PrState = entry.prState === "merged" ? "merged" : "open";
        const role = entry.primary ? "primary repo" : "attached repo";
        const name = repoLeaf(entry.repoRoot);
        if (!entry.prUrl) {
          return (
            <Tooltip
              key={entry.repoRoot}
              label={`${entry.repoRoot} (${role}) - no pull request opened here yet`}
            >
              <span className="task-repo-pr task-repo-pr-none">
                <span className="task-repo-name">{name}</span>
                <span className="pr-num">no PR</span>
              </span>
            </Tooltip>
          );
        }
        return (
          <Tooltip
            key={entry.repoRoot}
            label={
              state === "merged"
                ? `${entry.repoRoot} (${role}) - pull request ${label} merged - open on GitHub`
                : `${entry.repoRoot} (${role}) - pull request ${label} open - open on GitHub`
            }
          >
            <a
              className={`task-repo-pr pr-${state}`}
              href={entry.prUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
            >
              <PrStateIcon state={state} />
              <span className="task-repo-name">{name}</span>
              <span className="pr-num">{label}</span>
            </a>
          </Tooltip>
        );
      })}
    </span>
  );
}

/**
 * The number in a pull request URL, or null.
 *
 * Its own tiny reader rather than `Session.prNumber`, because these pull requests are not the
 * session's: `prNumber` is denormalized beside `prUrl` on a session by the daemon, and a
 * task's per-repo list has neither field to lean on.
 */
function prNumberIn(url: string | null): number | null {
  const m = url?.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : null;
}

/** Warning glyph for the "a CI check failed" alert: an outlined triangle with an exclamation. */
export function ChecksFailedIcon(): React.JSX.Element {
  return (
    <svg className="pr-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden focusable="false">
      <path
        fill="currentColor"
        d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"
      />
    </svg>
  );
}

/**
 * A task's priority, as a chip. Renders NOTHING when the priority is unset, which is
 * the default for every task and must stay visually silent: a backlog nobody has
 * triaged should look exactly as it did before priorities existed, not like a wall of
 * "none" chips.
 */
export function PriorityChip({ priority }: { priority: TaskPriority | null }): React.JSX.Element | null {
  if (!priority) return null;
  return (
    <Tooltip label={`Priority: ${PRIORITY_LABELS[priority]}`}>
      <span className={`task-priority prio-${priority}`}>{PRIORITY_LABELS[priority]}</span>
    </Tooltip>
  );
}

/**
 * Whether Foreman's backlog autopilot may schedule this task, as a switch.
 *
 * Shared rather than inlined because the backlog is drawn twice - the board's column
 * and the Sitrep panel's Backlog section - and a switch that existed on one of them
 * would be a hold you could set from the board and then not find again in the list you
 * were reading. Same markup, same words, same gesture, both places.
 *
 * `role="switch"` and not a checkbox: this is one card's own on/off, not membership of
 * a set, and a switch announces "on"/"off". The visible word is the STATE, never the
 * action - "disable" and "disabled" are a glance apart and mean opposite things.
 *
 * Never drawn as anything but the stored value: no optimistic flip. The patch is
 * status-guarded server-side, so the honest sequence is press, wait a beat, see it
 * move - a control that flipped instantly and sprang back on a 409 would read as
 * broken rather than refused.
 *
 * Both pointer handlers stop propagation, and that belongs HERE rather than at each
 * host: the board's card is `draggable` and click-to-edit, so without them a press
 * starts a drag and the click opens the dispatch modal on its way past. A host that
 * needs neither loses nothing by getting both.
 */
export function ScheduleSwitch({
  enabled,
  taskTitle,
  ariaLabel,
  busy = false,
  onChange,
}: {
  enabled: boolean;
  /** Named in the default accessible label, so a screen reader hears which card this is. */
  taskTitle: string;
  /** Override for a form where the surrounding label already identifies the task. */
  ariaLabel?: string;
  /** A request is in flight; the control is inert until it lands. */
  busy?: boolean;
  onChange: (enabled: boolean) => void;
}): React.JSX.Element {
  return (
    <Tooltip
      label={
        enabled
          ? "Enabled - Foreman's autopilot may schedule this. Click to hold it back."
          : "Disabled - Foreman's autopilot will skip this. You can still launch it yourself."
      }
    >
      <button
        className={`task-switch${enabled ? "" : " is-off"}`}
        role="switch"
        aria-checked={enabled}
        aria-label={ariaLabel ?? `Foreman may schedule ${taskTitle}`}
        disabled={busy}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onChange(!enabled);
        }}
      >
        <span className="task-switch-track" aria-hidden />
        {enabled ? "on" : "off"}
      </button>
    </Tooltip>
  );
}

/**
 * A task's labels, as chips. Also silent when empty, for the same reason as above.
 *
 * `max` exists because the same list is drawn in a roomy roundup row and in a narrow
 * board card; the overflow is reported as a count rather than dropped, so a card never
 * implies a task carries fewer tags than it does.
 */
export function LabelChips({
  labels,
  max = labels.length,
}: {
  labels: string[];
  max?: number;
}): React.JSX.Element | null {
  if (labels.length === 0) return null;
  const shown = labels.slice(0, max);
  const hidden = labels.length - shown.length;
  return (
    <Tooltip label={`Labels: ${labels.join(", ")}`}>
      <span className="task-labels">
        {shown.map((l) => (
          <span className="task-label" key={l}>
            {l}
          </span>
        ))}
        {hidden > 0 && <span className="task-label task-label-more">+{hidden}</span>}
      </span>
    </Tooltip>
  );
}

/**
 * The warning a backlog card wears when a cancelled or failed prerequisite is blocking
 * it - directly, or somewhere up its dependency chain (`deadBlockersFor`). Nothing else
 * on the card will ever clear it: a `stopped` dependency never satisfies, so the item
 * sits in `ready: 0` forever until a human resolves the dead task. This is where they do.
 *
 * Shared rather than inlined for the ScheduleSwitch reason: the backlog is drawn on the
 * board column and in the Sitrep, and a resolve affordance that lived on one would be a
 * fix you could reach from the board and not find in the list you were reading. It leads
 * with the same triangle the PR "checks failed" alert uses, because it is the same
 * grammar - "this will not fix itself, look here".
 *
 * Presentational, like every leaf here: it owns only its own open/closed popover, and
 * hands the two resolutions back to the host, which calls `api.rescheduleTask` /
 * `api.completeTask` exactly as `ScheduleSwitch`'s host calls `api.updateTask`. Both
 * pointer handlers stop propagation for the same reason ScheduleSwitch's do - the board
 * card underneath is `draggable` and click-to-edit.
 */
export function DeadBlockerButton({
  deadBlockers,
  busy = false,
  onReschedule,
  onComplete,
  onOpenChange,
}: {
  /** The cancelled/failed tasks blocking this card, from `deadBlockersFor`. */
  deadBlockers: Task[];
  /** A resolution is in flight; the controls are inert until it lands. */
  busy?: boolean;
  /** Put the dead task back in the backlog to run again. */
  onReschedule: (taskId: string) => void;
  /** Mark the dead task done (its work already landed), releasing this card. */
  onComplete: (taskId: string) => void;
  onOpenChange?: (open: boolean) => void;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const openRef = useRef(false);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const changeOpen = useCallback((next: boolean): void => {
    openRef.current = next;
    setOpen(next);
    onOpenChangeRef.current?.(next);
  }, []);
  useEffect(
    () => () => {
      if (openRef.current) onOpenChangeRef.current?.(false);
    },
    [],
  );
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) changeOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") changeOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [changeOpen, open]);
  useEffect(() => {
    if (deadBlockers.length === 0 && open) changeOpen(false);
  }, [changeOpen, deadBlockers.length, open]);

  if (deadBlockers.length === 0) return null;
  const summary =
    deadBlockers.length === 1
      ? `"${deadBlockers[0]!.title}" was ${deadBlockers[0]!.status} and won't finish on its own`
      : `${deadBlockers.length} prerequisites were cancelled or failed and won't finish on their own`;

  return (
    <span
      className="bl-deadblock"
      ref={ref}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <Tooltip label={summary}>
        <button
          className="bl-deadblock-btn"
          aria-label={`Blocked by a stopped task: ${summary}`}
          aria-expanded={open}
          disabled={busy}
          onClick={() => changeOpen(!open)}
        >
          <ChecksFailedIcon />
        </button>
      </Tooltip>
      {open && (
        <div className="bl-deadblock-pop" role="dialog" aria-label="Resolve a stopped prerequisite">
          <p className="bl-deadblock-lead">
            This can't be scheduled until the prerequisite below is resolved. Run it again, or mark
            it done if its work already landed.
          </p>
          <ul className="bl-deadblock-list">
            {deadBlockers.map((d) => (
              <li className="bl-deadblock-item" key={d.id}>
                <span className="bl-deadblock-name">{d.title}</span>
                <span className={`bl-deadblock-state state-${d.status}`}>{d.status}</span>
                <span className="bl-deadblock-acts">
                  <Tooltip label={`Put "${d.title}" back in the backlog to run again`}>
                    <button
                      className="btn btn-send"
                      disabled={busy}
                      onClick={() => {
                        onReschedule(d.id);
                        changeOpen(false);
                      }}
                    >
                      Reschedule
                    </button>
                  </Tooltip>
                  <Tooltip label={`Mark "${d.title}" done - use this if its work already merged`}>
                    <button
                      className="btn"
                      disabled={busy}
                      onClick={() => {
                        onComplete(d.id);
                        changeOpen(false);
                      }}
                    >
                      Mark done
                    </button>
                  </Tooltip>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </span>
  );
}

/**
 * The shared contents of the existing backlog task-notification line.
 *
 * Hosts keep their established position and sizing classes. This leaf only preserves the
 * shared copy, tone, and compact Trust remedy. Persisted launch errors retain the line's
 * transient status semantics, while derived trust posture is ordinary content: polling can
 * update many task rows at once and must not turn each one into a live-region announcement.
 * This leaf owns no scheduler state or disclosure state; a Foreman config refresh is what
 * removes a resolved trust notice.
 */
export function BacklogTaskNotice({
  notice,
  className,
  onManageTrust,
}: {
  notice: BacklogTaskNoticeView | null;
  className: string;
  onManageTrust?: () => void;
}): React.JSX.Element | null {
  if (!notice) return null;
  const hasDuplicateLeaves = notice.kind === "trust"
    && new Set(notice.missingRoots.map(repoLeaf)).size !== notice.missingRoots.length;

  return (
    <span
      className={`${className} backlog-task-notice is-${notice.kind}`}
      role={notice.kind === "error" ? "status" : undefined}
    >
      <span className="backlog-task-notice-copy">{notice.message}</span>
      {hasDuplicateLeaves && (
        <span className="sr-only">
          {` Missing repository paths: ${notice.missingRoots.join(", ")}.`}
        </span>
      )}
      {notice.kind === "trust" && onManageTrust && (
        <>
          {" "}
          <Tooltip label="Open the Foreman repository Trust matrix">
            <button
              type="button"
              className="backlog-task-notice-action"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onManageTrust();
              }}
            >
              Manage trust
            </button>
          </Tooltip>
        </>
      )}
    </span>
  );
}

/**
 * The one control that widens a board column, drawn on BOTH kinds of column head.
 *
 * The board has two of them - the tone columns BoardView builds and the Backlog column
 * that builds its own - and a widen affordance written twice is the mark vocabulary
 * problem this file exists to stop: the two would agree on the day they were written
 * and drift on the first retune. It lives here for the same reason `ScheduleSwitch`
 * does, and both heads render THIS.
 *
 * It is quiet until wanted: the header reveals it on hover, and it stays out while
 * narrow so five column heads do not each carry a permanent button nobody is looking
 * for. It is still focusable at all times though - `opacity`, never `display` - because
 * a control that leaves the tab order is one a keyboard cannot reach at all, and
 * double-click, the gesture this backs up, has no keyboard equivalent to fall back on.
 * A wide column keeps it visible regardless: the way back must never be the thing you
 * have to hunt for.
 */
export function ColumnWidthToggle({
  wide,
  label,
  onToggle,
}: {
  wide: boolean;
  /** The column's own name, so the tooltip and the label name what is moving. */
  label: string;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <Tooltip
      label={
        wide
          ? `Narrow ${label} (or double-click the header)`
          : `Widen ${label} to read more of each card (or double-click the header)`
      }
    >
      <button
        className="board-col-width"
        // A pressed toggle, not two buttons: the column is wide or it is not, and
        // `aria-pressed` is what says which without a second glyph to keep in sync.
        aria-pressed={wide}
        aria-label={wide ? `Narrow ${label}` : `Widen ${label}`}
        onClick={onToggle}
      >
        {wide ? "›‹" : "‹›"}
      </button>
    </Tooltip>
  );
}
