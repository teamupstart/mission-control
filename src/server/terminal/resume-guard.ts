import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { readFileSync } from "node:fs";
import { run } from "../util/exec.ts";
import { claimResumeLease, completeResumeLease, readResumeLease, writeResumeRecord } from "./resume-lease.ts";

// A separate packaged process, deliberately independent of the daemon's exit handlers.
// No config read and no agent spawn precedes the immutable claim/revoke decision.
async function main(): Promise<number> {
  const [root, id] = process.argv.slice(2);
  if (!root || !id) throw new Error("missing resume lease");
  const lease = readResumeLease(root, id);
  const observed = await run("ps", ["-p", String(process.pid), "-o", "lstart=", "-o", "pgid="], { timeoutMs: 5_000 });
  const match = observed.code === 0 && observed.stdout.trim().match(/^(.*?)\s+(\d+)$/);
  const startMs = match ? Date.parse(match[1]!) : NaN;
  const group = match ? Number(match[2]) : NaN;
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
  const before = await groupMembers(group);
  const child = spawn(executable, input.argv.slice(1), { cwd: input.cwd, env, stdio: "inherit" });
  // No EXIT/signal trap deletes credentials. Killing this guard leaves its child protected.
  const code = await new Promise<number>((resolve) => {
    child.once("error", () => resolve(127));
    child.once("exit", (code) => resolve(code ?? 1));
  });
  const after = await groupMembers(group);
  // An unavailable inventory or any surviving new member is ambiguous, never age-expired.
  if (before && after && [...after].every((pid) => before.has(pid))) {
    completeResumeLease(lease, process.pid, startMs);
  }
  return code;
}

async function groupMembers(group: number): Promise<Set<number> | null> {
  const result = await run("ps", ["-axo", "pid=,pgid="], { timeoutMs: 5_000 });
  if (result.code !== 0 || result.outcomeUnknown || result.overflowed) return null;
  return new Set(result.stdout.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    return match && Number(match[2]) === group && Number(match[1]) !== result.childPid ? [Number(match[1])] : [];
  }));
}

try {
  if (process.argv[2] === "--check") console.log("mission-resume-guard-v1");
  else process.exitCode = await main();
} catch {
  // Config, bearer values and the agent argv must never enter a launch error.
  console.error("Mission Control refused the managed resume. Recheck its managed launch status before trying again.");
  process.exitCode = 1;
}
