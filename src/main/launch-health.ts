import type { WebContents } from "electron";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { launchAckPath, inspectAppLaunch, launchConflictMessage, realMacAppOps, type MacAppOps } from "../../scripts/mac-app-lifecycle.mjs";
import { processIdentity } from "../../scripts/update-lock.mjs";
import { logMain } from "./main-log.ts";

/** No parent-PID heuristic: normal LaunchServices apps also have launchd as parent. */
export async function unmanagedLaunchMessage(bundle: string, pid = process.pid, ops: MacAppOps = realMacAppOps()): Promise<string | null> {
  try {
    const inspection = await inspectAppLaunch(bundle, ops);
    if (!inspection.unregistered.includes(pid)) return null;
    return launchConflictMessage(inspection, ops.uid);
  } catch {
    return "Mission Control could not verify its LaunchServices registration. Inspect lsappinfo list and launchctl list. Open the app from Finder or the Dock after resolving any launch conflict.";
  }
}

/** Called only after Electron has run JavaScript in a loaded window, including the local startup page. */
export function acknowledgeUpdateLaunch(bundle: string, directory: string, argv = process.argv): boolean {
  const index = argv.indexOf("--mission-update-launch");
  const nonce = index >= 0 ? argv[index + 1] : undefined;
  if (!nonce || !/^[a-f0-9]{32}$/.test(nonce)) return false;
  const path = launchAckPath(directory, nonce);
  const staged = `${path}.${process.pid}.tmp`;
  try {
    const identity = processIdentity(process.pid);
    if (!identity) throw new Error("Process identity unavailable");
    mkdirSync(directory, {recursive: true});
    writeFileSync(staged, JSON.stringify({nonce, pid: process.pid, bundle, identity}), {mode: 0o600});
    renameSync(staged, path);
    logMain("update launch: main event loop and renderer responded");
    return true;
  } catch {
    logMain("update launch: could not write renderer acknowledgment");
    return false;
  }
}

/** A real renderer round trip, independent of daemon readiness and update dialog answers. */
export function observeUpdateLaunch(contents: Pick<WebContents, "on" | "executeJavaScript">, bundle: string, directory: string, argv = process.argv): void {
  let acknowledged = false;
  contents.on("did-finish-load", () => {
    if (acknowledged) return;
    void contents.executeJavaScript("true").then(() => {
      if (acknowledged) return;
      acknowledged = acknowledgeUpdateLaunch(bundle, directory, argv);
    }).catch(() => logMain("update launch: renderer did not respond"));
  });
}
