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

function restoreBundle({ appPath, backupApp, pid, ops }) {
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
  ops.remove(failed);
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

export function realApplyOperations(logPath) {
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
      const result = spawnSync(node, [script, "--ref", tag], {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      });
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      if (output) log(output);
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
  const targetVersion = args.targetTag.replace(/^v/, "");
  let backupReady = false;
  let hadReceipt = false;

  const record = (outcome) => writeOutcome(outcomePath, outcome);
  const fail = async (reason) => {
    let message = sanitizeDiagnostic(reason instanceof Error ? reason.message : reason);
    if (backupReady) {
      try {
        restoreBundle({ appPath: args.appPath, backupApp, pid: process.pid, ops });
        restoreReceipt({ receiptPath, backupReceipt, hadReceipt, ops });
      } catch (restoreError) {
        message = `${message}. Restoring the previous app also failed: ${sanitizeDiagnostic(restoreError?.message ?? restoreError)}`;
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
    ops.remove(tempDirectory);
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
