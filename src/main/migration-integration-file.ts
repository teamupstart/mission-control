// Other programs do not share Mission's writer lock. Never rename over their
// current file: move the original into private recovery storage, validate what
// was actually moved, then publish with link(2)'s atomic no-replace semantics.
import { createHash } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

function recoveryDirectory(path: string, nonce: string): string {
  if (!/^[0-9a-f]{64}$/.test(nonce)) throw new Error("Invalid integration repair identity.");
  return `${path}.mission-migration-${nonce}`;
}

function privateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("Integration recovery storage has unexpected ownership or permissions.");
}

function fileText(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error("An integration changed its file type or ownership during repair.");
  return readFileSync(path, "utf8");
}

/** Keep the displaced inode, including late writes through an editor's open fd.
 * Retry checks those files too, even when the active registration looks complete. */
export function verifyIntegrationBackups(path: string, nonce: string): void {
  const directory = recoveryDirectory(path, nonce);
  if (!existsSync(directory)) return;
  privateDirectory(directory);
  const originals: string[] = [];
  for (const name of readdirSync(directory)) {
    const attempt = join(directory, name);
    privateDirectory(attempt);
    const before = join(attempt, "original");
    if (!existsSync(before)) continue; // interrupted before moving the original
    originals.push(before);
    if (digest(fileText(before)) !== fileText(join(attempt, "digest"))) throw new Error(`A concurrent integration edit was preserved at ${before}. Merge it into ${path}, remove ${directory}, then retry.`);
  }
  // With several saved versions we cannot guess which one the operator wants.
  if (!existsSync(path) && originals.length) {
    if (originals.length !== 1) throw new Error(`Restore the desired integration configuration from ${directory}, then retry.`);
    try { linkSync(originals[0]!, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
}

export function publishIntegrationText(path: string, nonce: string, original: string, text: string,
  operations = {rename: renameSync, link: linkSync}): void {
  verifyIntegrationBackups(path, nonce);
  const directory = recoveryDirectory(path, nonce);
  if (!existsSync(directory)) mkdirSync(directory, {mode: 0o700});
  privateDirectory(directory);
  const attempt = mkdtempSync(join(directory, "attempt-"));
  const before = join(attempt, "original");
  const replacement = join(attempt, "replacement");
  writeFileSync(join(attempt, "digest"), digest(original), {mode: 0o600, flag: "wx"});
  writeFileSync(replacement, text, {mode: 0o600, flag: "wx"});
  if (fileText(path) !== original) throw new Error("The integration changed while being repaired. Its current file was preserved.");
  operations.rename(path, before);
  try {
    if (fileText(before) !== original) throw new Error("The integration changed while being repaired.");
    operations.link(replacement, path); // EEXIST preserves any concurrent publication
  } catch (error) {
    try { linkSync(before, path); }
    catch (restoreError) { if ((restoreError as NodeJS.ErrnoException).code !== "EEXIST") throw new Error(`Integration recovery is required at ${before}: ${String(restoreError)}`); }
    throw new Error(`The integration changed during repair. Its files were preserved at ${path} and ${before}: ${String(error)}`);
  }
  verifyIntegrationBackups(path, nonce);
  if (fileText(path) !== text) throw new Error("The integration changed after publication. Its current file was preserved.");
}
