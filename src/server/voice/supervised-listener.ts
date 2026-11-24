import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { FIXED_OS_EXECUTABLES } from "../executables/catalog.ts";
import { playerScratchDirectory, removePlayerScratch, retirementDirectory } from "./recovery-files.ts";

export function voiceProcessGone(pid: number) {
  try {
    process.kill(pid, 0);
    if (process.platform !== "linux") return false;
    // A dead namespace init can await reaping by a different parent after monitor loss.
    const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Bubblewrap writes its namespace init's host PID to --info-fd and closes it before the gate runs. */
export async function sandboxLifetime(monitor: ChildProcess, info?: Readable) {
  let pid = monitor.pid!;
  if (info) {
    const json = await text(info);
    const sandboxPid: unknown = json && JSON.parse(json)["child-pid"];
    if (typeof sandboxPid !== "number" || !Number.isSafeInteger(sandboxPid) || sandboxPid < 2 || sandboxPid === pid) {
      throw new Error("Bubblewrap did not provide the sandbox PID.");
    }
    pid = sandboxPid;
  }
  const monitorRunning = () => monitor.exitCode === null && monitor.signalCode === null;
  const running = info ? () => !voiceProcessGone(pid) : monitorRunning;
  const exited = new Promise<void>(resolve => {
    const check = () => {
      if (running()) setTimeout(check, 250).unref();
      else resolve();
    };
    if (monitorRunning()) monitor.once("exit", check);
    else check();
  });
  return { pid, running, exited };
}

// The launcher announces the launch before calling spawn. Only ordinary listener
// credentials and standard streams cross this boundary. The signer stays in the parent.
export function confinedVoiceListener(stateHome: string, instance: string) {
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("No protected voice listener launch is available.");
  const home = realpathSync(stateHome);
  const voice = join(home, "voice");
  const retirements = retirementDirectory(home);
  const models = join(voice, "models");
  mkdirSync(voice, { recursive: true, mode: 0o700 });
  mkdirSync(retirements, { recursive: true, mode: 0o700 });
  const validateDirectories = () => {
    const modelEntry = lstatSync(models, { throwIfNoEntry: false });
    if (!lstatSync(voice).isDirectory() || !lstatSync(retirements).isDirectory() || (modelEntry && !modelEntry.isDirectory())) {
      throw new Error("Voice recovery and model directories must be real directories for a confined launch.");
    }
  };
  validateDirectories();
  return async (executable: string, args: string[], env: NodeJS.ProcessEnv) => {
    // The announcement is asynchronous. Check again before the kernel applies the policy.
    validateDirectories();
    const scratch = playerScratchDirectory(home, instance);
    mkdirSync(scratch, { mode: 0o700 });
    // The fixed startup gate must run unmodified before the requested executable.
    const listenerEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !/^(LD_|DYLD_)/u.test(name)));
    const options = { env: { ...listenerEnv, TMPDIR: scratch, TMP: scratch, TEMP: scratch, MISSION_VOICE_LISTENER_INSTANCE: instance }, stdio: "pipe" as const };
    const cleanup = () => { void removePlayerScratch(home, instance).catch(() => {}); };
    try {
      const macOS = process.platform === "darwin";
      const command = macOS ? FIXED_OS_EXECUTABLES.sandboxExec : FIXED_OS_EXECUTABLES.bubblewrap;
      const policy = macOS ? macPolicy(voice, models, retirements, scratch) : linuxPolicy(voice, models, retirements, scratch);
      // The shell builtin reads one release line from the parent. exec preserves the process
      // identity and the remaining listener stdin. EOF means the supervisor died before release.
      const gate = 'IFS= read -r ready && [ "$ready" = go ] || exit 1\nexec "$@"';
      const argv = [...policy, FIXED_OS_EXECUTABLES.sh, "-p", "-c", gate, "voice-launch", executable, ...args];
      const child = macOS ? spawn(command, argv, options) :
        spawn(command, argv, { ...options, stdio: ["pipe", "pipe", "pipe", "pipe"] });
      await once(child, "spawn");
      try {
        const lifetime = await sandboxLifetime(child, macOS ? undefined : child.stdio[3] as Readable);
        void lifetime.exited.then(cleanup);
        return { child, lifetime };
      } catch (error) {
        child.stdin.destroy(); // No release was sent to the startup gate.
        throw error;
      }
    } catch (error) {
      cleanup();
      throw error;
    }
  };
}

function macPolicy(voice: string, models: string, retirements: string, scratch: string) {
  const profile = [
    "(version 1)", "(allow default)", "(deny file-write*)",
    '(allow file-write* (subpath (param "SCRATCH")))',
    '(deny file-read* (subpath (param "VOICE")))',
    '(deny file-read* (subpath (param "RETIREMENTS")))',
    '(allow file-read* (subpath (param "SCRATCH")))',
    '(allow file-read* (subpath (param "MODELS")))',
    // Both macOS playback engines run in the listener. Its confirmed exit must
    // establish that no descendant can still own playback.
    "(deny process-fork)", "(deny mach-priv-task-port)", "(deny signal (target others))",
  ].join("\n");
  return ["-D", "VOICE=" + voice, "-D", "MODELS=" + models, "-D", "RETIREMENTS=" + retirements, "-D", "SCRATCH=" + scratch, "-p", profile];
}

function linuxPolicy(voice: string, models: string, retirements: string, scratch: string) {
  // Keep loopback for the daemon. Hide other processes and the speech records,
  // and mount the host filesystem read-only except for this player's scratch.
  const policy = ["--unshare-all", "--share-net", "--new-session", "--info-fd", "3", "--cap-drop", "ALL",
    "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--tmpfs", voice];
  if (existsSync(models)) policy.push("--ro-bind", models, models);
  return [...policy, "--remount-ro", voice, "--tmpfs", retirements, "--bind", scratch, scratch, "--remount-ro", retirements, "--"];
}
