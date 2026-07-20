import { readFileSync } from "node:fs";
import { foremanInstructionsPath } from "../config.ts";
import { getAppConfig, setAppConfig } from "../db.ts";

// Foreman's standing instructions: the prose half of its configuration, beside the typed
// knobs in `config.ts`.
//
// The division between the two is the thing to preserve. `ForemanConfig` grants AUTHORITY -
// whether Foreman may type at all, in which repos, whether it may approve access asks. This
// text shapes JUDGEMENT - what the operator considers finished, which conventions they care
// about, how to weigh a trade-off. A knob is a switch the human flips; this is the human
// talking to the reviewer in their own words, and neither can do the other's job.
//
// Stored exactly like `ForemanConfig`, `AwayConfig` and `SkillsConfig`: a value in the
// `app_config` KV, so the settings panel that will edit it needs no migration and no new
// table. `FOREMAN.md` at the app root is the SEED, not the storage - once the human edits
// this, the file is only what a fresh install starts from.

const CONFIG_KEY = "foreman.instructions";

/**
 * The shipped default, read once.
 *
 * Cached because it cannot change while the daemon runs - it is a file inside the install,
 * not a user document - and this is read on every review, every verify and every triage.
 * A missing or unreadable file degrades to "no instructions", which is the same state as an
 * operator who cleared the setting, and renders nothing.
 */
let seeded: string | undefined;
function seed(): string {
  if (seeded === undefined) {
    try {
      seeded = readFileSync(foremanInstructionsPath(), "utf8");
    } catch {
      seeded = "";
    }
  }
  return seeded;
}

/**
 * What Foreman should be told about how this operator wants calls made.
 *
 * The stored value wins whenever one EXISTS, including when it is empty. That distinction is
 * the whole reason this is not `stored || seed()`: an operator who clears the box is saying
 * "judge by your own policy alone", and falling back to the shipped default there would
 * quietly reinstate instructions they had just deleted - the same reasoning
 * `wrapupTriggers: []` documents for an empty list meaning empty rather than unset.
 */
export function foremanInstructions(): string {
  const stored = getAppConfig<unknown>(CONFIG_KEY);
  return typeof stored === "string" ? stored : seed();
}

/** Replace the stored instructions. Passing the empty string means "none", not "reset". */
export function setForemanInstructions(text: string): string {
  setAppConfig(CONFIG_KEY, text);
  return text;
}

/**
 * Drop the stored value so the shipped default applies again - what a "Reset to default"
 * control does. Distinct from setting it to "", which is an operator choosing to have none.
 */
export function resetForemanInstructions(): string {
  // `null`, not `undefined`: `setAppConfig` binds `JSON.stringify(value)`, and stringifying
  // `undefined` yields `undefined` rather than a string, which the driver refuses to bind.
  // `null` round-trips through `getAppConfig` and fails the `typeof === "string"` test above,
  // which is exactly what "no stored value" has to look like.
  setAppConfig(CONFIG_KEY, null);
  return seed();
}

/** The shipped default itself, so the settings UI can show what a reset would restore. */
export function defaultForemanInstructions(): string {
  return seed();
}
