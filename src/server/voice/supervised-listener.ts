import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXED_OS_EXECUTABLES } from "../executables/catalog.ts";

// The launcher announces the launch before calling spawn. Only ordinary listener
// credentials and standard streams cross this boundary. The signer stays in the parent.
export function confinedVoiceListener(stateHome: string, instance: string) {
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("No protected voice listener launch is available.");
  const voice = join(realpathSync(stateHome), "voice");
  const models = join(voice, "models");
  mkdirSync(voice, { recursive: true, mode: 0o700 });
  const validateDirectories = () => {
    const modelEntry = lstatSync(models, { throwIfNoEntry: false });
    if (!lstatSync(voice).isDirectory() || (modelEntry && !modelEntry.isDirectory())) {
      throw new Error("Voice recovery and model directories must be real directories for a confined launch.");
    }
  };
  validateDirectories();
  return (executable: string, args: string[], env: NodeJS.ProcessEnv) => {
    // The announcement is asynchronous. Check again before the kernel applies the policy.
    validateDirectories();
    const scratch = mkdtempSync(join(realpathSync(tmpdir()), "mission-voice-player-"));
    const options = { env: { ...env, TMPDIR: scratch, TMP: scratch, TEMP: scratch, MISSION_VOICE_LISTENER_INSTANCE: instance }, stdio: "pipe" as const };
    const cleanup = () => { void rm(scratch, { recursive: true, force: true }).catch(() => {}); };
    try {
      const macOS = process.platform === "darwin";
      const command = macOS ? FIXED_OS_EXECUTABLES.sandboxExec : FIXED_OS_EXECUTABLES.bubblewrap;
      const policy = macOS ? macPolicy(voice, models, scratch) : linuxPolicy(voice, models, scratch);
      const child = spawn(command, [...policy, executable, ...args], options);
      child.once("close", cleanup);
      return child;
    } catch (error) {
      cleanup();
      throw error;
    }
  };
}

function macPolicy(voice: string, models: string, scratch: string) {
  const profile = [
    "(version 1)", "(allow default)", "(deny file-write*)",
    '(allow file-write* (subpath (param "SCRATCH")))',
    '(deny file-read* (subpath (param "VOICE")))',
    '(allow file-read* (subpath (param "MODELS")))',
    "(deny mach-priv-task-port)", "(deny signal (target others))",
  ].join("\n");
  return ["-D", "VOICE=" + voice, "-D", "MODELS=" + models, "-D", "SCRATCH=" + scratch, "-p", profile];
}

function linuxPolicy(voice: string, models: string, scratch: string) {
  // Keep loopback for the daemon. Hide other processes and the speech records,
  // and mount the host filesystem read-only except for this player's scratch.
  const policy = ["--unshare-all", "--share-net", "--new-session", "--cap-drop", "ALL",
    "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--tmpfs", voice];
  if (existsSync(models)) policy.push("--ro-bind", models, models);
  return [...policy, "--remount-ro", voice, "--bind", scratch, scratch, "--"];
}
