// The update log and the one redaction every line passes through on its way into it.
//
// Its own module because two update paths now write to `update.log` and both have to redact:
// the controller's own diagnostics, and the staged build's `npm` and `electron-builder`
// output, which is the only channel that carries content nobody here wrote. Keeping the rule
// beside the writer, importable by both, is what stops "the writer redacts" from being a
// property you can only establish by reading the caller.

import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_LOG_BYTES = 1_000_000;

/**
 * Remove credentials, absolute paths, and remote URLs before update diagnostics reach disk
 * or UI.
 *
 * The URL rules are not decoration. The staged build's `npm` and `electron-builder` output is
 * the one update channel carrying text this app did not write, and a registry line is exactly
 * where a private host and an embedded credential turn up:
 * `npm warn registry https://user:hunter2@registry.internal.example/ returned 403` leaked in
 * full before them, because a path rule anchored on a preceding space or quote never fires on
 * the `//` after a scheme's colon. Both spellings of a git remote go the same way: `scheme://`
 * and the `git@host:path` form.
 *
 * Whole URLs rather than just their credentials, and no allowlist for hosts that look public:
 * "which registry" is the fact worth hiding, the same way "which directory" already is, and
 * an error class survives redaction ("request to <url> failed ... ENOTFOUND") while a host
 * does not.
 *
 * Idempotent over its own output - `<path>`, `<url>` and `<redacted-token>` match none of
 * these patterns - so a line may safely pass through it more than once on its way to the log.
 *
 * `scripts/apply-update.mjs` keeps a deliberate copy of this rule set as `sanitizeDiagnostic`,
 * because the detached helper is copied to a temp directory with exactly one sibling module
 * and cannot import this one. `test/update-log.test.ts` pins the two to the same output so
 * the copy cannot drift.
 */
export function sanitizeLogLine(line: string): string {
  return line
    .replace(/Authorization\s*:\s*[^\s]+(?:\s+[^\s]+)?/gi, "Authorization: <redacted>")
    .replace(/\b(?:gh[opusr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, "<redacted-token>")
    .replace(/\b(token|access_token|auth)\s*[=:]\s*[^\s]+/gi, "$1=<redacted>")
    // Before the general rule, and left as `file://<path>`: a local file URL says nothing
    // about a remote, and the path inside it is what mattered.
    .replace(/\bfile:\/\/\/[^\s"')]+/g, "file://<path>")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`)<>\]]+/gi, "<url>")
    // The scp-style git remote, which carries no scheme at all: `git@github.com:org/repo.git`.
    // Anchored on a dotted host followed by a colon and a path, so an ordinary `name@version`
    // and a bare email address are both left alone.
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+:[^\s"'`)<>]+/gi, "<url>")
    .replace(/(^|[\s"'(=])\/(?:[^\s"'),]+\/?)+/g, "$1<path>");
}

export function createRotatingUpdateLogger(path: string): (line: string) => void {
  return (line: string) => {
    try {
      mkdirSync(join(path, ".."), { recursive: true });
      if (statSync(path, { throwIfNoEntry: false })?.size && statSync(path).size >= MAX_LOG_BYTES) {
        rmSync(`${path}.1`, { force: true });
        renameSync(path, `${path}.1`);
      }
      appendFileSync(path, `${new Date().toISOString()} ${sanitizeLogLine(line)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch {
      // A diagnostic log must never break update behavior.
    }
  };
}
