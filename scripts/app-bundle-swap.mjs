// The macOS application swap is the only part of a managed install that may need
// administrator authorization. Keep checkout, dependency installation, packaging, and receipt
// writes in the signed-in account. This module is copied beside the detached update helper, so
// it imports only Node builtins and the bundled shared naming constants, and loads
// the copied native filesystem addon only for exclusive app publication.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { APP_BUNDLE_NAME, LEGACY_APP_BUNDLE_NAME } from "../src/shared/app-naming.mjs";
export { APP_BUNDLE_NAME };
/**
 * The one directory an administrator prompt may ever install into.
 *
 * Named for what it authorizes rather than for what an install defaults to, because it is no
 * longer both. A personal install now defaults to the signed-in account's own `~/Applications`
 * (see `install-destination.mjs`), which needs no elevation at all; this constant stays fixed
 * at the shared system folder so that widening the default cannot widen the privilege
 * boundary. `privilegedBundleSwapCommand` is its only consumer here.
 */
export const SYSTEM_APPS_DIR = "/Applications";
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

/**
 * The pid a displaced-bundle suffix names, or null when the suffix is not one this code wrote.
 *
 * `Number()` is far too generous to decide what to delete recursively: it accepts `123.0`,
 * `0x7b`, `1e3` and whitespace-padded forms, all of which coerce to perfectly valid integers.
 * `stagingPaths` only ever writes a canonical decimal pid, so any other spelling is a directory
 * this code could not have created - and the sweep's entire safety argument is that the filename
 * pins whose bundle it is. A name we could not have produced pins nothing, so it is not ours to
 * remove. `isSafeInteger` rules out the overflowed forms that survive the pattern.
 */
export function displacedBundlePid(suffix) {
  if (!/^[1-9][0-9]*$/.test(String(suffix))) return null;
  const pid = Number(suffix);
  return Number.isSafeInteger(pid) ? pid : null;
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
    staged: join(appsDir, `.${LEGACY_APP_BUNDLE_NAME}.incoming-${pid}`),
    previous: join(appsDir, `.${LEGACY_APP_BUNDLE_NAME}.previous-${pid}`),
    failed: join(appsDir, `.${LEGACY_APP_BUNDLE_NAME}.failed-update`),
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
  const expectedAppPath = join(SYSTEM_APPS_DIR, APP_BUNDLE_NAME);
  if (exactAppsDir !== SYSTEM_APPS_DIR || ![expectedAppPath, join(SYSTEM_APPS_DIR, LEGACY_APP_BUNDLE_NAME)].includes(exactAppPath)) {
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
  verifyStaged = () => {},
  ops,
}) {
  const { staged, previous, failed } = stagingPaths({ appsDir, pid });
  const why = (err) => (err instanceof Error ? err.message : String(err));

  ops.remove(staged);
  let verifying = false;
  try {
    ops.copy(packagedApp, staged);
    verifying = true;
    verifyStaged(staged);
  } catch (err) {
    ops.remove(staged);
    return {
      problem: `could not stage the new app at ${staged}: ${why(err)}. ${appPath} is unchanged.`,
      appIntact: true,
      verificationFailed: verifying,
      retainedAt: null,
      stranded: [],
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
        retainedAt: null,
        stranded: [],
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
      retainedAt: null,
      stranded: [],
    };
  }

  // Once the new bundle is live, filing or deleting the displaced bundle is best-effort.
  // A cleanup failure must leave the successful transaction successful. In the retention
  // case, `previous` is the fallback location when the durable `failed` sibling cannot be used.
  //
  // Best-effort still has to be honest, though. Swallowing these errors silently meant the run
  // that STRANDED a bundle was the one run that never mentioned it: an unprivileged swap over a
  // root-owned predecessor cannot empty the tree it renamed aside, and `sweepDisplacedBundles`
  // skips the live transaction's own sibling, so the operator heard nothing until some later
  // update happened to sweep it.
  const stranded = [];
  let retainedAt = null;
  if (hadPrevious && keepPrevious) {
    let filed = false;
    try {
      ops.remove(failed);
      ops.move(previous, failed);
      filed = true;
    } catch {}
    // Where the displaced bundle actually is, rather than where it was meant to go. The caller
    // reports this location to the operator, so guessing it wrong sends them to an empty path.
    retainedAt = filed ? failed : previous;
    // An older retained bundle this account could not delete, which is why filing failed. It is
    // still on disk and nothing else will find it: `sweepDisplacedBundles` scans `previous-*`
    // siblings only and never this fixed path. Same reporting the branch below already did - it
    // was missing here, so exactly one of the two ways to reach it stayed silent.
    if (!filed && ops.exists(failed)) stranded.push(failed);
  } else if (hadPrevious) {
    try {
      ops.remove(previous);
    } catch {
      stranded.push(previous);
    }
  }
  if (!keepPrevious) {
    try {
      ops.remove(failed);
    } catch {
      // A retained bundle from an earlier failed update that this account cannot delete. Still
      // occupying disk, so it is still worth naming.
      if (ops.exists(failed)) stranded.push(failed);
    }
  }
  return { problem: null, appIntact: true, retainedAt, stranded };
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
 * Reclaims only bundles whose owning process is gone, and excluding this transaction's own pid
 * is not enough to establish that. A `previous-<pid>` sibling is the ONLY copy of the installed
 * app for the window between "move the app aside" and "move the staged app live" - so deleting a
 * concurrent transaction's sibling in that window means that if its staged move then fails, its
 * rollback has nothing to restore and the person is left with no app at all. Trading a working
 * app for reclaimed disk is not a trade worth making.
 *
 * The helper lock does not make this safe on its own: `install-app.mjs` is a supported command
 * anyone can run directly, so a swap can be in flight without any claim being held. The pid is
 * in the filename, so liveness is checkable without coordination, and the conservative direction
 * is to keep - a live pid leaves a bundle unreclaimed, which only costs disk.
 *
 * Never touches the live transaction's own sibling either, which is the retention fallback the
 * swap relies on when it cannot file the displaced bundle. Every failure is ignored; reclaiming
 * disk is not worth failing an install over.
 */
export function sweepDisplacedBundles({
  appsDir,
  keepPid,
  readdir = readdirSync,
  remove = (path) => rmSync(path, { recursive: true, force: true }),
  isRunning = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM means alive and owned by another account, which is still alive. Only ESRCH is
      // evidence of absence, and anything unexpected reads as "still running" so an
      // in-flight transaction is never swept on a guess.
      return error?.code !== "ESRCH";
    }
  },
}) {
  const prefix = `.${LEGACY_APP_BUNDLE_NAME}.previous-`;
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
    const pid = displacedBundlePid(entry.slice(prefix.length));
    // Not a suffix this code writes, so not a bundle it will delete. Such a name could belong to
    // anything - another tool, a person's backup - and a transaction still running besides.
    if (pid === null) continue;
    // Possibly mid-swap, and its sibling may be the only copy of the installed app.
    if (isRunning(pid)) continue;
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
  verifyStaged = () => {},
  prompt = ADMINISTRATOR_AUTHORIZATION_PROMPT,
  platform = process.platform,
  appsDirWritable = directoryIsWritable(appsDir),
  owner = bundleOwnerSpec(process.getuid?.(), process.getgid?.()),
  sweep = () => sweepDisplacedBundles({ appsDir, keepPid: pid }),
  ops = {
    copy: (from, to) => execFileSync("/bin/cp", ["-R", from, to], { stdio: "inherit", timeout: 10 * 60 * 1000 }),
    move: renameSync,
    remove: (path) => rmSync(path, { recursive: true, force: true }),
    exists: existsSync,
  },
  runElevated = (command, promptText) => {
    execFileSync(
      "/usr/bin/osascript",
      ["-e", PRIVILEGED_SWAP_APPLESCRIPT, command, promptText],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10 * 60 * 1000 },
    );
  },
}) {
  /**
   * The retention slot the privileged transaction aims for.
   *
   * Only the elevated path uses this, and only as its best available answer: the shell script
   * does its own filing and reports nothing back, so its fallback to `previous` cannot be seen
   * from here. The unprivileged path knows exactly where the bundle ended up and says so.
   */
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
      verifyStaged,
      ops,
    });
    if (!attempt.problem) {
      return {
        problem: null,
        elevated: false,
        // What the transaction reports it actually retained, not what it set out to retain. The
        // fallback location is real: filing the displaced bundle into the fixed slot can fail,
        // and naming the slot anyway sends whoever reads this to an empty path.
        failedBundle: attempt.retainedAt,
        // Includes anything this transaction could not clean up after itself. Without that, the
        // one run that stranded a bundle was the only run that never mentioned it.
        stranded: [...stranded, ...attempt.stranded],
      };
    }
    // Nothing an administrator can put right, or nothing left to safely retry over.
    if (platform !== "darwin" || !attempt.appIntact || attempt.verificationFailed) {
      return {
        problem: attempt.problem,
        elevated: false,
        failedBundle: null,
        stranded: [...stranded, ...attempt.stranded],
      };
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

/** Reserve private staging on the destination volume. No public app path is written
 * until publishRenamedApp atomically claims an unoccupied name. */
export function reserveRenamedApp(target) {
  const prefix = join(dirname(target), ".mission-rename-staging-");
  try { return mkdtempSync(prefix); }
  catch (error) {
    if (!["EACCES", "EPERM"].includes(error.code) || target !== join(SYSTEM_APPS_DIR, APP_BUNDLE_NAME)) throw error;
  }
  const owner = bundleOwnerSpec(process.getuid?.(), process.getgid?.());
  if (!owner) throw new Error("Cannot identify the installation owner");
  const directory = execFileSync("/usr/bin/osascript", ["-e", PRIVILEGED_SWAP_APPLESCRIPT,
    `set -eu\ndirectory=$(/usr/bin/mktemp -d ${shellQuote(`${prefix}XXXXXXXX`)})\n/usr/sbin/chown ${shellQuote(owner)} "$directory"\nprintf '%s' "$directory"`,
    ADMINISTRATOR_AUTHORIZATION_PROMPT], {encoding: "utf8", timeout: 600_000});
  const path = directory.trim();
  const stat = lstatSync(path);
  if (dirname(path) !== SYSTEM_APPS_DIR || !basename(path).startsWith(".mission-rename-staging-") ||
    !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) {
    throw new Error("The private app staging directory could not be verified");
  }
  return path;
}

// This native operation already ships with every app. Unlike fs.renameSync or mv -n,
// it refuses an occupied name atomically, including an empty directory or a symlink.
function renamePublicationBinding() {
  const path = fileURLToPath(new URL("../dist/native/state-lock.node", import.meta.url));
  const binding = createRequire(path)(path);
  if (typeof binding.renameNoReplace !== "function") throw new Error("The packaged runtime lacks exclusive app publication");
  return {path, rename: binding.renameNoReplace};
}

/** Authorization only repeats the exclusive publication, using this helper's own
 * embedded runtime and shipped addon. No host Node, npm, compilation or copying into
 * the public destination. Recheck the private source after the prompt as well. */
export function renamedBundlePublicationCommand(source, target, expectedIdentity) {
  requireDirectoryIdentity(expectedIdentity);
  const script = `const fs = require('node:fs');
const [addon, source, target, expected] = process.argv.slice(1);
const stat = fs.lstatSync(source);
if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev + ':' + stat.ino !== expected) throw new Error('Private app staging identity changed');
require(addon).renameNoReplace(source, target);`;
  return `/usr/bin/env -i ELECTRON_RUN_AS_NODE=1 ${shellQuote(process.execPath)} -e ${shellQuote(script)} ${[renamePublicationBinding().path, source, target, expectedIdentity].map(shellQuote).join(" ")}`;
}

export function publishRenamedApp(source, target, expectedIdentity, {
  rename = (from, to) => renamePublicationBinding().rename(from, to),
  runElevated = (command) => execFileSync("/usr/bin/osascript", ["-e", PRIVILEGED_SWAP_APPLESCRIPT,
    command, ADMINISTRATOR_AUTHORIZATION_PROMPT], {encoding: "utf8", timeout: 600_000}),
} = {}) {
  requireDirectoryIdentity(expectedIdentity);
  if (resolve(source) !== source || resolve(target) !== target || basename(target) !== APP_BUNDLE_NAME ||
    basename(source) !== APP_BUNDLE_NAME || dirname(dirname(source)) !== dirname(target) ||
    !basename(dirname(source)).startsWith(".mission-rename-staging-")) throw new Error("Invalid private app publication paths");
  const stat = lstatSync(source);
  if (!stat.isDirectory() || stat.isSymbolicLink() || `${stat.dev}:${stat.ino}` !== expectedIdentity) throw new Error("Private app staging identity changed");
  try { rename(source, target); }
  catch (error) {
    // The native operation distinguishes collision/absence from other rename errors.
    // Only the exact system destination may retry an intact, unmodified source with
    // authorization. The retry remains exclusive even if a destination arrived meanwhile.
    if (error.code !== "ERENAME" || target !== join(SYSTEM_APPS_DIR, APP_BUNDLE_NAME)) throw error;
    runElevated(renamedBundlePublicationCommand(source, target, expectedIdentity));
  }
}

function requireDirectoryIdentity(identity) {
  if (!/^\d+:\d+$/.test(identity)) throw new Error("Invalid cleanup directory identity");
}

/** Capture again AFTER authorization. Never run an elevated rm on a public app path,
 * or on a user-owned holding path that could have changed while the prompt was open. */
export function renamedBundleRemovalCommand(source, expectedIdentity) {
  requireDirectoryIdentity(expectedIdentity);
  if (resolve(source) !== source) throw new Error("Cleanup requires an absolute normalized path");
  return [
    "set -eu",
    `source=${shellQuote(source)}`,
    `expected=${shellQuote(expectedIdentity)}`,
    'matches() { [ ! -L "$1" ] && [ -d "$1" ] && [ "$(/usr/bin/stat -f \'%d:%i\' "$1")" = "$expected" ]; }',
    'matches "$source" || { echo "Cleanup directory identity changed: $source" >&2; exit 1; }',
    `holding=$(/usr/bin/mktemp -d ${shellQuote(join(dirname(source), ".mission-rename-cleanup-XXXXXXXX"))})`,
    // Only rmdir the empty container. A mismatched or partially removed capture is
    // recovery material, and its exact path must survive in the authorization error.
    'trap \'status=$?; /bin/rmdir "$holding" 2>/dev/null || echo "Cleanup stopped; inspect retained bundle at $holding/bundle.app" >&2; exit "$status"\' EXIT',
    '/bin/mv "$source" "$holding/bundle.app"',
    'matches "$holding/bundle.app" || { echo "Cleanup directory identity changed during capture" >&2; exit 1; }',
    '/bin/rm -rf "$holding/bundle.app"',
  ].join("\n");
}

/** The caller pins dev:ino BEFORE verifying the source digest, or takes the pin from
 * the nonce-owned reservation. A rename into a private sibling captures one directory;
 * checking it AFTER the move closes the public path check/remove race. A foreign capture
 * is retained for manual recovery, never put back over a concurrently recreated path. */
export function removeRenamedBundle(source, expectedIdentity, {
  ops = {
    identity: (path) => {
      const s = lstatSync(path);
      return s.isDirectory() && !s.isSymbolicLink() ? `${s.dev}:${s.ino}` : null;
    },
    makePrivateDirectory: mkdtempSync,
    move: renameSync,
    remove: (path) => rmSync(path, {recursive: true}),
    removeDirectory: rmdirSync,
  },
  runElevated = (command) => execFileSync("/usr/bin/osascript", ["-e", PRIVILEGED_SWAP_APPLESCRIPT,
    command, "Mission Control needs administrator permission to remove its attempt-owned app bundle in /Applications."],
  {encoding: "utf8", timeout: 600_000}),
} = {}) {
  requireDirectoryIdentity(expectedIdentity);
  let holding = null;
  let captured = null;
  const requireMatch = (path) => {
    if (ops.identity(path) !== expectedIdentity) throw new Error(`Cleanup directory identity changed: ${path}`);
  };
  try {
    try {
      requireMatch(source);
      holding = ops.makePrivateDirectory(join(dirname(source), ".mission-rename-cleanup-"));
      const destination = join(holding, "bundle.app");
      ops.move(source, destination);
      captured = destination;
      requireMatch(captured);
      ops.remove(captured);
    } catch (error) {
      if (!["EACCES", "EPERM"].includes(error.code) || ![join(SYSTEM_APPS_DIR, LEGACY_APP_BUNDLE_NAME), join(SYSTEM_APPS_DIR, APP_BUNDLE_NAME)].includes(source)) throw error;
      runElevated(renamedBundleRemovalCommand(captured ?? source, expectedIdentity));
    }
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim();
    throw new Error(`${detail}. Cleanup stopped; inspect ${captured ?? source} manually.`, {cause: error});
  } finally {
    // Never recursively clean the container: it may hold a different app or the
    // only remaining copy of a bundle whose removal lacked permission.
    if (holding) { try { ops.removeDirectory(holding); } catch {} }
  }
}
