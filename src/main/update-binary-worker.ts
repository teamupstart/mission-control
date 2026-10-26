// Runs in the current app's embedded Node, before replacement. Long hashing and
// OS signature checks cannot block Electron's main thread or its Cancel control.
import { dirname, join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { binaryPublisherPolicy } from "../shared/binary-publisher-policy.mjs";
import { createHash } from "node:crypto";
import { binaryInstallReceipt } from "../../scripts/binary-install-policy.mjs";
import { prepareStagedInstall, requireInstallSpace } from "../../scripts/install-staged-app.mjs";
import type { InstallReceipt, BinaryInstallReceipt } from "../shared/install-receipt-schema.mjs";
import type { BinaryOffer } from "./update-binary-release.ts";
import { extractBinaryArchive } from "./update-binary-archive.ts";
import { verifyBinaryPlatform } from "./update-binary-platform.ts";
import { downloadBinaryAsset } from "./update-binary-download.ts";

export interface BinaryWork {
  offer: BinaryOffer; receipt: InstallReceipt; directory: string; gh: string; env: NodeJS.ProcessEnv;
}

export function binaryUpdateReceipt(offer: BinaryOffer, previous: InstallReceipt): BinaryInstallReceipt {
  const receipt = binaryInstallReceipt(offer.manifestText,
    {appsDir: dirname(previous.appPath), installScope: previous.installScope ?? null, problem: null}, previous,
    new Date().toISOString(), "app-zip");
  if (createHash("sha256").update(offer.manifestText).digest("hex") !== offer.manifestSha256 ||
      JSON.stringify(receipt.provenance.manifest) !== JSON.stringify(offer.manifest)) throw new Error("The accepted manifest changed before preparation");
  return receipt;
}


if (process.send) {
  const abort = new AbortController();
  const send = (message: unknown) => {
    if (process.connected) process.send?.(message, () => {});
  };
  let started = false;
  process.on("disconnect", () => abort.abort());
  process.on("message", (message: {kind: string; work?: BinaryWork}) => {
    if (message.kind === "cancel") { abort.abort(); return; }
    if (message.kind !== "prepare" || !message.work || started) return;
    started = true;
    const work = message.work;
    void (async () => {
      try {
        const receipt = binaryUpdateReceipt(work.offer, work.receipt);
        const asset = work.offer.manifest.assets.find(asset => asset.kind === "app-zip")!;
        // Reserve the archive first, then the validated central-directory expansion.
        // The transaction later budgets measured runtime and recovery copies.
        requireInstallSpace([{path: work.directory, bytes: asset.bytes}]);
        const archive = join(work.directory, "app.zip");
        await downloadBinaryAsset({command: work.gh, env: work.env, asset, path: archive, signal: abort.signal,
          onBytes: (received, total) => send({kind: "progress", stage: "download", transfer: {received, total}})});
        send({kind: "progress", stage: "extract"});
        const expanded = join(work.directory, "expanded");
        await mkdir(expanded, {mode: 0o700});
        const bundle = await extractBinaryArchive(archive, expanded, abort.signal, undefined, bytes => requireInstallSpace([{path: work.directory, bytes}]));
        await rm(archive);
        abort.signal.throwIfAborted();
        send({kind: "progress", stage: "signature"});
        verifyBinaryPlatform(bundle, receipt);
        const descriptor = prepareStagedInstall({bundle, receipt, publisher: binaryPublisherPolicy()});
        abort.signal.throwIfAborted();
        send({kind: "ready", descriptor});
      } catch (error) {
        send({kind: "failed", cancelled: abort.signal.aborted,
          message: error instanceof Error ? error.message : "Binary preparation failed"});
      } finally { if (process.connected) process.disconnect(); }
    })();
  });
}
