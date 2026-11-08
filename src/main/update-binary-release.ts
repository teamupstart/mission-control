import { createHash } from "node:crypto";
import { BINARY_REPO, validateBinaryManifest, type BinaryManifest } from "../shared/binary-distribution.mjs";
import { BINARY_MANIFEST_NAME, MAX_BINARY_MANIFEST_BYTES, binaryReleaseTag } from "../shared/binary-publisher-policy.mjs";
import { APP_BUNDLE_NAME, binaryBundleName } from "../shared/app-naming.mjs";
import { isNewerVersion, versionFromReleaseTag } from "../shared/update.ts";
import type { GhRunner, MainCommitInfo, ReleaseInfo } from "./updater.ts";

export interface BinaryOffer {
  manifest: BinaryManifest;
  manifestText: string;
  manifestSha256: string;
}

/** Only fixed, credential-free messages cross the renderer boundary. */
export class BinaryUpdateError extends Error {}

/** An exact build that is published, but can never update this installation. */
export interface UnavailableBinary {
  unavailable: string;
}

/**
 * What discovery established about one release.
 *
 * `building` and `unavailable` both mean "nothing to install", and the difference is the whole
 * point: only a build that has not finished publishing - no release yet, no ready manifest, or
 * assets still uploading - may be reported as still being signed. A complete manifest for an app
 * this installation cannot become is published and finished, and keeps its blocked offer.
 */
type Readiness =
  | {state: "ready"; binary: BinaryOffer; tagged: TaggedCommit}
  | {state: "building"}
  | {state: "unavailable"};

export const BINARY_PENDING = "The signed binary for this exact build is pending or unavailable. Check again later, or use the signed installer for recovery.";
const root = `repos/${BINARY_REPO}`;
const id = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
type Asset = {id: number; name: string; size: number; state: string};
type Release = {id: number; tag_name: string; name: string; published_at: string; body: string; draft: boolean; prerelease: boolean; assets: Asset[]};
type TaggedCommit = {sha?: unknown; commit?: {message?: unknown; committer?: {date?: unknown}}};
const ALPHA_TAG = /^alpha-[a-f0-9]{40}$/;
const SHA = /^[a-f0-9]{40}$/;

async function query(run: GhRunner, endpoint: string, missing = false, extra: string[] = []): Promise<unknown> {
  const response = await run(["api", "--hostname", "github.com", `${root}/${endpoint}`, ...extra]);
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

async function readyOffer(run: GhRunner, release: Release, channel: "stable" | "alpha", commit?: string): Promise<Readiness> {
  if (!id(release.id) || release.draft || release.prerelease !== (channel === "alpha")) return {state: "unavailable"};
  const assets = await pages<Asset>(run, `releases/${release.id}/assets`);
  const markers = assets.filter((asset) => asset.name === BINARY_MANIFEST_NAME);
  // The publisher uploads the ready manifest last, so its absence is a build still publishing.
  if (!markers.length) return {state: "building"};
  if (markers.length !== 1 || !id(markers[0]!.id) || markers[0]!.state !== "uploaded" ||
      markers[0]!.size < 1 || markers[0]!.size > MAX_BINARY_MANIFEST_BYTES) {
    throw new BinaryUpdateError("The published binary manifest is invalid. No update was downloaded.");
  }
  const response = await run(["api", "--hostname", "github.com", `${root}/releases/assets/${markers[0]!.id}`, "-H", "Accept: application/octet-stream"]);
  if (response.code !== 0 && /HTTP 404/.test(response.stderr)) return {state: "building"};
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
    if (matching.length !== 1 || assets.filter((entry) => entry.name === asset.name).length !== 1) return {state: "building"};
  }
  const tagged = await query(run, `commits/${release.tag_name}`) as TaggedCommit | null;
  if (tagged?.sha !== manifest.commit) throw new BinaryUpdateError("The published tag no longer matches the binary build. No update was downloaded.");
  // Historical manifests remain readable for receipts and recovery, but a new
  // update must satisfy the same app-name policy as the installation writer.
  if (binaryBundleName(manifest) !== APP_BUNDLE_NAME) return {state: "unavailable"};
  return {state: "ready", binary: {manifest, manifestText: response.stdout, manifestSha256: createHash("sha256").update(response.stdout).digest("hex")}, tagged};
}

export async function latestStableBinary(run: GhRunner, installedVersion: string): Promise<ReleaseInfo | null> {
  // Ineligible records do not consume the 300-candidate budget. Bound the scan
  // separately at 100 pages; GitHub's inventory order is not semver order, so
  // only a complete scan can establish the newest eligible stable release.
  const releases = (await pages<Release>(run, "releases", {maxPages: 100,
    include: release => Boolean(release && !release.draft && !release.prerelease && typeof release.tag_name === "string" && versionFromReleaseTag(release.tag_name))}))
    // isNewerVersion(current, candidate): a newer b must sort before a.
    .sort((a, b) => isNewerVersion(a.tag_name, b.tag_name) ? 1 : isNewerVersion(b.tag_name, a.tag_name) ? -1 : 0);
  let unavailable: ReleaseInfo | null = null;
  for (const release of releases) {
    // An older complete build cannot update this installation. Keep the newer
    // pending offer so the controller can explain availability and offer retry.
    if (unavailable && !isNewerVersion(installedVersion, release.tag_name)) return unavailable;
    const info: ReleaseInfo = {tagName: release.tag_name, name: typeof release.name === "string" ? release.name : release.tag_name,
      publishedAt: release.published_at, body: typeof release.body === "string" ? release.body : "", isDraft: false, isPrerelease: false};
    const readiness = await readyOffer(run, release, "stable");
    // An older complete build still upgrades this installation. When the newer one is only
    // still publishing, name it so the offer can say why it is not the newest.
    if (readiness.state === "ready") return {...info, binary: readiness.binary, ...(unavailable?.building ? {pending: unavailable.tagName} : {})};
    unavailable ??= {...info, unavailable: BINARY_PENDING, ...(readiness.state === "building" ? {building: true} : {})};
  }
  return unavailable;
}

/**
 * The exact alpha for `commit`: its offer, null while its signed build is still publishing (the
 * release record itself is created only at publication), or an unavailable marker when it is
 * published but can never update this installation.
 */
export async function binaryForCommit(run: GhRunner, commit: string): Promise<BinaryOffer | UnavailableBinary | null> {
  if (!SHA.test(commit)) throw new BinaryUpdateError("Invalid alpha commit identity.");
  const release = await query(run, `releases/tags/alpha-${commit}`, true) as Release | null;
  if (!release) return null;
  const readiness = await readyOffer(run, release, "alpha", commit);
  return readiness.state === "ready" ? readiness.binary : readiness.state === "building" ? null : {unavailable: BINARY_PENDING};
}

export interface ReadyAlpha {
  commit: MainCommitInfo;
  binary: BinaryOffer;
}

/** Whether `descendant` is strictly newer than `ancestor` on one line of canonical history. */
async function strictlyFollows(run: GhRunner, ancestor: string, descendant: string): Promise<boolean> {
  // Only two fields cross back: a full comparison carries every changed file and patch.
  const comparison = await query(run, `compare/${ancestor}...${descendant}`, true,
    ["--jq", "{status: .status, base: .merge_base_commit.sha}"]) as {status?: unknown; base?: unknown} | null;
  return comparison?.status === "ahead" && comparison.base === ancestor;
}

/**
 * The newest complete alpha that still upgrades `installed`, for when the signed build of
 * main's tip `head` is not published yet.
 *
 * Every merge to main starts a signed build that takes a while, and the publisher retires the
 * previous alpha only after its replacement is verified. So while the tip is building, the last
 * complete alpha is still published - and when it is newer than the installation, it is a real
 * upgrade the person should not have to wait for. A candidate must strictly follow the
 * installed commit and strictly precede the observed tip, so an offer never leaves canonical
 * main and never moves an installation sideways or backwards.
 */
export async function latestReadyAlpha(run: GhRunner, installed: string, head: string): Promise<ReadyAlpha | null> {
  if (!SHA.test(installed) || !SHA.test(head)) throw new BinaryUpdateError("Invalid alpha commit identity.");
  const releases = (await pages<Release>(run, "releases", {maxPages: 100,
    include: release => Boolean(release && !release.draft && release.prerelease === true && typeof release.tag_name === "string" && ALPHA_TAG.test(release.tag_name))}))
    .filter(release => release.tag_name !== `alpha-${installed}` && release.tag_name !== `alpha-${head}`)
    // Newest first, so the usual single retained alpha is found before any leftover record.
    .sort((a, b) => (Date.parse(b.published_at) || 0) - (Date.parse(a.published_at) || 0));
  let best: ReadyAlpha | null = null;
  for (const release of releases) {
    const sha = release.tag_name.slice("alpha-".length);
    // Following a candidate already found implies following the installation as well.
    if (!await strictlyFollows(run, best?.commit.sha ?? installed, sha) || !await strictlyFollows(run, sha, head)) continue;
    const ready = await readyOffer(run, release, "alpha", sha);
    if (ready.state !== "ready") continue;
    const message = ready.tagged.commit?.message;
    const date = ready.tagged.commit?.committer?.date;
    best = {binary: ready.binary, commit: {sha, message: typeof message === "string" ? message : "",
      committedAt: typeof date === "string" && Number.isFinite(Date.parse(date)) ? date : release.published_at}};
  }
  return best;
}
