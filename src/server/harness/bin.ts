import { envVar } from "@shared/harness-runtime.mjs";
import type { BinSpec } from "./types.ts";

/**
 * The env-override chain that decides which binary a harness launches.
 *
 * Extracted from `resolveAgentBin`, which still is the one function callers ask, so that a
 * module reaching for a SPEC it already holds does not have to import the registry to
 * resolve it. The Claude driver is that module: it needs the `claude` path to pin its
 * subprocess to, and `harness/index.ts` imports the driver, so asking the registry from
 * inside it would close an import cycle around the record every other harness question
 * goes through.
 *
 * One implementation, two doors. A second copy of this chain is how an override an
 * operator set stops being honoured on exactly one path - which is the defect
 * `resolveAgentBin` was written to end when `claude-cli.ts` kept a chain of its own.
 */
export function resolveBinSpec(spec: BinSpec): string {
  const chain = envVar(spec.env);
  if (chain) return chain;
  for (const name of spec.legacyEnv) {
    const legacy = process.env[name];
    if (legacy) return legacy;
  }
  return spec.command;
}
