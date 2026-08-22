#!/usr/bin/env node
// Detached macOS update helper. The Electron process copies this file to a fresh temp
// directory before launching it, because both the app bundle and updater-owned clone can be
// rewritten during the update. Keep every import in this file a node: builtin and do not add
// runtime imports after work begins.

import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

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

function restoreBundle({ appPath, backupApp, pid, ops, keepFailedAs }) {
  const parent = dirname(appPath);
  const rollback = join(parent, `.${basename(appPath)}.rollback-${pid}`);
  const failed = join(parent, `.${basename(appPath)}.failed-${pid}`);
  ops.remove(rollback);
  ops.remove(failed);
  ops.copy(backupApp, rollback);
  const hadApp = ops.exists(appPath);
  if (hadApp) ops.move(appPath, failed);
  try {
    ops.move(rollback, appPath);
  } catch (error) {
    if (hadApp && ops.exists(failed)) ops.move(failed, appPath);
    throw error;
  }
  // The bundle that failed is the only evidence of HOW it failed, so it is never deleted here.
  // Filing it under the durable directory is preferred; leaving it in place as `.failed-<pid>`
  // beside the installed app is the fallback when there is nowhere durable to put it. Filing it
  // must not be able to turn a rollback that worked into a reported failure, so a move that
  // throws falls back rather than propagating.
  if (!hadApp) {
    ops.remove(failed);
    return null;
  }
  if (keepFailedAs) {
    try {
      ops.move(failed, keepFailedAs);
      return keepFailedAs;
    } catch {
      // nowhere durable to put it after all - leave it where it is
    }
  }
  return failed;
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
    copy: (from, to) => execFileSync("cp", ["-R", from, to], { stdio: "ignore" }),
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
    install: (node, script, tag) => {
      // SIGKILL, not the default SIGTERM: this child is the last thing standing between the
      // person and a rollback, and it must be gone before one starts. Its own grandchildren
      // (npm, electron-builder) do outlive it, but they only ever write inside the
      // updater-owned clone - nothing moves an app into /Applications except the child that
      // was just killed - so they waste cycles rather than racing the rollback.
      const result = spawnSync(node, [script, "--ref", tag], {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: installTimeoutMs,
        killSignal: "SIGKILL",
      });
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      if (output) log(output);
      if (result.error?.code === "ETIMEDOUT") {
        throw new Error(
          `the build did not finish within ${Math.round(installTimeoutMs / 60_000)} minutes and was stopped`,
        );
      }
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`the build/install command exited ${result.status ?? 1}`);
      }
    },
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
  const targetVersion = args.targetTag.replace(/^v/, "");
  let backupReady = false;
  let hadReceipt = false;
  let keepTemporaryBackup = false;

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
      try {
        const failedBundle = restoreBundle({
          appPath: args.appPath,
          backupApp,
          pid: process.pid,
          ops,
          keepFailedAs: kept ? join(retained, "failed-app.bundle") : null,
        });
        restoreReceipt({ receiptPath, backupReceipt, hadReceipt, ops });
        if (!kept && failedBundle) {
          // Paths are redacted out of the log, so this can only say WHERE in the abstract. Both
          // locations are deterministic: the helper's own temp directory, and a `.failed-<pid>`
          // sibling of the installed app. A stale sibling can only accumulate on a machine whose
          // state directory cannot be written at all, which has to be fixed by hand regardless.
          ops.log(
            "durable retention was unavailable: the previous app bundle and receipt were left in the update helper's temp directory, and the failed bundle beside the installed app",
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

    ops.install(process.execPath, join(args.sourceClone, "scripts", "install-app.mjs"), args.targetTag);
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
