import { useId } from "react";
import {
  SPOKEN_NAME_MAX,
  SPOKEN_NAME_METER_STEPS,
  spokenNameMeter,
  spokenNameWarningLabel,
  quotedReferenceName,
  spokenNameWarningText,
  validateSpokenName,
  type SpokenName,
} from "@shared/voice-names.ts";

/** The sentence a name is previewed in: what the operator would say to the agent. */
export const SPOKEN_NAME_EXAMPLE = "check the build";

function MicGlyph(): React.JSX.Element {
  return (
    <svg className="voice-heard-glyph" viewBox="0 0 16 16" aria-hidden focusable="false">
      <path d="M8 1.5a2 2 0 0 0-2 2v4a2 2 0 0 0 4 0v-4a2 2 0 0 0-2-2z" />
      <path d="M4 7.5a4 4 0 0 0 8 0M8 11.5v3M5.5 14.5h5" />
    </svg>
  );
}

/**
 * The heard-as preview under a spoken-name field (the adopted call sign design): the sentence
 * the operator would say, a four-step distinctiveness meter that loses a step per warning, and
 * one line per warning saying why. Every warning is advice: nothing here blocks a save.
 */
export function SpokenNamePreview({
  name,
  roster,
  referenceName = false,
  example = SPOKEN_NAME_EXAMPLE,
}: {
  name: string;
  /** Who else answers to a name, without the agent this name is for. */
  roster: readonly Pick<SpokenName, "name" | "isReferenceName">[];
  referenceName?: boolean;
  example?: string;
}): React.JSX.Element {
  const said = name.trim().replace(/\s+/g, " ");
  if (!said) {
    return (
      <span className="voice-heard is-empty">
        <MicGlyph />
        Type a name to see how you would say it.
      </span>
    );
  }
  const warnings = validateSpokenName(said, roster);
  const lit = spokenNameMeter(warnings);
  const first = warnings[0];
  return (
    <>
      <span className="voice-heard">
        <MicGlyph />
        <span><b>{referenceName ? quotedReferenceName(said) : said},</b> {example}</span>
      </span>
      <span className="voice-meter-row">
        <span
          className={`voice-meter ${first ? "is-warn" : "is-good"}`}
          role="meter"
          aria-label="Distinctiveness"
          aria-valuemin={0}
          aria-valuemax={SPOKEN_NAME_METER_STEPS}
          aria-valuenow={lit}
          aria-valuetext={first ? `${lit} of ${SPOKEN_NAME_METER_STEPS}: ${warnings.map(spokenNameWarningLabel).join(", ")}` : "Distinctive"}
        >
          {Array.from({ length: SPOKEN_NAME_METER_STEPS }, (_, step) => (
            <i key={step} className={step < lit ? "on" : undefined} />
          ))}
        </span>
        <span className={first ? "voice-meter-bad" : "voice-meter-good"}>
          {first ? spokenNameWarningLabel(first) : "Distinctive"}
        </span>
      </span>
      {warnings.map((warning) => (
        <span key={warning.kind} className="voice-name-warning">{spokenNameWarningText(warning, said, referenceName)}</span>
      ))}
    </>
  );
}

/**
 * What a screen reader is told as a name's warnings change: the meter's verdict, every warning by
 * its short label, or nothing while the field is blank. Only the verdict, so typing a letter that
 * changes no warning announces nothing.
 */
export function spokenNameVerdict(name: string, roster: readonly Pick<SpokenName, "name" | "isReferenceName">[]): string {
  const said = name.trim().replace(/\s+/g, " ");
  if (!said) return "";
  const warnings = validateSpokenName(said, roster);
  return warnings.length === 0 ? "Distinctive" : warnings.map(spokenNameWarningLabel).join(", ");
}

/**
 * A call sign or reference name: an optional text field with the heard-as preview under it.
 * The value is the raw text as typed; whoever saves it trims it, and blank means none.
 *
 * The verdict also sits in a polite status region that stays mounted, so a change of warnings is
 * announced while the operator types, without moving focus.
 */
export function SpokenNameField({
  label,
  value,
  onChange,
  roster,
  placeholder,
  disabled = false,
  referenceName,
  example,
  className = "",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  roster: readonly Pick<SpokenName, "name" | "isReferenceName">[];
  placeholder: string;
  disabled?: boolean;
  referenceName?: boolean;
  example?: string;
  className?: string;
}): React.JSX.Element {
  const id = useId();
  return (
    <div className={`field spoken-name-field ${className}`.trim()}>
      <label className="field-label" htmlFor={id}>
        {label} <span className="field-hint">optional</span>
      </label>
      <input
        id={id}
        aria-label={label}
        className="field-input"
        value={value}
        maxLength={SPOKEN_NAME_MAX}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
      <SpokenNamePreview referenceName={referenceName} name={value} roster={roster} example={example} />
      <span role="status" aria-live="polite" className="sr-only">{spokenNameVerdict(value, roster)}</span>
    </div>
  );
}
