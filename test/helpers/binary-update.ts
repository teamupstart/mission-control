import { createHash } from "node:crypto";
import type { BinaryOffer } from "../../src/main/update-binary-release.ts";
import type { BinaryStageRequest, BinaryStageOutcome } from "../../src/main/update-binary.ts";
import type { InstallReceipt } from "../../src/shared/install-receipt-schema.mjs";

export function binaryOffer(commit = "b".repeat(40), channel: "stable" | "alpha" = "stable", version = "1.2.4"): BinaryOffer {
  const manifest: BinaryOffer["manifest"] = {protocol: 1, repo: "teamupstart/mission-control", channel,
    releaseTag: channel === "stable" ? `v${version}` : null, version, commit, platform: "darwin", arch: "arm64",
    bundleId: "com.mission-control.app", minimumSystemVersion: "12.0", helperProtocol: {min: 1, max: 1}, assets: [
      {kind: "app-zip", id: "123", name: "app.zip", bytes: 100, sha256: "e".repeat(64)},
      {kind: "dmg", id: "124", name: "app.dmg", bytes: 120, sha256: "f".repeat(64)},
    ]};
  const manifestText = JSON.stringify(manifest);
  return {manifest, manifestText, manifestSha256: createHash("sha256").update(manifestText).digest("hex")};
}

export function binaryReceipt(offer: BinaryOffer, previous: InstallReceipt): InstallReceipt {
  return {schema: 2, kind: "binary", repo: offer.manifest.repo, appPath: previous.appPath, installedVersion: offer.manifest.version,
    installedCommit: offer.manifest.commit, releaseTag: offer.manifest.releaseTag, installedAt: "2026-10-25T00:00:00Z",
    ...(previous.installScope ? {installScope: previous.installScope} : {}),
    provenance: {manifest: offer.manifest, manifestSha256: offer.manifestSha256, assetId: "123"}};
}

export function binaryStaged(request: Pick<BinaryStageRequest, "offer" | "receipt">, bundlePath: string, revision = "staged-1"): Extract<BinaryStageOutcome, {ok: true}> {
  return {ok: true, staged: {bundlePath, revision, version: request.offer.manifest.version},
    descriptor: {protocol: 1, bundle: bundlePath, revision, digest: "a".repeat(64), bytes: 100,
      receipt: binaryReceipt(request.offer, request.receipt), publisher: {teamId: "S2FPCQK39Z", notarized: true}}};
}
