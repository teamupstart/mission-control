#!/usr/bin/env node
// Detached macOS update helper. The Electron process copies this file to a fresh temp
// directory before launching it, because both the app bundle and updater-owned clone can be
// rewritten during the update. Its complete dependency graph is copied with the same relative
// layout before launch. Do not add runtime imports after work begins.
//
// The app builds the new version before it quits and hands the verified bundle over with
// `--staged-bundle`, so this helper's work is the part that genuinely needs the app gone: wait
// for it to exit, swap the bundle in, relaunch. It still accepts a handoff without one, and
// then builds from the clone itself exactly as before - that is the path a `--ref` install
// from an older app takes, and it is the reason the timeout below is still measured in
// three quarters of an hour.

import { acknowledgeHelper, finishHelper } from "./update-helper-runtime.mjs";
import { prepareSourceUpdate, installStagedApp, bundleCommit as bundleSourceCommit } from "./install-staged-app.mjs";
import { readReceipt } from "../src/shared/install-receipt.mjs";
import { randomBytes } from "node:crypto";
import { assertSafeAppLaunch, COMMAND_TIMEOUT_MS, realMacAppOps, waitForBundleExit, prepareAppLaunch, verifyAppLaunch, stopAttemptLaunch, launchAckPath } from "./mac-app-lifecycle.mjs";
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
import { dirname, join, resolve } from "node:path";
import { readMigrationJson, validateMigrationPlan, updateMigrationReceipt, runMigration, recoverMigration, readMigrationJournal } from "./install-migration.mjs";
import { migrationRuntimePorts } from "./migration-runtime.mjs";
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

import {
  HELPER_LOCK_DIR_NAME, acquireHelperLock, releaseHelperLock, realHelperLockOperations,
} from "./update-lock.mjs";
export {
  HELPER_LOCK_DIR_NAME, claimPrecedes, claimEntryName, parseClaimEntryName,
  stagingEntryName, parseStagingEntryName, processIsAlive, processIdentity,
  claimIsLive, acquireHelperLock, releaseHelperLock, realHelperLockOperations,
} from "./update-lock.mjs";
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

/**
 * Whether the installed app still has to be rolled back.
 *
 * The rollback is not free: on a bundle this account cannot rewrite it raises a second
 * administrator panel, and it used to raise one for a failure that never touched the app at
 * all - the install swap being cancelled. Comparing what is installed against the backup
 * answers the question directly. An unreadable or missing bundle is "unknown", and unknown
 * restores, because a bundle whose identity cannot be established is the one worth restoring.
 */
export function rollbackIsNeeded({ installedVersion, backupVersion, installedCommit, backupCommit, requireCommit = false }) {
  if (requireCommit && (!installedCommit || !backupCommit)) return true;
  if (requireCommit && installedCommit !== backupCommit) return true;
  if (installedVersion === null || backupVersion === null) return true;
  return installedVersion !== backupVersion;
}

export { bundleCommit as bundleSourceCommit } from "./install-staged-app.mjs";

export function parseArgs(argv) {
  const values = { stagedBundle: null, stagedRevision: null, stagedDigest: null };
  const names = new Map([
    ["--source-clone", "sourceClone"],
    ["--target-tag", "targetTag"],
    ["--app-path", "appPath"],
    ["--parent-pid", "parentPid"],
    ["--state-dir", "stateDirectory"],
    ["--log-path", "logPath"],
    ["--staged-bundle", "stagedBundle"],
    ["--staged-revision", "stagedRevision"],
    ["--staged-digest", "stagedDigest"],
    ["--source-app", "sourceApp"],
    ["--target-app", "targetApp"],
    ["--migration-plan", "migrationPlan"],
    ["--attempt-directory", "attemptDirectory"],
    ["--recovery", "recovery"],
  ]);
  // Optional rather than required, because a handoff from an app that predates staging carries
  // neither and must still be applied.
  const optional = new Set(["stagedBundle", "stagedRevision", "stagedDigest", "sourceApp", "targetApp", "migrationPlan", "attemptDirectory", "recovery"]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 2) {
    const key = names.get(argv[index]);
    const value = argv[index + 1];
    if (!key || !value || seen.has(key)) {
      return { args: null, problem: `invalid helper argument: ${argv[index] ?? "(missing)"}` };
    }
    values[key] = key === "parentPid" ? Number(value) : value;
    seen.add(key);
  }
  const missing = [...names.values()].find(
    (name) => !optional.has(name) && !(name === "sourceClone" && values.migrationPlan) && values[name] === undefined,
  );
  if (missing || !Number.isInteger(values.parentPid) || values.parentPid < 1) {
    return { args: null, problem: missing ? `missing ${missing}` : "parent pid is invalid" };
  }
  const migration = [values.sourceApp, values.targetApp, values.migrationPlan];
  if (values.stagedDigest !== null && (!/^[a-f0-9]{64}$/.test(values.stagedDigest) || !values.stagedBundle || !values.stagedRevision)) {
    return {args: null, problem: "a staged digest requires a SHA-256 digest and pinned staged bundle"};
  }
  if (migration.some(Boolean) && (!migration.every(Boolean) || !values.stagedBundle || !values.stagedRevision || values.appPath !== values.sourceApp)) {
    return {args: null, problem: "a migration requires a complete source, target, plan and pinned staged bundle"};
  }
  return { args: values, problem: null };
}

/**
 * The same rule set as `sanitizeLogLine` in `src/main/update-log.ts`, plus a length cap.
 *
 * A deliberate copy, not an oversight: this file's detached dependency graph cannot import
 * the main-process TypeScript logger after it outlives the app bundle.
 * `test/update-log.test.ts` asserts both produce identical output, which is what keeps a copy
 * from becoming a divergence - the URL rules were added to both in the same change, after a
 * review found that a registry or git URL reached the log in full.
 */
export function sanitizeDiagnostic(value) {
  return String(value)
    .replace(
      /(["'])Authorization\1\s*:\s*(["'])(?!<redacted>)[^"']*\2/gi,
      "$1Authorization$1: $2<redacted>$2",
    )
    // `(?!<redacted>)`: see the note beside the same rule in `src/main/update-log.ts`. Without
    // it a second pass over this function's own output consumed the following word.
    .replace(/Authorization\s*:\s*(?!<redacted>)[^\s]+(?:\s+[^\s]+)?/gi, "Authorization: <redacted>")
    .replace(/\b(?:gh[opusr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, "<redacted-token>")
    .replace(/\b(token|access_token|auth)\s*[=:]\s*[^\s]+/gi, "$1=<redacted>")
    .replace(/\bfile:\/\/\/[^\s"')]+/g, "file://<path>")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`)<>\]]+/gi, "<url>")
    .replace(/^\s*[\w.+-]+@(?=[\w.-]*[a-z])[\w-]+(?:\.[\w-]+)+:(?=\s)/gi, "<url>:")
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+:[^\s"'`)<>]+/gi, "<url>")
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

/**
 * Relaunch the app through LaunchServices, within `COMMAND_TIMEOUT_MS`.
 *
 * `spawn` is injectable so the budget is observable in a test; production always uses
 * `spawnSync`. `open` returns once LaunchServices has the request, so the bound is on a hung
 * `open`, not on the app's own startup.
 */
export function openAppForRelaunch(appPath, nonce, spawn = spawnSync) {
  const env = {...process.env};
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawn("/usr/bin/open", [appPath, ...(nonce ? ["--args", "--mission-update-launch", nonce] : [])], { encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, env });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`macOS could not relaunch the app (open exited ${result.status ?? 1})`);
  }
}

export function realApplyOperations(
  logPath,
  installTimeoutMs = INSTALL_TIMEOUT_MS,
) {
  const mac = realMacAppOps(dirname(logPath));
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
    preflight: (bundle) => assertSafeAppLaunch(bundle, mac),
    waitForBundle: (bundle) => waitForBundleExit(bundle, mac),
    prepareLaunch: (bundle) => prepareAppLaunch(bundle, mac),
    verifyLaunch: (bundle, nonce) => verifyAppLaunch(bundle, nonce, mac),
    stopLaunch: (bundle, nonce) => stopAttemptLaunch(bundle, nonce, mac),
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
    install: (node, script, tag, appsDir, stagedBundle = null, stagedRevision = null, stagedDigest = null) => {
      if (stagedBundle) {
        const previous = readReceipt(join(dirname(logPath), "install-receipt.json"));
        if (!previous) throw new Error("A staged update requires its existing managed receipt");
        const descriptor = prepareSourceUpdate({receipt: previous, bundle: stagedBundle, revision: stagedRevision, targetTag: tag});
        if (stagedDigest !== null && descriptor.digest !== stagedDigest) throw new Error("The accepted staged app bytes changed");
        if (dirname(descriptor.receipt.appPath) !== appsDir) throw new Error("The installation destination changed");
        installStagedApp(descriptor, {stateDirectory: dirname(logPath)});
        return;
      }
      // Compatibility for source installers predating --stage-only. Their child
      // must be stopped before rollback; staged installs never enter this branch.
      const timeout = installTimeoutMs;
      const result = spawnSync(node, [script, "--ref", tag, "--apps-dir", appsDir], {
        encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout, killSignal: "SIGKILL",
      });
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      const summary = installFailureSummary(output);
      if (summary) log(summary);
      if (result.error?.code === "ETIMEDOUT") {
        throw new Error(
          `the build did not finish within ${Math.round(timeout / 60_000)} minutes and was stopped`,
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
    bundleCommit: bundleSourceCommit,
    lock: realHelperLockOperations(),
    launch: (appPath, nonce) => openAppForRelaunch(appPath, nonce),
    log,
  };
}

/** Apply one already-approved update. All mutable operations are injected for tests. */
export async function runApplyUpdate(args, ops = realApplyOperations(args.logPath)) {
  if (args.migrationPlan) {
    const handoff = readMigrationJson(args.migrationPlan);
    const plan = validateMigrationPlan(handoff.plan);
    if (plan.source !== args.sourceApp || plan.target !== args.targetApp || plan.stateDirectory !== realpathSync(args.stateDirectory) || plan.stagedBundle !== args.stagedBundle || plan.stagedRevision !== args.stagedRevision || plan.oldReceipt.sourceClone !== args.sourceClone || handoff.parent?.pid !== args.parentPid || typeof handoff.parent.identity !== "string" || !Number.isInteger(handoff.port) || handoff.port < 1 || handoff.port > 65535) throw new Error("The migration handoff changed.");
    const targetTag = /^[0-9a-f]{40}$/.test(args.targetTag) ? null : args.targetTag;
    if ((targetTag === null && plan.targetIdentity.commit !== args.targetTag) || (targetTag !== null && plan.targetIdentity.version !== targetTag.replace(/^v/, ""))) throw new Error("The migration target does not match the accepted update.");
    if (!plan.kind) updateMigrationReceipt(plan, {releaseTag: targetTag});
    // The journal takes ownership of this private inventory. Do not leave credentials
    // from MCP env settings in a second, unbounded temp handoff after it is consumed.
    const privateManifest = join(dirname(dirname(fileURLToPath(import.meta.url))), "migration-plan.json");
    if (resolve(args.migrationPlan) === privateManifest) rmSync(privateManifest, {force: true});
    const ports = migrationRuntimePorts(handoff);
    const stopTarget = ports.stopTarget;
    ports.stopTarget = async (journal) => {
      await stopTarget(journal);
      await ops.waitForBundle(plan.target);
      await ops.preflight(plan.target);
    };
    if (args.attemptDirectory) ports.helperReady = () => acknowledgeHelper(args.attemptDirectory);
    if (args.recovery) {
      const existing = readMigrationJournal(args.stateDirectory);
      if (args.recovery !== "1" || JSON.stringify(existing?.plan) !== JSON.stringify(plan)) throw new Error("The recovery transaction changed");
      // Recovery must stop its recorded target before waiting for the entire bundle
      // to exit; that target may still be running after the original helper died.
      const recovered = await recoverMigration(args.stateDirectory, ports);
      if (args.attemptDirectory && ["complete", "restored"].includes(recovered?.stage)) finishHelper(args.attemptDirectory);
      return {ok: recovered?.stage === "complete", message: null};
    }
    const waitForSource = ports.waitForParent;
    ports.waitForParent = async () => {
      await ops.preflight(plan.source);
      await ops.preflight(plan.target);
      await waitForSource();
      await ops.waitForBundle(plan.source);
      await ops.waitForBundle(plan.target);
      await ops.preflight(plan.source);
      await ops.preflight(plan.target);
    };
    const result = await runMigration(plan, ports);
    if (args.attemptDirectory && result.committed) finishHelper(args.attemptDirectory);
    if (result.error) ops.log(`migration: ${result.diagnostic ?? result.error}`);
    return {ok: result.committed, message: result.error ?? null};
  }
  const outcomePath = join(args.stateDirectory, "update-outcome.json");
  const receiptPath = join(args.stateDirectory, "install-receipt.json");
  const tempDirectory = dirname(fileURLToPath(import.meta.url));
  const backupApp = join(tempDirectory, "previous-app.bundle");
  const backupReceipt = join(tempDirectory, "previous-receipt.json");
  const retained = join(args.stateDirectory, RETAINED_FAILURE_DIR_NAME);
  const lockDirectory = join(args.stateDirectory, HELPER_LOCK_DIR_NAME);
  const alpha = /^[0-9a-f]{40}$/.test(args.targetTag);
  const targetVersion = alpha ? `alpha ${args.targetTag.slice(0, 7)}` : args.targetTag.replace(/^v/, "");
  let backupReady = false;
  let hadReceipt = false;
  let keepTemporaryBackup = false;
  let heldEntry = null;
  let launchAttempted = false;
  let swapAttempted = false;
  const launchNonce = randomBytes(16).toString("hex");

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
    // A live executable must never be replaced, including on rollback. Only a process
    // carrying our nonce can be stopped. Otherwise preserve the backup for manual recovery.
    let recoverySafe = true;
    if (swapAttempted) {
      try {
        if (launchAttempted) await ops.stopLaunch(args.appPath, launchNonce);
        await ops.waitForBundle(args.appPath);
        await ops.preflight(args.appPath);
      } catch (error) {
        recoverySafe = false;
        message += `. Automatic rollback paused: ${sanitizeDiagnostic(error?.message ?? error)}`;
      }
    }
    if (backupReady && !recoverySafe) keepTemporaryBackup = !retainFailure();
    if (backupReady && recoverySafe && swapAttempted) {
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
        installedCommit: ops.bundleCommit?.(args.appPath),
        backupCommit: ops.bundleCommit?.(backupApp),
        requireCommit: alpha,
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
      // A preflight refusal must not start the racing launcher it just diagnosed.
      if (swapAttempted && recoverySafe) {
        await ops.prepareLaunch(args.appPath);
        await ops.preflight(args.appPath);
        await ops.launch(args.appPath);
      }
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
    if (args.attemptDirectory) acknowledgeHelper(args.attemptDirectory);
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
    await ops.preflight(args.appPath);
    if (args.attemptDirectory) {
      const {parent} = readMigrationJson(join(args.attemptDirectory, "owner.json"));
      await migrationRuntimePorts({parent, port: 1}).waitForParent();
    } else await ops.waitForParent(args.parentPid);
    await ops.waitForBundle(args.appPath);
    await ops.preflight(args.appPath);
    if (!ops.exists(args.appPath)) throw new Error("the installed app is missing before the update");
    ops.copy(args.appPath, backupApp);
    hadReceipt = ops.exists(receiptPath);
    if (hadReceipt) ops.copy(receiptPath, backupReceipt);
    backupReady = true;

    // The backup copy can take time. Do not treat the earlier process inventory as
    // proof that the bundle is still unused at the install boundary.
    await ops.waitForBundle(args.appPath);
    await ops.preflight(args.appPath);
    swapAttempted = true;
    ops.install(
      process.execPath,
      join(args.sourceClone, "scripts", "install-app.mjs"),
      args.targetTag,
      dirname(args.appPath),
      args.stagedBundle ?? null,
      args.stagedRevision ?? null,
      args.stagedDigest ?? null,
    );
    if (alpha && ops.bundleCommit?.(args.appPath) !== args.targetTag) {
      throw new Error("The installed app does not match the requested main commit.");
    }
    await ops.prepareLaunch(args.appPath);
    for (let attempt = 0; attempt < 2; attempt++) {
      await ops.preflight(args.appPath);
      launchAttempted = true;
      try {
        await ops.launch(args.appPath, launchNonce);
        await ops.verifyLaunch(args.appPath, launchNonce);
        break;
      } catch (error) {
        ops.log(`launch attempt ${attempt + 1} failed: ${error?.message ?? error}`);
        if (attempt === 1) throw error;
        await ops.stopLaunch(args.appPath, launchNonce);
        await ops.waitForBundle(args.appPath);
        await ops.prepareLaunch(args.appPath);
      }
    }
    record({ result: "success", targetVersion, recordedAt: ops.nowIso(), launchVerified: true });
    if (args.attemptDirectory) finishHelper(args.attemptDirectory);
    return { ok: true, message: null };
  } catch (error) {
    return await fail(error);
  } finally {
    // Cleanup first, lock released last, so the claim covers everything this helper does rather
    // than most of it. Nothing here needs the lock today - each helper's temp directory is its
    // own, created by a fresh `mkdtemp` per launch, so a later helper could not collide with
    // this removal even if it started early. The ordering is for the invariant: work added to
    // this block later is covered by construction instead of silently running unprotected.
    //
    // The release sits in its own `finally` so a cleanup failure cannot leave the lock held,
    // which would block every future update rather than just this one.
    try {
      // Every exit path except one: a failure that could not file its backup anywhere durable
      // keeps it here instead. Its home is a temp directory, so the OS still reclaims it.
      try { ops.remove(launchAckPath(args.stateDirectory, launchNonce)); }
      catch (error) { ops.log(`could not remove launch acknowledgment: ${error?.message ?? error}`); }
      if (!keepTemporaryBackup) ops.remove(tempDirectory);
    } finally {
      // A helper killed before reaching here leaves its entry behind, which the next helper
      // clears once it can prove the writing process is gone - by pid AND start time, so a
      // reused pid cannot keep a dead helper's claim alive.
      if (heldEntry !== null) {
        try {
          releaseHelperLock(lockDirectory, heldEntry, ops.lock);
        } catch (error) {
          ops.log(`could not release the update lock: ${error?.message ?? error}`);
        }
      }
    }
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
