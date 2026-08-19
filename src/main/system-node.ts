import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { loginShellPath } from "./path-env.ts";

/** Resolve a system Node binary that remains available while Electron replaces itself. */
export function findSystemNode(): string | null {
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const output = execFileSync(shell, ["-ilc", "command -v node"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, PATH: loginShellPath() },
    }).trim();
    return output && existsSync(output) ? output : null;
  } catch {
    return null;
  }
}
