import type { BinSpec } from "../types.ts";

/**
 * The `claude` CLI.
 *
 * `FOREMAN_CLAUDE_BIN` is the legacy name, and the reason `BinSpec` has a raw-key slot at
 * all: it predates both this app's `MISSION_`/`FLEET_`/`HARNESS_` chain and the move of
 * headless runs out of `foreman/`, so it cannot be spelled as a suffix. It was read by
 * `claude-cli.ts` alone, which is exactly the split this spec closes - it now resolves for
 * a dispatched session too, matching what the README has always said it aliases.
 */
export const claudeBin: BinSpec = {
  env: "CLAUDE_BIN",
  legacyEnv: ["FOREMAN_CLAUDE_BIN"],
  command: "claude",
};
