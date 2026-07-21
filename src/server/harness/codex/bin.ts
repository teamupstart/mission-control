import type { BinSpec } from "../types.ts";

/** The `codex` CLI. No legacy name - it was only ever read through the current chain. */
export const codexBin: BinSpec = {
  env: "CODEX_BIN",
  legacyEnv: [],
  command: "codex",
};
