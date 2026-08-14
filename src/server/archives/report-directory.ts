import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { ARCHIVE_REPORT_DIR, validateArchivePath, type ArchiveManifestMissing } from "@shared/archives.ts";
import { isIgnored, resolveCheckoutDirectory, resolveCheckoutFile } from "./checkout.ts";
import type { PlannedFile, ResolvedRoot } from "./plan.ts";

/**
 * Capturing one checkout directory as the bundle's `report/` tree.
 *
 * Kind-agnostic mechanics, and here rather than inside a planner because both captured kinds
 * do exactly this and must do it identically: a scout's `docs/reports/<slug>/` and a plan's
 * `docs/plans/<name>/` are the same problem wearing different names. What differs is only
 * WHICH directory, and which file inside it is the primary - both of which the kind decides
 * and hands in.
 *
 * The directory is captured as ONE relative unit because that is what keeps the page's own
 * links working: a report that says `<img src="chart.svg">`, or a plan whose page links to
 * `./phase-2.md`, is only readable in the archive if the companion arrived at the same
 * relative position. It is also why the static-HTML validator is handed the set of captured
 * companions - a link to a file that was not captured is refused rather than left dangling.
 */

export type CapturedDirectory =
  | { ok: true; files: PlannedFile[]; missing: ArchiveManifestMissing[] }
  | { ok: false; problems: string[] };

/**
 * Every file in `directory`, recursively, keeping its layout under `report/`.
 *
 * `primaryRealPath` names the one file that arrives through the caller's own primary entry
 * and is therefore skipped here - archiving it twice would describe the same bytes as two
 * artifacts under two ids. Null means the caller has no primary, so nothing is skipped and
 * every file including the page itself is captured as a companion under its own name. That
 * is not a degenerate case: it is how a bundle keeps a page it could not make primary.
 *
 * Hidden entries are skipped silently, and that is a deliberate pair of decisions rather than
 * an oversight. A bundle path may not contain a dot-prefixed segment at all
 * (`validateArchivePath`), so `.DS_Store` and an editor swap file CANNOT be archived; and
 * a hidden file the page actually depends on does not slip through unnoticed, because the
 * page then links to a companion that is not in the bundle and validation refuses the whole
 * capture by name. Silence for bookkeeping, a loud refusal when it mattered.
 */
export async function planCapturedDirectory(
  root: ResolvedRoot,
  directory: string,
  primaryRealPath: string | null,
  beforeDirectory?: (directory: string) => Promise<void>,
): Promise<CapturedDirectory> {
  const files: PlannedFile[] = [];
  const missing: ArchiveManifestMissing[] = [];
  const problems: string[] = [];

  const walk = async (relative: string): Promise<void> => {
    if (problems.length > 0) return;
    const directoryPath = relative === "" ? directory : `${directory}/${relative}`;
    const before = await resolveCheckoutDirectory(root.realRoot!, directoryPath);
    if (!before.ok) {
      problems.push(`${directoryPath}: ${before.reason}`);
      return;
    }
    const entries = await readdir(before.path, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      problems.push(`${directory}/${relative}: could not be read (${error.code ?? "unknown"})`);
      return null;
    });
    if (!entries) return;
    const after = await resolveCheckoutDirectory(root.realRoot!, directoryPath);
    if (!after.ok || after.dev !== before.dev || after.ino !== before.ino) {
      problems.push(`${directoryPath}: changed while the report directory was being inspected`);
      return;
    }
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.name.startsWith(".")) continue;
      const absolute = path.join(before.path, entry.name);
      const rel = relative === "" ? entry.name : `${relative}/${entry.name}`;
      const info = await lstat(absolute).catch(() => null);
      if (!info) continue;
      if (info.isSymbolicLink()) {
        missing.push({
          kind: "report_companion",
          expectedSource: `${directory}/${rel}`,
          reason: "a symbolic link beside the report was not archived",
        });
        continue;
      }
      if (info.isDirectory()) {
        await beforeDirectory?.(absolute);
        await walk(rel);
        continue;
      }
      if (!info.isFile()) {
        missing.push({
          kind: "report_companion",
          expectedSource: `${directory}/${rel}`,
          reason: "a file beside the report is not an ordinary file and was not archived",
        });
        continue;
      }
      // The primary arrives through the caller's own entry, with its own role and id.
      if (primaryRealPath !== null && absolute === primaryRealPath) continue;
      const originalPath = `${directory}/${rel}`;
      // `readdir` and `lstat` describe what occupied this name at one instant, but a parent
      // directory can be replaced before recursion reaches the leaf. Resolve the whole path
      // beneath the checkout again, exactly like an explicitly submitted supporting file.
      // If a parent became a symlink this refuses it; if it changes after this check, the
      // opened handle's device/inode proof in `copyIntoBundle` refuses the replacement.
      const resolved = await resolveCheckoutFile(root.realRoot!, originalPath);
      if (!resolved.ok) {
        missing.push({
          kind: "report_companion",
          expectedSource: originalPath,
          reason: `the file ${resolved.reason} and was not archived`,
        });
        continue;
      }
      if (await isIgnored(root.realRoot!, originalPath)) {
        missing.push({
          kind: "report_companion",
          expectedSource: originalPath,
          reason: "the file is ignored by git and was not archived",
        });
        continue;
      }
      const archivePath = `${ARCHIVE_REPORT_DIR}/${rel}`;
      if (!validateArchivePath(archivePath)) {
        missing.push({
          kind: "report_companion",
          expectedSource: originalPath,
          reason: "the file's name cannot be represented inside an archive",
        });
        continue;
      }
      files.push({
        source: resolved.path,
        sourceDev: resolved.dev,
        sourceIno: resolved.ino,
        archivePath,
        role: "report_companion",
        repoSlot: root.slot,
        originalPath,
        bytes: resolved.bytes,
      });
    }
  };

  await walk("");
  if (problems.length > 0) return { ok: false, problems };
  // Bounded before anything is copied, so a runaway directory costs one walk rather than
  // 128 MiB of writes that then have to be thrown away.
  return { ok: true, files, missing: missing.slice(0, 64) };
}
