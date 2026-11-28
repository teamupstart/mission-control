import { basename } from "node:path";
import { FIXED_OS_EXECUTABLES } from "../executables/catalog.ts";
import type { TerminalExec } from "./exec.ts";

/**
 * Whether a process with this executable name runs for the current user.
 *
 * `false` only when `ps` answered with a parseable list that names none, so a failed or
 * empty listing is `null` and proves nothing. Used to back up a multiplexer's own "no server
 * running" answer: a server on another socket would still be a process, and finding one keeps
 * a home whose identity cannot be checked.
 */
export async function userProcessRunning(exec: TerminalExec, name: string): Promise<boolean | null> {
  const uid = process.getuid?.();
  if (uid === undefined) return null;
  const result = await exec(FIXED_OS_EXECUTABLES.macProcessStatus, ["-A", "-o", "uid=,comm="], { timeoutMs: 10_000 });
  if (result.code !== 0 || result.outcomeUnknown || result.overflowed) return null;
  const lines = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  for (const line of lines) {
    const match = line.match(/^(\d+)\s+(.+)$/);
    if (!match) return null;
    if (Number(match[1]) !== uid) continue;
    // macOS reports the executable path, Linux the short name; tmux may retitle itself
    // `tmux: server`. The first word of the basename is the executable either way.
    if (basename(match[2]!).split(/[:\s]/)[0] === name) return true;
  }
  return false;
}
