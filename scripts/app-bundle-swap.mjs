// The macOS application swap is the only part of a managed install that may need
// administrator authorization. Keep checkout, dependency installation, packaging, and receipt
// writes in the signed-in account. This module is copied beside the detached update helper, so
// it may import only node: builtins.

import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";

export const APP_BUNDLE_NAME = "Mission Control.app";
export const DEFAULT_APPS_DIR = "/Applications";
export const ADMINISTRATOR_AUTHORIZATION_PROMPT =
  "Mission Control needs administrator permission to install this update in /Applications.";
/**
 * The rollback wears its own sentence.
 *
 * One shared constant meant the panel raised to put the OLD app back still read "install this
 * update in /Applications", so an operator who authorized it had every reason to believe they
 * were approving the upgrade. They were approving its undo. Authorizing a rollback is a
 * different decision from authorizing an install and has to read as one.
 */
export const RESTORE_AUTHORIZATION_PROMPT =
  "Mission Control needs administrator permission to restore the previous app in /Applications.";

/**
 * The prompt travels through argv beside the transaction rather than interpolated into the
 * source. Two callers now supply two different sentences, and a sentence spliced into an
 * AppleScript string literal is one quote away from changing what the script says.
 */
export const PRIVILEGED_SWAP_APPLESCRIPT = `on run argv
  if (count of argv) is not 2 then error "expected one bundle transaction and one prompt"
  do shell script (item 1 of argv) with prompt (item 2 of argv) with administrator privileges
end run`;

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function validPid(pid) {
  return /^\d+$/.test(String(pid)) && Number(pid) > 0;
}

/** A numeric uid or gid, which is the only form the privileged transaction will chown to. */
function validId(id) {
  return Number.isInteger(id) && id >= 0;
}

/**
 * `uid:gid` for the privileged chown, or null when this account cannot be named numerically.
 *
 * Numeric ids on purpose. In the authorization context this transaction runs in, macOS name
 * lookup is not dependable - authd logs `User not found` for the very account it then matches
 * by uid - and a chown under `set -eu` that fails on a name lookup would abort an otherwise
 * good install.
 */
export function bundleOwnerSpec(uid, gid) {
  return validId(uid) && validId(gid) ? `${uid}:${gid}` : null;
}

export function stagingPaths({ appsDir, pid }) {
  return {
    staged: join(appsDir, `.${APP_BUNDLE_NAME}.incoming-${pid}`),
    previous: join(appsDir, `.${APP_BUNDLE_NAME}.previous-${pid}`),
    failed: join(appsDir, `.${APP_BUNDLE_NAME}.failed-update`),
  };
}

/** Build the shell transaction after its paths have passed the privileged-path checks. */
export function bundleSwapShellCommand({
  sourceBundle,
  appPath,
  staged,
  previous,
  failed,
  keepPrevious,
  owner = null,
}) {
  const q = shellQuote;
  // The copy and decisive moves stay subject to `set -eu`. These commands run only after the
  // new bundle is live, so their `|| true` guards are deliberate: filing or deleting the
  // displaced bundle is best-effort and must not turn a successful swap into a reported
  // failure. If filing fails, `previous` remains the recoverable fallback sibling.
  const finishPrevious = keepPrevious
    ? `{ /bin/rm -rf ${q(failed)} && /bin/mv ${q(previous)} ${q(failed)}; } || true`
    : `/bin/rm -rf ${q(previous)} || true`;
  const finishFailed = keepPrevious ? null : `/bin/rm -rf ${q(failed)} || true`;
  return [
    "set -eu",
    `/bin/rm -rf ${q(staged)} ${q(previous)}`,
    `/bin/cp -R ${q(sourceBundle)} ${q(staged)}`,
    // The `cp` above runs as root, so without this the installed bundle ends up root-owned -
    // and a root-owned bundle is exactly the condition that sends the NEXT update down this
    // privileged path too. One install needing authorization used to mean every install after
    // it needed authorization. Handing the staged copy back to the signed-in account before it
    // goes live is what makes elevation a one-off rather than a ratchet.
    //
    // Inside `set -eu` deliberately: a chown that fails has produced a bundle this account
    // cannot maintain, and it fails here, before anything has been moved and while the
    // installed app is still untouched.
    ...(owner ? [`/usr/sbin/chown -R ${q(owner)} ${q(staged)}`] : []),
    "had_previous=0",
    `if [ -e ${q(appPath)} ]; then /bin/mv ${q(appPath)} ${q(previous)}; had_previous=1; fi`,
    `if /bin/mv ${q(staged)} ${q(appPath)}; then`,
    `  if [ "$had_previous" -eq 1 ]; then ${finishPrevious}; fi`,
    ...(finishFailed ? [`  ${finishFailed}`] : []),
    "else",
    "  status=$?",
    `  if [ "$had_previous" -eq 1 ] && [ -e ${q(previous)} ]; then /bin/mv ${q(previous)} ${q(appPath)}; fi`,
    `  /bin/rm -rf ${q(staged)}`,
    '  exit "$status"',
    "fi",
  ].join("\n");
}

/**
 * One fixed-path shell transaction, passed to osascript as data rather than interpolated into
 * AppleScript. All paths are single-quoted for /bin/sh. The only elevated destination this
 * module permits is the exact product bundle in /Applications.
 */
export function privilegedBundleSwapCommand({
  sourceBundle,
  appPath,
  appsDir,
  pid,
  keepPrevious,
  owner = null,
}) {
  if (!validPid(pid)) return { command: null, problem: "the bundle transaction pid is invalid" };
  if (owner !== null && !/^\d+:\d+$/.test(String(owner))) {
    return { command: null, problem: "the bundle owner must be numeric uid:gid" };
  }
  const exactAppsDir = resolve(appsDir);
  const exactAppPath = resolve(appPath);
  const expectedAppPath = join(DEFAULT_APPS_DIR, APP_BUNDLE_NAME);
  if (exactAppsDir !== DEFAULT_APPS_DIR || exactAppPath !== expectedAppPath) {
    return {
      command: null,
      problem: `administrator authorization is restricted to ${expectedAppPath}`,
    };
  }
  if (resolve(sourceBundle) !== sourceBundle) {
    return { command: null, problem: "the source bundle path must be absolute and normalized" };
  }

  const { staged, previous, failed } = stagingPaths({ appsDir: exactAppsDir, pid });
  const command = bundleSwapShellCommand({
    sourceBundle,
    appPath: exactAppPath,
    staged,
    previous,
    failed,
    keepPrevious,
    owner,
  });
  return { command, problem: null };
}

/**
 * Pure transaction used directly when the destination directory is already writable.
 *
 * Reports not only WHETHER it failed but whether the installed app survived the attempt, which
 * is what lets `replaceAppBundle` decide between escalating to an administrator-authorized
 * retry and stopping. Every failure below except one is arranged to leave the installed app
 * exactly where it was, so the common answer is `appIntact: true` and a retry is safe.
 */
export function attemptSwapAppBundle({
  packagedApp,
  appPath,
  appsDir,
  pid,
  keepPrevious = false,
  ops,
}) {
  const { staged, previous, failed } = stagingPaths({ appsDir, pid });
  const why = (err) => (err instanceof Error ? err.message : String(err));

  ops.remove(staged);
  try {
    ops.copy(packagedApp, staged);
  } catch (err) {
    ops.remove(staged);
    return {
      problem: `could not stage the new app at ${staged}: ${why(err)}. ${appPath} is unchanged.`,
      appIntact: true,
    };
  }

  const hadPrevious = ops.exists(appPath);
  if (hadPrevious) {
    try {
      ops.move(appPath, previous);
    } catch (err) {
      ops.remove(staged);
      return {
        problem: `could not move the existing app aside: ${why(err)}. ${appPath} is unchanged.`,
        appIntact: true,
      };
    }
  }

  try {
    ops.move(staged, appPath);
  } catch (err) {
    let restored = false;
    if (hadPrevious) {
      try {
        ops.move(previous, appPath);
        restored = true;
      } catch {}
    }
    ops.remove(staged);
    const state = hadPrevious
      ? restored
        ? "The previous app was restored."
        : `The previous app is at ${previous} - move it back by hand.`
      : "Nothing was installed.";
    return {
      problem: `could not put the new app in place at ${appPath}: ${why(err)}. ${state}`,
      // The one case where the installed app is NOT where it was. A privileged retry would
      // stage over a half-dismantled destination, so this failure is final.
      appIntact: hadPrevious ? restored : true,
    };
  }

  // Once the new bundle is live, filing or deleting the displaced bundle is best-effort.
  // A cleanup failure must leave the successful transaction successful. In the retention
  // case, `previous` is the fallback location when the durable `failed` sibling cannot be used.
  if (hadPrevious && keepPrevious) {
    try {
      ops.remove(failed);
      ops.move(previous, failed);
    } catch {}
  } else if (hadPrevious) {
    try { ops.remove(previous); } catch {}
  }
  if (!keepPrevious) {
    try { ops.remove(failed); } catch {}
  }
  return { problem: null, appIntact: true };
}

/** The long-standing string-returning contract, kept for callers that cannot act on a retry. */
export function swapAppBundle(args) {
  return attemptSwapAppBundle(args).problem;
}

/** `CFBundleShortVersionString` out of an `Info.plist` body, or null when it is not stated. */
export function plistVersion(text) {
  const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/.exec(
    String(text ?? ""),
  );
  return match?.[1]?.trim() || null;
}

/**
 * The version an installed bundle reports, or null when that cannot be established.
 *
 * Null is the answer for a missing app, an unreadable plist, and a plist with no version, and
 * every caller treats it as "unknown" rather than as any particular version - a bundle whose
 * identity cannot be read is exactly the one worth being careful about.
 */
export function bundleShortVersion(appPath, read = (path) => readFileSync(path, "utf8")) {
  try {
    return plistVersion(read(join(appPath, "Contents", "Info.plist")));
  } catch {
    return null;
  }
}

export function directoryIsWritable(path, access = accessSync) {
  try {
    access(path, fsConstants.W_OK | fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Deliberately no longer consulted before choosing a path. See `replaceAppBundle`.
 *
 * It answers "can this account rewrite every directory inside the bundle", which the swap does
 * not need and never did: the transaction renames the outgoing bundle aside and never writes
 * into it. Kept because it is the honest test of whether the displaced tree can also be
 * DELETED afterwards, which is the one thing an unprivileged swap genuinely cannot do.
 */
export function directoryTreeIsWritable(root) {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directoryIsWritable(directory)) return false;
    try {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (lstatSync(path).isDirectory()) pending.push(path);
      }
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Best-effort reclamation of bundles displaced by earlier runs.
 *
 * An unprivileged swap can always rename a bundle it does not own out of the way, but it cannot
 * empty one - so a root-owned predecessor gets left behind as a `previous-<pid>` sibling. That
 * is a far better outcome than refusing to update, and this keeps it from accumulating: the
 * generation after a privileged install is owned by this account and deletes cleanly.
 *
 * Never touches the live transaction's own sibling, which is the retention fallback the swap
 * relies on when it cannot file the displaced bundle. Every failure is ignored; reclaiming disk
 * is not worth failing an install over.
 */
export function sweepDisplacedBundles({
  appsDir,
  keepPid,
  readdir = readdirSync,
  remove = (path) => rmSync(path, { recursive: true, force: true }),
}) {
  const prefix = `.${APP_BUNDLE_NAME}.previous-`;
  const keep = `${prefix}${keepPid}`;
  const stranded = [];
  let entries = [];
  try {
    entries = readdir(appsDir);
  } catch {
    return stranded;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || entry === keep) continue;
    try {
      remove(join(appsDir, entry));
    } catch {
      stranded.push(join(appsDir, entry));
    }
  }
  return stranded;
}

/**
 * Install the bundle, asking for administrator authorization only when the plain attempt proved
 * it was needed.
 *
 * This used to PREDICT which path would work, and predicted it wrongly in the one case that
 * matters. The check required every directory inside the outgoing bundle to be writable, so a
 * root-owned app - which is what a previous elevated install leaves behind - sent every later
 * update straight to an administrator prompt. The transaction never writes into that bundle: it
 * stages a sibling, renames the old bundle aside, and renames the new one in, all of which need
 * write and execute on `appsDir` alone. Renaming a root-owned bundle out of a writable
 * `/Applications` succeeds for any admin user.
 *
 * That prediction was also expensive to get wrong. The prompt it forced is raised by a detached
 * helper whose app has already quit, so macOS brings the authorization panel up unfocused and
 * behind whatever is on screen, and authd deny-lists `/usr/bin/osascript` besides. A panel
 * nobody sees is dismissed, `do shell script` reports `User canceled (-128)`, and a routine
 * update fails for want of permission it never required.
 *
 * So: attempt, then escalate. The attempt is arranged to leave the installed app untouched on
 * every failure but one, and only that survivable kind escalates.
 */
export function replaceAppBundle({
  sourceBundle,
  appPath,
  appsDir,
  pid,
  keepPrevious = false,
  prompt = ADMINISTRATOR_AUTHORIZATION_PROMPT,
  platform = process.platform,
  appsDirWritable = directoryIsWritable(appsDir),
  owner = bundleOwnerSpec(process.getuid?.(), process.getgid?.()),
  sweep = () => sweepDisplacedBundles({ appsDir, keepPid: pid }),
  ops = {
    copy: (from, to) => execFileSync("/bin/cp", ["-R", from, to], { stdio: "inherit" }),
    move: renameSync,
    remove: (path) => rmSync(path, { recursive: true, force: true }),
    exists: existsSync,
  },
  runElevated = (command, promptText) => {
    execFileSync(
      "/usr/bin/osascript",
      ["-e", PRIVILEGED_SWAP_APPLESCRIPT, command, promptText],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  },
}) {
  const retained = () => (keepPrevious ? stagingPaths({ appsDir, pid }).failed : null);
  let stranded = [];
  let unprivileged = null;

  if (appsDirWritable) {
    stranded = sweep();
    const attempt = attemptSwapAppBundle({
      packagedApp: sourceBundle,
      appPath,
      appsDir,
      pid,
      keepPrevious,
      ops,
    });
    if (!attempt.problem) {
      return { problem: null, elevated: false, failedBundle: retained(), stranded };
    }
    // Nothing an administrator can put right, or nothing left to safely retry over.
    if (platform !== "darwin" || !attempt.appIntact) {
      return { problem: attempt.problem, elevated: false, failedBundle: null, stranded };
    }
    unprivileged = attempt.problem;
  } else if (platform !== "darwin") {
    return {
      problem: `${appsDir} is not writable`,
      elevated: false,
      failedBundle: null,
      stranded,
    };
  }

  const plan = privilegedBundleSwapCommand({
    sourceBundle,
    appPath,
    appsDir,
    pid,
    keepPrevious,
    owner,
  });
  if (plan.problem) {
    return { problem: plan.problem, elevated: false, failedBundle: null, stranded };
  }
  try {
    runElevated(plan.command, prompt);
    return { problem: null, elevated: true, failedBundle: retained(), stranded };
  } catch (error) {
    const detail = error?.stderr || error?.message || error;
    // Both halves, because "User canceled" alone reads as the whole story when the real story
    // is that an ordinary install was attempted first and says why it could not finish.
    const why = `administrator-authorized app bundle transaction failed: ${String(detail).trim()}`;
    return {
      problem: unprivileged ? `${unprivileged} ${why}` : why,
      elevated: true,
      failedBundle: null,
      stranded,
    };
  }
}
