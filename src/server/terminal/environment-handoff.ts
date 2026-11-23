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

const pendingHandoffs = new Set<() => Promise<void>>();
let stopping = false;

export async function stopTerminalEnvironmentHandoffs(): Promise<void> {
  stopping = true;
  await Promise.all([...pendingHandoffs].map((dispose) => dispose()));
}

/**
 * Pane APIs carry argv, and may record it. Send the launch environment over a one-use
 * Unix socket instead. Its parent is private to the daemon user and deliberately short
 * enough for sockaddr_un even when a managed resume's state-home path is long.
 */
export async function openTerminalEnvironmentHandoff(
  launch: { cwd: string; stateHome: string }, named: NamedAgentEnvironment, onUnused?: () => void,
) {
  if (stopping) throw new Error("Terminal environment handoffs are stopping.");
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
  let disposed = false;
  let used = false;
  const closed = new Promise<void>((resolve) => {
    server.once("close", () => {
      removeDirectory();
      pendingHandoffs.delete(dispose);
      resolve();
    });
  });
  const dispose = () => {
    if (!disposed) {
      disposed = true;
      clearTimeout(timer);
      server.close();
      if (!used && onUnused) {
        try { onUnused(); } catch { console.warn("Could not release the unused terminal launch state home."); }
      }
    }
    return closed;
  };
  // Listening on a Unix pathname binds it before listen returns. Track the handoff before
  // yielding so shutdown also drains listeners whose startup callback is still queued.
  const timer = setTimeout(dispose, RESUME_START_MS).unref();
  server.on("connection", (socket) => {
    if (disposed) { socket.destroy(); return; }
    used = true;
    void dispose();
    socket.on("error", () => socket.destroy());
    socket.setTimeout(5_000, () => socket.destroy());
    socket.end(JSON.stringify(patch));
  });
  try {
    const listening = new Promise<void>((resolve, reject) => {
      const closedBeforeListening = () => reject(new Error("Terminal environment handoff closed before launch."));
      server.once("close", closedBeforeListening);
      server.once("error", reject);
      server.listen(path, () => {
        server.off("close", closedBeforeListening);
        resolve();
      });
    });
    pendingHandoffs.add(dispose);
    await listening;
    if (disposed) throw new Error("Terminal environment handoff closed before launch.");
  } catch (error) {
    await dispose();
    throw error;
  }
  server.unref();
  return { path, dispose };
}

/** A fresh dispatch runs its existing shell wrapper under the selected environment. */
export async function terminalEnvironmentArgv(
  argv: string[], launch: { cwd: string; stateHome: string }, named?: NamedAgentEnvironment, onUnused?: () => void,
) {
  if (!named) return { argv, dispose() {} };
  const { path, dispose } = await openTerminalEnvironmentHandoff(launch, named, onUnused);
  const runtime = resolveOwnedRuntime({ executable: process.execPath, kind: process.versions.electron ? "electron" : "node" });
  return { argv: ["/usr/bin/env", ...Object.entries(runtime.env).map(([k, v]) => `${k}=${v}`),
    runtime.command, resumeGuardPath(), "--with-agent-environment", path, ...argv], dispose };
}
