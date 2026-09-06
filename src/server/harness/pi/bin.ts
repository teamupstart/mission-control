import type { BinSpec } from "../types.ts";
import { executableSpec } from "../../executables/catalog.ts";

/** The `pi` CLI. Bare on PATH; no legacy env name, it was only ever read through this chain. */
const declared = executableSpec("pi");
export const piBin: BinSpec = {
  env: declared.overrideEnv!,
  legacyEnv: declared.legacyEnv,
  command: declared.command,
};
