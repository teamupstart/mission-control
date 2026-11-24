import { createConnection } from "node:net";
import type { TerminalEnvironmentPatch } from "./environment-handoff.ts";
import { spawn, spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join } from "node:path";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { WORK_UNIT_ENV_VAR } from "@shared/work-unit.ts";
import { FIXED_OS_EXECUTABLES } from "../executables/catalog.ts";
import { probePadding } from "./shell.ts";
import { run } from "../util/exec.ts";
import { claimResumeLease, completeResumeLease, readResumeEnvironmentSocket, readResumeLease, writeResumeRecord } from "./resume-lease.ts";
import { parseResumeProcesses, resumeDescendantsExited } from "./resume-processes.ts";

const handoffTicket = process.env.MISSION_TERMINAL_HANDOFF_TICKET;
delete process.env.MISSION_TERMINAL_HANDOFF_TICKET;
const inventoryOptions = { timeoutMs: 5_000, env: { ...process.env, LC_ALL: "C", LANG: "C" } };

// A separate packaged process, deliberately independent of the daemon's exit handlers.
// No config read and no agent spawn precedes the immutable claim/revoke decision.
async function main(): Promise<number> {
  const [root, id] = process.argv.slice(2);
  if (!root || !id) throw new Error("missing resume lease");
  const lease = readResumeLease(root, id);
  const observed = await run("ps", ["-p", String(process.pid), "-o", "lstart="], inventoryOptions);
  const startMs = observed.code === 0 && !observed.outcomeUnknown && !observed.overflowed ? Date.parse(observed.stdout.trim()) : NaN;
  if (!Number.isFinite(startMs) || !claimResumeLease(lease, process.pid, startMs)) {
    throw new Error("resume lease unavailable, expired, or already claimed");
  }
  const input = JSON.parse(readFileSync(join(lease.home, "launch.json"), "utf8")) as {
    argv: string[]; env: Record<string, string>; cwd: string;
  };
  const executable = input.argv[0];
  if (!executable || !isAbsolute(executable) || !isAbsolute(input.cwd)) throw new Error("invalid prepared resume command");
  // Actual pane variables come from this terminal. Explicit daemon/session identities do not.
  const env = { ...process.env };
  // The work unit too: the pane's terminal server may hold another unit's id, and the resume's
  // own decision, when it carries one, is in the prepared environment applied next.
  for (const key of ["FLEET_HOME", "HARNESS_HOME", "MISSION_SESSION_ID", "FLEET_SESSION_ID", "HARNESS_SESSION_ID",
    "MISSION_AGENT_SESSION_ID", "MISSION_API_TOKEN", "MISSION_SCOUT_SUBMISSION_CREDENTIAL", WORK_UNIT_ENV_VAR])
    delete env[key];
  writeResumeRecord(join(lease.home, "terminal-launch.json"), { pid: process.pid, startMs });
  const before = await processInventory();
  // The terminal signals the foreground group, including both guard and agent. Stay alive
  // to observe child exit; the spawned agent keeps its default signal handling. A signal
  // never authorizes cleanup by itself, and SIGKILL still leaves the environment protected.
  const terminalSignals = ["SIGHUP", "SIGINT", "SIGQUIT"] as const;
  const stayAlive = () => {};
  for (const signal of terminalSignals) process.on(signal, stayAlive);
  try {
    const socketPath = readResumeEnvironmentSocket(lease);
    if (socketPath && !await applyEnvironmentPatch(socketPath, env)) {
      // We own the claim and have not spawned an agent or any agent descendants.
      completeResumeLease(lease, process.pid, startMs);
      return 1;
    }
    // The prepared isolation and launch identities remain authoritative for the child.
    Object.assign(env, input.env);
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(executable, input.argv.slice(1), { cwd: input.cwd, env, stdio: "inherit" });
    const code = await new Promise<number>((resolve) => {
      child.once("error", () => resolve(127));
      child.once("exit", (code) => resolve(code ?? 1));
    });
    const after = await processInventory();
    // Detached children can leave the process group and double-forked children lose their
    // original parent. Unavailable inventory or ambiguous ancestry cannot authorize deletion.
    if (resumeDescendantsExited(before, after, { pid: process.pid, startMs })) {
      completeResumeLease(lease, process.pid, startMs);
    }
    return code;
  } finally {
    for (const signal of terminalSignals) process.off(signal, stayAlive);
  }
}

async function processInventory() {
  const result = await run("ps", ["-axo", "pid=,ppid=,lstart="], inventoryOptions);
  if (result.code !== 0 || result.outcomeUnknown || result.overflowed) return null;
  return parseResumeProcesses(result.stdout, result.childPid);
}

async function readEnvironmentPatch(path: string): Promise<TerminalEnvironmentPatch> {
  if (!handoffTicket || !/^[a-f0-9]{64}$/.test(handoffTicket)) throw new Error("Missing launch ticket");
  const cwd = process.cwd();
  const directory = dirname(path);
  process.chdir(directory);
  try {
    // Connect relative to the directory we checked. A late pane must not follow a
    // replacement in shared /tmp after the original private directory was removed.
    const stat = statSync(".");
    if (process.cwd() !== directory || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) {
      throw new Error("Unavailable environment handoff");
    }
    const socket = createConnection(basename(path));
    socket.write(Buffer.from(handoffTicket, "hex"));
    socket.setTimeout(5_000, () => socket.destroy(new Error("Environment handoff timed out")));
    socket.setEncoding("utf8");
    let payload = "";
    for await (const chunk of socket) payload += chunk;
    return JSON.parse(payload);
  } finally {
    process.chdir(cwd);
  }
}

async function applyEnvironmentPatch(socketPath: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    const patch = await readEnvironmentPatch(socketPath);
    Object.assign(env, patch.set);
    for (const name of patch.unset) delete env[name];
  } catch {
    console.error("Mission Control could not read the terminal environment handoff. It expired or is unavailable. Start a new launch.");
    return false;
  }
  return true;
}

/** Apply the patch only on the exec that replaces the reader with the final agent. */
async function execWithAgentEnvironment(): Promise<void> {
  const [socketPath, ...command] = process.argv.slice(3);
  if (!socketPath || !process.execve) throw new Error("Unavailable environment handoff");
  const env = { ...process.env };
  if (!await applyEnvironmentPatch(socketPath, env)) {
    process.exitCode = 1;
    return;
  }
  delete env.ELECTRON_RUN_AS_NODE;
  const dispatch = process.argv[2] === "--dispatch-agent"
    ? JSON.parse(readFileSync(command[0]!, "utf8")) as { argv: string[]; fallbackArgv: string[] | null; outcomePath: string }
    : null;
  let argv: readonly string[] = dispatch?.argv ?? command;
  if (dispatch?.fallbackArgv) {
    // argv and env share execve's byte and pointer budget. Charge each final environment
    // entry as one inert argument, so the probe runs with neither credentials nor loader overrides.
    const envPadding = Object.entries(env).map(([key, value]) => "x".repeat(Buffer.byteLength(key) + 1 + Buffer.byteLength(value!)));
    const executable = FIXED_OS_EXECUTABLES.sh;
    const fits = spawnSync(executable, ["-c", ":", "mission-turn-one-probe", probePadding(argv[0]!), ...argv, ...envPadding],
      { env: {}, stdio: "ignore" }).status === 0;
    if (!fits) argv = dispatch.fallbackArgv;
    writeFileSync(dispatch.outcomePath, fits ? "shaped" : "original", { mode: 0o600 });
  }
  if (!argv[0]) throw new Error("Missing agent command");
  try {
    return process.execve(argv[0], [...argv], env);
  } catch (error) {
    // The original dispatch shell runs executable text without a shebang as a shell
    // program. Only ENOEXEC selects that interpreter; retain normal permission errors.
    if (!dispatch || (error as NodeJS.ErrnoException).code !== "ENOEXEC") throw error;
    const shell = FIXED_OS_EXECUTABLES.sh;
    return process.execve(shell, [shell, ...argv], env);
  }
}

const dispatchReader = process.argv[2] === "--with-agent-environment" || process.argv[2] === "--dispatch-agent";
try {
  if (dispatchReader) await execWithAgentEnvironment();
  else if (process.argv[2] === "--check") console.log("mission-resume-guard-v1");
  else process.exitCode = await main();
} catch {
  // Config, bearer values and the agent argv must never enter a launch error.
  console.error(dispatchReader
    ? "Mission Control could not execute the terminal launch command."
    : "Mission Control refused the managed resume. Recheck its managed launch status before trying again.");
  process.exitCode = 1;
}
