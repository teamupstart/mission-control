import { ensureToken as mintToken } from "../shared/harness-runtime.mjs";

let cached: string | null = null;

/**
 * Per-machine shared secret. Hook scripts and the MCP bridge include it so
 * arbitrary local processes can't spoof session state into the daemon. Created
 * on first run with 0600 perms; the daemon and hooks both read the same file.
 *
 * The mint itself lives in `harness-runtime.mjs` because the CLI installer needs it
 * too - it bakes the token into the OTel env block before the daemon has necessarily
 * ever run - and two implementations of "make one if there isn't one" is how the two
 * end up holding different secrets. This adds only the process-lifetime cache.
 */
export function ensureToken(): string {
  cached ??= mintToken();
  return cached;
}

export function checkToken(provided: string | null | undefined): boolean {
  if (!provided) return false;
  const expected = ensureToken();
  // Constant-ish comparison; tokens are equal length hex so a simple compare
  // is acceptable for a localhost single-user tool.
  return provided.length === expected.length && provided === expected;
}
