import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import {
  ARCHIVE_LIMITS,
  ARCHIVE_PRIMARY_REPORT_PATH,
  ARCHIVE_REPORT_DIR,
  ARCHIVE_TEXT_LIMITS,
  canonicalArchiveContentPayload,
  formatArchiveDigest,
  isArchiveReportPath,
  parseArchiveManifest,
  archiveKey,
  type ArchiveIdentity,
  type ArchiveIndexStatus,
  type ArchiveManifest,
} from "@shared/archives.ts";
import { readFileWithinCap } from "../session-files.ts";
import { extractVisibleText, validateStaticReportHtml } from "./html.ts";
import {
  ArchivePathError,
  archiveDir,
  archiveRelativePath,
  digestFile,
  isInside,
  manifestPath,
  resolveArchiveFile,
  statRealDirectory,
  statRegularFile,
} from "./paths.ts";

/**
 * Reading one bundle directory into the single verified representation everything else uses.
 *
 * Reconciliation and the routes share this, which is the point: an archive that the index
 * calls ready is an archive that passed exactly these checks, so there is no second, weaker
 * definition of "valid" living in a route.
 *
 * Every bundle is treated as untrusted input, including one this daemon wrote. A manifest is
 * a set of CLAIMS about files; verification is what turns them into facts, and nothing here
 * lets a claim authorize a path, a size, or a content type.
 */

/**
 * What the index stores to answer "has this bundle changed?" without reading it.
 *
 * Manifest size plus nanosecond mtime. Not a content hash: the entire point is that a normal
 * startup with a thousand unchanged archives does no digesting at all, and a content hash
 * would mean reading every byte to discover that nothing moved. A completed bundle is
 * immutable by contract, so its manifest not moving is a sound proxy for its content not
 * moving; anything that DOES rewrite one gets fully re-verified.
 *
 * The mtime is decimal nanoseconds as a string because it comes from a `bigint` stat and has
 * to survive a SQLite TEXT column and a JSON round trip without losing its low digits.
 */
export interface ArchiveBundleFingerprint {
  manifestBytes: number;
  manifestMtimeNs: string;
}

/** A bundle that passed every check, ready to become index rows. */
export interface VerifiedArchiveBundle {
  identity: ArchiveIdentity;
  key: string;
  /** Which library root it was found under - there is more than one, and only one is written. */
  libraryRoot: string;
  /** Under that root, so the whole library can move and still reconcile. */
  relativePath: string;
  /** The realpath'd directory on THIS machine. */
  bundleDir: string;
  manifest: ArchiveManifest;
  fingerprint: ArchiveBundleFingerprint;
  /**
   * SHA-256 of the manifest FILE, which is what immutability is judged on.
   *
   * Not the content digest: that covers the archived files, so a manifest whose title or
   * summary was rewritten over unchanged evidence would hash identically and the rewrite
   * would be adopted in silence. Hashing the bytes makes "this key holds something else
   * now" mean exactly what it says, while an identical copy delivered by a sync tool - same
   * bytes, new mtime - still reconciles as the archive it already was.
   */
  manifestDigest: string;
  /** Actual verified content bytes, excluding `manifest.json`. */
  contentBytes: number;
  /** Bounded visible text of the primary report, or "" when there is none. */
  reportText: string;
  status: ArchiveIndexStatus;
}

export type ArchiveBundleRead =
  /** There is no directory, or no manifest in it, at this key. */
  | { kind: "absent" }
  /**
   * The bundle is structurally fine but its payload is not all here yet - a file is
   * missing, a size disagrees, a digest disagrees. Ordinary during a filesystem copy, so
   * the caller retries rather than publishing a corrupt record.
   */
  | { kind: "incomplete"; reason: string }
  /** This build refuses the bundle, and will go on refusing it until the bytes change. */
  | { kind: "unreadable"; reason: string; formatVersion: number | null }
  | { kind: "verified"; bundle: VerifiedArchiveBundle };

/** The manifest's size and mtime, or null when there is no manifest to fingerprint. */
export async function readBundleFingerprint(
  bundleDir: string,
): Promise<ArchiveBundleFingerprint | null> {
  const info = await lstat(manifestPath(bundleDir), { bigint: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    },
  );
  if (!info) return null;
  if (info.isSymbolicLink() || !info.isFile()) return null;
  return { manifestBytes: Number(info.size), manifestMtimeNs: info.mtimeNs.toString() };
}

export function sameFingerprint(
  a: ArchiveBundleFingerprint | null,
  b: ArchiveBundleFingerprint | null,
): boolean {
  if (!a || !b) return false;
  return a.manifestBytes === b.manifestBytes && a.manifestMtimeNs === b.manifestMtimeNs;
}

/**
 * A cheap signature over the manifest AND every file it declares.
 *
 * This is what "settled" means for a bundle arriving through a sync tool. A directory can be
 * exposed before its payload finishes copying, and a manifest that landed first would
 * otherwise look complete and stable while its files were still growing. Two identical
 * signatures a cadence apart is the evidence that nothing is still being written.
 *
 * Sizes and mtimes only - no digesting. It runs on every pass for every new or changed
 * bundle, so it has to cost one `lstat` per declared file and nothing more.
 */
export async function settleSignature(
  bundleDir: string,
  fingerprint: ArchiveBundleFingerprint,
  manifest: ArchiveManifest | null,
): Promise<string> {
  const parts = [`m:${fingerprint.manifestBytes}:${fingerprint.manifestMtimeNs}`];
  for (const artifact of manifest?.artifacts ?? []) {
    let entry = "absent";
    try {
      const target = await resolveArchiveFile(bundleDir, artifact.archivePath);
      const info = await lstat(target, { bigint: true });
      entry = `${info.size}:${info.mtimeNs.toString()}`;
    } catch {
      entry = "absent";
    }
    parts.push(`${artifact.archivePath}:${entry}`);
  }
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

/** Read and parse a bundle's manifest without verifying any of its payload. */
export async function readBundleManifest(
  bundleDir: string,
): Promise<
  | { kind: "manifest"; manifest: ArchiveManifest; digest: string }
  | { kind: "absent" }
  | { kind: "unreadable"; reason: string; formatVersion: number | null }
> {
  const info = await statRegularFile(manifestPath(bundleDir));
  if (!info) return { kind: "absent" };
  if (info.size > ARCHIVE_LIMITS.manifestBytes) {
    return { kind: "unreadable", reason: "manifest.json exceeds its size limit", formatVersion: null };
  }
  const handle = await open(manifestPath(bundleDir), constants.O_RDONLY).catch(() => null);
  if (!handle) return { kind: "absent" };
  let text: string;
  let digest: string;
  try {
    const bounded = await readFileWithinCap(handle, ARCHIVE_LIMITS.manifestBytes);
    if (bounded.exceeded) {
      return { kind: "unreadable", reason: "manifest.json exceeds its size limit", formatVersion: null };
    }
    digest = `sha256:${createHash("sha256").update(bounded.bytes).digest("hex")}`;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bounded.bytes);
    } catch {
      return { kind: "unreadable", reason: "manifest.json is not valid UTF-8", formatVersion: null };
    }
  } finally {
    await handle.close();
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: "unreadable", reason: "manifest.json is not valid JSON", formatVersion: null };
  }
  const parsed = parseArchiveManifest(value);
  if (!parsed.ok) {
    return { kind: "unreadable", reason: parsed.reason, formatVersion: parsed.formatVersion };
  }
  return { kind: "manifest", manifest: parsed.manifest, digest };
}

/**
 * Fully verify one bundle: identity, containment, sizes, digests, limits, and static HTML.
 *
 * The order is deliberate. Cheap structural refusals come first so a malformed bundle costs
 * a stat and a small read; digesting - the only expensive step - runs last and only for a
 * bundle whose every claim already agreed with its own manifest.
 */
export async function verifyArchiveBundle(
  libraryRealRoot: string,
  identity: ArchiveIdentity,
): Promise<ArchiveBundleRead> {
  let dir: string;
  try {
    dir = archiveDir(libraryRealRoot, identity.producerId, identity.archiveId);
  } catch {
    return { kind: "unreadable", reason: "archive identity is not generated", formatVersion: null };
  }
  const dirInfo = await statRealDirectory(dir);
  if (!dirInfo) return { kind: "absent" };
  // EQUALITY against the generated path, matching `ArchiveManager.resolveBundleDir`.
  // Containment alone would accept a symlinked producer namespace pointing at another archive
  // in the same library, so one key could be verified from another key's bytes. Discovery
  // already skips symlinked entries, so this is the second lock on the same door - and the
  // one that holds for any caller that reaches the verifier with an identity of its own.
  const realDir = await realpath(dir).catch(() => null);
  if (!realDir || realDir !== dir || !isInside(libraryRealRoot, realDir)) {
    return { kind: "unreadable", reason: "the bundle does not resolve to a directory in the library", formatVersion: null };
  }

  const fingerprint = await readBundleFingerprint(realDir);
  if (!fingerprint) return { kind: "absent" };
  const read = await readBundleManifest(realDir);
  if (read.kind === "absent") return { kind: "absent" };
  if (read.kind === "unreadable") {
    return { kind: "unreadable", reason: read.reason, formatVersion: read.formatVersion };
  }
  const manifest = read.manifest;

  if (manifest.producer.id !== identity.producerId || manifest.archive.id !== identity.archiveId) {
    return {
      kind: "unreadable",
      reason: "the manifest identity does not match the directory it is in",
      formatVersion: manifest.formatVersion,
    };
  }

  let contentBytes = 0;
  let reportBytes = 0;
  let reportEntries = 0;
  const reportTargets = new Set<string>();
  let primaryFile: string | null = null;
  for (const artifact of manifest.artifacts) {
    let target: string;
    try {
      target = await resolveArchiveFile(realDir, artifact.archivePath);
    } catch (error) {
      if (error instanceof ArchivePathError && error.status === 404) {
        return { kind: "incomplete", reason: `${artifact.archivePath} is not in the bundle yet` };
      }
      const reason = error instanceof ArchivePathError ? error.message : "an archived path is unusable";
      return { kind: "unreadable", reason: `${artifact.archivePath}: ${reason}`, formatVersion: manifest.formatVersion };
    }
    const cap = capFor(artifact.archivePath, artifact.role === "primary_report");
    const digested = await digestFile(target, cap);
    if ("error" in digested) {
      return { kind: "incomplete", reason: `${artifact.archivePath}: ${digested.error}` };
    }
    if (digested.bytes !== artifact.bytes) {
      return {
        kind: "incomplete",
        reason: `${artifact.archivePath} is ${digested.bytes} bytes and the manifest says ${artifact.bytes}`,
      };
    }
    if (digested.sha256 !== artifact.sha256) {
      return { kind: "incomplete", reason: `${artifact.archivePath} does not match its recorded digest` };
    }
    contentBytes += digested.bytes;
    if (isArchiveReportPath(artifact.archivePath)) {
      reportBytes += digested.bytes;
      reportEntries += 1;
      reportTargets.add(artifact.archivePath.slice(ARCHIVE_REPORT_DIR.length + 1));
    }
    if (artifact.archivePath === ARCHIVE_PRIMARY_REPORT_PATH) primaryFile = target;
  }

  const limit = limitProblem({
    entries: manifest.artifacts.length,
    contentBytes,
    reportBytes,
    reportEntries,
  });
  if (limit) return { kind: "unreadable", reason: limit, formatVersion: manifest.formatVersion };

  const digest = formatArchiveDigest(
    createHash("sha256").update(canonicalArchiveContentPayload(manifest.artifacts)).digest("hex"),
  );
  if (digest !== manifest.contentDigest) {
    return {
      kind: "unreadable",
      reason: "the manifest content digest does not describe its own contents",
      formatVersion: manifest.formatVersion,
    };
  }

  let reportText = "";
  if (manifest.primaryArtifactId && primaryFile) {
    const html = await readTextWithinCap(primaryFile, ARCHIVE_LIMITS.primaryReportBytes);
    if (html === null) {
      return { kind: "unreadable", reason: "report.html is not valid UTF-8", formatVersion: manifest.formatVersion };
    }
    const valid = validateStaticReportHtml(html, reportTargets);
    if (!valid.ok) {
      const named = valid.problems.map((problem) => problem.message).join("; ");
      return {
        kind: "unreadable",
        reason: `report.html is not a static report: ${named}`,
        formatVersion: manifest.formatVersion,
      };
    }
    reportText = extractVisibleText(html, ARCHIVE_TEXT_LIMITS.reportText);
  }

  return {
    kind: "verified",
    bundle: {
      identity,
      key: archiveKey(identity.producerId, identity.archiveId),
      libraryRoot: libraryRealRoot,
      relativePath: archiveRelativePath(identity.producerId, identity.archiveId),
      bundleDir: realDir,
      manifest,
      fingerprint,
      manifestDigest: read.digest,
      contentBytes,
      reportText,
      status: manifest.archive.captureStatus === "complete" ? "ready" : "partial",
    },
  };
}

function capFor(archivePath: string, primary: boolean): number {
  if (primary || archivePath === ARCHIVE_PRIMARY_REPORT_PATH) return ARCHIVE_LIMITS.primaryReportBytes;
  if (isArchiveReportPath(archivePath)) return ARCHIVE_LIMITS.reportDirectoryBytes;
  return ARCHIVE_LIMITS.supportingFileBytes;
}

function limitProblem(totals: {
  entries: number;
  contentBytes: number;
  reportBytes: number;
  reportEntries: number;
}): string | null {
  if (totals.entries > ARCHIVE_LIMITS.entries) return "the bundle declares too many files";
  if (totals.reportEntries > ARCHIVE_LIMITS.reportDirectoryEntries) {
    return "the report directory holds too many files";
  }
  if (totals.reportBytes > ARCHIVE_LIMITS.reportDirectoryBytes) {
    return "the report directory exceeds its size limit";
  }
  if (totals.contentBytes > ARCHIVE_LIMITS.bundleBytes) return "the bundle exceeds its size limit";
  return null;
}

async function readTextWithinCap(target: string, cap: number): Promise<string | null> {
  const handle = await open(target, constants.O_RDONLY).catch(() => null);
  if (!handle) return null;
  try {
    const bounded = await readFileWithinCap(handle, cap);
    if (bounded.exceeded) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(bounded.bytes);
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}
