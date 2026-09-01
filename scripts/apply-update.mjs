#!/usr/bin/env node
// Detached macOS update helper. The Electron process copies this file to a fresh temp
// directory before launching it, because both the app bundle and updater-owned clone can be
// rewritten during the update. Its one sibling module is copied into the same directory before
// launch and imports only node: builtins. Do not add runtime imports after work begins.

import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
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
 *
 * Held as a directory of per-helper claim entries rather than as one shared lock file, and that
 * shape is the point. Two attempts at a single shared name both foundered on the same thing: a
 * contender deciding a lock was abandoned, then acting on that decision a moment later, by which
 * time it might be acting on a DIFFERENT, live helper's lock. Deleting outright let two helpers
 * both claim; taking-then-verifying moved the window rather than closing it, because taking a
 * live lock aside is itself destructive and putting it back can overwrite a third helper.
 *
 * Here, no contender ever writes or removes a name another live helper owns. Each helper creates
 * exactly one entry named after its own identity, and the holder is decided by reading the
 * directory - a decision that needs no mutation at all. The only entries anyone deletes are their
 * own, and those belonging to a process proven gone, which is safe precisely because the entry
 * name pins whose it is. There is no shared mutable name left to race over, and no timeout to
 * tune.
 */
export const HELPER_LOCK_DIR_NAME = "update-helper.lock.d";

/** Ordering key for a claim entry: earliest wins, pid settles a same-millisecond tie. */
export function claimPrecedes(a, b) {
  return a.createdAtMs !== b.createdAtMs ? a.createdAtMs < b.createdAtMs : a.pid < b.pid;
}

export function claimEntryName({ createdAtMs, pid }) {
  return `${String(createdAtMs).padStart(15, "0")}-${pid}.claim`;
}

export function parseClaimEntryName(name) {
  const match = /^(\d{15})-(\d+)\.claim$/.exec(name);
  if (!match) return null;
  return { createdAtMs: Number(match[1]), pid: Number(match[2]), name };
}

/** The staging name an entry is written under before being renamed into place. */
export function stagingEntryName(pid, createdAtMs) {
  return `.tmp-${pid}-${createdAtMs}`;
}

/**
 * The pid that owns a staging file, or null when the name is not one.
 *
 * A helper killed between writing its staging file and renaming it into place leaves that file
 * behind. It is never mistaken for a claim - the name cannot match the claim pattern - but
 * without this it would sit in the state directory forever, one per killed helper.
 */
export function parseStagingEntryName(name) {
  const match = /^\.tmp-(\d+)-(\d+)$/.exec(name);
  return match ? { pid: Number(match[1]), name } : null;
}

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
 * A process's start time, which is what makes a pid an identity rather than a coincidence.
 *
 * A pid on its own is reusable. A helper killed while holding a claim leaves its pid behind, and
 * macOS is free to hand that number to something unrelated - a shell, a browser tab's helper,
 * anything long-lived. `kill(pid, 0)` then answers "alive" forever and every future update reports
 * one already in progress, with no updater anywhere near the clone. Pairing the pid with the start
 * time of the process that actually wrote the entry makes reuse detectable: same number, different
 * process, different start time.
 *
 * Null when it cannot be read, which every caller treats as "cannot prove this is gone".
 */
export function processStartedAt(pid, run = defaultProcessQuery) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  try {
    const out = run(pid);
    const value = String(out ?? "").trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

function defaultProcessQuery(pid) {
  return execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * Whether the process that wrote a claim entry is still running.
 *
 * Conservative on purpose: anything short of proof that the writer is gone counts as live. A
 * wrongly-kept claim defers one update, and the person clicks Retry; a wrongly-removed claim puts
 * two helpers in one clone, which is the failure this whole mechanism exists to prevent.
 */
export function claimIsLive(entry, deps = {}) {
  const alive = deps.alive ?? ((pid) => processIsAlive(pid));
  const startedAt = deps.startedAt ?? ((pid) => processStartedAt(pid));
  if (!alive(entry.pid)) return false;
  // Nothing recorded to compare against, or nothing readable now: cannot prove reuse, so live.
  if (!entry.startedAt) return true;
  const now = startedAt(entry.pid);
  if (now === null) return true;
  return now === entry.startedAt;
}

/**
 * Take the helper claim, or report who holds it.
 *
 * The whole decision is made by reading the directory. This helper writes exactly one entry -
 * its own - and then looks at what is there; it never writes or removes a name that belongs to
 * another live helper, so there is no shared mutable state for two contenders to race over. That
 * is the property both earlier attempts lacked.
 *
 * The rule is that a helper holds the lock only when its own entry is the ONLY live one. It
 * deliberately involves no ordering, because ordering was wrong: an earlier version ranked
 * entries by (createdAtMs, pid) and let the earliest live claim win, which a contender arriving
 * LATER could break simply by writing an entry stamped earlier - displacing a helper that was
 * already running. A key the arriving process chooses cannot decide who was there first.
 *
 * "Alone or nothing" needs no clock, no tie-break, and no trust:
 *
 *   For this helper to hold the lock, its listing must show no other live entry. Its own entry
 *   is always written before it lists. So if two helpers both held the lock, each must have
 *   listed before the other's entry existed - yet each entry was written before that helper
 *   listed, which cannot be true of both. At most one helper can hold it, on every interleaving.
 *
 * The price is that two helpers starting close enough together can both see each other and both
 * stand down, leaving the update deferred rather than running. That is the right way to be
 * wrong: the person clicks Retry and the next attempt is alone. Two helpers in one clone is the
 * failure this exists to prevent, and it is not recoverable by retrying.
 *
 * Entries whose writing process is proven gone are removed. That is the one delete that touches
 * somebody else's name, and it is safe because the name says whose it is and `claimIsLive`
 * refuses to declare a process gone on anything less than proof.
 */
export function acquireHelperLock(directory, ops) {
  ops.ensureDirectory(directory);

  const mine = {
    createdAtMs: ops.now(),
    pid: ops.pid,
    startedAt: ops.startedAt(ops.pid),
  };
  const myName = claimEntryName(mine);
  // Written under a temporary name and renamed into place, so an entry is never visible in a
  // half-written state. A competitor reading a truncated entry could not tell a live helper
  // mid-write from an abandoned one, and would be entitled to delete it.
  ops.writeEntry(directory, myName, JSON.stringify({ pid: mine.pid, startedAt: mine.startedAt }));

  let names;
  try {
    names = ops.list(directory);
  } catch (error) {
    ops.removeEntry(directory, myName);
    throw error;
  }

  let rival = null;
  for (const name of names) {
    const parsed = parseClaimEntryName(name);
    if (!parsed) {
      // A staging file whose helper died before it could rename it into place. Removed only when
      // its owning pid is not running: deleting a live helper's staging file would make its
      // rename fail for no reason. Identity-pinned like every other delete here - the pid is in
      // the name, so this can only ever clear the leftovers of the process named in it.
      const staging = parseStagingEntryName(name);
      if (staging && !ops.isLive({ pid: staging.pid, startedAt: null })) {
        ops.removeEntry(directory, name);
      }
      continue;
    }
    if (name === myName) continue;
    const recorded = ops.readEntry(directory, name);
    const entry = { ...parsed, startedAt: recorded?.startedAt ?? null };
    if (!ops.isLive(entry)) {
      // Its writer is gone. Safe to remove: the filename pins whose entry this is, so this can
      // only ever clear the claim of the process named in it.
      ops.removeEntry(directory, name);
      continue;
    }
    // Only to decide which pid to name in the message, so the report is stable rather than
    // dependent on directory order. Any live rival at all is already decisive.
    if (rival === null || claimPrecedes(entry, rival)) rival = entry;
  }

  if (rival === null) return { ok: true, heldBy: null, entryName: myName };
  // Withdraw rather than linger: an entry left behind by a helper that is not running would make
  // it look like a live contender to everyone who reads the directory next.
  ops.removeEntry(directory, myName);
  return { ok: false, heldBy: rival.pid, entryName: null };
}

/** Withdraw this helper's own claim. The only entry it is ever this helper's job to remove. */
export function releaseHelperLock(directory, entryName, ops) {
  ops.removeEntry(directory, entryName);
}

export function realHelperLockOperations() {
  const startedAt = (pid) => processStartedAt(pid);
  return {
    pid: process.pid,
    now: () => Date.now(),
    startedAt,
    isLive: (entry) => claimIsLive(entry),
    ensureDirectory: (directory) => mkdirSync(directory, { recursive: true }),
    list: (directory) => readdirSync(directory),
    writeEntry: (directory, name, body) => {
      // `.tmp-` is outside the `<digits>-<pid>.claim` pattern, so a temporary file is never read
      // as a claim even if this helper dies between the write and the rename.
      const staging = join(directory, stagingEntryName(process.pid, Date.now()));
      writeFileSync(staging, `${body}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(staging, join(directory, name));
    },
    readEntry: (directory, name) => {
      try {
        return JSON.parse(readFileSync(join(directory, name), "utf8"));
      } catch {
        return null;
      }
    },
    removeEntry: (directory, name) => rmSync(join(directory, name), { force: true }),
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
  const lockDirectory = join(args.stateDirectory, HELPER_LOCK_DIR_NAME);
  const targetVersion = args.targetTag.replace(/^v/, "");
  let backupReady = false;
  let hadReceipt = false;
  let keepTemporaryBackup = false;
  let heldEntry = null;

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
    claimed = acquireHelperLock(lockDirectory, ops.lock);
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
  heldEntry = claimed.entryName;

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
    // A helper killed between here and the claim leaves its entry behind, which the next helper
    // clears once it can prove the writing process is gone - by pid AND start time, so a reused
    // pid cannot keep a dead helper's claim alive.
    if (heldEntry !== null) {
      try {
        releaseHelperLock(lockDirectory, heldEntry, ops.lock);
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
