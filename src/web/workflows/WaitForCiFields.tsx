import { useEffect, useId, useState } from "react";
import { Tooltip } from "../components/Tooltip.tsx";
import type { CiStrictness } from "@shared/ci-checks.ts";
import {
  WAIT_FOR_CI_EXPECTED_CHECKS,
  WAIT_FOR_CI_EXPECTED_CHECKS_MESSAGE,
  WAIT_FOR_CI_QUIET_MINUTES,
  WAIT_FOR_CI_QUIET_PERIOD_MESSAGE,
  WAIT_FOR_CI_TIMEOUT_MINUTES,
  ciStrictnessLabel,
  waitForCiExpectedChecksValid,
  waitForCiQuietFits,
  waitForCiSettings,
  type WaitForCiSettings,
  type WaitForCiStoredSettings,
} from "@shared/wait-for-ci.ts";

/** A Wait for CI node as both editors hold it: its timeout and its settings as stored. */
export type WaitForCiNodeFields = { timeoutMinutes: number } & WaitForCiStoredSettings;

/**
 * How long a Wait for CI node waits for the pull request's CI before blocking the run. Shared
 * by the Graph rail and the Pipeline editor so both say the same.
 *
 * Kept as local text and committed only when it is a whole number in range, so typing "60"
 * does not pass through an out-of-range "6" that the schema would refuse.
 */
export function WaitForCiTimeoutField({
  value,
  readOnly,
  onChange,
}: {
  value: number;
  readOnly: boolean;
  onChange: (timeoutMinutes: number) => void;
}): React.JSX.Element {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const { min, max } = WAIT_FOR_CI_TIMEOUT_MINUTES;
  const parsed = Number(text);
  const valid = Number.isInteger(parsed) && parsed >= min && parsed <= max;
  return (
    <label>
      Timeout (minutes)
      <input
        type="number"
        min={min}
        max={max}
        step={1}
        disabled={readOnly}
        value={text}
        aria-invalid={!valid}
        onChange={(event) => {
          setText(event.target.value);
          const next = Number(event.target.value);
          if (Number.isInteger(next) && next >= min && next <= max) onChange(next);
        }}
        onBlur={() => setText(String(value))}
      />
      <small>
        {valid
          ? "Blocks the run when CI is still running, or never appeared, after this long."
          : `Enter a whole number from ${min} to ${max}.`}
      </small>
    </label>
  );
}

const STRICTNESS_CHOICES: ReadonlyArray<{ value: CiStrictness; label: string; hint: string }> = [
  {
    value: "all",
    label: "All checks must pass",
    hint: "Every check GitHub reports on the head commit counts.",
  },
  {
    value: "required",
    label: "Required checks must pass",
    hint: "Only checks GitHub marks required, plus any expected checks, count. When none are "
      + "marked required, every check counts.",
  },
];

/** The expected-checks textarea's lines as a list: trimmed, blank lines dropped. */
function expectedLines(text: string): string[] {
  return text.split("\n")
    .map((line) => line.trim().slice(0, WAIT_FOR_CI_EXPECTED_CHECKS.nameMax))
    .filter((line) => line !== "")
    .slice(0, WAIT_FOR_CI_EXPECTED_CHECKS.schemaMax);
}

/**
 * A Wait for CI node's three settings: strictness, quiet period and expected checks. Shared by
 * the Graph rail and the Pipeline editor.
 *
 * It shows the resolved values, so a node saved before the settings existed shows the legacy
 * ones, and every change hands back all three: a legacy node keeps its fields absent until the
 * author edits one, and the first edit writes them all.
 */
export function WaitForCiSettingsFields({
  node,
  readOnly,
  onChange,
}: {
  node: WaitForCiNodeFields;
  readOnly: boolean;
  onChange: (settings: WaitForCiSettings) => void;
}): React.JSX.Element {
  const settings = waitForCiSettings(node);
  const change = (patch: Partial<WaitForCiSettings>) => onChange({
    ...settings,
    expectedChecks: [...settings.expectedChecks],
    ...patch,
  });
  const name = useId();
  const [quietText, setQuietText] = useState(String(settings.quietMinutes));
  useEffect(() => setQuietText(String(settings.quietMinutes)), [settings.quietMinutes]);
  const { min, max } = WAIT_FOR_CI_QUIET_MINUTES;
  const quietParsed = Number(quietText);
  const quietInRange = quietText.trim() !== "" && Number.isInteger(quietParsed) && quietParsed >= min && quietParsed <= max;
  const quietFits = waitForCiQuietFits(settings, node.timeoutMinutes);
  // The textarea keeps what was typed, a trailing blank line included, and is replaced only
  // when the stored list changes to something the text does not already say.
  const stored = settings.expectedChecks.join("\n");
  const [expectedText, setExpectedText] = useState(stored);
  useEffect(() => {
    setExpectedText((text) => expectedLines(text).join("\n") === stored ? text : stored);
  }, [stored]);
  return (
    <>
      <fieldset className="wf-ci-strictness" disabled={readOnly}>
        <legend>Strictness</legend>
        {/* The hint describes the choice rather than naming it, so it stays out of the label. */}
        {STRICTNESS_CHOICES.map((choice) => (
          <div key={choice.value} className="wf-ci-choice">
            <Tooltip label={choice.hint}>
              <label>
                <input
                  type="radio"
                  name={name}
                  value={choice.value}
                  checked={settings.strictness === choice.value}
                  aria-describedby={`${name}-${choice.value}`}
                  onChange={() => change({ strictness: choice.value })}
                />
                {choice.label}
              </label>
            </Tooltip>
            <small id={`${name}-${choice.value}`}>{choice.hint}</small>
          </div>
        ))}
      </fieldset>
      <label>
        Quiet period (minutes)
        <input
          type="number"
          min={min}
          max={max}
          step={1}
          disabled={readOnly}
          value={quietText}
          aria-invalid={!quietInRange || !quietFits}
          onChange={(event) => {
            setQuietText(event.target.value);
            const next = Number(event.target.value);
            if (event.target.value.trim() !== "" && Number.isInteger(next) && next >= min && next <= max
              && next !== settings.quietMinutes) {
              change({ quietMinutes: next });
            }
          }}
          onBlur={() => setQuietText(String(settings.quietMinutes))}
        />
        <small>
          {!quietInRange
            ? `Enter a whole number from ${min} to ${max}.`
            : !quietFits
              ? WAIT_FOR_CI_QUIET_PERIOD_MESSAGE
              : "Passes once every counted check has settled and stayed unchanged this long. Set 0 to "
                + "pass as soon as they settle."}
        </small>
      </label>
      <label>
        Expected checks
        <textarea
          rows={3}
          disabled={readOnly}
          value={expectedText}
          aria-invalid={!waitForCiExpectedChecksValid(settings.expectedChecks)}
          onChange={(event) => {
            setExpectedText(event.target.value);
            const next = expectedLines(event.target.value);
            if (next.join("\n") !== stored) change({ expectedChecks: next });
          }}
        />
        <small>
          {waitForCiExpectedChecksValid(settings.expectedChecks)
            ? "One check name per line, exactly as GitHub shows it. Each must appear and pass in "
              + "either mode. Once all have settled, the quiet period is skipped."
            : WAIT_FOR_CI_EXPECTED_CHECKS_MESSAGE}
        </small>
      </label>
    </>
  );
}

/**
 * Every field a Wait for CI node has, in the order both editors show them: the timeout, then
 * the three settings. `onChange` receives the node's new fields.
 */
export function WaitForCiNodeFieldset({
  node,
  readOnly,
  onChange,
}: {
  node: WaitForCiNodeFields;
  readOnly: boolean;
  onChange: (next: WaitForCiNodeFields) => void;
}): React.JSX.Element {
  return (
    // The Pipeline row around these fields moves focus or removes the node on arrow and Delete keys.
    <div className="wf-ci-fields" onKeyDown={(event) => event.stopPropagation()}>
      <WaitForCiTimeoutField
        value={node.timeoutMinutes}
        readOnly={readOnly}
        onChange={(timeoutMinutes) => onChange({ ...node, timeoutMinutes })}
      />
      <WaitForCiSettingsFields
        node={node}
        readOnly={readOnly}
        onChange={(settings) => onChange({ ...node, ...settings, expectedChecks: [...settings.expectedChecks] })}
      />
    </div>
  );
}

/**
 * One line naming what a Wait for CI node judges under, for the Pipeline row and its live
 * announcement: `Required checks · quiet 3 min · blocks after 45 min · expects 2 checks`.
 */
export function waitForCiSummary(node: WaitForCiNodeFields): string {
  const settings = waitForCiSettings(node);
  const expected = settings.expectedChecks.length;
  return [
    ciStrictnessLabel(settings.strictness),
    `quiet ${settings.quietMinutes} min`,
    `blocks after ${node.timeoutMinutes} min`,
    expected > 0 ? `expects ${expected} check${expected === 1 ? "" : "s"}` : null,
  ].filter(Boolean).join(" · ");
}

/** What the node does, said once for both editors. */
export const WAIT_FOR_CI_EXPLANATION =
  "Waits for the pull request's CI on the head the Pull Request action proved. It passes once "
  + "every counted check has passed and stayed settled for the quiet period, and returns a "
  + "failing check to the session by name. It blocks the run when CI times out, never appears, "
  + "or an expected check never appears. It reads CI through the GitHub Inspector, which must "
  + "be on.";
