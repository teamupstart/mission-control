import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  ForemanInstructionsSource,
  ForemanInstructionsUpdate,
  ForemanInstructionsView,
} from "@shared/protocol.ts";
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
// table. `personas/FOREMAN.md` under the app root is the SEED, not the storage - once the human edits
// this, the file is only what a fresh install starts from.

const CONFIG_KEY = "foreman.instructions";
const ETAG_NAMESPACE = "mission-control:foreman-instructions:v1";

export type ForemanInstructionsMutation =
  | { ok: true; view: ForemanInstructionsView }
  | { ok: false; current: ForemanInstructionsView };

/**
 * The shipped default, read once.
 *
 * Cached because it cannot change while the daemon runs - it is a file inside the install,
 * not a user document - and this is read on every review, every verify and every triage.
 * A missing or unreadable file degrades to an empty built-in document and renders nothing.
 * It remains source-distinct from an operator intentionally clearing the setting.
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

/** Hash the source and every exact effective UTF-16 code unit into one stable opaque CAS token. */
function instructionsEtag(source: ForemanInstructionsSource, text: string): string {
  const hash = createHash("sha256");
  hash.update(ETAG_NAMESPACE, "utf8");
  hash.update("\0", "utf8");
  hash.update(source, "utf8");
  hash.update("\0", "utf8");
  // The API accepts every JavaScript string, including escaped lone surrogates. UTF-8 encoding
  // replaces each lone surrogate with the same U+FFFD bytes, which would let distinct documents
  // share a CAS token. Fixed little-endian code units preserve the exact accepted string instead.
  hash.update(text, "utf16le");
  return `foreman-instructions-v1:${hash.digest("hex")}`;
}

/** Construct a source-aware view without performing another config read. */
function viewFromStored(stored: unknown): ForemanInstructionsView {
  const defaultText = seed();
  const source: ForemanInstructionsSource = typeof stored !== "string"
    ? "builtin"
    : stored.length === 0
      ? "none"
      : "custom";
  const text = source === "builtin" ? defaultText : stored as string;
  return {
    text,
    defaultText,
    source,
    etag: instructionsEtag(source, text),
  };
}

/**
 * The one current document view. Each construction reads the durable key exactly once.
 *
 * The stored value wins whenever one EXISTS, including when it is empty. That distinction is
 * the whole reason this is not `stored || seed()`: an operator who clears the box is saying
 * "judge by your own policy alone", and falling back to the shipped default there would
 * quietly reinstate instructions they had just deleted - the same reasoning
 * `wrapupTriggers: []` documents for an empty list meaning empty rather than unset.
 */
export function foremanInstructionsView(): ForemanInstructionsView {
  return viewFromStored(getAppConfig<unknown>(CONFIG_KEY));
}

/**
 * Compare and synchronously replace or reset the current document.
 *
 * There is deliberately no await between the current read, comparison, and config write. A stale
 * caller receives the current view and performs no write. Empty text remains a durable `none`
 * state; reset writes null so older builds continue selecting the shipped seed.
 */
export function updateForemanInstructions(
  update: ForemanInstructionsUpdate,
): ForemanInstructionsMutation {
  const current = foremanInstructionsView();
  if (update.expectedEtag !== current.etag) return { ok: false, current };

  const stored = "text" in update ? update.text : null;
  setAppConfig(CONFIG_KEY, stored);
  return { ok: true, view: viewFromStored(stored) };
}
