import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { nativeStateLockAddonPath } from "../state-ownership-native.ts";

/** Stable through exec. A different boot or birth at this PID proves the old process exited. */
export function voiceProcessBirth(pid: number): string {
  if (process.platform === "darwin") {
    const addon = nativeStateLockAddonPath();
    return createRequire(addon)(addon).voiceProcessBirth(pid);
  }
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
  // The command (field 2) may contain spaces or parentheses. Field 22 is the start tick.
  const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  if (!/^[a-f0-9-]{36}$/i.test(boot) || !start || !/^\d+$/.test(start)) throw new Error("Cannot identify voice process.");
  return boot + "/" + start;
}

export function voiceProcessGone(pid: number, birth?: string): boolean {
  try {
    process.kill(pid, 0);
    if (birth && voiceProcessBirth(pid) !== birth) return true;
    if (process.platform !== "linux") return false;
    const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}
