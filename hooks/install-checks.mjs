// Preflights for the hook installer: will the paths it bakes outlive the install?
//
// The installer writes ABSOLUTE paths into the user's global Claude settings - a node
// binary and this checkout's harness-hook.mjs - and Claude Code then runs that command
// on every hook event of every session on the machine. Any baked path that later stops
// existing turns into a MODULE_NOT_FOUND on every prompt, everywhere, with nothing
// pointing back at the install that planted it. Both checks here exist because that
// outage happened, from the same install, in two ways at once:
//
//   - the install ran from a transient pooled checkout, whose allocator later
//     reclaimed out from under the settings file;
//   - it baked `process.execPath`, which resolves symlinks - under Homebrew that is
//     /opt/homebrew/Cellar/node/<version>/bin/node, a directory the next
//     `brew upgrade node` deletes, priming the identical failure again.
//
// Plain .mjs with node:-only imports, like its hooks/ siblings: this corner of the
// repo stays runnable with no build step, and the TypeScript side (the tests) reads
// its types from install-checks.d.mts.

import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

/** realpath that answers null for a path that does not resolve, instead of throwing. */
function safeRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * A durable absolute path to the running node binary.
 *
 * Prefers a symlinked `node` on PATH that resolves to the same binary as `execPath` -
 * an alias like /opt/homebrew/bin/node, which package managers repoint on upgrade
 * while the versioned directory it points into is removed. The alias test is
 * `candidate !== realpath(candidate)`: a plain versioned install (nvm's bin dir, or
 * the Cellar dir npm prepends to PATH) is its own realpath and is never chosen over
 * `execPath`, because it is no more durable. A `node` on PATH that is NOT the running
 * binary (a different install, a version-manager shim) is never chosen at all: the
 * hook script's requirements are known for the runtime that ran the installer, not
 * for whatever else the machine has lying around.
 *
 * Falls back to `execPath` unchanged when nothing better is on PATH.
 */
export function stableNodePath(execPath = process.execPath, pathEnv = process.env.PATH ?? "") {
  const real = safeRealpath(execPath);
  if (!real) return execPath;
  for (const dir of pathEnv.split(delimiter)) {
    // A relative PATH entry would realpath against cwd and read as an alias by
    // accident; nothing durable lives on a relative path anyway.
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, "node");
    const candidateReal = safeRealpath(candidate);
    if (candidateReal === real && candidate !== candidateReal) return candidate;
  }
  return execPath;
}

const TRANSIENT_MARKERS = [
  [".mission-control-worktree-pool", "native Mission Control worktree pool"],
  ["treehouse-state.json", "legacy Treehouse worktree pool"],
];

/**
 * The transient pool root above `dir`, or null when `dir` is a durable checkout.
 *
 * Walks the path as given rather than its realpath: the caller passes the path the
 * running script was actually reached by, which is the one that would get baked.
 */
export function transientCheckoutRoot(dir) {
  let current = dir;
  for (;;) {
    for (const [marker, reason] of TRANSIENT_MARKERS) {
      if (existsSync(join(current, marker))) return { root: current, reason };
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
