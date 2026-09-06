import type { BinSpec } from "../types.ts";
import { executableSpec } from "../../executables/catalog.ts";

/** The `codex` CLI. No legacy name - it was only ever read through the current chain. */
const declared = executableSpec("codex");
export const codexBin: BinSpec = {
  env: declared.overrideEnv!,
  legacyEnv: declared.legacyEnv,
  command: declared.command,
};
