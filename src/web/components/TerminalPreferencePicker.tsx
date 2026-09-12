import { useEffect, useRef, useState } from "react";
import type { EmulatorId } from "@shared/terminal.ts";
import {
  EMULATOR_IDS,
  MULTIPLEXER_IDS,
  resolveTerminalBackend,
  type TerminalBackendId,
  type TerminalTargetView,
} from "@shared/terminal.ts";
import { useTerminalTargets } from "../lib/terminalTargets.ts";
import { Tooltip } from "./Tooltip.tsx";

/** One group of rows in the open menu. */
export interface TerminalPreferenceGroup<Id extends TerminalBackendId = TerminalBackendId> {
  label: string;
  ids: readonly Id[];
}

/** Both axes - what the Harnesses card offers. */
export const DISPATCH_GROUPS: ReadonlyArray<TerminalPreferenceGroup> = [
  { label: "Multiplexers", ids: MULTIPLEXER_IDS },
  { label: "Terminal apps", ids: EMULATOR_IDS },
];

/** Terminal apps only - what a multiplexer's Setup row offers. */
export const EMULATOR_GROUPS: ReadonlyArray<TerminalPreferenceGroup<EmulatorId>> = [
  { label: "Terminal apps", ids: EMULATOR_IDS },
];

/**
 * Every sentence this control says, supplied by the caller.
 *
 * Spelled out rather than composed from one noun: the two callers differ by more than a
 * noun, so a template would produce a sentence for the wrong question.
 */
export interface TerminalPreferenceCopy {
  /** The closed trigger's hover sentence. */
  tooltip: string;
  /** The trigger's accessible name. The current value is appended after a colon. */
  triggerName: string;
  /** The open menu's accessible name. */
  menuName: string;
  /** The menu's heading. */
  heading: string;
  /** What Automatic does here. */
  automaticNote: string;
  /** Hover on one backend's row. */
  rowTooltip: (label: string) => string;
  /**
   * What choosing this backend produces, and why it cannot be chosen.
   *
   * A `TerminalTargetView` answers both twice - once for a dispatch, once for a window a
   * human is about to look at - and the pairs differ for a detached multiplexer, so a chooser
   * reading the wrong one greys out a row for a reason that does not apply to it.
   */
  rowNote: (target: TerminalTargetView) => string;
  rowUnavailable: (target: TerminalTargetView) => string | null;
}

/** The Harnesses card's wording: which terminal a dispatched session of one agent launches in. */
export function dispatchTerminalCopy(agentLabel: string): TerminalPreferenceCopy {
  return {
    tooltip: `Which terminal every dispatched ${agentLabel} session launches in`,
    triggerName: `Terminal preference for ${agentLabel}`,
    menuName: `Choose a terminal for dispatched ${agentLabel} sessions`,
    heading: `Terminal for ${agentLabel}`,
    automaticNote: "Prefer an available multiplexer, then fall back to a terminal app.",
    rowTooltip: (label) => `Use ${label} for dispatched terminal sessions`,
    rowNote: (target) => target.dispatchBlurb ?? target.blurb,
    // `dispatchUnavailable` is a real answer when present and `null` is one of its values, so
    // the key's PRESENCE decides rather than its truthiness: a detached tmux refuses the
    // ordinary open-terminal menu and is perfectly fine for a background dispatch.
    rowUnavailable: (target) =>
      Object.hasOwn(target, "dispatchUnavailable")
        ? (target.dispatchUnavailable ?? null)
        : target.unavailable,
  };
}

/**
 * A Setup row's wording.
 *
 * "Terminal APP" throughout because the Setup panel already labels the installer's
 * visible-terminal select `Terminal for <row label>` and a row can render both at once: a
 * name reading `Terminal for tmux sessions` would contain that one as a substring, and every
 * by-label lookup would find two controls.
 */
export function multiplexerTerminalCopy(muxLabel: string): TerminalPreferenceCopy {
  return {
    tooltip: `Which terminal app opens a window when you focus a ${muxLabel} session`,
    triggerName: `Terminal app for ${muxLabel} sessions`,
    menuName: `Choose a terminal app for ${muxLabel} sessions`,
    heading: `Terminal app for ${muxLabel} sessions`,
    automaticNote: "Use the first available terminal app.",
    rowTooltip: (label) => `Open ${muxLabel} sessions in ${label}`,
    rowNote: (target) => `Focus opens a new ${target.label} window.`,
    rowUnavailable: (target) => target.unavailable,
  };
}

function PreferenceRow({
  target,
  selected,
  copy,
  onChoose,
}: {
  target: TerminalTargetView;
  selected: boolean;
  copy: TerminalPreferenceCopy;
  onChoose: () => void;
}): React.JSX.Element {
  const unavailable = copy.rowUnavailable(target);
  const blurb = copy.rowNote(target);
  const tooltip = copy.rowTooltip(target.label);
  return (
    <Tooltip label={unavailable ?? tooltip}>
      <button
        type="button"
        role="menuitemradio"
        aria-checked={selected}
        className="launch-row terminal-pref-row"
        disabled={Boolean(unavailable)}
        onClick={onChoose}
      >
        <span className="launch-glyph" aria-hidden>{target.glyph}</span>
        <span className="launch-text">
          <span className="launch-label">{target.label}</span>
          <span className="launch-note">{unavailable ?? blurb}</span>
        </span>
        {selected && <span className="terminal-pref-check" aria-hidden>✓</span>}
      </button>
    </Tooltip>
  );
}

/**
 * The detailed terminal chooser, used by one Harnesses card and by one multiplexer's Setup row.
 *
 * Backend identity and availability come from the daemon's terminal registry. This component
 * owns only the settings interaction: Automatic, grouping, selection, and keyboard behavior.
 * It deliberately uses the launch menu's row vocabulary so every terminal chooser in the app
 * looks and moves like the same product.
 *
 * `resolve` travels with `groups` rather than being derived from it: a chooser offering
 * terminal apps only must also READ a stored multiplexer id as unrecognized, or a value from
 * the other preference would render as a selection this menu cannot show.
 */
export function TerminalPreferencePicker<Id extends TerminalBackendId = TerminalBackendId>({
  id,
  copy,
  groups = DISPATCH_GROUPS as ReadonlyArray<TerminalPreferenceGroup<Id>>,
  resolve = resolveTerminalBackend as (value: string | null | undefined) => {
    backend: Id | null;
    unknown: string | null;
  },
  value,
  disabled,
  onChange,
}: {
  id: string;
  copy: TerminalPreferenceCopy;
  groups?: ReadonlyArray<TerminalPreferenceGroup<Id>>;
  resolve?: (value: string | null | undefined) => { backend: Id | null; unknown: string | null };
  value: string | null;
  disabled: boolean;
  onChange: (backend: Id | null) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const { targets, failed } = useTerminalTargets();
  const resolved = resolve(value);
  const selectedTarget = targets?.find((target) => target.id === resolved.backend) ?? null;
  const selectedLabel = resolved.backend ? (selectedTarget?.label ?? resolved.backend) : "Automatic";

  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

  useEffect(() => {
    if (!open) return;
    function seize(event: KeyboardEvent): void {
      event.stopImmediatePropagation();
      event.preventDefault();
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        seize(event);
        setOpen(false);
        root.current?.querySelector<HTMLButtonElement>(".terminal-pref-trigger")?.focus();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const rows = [
        ...(root.current?.querySelectorAll<HTMLButtonElement>(".terminal-pref-row") ?? []),
      ].filter((row) => !row.disabled);
      if (rows.length === 0) return;
      seize(event);
      const at = rows.indexOf(document.activeElement as HTMLButtonElement);
      const step = event.key === "ArrowDown" ? 1 : -1;
      rows[(at + step + rows.length) % rows.length]?.focus();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDown(event: PointerEvent): void {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    root.current
      ?.querySelector<HTMLButtonElement>(".terminal-pref-row:not(:disabled)")
      ?.focus();
  }, [open, targets]);

  function choose(backend: Id | null): void {
    setOpen(false);
    onChange(backend);
    root.current?.querySelector<HTMLButtonElement>(".terminal-pref-trigger")?.focus();
  }

  return (
    <span className="terminal-pref" ref={root}>
      <Tooltip label={copy.tooltip}>
        <button
          id={id}
          type="button"
          className="harnesses-select terminal-pref-trigger"
          aria-label={`${copy.triggerName}: ${selectedLabel}`}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen((shown) => !shown)}
        >
          <span className="terminal-pref-value">{selectedLabel}</span>
          <span className="terminal-pref-caret" aria-hidden>▾</span>
        </button>
      </Tooltip>
      {open && (
        <div
          className="launch-pop terminal-pref-pop"
          role="menu"
          aria-label={copy.menuName}
        >
          <span className="launch-head terminal-pref-head">{copy.heading}</span>
          <Tooltip label="Let Mission Control choose the best available terminal for each dispatch">
            <button
              type="button"
              role="menuitemradio"
              aria-checked={resolved.backend === null}
              className="launch-row terminal-pref-row"
              onClick={() => choose(null)}
            >
              <span className="launch-glyph terminal-pref-auto-glyph" aria-hidden>◇</span>
              <span className="launch-text">
                <span className="launch-label">Automatic</span>
                <span className="launch-note">{copy.automaticNote}</span>
              </span>
              {resolved.backend === null && (
                <span className="terminal-pref-check" aria-hidden>✓</span>
              )}
            </button>
          </Tooltip>

          {failed && (
            <p className="launch-note is-error">Could not ask the daemon what is available.</p>
          )}
          {!failed && !targets && <p className="launch-note">Checking…</p>}
          {!failed && targets?.length === 0 && (
            <p className="launch-note">This build has no registered terminal backend.</p>
          )}
          {targets && (
            <div className="terminal-pref-groups">
              {groups.map((group) => {
                const rows = group.ids
                  .map((backend) => targets.find((target) => target.id === backend))
                  .filter((target): target is TerminalTargetView => Boolean(target));
                if (rows.length === 0) return null;
                return (
                  <div
                    className="terminal-pref-group"
                    role="group"
                    aria-label={group.label}
                    key={group.label}
                  >
                    <span className="launch-head">{group.label}</span>
                    {rows.map((target) => (
                      <PreferenceRow
                        key={target.id}
                        target={target}
                        copy={copy}
                        selected={resolved.backend === target.id}
                        onChoose={() => choose(target.id as Id)}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          )}
          {resolved.unknown && (
            <p className="launch-note is-error">
              The stored backend “{resolved.unknown}” is not available in this build. Automatic
              selection will be used until you choose another terminal.
            </p>
          )}
        </div>
      )}
    </span>
  );
}
