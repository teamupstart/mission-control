// What the packaged shell decides before it starts anything at all.
//
// Split out of `index.ts` because that module is the Electron entry point: it reaches for
// `app` at import time and starts a window, a daemon and an updater as a side effect of being
// loaded, so nothing in it can be driven by a test. The decision it makes first is exactly the
// one worth driving - a launch of the retained system copy is handed to this account's
// personal app, and this process then starts nothing - and a defect in the hand-over is
// invisible to every test of the classifier, which only ever proves what the answer SHOULD be.
//
// So the answer and the consequence are separated. `install-identity.ts` decides which
// installed app this process is; this decides what the shell does about it, over injected
// ports, and `index.ts` supplies the real ones.

import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { FIXED_OS_EXECUTABLES } from "../server/executables/catalog.ts";
import { identityUpdateBlock, type InstallIdentity } from "./install-identity.ts";

/** What a hand-over attempt reported, so a failure can be logged rather than guessed at. */
export interface HandoverAttempt {
  ok: boolean;
  detail: string | null;
}

/** What `spawnSync` reports, narrowed to what a hand-over reads. */
export interface OpenResult {
  error?: Error;
  status: number | null;
  stderr?: string | null;
}

/** The one subprocess this path runs, injectable so a test can watch its exact argv. */
export type RunOpen = (executable: string, args: string[]) => OpenResult;

/** Electron's `app`, narrowed to the three things startup asks of it. */
export interface StartupApp {
  requestSingleInstanceLock(): boolean;
  exit(code: number): void;
  quit(): void;
}

export interface StartupPorts {
  /** The running bundle's identity, read now rather than cached. */
  identity(): InstallIdentity;
  /** Launch Services against one absolute bundle path. */
  open(target: string): HandoverAttempt;
  requestSingleInstanceLock(): boolean;
  exit(code: number): void;
  quit(): void;
  log(line: string): void;
}

export interface StartupDecision {
  /** Whether this launch now belongs to another bundle. */
  handedOver: boolean;
  /** Whether this process may take a window, a daemon and an updater. */
  proceed: boolean;
  /** Why the updater must stand down, or null when it may run. */
  updateBlock: string | null;
}

/**
 * The `.app` a packaged process came out of, derived from `app.getAppPath()`.
 *
 * Packaged, that path is `<bundle>/Contents/Resources/app`, so the bundle is three directories
 * up. Unpackaged it is the checkout, which is not a bundle and has no installed identity to
 * compare, so development answers null and classifies as unmanaged.
 */
export function runningBundlePath(appPath: string, packaged: boolean): string | null {
  return packaged ? dirname(dirname(dirname(appPath))) : null;
}

/**
 * Decide, and act, before the single-instance lock.
 *
 * The ordering is the whole point and is easy to undo by accident. The old copy is a complete
 * Mission Control: if it took the lock first, the personal app it then opened would lose that
 * lock, quit, and hand the person back the very bundle they were being moved off, with the old
 * app's daemon already running against the shared state. So a hand-over asks for no lock at
 * all.
 *
 * It also does not trust `exit` to have ended this process synchronously. A handed-over launch
 * reports `gotLock` false and takes the same road a losing second instance already takes,
 * which is the path already known to start nothing.
 *
 * A failed hand-over is NOT fatal. This copy keeps running, because the alternative is leaving
 * somebody with no Mission Control at all, and the updater stands down because the only bundle
 * it could update is not this one.
 */
export function decideStartup(ports: StartupPorts): StartupDecision {
  const identity = ports.identity();
  let handedOver = false;
  if (identity.state === "redirect") {
    const attempt = ports.open(identity.target);
    handedOver = attempt.ok;
    if (!attempt.ok) {
      ports.log(
        `could not open the installed app at ${identity.target}${attempt.detail ? `: ${attempt.detail}` : ""}. Continuing here with updates disabled.`,
      );
    }
  }
  if (handedOver) ports.exit(0);
  const gotLock = handedOver ? false : ports.requestSingleInstanceLock();
  if (!gotLock) ports.quit();
  return { handedOver, proceed: gotLock, updateBlock: identityUpdateBlock(identity) };
}

/**
 * The real Launch Services call, and the only direct subprocess on this path.
 *
 * Its own function so the executable and argv are built in exactly one place and a test can
 * replace the runner without replacing the construction. `spawnSync` is called directly here
 * rather than through the injected port, which is what keeps this an executable boundary the
 * contract test can see and hold.
 */
function runOpen(executable: string, args: string[]): OpenResult {
  return spawnSync(executable, args, { encoding: "utf8", timeout: 30_000 });
}

/**
 * Ask Launch Services to bring up one bundle.
 *
 * `open` reveals an already-running instance rather than starting a second one, which is the
 * behavior wanted when someone clicks a stale Dock entry for an app that is already up.
 *
 * The catalog's fixed absolute path, not a bare name: this runs before `app.whenReady()` and
 * therefore before the locator snapshot exists, so there is no resolved PATH to search and
 * nothing to select between.
 */
export function openInstalledApp(target: string, run: RunOpen = runOpen): HandoverAttempt {
  const executable = FIXED_OS_EXECUTABLES.open;
  const result = run(executable, [target]);
  const detail = result.error?.message ?? (result.stderr?.trim() || null);
  return { ok: !result.error && result.status === 0, detail };
}

/**
 * The packaged shell's startup decision, wired to the real world.
 *
 * One function rather than a ports literal at the entry point, because the wiring is the part
 * a test could not otherwise reach: `index.ts` starts a window, a daemon and an updater as a
 * side effect of being imported, so an `open` port left unconnected, or connected to the wrong
 * executable, would be invisible to every test of the pieces. Here `app` and the subprocess
 * runner are the only seams, and everything between them is the production path.
 */
export function startPackagedShell(options: {
  app: StartupApp;
  identity: () => InstallIdentity;
  log: (line: string) => void;
  run?: RunOpen;
}): StartupDecision {
  return decideStartup({
    identity: options.identity,
    open: (target) => openInstalledApp(target, options.run),
    requestSingleInstanceLock: () => options.app.requestSingleInstanceLock(),
    exit: (code) => options.app.exit(code),
    quit: () => options.app.quit(),
    log: options.log,
  });
}
