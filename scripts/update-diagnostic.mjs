// The detached helper's one redaction policy for text a person or a log will read.
//
// Its own module so both halves of an update can apply it: `apply-update.mjs` for the legacy
// transaction's outcome and log lines, and `install-migration.mjs` for a migration's rollback
// cause - which `apply-update.mjs` already imports, so the policy cannot live there without a
// cycle.

/**
 * The same rule set as `sanitizeLogLine` in `src/main/update-log.ts`, plus a length cap.
 *
 * A deliberate copy, not an oversight: this file's detached dependency graph cannot import
 * the main-process TypeScript logger after it outlives the app bundle.
 * `test/update-log.test.ts` asserts both produce identical output, which is what keeps a copy
 * from becoming a divergence - the URL rules were added to both in the same change, after a
 * review found that a registry or git URL reached the log in full.
 */
export function sanitizeDiagnostic(value) {
  return String(value)
    .replace(
      /(["'])Authorization\1\s*:\s*(["'])(?!<redacted>)[^"']*\2/gi,
      "$1Authorization$1: $2<redacted>$2",
    )
    // `(?!<redacted>)`: see the note beside the same rule in `src/main/update-log.ts`. Without
    // it a second pass over this function's own output consumed the following word.
    .replace(/Authorization\s*:\s*(?!<redacted>)[^\s]+(?:\s+[^\s]+)?/gi, "Authorization: <redacted>")
    .replace(/\b(?:gh[opusr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, "<redacted-token>")
    .replace(/\b(token|access_token|auth)\s*[=:]\s*[^\s]+/gi, "$1=<redacted>")
    .replace(/\bfile:\/\/\/[^\s"')]+/g, "file://<path>")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`)<>\]]+/gi, "<url>")
    .replace(/^\s*[\w.+-]+@(?=[\w.-]*[a-z])[\w-]+(?:\.[\w-]+)+:(?=\s)/gi, "<url>:")
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+:[^\s"'`)<>]+/gi, "<url>")
    .replace(/(^|[\s"'(=])\/(?:[^\s"'),]+\/?)+/g, "$1<path>")
    .slice(0, 500);
}
