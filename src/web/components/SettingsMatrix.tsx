import { LLM_RUNNER_IDS } from "@shared/llm.ts";
import type { LlmRunnerId, ResolvedLlmRunner } from "@shared/llm.ts";
import type { ModelChoiceSpec, ResolvedModel } from "@shared/model-choice.ts";
import { modelChoicesFor } from "@shared/model.ts";
import type { LlmProviderView } from "@shared/types.ts";
import { ModelField } from "./ModelField.tsx";
import { Tooltip } from "./Tooltip.tsx";

// The settings TABLE: a set of slots down the side, the choices that make one up across the
// top, and the value each slot resolved to in the cells.
//
// Why a table and not more stacked field cards. Settings grew one control per question, and
// that shape answers "what is this knob" well and "which of these five is different from the
// others" not at all - which is the only question anyone brings to a page of slots. Five
// jobs times two choices as ten cards is a scroll; as a grid it is one glance, and an
// inherited row is visibly quieter than a pinned one without reading a word.
//
// Presentational, and deliberately knows nothing about jobs, Foreman roles or task kinds. It
// takes column definitions and rows; the caller says what a cell contains. That is what lets
// the later phases add a Foreman group and a task-kind grid by declaring more columns rather
// than forking a second table that drifts on the first fix.
//
// NO `data-testid` anywhere in here, per the house rule: every control a row puts in a cell
// carries its own accessible name, and that is what a spec selects on.

/** One choice a slot makes, rendered as a column. */
export interface SettingsMatrixColumn {
  /** Stable key, matched against the keys in a row's `cells`. */
  key: string;
  /** The column heading, as read. */
  label: string;
}

/** One slot, rendered as a row. */
export interface SettingsMatrixRow {
  key: string;
  /** The row heading - the name of the thing being configured. */
  label: string;
  /** One line under the heading saying what this slot actually does. */
  blurb?: string;
  /** This row's settings anchor, `<category>/<slug>`, or null when search cannot reach it. */
  anchor?: string | null;
  /**
   * A row that is showing an INHERITED value rather than one of its own - drawn muted and
   * with its controls disabled.
   *
   * Phases 2 and 3 render the app-wide defaults as this kind of first row, so a grid of
   * overrides always says what it is overriding. A row with no override of its own is not
   * this: it is an ordinary editable row whose controls happen to read "Inherit".
   */
  inherited?: boolean;
  /** Cell content per column key. A missing key renders an empty cell. */
  cells: Record<string, React.ReactNode>;
  /** A full-width line under the row - what was reset, or what could not be honoured. */
  note?: React.ReactNode;
}

/**
 * A labelled grid of settings slots.
 *
 * Wide content scrolls inside the wrapper rather than widening the page: a settings page
 * that scrolls sideways hides the rail and the search box, and Phase 3's grid is four
 * columns wide.
 */
export function SettingsMatrix({
  caption,
  columns,
  rows,
}: {
  /** What this grid is a grid OF. Rendered as the table's accessible name. */
  caption: string;
  columns: SettingsMatrixColumn[];
  rows: SettingsMatrixRow[];
}): React.JSX.Element {
  return (
    <div className="settings-matrix-scroll">
      <table className="settings-matrix">
        <caption className="settings-matrix-caption">{caption}</caption>
        <thead>
          <tr>
            {/* Empty rather than captioned: the row headings below name themselves, and a
                word here ("Job", "Role") would be a third vocabulary for the same thing. */}
            <th scope="col" className="settings-matrix-corner" />
            {columns.map((column) => (
              <th scope="col" key={column.key}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <SettingsMatrixRowCells key={row.key} row={row} columns={columns} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SettingsMatrixRowCells({
  row,
  columns,
}: {
  row: SettingsMatrixRow;
  columns: SettingsMatrixColumn[];
}): React.JSX.Element {
  const className = [
    "settings-matrix-row",
    row.inherited ? "is-inherited" : "",
    // The note is drawn as a second `<tr>` but has to READ as part of this row's card, so the
    // card's bottom edge moves down onto it rather than closing above it.
    row.note ? "has-note" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <>
      <tr className={className} data-anchor={row.anchor ?? undefined}>
        <th scope="row" className="settings-matrix-slot">
          <span className="settings-matrix-slot-label">{row.label}</span>
          {row.blurb && <span className="settings-matrix-slot-blurb">{row.blurb}</span>}
        </th>
        {columns.map((column) => (
          <td key={column.key}>{row.cells[column.key] ?? null}</td>
        ))}
      </tr>
      {row.note && (
        <tr className={row.inherited ? "settings-matrix-note-row is-inherited" : "settings-matrix-note-row"}>
          {/* Spans the whole row: what was dropped is a fact about the PAIR, not about the
              provider cell or the model cell, and putting it under one of them would read as
              a complaint about that control alone. */}
          <td colSpan={columns.length + 1} className="settings-matrix-note">
            {row.note}
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * The provider half of a slot: inherit, or one of the providers this build has.
 *
 * A `<select>` rather than the app-wide radio group, because a radio group per row would be
 * ten controls where the page already has one set, and because "Inherit" is a real option
 * here in a way it is not at the top - the app-wide picker cannot inherit from anything.
 */
export function ProviderSelect({
  id,
  name,
  tooltip,
  value,
  inherited,
  providers,
  disabled,
  onCommit,
}: {
  id: string;
  /**
   * What this control is FOR, spoken. Becomes the accessible name, because the row heading
   * beside it is a `<th>` a screen reader announces separately and a specification cannot
   * select on - "Goal provider" is one name for one control.
   */
  name: string;
  /** The hover description. Owned here, so the control cannot ship without one. */
  tooltip: string;
  /** The stored override, or "" for inherit. */
  value: string;
  /**
   * What choosing Inherit would actually give this slot - the app-wide resolution, NOT what
   * this row resolves to right now.
   *
   * The distinction only shows up on a row that has an override, and there it is the whole
   * question: a row pinned to Codex under an app-wide Claude was labelling its own Inherit
   * option "Inherit - Codex", which is the one thing selecting it will not do.
   */
  inherited: ResolvedLlmRunner | undefined;
  providers: LlmProviderView[];
  disabled: boolean;
  /**
   * The narrowed choice, never the raw event value: every option this renders is either a
   * provider this build has or the empty inherit row, so a caller should not have to
   * re-validate a string to write a strictly-typed patch.
   */
  onCommit: (next: LlmRunnerId | "") => void;
}): React.JSX.Element {
  const inheritedLabel =
    providers.find((provider) => provider.id === inherited?.id)?.label ?? inherited?.id ?? "app-wide";
  return (
    <Tooltip label={tooltip}>
      <select
        id={id}
        aria-label={name}
        className="field-input settings-matrix-provider"
        value={value}
        disabled={disabled}
        onChange={(event) => onCommit(knownRunner(event.target.value) ?? "")}
      >
        {/* Named with what it resolves to, the same honesty `ModelField`'s "Default - x" row
            keeps: an option reading only "Inherit" makes an operator open the app-wide picker
            to find out what this row is actually running on. */}
        <option value="">Inherit - {inheritedLabel}</option>
        {providers.map((provider) => (
          <option key={provider.id} value={provider.id}>
            {provider.label}
          </option>
        ))}
      </select>
    </Tooltip>
  );
}

/**
 * Whether a provider change would strand the model pinned beside it.
 *
 * The second half of the pinning rule, and the reason it exists: a slot's own Provider
 * select is a statement about exactly that slot, so its model has to follow. Without this,
 * one click stores a Claude id under a Codex runner and hands the job a pair no runner can
 * honour.
 *
 * Only a PINNED model is at stake. An empty box is already inheriting and re-resolves to the
 * new provider's own default with nothing to reset. And a model the new provider also offers
 * is KEPT - the two providers genuinely share an id far less often than an operator changes
 * their mind, but when they do, silently clearing it would be the surprising answer.
 */
export function modelSurvivesProviderChange(model: string, provider: LlmRunnerId): boolean {
  const pinned = model.trim();
  if (!pinned) return true;
  return modelChoicesFor(provider).some((choice) => choice.id === pinned);
}

/**
 * One slot's row: a provider picker, the model picker beside it, and what the pair resolved.
 *
 * Returned as a row DEFINITION rather than as markup, so the table owns its own cells and a
 * later phase can add a third column - effort, or a task kind's harness - without this
 * having to know a table exists.
 */
export function modelSlotRow({
  key,
  anchor,
  spec,
  providers,
  runnerValue,
  runnerResolved,
  inheritedRunner,
  modelValue,
  modelResolved,
  disabled,
  reset,
  onCommit,
}: {
  key: string;
  anchor: string | null;
  spec: ModelChoiceSpec;
  providers: LlmProviderView[];
  /** The stored provider override, or "" for inherit. */
  runnerValue: string;
  /**
   * What this row resolves to TODAY - its own override when it has a readable one, otherwise
   * the app-wide answer. Read for the catalog and for `unknown`, never for the Inherit case.
   */
  runnerResolved: ResolvedLlmRunner | undefined;
  /**
   * What this row would resolve to if it chose Inherit - the app-wide answer, always.
   *
   * Separate from `runnerResolved` because on an overridden row the two DIFFER, and every
   * question about the Inherit option is a question about this one: what the option is
   * labelled, and which provider a model has to survive when the operator picks it.
   */
  inheritedRunner: ResolvedLlmRunner | undefined;
  /** The stored model override, or "" for the ladder. */
  modelValue: string;
  modelResolved: (ResolvedModel & { unsupported?: string | null }) | undefined;
  disabled: boolean;
  /** What this row reset, and why - shown until the operator's next edit to it. */
  reset: string | null;
  /** Both halves of one write. A provider change may carry its model back to Inherit. */
  onCommit: (patch: { runner?: LlmRunnerId | ""; model?: string }) => void;
}): SettingsMatrixRow {
  const runnerForCatalog: LlmRunnerId = knownRunner(runnerValue) ?? runnerResolved?.id ?? "claude";
  const dropped = modelResolved?.unsupported ?? null;
  const unreadableProvider = runnerResolved?.unknown ?? null;
  return {
    key,
    label: spec.label,
    blurb: spec.blurb,
    anchor,
    cells: {
      provider: (
        <ProviderSelect
          id={`${key}-provider`}
          name={`${spec.label} provider`}
          tooltip={`Which provider runs ${spec.label.toLowerCase()}. Inherit follows the app-wide picker.`}
          value={runnerValue}
          inherited={inheritedRunner}
          providers={providers}
          disabled={disabled}
          onCommit={(next) => {
            // The provider this row will run on AFTER the change - which for an empty pick is
            // the app-wide one, not the override being abandoned. Reading the row's current
            // resolution here let a row drop from Codex back to Inherit under an app-wide
            // Claude while keeping its Codex model: the stored pair was then mismatched, and
            // only the resolution guard downstream stopped it reaching a runner. The panel
            // must not write a pair it already knows is wrong.
            const provider = next || inheritedRunner?.id || "claude";
            // Pinning a model pins its provider, and a slot's own provider control is a
            // statement about that slot - so the model follows rather than being stranded.
            // Reset, not refuse: "run this job on Codex instead" is the common case, and the
            // dispatch form already resets its model when the agent under it changes.
            onCommit(
              modelSurvivesProviderChange(modelValue, provider)
                ? { runner: next }
                : { runner: next, model: "" },
            );
          }}
        />
      ),
      model: (
        <ModelField
          id={`${key}-model`}
          anchor={null}
          spec={spec}
          value={modelValue}
          resolved={modelResolved}
          runner={runnerForCatalog}
          disabled={disabled}
          label="none"
          blurb="hover"
          onCommit={(next) => onCommit({ model: next })}
        />
      ),
    },
    note: reset || dropped || unreadableProvider
      ? (
        <>
          {reset && <span className="settings-matrix-reset">{reset}</span>}
          {/* An override this build cannot resolve, said out loud. Replaced silently, the
              inherited provider reads as this row's own choice - the same failure the
              app-wide picker's `unknown` line exists to prevent, and the reason a per-job
              override reports it too rather than only the setting above it. */}
          {unreadableProvider && (
            <span className="settings-matrix-reset">
              {`"${unreadableProvider}" is not a provider this build has, so this row is inheriting instead.`}
            </span>
          )}
          {dropped && (
            <span className="settings-matrix-reset">
              {`"${dropped}" is not a model this provider offers, so this job is running on its default instead.`}
            </span>
          )}
        </>
      )
      : undefined,
  };
}

/** A stored provider string this build can actually resolve, or null. */
function knownRunner(value: string): LlmRunnerId | null {
  const asked = value.trim();
  return (LLM_RUNNER_IDS as readonly string[]).includes(asked) ? (asked as LlmRunnerId) : null;
}
