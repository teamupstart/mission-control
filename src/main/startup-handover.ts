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

import { dirname } from "node:path";
import { identityUpdateBlock, type InstallIdentity } from "./install-identity.ts";

/** What a hand-over attempt reported, so a failure can be logged rather than guessed at. */
export interface HandoverAttempt {
  ok: boolean;
  detail: string | null;
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
