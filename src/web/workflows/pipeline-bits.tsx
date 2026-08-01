import type { ReactNode } from "react";
import { Tooltip } from "../components/Tooltip.tsx";

/**
 * The presentational leaves every stage surface is drawn from - the role `session-bits.tsx`
 * plays for session cards.
 *
 * They exist as a shared module rather than inside `PipelineEditor.tsx` because the runs
 * monitor draws the SAME pipeline the author drew, and a second stage-rendering dialect is
 * exactly the defect this migration removes. So each leaf takes data and nothing else: no
 * fetch, no draft, no run detail. `ReviewerRow`'s `status` slot is here from the start for
 * that reason - the editor never passes one, and the monitor should not have to fork the
 * leaf to get a chip onto it.
 *
 * Status tones are the vocabulary `workflow-chip` already carries across the fleet layouts
 * (`.workflow-running` / `-waiting` / `-passed` / `-failed`), so a chip drawn here and a chip
 * drawn on a session card cannot drift into two colour languages.
 */

export const PIPELINE_STATUS_TONES = ["running", "waiting", "passed", "failed"] as const;
export type PipelineStatusTone = (typeof PIPELINE_STATUS_TONES)[number];

export interface PipelineStatus {
  tone: PipelineStatusTone;
  label: string;
  /** Why this status was skipped or otherwise needs more context. */
  tooltip?: string;
  /** Machine-readable reason for a deliberate skip; labels remain presentation only. */
  skipKind?: "inspector_repair" | "unconfigured_check" | "unavailable_check";
  /**
   * This advanced the pipeline without being earned - a check that was skipped or could not
   * run, rather than one that ran and succeeded.
   *
   * A flag rather than a fifth tone because the colour vocabulary is shared with the fleet's
   * `workflow-chip`, and because the thing a reader needs is the SENTENCE. It exists so the
   * stage fold can say "Passed, 2 not run" without pattern-matching on label text.
   */
  degraded?: boolean;
}

/** Visual state of one card or row. Drag feedback and nothing semantic. */
export type PipelineItemState = "idle" | "dragging" | "drop-target";

/**
 * Focus and drag wiring an OWNER supplies. The leaves hold no focus or drag state of their
 * own: roving focus is a property of the whole strip, so only the strip can know which stop
 * is current.
 */
export interface PipelineItemProps {
  tabIndex?: number;
  ariaLabel?: string;
  draggable?: boolean;
  focusKey?: string;
  onFocus?: () => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLElement>) => void;
  onDragStart?: (event: React.DragEvent<HTMLElement>) => void;
  onDragEnd?: (event: React.DragEvent<HTMLElement>) => void;
  onDragOver?: (event: React.DragEvent<HTMLElement>) => void;
  onDrop?: (event: React.DragEvent<HTMLElement>) => void;
}

function stateClass(state: PipelineItemState): string {
  return state === "idle" ? "" : ` is-${state}`;
}

/** Spread onto the element that owns the roving tab stop. */
function itemAttributes(item: PipelineItemProps): Record<string, unknown> {
  return {
    tabIndex: item.tabIndex,
    "aria-label": item.ariaLabel,
    "data-focus-key": item.focusKey,
    draggable: item.draggable,
    onFocus: item.onFocus,
    onKeyDown: item.onKeyDown,
    onDragStart: item.onDragStart,
    onDragEnd: item.onDragEnd,
    onDragOver: item.onDragOver,
    onDrop: item.onDrop,
  };
}

export function PipelineStatusChip({ status }: { status: PipelineStatus }): React.JSX.Element {
  const chip = (
    <span
      className={`workflow-chip wf-pipeline-status workflow-${status.tone}${
        status.tooltip ? " wf-status-explained" : ""
      }`}
      tabIndex={status.tooltip ? 0 : undefined}
    >
      {status.label}
    </span>
  );
  return status.tooltip ? <Tooltip label={status.tooltip}>{chip}</Tooltip> : chip;
}

/**
 * One member inside a stage. `meta` is the `runner · model` line; `actions` is the trailing
 * control slot (Remove here, "open verdict" for the monitor).
 *
 * `kind` is what separates a reviewer from a deterministic check, and it is a CHIP rather than
 * a different row: the two are peers in a stage - same routes, same join, same reorder - and
 * drawing them as two shapes would say they behave differently. A check's `name` is its bare
 * slot, so the chip supplies the noun that "test" alone next to a Persona's name does not.
 */
export function ReviewerRow({
  name,
  kind = "persona",
  meta = null,
  status = null,
  state = "idle",
  actions = null,
  item = {},
}: {
  name: string;
  kind?: "persona" | "check";
  meta?: string | null;
  status?: PipelineStatus | null;
  state?: PipelineItemState;
  actions?: ReactNode;
  item?: PipelineItemProps;
}): React.JSX.Element {
  return (
    <li className={`wf-pipeline-reviewer is-${kind}${stateClass(state)}`} {...itemAttributes(item)}>
      <span className="wf-pipeline-reviewer-body">
        <span className="wf-pipeline-reviewer-name">
          {kind === "check" && <span className="wf-pipeline-check-mark">Check</span>}
          {name}
        </span>
        {meta && <span className="wf-pipeline-reviewer-meta">{meta}</span>}
      </span>
      {status && <PipelineStatusChip status={status} />}
      {actions && <span className="wf-pipeline-reviewer-actions">{actions}</span>}
    </li>
  );
}

/**
 * One stage: its derived name, what it is waiting on, and its members.
 *
 * `header` wires the stage's own roving stop and drag handle; `frame` takes drops for the
 * card as a whole, so a member can be moved onto a stage without aiming at a row.
 */
export function StageCard({
  name,
  subtitle = null,
  status = null,
  state = "idle",
  actions = null,
  header = {},
  frame = {},
  children,
}: {
  name: string;
  subtitle?: string | null;
  status?: PipelineStatus | null;
  state?: PipelineItemState;
  actions?: ReactNode;
  header?: PipelineItemProps;
  frame?: Pick<PipelineItemProps, "onDragOver" | "onDrop">;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <section
      className={`wf-pipeline-stage${stateClass(state)}`}
      onDragOver={frame.onDragOver}
      onDrop={frame.onDrop}
    >
      <header className="wf-pipeline-stage-head" {...itemAttributes(header)}>
        <span className="wf-pipeline-stage-title">
          <span className="wf-pipeline-stage-name">{name}</span>
          {subtitle && <span className="wf-pipeline-stage-sub">{subtitle}</span>}
        </span>
        {status && <PipelineStatusChip status={status} />}
        {actions && <span className="wf-pipeline-stage-actions">{actions}</span>}
      </header>
      {children}
    </section>
  );
}

/**
 * The join between two cards. `gate` is the mark an operator reads as the rule ("all pass"),
 * and `children` is whatever the surface wants to hang there - the editor puts its
 * insert-a-stage affordance in it; the monitor puts nothing.
 */
export function StageSeam({
  gate = null,
  children = null,
}: {
  gate?: string | null;
  children?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="wf-pipeline-seam">
      {/* The slot is always present, empty or not: a seam that skipped it would sit its
          connector a mark's height higher than its neighbours, and the chain would read
          as a broken line. */}
      <span className="wf-pipeline-gate-slot">
        {gate && <span className="wf-pipeline-gate">{gate}</span>}
      </span>
      <span className="wf-pipeline-seam-line" aria-hidden>→</span>
      {children}
    </div>
  );
}

/** Session and End, the two fixed ends of every pipeline. */
export function TerminusCard({
  kind,
  name,
  subtitle = null,
  status = null,
  item = {},
}: {
  kind: "session" | "end";
  name: string;
  subtitle?: string | null;
  status?: PipelineStatus | null;
  item?: PipelineItemProps;
}): React.JSX.Element {
  return (
    <section className={`wf-pipeline-terminus is-${kind}`} {...itemAttributes(item)}>
      <span className="wf-pipeline-terminus-mark" aria-hidden>{kind === "session" ? "◇" : "◆"}</span>
      <span className="wf-pipeline-terminus-body">
        <span className="wf-pipeline-terminus-name">{name}</span>
        {subtitle && <span className="wf-pipeline-terminus-sub">{subtitle}</span>}
      </span>
      {status && <PipelineStatusChip status={status} />}
    </section>
  );
}

/**
 * The strip itself: a horizontal scroller for the chain, with the repair rail underneath.
 *
 * The repair rail is a sentence rather than a drawn edge on purpose - every fail in a
 * pipeline returns to Session, so drawing N identical return edges was what made the canvas
 * unreadable at two members.
 */
export function PipelineFrame({
  ariaLabel,
  repair = null,
  children,
}: {
  ariaLabel: string;
  repair?: ReactNode;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="wf-pipeline">
      <div className="wf-pipeline-strip" role="group" aria-label={ariaLabel}>
        {children}
      </div>
      {repair && <p className="wf-pipeline-repair">{repair}</p>}
    </div>
  );
}
