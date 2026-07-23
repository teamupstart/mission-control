import type { BinSpec } from "../types.ts";

/** The `pi` CLI. Bare on PATH; no legacy env name, it was only ever read through this chain. */
export const piBin: BinSpec = {
  env: "PI_BIN",
  legacyEnv: [],
  command: "pi",
};
