import { useEffect, useRef, useState } from "react";
import {
  EMULATOR_IDS,
  MULTIPLEXER_IDS,
  resolveTerminalBackend,
  type TerminalBackendId,
  type TerminalTargetView,
} from "@shared/terminal.ts";
import { useTerminalTargets } from "../lib/terminalTargets.ts";
import { Tooltip } from "./Tooltip.tsx";

const GROUPS: ReadonlyArray<{
  label: string;
  ids: readonly TerminalBackendId[];
}> = [
  { label: "Multiplexers", ids: MULTIPLEXER_IDS },
  { label: "Terminal apps", ids: EMULATOR_IDS },
];

function PreferenceRow({
  target,
  selected,
  onChoose,
}: {
  target: TerminalTargetView;
  selected: boolean;
  onChoose: () => void;
}): React.JSX.Element {
  const unavailable = Object.hasOwn(target, "dispatchUnavailable")
    ? (target.dispatchUnavailable ?? null)
    : target.unavailable;
  const blurb = target.dispatchBlurb ?? target.blurb;
  return (
    <Tooltip label={unavailable ?? `Use ${target.label} for dispatched terminal sessions`}>
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
 * The detailed terminal chooser used by one Harnesses card.
 *
 * Backend identity and availability come from the daemon's terminal registry. This component
 * owns only the settings interaction: Automatic, grouping by axis, selection, and keyboard
 * behavior. It deliberately uses the launch menu's row vocabulary so the two terminal
 * choosers look and move like the same product.
 */
export function TerminalPreferencePicker({
  id,
  agentLabel,
  value,
  disabled,
  onChange,
}: {
  id: string;
  agentLabel: string;
  value: string | null;
  disabled: boolean;
  onChange: (backend: TerminalBackendId | null) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const { targets, failed } = useTerminalTargets();
  const resolved = resolveTerminalBackend(value);
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

  function choose(backend: TerminalBackendId | null): void {
    setOpen(false);
    onChange(backend);
    root.current?.querySelector<HTMLButtonElement>(".terminal-pref-trigger")?.focus();
  }

  return (
    <span className="terminal-pref" ref={root}>
      <Tooltip label={`Which terminal every dispatched ${agentLabel} session launches in`}>
        <button
          id={id}
          type="button"
          className="harnesses-select terminal-pref-trigger"
          aria-label={`Terminal preference for ${agentLabel}: ${selectedLabel}`}
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
          aria-label={`Choose a terminal for dispatched ${agentLabel} sessions`}
        >
          <span className="launch-head terminal-pref-head">Terminal for {agentLabel}</span>
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
                <span className="launch-note">
                  Prefer an available multiplexer, then fall back to a terminal app.
                </span>
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
              {GROUPS.map((group) => {
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
                        selected={resolved.backend === target.id}
                        onChoose={() => choose(target.id)}
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
