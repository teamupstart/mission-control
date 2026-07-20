import { existsSync } from "node:fs";
import type { BinSpec } from "./types.ts";

/**
 * Resolving a backend's binary, once.
 *
 * This is `resolveWeztermBin`'s body with the vendor taken out - env override, then the
 * first candidate that exists, then the bare name in the hope PATH has it. It is separate
 * from the adapters so `config.ts` can keep its own exported helper while there is exactly
 * one implementation of the rule, rather than a fifth copy landing in the same change that
 * exists to stop copies multiplying.
 *
 * Not cached: an operator installing wezterm, or exporting `WEZTERM_BIN`, should not have
 * to restart the daemon, and the cost is an `existsSync` on a path that is almost always
 * the first hit.
 */
export function resolveBin(spec: BinSpec): string {
  const override = spec.env ? process.env[spec.env] : undefined;
  if (override) return override;
  for (const c of spec.candidates) {
    // The bare name (no separator) cannot be tested with existsSync - it is resolved by
    // the OS against PATH at spawn time, which is what makes it the fallback.
    if (!c.includes("/")) continue;
    if (existsSync(c)) return c;
  }
  return spec.candidates[spec.candidates.length - 1] ?? "";
}

/**
 * The specs live here, and not beside their adapters, for one reason: `config.ts` still
 * exports `resolveWeztermBin` for the call sites the migration has not reached, and this
 * module is the only home it can read the spec from without an import cycle
 * (`discovery/wezterm.ts` imports `config.ts`). One list of candidates, one resolver.
 */

/** `TMUX_BIN` is deliberately absent: tmux has no such convention, so nothing invents one. */
export const TMUX_BIN: BinSpec = { env: null, candidates: ["tmux"] };

export const WEZTERM_BIN: BinSpec = {
  env: "WEZTERM_BIN",
  candidates: ["/Applications/WezTerm.app/Contents/MacOS/wezterm", "wezterm"],
};
