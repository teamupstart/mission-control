import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { agentSubprocessEnv, dropTerminalIdentityEnv } from "../agent-subprocess-env.ts";
import type { NamedAgentEnvironment } from "../executables/named-variable.ts";
import { resolveOwnedRuntime } from "../../shared/owned-runtime.mjs";
import { resumeGuardPath } from "../resume-guard-path.ts";
import { RESUME_START_MS } from "./resume-lease.ts";

/** Only selected, isolated overrides cross the socket. The wrapper owns its state and loopback credentials. */
export interface TerminalEnvironmentPatch {
  set: Record<string, string>;
  unset: string[];
}

function terminalEnvironmentPatch(launch: { cwd: string; stateHome: string }, named: NamedAgentEnvironment): TerminalEnvironmentPatch {
  const isolated = agentSubprocessEnv({}, { cwd: launch.cwd, stateHome: launch.stateHome, loopbackAccess: true, extraEnv: named.extraEnv });
  const patch: TerminalEnvironmentPatch = { set: {}, unset: [...named.missing] };
  for (const [name, value] of Object.entries(named.extraEnv)) {
    if (Object.hasOwn(isolated, name) && isolated[name] === value) patch.set[name] = isolated[name];
    else patch.unset.push(name);
  }
  // Keep the real pane's identity when it differs from the daemon's or a shell export.
  dropTerminalIdentityEnv(patch.set);
  return patch;
}

/**
 * Pane APIs carry argv, and may record it. Send the launch environment over a one-use
 * Unix socket instead. Its parent is private to the daemon user and deliberately short
 * enough for sockaddr_un even when a managed resume's state-home path is long.
 */
export async function terminalEnvironmentArgv(argv: string[], launch: { cwd: string; stateHome: string }, named?: NamedAgentEnvironment) {
  if (!named) return { argv, dispose() {} };
  const patch = terminalEnvironmentPatch(launch, named);
  // mkdtemp exclusively creates a 0700 directory for this launch, even in shared /tmp.
  const directory = realpathSync(mkdtempSync("/tmp/mission-agent-env-"));
  const path = join(directory, randomUUID());
  const removeDirectory = () => {
    try { rmdirSync(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("Could not remove the terminal environment handoff directory.");
    }
  };
  const server = createServer();
  let used = false;
  const dispose = () => {
    clearTimeout(timer);
    if (server.listening) server.close();
  };
  // A delayed pane has the same start window as the managed resume lease.
  const timer = setTimeout(dispose, RESUME_START_MS).unref();
  server.on("connection", (socket) => {
    if (used) { socket.destroy(); return; }
    used = true;
    dispose();
    socket.on("error", () => socket.destroy());
    socket.setTimeout(5_000, () => socket.destroy());
    socket.end(JSON.stringify(patch));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
  } catch (error) {
    dispose();
    removeDirectory();
    throw error;
  }
  server.once("close", removeDirectory);
  server.unref();
  const runtime = resolveOwnedRuntime({ executable: process.execPath, kind: process.versions.electron ? "electron" : "node" });
  return { argv: ["/usr/bin/env", ...Object.entries(runtime.env).map(([k, v]) => `${k}=${v}`),
    runtime.command, resumeGuardPath(), "--with-agent-environment", path, ...argv], dispose };
}
