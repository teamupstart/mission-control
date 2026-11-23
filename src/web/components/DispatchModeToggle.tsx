import type { DispatchLaunchMode } from "../lib/dispatch-mode.ts";
import { Tooltip } from "./Tooltip.tsx";

/** Each launch mode's label and what choosing it does, in toggle order. */
const LAUNCH_MODES: ReadonlyArray<{ id: DispatchLaunchMode; label: string; hint: string }> = [
  { id: "single", label: "Single agent", hint: "Dispatch one agent to this task" },
  { id: "ensemble", label: "Ensemble", hint: "Launch several agents on the same task and compare them" },
  { id: "resident", label: "Resident", hint: "Launch a long-running agent from a resident profile" },
];

/**
 * Dispatch's launch-mode toggle. It lives at dialog level, not among the fields: each mode
 * reshapes the whole form below it. One component so Single, Ensemble and Resident draw the
 * same control from whichever body is showing.
 */
export function DispatchModeToggle({
  mode,
  onChange,
}: {
  mode: DispatchLaunchMode;
  onChange: (mode: DispatchLaunchMode) => void;
}): React.JSX.Element {
  return (
    <div className="dispatch-mode-toggle" role="radiogroup" aria-label="Launch mode">
      {LAUNCH_MODES.map(({ id, label, hint }) => (
        <Tooltip key={id} label={hint}>
          <button
            type="button"
            role="radio"
            aria-checked={mode === id}
            className={mode === id ? "active" : ""}
            onClick={() => onChange(id)}
          >
            {label}
          </button>
        </Tooltip>
      ))}
    </div>
  );
}
