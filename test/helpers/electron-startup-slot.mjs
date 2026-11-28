// One Electron GUI startup at a time on this machine.
//
// Concurrent Electron GUI launches on macOS can hang before startup completes: under load,
// with several test workers launching at once, the main thread sat in a synchronous Mach
// message inside `ElectronMain` for the whole four-minute budget, with no GPU or renderer
// helper ever spawned. The same files launched one at a time passed under the same load. So
// tests serialize only that phase: a launch takes this slot, starts Electron, and gives the
// slot back once the browser process has spawned its first helper, which happens after the
// phase that hangs. Fixture runs themselves still overlap.
//
// The slot is a directory created atomically in the machine temp dir, so every worker and
// every checkout on the host share it. Its owner file names the holder by pid and start time,
// so a holder that died is stolen from rather than waited on. A holder that keeps it past
// `MAX_HOLD_MS` is stolen from too: its Electron is past the point where serializing helps.
//
// Plain `.mjs` with Node built-ins, shared by `electron-gui-launch.mjs` (a launcher process)
// and the TypeScript tests that spawn Electron directly.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ownerState, processStartedAt, systemTempDir } from "../temp-root.mjs";

/** How long one startup may hold the slot before a waiter takes it over. */
export const ELECTRON_STARTUP_MAX_HOLD_MS = 45_000;
const MAX_HOLD_MS = ELECTRON_STARTUP_MAX_HOLD_MS;
const MAX_WAIT_MS = 10 * 60_000;
const POLL_MS = 100;

function slotPath() {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return join(systemTempDir(), `mission-electron-startup-${uid}.lock`);
}

function readOwner(path) {
  try {
    return JSON.parse(readFileSync(join(path, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

function stale(path, now) {
  const owner = readOwner(path);
  if (!owner) {
    // Created but not yet stamped, or stamped by something else: give a writer a moment.
    try {
      return now - statSync(path).mtimeMs > 5_000;
    } catch {
      return false;
    }
  }
  if (now - Number(owner.acquiredAt) > MAX_HOLD_MS) return true;
  return ownerState(owner, null) === "dead";
}

/** Take the slot, waiting for it; resolves to a function that gives it back. */
export async function acquireElectronStartupSlot() {
  const path = slotPath();
  const deadline = Date.now() + MAX_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(path);
      const stamp = { pid: process.pid, startedAt: processStartedAt(), acquiredAt: Date.now() };
      writeFileSync(join(path, "owner.json"), JSON.stringify(stamp));
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const owner = readOwner(path);
        if (owner?.pid === stamp.pid && owner?.acquiredAt === stamp.acquiredAt) rmSync(path, { recursive: true, force: true });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    if (stale(path, Date.now())) {
      // Renamed before removal, so two waiters that both judged it stale cannot each delete
      // the other's fresh slot; only one rename succeeds.
      const aside = `${path}.stale.${process.pid}`;
      try {
        renameSync(path, aside);
        rmSync(aside, { recursive: true, force: true });
      } catch {
        // Someone else moved it first.
      }
      continue;
    }
    if (Date.now() > deadline) throw new Error(`waited ${MAX_WAIT_MS}ms for the Electron startup slot at ${path}`);
    await delay(POLL_MS);
  }
}

function hasChildren(pid) {
  const result = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim().length > 0;
}

/**
 * Resolve once Electron process `child` is past startup: it spawned a helper, it exited, or
 * `MAX_HOLD_MS` passed.
 */
export async function electronStarted(child) {
  const deadline = Date.now() + MAX_HOLD_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (child.pid !== undefined && hasChildren(child.pid)) return;
    await delay(POLL_MS);
  }
}

/**
 * Hold the slot for `child`'s startup and release it after. For tests that `spawn` Electron
 * themselves: take the slot first, spawn, then pass the child here.
 */
export function releaseAfterStartup(child, release) {
  electronStarted(child).finally(release);
}

/**
 * Hold the slot while `start` launches Electron and resolves, for launches that report their
 * own readiness, such as Playwright's `_electron.launch`, which resolves once the app is
 * connected and so past startup.
 */
export async function withElectronStartupSlot(start) {
  const release = await acquireElectronStartupSlot();
  try {
    return await start();
  } finally {
    release();
  }
}
