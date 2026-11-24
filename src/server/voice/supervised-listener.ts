import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { FIXED_OS_EXECUTABLES } from "../executables/catalog.ts";
import { playerScratchDirectory, removePlayerScratch, retirementDirectory } from "./recovery-files.ts";

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
  return (executable: string, args: string[], env: NodeJS.ProcessEnv) => {
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
      const child = spawn(command, [...policy, FIXED_OS_EXECUTABLES.sh, "-p", "-c", gate, "voice-launch", executable, ...args], options);
      child.once("close", cleanup);
      return child;
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
  const policy = ["--unshare-all", "--share-net", "--new-session", "--cap-drop", "ALL",
    "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--tmpfs", voice];
  if (existsSync(models)) policy.push("--ro-bind", models, models);
  return [...policy, "--remount-ro", voice, "--tmpfs", retirements, "--bind", scratch, scratch, "--remount-ro", retirements, "--"];
}
