import type { ThinkingLevel } from "@shared/types.ts";
import { Tooltip } from "../components/Tooltip.tsx";

/**
 * A Persona call's reasoning effort, for the Persona editor and the workflow node editor.
 *
 * `levels` is what the selected provider and model offer (`personaEffortLevels`), so the list
 * is the same capability table sessions and tasks launch from, never a second list. A saved
 * value outside it stays selected and is FLAGGED rather than dropped: the operator chose it,
 * the provider or model changed underneath it, and the honest response is to say it will not
 * apply - the daemon refuses to save or publish it - not to quietly pick another level.
 */
export function EffortSelect({
  name,
  levels,
  value,
  readOnly,
  tooltip,
  className = "wf-node-execution-field",
  flag = true,
  onChange,
}: {
  /** The reviewer this is about, so the accessible name addresses one control. */
  name: string;
  levels: readonly ThinkingLevel[];
  value: ThinkingLevel | "";
  readOnly: boolean;
  tooltip: string;
  className?: string;
  /** False when the caller already flags an unsupported level somewhere more visible. */
  flag?: boolean;
  onChange: (effort: ThinkingLevel | "") => void;
}): React.JSX.Element {
  const unsupported = value !== "" && !levels.includes(value);
  return (
    <>
      <label className={className}>
        <span>Effort</span>
        <Tooltip label={tooltip}>
          <select
            aria-label={`Effort for ${name}`}
            value={value}
            disabled={readOnly}
            onChange={(event) => onChange(event.target.value as ThinkingLevel | "")}
          >
            <option value="">Provider default</option>
            {unsupported && <option value={value}>{value} (unsupported)</option>}
            {levels.map((level) => <option key={level} value={level}>{level}</option>)}
          </select>
        </Tooltip>
      </label>
      {unsupported && flag && (
        <p className="wf-node-execution-incomplete" role="status">
          This provider and model do not support {value} effort. Choose another level or the
          provider default.
        </p>
      )}
    </>
  );
}
