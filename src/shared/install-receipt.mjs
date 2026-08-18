// Reading and writing the install receipt - the file that tells a packaged app what was
// installed, from which repository and ref, and which clone it was built in.
//
// The schema half lives in `install-receipt-schema.mjs` and is browser-safe; this half is
// the only one that touches the filesystem. A node-using `.mjs` in `src/shared/` is the
// established shape here, not a novelty: `harness-runtime.mjs` imports `node:fs` and does
// the same temp-file-then-rename write, and its consumers are the same mix of `scripts/`,
// the daemon, and bundled processes.
//
// Consumers: `scripts/install-app.mjs` writes it; the packaged main process reads it to
// decide whether the updater is active at all.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDir } from "./harness-runtime.mjs";
import { validateReceipt } from "./install-receipt-schema.mjs";

/** Where the receipt lives, inside the daemon's existing state directory. */
export function receiptPath() {
  return join(stateDir(), "install-receipt.json");
}

/**
 * Read the receipt, or `null` when there is not a usable one.
 *
 * `null` is the answer for absent, unreadable, malformed, and schema-too-new alike, and it
 * has one meaning for the caller: this install is not updater-managed. Every install made
 * before the managed path existed lands here, which is the intended reading rather than an
 * error to report.
 */
export function readReceipt(path = receiptPath()) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return validateReceipt(parsed) === null ? parsed : null;
}

/**
 * Write the receipt atomically. Throws before touching anything when the receipt is invalid,
 * so a rejected write leaves an existing receipt exactly as it was.
 *
 * Temp file then `renameSync`, matching `harness-runtime.mjs`: a reader either sees the old
 * receipt or the new one, never a half-written file. The updater reads this to decide whether
 * to rebuild and swap the app, so a truncated receipt is worse than a stale one.
 */
export function writeReceipt(receipt, path = receiptPath()) {
  const problem = validateReceipt(receipt);
  if (problem) throw new Error(`refusing to write an invalid install receipt: ${problem}`);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o644 });
    renameSync(temp, path);
  } catch (err) {
    if (existsSync(temp)) rmSync(temp, { force: true });
    throw err;
  }
  return path;
}
