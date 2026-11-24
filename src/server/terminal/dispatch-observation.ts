import { createHash } from "node:crypto";
import {
  closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync,
  readdirSync, realpathSync, rmdirSync, rmSync, unlinkSync, writeSync, type Stats,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { stateDir } from "../../shared/harness-runtime.mjs";
import { type PendingTerminalLaunch, TERMINAL_RECEIPT_NAME } from "@shared/launch-failure.ts";
import { DISPOSABLE_STATE_ROOT, LAUNCH_PID_FILE, readTerminalWrapperProcess, type LaunchProcess } from "./launch-process.ts";
import { RESUME_START_MS } from "./resume-lease.ts";

const POLL_INTERVAL_MS = 5_000;
// Give a temporarily unavailable process table a minute to recover. The durable receipt
// remains available to restart if this daemon exhausts the consecutive failed probes.
const MAX_UNKNOWN_PROBES = 12;
export const WRAPPER_EXIT_FILE = "terminal-wrapper.exit";

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function privateDirectory(path: string): boolean {
  const info = lstatSync(path);
  return info.isDirectory() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0;
}

function receiptDirectory(create = false): string {
  // Multiple daemons can share the disposable root. Only this state store's records belong to it.
  if (!privateDirectory(DISPOSABLE_STATE_ROOT)) throw new Error("Unsafe terminal scratch directory");
  const scope = createHash("sha256").update(realpathSync(stateDir())).digest("hex");
  const path = join(DISPOSABLE_STATE_ROOT, ".pending-" + scope);
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!privateDirectory(path)) throw new Error("Unsafe terminal receipt directory");
  return path;
}

function receiptName(home: string, file: Stats): string {
  return basename(home) + "." + file.dev + "." + file.ino;
}

/** The exclusive link is the daemon's claim against the wrapper's exclusive PID creation.
 * Its identity survives a crash between claiming, marking the outcome and removing the home. */
function revokeUnstartedWrapper(home: string, expected: Stats): boolean {
  if (!privateDirectory(home)) return false;
  const exitPath = join(home, WRAPPER_EXIT_FILE);
  const fd = openSync(exitPath, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const file = fstatSync(fd);
    if (!file.isFile() || file.uid !== process.getuid?.() || !sameFile(file, expected)) return false;
    const claim = join(home, LAUNCH_PID_FILE);
    try { linkSync(exitPath, claim); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (!sameFile(file, lstatSync(claim))) return false;
    writeSync(fd, "n", 0);
    rmSync(home, { recursive: true, force: true });
    return true;
  } finally { closeSync(fd); }
}

function observe(home: string, fd: number, readOwner: typeof readTerminalWrapperProcess, pinned: boolean) {
  const identity = fstatSync(fd);
  const outcome = () => {
    const file = fstatSync(fd);
    if (file.nlink !== (pinned ? 1 : 0)) return null;
    const byte = Buffer.alloc(1);
    if (file.size !== 1 || readSync(fd, byte, 0, 1, 0) !== 1) return false;
    const marker = byte.toString("latin1");
    return marker === "x" || marker === "n";
  };
  return {
    confirmed: () => outcome() === true,
    revokeUnstarted: () => revokeUnstartedWrapper(home, identity),
    persist(deadline: number): PendingTerminalLaunch | undefined {
      // Only an ambiguous backend outcome needs a link surviving the daemon's descriptor.
      const file = fstatSync(fd);
      const receipt = receiptName(home, file);
      if (!TERMINAL_RECEIPT_NAME.test(receipt) || dirname(home) !== DISPOSABLE_STATE_ROOT) return;
      try {
        if (!privateDirectory(home)) return;
        const source = join(home, WRAPPER_EXIT_FILE);
        if (!sameFile(lstatSync(source), file)) return;
        linkSync(source, join(receiptDirectory(true), receipt));
        pinned = true;
        return { receipt, deadline };
      } catch { return; } // The wrapper can already have exited. A missing record proves nothing.
    },
    async waitForExit(stillOwned: () => boolean): Promise<boolean> {
      let owner: LaunchProcess | null = null;
      let retriedClaim = false;
      let unknownProbes = 0;
      while (stillOwned()) {
        const exited = outcome();
        if (exited !== null) return exited;
        const current = await readOwner(home, owner?.pid);
        if (current === "unknown") {
          if (++unknownProbes >= MAX_UNKNOWN_PROBES) return outcome() === true;
        } else {
          unknownProbes = 0;
          if (owner && (!current || current.pid !== owner.pid || current.startMs !== owner.startMs)) return outcome() === true;
          if (!current && retriedClaim) return outcome() === true;
          owner = current;
          retriedClaim = true;
        }
        const observed = outcome();
        if (observed !== null) return observed;
        await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS).unref());
      }
      return false;
    },
    close: () => closeSync(fd),
  };
}

export function observeTerminalWrapperExit(home: string, readOwner = readTerminalWrapperProcess) {
  const fd = openSync(join(home, WRAPPER_EXIT_FILE), "wx+", 0o600);
  return observe(home, fd, readOwner, false);
}

/** Restart may retire an unstarted wrapper's scratch directory. Checkout retention is owned by the caller. */
export async function restoredTerminalInactive(pending: PendingTerminalLaunch, stillOwned: () => boolean): Promise<boolean> {
  if (!TERMINAL_RECEIPT_NAME.test(pending.receipt) || !stillOwned()) return false;
  const home = join(DISPOSABLE_STATE_ROOT, pending.receipt.split(".")[0]!);
  try {
    const path = join(receiptDirectory(), pending.receipt);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const observation = observe(home, fd, readTerminalWrapperProcess, true);
    try {
      const file = fstatSync(fd);
      if (!file.isFile() || file.uid !== process.getuid?.() || (file.mode & 0o077) !== 0 || receiptName(home, file) !== pending.receipt) return false;
      if (observation.confirmed()) return true;
      const remaining = Math.min(RESUME_START_MS, pending.deadline - Date.now());
      if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, remaining).unref());
      if (!stillOwned()) return false;
      if (observation.confirmed()) return true;
      try {
        if (observation.revokeUnstarted()) return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      }
      return await observation.waitForExit(stillOwned);
    } finally { observation.close(); }
  } catch { return false; }
}

export function discardTerminalReceipt(receipt: string): void {
  try {
    if (!TERMINAL_RECEIPT_NAME.test(receipt)) return;
    const dir = receiptDirectory();
    unlinkSync(join(dir, receipt));
    rmdirSync(dir); // Only the last completed observation can remove the empty directory.
  } catch { /* Another pending launch can still own the directory. */ }
}

export function pruneTerminalReceipts(owned: ReadonlySet<string>): void {
  try {
    for (const name of readdirSync(receiptDirectory())) {
      if (!owned.has(name)) discardTerminalReceipt(name);
    }
  } catch { /* No pending records on a fresh install. */ }
}
