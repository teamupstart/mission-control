import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { readFileSync } from "node:fs";
import { run } from "../util/exec.ts";
import { claimResumeLease, completeResumeLease, readResumeLease, writeResumeRecord } from "./resume-lease.ts";
import { parseResumeProcesses, resumeDescendantsExited } from "./resume-processes.ts";

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
  for (const key of ["FLEET_HOME", "HARNESS_HOME", "MISSION_SESSION_ID", "FLEET_SESSION_ID", "HARNESS_SESSION_ID",
    "MISSION_AGENT_SESSION_ID", "MISSION_API_TOKEN", "MISSION_SCOUT_SUBMISSION_CREDENTIAL"])
    delete env[key];
  Object.assign(env, input.env);
  writeResumeRecord(join(lease.home, "terminal-launch.json"), { pid: process.pid, startMs });
  const before = await processInventory();
  // The terminal signals the foreground group, including both guard and agent. Stay alive
  // to observe child exit; the spawned agent keeps its default signal handling. A signal
  // never authorizes cleanup by itself, and SIGKILL still leaves the environment protected.
  const terminalSignals = ["SIGHUP", "SIGINT", "SIGQUIT"] as const;
  const stayAlive = () => {};
  for (const signal of terminalSignals) process.on(signal, stayAlive);
  try {
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

try {
  if (process.argv[2] === "--check") console.log("mission-resume-guard-v1");
  else process.exitCode = await main();
} catch {
  // Config, bearer values and the agent argv must never enter a launch error.
  console.error("Mission Control refused the managed resume. Recheck its managed launch status before trying again.");
  process.exitCode = 1;
}
