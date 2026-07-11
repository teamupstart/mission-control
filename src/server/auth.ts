import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { STATE_DIR, TOKEN_PATH } from "./config.ts";

let cached: string | null = null;

/**
 * Per-machine shared secret. Hook scripts and the MCP bridge include it so
 * arbitrary local processes can't spoof session state into the daemon. Created
 * on first run with 0600 perms; the daemon and hooks both read the same file.
 */
export function ensureToken(): string {
  if (cached) return cached;
  if (existsSync(TOKEN_PATH)) {
    cached = readFileSync(TOKEN_PATH, "utf8").trim();
    if (cached) return cached;
  }
  mkdirSync(dirname(TOKEN_PATH), { recursive: true });
  void STATE_DIR;
  cached = randomBytes(24).toString("hex");
  writeFileSync(TOKEN_PATH, cached + "\n", { mode: 0o600 });
  return cached;
}

export function checkToken(provided: string | null | undefined): boolean {
  if (!provided) return false;
  const expected = ensureToken();
  // Constant-ish comparison; tokens are equal length hex so a simple compare
  // is acceptable for a localhost single-user tool.
  return provided.length === expected.length && provided === expected;
}
