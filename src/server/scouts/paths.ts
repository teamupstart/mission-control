import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import {
  SCOUT_MANIFEST_FILENAME,
  SCOUT_STAGING_DIR,
  SCOUT_TRASH_DIR,
  formatScoutDigest,
  isScoutId,
  validateScoutArchivePath,
} from "@shared/scouts.ts";

/**
 * The one place a scout archive path is turned into a real file on disk.
 *
 * `session-files.ts` does the same job for a session checkout and its defences are the
 * model here - realpath the root, refuse symlinks, refuse anything that resolves outside,
 * refuse anything that is not a regular file - but its API takes a session `cwd` and its
 * errors talk about checkouts, so reusing it would mean a route that accepts session paths
 * being the thing that opens archive files. These are separate roots with separate rules
 * (a bundle path is generated, never operator-typed), so they get separate owners with
 * equivalent tests rather than one function with a mode flag.
 *
 * The rule every function here exists to enforce: an archive path from a manifest is a
 * CLAIM. It selects a file only after being validated as a legal relative path and then
 * resolved beneath a realpath'd archive root that the server generated from a decoded
 * archive key. Nothing joins a string from a request or a manifest to a root without going
 * through here.
 */

export class ScoutPathError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** Where one archive's directory sits under the library root. */
export function archiveRelativePath(producerId: string, archiveId: string): string {
  return `${producerId}/${archiveId}`;
}

/** The absolute directory of one archive, from generated identity components only. */
export function archiveDir(root: string, producerId: string, archiveId: string): string {
  if (!isScoutId(producerId) || !isScoutId(archiveId)) {
    throw new ScoutPathError("archive identity is not generated", 400);
  }
  return path.join(root, producerId, archiveId);
}

/** The absolute `manifest.json` of one archive. */
export function manifestPath(bundleDir: string): string {
  return path.join(bundleDir, SCOUT_MANIFEST_FILENAME);
}

/** The reserved staging and trash roots. Never discovered as bundles. */
export function stagingRoot(root: string): string {
  return path.join(root, SCOUT_STAGING_DIR);
}
export function trashRoot(root: string): string {
  return path.join(root, SCOUT_TRASH_DIR);
}

/**
 * `lstat` a path and insist it is an ordinary file.
 *
 * `lstat`, never `stat`: `stat` follows a symlink and would report the target's type, so a
 * link pointing at `/etc/passwd` would pass a "regular file" check. Returns null for a
 * missing file, because "not there yet" is an ordinary state during a copy and a caller
 * that needs to distinguish it from "refused" cannot do so through an exception.
 */
export async function statRegularFile(target: string): Promise<Stats | null> {
  const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  });
  if (!info) return null;
  if (info.isSymbolicLink() || !info.isFile()) return null;
  return info;
}

/** `lstat` a path and insist it is an ordinary directory (never a link to one). */
export async function statRealDirectory(target: string): Promise<Stats | null> {
  const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  });
  if (!info) return null;
  if (info.isSymbolicLink() || !info.isDirectory()) return null;
  return info;
}

/**
 * Resolve one manifest-declared archive path to an absolute file inside a verified bundle.
 *
 * Three separate refusals, and all three are needed:
 *
 * 1. the path must be a legal archive path at all (`validateScoutArchivePath`), which is
 *    what stops `..`, an absolute path, a NUL, and a Windows separator before any I/O;
 * 2. the JOINED path must still be under the root, which catches a normalization
 *    disagreement between this process and the string that was validated;
 * 3. the REALPATH must still be under the root, which is the only check that sees a symlink
 *    swapped in after the bundle was scanned - the file was verified, then replaced.
 *
 * `bundleRealDir` is the realpath of the archive directory, resolved once by the caller. It
 * is passed in rather than resolved here so a route reading five artifacts does not walk the
 * same directory chain five times, and so the containment answer cannot change between two
 * artifacts of the same read.
 */
export async function resolveArchiveFile(
  bundleRealDir: string,
  archivePath: string,
): Promise<string> {
  const relative = validateScoutArchivePath(archivePath);
  if (!relative) throw new ScoutPathError("archive path is not usable", 400);
  const joined = path.resolve(bundleRealDir, relative);
  if (!isInside(bundleRealDir, joined)) {
    throw new ScoutPathError("archive path leaves the bundle", 403);
  }
  const info = await statRegularFile(joined);
  if (!info) throw new ScoutPathError("archived file is unavailable", 404);
  const real = await realpath(joined).catch(() => {
    throw new ScoutPathError("archived file is unavailable", 404);
  });
  if (!isInside(bundleRealDir, real)) {
    throw new ScoutPathError("archived file resolves outside the bundle", 403);
  }
  return real;
}

/** Whether `candidate` is the root itself or sits below it, after both are absolute. */
export function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * SHA-256 one file, streamed, refusing anything larger than `cap`.
 *
 * Streamed rather than read whole because the per-file ceiling is 64 MiB and the bundle
 * ceiling is 512 MiB: hashing a library by buffering each file would make an ordinary
 * reconciliation pass a memory spike proportional to somebody else's evidence.
 *
 * The size is taken from the OPEN handle rather than from a prior `lstat`, and the read is
 * capped at `cap + 1`, so a file that grows between the scan and the hash is refused here
 * instead of producing a digest for bytes nobody verified.
 */
export async function digestFile(
  target: string,
  cap: number,
): Promise<{ sha256: string; bytes: number } | { error: string }> {
  const handle = await open(target, constants.O_RDONLY).catch(() => null);
  if (!handle) return { error: "file is unavailable" };
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { error: "not a regular file" };
    if (info.size > cap) return { error: "file exceeds its size limit" };
    const hash = createHash("sha256");
    let bytes = 0;
    const buffer = Buffer.allocUnsafe(256 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, bytes);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > cap) return { error: "file exceeds its size limit" };
      hash.update(buffer.subarray(0, bytesRead));
    }
    const digest = formatScoutDigest(hash.digest("hex"));
    if (!digest) return { error: "could not digest the file" };
    return { sha256: digest, bytes };
  } finally {
    await handle.close();
  }
}

/**
 * The content type one archived file is served as.
 *
 * Derived from the archive path's extension through a CLOSED table, never from the
 * manifest's `media_type`. A foreign manifest is a stranger's claim about a stranger's
 * file, and a claimed content type is the one field that decides how a browser treats the
 * bytes; taking it from the file's own name means the worst a hostile manifest can do is
 * mislabel its own artifact list in the UI. Anything unrecognised is an opaque download.
 */
const MEDIA_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".yaml": "text/plain; charset=utf-8",
  ".yml": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".pdf": "application/pdf",
};

export const SCOUT_DEFAULT_MEDIA_TYPE = "application/octet-stream";

export function mediaTypeForArchivePath(archivePath: string): string {
  const ext = path.extname(archivePath).toLowerCase();
  return MEDIA_TYPES[ext] ?? SCOUT_DEFAULT_MEDIA_TYPE;
}

/** Whether an archived file is HTML by its own name - the only thing allowed to decide that. */
export function isArchivedHtml(archivePath: string): boolean {
  return /\.html?$/i.test(archivePath);
}
