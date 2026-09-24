import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createConnection } from "node:net";
import { weztermEmulator as nativeWeztermEmulator } from "../../src/server/terminal/wezterm.ts";
import { stubRun } from "../../src/server/util/exec.ts";
import type { TerminalExec } from "../../src/server/terminal/exec.ts";

const read = () => {
  const path = join(process.env.MISSION_HOME!, "terminal-boundary.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
};
const exec: TerminalExec = async (_bin, args, opts) => {
  if (!args.includes("--no-auto-start") || opts?.env?.WEZTERM_UNIX_SOCKET) throw new Error("unsafe CLI environment");
  const socket = args.find((arg) => arg.startsWith("WEZTERM_UNIX_SOCKET="))?.split("=")[1] ?? read()?.socket;
  if (!socket) return stubRun({ code: 1, stdout: "", stderr: "no fixture socket" });
  return await new Promise((resolve) => {
    const client = createConnection(socket);
    let output = "";
    client.setTimeout(1000, () => client.destroy(new Error("fixture socket timeout")));
    client.once("connect", () => client.write(JSON.stringify({ args, input: opts?.input })));
    client.on("data", (data) => { output += data; });
    client.once("error", () => resolve(stubRun({ code: 1, stdout: "", stderr: "socket unavailable" })));
    client.once("end", () => resolve(stubRun({ code: 0, stdout: output,
      stderr: `TRACE wezterm_client::client > connect to Socket(${JSON.stringify(socket)})` })));
  });
};

/** Only CLI/OS observations are faked. The real adapter owns pinning and every operation. */
export function weztermEmulator(): ReturnType<typeof nativeWeztermEmulator> {
  const adapter = nativeWeztermEmulator(exec);
  adapter.bin = { env: null, candidates: [process.execPath], dropEnv: [] };
  const list = adapter.list!;
  let previous: Awaited<ReturnType<typeof list>> = null;
  // Hold the last discovery observation across the deliberately widened restart gap.
  // This never bypasses the final write boundary, which must reject that stale handle.
  adapter.list = async () => read()?.freezeDiscovery ? previous : (previous = await list());
  return adapter;
}
