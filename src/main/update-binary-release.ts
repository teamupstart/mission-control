import { createHash } from "node:crypto";
import { BINARY_REPO, validateBinaryManifest, type BinaryManifest } from "../shared/binary-distribution.mjs";
import { BINARY_MANIFEST_NAME, MAX_BINARY_MANIFEST_BYTES, binaryReleaseTag } from "../shared/binary-publisher-policy.mjs";
import { isNewerVersion, versionFromReleaseTag } from "../shared/update.ts";
import type { GhRunner, ReleaseInfo } from "./updater.ts";

export interface BinaryOffer {
  manifest: BinaryManifest;
  manifestText: string;
  manifestSha256: string;
}

/** Only fixed, credential-free messages cross the renderer boundary. */
export class BinaryUpdateError extends Error {}

export const BINARY_PENDING = "The signed binary for this exact build is pending or unavailable. Check again later, or use the signed installer for recovery.";
const root = `repos/${BINARY_REPO}`;
const id = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
type Asset = {id: number; name: string; size: number; state: string};
type Release = {id: number; tag_name: string; name: string; published_at: string; body: string; draft: boolean; prerelease: boolean; assets: Asset[]};

async function query(run: GhRunner, endpoint: string, missing = false): Promise<unknown> {
  const response = await run(["api", "--hostname", "github.com", `${root}/${endpoint}`]);
  if (missing && response.code !== 0 && /HTTP 404/.test(response.stderr)) return null;
  if (response.code !== 0) {
    // Share authentication/rate-limit policy with ordinary update checks.
    const { ghFailure } = await import("./updater.ts");
    throw ghFailure(response);
  }
  try { return JSON.parse(response.stdout); }
  catch { throw new BinaryUpdateError("GitHub returned unreadable binary availability. Check again."); }
}

async function pages<T>(run: GhRunner, endpoint: string, options: {include?: (item: T) => boolean; maxPages?: number} = {}): Promise<T[]> {
  const result: T[] = [];
  for (let page = 1; page <= (options.maxPages ?? 10); page++) {
    const batch = await query(run, `${endpoint}?per_page=30&page=${page}`);
    if (!Array.isArray(batch) || batch.length > 30) throw new BinaryUpdateError("GitHub returned an invalid binary inventory.");
    result.push(...(options.include ? batch.filter(options.include) : batch));
    if (result.length > 300) break;
    if (batch.length < 30) return result;
  }
  throw new BinaryUpdateError("Binary discovery exceeded its inventory limit. Use the signed installer or check again later.");
}

async function readyOffer(run: GhRunner, release: Release, channel: "stable" | "alpha", commit?: string): Promise<BinaryOffer | null> {
  if (!id(release.id) || release.draft || release.prerelease !== (channel === "alpha")) return null;
  const assets = await pages<Asset>(run, `releases/${release.id}/assets`);
  const markers = assets.filter((asset) => asset.name === BINARY_MANIFEST_NAME);
  if (!markers.length) return null;
  if (markers.length !== 1 || !id(markers[0]!.id) || markers[0]!.state !== "uploaded" ||
      markers[0]!.size < 1 || markers[0]!.size > MAX_BINARY_MANIFEST_BYTES) {
    throw new BinaryUpdateError("The published binary manifest is invalid. No update was downloaded.");
  }
  const response = await run(["api", "--hostname", "github.com", `${root}/releases/assets/${markers[0]!.id}`, "-H", "Accept: application/octet-stream"]);
  if (response.code !== 0 && /HTTP 404/.test(response.stderr)) return null;
  if (response.code !== 0) { const { ghFailure } = await import("./updater.ts"); throw ghFailure(response); }
  let manifest: BinaryManifest;
  try {
    if (Buffer.byteLength(response.stdout) !== markers[0]!.size || Buffer.byteLength(response.stdout) > MAX_BINARY_MANIFEST_BYTES) throw new Error();
    manifest = JSON.parse(response.stdout);
    if (validateBinaryManifest(manifest) || manifest.assets.length !== 2 || manifest.channel !== channel ||
        binaryReleaseTag(manifest) !== release.tag_name || (commit && manifest.commit !== commit)) throw new Error();
  } catch { throw new BinaryUpdateError("The binary manifest has an incompatible protocol, platform, or build identity. Use the signed installer for recovery."); }
  for (const asset of manifest.assets) {
    const matching = assets.filter((entry) => String(entry.id) === asset.id && entry.name === asset.name && entry.size === asset.bytes && entry.state === "uploaded");
    if (matching.length !== 1 || assets.filter((entry) => entry.name === asset.name).length !== 1) return null;
  }
  const tagged = await query(run, `commits/${release.tag_name}`) as {sha?: string};
  if (tagged?.sha !== manifest.commit) throw new BinaryUpdateError("The published tag no longer matches the binary build. No update was downloaded.");
  return {manifest, manifestText: response.stdout, manifestSha256: createHash("sha256").update(response.stdout).digest("hex")};
}

export async function latestStableBinary(run: GhRunner): Promise<ReleaseInfo | null> {
  // Ineligible records do not consume the 300-candidate budget. Bound the scan
  // separately at 100 pages; GitHub's inventory order is not semver order, so
  // only a complete scan can establish the newest eligible stable release.
  const releases = (await pages<Release>(run, "releases", {maxPages: 100,
    include: release => Boolean(release && !release.draft && !release.prerelease && typeof release.tag_name === "string" && versionFromReleaseTag(release.tag_name))}))
    // isNewerVersion(current, candidate): a newer b must sort before a.
    .sort((a, b) => isNewerVersion(a.tag_name, b.tag_name) ? 1 : isNewerVersion(b.tag_name, a.tag_name) ? -1 : 0);
  let unavailable: ReleaseInfo | null = null;
  for (const release of releases) {
    const info: ReleaseInfo = {tagName: release.tag_name, name: typeof release.name === "string" ? release.name : release.tag_name,
      publishedAt: release.published_at, body: typeof release.body === "string" ? release.body : "", isDraft: false, isPrerelease: false};
    unavailable ??= {...info, unavailable: BINARY_PENDING};
    const binary = await readyOffer(run, release, "stable");
    if (binary) return {...info, binary};
  }
  return unavailable;
}

export async function binaryForCommit(run: GhRunner, commit: string): Promise<BinaryOffer | null> {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new BinaryUpdateError("Invalid alpha commit identity.");
  const release = await query(run, `releases/tags/alpha-${commit}`, true) as Release | null;
  return release ? readyOffer(run, release, "alpha", commit) : null;
}
