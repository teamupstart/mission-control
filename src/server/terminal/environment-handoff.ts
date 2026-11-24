import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { agentSubprocessEnv, dropTerminalIdentityEnv } from "../agent-subprocess-env.ts";
import type { NamedAgentEnvironment } from "../executables/named-variable.ts";
import { stateDir } from "../../shared/harness-runtime.mjs";
import { resolveOwnedRuntime } from "../../shared/owned-runtime.mjs";
import { resumeGuardPath } from "../resume-guard-path.ts";
import { turnOneOutcomePath } from "./launch-process.ts";
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

const SOCKET_NAME = "env.sock";

function handoffDirectoryPrefix(home: string): string {
  // A short scope keeps even long state-home paths within sockaddr_un. Canonicalize
  // an existing home so a launch and a restart through its symlink share the scope.
  let canonical = resolve(home);
  try { canonical = realpathSync(home); } catch { /* A fixture home may not exist yet. */ }
  return `mission-agent-env-${createHash("sha256").update(canonical).digest("hex").slice(0, 20)}-`;
}

/** Run after the daemon acquires its state home. Never recurse into an unrecognized entry. */
export function reconcileTerminalEnvironmentHandoffs(ownedStateHome: string): void {
  const prefix = handoffDirectoryPrefix(ownedStateHome);
  const uid = process.getuid?.();
  if (uid === undefined) return;
  let entries;
  try { entries = readdirSync("/tmp", { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const owner = /^([1-9]\d{0,9})-[a-zA-Z0-9]{6}$/.exec(entry.name.slice(prefix.length));
    if (!owner) continue;
    try { process.kill(Number(owner[1]), 0); continue; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
    }
    const directory = join("/tmp", entry.name);
    try {
      const info = lstatSync(directory);
      if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o777) !== 0o700) continue;
      const children = readdirSync(directory);
      if (children.length) {
        if (children.length !== 1 || children[0] !== SOCKET_NAME) continue;
        const path = join(directory, SOCKET_NAME);
        const socket = lstatSync(path);
        if (!socket.isSocket() || socket.uid !== uid) continue;
        unlinkSync(path);
      }
      rmdirSync(directory);
    } catch { /* A concurrent cleanup or an unreadable entry does not block startup. */ }
  }
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
  launch: { cwd: string; stateHome: string }, named: NamedAgentEnvironment,
) {
  if (stopping) throw new Error("Terminal environment handoffs are stopping.");
  const patch = terminalEnvironmentPatch(launch, named);
  // mkdtemp exclusively creates a 0700 directory for this launch, even in shared /tmp.
  const directory = realpathSync(mkdtempSync(join("/tmp", `${handoffDirectoryPrefix(stateDir())}${process.pid}-`)));
  const path = join(directory, SOCKET_NAME);
  // Independent of the enumerable socket path. Only the terminal launch receives the ticket.
  const ticket = randomBytes(32);
  const readers = new Set<Socket>();
  const removeDirectory = () => {
    try { rmdirSync(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("Could not remove the terminal environment handoff directory.");
    }
  };
  const server = createServer();
  let disposed = false;
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
      for (const reader of readers) reader.destroy();
      server.close();
    }
    return closed;
  };
  // Listening on a Unix pathname binds it before listen returns. Track the handoff before
  // yielding so shutdown also drains listeners whose startup callback is still queued.
  const timer = setTimeout(dispose, RESUME_START_MS).unref();
  server.on("connection", (socket) => {
    if (disposed) { socket.destroy(); return; }
    readers.add(socket);
    socket.once("close", () => readers.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setTimeout(5_000, () => socket.destroy());
    socket.on("readable", () => {
      const presented: Buffer | null = socket.read(ticket.length);
      if (!presented) return;
      if (disposed || presented.length !== ticket.length || !timingSafeEqual(presented, ticket)) {
        socket.destroy();
        return;
      }
      readers.delete(socket);
      void dispose();
      socket.end(JSON.stringify(patch));
    });
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
  const authorize = (argv: string[]) => ["/usr/bin/env", `MISSION_TERMINAL_HANDOFF_TICKET=${ticket.toString("hex")}`, ...argv];
  return { path, authorize, dispose };
}

/** Put the one-use reader at the final agent command. The owning shell retains its own environment. */
export async function terminalEnvironmentArgv(
  argv: string[], launch: { cwd: string; stateHome: string }, named: NamedAgentEnvironment,
  dispatch?: { wrap: (reader: string[]) => string[]; fallbackArgv: readonly string[] | null },
) {
  const runtime = resolveOwnedRuntime({ executable: process.execPath, kind: process.versions.electron ? "electron" : "node" });
  const guard = resumeGuardPath();
  const { path, authorize, dispose } = await openTerminalEnvironmentHandoff(launch, named);
  try {
    const reader = ["/usr/bin/env", ...Object.entries(runtime.env).map(([k, v]) => `${k}=${v}`),
      runtime.command, guard];
    if (!dispatch) return { argv: authorize([...reader, "--with-agent-environment", path, ...argv]), dispose };
    const manifest = join(launch.stateHome, "launch.json");
    writeFileSync(manifest, JSON.stringify({ argv, fallbackArgv: dispatch.fallbackArgv,
      outcomePath: turnOneOutcomePath(launch.stateHome) }), { flag: "wx", mode: 0o600 });
    const wrapper = dispatch.wrap([...reader, "--dispatch-agent", path, manifest]);
    // On expiry the daemon may already have removed the wrapper. Keep the diagnostic
    // available in the pane, even when the reader inside that wrapper can no longer run.
    const start = 'if [ -S "$1" ]; then shift; exec "$@"; fi; echo "Mission Control could not read the terminal environment handoff. It expired or is unavailable. Start a new launch." >&2; exit 1';
    return { argv: authorize(["/bin/sh", "-c", start, "mission-dispatch", path, ...wrapper]), dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
