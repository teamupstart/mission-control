// OS ports for the relocation protocol. All waits have deadlines; all signals require
// the recorded process identity, never just a PID that macOS may have reused.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { APP_BUNDLE_NAME } from "./app-bundle-swap.mjs";
import { processIdentity, processIsAlive } from "./update-lock.mjs";
import {
  MIGRATION_ACK, MIGRATION_JOURNAL, MIGRATION_TIMEOUT_MS, atomicMigrationJson,
  readMigrationJson, readMigrationJournal, migrationIsCommitted, migrationReceipt,
  validateMigrationTarget, recoverMigration,
} from "./install-migration.mjs";

export const migrationDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function boundedMigrationWait(predicate, message, { timeout = MIGRATION_TIMEOUT_MS, delay = migrationDelay } = {}) {
  const deadline = Date.now() + timeout;
  do {
    if (await predicate()) return;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(message);
}

export function sameMigrationProcess(record) {
  if (!record || !processIsAlive(record.pid)) return false;
  const current = processIdentity(record.pid);
  return current === null || !record.identity || current === record.identity;
}

export function migrationPortOccupied(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(600);
    const finish = (occupied) => { socket.destroy(); resolve(occupied); };
    socket.once("connect", () => finish(true));
    socket.once("error", (error) => finish(error.code !== "ECONNREFUSED"));
    socket.once("timeout", () => finish(true));
  });
}

async function spawnMigrationApp(path, args, env = process.env) {
  const appEnv = {...env};
  delete appEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(path, args, { detached: true, stdio: "ignore", env: appEnv });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
  let identity = null;
  await boundedMigrationWait(() => {
    identity = processIdentity(child.pid);
    if (!processIsAlive(child.pid)) throw new Error("The personal app exited before it could identify itself.");
    return identity !== null;
  }, "Could not identify the personal app process.", { timeout: 5000 });
  return { pid: child.pid, identity };
}

export function migrationRuntimePorts({ parent, port, inventory, checkpoint, timeout = MIGRATION_TIMEOUT_MS }) {
  return {
    inventory, checkpoint,
    waitForParent: () => boundedMigrationWait(() => !sameMigrationProcess(parent), "The system app did not exit before migration. Close it and retry."),
    waitForDaemonExit: () => boundedMigrationWait(async () => !await migrationPortOccupied(port), "A background Mission Control daemon is still running. Stop it, then retry the update."),
    launchTarget: (plan) => spawnMigrationApp(join(plan.target, "Contents", "MacOS", "Mission Control"), ["--mission-migration", plan.nonce]),
    waitForReady: (journal) => boundedMigrationWait(() => {
      if (!sameMigrationProcess(journal.targetProcess)) throw new Error("The personal app exited before confirming readiness.");
      if (processIdentity(journal.targetProcess.pid) !== journal.targetProcess.identity) return false;
      const path = join(journal.plan.stateDirectory, MIGRATION_ACK);
      if (!existsSync(path)) return false;
      const ack = readMigrationJson(path);
      return ack.nonce === journal.plan.nonce && ack.pid === journal.targetProcess.pid &&
        ack.identity === journal.targetProcess.identity && ack.commit === journal.plan.targetIdentity.commit &&
        ack.stateDirectory === journal.plan.stateDirectory && ack.bundle === journal.plan.target;
    }, "The personal app did not confirm readiness before the migration timeout.", {timeout}),
    stopTarget: async (journal) => {
      const record = journal.targetProcess;
      if (!record || !record.identity || processIdentity(record.pid) !== record.identity || !sameMigrationProcess(record) || record.pid === process.pid) return;
      process.kill(record.pid, "SIGTERM");
      try {
        await boundedMigrationWait(() => !sameMigrationProcess(record), "The migration target did not stop.", { timeout: 5000 });
      } catch {
        if (processIdentity(record.pid) === record.identity && sameMigrationProcess(record)) process.kill(record.pid, "SIGKILL");
        await boundedMigrationWait(() => !sameMigrationProcess(record), "The migration target could not be stopped.", { timeout: 5000 });
      }
    },
    launchSource: async (source) => {
      await spawnMigrationApp(join(source, "Contents", "MacOS", "Mission Control"), []);
    },
  };
}

/** Read-only asset check, before a daemon, SQLite, session restore or an agent starts. */
export function verifyMigrationAssets(bundle) {
  const root = join(bundle, "Contents", "Resources", "app");
  for (const relative of ["dist/main/index.cjs", "dist/preload/index.cjs", "dist/server/index.mjs", "dist/server/foreman-worker.mjs", "dist/web/index.html", "dist/mcp/server.mjs", "dist/satellites/hook.mjs", "dist/native/state-lock.node", "scripts/apply-update.mjs"]) {
    if (readFileSync(join(root, relative)).length === 0) throw new Error(`The personal app is missing a required packaged asset: ${relative}`);
  }
  createRequire(join(root, "package.json"))(join(root, "dist/native/state-lock.node"));
  for (const relative of ["dist/server/index.mjs", "dist/server/foreman-worker.mjs", "dist/mcp/server.mjs"]) {
    const result = spawnSync(process.execPath, ["--check", join(root, relative)], {env: {...process.env, ELECTRON_RUN_AS_NODE: "1"}, stdio: "pipe", timeout: 10_000});
    if (result.error || result.status !== 0) throw new Error(`A packaged module could not be parsed: ${relative}`);
  }
}

/** The main entry calls this before its ordinary single-instance/redirect decision. */
export async function migrationStartupGate({ stateDirectory, runningBundle, nonce, port, policy, timeout = MIGRATION_TIMEOUT_MS }) {
  if (!existsSync(join(stateDirectory, MIGRATION_JOURNAL))) {
    if (nonce) throw new Error("The migration launch has no matching transaction.");
    return { proceed: true, committed: false, fresh: false };
  }
  let journal = readMigrationJournal(stateDirectory, policy);
  if (journal.stage === "restored" && nonce) throw new Error("This migration attempt was restored. Open the retained system app.");
  if (journal.stage === "complete" || journal.stage === "restored") return { proceed: true, committed: journal.stage === "complete", fresh: false };
  const { plan } = journal;
  const ports = migrationRuntimePorts({ port });
  const target = runningBundle === plan.target;
  if (nonce && (nonce !== plan.nonce || !target)) throw new Error("This launch does not belong to the pending migration.");
  if (journal.ownerRole === "recovery" && sameMigrationProcess(journal.owner) && migrationIsCommitted(journal, migrationReceipt(stateDirectory))) {
    validateMigrationTarget(plan);
    // The personal main process may stay alive with unresolved repairs. A second
    // launch can now use the ordinary redirect/single-instance path immediately.
    return {proceed: true, committed: true, fresh: false};
  }
  if (target && !migrationIsCommitted(journal, migrationReceipt(stateDirectory))) {
    if (!nonce || !sameMigrationProcess(journal.owner)) throw new Error("An uncommitted personal app cannot start. Reopen the system app to recover the interrupted update.");
    validateMigrationTarget(plan);
    if (realpathSync(runningBundle) !== join(realpathSync(dirname(plan.target)), APP_BUNDLE_NAME)) throw new Error("The migration target resolves to another app.");
    verifyMigrationAssets(plan.target);
    if (await migrationPortOccupied(port)) throw new Error("A previous daemon still owns the runtime port. Migration readiness was refused.");
    const identity = processIdentity(process.pid);
    if (!identity) throw new Error("The personal app could not prove its process identity.");
    atomicMigrationJson(join(stateDirectory, MIGRATION_ACK), {
      nonce, pid: process.pid, identity, bundle: runningBundle,
      commit: plan.targetIdentity.commit, stateDirectory: plan.stateDirectory,
    });
  }
  await boundedMigrationWait(() => !sameMigrationProcess(journal.owner), "An update helper is still running. Reopen Mission Control after it finishes.", { timeout });
  journal = await recoverMigration(stateDirectory, ports, { policy });
  if (journal?.stage === "restored") return { proceed: runningBundle === plan.source, committed: false, fresh: false };
  // A committed target starts only after forward recovery published its marker. The
  // retained source continues to the ordinary validated redirect, never a daemon.
  return { proceed: true, committed: true, fresh: true };
}
