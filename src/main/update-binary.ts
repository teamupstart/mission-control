import { fork } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { lstatSync, readdirSync, realpathSync, rmSync, existsSync } from "node:fs";
import { atomicMigrationJson, readMigrationJson, readMigrationJournal } from "../../scripts/install-migration.mjs";
import { processIdentity, claimIsLive } from "../../scripts/update-lock.mjs";
import type { StagedInstallDescriptor } from "../../scripts/install-staged-app.mjs";
import type { InstallReceipt } from "../shared/install-receipt-schema.mjs";
import type { UpdatePrepareStage, UpdateTransfer } from "../shared/update.ts";
import type { BinaryOffer } from "./update-binary-release.ts";
import { BinaryUpdateError } from "./update-binary-release.ts";

export interface BinaryStageRequest {
  offer: BinaryOffer;
  receipt: InstallReceipt;
  targetTag: string;
  signal: AbortSignal;
  onStage(stage: UpdatePrepareStage, transfer?: UpdateTransfer): void;
}
export type BinaryStageOutcome = {ok: true; descriptor: StagedInstallDescriptor; staged: {version: string; bundlePath: string; revision: string}}
  | {ok: false; reason: "cancelled" | "failed"; message: string};

/** Abandoned downloads have no recovery obligation. Handed-off candidates stay
 * until the matching transaction and independent helper have both finished. */
export function cleanupBinaryDownloads(stateDirectory: string): void {
  const store = join(realpathSync(stateDirectory), "update-downloads");
  if (!existsSync(store) || lstatSync(store).isSymbolicLink()) return;
  const journal = readMigrationJournal(stateDirectory);
  for (const name of readdirSync(store)) {
    if (!/^attempt-[A-Za-z0-9]+$/.test(name)) continue;
    const directory = join(store, name);
    try {
      if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) continue;
      const marker = readMigrationJson(join(directory, "owner.json"));
      if (marker.protocol !== 1 || marker.path !== realpathSync(directory) || !marker.parent?.identity ||
          claimIsLive(marker.parent) || !marker.worker?.identity || claimIsLive(marker.worker)) continue;
      const handoff = join(directory, "handoff.json");
      if (existsSync(handoff)) {
        const {nonce} = readMigrationJson(handoff);
        if (typeof nonce !== "string" || !/^[a-f0-9]{64}$/.test(nonce) || journal?.plan.nonce !== nonce || !["complete", "restored"].includes(journal.stage)) continue;
        const runtime = join(stateDirectory, "update-runtimes", `attempt-${nonce}`);
        const owner = readMigrationJson(join(runtime, "owner.json"));
        const finished = readMigrationJson(join(runtime, "finished.json"));
        if (!owner.helper?.identity || claimIsLive(owner.helper) || finished.nonce !== nonce ||
            finished.pid !== owner.helper.pid || finished.identity !== owner.helper.identity) continue;
      } else if (journal?.plan.stagedBundle.startsWith(`${directory}/`)) continue;
      rmSync(directory, {recursive: true});
    } catch { /* Unknown ownership or recovery state retains the candidate. */ }
  }
}

/** The parent owns the attempt directory and never offers retry until its worker
 * and subprocess group have settled. A killed worker cannot leave a writer behind. */
export async function stageBinaryUpdate(request: BinaryStageRequest, options: {
  worker: string; stateDirectory: string; gh: string; env: NodeJS.ProcessEnv; log(line: string): void;
}): Promise<BinaryStageOutcome> {
  const store = join(await realpath(options.stateDirectory), "update-downloads");
  await mkdir(store, {recursive: true, mode: 0o700});
  if ((await lstat(store)).isSymbolicLink()) throw new BinaryUpdateError("The update staging directory is not a private installation directory.");
  cleanupBinaryDownloads(options.stateDirectory);
  const directory = await mkdtemp(join(store, "attempt-"));
  const env: NodeJS.ProcessEnv = {...options.env, ELECTRON_RUN_AS_NODE: "1"};
  delete env.NODE_OPTIONS; delete env.NODE_PATH;
  let outcome: BinaryStageOutcome = {ok: false, reason: "failed", message: "Binary preparation stopped unexpectedly. Check again to retry."};
  const parent = {pid: process.pid, identity: processIdentity(process.pid)};
  atomicMigrationJson(join(directory, "owner.json"), {protocol: 1, path: directory,
    parent, worker: null});
  const child = fork(options.worker, [], {execPath: process.execPath, execArgv: [], env, detached: true, stdio: ["ignore", "ignore", "pipe", "ipc"]});
  const killGroup = () => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* Already settled. */ } };
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (child.connected) child.send({kind: "cancel"}, () => {});
    killTimer ??= setTimeout(killGroup, 5_000);
  };
  request.signal.addEventListener("abort", cancel, {once: true});
  const timeout = setTimeout(killGroup, 20 * 60_000);
  try {
    await new Promise<void>(resolve => {
      child.stderr?.on("data", (chunk: Buffer) => options.log(chunk.toString().slice(0, 4096)));
      child.once("error", () => resolve());
      child.once("spawn", () => {
        try {
          atomicMigrationJson(join(directory, "owner.json"), {protocol: 1, path: directory, parent,
            worker: {pid: child.pid, identity: child.pid ? processIdentity(child.pid) : null}});
        } catch { killGroup(); }
      });
      child.on("message", (message: {kind: string; stage?: UpdatePrepareStage; transfer?: UpdateTransfer; descriptor?: StagedInstallDescriptor; message?: string; cancelled?: boolean}) => {
        if (message.kind === "progress" && message.stage && !request.signal.aborted) request.onStage(message.stage, message.transfer);
        if (message.kind === "ready" && message.descriptor) {
          const descriptor = message.descriptor;
          outcome = {ok: true, descriptor, staged: {version: descriptor.receipt.installedVersion, bundlePath: descriptor.bundle, revision: descriptor.revision}};
        }
        if (message.kind === "failed") {
          options.log(`binary preparation failed: ${message.message}`);
          // Only known, fixed worker errors may be shown. Filesystem/OS diagnostics
          // can contain private paths and are retained only in the redacted log.
          const safe = /^(The binary download |The accepted binary asset |GitHub CLI is not authenticated|GitHub rate limited|Binary download timed out|This binary requires a newer macOS|Insufficient free disk space)/.test(message.message ?? "");
          outcome = {ok: false, reason: message.cancelled ? "cancelled" : "failed",
            message: safe ? message.message! : "Binary verification failed. The installed app is unchanged. Check the update log or use the signed installer for recovery."};
        }
      });
      child.once("close", () => resolve());
      child.send({kind: "prepare", work: {offer: request.offer, receipt: request.receipt, directory, gh: options.gh, env: options.env}}, () => {});
      if (request.signal.aborted) cancel();
    });
  } finally {
    clearTimeout(timeout); clearTimeout(killTimer); request.signal.removeEventListener("abort", cancel);
    killGroup();
    if (request.signal.aborted) outcome = {ok: false, reason: "cancelled", message: "Update cancelled"};
    if (!(outcome as BinaryStageOutcome).ok) await rm(directory, {recursive: true, force: true});
  }
  return outcome;
}

export async function discardBinaryUpdate(descriptor: StagedInstallDescriptor, stateDirectory: string): Promise<void> {
  const directory = dirname(dirname(descriptor.bundle));
  const store = join(await realpath(stateDirectory), "update-downloads");
  if (dirname(directory) !== store || !/^attempt-[A-Za-z0-9]+$/.test(directory.slice(store.length + 1)) || await realpath(directory) !== directory) return;
  try {
    const journal = readMigrationJournal(stateDirectory);
    if (journal?.plan.stagedBundle.startsWith(`${directory}/`)) return;
    if (lstatSync(join(directory, "handoff.json"), {throwIfNoEntry: false})) {
      const {nonce} = readMigrationJson(join(directory, "handoff.json"));
      if (typeof nonce !== "string" || !/^[a-f0-9]{64}$/.test(nonce)) return;
      // A failed acknowledgement does not mean the helper stopped. Its runtime
      // attempt survives every uncertain spawn; startup cleanup owns reclamation.
      // A marker without a runtime or journal is safe to discard: spawn failed
      // before creating a child and removed its partial runtime while locked.
      if (lstatSync(join(stateDirectory, "update-runtimes", `attempt-${nonce}`), {throwIfNoEntry: false}) || journal?.plan.nonce === nonce) return;
    }
  } catch { return; /* Unknown handoff or recovery ownership retains the candidate. */ }
  await rm(directory, {recursive: true, force: true});
}

export function retainBinaryHandoff(descriptor: StagedInstallDescriptor, stateDirectory: string, nonce: string): void {
  const directory = dirname(dirname(descriptor.bundle));
  if (dirname(directory) !== join(realpathSync(stateDirectory), "update-downloads")) return;
  atomicMigrationJson(join(directory, "handoff.json"), {nonce});
}
