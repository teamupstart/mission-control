import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { itermEmulator as nativeItermEmulator } from "../../src/server/terminal/iterm.ts";
import { stubRun } from "../../src/server/util/exec.ts";
import type { TerminalExec } from "../../src/server/terminal/exec.ts";

/** The session id a launched iTerm2 command would write back through its spawn marker. */
export const ITERM_BOUNDARY_SESSION = "w0t0p0:E2E-ITERM-SESSION";

export interface ItermBoundaryCall {
  bin: string;
  args: string[];
  /** The AppleScript the real adapter handed to `osascript`. */
  script: string;
}

/**
 * The real iTerm2 adapter with only its Apple Events replaced.
 *
 * Every script the production adapter builds - the `create window ... command` a launch
 * sends, and the retitle that follows it - is appended to `iterm-osascript.jsonl` in the
 * record dir instead of reaching iTerm2. The spawn marker reports a fixed session id, which
 * is what iTerm2's launched shell would have written, so a launch completes the way it does
 * on a Mac with iTerm2 open. Nothing here opens a window.
 */
export function itermBoundaryEmulator(): ReturnType<typeof nativeItermEmulator> {
  const exec: TerminalExec = async (bin, args, opts) => {
    const call: ItermBoundaryCall = { bin, args: [...args], script: opts?.input ?? "" };
    appendFileSync(join(process.env.MC_E2E_RECORD_DIR!, "iterm-osascript.jsonl"), `${JSON.stringify(call)}\n`);
    return stubRun({ code: 0, stdout: "", stderr: "" });
  };
  const adapter = nativeItermEmulator(exec, () => ({
    path: join(process.env.MISSION_HOME!, "iterm-spawn-marker"),
    read: () => ITERM_BOUNDARY_SESSION,
    cleanup: () => {},
  }));
  adapter.bin = { env: null, candidates: [process.execPath], dropEnv: [] };
  return adapter;
}
