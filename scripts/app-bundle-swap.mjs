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
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";

export const APP_BUNDLE_NAME = "Mission Control.app";
export const DEFAULT_APPS_DIR = "/Applications";
export const ADMINISTRATOR_AUTHORIZATION_PROMPT =
  "Mission Control needs administrator permission to install this update in /Applications.";

export const PRIVILEGED_SWAP_APPLESCRIPT = `on run argv
  if (count of argv) is not 1 then error "expected one bundle transaction"
  do shell script (item 1 of argv) with prompt "${ADMINISTRATOR_AUTHORIZATION_PROMPT}" with administrator privileges
end run`;

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function validPid(pid) {
  return /^\d+$/.test(String(pid)) && Number(pid) > 0;
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
export function privilegedBundleSwapCommand({ sourceBundle, appPath, appsDir, pid, keepPrevious }) {
  if (!validPid(pid)) return { command: null, problem: "the bundle transaction pid is invalid" };
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
  });
  return { command, problem: null };
}

/** Pure transaction used directly when the destination directory is already writable. */
export function swapAppBundle({ packagedApp, appPath, appsDir, pid, keepPrevious = false, ops }) {
  const { staged, previous, failed } = stagingPaths({ appsDir, pid });
  const why = (err) => (err instanceof Error ? err.message : String(err));

  ops.remove(staged);
  try {
    ops.copy(packagedApp, staged);
  } catch (err) {
    ops.remove(staged);
    return `could not stage the new app at ${staged}: ${why(err)}. ${appPath} is unchanged.`;
  }

  const hadPrevious = ops.exists(appPath);
  if (hadPrevious) {
    try {
      ops.move(appPath, previous);
    } catch (err) {
      ops.remove(staged);
      return `could not move the existing app aside: ${why(err)}. ${appPath} is unchanged.`;
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
    return `could not put the new app in place at ${appPath}: ${why(err)}. ${state}`;
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
  return null;
}

export function directoryIsWritable(path, access = accessSync) {
  try {
    access(path, fsConstants.W_OK | fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

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
 * Use ordinary filesystem operations whenever possible. On macOS, an unwritable /Applications
 * destination gets one native administrator prompt for only the fixed bundle transaction.
 */
export function replaceAppBundle({
  sourceBundle,
  appPath,
  appsDir,
  pid,
  keepPrevious = false,
  platform = process.platform,
  writable = directoryIsWritable(appsDir)
    && (!existsSync(appPath) || directoryTreeIsWritable(appPath)),
  ops = {
    copy: (from, to) => execFileSync("/bin/cp", ["-R", from, to], { stdio: "inherit" }),
    move: renameSync,
    remove: (path) => rmSync(path, { recursive: true, force: true }),
    exists: existsSync,
  },
  runElevated = (command) => {
    execFileSync(
      "/usr/bin/osascript",
      ["-e", PRIVILEGED_SWAP_APPLESCRIPT, command],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  },
}) {
  if (writable) {
    const problem = swapAppBundle({
      packagedApp: sourceBundle,
      appPath,
      appsDir,
      pid,
      keepPrevious,
      ops,
    });
    return {
      problem,
      elevated: false,
      failedBundle: !problem && keepPrevious ? stagingPaths({ appsDir, pid }).failed : null,
    };
  }
  if (platform !== "darwin") {
    return { problem: `${appsDir} is not writable`, elevated: false, failedBundle: null };
  }
  const plan = privilegedBundleSwapCommand({
    sourceBundle,
    appPath,
    appsDir,
    pid,
    keepPrevious,
  });
  if (plan.problem) return { problem: plan.problem, elevated: false, failedBundle: null };
  try {
    runElevated(plan.command);
    return {
      problem: null,
      elevated: true,
      failedBundle: keepPrevious ? stagingPaths({ appsDir, pid }).failed : null,
    };
  } catch (error) {
    const detail = error?.stderr || error?.message || error;
    return {
      problem: `administrator-authorized app bundle transaction failed: ${String(detail).trim()}`,
      elevated: true,
      failedBundle: null,
    };
  }
}
