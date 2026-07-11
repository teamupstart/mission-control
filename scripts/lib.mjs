// Shared, dependency-free helpers for the standalone setup scripts
// (init / new-session / worktree-setup). These run under bare `node`, so this
// stays plain JS with no build step and no imports beyond node builtins.

import { execFileSync } from "node:child_process";

/** True when `bin` is on PATH. */
export function have(bin) {
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
