#!/usr/bin/env node
// Detached macOS update helper. The Electron process copies this file to a fresh temp
// directory before launching it, because both the app bundle and updater-owned clone can be
// rewritten during the update. Its one sibling module is copied into the same directory before
// launch and imports only node: builtins. Do not add runtime imports after work begins.

import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RESTORE_AUTHORIZATION_PROMPT,
  bundleShortVersion,
  replaceAppBundle,
} from "./app-bundle-swap.mjs";

export const UPDATE_OUTCOME_SCHEMA = 1;
const PARENT_EXIT_TIMEOUT_MS = 120_000;
const PARENT_POLL_MS = 250;

/**
 * How long the build may take before it is treated as hung.
 *
 * The build is a cold `npm ci` plus a full Electron package in the updater-owned clone, so this
 * has to be generous or it becomes the failure it is meant to prevent. Forty-five minutes is far
 * past any real build on supported hardware and still a bound: without one, a wedged npm leaves
 * the person with the app already backed up, no new app, and a helper that never returns.
 *
 * Distinct from PARENT_EXIT_TIMEOUT_MS on purpose. An app that will not quit and a build that
 * hangs are different failures and read differently.
 */
export const INSTALL_TIMEOUT_MS = 45 * 60 * 1000;

/**
 * Where a failed update leaves what it was holding.
 *
 * Lifetime: until the next update attempt STARTS - cleared before that attempt does anything
 * that can fail, so it holds one attempt's worth however that attempt ends, including the
 * failures that happen before there is a backup to retain in its place. That is enough to
 * inspect the broken bundle and to roll back a second time by hand, and it cannot accumulate.
 */
export const RETAINED_FAILURE_DIR_NAME = "failed-update";

/**
 * The one helper allowed to be updating at a time.
 *
 * `UpdateController.applyPromise` only ever guarded one app PROCESS, and this helper's whole
 * job is to outlive that process: it waits for the app to quit, works, and relaunches it. The
 * relaunched app reads `update-outcome.json`, offers Retry, and a second helper starts against
 * the same updater-owned clone as the first. That is not hypothetical - it is what the failing
 * logs show, twice over: `npm error ENOTEMPTY: directory not empty, rmdir` from two `npm ci`
 * runs in one clone, and four administrator panels inside a minute, of which the person could
 * only ever answer one. A second helper also writes its own `in-progress` over the first
 * helper's finished outcome, which is what turns a reported failure back into "the previous
 * update did not finish".
 */
export const HELPER_LOCK_FILE_NAME = "update-helper.lock";

const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

/**
 * Whether `pid` still names a live process, for deciding if a lock is stale.
 *
 * EPERM means it is alive and owned by somebody else, which is still alive. Only ESRCH is
 * evidence of absence, so an unexpected error reads as "assume alive" - refusing to start
 * costs one deferred update, while wrongly stealing a live lock costs the collision this
 * whole mechanism exists to prevent.
 */
export function processIsAlive(pid, kill = (target) => process.kill(target, 0)) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    kill(pid);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

/**
 * Take the helper lock, or report who holds it.
 *
 * Two atomic primitives carry this, and nothing else is trusted:
 *
 * - `O_EXCL` create for the claim, so there is no window between checking and claiming.
 * - `rename` for reclaiming a stale lock, so exactly one contender can take a given lock file
 *   and the rest get ENOENT instead of a turn.
 *
 * A leftover from a helper that was killed is identified by reading its pid, not by age, so
 * there is no timeout to tune and no wait before a genuinely stale lock can be reclaimed. That
 * read is an observation rather than a guarantee, so reclamation re-checks the pid of the file
 * it actually took and puts it back if it took the wrong one - see below. Nothing here removes
 * a lock it has not first taken ownership of, which is what keeps a reclaim from deleting a
 * lock another helper created in the meantime.
 *
 * Single-shot by design: a contender that loses any of these steps refuses rather than looping.
 * The app is relaunched on failure and offers Retry, so the retry is the person's, not a spin.
 */
export function acquireHelperLock(path, ops) {
  // Null for absent, unreadable, and unparseable alike. A lock whose pid cannot be established
  // names nobody, and every caller below treats that as "no identified holder" rather than
  // inventing one - including the window where a winning contender has moved the file aside but
  // not yet created its own.
  const readPid = (from) => {
    try {
      return Number(String(ops.read(from) ?? "").trim()) || null;
    } catch {
      return null;
    }
  };
  const claim = () => {
    const fd = ops.open(path);
    try {
      ops.write(fd, `${process.pid}\n`);
    } finally {
      ops.close(fd);
    }
    return { ok: true, heldBy: null };
  };
  try {
    return claim();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const holder = readPid(path);
  if (holder !== null && ops.alive(holder)) return { ok: false, heldBy: holder };

  // Stale, as far as this helper could see a moment ago - and "a moment ago" is the whole
  // problem. Deleting the lock outright here trusted that observation, so two helpers that both
  // saw the same dead pid would both delete and both claim: the second one's delete removes the
  // FIRST one's freshly created lock, and the collision this lock exists to prevent happens
  // anyway, now with the added confidence of a lock file.
  //
  // So reclamation takes the file rather than deleting it, and then proves that what it took is
  // the file it decided about. The rename is the atomic step: exactly one contender can move a
  // given lock, and the losers get ENOENT rather than a turn.
  const stolen = `${path}.stale-${process.pid}`;
  try {
    ops.remove(stolen);
  } catch {
    // A leftover from an attempt of ours that was killed. The move below reports it if it matters.
  }
  try {
    ops.move(path, stolen);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    // Another contender reclaimed it first. Whoever won is live by construction, so this attempt
    // is over; the next one reads their pid and refuses on the fast path above.
    return { ok: false, heldBy: readPid(path) };
  }

  const taken = readPid(stolen);
  if (taken !== holder) {
    // Not the stale lock after all: a helper claimed it between the read above and the move, and
    // this just took a LIVE lock out from under them. Put it back and stand down - the file is
    // theirs, and the brief absence is invisible to them because they only touch it again to
    // release it.
    try {
      ops.move(stolen, path);
    } catch (error) {
      ops.log?.(`could not return a lock taken from helper ${taken}: ${error?.message ?? error}`);
    }
    return { ok: false, heldBy: taken };
  }

  try {
    ops.remove(stolen);
  } catch {
    // The stale pid file is confirmed dead and already out of the way; failing to delete it
    // leaks one small file rather than blocking the update.
  }
  try {
    return claim();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    return { ok: false, heldBy: readPid(path) };
  }
}

export function realHelperLockOperations() {
  return {
    // `wx` is the exclusive create the whole mechanism rests on. The mkdir is here because the
    // claim now happens before the first outcome is written, and writing that outcome used to be
    // what created the state directory - without this, a state directory that does not exist yet
    // would fail the claim instead of the update proceeding.
    open: (path) => {
      mkdirSync(dirname(path), { recursive: true });
      return openSync(path, "wx", 0o600);
    },
    write: (fd, text) => writeSync(fd, text),
    close: closeSync,
    read: (path) => readFileSync(path, "utf8"),
    // Plain `renameSync`, because the atomicity is the point: exactly one contender can move a
    // given lock file, and the rest get ENOENT instead of a turn.
    move: renameSync,
    remove: (path) => rmSync(path, { force: true }),
    alive: (pid) => processIsAlive(pid),
  };
}

/**
 * Whether the installed app still has to be rolled back.
 *
 * The rollback is not free: on a bundle this account cannot rewrite it raises a second
 * administrator panel, and it used to raise one for a failure that never touched the app at
 * all - the install swap being cancelled. Comparing what is installed against the backup
 * answers the question directly. An unreadable or missing bundle is "unknown", and unknown
 * restores, because a bundle whose identity cannot be established is the one worth restoring.
 */
export function rollbackIsNeeded({ installedVersion, backupVersion }) {
  if (installedVersion === null || backupVersion === null) return true;
  return installedVersion !== backupVersion;
}

export function parseArgs(argv) {
  const values = {};
  const names = new Map([
    ["--source-clone", "sourceClone"],
    ["--target-tag", "targetTag"],
    ["--app-path", "appPath"],
    ["--parent-pid", "parentPid"],
    ["--state-dir", "stateDirectory"],
    ["--log-path", "logPath"],
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = names.get(argv[index]);
    const value = argv[index + 1];
    if (!key || !value) {
      return { args: null, problem: `invalid helper argument: ${argv[index] ?? "(missing)"}` };
    }
    values[key] = key === "parentPid" ? Number(value) : value;
  }
  const missing = [...names.values()].find((name) => values[name] === undefined);
  if (missing || !Number.isInteger(values.parentPid) || values.parentPid < 1) {
    return { args: null, problem: missing ? `missing ${missing}` : "parent pid is invalid" };
  }
  return { args: values, problem: null };
}

export function sanitizeDiagnostic(value) {
  return String(value)
    .replace(/Authorization\s*:\s*[^\s]+(?:\s+[^\s]+)?/gi, "Authorization: <redacted>")
    .replace(/\b(?:gh[opusr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, "<redacted-token>")
    .replace(/\b(token|access_token|auth)\s*[=:]\s*[^\s]+/gi, "$1=<redacted>")
    .replace(/\bfile:\/\/\/[^\s"')]+/g, "file://<path>")
    .replace(/(^|[\s"'(=])\/(?:[^\s"'),]+\/?)+/g, "$1<path>")
    .slice(0, 500);
}

/** Keep the decisive tail of a failed child process instead of only its exit status. */
export function installFailureSummary(output) {
  const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  const lines = String(output ?? "")
    .replace(ansiPattern, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-3).join(" | ").slice(-400);
}

export function writeOutcome(path, outcome) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(
      temporary,
      `${JSON.stringify({ schema: UPDATE_OUTCOME_SCHEMA, ...outcome }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function restoreReceipt({ receiptPath, backupReceipt, hadReceipt, ops }) {
  if (!hadReceipt) {
    ops.remove(receiptPath);
    return;
  }
  const staged = `${receiptPath}.rollback-${process.pid}`;
  ops.remove(staged);
  ops.copy(backupReceipt, staged);
  ops.move(staged, receiptPath);
}

export function realApplyOperations(logPath, installTimeoutMs = INSTALL_TIMEOUT_MS) {
  const log = (line) => {
    try {
      appendFileSync(logPath, `${new Date().toISOString()} ${sanitizeDiagnostic(line)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch {
      // Diagnostics must never make rollback or relaunch fail.
    }
  };
  return {
    exists: existsSync,
    remove: (path) => rmSync(path, { recursive: true, force: true }),
    move: renameSync,
    // Keep stderr in a thrown error. The caller sanitizes it before it reaches the outcome,
    // and "Operation not permitted" is the difference between a diagnosable rollback and the
    // old generic "Command failed: cp" report.
    copy: (from, to) => execFileSync("cp", ["-R", from, to], {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
    }),
    nowIso: () => new Date().toISOString(),
    waitForParent: async (pid) => {
      const deadline = Date.now() + PARENT_EXIT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0);
          await delay(PARENT_POLL_MS);
        } catch (error) {
          if (error?.code === "ESRCH") return;
          throw error;
        }
      }
      throw new Error("the app did not quit before the update timeout");
    },
    install: (node, script, tag, appsDir) => {
      // SIGKILL, not the default SIGTERM: this child is the last thing standing between the
      // person and a rollback, and it must be gone before one starts. Its own grandchildren
      // (npm, electron-builder) do outlive it, but they only ever write inside the
      // updater-owned clone - nothing moves an app into the installed location except the
      // child that was just killed - so they waste cycles rather than racing the rollback.
      // `--apps-dir` is forwarded from the receipt's own `appPath`, not left to the
      // install script's `/Applications` default. For an ordinary install the two are the
      // same string, so nothing changes. For an install made somewhere else - which is the
      // only way the release-verification runbook can exercise this path without touching
      // the operator's real app - the default would have rebuilt into `/Applications` while
      // the backup, the rollback, and the relaunch all still pointed at the receipt's path,
      // leaving the update reported as applied and the running app still on the old version.
      const result = spawnSync(node, [script, "--ref", tag, "--apps-dir", appsDir], {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: installTimeoutMs,
        killSignal: "SIGKILL",
      });
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      const summary = installFailureSummary(output);
      if (summary) log(summary);
      if (result.error?.code === "ETIMEDOUT") {
        throw new Error(
          `the build did not finish within ${Math.round(installTimeoutMs / 60_000)} minutes and was stopped`,
        );
      }
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(
          `the build/install command exited ${result.status ?? 1}${summary ? `: ${summary}` : ""}`,
        );
      }
    },
    restoreApp: (backupApp, appPath, pid) => {
      const restored = replaceAppBundle({
        sourceBundle: backupApp,
        appPath,
        appsDir: dirname(appPath),
        pid,
        keepPrevious: true,
        // Its own sentence. Sharing the install prompt meant the panel that undoes an update
        // asked to "install this update", so authorizing the rollback looked like authorizing
        // the upgrade - and in the failing logs that is precisely the panel that got approved.
        prompt: RESTORE_AUTHORIZATION_PROMPT,
      });
      if (restored.problem) throw new Error(restored.problem);
      for (const stray of restored.stranded) {
        log(`a bundle displaced by an earlier privileged install could not be removed: ${stray}`);
      }
      return restored.failedBundle;
    },
    bundleVersion: (path) => bundleShortVersion(path),
    lock: realHelperLockOperations(),
    launch: (appPath) => {
      const result = spawnSync("open", [appPath], { encoding: "utf8" });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`macOS could not relaunch the app (open exited ${result.status ?? 1})`);
      }
    },
    log,
  };
}

/** Apply one already-approved update. All mutable operations are injected for tests. */
export async function runApplyUpdate(args, ops = realApplyOperations(args.logPath)) {
  const outcomePath = join(args.stateDirectory, "update-outcome.json");
  const receiptPath = join(args.stateDirectory, "install-receipt.json");
  const tempDirectory = dirname(fileURLToPath(import.meta.url));
  const backupApp = join(tempDirectory, "previous-app.bundle");
  const backupReceipt = join(tempDirectory, "previous-receipt.json");
  const retained = join(args.stateDirectory, RETAINED_FAILURE_DIR_NAME);
  const lockPath = join(args.stateDirectory, HELPER_LOCK_FILE_NAME);
  const targetVersion = args.targetTag.replace(/^v/, "");
  let backupReady = false;
  let hadReceipt = false;
  let keepTemporaryBackup = false;
  let lockHeld = false;

  const record = (outcome) => writeOutcome(outcomePath, outcome);
  /**
   * Copy the whole backup directory somewhere the `finally` below does not reach.
   *
   * That `finally` removes the temp directory on every exit path, which is right for a
   * successful update and used to mean a failed one left nothing to inspect and nothing to roll
   * back to a second time. Copying the directory rather than the bundle alone also carries the
   * previous receipt, and needs no directory to be created first.
   *
   * It can still fail - a full or unwritable state directory is the obvious way - so the caller
   * treats a false here as "there is nowhere durable to put this", never as "throw it away".
   */
  const retainFailure = () => {
    try {
      ops.copy(tempDirectory, retained);
      return true;
    } catch (error) {
      ops.log(`could not retain the previous app for inspection: ${error?.message ?? error}`);
      return false;
    }
  };
  const fail = async (reason) => {
    let message = sanitizeDiagnostic(reason instanceof Error ? reason.message : reason);
    if (backupReady) {
      const kept = retainFailure();
      // Durable retention could not be created, so the temp directory becomes the retention:
      // the `finally` below is skipped and the backup survives where it already is. Strictly
      // better than the alternative, which would delete the only copy precisely because the
      // state directory was too broken to hold a second one.
      keepTemporaryBackup = !kept;
      // The install may well have failed without ever reaching the app - a cancelled or refused
      // authorization is exactly that - and restoring over an app that was never touched buys
      // nothing while costing a second administrator panel. That second panel is how the person
      // ended up authorizing an undo while the upgrade they asked for stayed unapplied.
      const needed = rollbackIsNeeded({
        installedVersion: ops.exists(args.appPath) ? ops.bundleVersion(args.appPath) : null,
        backupVersion: ops.bundleVersion(backupApp),
      });
      try {
        let failedBundle = null;
        if (needed) {
          failedBundle = ops.restoreApp(backupApp, args.appPath, process.pid);
        } else {
          ops.log("the installed app still matches the backup, so no rollback was needed");
        }
        restoreReceipt({ receiptPath, backupReceipt, hadReceipt, ops });
        if (failedBundle) {
          // Paths are redacted out of the log, so this can only say WHERE in the abstract. Both
          // locations are deterministic: the helper's own temp directory, and a `.failed-update`
          // sibling of the installed app. The next bundle transaction replaces that one retained
          // failed bundle, so repeated failures do not accumulate privileged directories.
          ops.log(
            `${kept ? "the previous app bundle and receipt were retained in the state directory" : "durable retention was unavailable, so the previous app bundle and receipt remain in the update helper's temp directory"}; the failed bundle remains beside the installed app`,
          );
        }
      } catch (restoreError) {
        message = `${message}. Restoring the previous app also failed: ${sanitizeDiagnostic(restoreError?.message ?? restoreError)}`;
        // A rollback that threw leaves the app in an unknown state; the backup is the only way
        // out of it, so it survives regardless of where retention ended up.
        keepTemporaryBackup = true;
      }
    }
    try {
      record({ result: "failure", targetVersion, recordedAt: ops.nowIso(), message });
    } catch (outcomeError) {
      ops.log(`could not record update failure: ${outcomeError?.message ?? outcomeError}`);
    }
    try {
      ops.launch(args.appPath);
    } catch (launchError) {
      ops.log(`could not relaunch the working app: ${launchError?.message ?? launchError}`);
    }
    return { ok: false, message };
  };

  // Before the in-progress record, not after: the outcome file is the thing a second helper
  // would corrupt, so it must not be written until this helper knows it is the only one.
  let claimed;
  try {
    claimed = acquireHelperLock(lockPath, ops.lock);
  } catch (error) {
    claimed = { ok: false, heldBy: null, problem: error?.message ?? String(error) };
  }
  if (!claimed.ok) {
    // Deliberately no outcome written and no relaunch attempted. Both belong to the helper that
    // holds the lock, and writing either here is the clobbering this prevents.
    const message = claimed.problem
      ? `could not claim the update lock: ${sanitizeDiagnostic(claimed.problem)}`
      : `another update is already in progress${claimed.heldBy ? ` (helper ${claimed.heldBy})` : ""}`;
    ops.log(message);
    return { ok: false, message };
  }
  lockHeld = true;

  try {
    record({ result: "in-progress", targetVersion, recordedAt: ops.nowIso() });
    // The single owner of the retention lifetime, and it runs here rather than beside either
    // outcome because the failures BEFORE the backup exists - the app never quitting, the app
    // being gone already - reach `fail()` with `backupReady` still false and would leave an
    // older attempt's evidence in place while the documented lifetime claims one attempt's
    // worth. Those failures leave the installed app untouched, so there is nothing to retain
    // in their place; clearing here is what makes "one attempt's worth" true for all of them.
    try {
      ops.remove(retained);
    } catch (error) {
      ops.log(`could not clear the retained failure directory: ${error?.message ?? error}`);
    }
    await ops.waitForParent(args.parentPid);
    if (!ops.exists(args.appPath)) throw new Error("the installed app is missing before the update");
    ops.copy(args.appPath, backupApp);
    hadReceipt = ops.exists(receiptPath);
    if (hadReceipt) ops.copy(receiptPath, backupReceipt);
    backupReady = true;

    ops.install(
      process.execPath,
      join(args.sourceClone, "scripts", "install-app.mjs"),
      args.targetTag,
      dirname(args.appPath),
    );
    record({ result: "success", targetVersion, recordedAt: ops.nowIso() });
    try {
      ops.launch(args.appPath);
    } catch (error) {
      return await fail(error);
    }
    return { ok: true, message: null };
  } catch (error) {
    return await fail(error);
  } finally {
    // Released before the temp directory goes, so the relaunched app can retry immediately.
    // A helper killed between here and the claim leaves the file behind, which the next
    // helper reclaims by pid rather than by waiting a timeout out.
    if (lockHeld) {
      try {
        ops.lock.remove(lockPath);
      } catch (error) {
        ops.log(`could not release the update lock: ${error?.message ?? error}`);
      }
    }
    // Every exit path except one: a failure that could not file its backup anywhere durable
    // keeps it here instead. Its home is a temp directory, so the OS still reclaims it.
    if (!keepTemporaryBackup) ops.remove(tempDirectory);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
const invokedDirectly = invokedPath && realpathSync(invokedPath) === realpathSync(modulePath);
if (invokedDirectly) {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.problem) {
    console.error(parsed.problem);
    process.exitCode = 1;
  } else {
    const result = await runApplyUpdate(parsed.args);
    process.exitCode = result.ok ? 0 : 1;
  }
}
