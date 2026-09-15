// Versioned, Node-only relocation contract. The detached helper owns this journal;
// the target writes a separate acknowledgment and cannot publish its own receipt.
import { randomBytes, createHash } from "node:crypto";
import {
  accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync,
  realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { validateReceipt, isTrustedInstallRepo } from "../src/shared/install-receipt-schema.mjs";
import { stagedBundleRevision } from "../src/shared/staged-bundle.mjs";
import { APP_BUNDLE_NAME, SYSTEM_APPS_DIR, bundleShortVersion, replaceAppBundle } from "./app-bundle-swap.mjs";
import { inspectInstallDirectory, installDirectoryProblem } from "./install-destination.mjs";
import { acquireHelperLock, releaseHelperLock, realHelperLockOperations, parseClaimEntryName, HELPER_LOCK_DIR_NAME } from "./update-lock.mjs";

export const MIGRATION_PROTOCOL = 1;
export const MIGRATION_JOURNAL = "install-migration.json";
export const MIGRATION_ACK = "install-migration-ready.json";
export const MIGRATION_STAGES = ["prepared", "target-staged", "target-ready", "receipt-committed", "repair-required", "complete", "restored"];
export const MIGRATION_TIMEOUT_MS = 120_000;
const NONCE = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const MAX_JOURNAL_BYTES = 256 * 1024;

export function readMigrationJson(path) {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_JOURNAL_BYTES) {
    throw new Error("The migration record is not a bounded regular file.");
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

export function atomicMigrationJson(path, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_JOURNAL_BYTES) throw new Error("The migration record is too large.");
  const temporary = `${path}.${randomBytes(16).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function receiptDigest(receipt) {
  // Stable for field ordering, but includes unknown additive fields. Recovery must not
  // overwrite a receipt another installer or the operator changed in the meantime.
  const ordered = Object.fromEntries(Object.keys(receipt).sort().map((key) => [key, receipt[key]]));
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

export function migrationBundleIdentity(bundle) {
  const stats = lstatSync(bundle);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("The app bundle is not a real directory.");
  const pkg = readMigrationJson(join(bundle, "Contents", "Resources", "app", "package.json"));
  return {
    commit: typeof pkg.missionCommit === "string" && SHA.test(pkg.missionCommit) ? pkg.missionCommit : null,
    version: bundleShortVersion(bundle),
    revision: stagedBundleRevision(stats),
    protocol: pkg.missionInstallMigration?.protocol === MIGRATION_PROTOCOL ? MIGRATION_PROTOCOL : null,
    automatic: pkg.missionInstallMigration?.automatic === true,
  };
}

function sameBuild(found, expected) {
  return found.commit === expected.commit && found.version === expected.version && found.protocol === expected.protocol && found.automatic === expected.automatic;
}

function canonicalDirectory(path) {
  const real = realpathSync(path);
  const stat = statSync(real);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error("The migration directory is not owned by this account.");
  }
  accessSync(real, constants.W_OK | constants.X_OK);
  return real;
}

/** Policy roots are injected only by filesystem tests. Production always uses homedir. */
export function migrationPaths(home = homedir(), systemDirectory = SYSTEM_APPS_DIR) {
  return { source: join(systemDirectory, APP_BUNDLE_NAME), target: join(home, "Applications", APP_BUNDLE_NAME) };
}

export function validateMigrationPaths(plan, { home = homedir(), systemDirectory = SYSTEM_APPS_DIR } = {}) {
  const paths = migrationPaths(home, systemDirectory);
  if (plan.source !== paths.source || plan.target !== paths.target || plan.source === plan.target) {
    throw new Error("The migration does not name this account's system and personal app locations.");
  }
  const realHome = canonicalDirectory(home);
  const problem = installDirectoryProblem(inspectInstallDirectory(dirname(plan.target), home));
  if (problem) throw new Error(problem);
  // A missing Applications directory still requires a writable, owned home, and a
  // dangling symlink is not an absent destination that we are entitled to create.
  if (lstatSync(dirname(plan.target), { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error("The personal Applications directory must not be a symbolic link.");
  }
  if (existsSync(dirname(plan.target)) && realpathSync(dirname(plan.target)) !== join(realHome, "Applications")) {
    throw new Error("The personal destination escapes this account's home.");
  }
  if (existsSync(plan.source) && realpathSync(plan.source) !== join(realpathSync(systemDirectory), APP_BUNDLE_NAME)) {
    throw new Error("The system source must not be a symbolic link.");
  }
  if (canonicalDirectory(plan.stateDirectory) !== plan.stateDirectory) {
    throw new Error("The migration state home must be resolved before preparing the move.");
  }
}

/** Read-only eligibility, after the updater has validated the staged build's pinned ref. */
export function prepareMigration({ receipt, stagedBundle, stagedRevision, stateDirectory, home = homedir(), systemDirectory = SYSTEM_APPS_DIR }) {
  if (validateReceipt(receipt) || !isTrustedInstallRepo(receipt.repo) || receipt.installScope !== undefined) return null;
  const paths = migrationPaths(home, systemDirectory);
  if (receipt.appPath !== paths.source) return null;
  const sourceIdentity = migrationBundleIdentity(paths.source);
  const targetIdentity = migrationBundleIdentity(stagedBundle);
  // No version threshold and no mutable clone claims. An older target deliberately
  // follows the existing in-place helper contract; its next update can relocate.
  if (!sourceIdentity.automatic || sourceIdentity.protocol !== MIGRATION_PROTOCOL || targetIdentity.protocol !== MIGRATION_PROTOCOL) return null;
  if (!sourceIdentity.commit || !targetIdentity.commit || !targetIdentity.version || targetIdentity.revision !== stagedRevision) {
    throw new Error("The migration build identity changed or could not be verified.");
  }
  if (receipt.installedCommit ? receipt.installedCommit !== sourceIdentity.commit : receipt.installedVersion !== sourceIdentity.version) {
    throw new Error("The running system app no longer matches its install receipt.");
  }
  const plan = {
    protocol: MIGRATION_PROTOCOL, nonce: randomBytes(32).toString("hex"),
    ...paths, stateDirectory: realpathSync(stateDirectory), stagedBundle, stagedRevision,
    sourceIdentity, targetIdentity, oldReceipt: receipt,
    intendedReceipt: { ...receipt, appPath: paths.target, installScope: "user", installedCommit: targetIdentity.commit,
      installedVersion: targetIdentity.version, installedAt: new Date().toISOString() },
  };
  validateMigrationPaths(plan, { home, systemDirectory });
  if (lstatSync(plan.target, { throwIfNoEntry: false })) throw new Error("A personal Mission Control already exists. Move it aside yourself before retrying this update.");
  return plan;
}

export function validateMigrationPlan(plan, policy) {
  if (!plan || plan.protocol !== MIGRATION_PROTOCOL || !NONCE.test(plan.nonce ?? "")) throw new Error("Unsupported or invalid migration protocol.");
  if (validateReceipt(plan.oldReceipt) || validateReceipt(plan.intendedReceipt) || !isTrustedInstallRepo(plan.oldReceipt.repo)) throw new Error("Invalid migration receipts.");
  if (plan.oldReceipt.installScope !== undefined || plan.oldReceipt.appPath !== plan.source || plan.intendedReceipt.appPath !== plan.target || plan.intendedReceipt.installScope !== "user") throw new Error("Invalid migration installation policy.");
  if (!SHA.test(plan.sourceIdentity?.commit ?? "") || !SHA.test(plan.targetIdentity?.commit ?? "") || plan.targetIdentity.protocol !== MIGRATION_PROTOCOL || plan.sourceIdentity.protocol !== MIGRATION_PROTOCOL) throw new Error("Invalid migration build identities.");
  if (plan.sourceIdentity.automatic !== true || typeof plan.targetIdentity.automatic !== "boolean" || (plan.oldReceipt.installedCommit ? plan.oldReceipt.installedCommit !== plan.sourceIdentity.commit : plan.oldReceipt.installedVersion !== plan.sourceIdentity.version)) throw new Error("The source identity does not match the eligible legacy receipt.");
  if (plan.intendedReceipt.installedCommit !== plan.targetIdentity.commit || plan.intendedReceipt.installedVersion !== plan.targetIdentity.version || plan.intendedReceipt.repo !== plan.oldReceipt.repo || plan.intendedReceipt.sourceClone !== plan.oldReceipt.sourceClone) throw new Error("The intended receipt does not match the prepared build.");
  if (typeof plan.stagedBundle !== "string" || resolve(plan.stagedBundle) !== plan.stagedBundle || typeof plan.stagedRevision !== "string") throw new Error("Invalid staged migration bundle.");
  validateMigrationPaths(plan, policy);
  return plan;
}

export function readMigrationJournal(stateDirectory, policy) {
  const path = join(stateDirectory, MIGRATION_JOURNAL);
  if (!existsSync(path)) return null;
  const journal = readMigrationJson(path);
  validateMigrationPlan(journal.plan, policy);
  const processRecord = (record) => record && Number.isInteger(record.pid) && record.pid > 0 && typeof record.identity === "string" && record.identity.length > 0 && record.identity.length < 8192;
  if (journal.plan.stateDirectory !== realpathSync(stateDirectory) || !MIGRATION_STAGES.includes(journal.stage) || !processRecord(journal.owner) || !["helper", "recovery"].includes(journal.ownerRole) || (journal.targetProcess !== null && !processRecord(journal.targetProcess)) || !validRepairs(journal.repairs)) throw new Error("Invalid migration journal.");
  return journal;
}

function validRepairs(repairs) {
  return Array.isArray(repairs) && repairs.length <= 32 && repairs.every((item) => item && typeof item.id === "string" && item.id.length <= 80 && ["complete", "pending"].includes(item.status) && typeof item.message === "string" && item.message.length <= 500);
}

export function migrationIsCommitted(journal, receipt) {
  return receipt !== null && receiptDigest(receipt) === receiptDigest(journal.plan.intendedReceipt);
}

function markerPath(bundle) { return join(bundle, ".mission-migration-owner.json"); }
function directoryIdentity(path) { const s = lstatSync(path); return `${s.dev}:${s.ino}`; }

export function ownsMigrationTarget(plan) {
  try {
    if (lstatSync(plan.target).isSymbolicLink()) return false;
    const marker = readMigrationJson(markerPath(plan.target));
    return marker.nonce === plan.nonce && marker.directory === directoryIdentity(plan.target);
  } catch { return false; }
}

/** Receipt-deferred entry at the existing bundle swap primitive. No installer CLI flag
 * can accidentally select it. An exclusive reservation prevents a foreign target from
 * being swapped out; only Contents is published into that attempt-owned directory. */
export function stageMigrationTarget(plan, { policy, checkpoint = () => {} } = {}) {
  validateMigrationPlan(plan, policy);
  const found = migrationBundleIdentity(plan.stagedBundle);
  if (!sameBuild(found, plan.targetIdentity) || found.revision !== plan.stagedRevision) throw new Error("The prepared migration bundle changed.");
  mkdirSync(dirname(plan.target), { recursive: true, mode: 0o755 });
  validateMigrationPaths(plan, policy);
  mkdirSync(plan.target, { mode: 0o700 }); // EEXIST is always a blocker, including a symlink.
  atomicMigrationJson(markerPath(plan.target), { nonce: plan.nonce, directory: directoryIdentity(plan.target) });
  checkpoint("target-reserved");
  const staging = join(dirname(plan.target), `.mission-migration-${plan.nonce}`);
  mkdirSync(staging, { mode: 0o700 });
  const staged = join(staging, APP_BUNDLE_NAME);
  try {
    const swapped = replaceAppBundle({ sourceBundle: plan.stagedBundle, appPath: staged, appsDir: staging, pid: process.pid, sweep: () => [] });
    if (swapped.problem) throw new Error(swapped.problem);
    if (!sameBuild(migrationBundleIdentity(staged), plan.targetIdentity) || (!sameBuild(migrationBundleIdentity(plan.stagedBundle), plan.targetIdentity) || migrationBundleIdentity(plan.stagedBundle).revision !== plan.stagedRevision)) throw new Error("The copied migration build changed.");
    if (!ownsMigrationTarget(plan)) throw new Error("The migration destination was replaced while staging.");
    renameSync(join(staged, "Contents"), join(plan.target, "Contents"));
    checkpoint("target-published");
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function validateMigrationTarget(plan) {
  if (!ownsMigrationTarget(plan) || !sameBuild(migrationBundleIdentity(plan.target), plan.targetIdentity)) throw new Error("The personal migration target is missing or changed. Reinstall the personal app to recover.");
}

export function migrationReceipt(stateDirectory) {
  const receipt = readMigrationJson(join(stateDirectory, "install-receipt.json"));
  if (validateReceipt(receipt)) throw new Error("The install receipt is invalid.");
  return receipt;
}

const localOwners = new Set();
export async function withMigrationLock(stateDirectory, action, lock = realHelperLockOperations()) {
  const directory = join(realpathSync(stateDirectory), HELPER_LOCK_DIR_NAME);
  if (localOwners.has(directory)) throw new Error("Another update or install is in progress. Retry after it finishes.");
  localOwners.add(directory);
  let claim;
  try {
    claim = acquireHelperLock(directory, lock);
    if (!claim.ok) throw new Error("Another update or install is in progress. Retry after it finishes.");
    return await action({ pid: lock.pid, identity: lock.identity(lock.pid) });
  } finally {
    try { if (claim?.ok) releaseHelperLock(directory, claim.entryName, lock); }
    finally { localOwners.delete(directory); }
  }
}

/** Normal managed installers share the receipt lock. Old helpers already hold it and
 * launch the installer as their direct child: recognize that verified parent claim so
 * their unchanged argv stays compatible. Pending migration never delegates a writer. */
export function claimInstallReceiptWriter(stateDirectory) {
  const ops = realHelperLockOperations();
  const directory = join(stateDirectory, HELPER_LOCK_DIR_NAME);
  ops.ensureDirectory(directory);
  const parentClaim = ops.list(directory).some((name) => {
    if (!parseClaimEntryName(name)) return false;
    const entry = ops.readEntry(directory, name);
    return entry?.pid === process.ppid && entry.identity && entry.identity === ops.identity(process.ppid);
  });
  let release = () => {};
  if (!parentClaim) {
    const claim = acquireHelperLock(directory, ops);
    if (!claim.ok) throw new Error("Another update or install is in progress.");
    release = () => releaseHelperLock(directory, claim.entryName, ops);
  }
  try {
    // Read only after ownership: a migration may have committed while we acquired it.
    const pending = readMigrationJournal(stateDirectory);
    if (pending && !["restored", "complete"].includes(pending.stage)) throw new Error("Finish or recover the pending personal installation before running another installer.");
    if (pending) {
      rmSync(join(stateDirectory, MIGRATION_JOURNAL), { force: true });
      rmSync(join(stateDirectory, MIGRATION_ACK), { force: true });
    }
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

export function keepSystemInstallation(plan) {
  return withMigrationLock(plan.stateDirectory, () => {
    validateMigrationPlan(plan);
    const pending = readMigrationJournal(plan.stateDirectory);
    if (pending && !["complete", "restored"].includes(pending.stage)) throw new Error("Finish migration recovery before changing installation policy.");
    if (receiptDigest(migrationReceipt(plan.stateDirectory)) !== receiptDigest(plan.oldReceipt)) throw new Error("The receipt changed. Check for updates again before choosing the installation location.");
    const staged = migrationBundleIdentity(plan.stagedBundle);
    if (!sameBuild(staged, plan.targetIdentity) || staged.revision !== plan.stagedRevision) throw new Error("The prepared update changed. Prepare it again before changing installation policy.");
    const receipt = { ...plan.oldReceipt, installScope: "system" };
    atomicMigrationJson(join(plan.stateDirectory, "install-receipt.json"), receipt);
    return receipt;
  });
}

/** Injectable OS ports keep crash-boundary tests on the real journal and receipt. */
export async function runMigration(plan, ports, { policy, lock } = {}) {
  return withMigrationLock(plan.stateDirectory, async (owner) => {
    validateMigrationPlan(plan, policy);
    if (!owner.identity) throw new Error("Could not identify the migration helper.");
    if (receiptDigest(migrationReceipt(plan.stateDirectory)) !== receiptDigest(plan.oldReceipt) || !sameBuild(migrationBundleIdentity(plan.source), plan.sourceIdentity)) throw new Error("The system installation changed before the migration took ownership.");
    const previous = readMigrationJournal(plan.stateDirectory, policy);
    if (previous && previous.stage !== "restored" && previous.stage !== "complete") throw new Error("An earlier migration needs recovery before another update.");
    if (lstatSync(plan.target, { throwIfNoEntry: false })) throw new Error("The personal migration destination is occupied.");
    const journal = { plan, owner, ownerRole: "helper", stage: "prepared", repairs: [], inventory: ports.inventory, targetProcess: null };
    const publish = (stage) => {
      journal.stage = stage;
      atomicMigrationJson(join(plan.stateDirectory, MIGRATION_JOURNAL), journal);
      ports.checkpoint?.(stage);
    };
    publish("prepared");
    try {
      await ports.waitForParent();
      await ports.waitForDaemonExit();
      stageMigrationTarget(plan, { policy, checkpoint: ports.checkpoint });
      publish("target-staged");
      journal.targetProcess = await ports.launchTarget(plan);
      publish("target-staged");
      await ports.waitForReady(journal);
      validateMigrationTarget(plan);
      publish("target-ready");
      if (receiptDigest(migrationReceipt(plan.stateDirectory)) !== receiptDigest(plan.oldReceipt)) throw new Error("The install receipt changed before migration commitment.");
      atomicMigrationJson(join(plan.stateDirectory, "install-receipt.json"), plan.intendedReceipt);
      ports.checkpoint?.("receipt-renamed");
      publish("receipt-committed");
      // The target waits until this helper releases the lock before taking repair ownership.
      return { committed: true, journal };
    } catch (error) {
      // A crash injection deliberately models process death, including no finally cleanup.
      if (error?.migrationCrash) throw error;
      if (migrationIsCommitted(journal, migrationReceipt(plan.stateDirectory))) {
        journal.repairs = [{ id: "startup", status: "pending", message: "The personal installation committed. Reopen it to finish startup and integration repair." }];
        publish("repair-required");
        return { committed: true, journal, error: String(error.message ?? error) };
      }
      await restoreMigration(journal, ports, policy);
      return { committed: false, journal, error: String(error.message ?? error) };
    }
  }, lock);
}

export async function restoreMigration(journal, ports, policy) {
  const { plan } = journal;
  validateMigrationPlan(plan, policy);
  if (receiptDigest(migrationReceipt(plan.stateDirectory)) !== receiptDigest(plan.oldReceipt)) throw new Error("The receipt changed. Recovery left both bundles untouched; inspect the installation before retrying.");
  if (!sameBuild(migrationBundleIdentity(plan.source), plan.sourceIdentity)) throw new Error("The retained system app changed. Recovery will not launch it.");
  // The port must prove PID plus start/command identity before signalling anything.
  await ports.stopTarget(journal);
  if (ownsMigrationTarget(plan)) rmSync(plan.target, { recursive: true, force: true });
  journal.stage = "restored";
  journal.repairs = [];
  journal.inventory = null;
  atomicMigrationJson(join(plan.stateDirectory, MIGRATION_JOURNAL), journal);
  atomicMigrationJson(join(plan.stateDirectory, "update-outcome.json"), {
    schema: 1, result: "failure", targetVersion: plan.targetIdentity.version,
    recordedAt: new Date().toISOString(),
    message: "The personal installation did not commit. The retained system app and previous receipt are unchanged. Check the update log, then prepare the update again.",
  });
  await ports.launchSource(plan.source);
}

/** Recovery and post-start repair explicitly acquire the same lock after the helper exits. */
export async function recoverMigration(stateDirectory, ports, { policy, lock } = {}) {
  return withMigrationLock(stateDirectory, async (owner) => {
    const journal = readMigrationJournal(stateDirectory, policy);
    if (!journal || journal.stage === "restored" || journal.stage === "complete") return journal;
    if (!owner.identity) throw new Error("Could not identify the recovery owner.");
    if (!migrationIsCommitted(journal, migrationReceipt(stateDirectory))) {
      if (["receipt-committed", "repair-required"].includes(journal.stage)) throw new Error("The committed personal receipt changed. Reinstall the personal app; do not restore the older system runtime.");
      await restoreMigration(journal, ports, policy);
      return journal;
    }
    validateMigrationTarget(journal.plan);
    journal.owner = owner;
    journal.ownerRole = "recovery";
    journal.stage = "receipt-committed";
    atomicMigrationJson(join(stateDirectory, MIGRATION_JOURNAL), journal);
    return journal;
  }, lock);
}

export async function repairMigration(stateDirectory, repair, { policy, lock } = {}) {
  return withMigrationLock(stateDirectory, async (owner) => {
    const journal = readMigrationJournal(stateDirectory, policy);
    if (!journal || journal.stage === "complete" || journal.stage === "restored") return journal;
    if (!migrationIsCommitted(journal, migrationReceipt(stateDirectory))) throw new Error("The personal receipt changed; repair was not started.");
    validateMigrationTarget(journal.plan);
    journal.owner = owner;
    journal.ownerRole = "recovery";
    journal.stage = "repair-required";
    atomicMigrationJson(join(stateDirectory, MIGRATION_JOURNAL), journal);
    journal.repairs = await repair(journal);
    if (!validRepairs(journal.repairs)) throw new Error("Invalid integration repair results.");
    journal.stage = journal.repairs.every((r) => r.status === "complete") ? "complete" : "repair-required";
    if (journal.stage === "complete") journal.inventory = null;
    atomicMigrationJson(join(stateDirectory, MIGRATION_JOURNAL), journal);
    return journal;
  }, lock);
}
