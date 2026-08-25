// The install receipt's shape, and the one trusted repository slug - both browser-safe.
//
// Deliberately split from `install-receipt.mjs`, which does the filesystem work: anything
// renderer-adjacent that needs to reason about a receipt (or needs `CANONICAL_REPO`) imports
// THIS half, so no import path can drag `node:fs` into the web bundle. Nothing here may
// import `node:` anything.
//
// This is `.mjs` rather than `.ts` because `scripts/install-app.mjs` runs under bare `node`
// with no build step, exactly like `hooks/harness-hook.mjs` does, so it cannot import a
// TypeScript module - and a schema the writer validates against but the reader cannot would
// be two schemas. The paired `.d.mts` gives the TypeScript side its types, matching
// `harness-runtime.mjs` and `pr-command.mjs`.

/**
 * The only repository whose releases are trusted, as `owner/name`.
 *
 * One exported constant rather than a copy per caller. The install script, the release
 * lookup, and the updater all read it, and `gh` infers a repository from whichever checkout
 * it runs in when `--repo` is omitted - so a second, drifting copy is a trust hole rather
 * than a duplication smell. Not user-configurable.
 */
export const CANONICAL_REPO = "teamupstart/mission-control";
export const FORMER_CANONICAL_REPO = "mancej-cyc/ai-harness";

/** Whether a receipt came from the current canonical repository or its exact former slug. */
export function isTrustedInstallRepo(repo) {
  return repo === CANONICAL_REPO || repo === FORMER_CANONICAL_REPO;
}

/**
 * Current receipt schema. Append-only: add optional fields under the same number, or
 * increment and keep accepting every earlier number.
 */
export const INSTALL_RECEIPT_SCHEMA = 1;

/** Absolute-path check that does not need `node:path`. */
function isAbsolutePosixPath(value) {
  return typeof value === "string" && value.startsWith("/");
}

function isRepoSlug(value) {
  return typeof value === "string" && /^[\w.-]+\/[\w.-]+$/.test(value);
}

function isIsoTimestamp(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

/**
 * Validate a value as an install receipt. Returns a human-readable reason it is not one, or
 * `null` when it is.
 *
 * A receipt whose `schema` is HIGHER than this build knows is declined rather than read
 * field by field, because the updater decides whether to rebuild and swap the app from this
 * file: a newer install's receipt may mean something this build would misread.
 */
export function validateReceipt(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "receipt is not an object";
  }
  const receipt = /** @type {Record<string, unknown>} */ (value);
  const { schema } = receipt;
  if (!Number.isInteger(schema) || Number(schema) < 1) {
    return "receipt schema is missing or not a positive integer";
  }
  if (Number(schema) > INSTALL_RECEIPT_SCHEMA) {
    return `receipt schema ${schema} is newer than this build understands (${INSTALL_RECEIPT_SCHEMA})`;
  }
  if (!isRepoSlug(receipt.repo)) return "receipt repo is not an owner/name slug";
  if (receipt.releaseTag !== null && typeof receipt.releaseTag !== "string") {
    return "receipt releaseTag is neither a string nor null";
  }
  if (typeof receipt.releaseTag === "string" && receipt.releaseTag.length === 0) {
    return "receipt releaseTag is an empty string (use null when there is no tag)";
  }
  if (typeof receipt.installedVersion !== "string" || receipt.installedVersion.length === 0) {
    return "receipt installedVersion is missing";
  }
  if (!isAbsolutePosixPath(receipt.sourceClone)) {
    return "receipt sourceClone is not an absolute path";
  }
  if (!isAbsolutePosixPath(receipt.appPath)) return "receipt appPath is not an absolute path";
  if (!isIsoTimestamp(receipt.installedAt)) {
    return "receipt installedAt is not an ISO 8601 timestamp";
  }
  return null;
}
