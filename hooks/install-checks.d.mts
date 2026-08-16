// Types for the plain-JS installer preflights, mirroring `statusline-body.d.mts`.
//
// The module itself has to stay .mjs - it belongs to hooks/, the corner of the repo
// that runs with no build step - so the TypeScript side (the tests) gets its types
// from here.

/**
 * A durable absolute path to the running node binary: a symlinked `node` on PATH
 * that resolves to the same binary as `execPath`, else `execPath` unchanged.
 */
export function stableNodePath(execPath?: string, pathEnv?: string): string;

/** The transient pool root above `dir`, or null when `dir` is a durable checkout. */
export function transientCheckoutRoot(dir: string): { root: string; reason: string } | null;
