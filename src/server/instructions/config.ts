import { createHash } from "node:crypto";
import {
  StandingInstructionsConfigSchema,
  type StandingInstructionsUpdate,
  type StandingInstructionsView,
} from "@shared/protocol.ts";
import {
  STANDING_INSTRUCTIONS_MAX_REPOSITORIES,
  type StandingInstructionsConfig,
} from "@shared/standing-instructions.ts";
import { getAppConfig, setAppConfig } from "../db.ts";

// The durable half of repository standing instructions: one machine-wide default plus a
// per-repository map, held in the `app_config` KV.
//
// Modelled directly on `src/server/foreman/instructions.ts`, which is the closest existing
// thing - an operator's prose, edited as a document, guarded by a compare-and-swap token so
// a stale window cannot silently overwrite a newer edit. The difference is only that this
// document has many boxes rather than one.
//
// No migration, for the reason six other config modules here record: `app_config` holds a
// schema-validated blob and zod defaults apply on every read, so an installation that has
// never seen this key reads the shipped empty document.

const CONFIG_KEY = "instructions.standing";
const ETAG_NAMESPACE = "mission-control:standing-instructions:v1";

export type StandingInstructionsMutation =
  | { ok: true; view: StandingInstructionsView }
  /** A stale `expectedEtag`. The caller gets the current document and nothing was written. */
  | { ok: false; conflict: StandingInstructionsView }
  /** The MERGED document would break a bound the patch alone could not see. */
  | { ok: false; refusal: string };

/**
 * Hash every exact effective UTF-16 code unit of the whole document into one opaque token.
 *
 * `utf16le`, not `utf8`, for the reason `foreman/instructions.ts` records: the API accepts
 * every JavaScript string, escaped lone surrogates included, and UTF-8 encoding collapses
 * each of those onto the same U+FFFD bytes - which would let two DIFFERENT documents share
 * a CAS token and so let one silently overwrite the other.
 *
 * Keys are sorted so an object that happens to have been built in another insertion order
 * is the same document, and each field is length-prefixed so no pair of keys and values can
 * be re-cut into a different pair with the same bytes.
 */
function instructionsEtag(config: StandingInstructionsConfig): string {
  const hash = createHash("sha256");
  hash.update(ETAG_NAMESPACE, "utf8");
  const part = (value: string): void => {
    hash.update(`\0${value.length}\0`, "utf8");
    hash.update(value, "utf16le");
  };
  part(config.default);
  for (const key of Object.keys(config.repositories).sort()) {
    part(key);
    part(config.repositories[key] ?? "");
  }
  return `standing-instructions-v1:${hash.digest("hex")}`;
}

/**
 * The stored document, defaulted.
 *
 * An unreadable blob - written by a newer build, or corrupted - degrades to the shipped
 * empty document rather than throwing. This is read on every dispatch, and taking out a
 * launch over an unparseable settings row would be a far worse failure than sending no
 * standing instruction.
 */
export function standingInstructionsConfig(): StandingInstructionsConfig {
  const parsed = StandingInstructionsConfigSchema.safeParse(
    getAppConfig<unknown>(CONFIG_KEY) ?? {},
  );
  return parsed.success ? parsed.data : { default: "", repositories: {} };
}

function viewOf(config: StandingInstructionsConfig): StandingInstructionsView {
  return { ...config, etag: instructionsEtag(config) };
}

/** The one current document view. Each construction reads the durable key exactly once. */
export function standingInstructionsView(): StandingInstructionsView {
  return viewOf(standingInstructionsConfig());
}

/**
 * Compare and synchronously apply a patch to the current document.
 *
 * There is deliberately no await between the read, the comparison and the write, so two
 * windows cannot interleave: a stale caller receives the current view and performs no write.
 *
 * `repositories` is a PATCH. An absent key is left alone, a string sets it, and `null`
 * removes it - so a panel saving one repository sends that one key and cannot persist a
 * neighbouring box's unsaved draft. The empty string is a real value and is NOT a removal:
 * it means "send nothing for this repository", which beats the machine-wide default.
 */
export function updateStandingInstructions(
  update: StandingInstructionsUpdate,
): StandingInstructionsMutation {
  const current = standingInstructionsConfig();
  const currentView = viewOf(current);
  if (update.expectedEtag !== currentView.etag) return { ok: false, conflict: currentView };

  const repositories = { ...current.repositories };
  for (const [key, value] of Object.entries(update.repositories ?? {})) {
    if (value === null) delete repositories[key];
    else repositories[key] = value;
  }
  // The cap is on the MERGED document, which no schema on the patch can check: a patch of
  // one key is always within the bound and can still be the key that takes the store past
  // it. Refused rather than truncated - dropping somebody else's repository to make room
  // for this one is the worst available answer.
  if (Object.keys(repositories).length > STANDING_INSTRUCTIONS_MAX_REPOSITORIES) {
    return {
      ok: false,
      refusal:
        `at most ${STANDING_INSTRUCTIONS_MAX_REPOSITORIES} repositories may carry standing instructions`,
    };
  }
  const next: StandingInstructionsConfig = {
    default: update.default ?? current.default,
    repositories,
  };
  setAppConfig(CONFIG_KEY, next);
  return { ok: true, view: viewOf(next) };
}
