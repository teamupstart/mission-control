import type { ReactNode } from "react";
import type { WorkflowCompletionPolicy } from "@shared/workflow.ts";
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
 *
 * `stopped` is the fifth and the newest, and it is a genuinely different claim rather than a
 * shade of the other four: NOTHING HAPPENED HERE. A stage that was CANCELLED where it stood is
 * one way to arrive at it - `orphanBinding` marks a lost session's queued reviewer attempts
 * `cancelled`, and until this tone existed the chip for them read amber `Reviewers`, which says
 * "these are about to run" about attempts that are dead. A stage CARRIED FORWARD from an
 * earlier round is the other: it did not run here either, and the same amber lie was being told
 * about it. Grey, because absence is what actually happened in both - failed would blame the
 * reviewers for a session that disappeared underneath them, and passed would credit a carried
 * stage with an execution this round never gave it.
 */

export const PIPELINE_STATUS_TONES = ["running", "waiting", "passed", "failed", "stopped"] as const;
export type PipelineStatusTone = (typeof PIPELINE_STATUS_TONES)[number];

export interface PipelineStatus {
  tone: PipelineStatusTone;
  label: string;
  /** Why this status was skipped or otherwise needs more context. */
  tooltip?: string;
  /** Machine-readable reason for a deliberate skip; labels remain presentation only. */
  skipKind?: "carried_pass" | "unconfigured_check" | "unavailable_check" | "budget_check";
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

/** Which of the ladder's five rung treatments a status earns. */
export function rungState(status: PipelineStatus, pending = false): string {
  if (status.tone === "passed") return "is-passed";
  if (status.tone === "running") return "is-running";
  if (status.tone === "failed") return "is-failed";
  return pending ? "is-pending" : "is-waiting";
}

/**
 * One step of the VERTICAL ladder - the compact reading a session's detail pane draws.
 *
 * Here rather than inside `WorkflowLadder.tsx`, where it was, because a second reader
 * arrived: an external engine's pipeline is drawn as a ladder in the same pane, and it is the
 * same grammar - a titled row, a status on the right, and whatever the caller nests under it.
 * A lookalike built beside it would drift on the one thing that matters here, which is that
 * the two ladders read as ONE component to whoever is looking at the pane.
 *
 * The horizontal strip's leaves are the neighbours above and below for the same reason: this
 * module is where the run-drawing vocabulary lives, and both readers borrow from it rather
 * than from each other.
 */
export function Rung({
  name,
  sub = null,
  status,
  terminal = false,
  pending = false,
  fixed = false,
  carried = false,
  children = null,
}: {
  name: string;
  sub?: string | null;
  status: PipelineStatus;
  terminal?: boolean;
  pending?: boolean;
  /** Not run in this round because an earlier one already passed it. Recedes, never hides. */
  carried?: boolean;
  /**
   * This rung is the completion POLICY, not an authored stage: it sits after the End and
   * nothing about it can be edited from any surface. A word rather than only a class, for
   * the reason the pipeline footer's badge is one - the distinction has to survive a reader
   * who never sees the styling.
   */
  fixed?: boolean;
  children?: React.ReactNode;
}): React.JSX.Element {
  const state = (
    <span
      className={`wf-ladder-state${status.tooltip ? " wf-status-explained" : ""}`}
      tabIndex={status.tooltip ? 0 : undefined}
    >
      {status.label}
    </span>
  );
  return (
    <li
      className={[
        "wf-ladder-rung",
        `workflow-${status.tone}`,
        rungState(status, pending),
        terminal ? "is-terminal" : "",
        fixed ? "is-fixed" : "",
        carried ? "is-carried" : "",
      ].filter(Boolean).join(" ")}
    >
      <div className="wf-ladder-row">
        <span className="wf-ladder-title">
          <strong>{name}</strong>
          {fixed && <span className="wf-ladder-fixed">Fixed</span>}
          {sub && <span className="wf-ladder-sub">{sub}</span>}
        </span>
        {status.tooltip ? <Tooltip label={status.tooltip}>{state}</Tooltip> : state}
      </div>
      {children}
    </li>
  );
}

/**
 * One member inside a stage. `meta` is the `runner · model` line; `actions` is the trailing
 * control slot (Remove here, "open verdict" for the monitor).
 *
 * `kind` is what separates a reviewer from a deterministic check, and it is a CHIP rather than
 * a different row: the two are peers in a stage - same routes, same join, same reorder - and
 * drawing them as two shapes would say they behave differently. A check's `name` is its bare
 * slot, so the chip supplies the noun that "test" alone next to a Persona's name does not.
 *
 * `onOpen` is the runs monitor's primary row action. `disabled` and the older
 * `onToggleDisabled` slot remain available to callers that need a direct auto-pass toggle,
 * while the run pipeline now places that destructive control in `actions` so a Persona row
 * can open its feedback editor. Optional props keep the editor's shared leaf unchanged.
 */
export function ReviewerRow({
  name,
  kind = "persona",
  meta = null,
  status = null,
  state = "idle",
  actions = null,
  notice = null,
  panel = null,
  item = {},
  disabled = false,
  hasDirective = false,
  onOpen = null,
  openLabel = null,
  onToggleDisabled = null,
  toggleLabel = null,
}: {
  name: string;
  kind?: "persona" | "check" | "session_action";
  meta?: string | null;
  status?: PipelineStatus | null;
  state?: PipelineItemState;
  actions?: ReactNode;
  notice?: ReactNode;
  /**
   * An expanded editing surface for this row, drawn under it and OUTSIDE the row's own hit
   * target. Outside deliberately: the run monitor wraps a row's content in a button, and a
   * form nested inside one is both invalid markup and unreachable by keyboard.
   */
  panel?: ReactNode;
  item?: PipelineItemProps;
  disabled?: boolean;
  hasDirective?: boolean;
  onOpen?: (() => void) | null;
  openLabel?: string | null;
  onToggleDisabled?: (() => void) | null;
  toggleLabel?: string | null;
}): React.JSX.Element {
  const content = (
    <>
      <span className="wf-pipeline-reviewer-body">
        <span className="wf-pipeline-reviewer-name">
          {disabled && <span className="wf-pipeline-disabled-mark" aria-hidden>⊘</span>}
          {kind === "check" && <span className="wf-pipeline-check-mark">Command</span>}
          {/* The badge says what this row IS, because a session action sitting in a column
              of reviewers otherwise reads as one - and it does the opposite of reviewing. */}
          {kind === "session_action" && <span className="wf-pipeline-action-mark">Session action</span>}
          {name}
        </span>
        {meta && <span className="wf-pipeline-reviewer-meta">{meta}</span>}
        {notice}
      </span>
      {status && <PipelineStatusChip status={status} />}
    </>
  );
  return (
    <li
      className={`wf-pipeline-reviewer is-${kind}${stateClass(state)}${disabled ? " is-disabled" : ""}${hasDirective ? " has-directive" : ""}`}
      {...itemAttributes(item)}
    >
      {onOpen || onToggleDisabled ? (
        <Tooltip label={onOpen ? openLabel ?? "" : toggleLabel ?? ""}>
          <button
            type="button"
            className="wf-pipeline-toggle wf-pipeline-reviewer-hit"
            aria-pressed={onOpen ? undefined : disabled}
            onClick={onOpen ?? onToggleDisabled ?? undefined}
          >
            {content}
          </button>
        </Tooltip>
      ) : content}
      {actions && <span className="wf-pipeline-reviewer-actions">{actions}</span>}
      {panel}
    </li>
  );
}

/**
 * One stage: its derived name, what it is waiting on, and its members.
 *
 * `header` wires the stage's own roving stop and drag handle; `frame` takes drops for the
 * card as a whole, so a member can be moved onto a stage without aiming at a row.
 *
 * `onOpen` mirrors `ReviewerRow` for single-Persona stages. The optional direct disable
 * callback remains available to other callers, while the run pipeline puts its stage-grain
 * auto-pass control in the trailing actions menu.
 */
export function StageCard({
  name,
  subtitle = null,
  status = null,
  state = "idle",
  actions = null,
  header = {},
  frame = {},
  disabled = false,
  hasDirective = false,
  onOpen = null,
  openLabel = null,
  onToggleDisabled = null,
  toggleLabel = null,
  carried = false,
  footer = null,
  children,
}: {
  name: string;
  subtitle?: string | null;
  status?: PipelineStatus | null;
  state?: PipelineItemState;
  actions?: ReactNode;
  header?: PipelineItemProps;
  frame?: Pick<PipelineItemProps, "onDragOver" | "onDrop">;
  disabled?: boolean;
  hasDirective?: boolean;
  onOpen?: (() => void) | null;
  openLabel?: string | null;
  onToggleDisabled?: (() => void) | null;
  toggleLabel?: string | null;
  /**
   * This stage did not run in the round being read. It recedes rather than disappears: the
   * pipeline's shape is what makes the gap legible, so hiding it would cost the reader the
   * very structure that explains why the stages below it are the only ones working.
   */
  carried?: boolean;
  /** The provenance slot under the members - where a carried stage names the round it passed in. */
  footer?: ReactNode;
  children: ReactNode;
}): React.JSX.Element {
  const title = (
    <>
      <span className="wf-pipeline-stage-title">
        <span className="wf-pipeline-stage-name">
          {disabled && <span className="wf-pipeline-disabled-mark" aria-hidden>⊘</span>}
          {name}
        </span>
        {subtitle && <span className="wf-pipeline-stage-sub">{subtitle}</span>}
      </span>
      {status && <PipelineStatusChip status={status} />}
    </>
  );
  return (
    <section
      className={`wf-pipeline-stage${stateClass(state)}${disabled ? " is-disabled" : ""}${hasDirective ? " has-directive" : ""}${carried ? " is-carried" : ""}`}
      onDragOver={frame.onDragOver}
      onDrop={frame.onDrop}
    >
      <header className="wf-pipeline-stage-head" {...itemAttributes(header)}>
        {onOpen || onToggleDisabled ? (
          <Tooltip label={onOpen ? openLabel ?? "" : toggleLabel ?? ""}>
            <button
              type="button"
              className="wf-pipeline-toggle wf-pipeline-stage-hit"
              aria-pressed={onOpen ? undefined : disabled}
              onClick={onOpen ?? onToggleDisabled ?? undefined}
            >
              {title}
            </button>
          </Tooltip>
        ) : title}
        {actions && <span className="wf-pipeline-stage-actions">{actions}</span>}
      </header>
      {children}
      {footer}
    </section>
  );
}

/**
 * Where a carried stage's pass actually lives, and the way back to it.
 *
 * This exists because the alternative shipped first and was the whole defect: a stage that did
 * not run showed no outcome at all, so confirming it had passed meant leaving the round you
 * were reading, finding the earlier one in the scrubber, and reading it there. The round is
 * NAMED here so the answer needs no navigation, and it is a BUTTON so the proof behind the
 * answer needs one click rather than a hunt.
 *
 * The tick is the only green on a carried stage, and it belongs to this line rather than to the
 * status chip for a reason worth keeping: it is making a claim about a DIFFERENT round. The
 * chip speaks for the round on screen, where nothing ran.
 */
export function CarriedProvenance({
  roundLabel,
  onOpen = null,
}: {
  roundLabel: string;
  onOpen?: (() => void) | null;
}): React.JSX.Element {
  const body = (
    <>
      <span className="wf-carried-tick" aria-hidden>✓</span>
      <span className="wf-carried-text">Passed in {roundLabel}</span>
    </>
  );
  if (!onOpen) return <p className="wf-carried">{body}</p>;
  return (
    <Tooltip label={`Show ${roundLabel}, where this stage earned its pass`}>
      <button
        type="button"
        className="wf-carried is-link"
        onClick={onOpen}
        aria-label={`Passed in ${roundLabel}. Show that round.`}
      >
        {body}
        <span className="wf-carried-go" aria-hidden>→</span>
      </button>
    </Tooltip>
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
 * Inspector, drawn after End as a FIXED footer.
 *
 * A projection of `WorkflowCompletionPolicy` and never a stage. It carries no drag handle, no
 * focus stop in the strip's roving order, no member list, no edge and no delete, because
 * there is nothing in the persisted graph for any of those to act on: Inspector is a property
 * of the workflow, End is still the graph's success boundary, and the completion policy
 * claims that boundary afterwards.
 *
 * Rendering it here rather than at each surface is what stops the three places it appears -
 * the editor, a run, and the Board ladder - from drawing three different pictures of the same
 * immutable rule. Returning `null` for a `none` policy is the whole visibility contract: a
 * workflow that does not end at Inspector shows no footer at all, which is why every caller
 * can hand this the policy unconditionally.
 *
 * `status` and `detail` are the RUN's answers - the gate chip and the sentence saying what it
 * is waiting on. Absent in the editor, where there is no run to have an opinion.
 */
export function InspectorFooter({
  policy,
  status = null,
  detail = null,
}: {
  policy: WorkflowCompletionPolicy;
  status?: PipelineStatus | null;
  detail?: string | null;
}): React.JSX.Element | null {
  if (policy.kind !== "inspector") return null;
  return (
    <>
      {/* The seam says what has to have happened, and it is deliberately not a gate an
          author can change: End is reached, and only then does Inspector look at the work. */}
      <StageSeam gate="workflow succeeded" />
      <section
        className="wf-pipeline-inspector"
        aria-label="GitHub Inspector, the fixed completion policy after End"
      >
        <span className="wf-pipeline-inspector-mark" aria-hidden>✦</span>
        <span className="wf-pipeline-inspector-body">
          <span className="wf-pipeline-inspector-name">
            GitHub Inspector
            {/* A word, not a colour. The point of this badge is that the card is not part of
                the pipeline an author is editing, and that has to survive a greyscale
                screenshot and a reader who never sees the styling. */}
            <span className="wf-pipeline-inspector-fixed">Fixed</span>
          </span>
          {/* Two facts and no more. A strip card is read at a glance beside four others, and
              the first draft of this spent eight lines restating what the Fixed badge and
              the absent controls already say. What is left is what an operator cannot see
              from the card: what Inspector looks at, and where its switches actually live. */}
          <span className="wf-pipeline-inspector-sub">
            Reviews the finished pull request once the workflow succeeds. Set in Workflow
            settings, not on the graph.
          </span>
          {detail && <span className="wf-pipeline-inspector-detail">{detail}</span>}
        </span>
        {status && <PipelineStatusChip status={status} />}
      </section>
    </>
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
  stripRef,
  children,
}: {
  ariaLabel: string;
  repair?: ReactNode;
  /**
   * A semantic ref the owning surface may attach to the strip.
   *
   * Three surfaces draw this frame - the workflow builder's Pipeline view, one workflow run,
   * and an external engine's pipeline - and a guided tour spotlights two of them as different
   * stops. Which one a ref means is therefore the caller's to say. Absent everywhere else,
   * and the strip's element, class, role, and label are identical either way.
   */
  stripRef?: React.Ref<HTMLDivElement>;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="wf-pipeline">
      <div className="wf-pipeline-strip" role="group" aria-label={ariaLabel} ref={stripRef}>
        {children}
      </div>
      {repair && <p className="wf-pipeline-repair">{repair}</p>}
    </div>
  );
}
