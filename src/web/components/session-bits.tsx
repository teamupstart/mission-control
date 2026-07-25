import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentType,
  PrState,
  Session,
  SessionCost,
  SessionMeta,
  Task,
  TaskPriority,
} from "@shared/types.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { GOAL_UNSUPPORTED } from "@shared/goal.ts";
import { costTone } from "@shared/cost.ts";
import { PRIORITY_LABELS } from "@shared/task.ts";
import { compactTokens, contextTone, fmtUsd, stateDisplay } from "../lib/format.ts";
import { formatScheduledFor } from "../lib/schedules.ts";
import { api } from "../lib/api.ts";
import { Tooltip } from "./Tooltip.tsx";
import { EffortPicker } from "./EffortPicker.tsx";
import type { WorkflowRunSummary } from "@shared/workflow.ts";
import type { TaskEnsembleLink } from "@shared/ensemble.ts";

/**
 * The small, presentational pieces a session is drawn from - the agent dot, the
 * goal line, the PR chip, the state badge, the title (with its rename editor), the
 * runtime pills - plus the task chips (priority, labels), which live here for the same
 * reason even though they hang off a Task rather than a Session: the board's backlog
 * column and the roundup panel both draw them, and two copies is how they drift.
 *
 * Every surface is a consumer here, the card included: the card, the console's detail
 * pane and the board's tile each arrange these SAME bits rather than importing one
 * another or keeping a private copy of the PR-icon SVG or the rename flow. That matters
 * because the card is rendered by ONE layout while the detail serves two, so a private
 * copy means a fix lands in two layouts and silently misses the third.
 *
 * `test/session-leaf-parity.test.ts` pins this: it renders each bit standalone and
 * asserts all three surfaces contain that exact output, so a re-inlined copy fails as
 * soon as it drifts.
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
  const namer = session.terminals.find((h) => h.backend === session.nameSource);
  if (namer?.kind === "multiplexer") return `${namer.backend} · ${namer.paneId}`;
  return session.nameSource;
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
  if ([
    "waiting_for_session",
    "waiting_for_pr",
    "waiting_for_inspector",
    "waiting_for_new_head",
  ].includes(run.status)) return "waiting";
  if (run.status === "blocked") return "blocked";
  if (run.status === "failed" || run.status === "cancelled") return "failed";
  return "running";
}

function workflowRunLabel(run: WorkflowRunSummary): string {
  const tone = workflowRunTone(run);
  if (tone === "passed") return "Approved";
  if (run.gate === "waiting_pr") return "Waiting for PR";
  if (run.gate === "waiting_inspector") return "Inspector gate";
  if (run.gate === "findings") return "Inspector findings";
  if (tone === "waiting") return "Review changes";
  if (tone === "blocked") return "Workflow blocked";
  if (tone === "failed") return run.status === "cancelled" ? "Preview cancelled" : "Preview failed";
  return `Preview · R${run.round}`;
}

export function WorkflowChip({
  run,
  onOpen,
}: {
  run: WorkflowRunSummary | null;
  onOpen?: () => void;
}): React.JSX.Element | null {
  if (!run) return null;
  return (
    <Tooltip label={`${run.workflowName} v${run.workflowVersion}: ${workflowRunLabel(run)}`}>
      <button
        className={`workflow-chip workflow-${workflowRunTone(run)}`}
        onClick={(event) => {
          event.stopPropagation();
          onOpen?.();
        }}
      >
        <span aria-hidden>⌁</span>
        {workflowRunLabel(run)}
      </button>
    </Tooltip>
  );
}

export function WorkflowTileFlag({
  run,
  onOpen,
}: {
  run: WorkflowRunSummary | null;
  onOpen?: () => void;
}): React.JSX.Element | null {
  if (!run) return null;
  return (
    <Tooltip label={`${run.workflowName} v${run.workflowVersion}: ${workflowRunLabel(run)}`}>
      <button
        className={`tile-flag tf-workflow workflow-${workflowRunTone(run)}`}
        onClick={(event) => {
          event.stopPropagation();
          onOpen?.();
        }}
      >
        ⌁ {workflowRunLabel(run)}
      </button>
    </Tooltip>
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
export type EnsembleMemberTone = "running" | "waiting" | "kept" | "out";

export function ensembleMemberTone(link: TaskEnsembleLink): EnsembleMemberTone {
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
 * A short human phrase for this member's current standing. Prefers the server-derived
 * `resultLabel` ("rank 1", "advanced", "retained") when it exists; components render that string
 * and never interpret strategy-specific JSON to derive one of their own.
 */
export function ensembleMemberStateLabel(link: TaskEnsembleLink): string {
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

function ensembleMemberTooltip(link: TaskEnsembleLink): string {
  return `${link.strategyLabel}: candidate ${link.ordinal} of ${link.launchedMembers} - ${ensembleMemberStateLabel(link)}`;
}

export function EnsembleChip({
  link,
  onOpen,
}: {
  link: TaskEnsembleLink | null;
  onOpen?: () => void;
}): React.JSX.Element | null {
  if (!link) return null;
  return (
    <Tooltip label={ensembleMemberTooltip(link)}>
      <button
        className={`ensemble-chip ensemble-${ensembleMemberTone(link)}`}
        aria-label={ensembleMemberTooltip(link)}
        onClick={(event) => {
          event.stopPropagation();
          onOpen?.();
        }}
      >
        <span aria-hidden>⧉</span>
        {link.strategyLabel} · {ensembleMemberStateLabel(link)}
      </button>
    </Tooltip>
  );
}

export function EnsembleTileFlag({
  link,
  onOpen,
}: {
  link: TaskEnsembleLink | null;
  onOpen?: () => void;
}): React.JSX.Element | null {
  if (!link) return null;
  return (
    <Tooltip label={ensembleMemberTooltip(link)}>
      <button
        className={`tile-flag tf-ensemble ensemble-${ensembleMemberTone(link)}`}
        aria-label={ensembleMemberTooltip(link)}
        onClick={(event) => {
          event.stopPropagation();
          onOpen?.();
        }}
      >
        <span aria-hidden>E</span> {link.ordinal} · {ensembleMemberStateLabel(link)}
      </button>
    </Tooltip>
  );
}

export function EnsembleRailMark({
  link,
  onOpen,
}: {
  link: TaskEnsembleLink | null;
  onOpen?: () => void;
}): React.JSX.Element | null {
  if (!link) return null;
  // A span, not a button: the whole rail row is already a button, and a button inside a button
  // is invalid. This matches `WorkflowRailMark`; the row stays the keyboard-focusable element and
  // the aria-label names what the click opens.
  return (
    <Tooltip label={ensembleMemberTooltip(link)}>
      <span
        className={`rail-ensemble ensemble-${ensembleMemberTone(link)}`}
        aria-label={ensembleMemberTooltip(link)}
        onClick={(event) => {
          event.stopPropagation();
          onOpen?.();
        }}
      >
        <span aria-hidden>E</span>
        {link.resultLabel && <span className="rail-ensemble-label">{link.resultLabel}</span>}
      </span>
    </Tooltip>
  );
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
 * Clicking any of them opens the Scheduled Catalog at this schedule's run history through
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
  return (
    <Tooltip
      label={
        session.goal.source === "heuristic"
          ? `${session.goal.text} (your prompt, verbatim - being summarised)`
          : session.goal.text
      }
    >
      <p className={`goal goal-${session.goal.source ?? "heuristic"}`}>{session.goal.text}</p>
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
      title: `Inspector: the last review of this pull request did not complete${suffix}`,
    };
  }
  if (inspector.round === 0) {
    // Glyph alone. "Adopted, not looked at yet" is the least urgent thing this chip can
    // say, and it should not cost a single character more than its own presence.
    return {
      mark: "",
      tone: "insp-queued",
      dry,
      title: `Inspector: adopted for review, not looked at yet${suffix}`,
    };
  }
  if (inspector.open === 0) {
    return {
      mark: "✓",
      tone: "insp-clean",
      dry,
      title: `Inspector: reviewed, nothing outstanding${suffix}`,
    };
  }
  return {
    mark: `${inspector.open}`,
    tone: "insp-findings",
    dry,
    title:
      `Inspector: ${inspector.open} open finding${inspector.open === 1 ? "" : "s"} ` +
      `after ${inspector.round} round${inspector.round === 1 ? "" : "s"}${suffix}`,
  };
}

/** The Inspector chip. Shared by all four session surfaces - see CLAUDE.md on parity. */
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

/** The PR chip, plus the "a CI check failed" alert beside it when checks are failing. */
export function PrChip({ session }: { session: Session }): React.JSX.Element | null {
  if (!session.prUrl) return null;
  return (
    <>
      <Tooltip
        label={
          session.prState === "merged"
            ? "Pull request merged - open on GitHub"
            : "Open pull request - open on GitHub"
        }
      >
        <a
          className={`pr-chip pr-${session.prState ?? "open"}`}
          href={session.prUrl}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
        >
          <PrStateIcon state={session.prState ?? "open"} />
          <span className="pr-num">{session.prNumber ? `#${session.prNumber}` : "PR"}</span>
        </a>
      </Tooltip>
      {session.prChecks === "failing" && (
        <Tooltip label="A CI check failed on this PR - open on GitHub">
          <a
            className="pr-checks-alert"
            href={session.prUrl}
            target="_blank"
            rel="noreferrer"
            aria-label="A CI check failed on this pull request - open on GitHub"
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
 * The board tile's own vocabulary for the PR - a `.tile-flag` link, folding the failing-
 * checks state into the same chip with a `⚠` suffix rather than `PrChip`'s separate alert
 * icon, since the tile has no room for a second element. Given the same instant `Tooltip`
 * as `InspectorTileFlag` rather than a native `title`, so two adjacent flags on the same
 * tile don't behave differently on hover. Renders nothing without a PR number, and a plain
 * unlinked flag (the tile's own long-standing escape hatch) when there's a number but no
 * URL yet - neither state has anything to hover for.
 */
export function PrTileFlag({ session }: { session: Session }): React.JSX.Element | null {
  if (!session.prNumber) return null;
  const tone = `pr-${session.prState ?? "open"}`;
  const label = (
    <>
      #{session.prNumber}
      {session.prChecks === "failing" && " ⚠"}
    </>
  );
  if (!session.prUrl) return <span className={`tile-flag ${tone}`}>{label}</span>;
  const title =
    session.prChecks === "failing"
      ? "A CI check failed on this pull request - open on GitHub"
      : `Pull request #${session.prNumber} - open on GitHub`;
  return (
    <Tooltip label={title}>
      <a
        className={`tile-flag tile-flag-link ${tone}`}
        href={session.prUrl}
        target="_blank"
        rel="noreferrer"
        // Without this the click also reaches the tile's own onClick and opens the
        // console behind the new tab. stopPropagation only: the link still has to navigate.
        onClick={(e) => e.stopPropagation()}
      >
        {label}
      </a>
    </Tooltip>
  );
}

/** The status badge; a button that opens the reviews modal when there are pending reviews. */
export function StateBadge({
  session,
  gateNeedsYou,
  onOpenReviews,
}: {
  session: Session;
  /** Cross-session verdict for a parked no-mistakes gate. */
  gateNeedsYou: boolean;
  onOpenReviews?: () => void;
}): React.JSX.Element {
  const st = stateDisplay(session, gateNeedsYou);
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
          {st.label} →
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
  if (renaming) return <RenameEditor session={session} onClose={() => onRenameClose?.()} />;
  if (canRename) {
    return (
      <h2>
        <Tooltip label={`Rename "${session.name}"`}>
          <button
            type="button"
            className="card-title-edit"
            onClick={(e) => {
              e.stopPropagation();
              onRenameStart?.();
            }}
          >
            <span className="card-title-name">{session.name || "(unnamed)"}</span>
            <span className="rename-pencil" aria-hidden>
              ✎
            </span>
          </button>
        </Tooltip>
      </h2>
    );
  }
  return (
    <Tooltip label={session.name || "This session has no name"}>
      <h2>{session.name || "(unnamed)"}</h2>
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
  const [value, setValue] = useState(session.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  // Disabling the input mid-flight drops focus to <body>; take it back so a rejected name
  // still hears Enter/Escape. Keyed on `busy` too: retrying the same bad name re-reports an
  // identical string, so `error` alone wouldn't re-fire.
  useEffect(() => {
    if (busy || !error) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [busy, error]);

  async function submit(): Promise<void> {
    const name = value.trim();
    if (!name || name === session.name) {
      onClose();
      return;
    }
    setBusy(true);
    const r = await api.rename(session.id, name);
    setBusy(false);
    if (r.ok) onClose();
    else setError(r.error ?? "rename failed");
  }

  return (
    <div className="rename-edit" onClick={(e) => e.stopPropagation()}>
      <div className="rename-row">
        <input
          ref={inputRef}
          className="rename-input"
          value={value}
          disabled={busy}
          maxLength={200}
          aria-label="Rename session"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          // Clicking away cancels, but a Cmd+Tab to the terminal must not: the browser fires
          // blur before the window loses focus, so guard on document.hasFocus().
          onBlur={() => {
            if (!busy && document.hasFocus()) onClose();
          }}
        />
        <Tooltip label={busy ? "Renaming…" : "Save the new name (Enter)"}>
          <button
            type="button"
            className="rename-btn rename-save"
            aria-label="Save name"
            disabled={busy}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void submit()}
          >
            ✓
          </button>
        </Tooltip>
        <Tooltip label={busy ? "Renaming…" : "Discard the rename (Escape)"}>
          <button
            type="button"
            className="rename-btn rename-cancel"
            aria-label="Cancel rename"
            disabled={busy}
            onMouseDown={(e) => e.preventDefault()}
            onClick={onClose}
          >
            ✕
          </button>
        </Tooltip>
      </div>
      {error && (
        <span className="rename-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

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
  showEffort = true,
}: {
  meta: SessionMeta;
  session?: Session;
  /** Board renders its interactive effort control as a sibling of this shared row. */
  showEffort?: boolean;
}): React.JSX.Element | null {
  const hasCtx = meta.contextPct != null;
  if (!meta.model && !meta.thinkingLevel && !hasCtx) return null;
  const tone = contextTone(meta.contextPct);
  const ctxTitle =
    meta.contextTokens != null && meta.contextWindow != null
      ? `${compactTokens(meta.contextTokens)} / ${compactTokens(meta.contextWindow)} tokens in context`
      : `${meta.contextPct}% of the context window used`;
  return (
    <span className="card-runtime">
      {meta.model && (
        <Tooltip label={meta.modelId ? `Model: ${meta.modelId}` : `Model: ${meta.model}`}>
          <span className="rt-pill rt-model">
            {meta.model}
            {meta.longContext && <span className="rt-1m">1M</span>}
          </span>
        </Tooltip>
      )}
      {showEffort && meta.thinkingLevel &&
        (session ? (
          <EffortPicker session={session} />
        ) : (
          <Tooltip label={`Reasoning effort: ${meta.thinkingLevel}`}>
            <span className={`rt-pill rt-think rt-think-${meta.thinkingLevel}`}>
              <span className="rt-think-glyph" aria-hidden>
                ✦
              </span>
              {meta.thinkingLevel}
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
  busy = false,
  onChange,
}: {
  enabled: boolean;
  /** Named in the accessible label, so a screen reader hears which card this is. */
  taskTitle: string;
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
        aria-label={`Foreman may schedule ${taskTitle}`}
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
