import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  ARCHIVE_FORMAT_VERSION,
  ARCHIVE_LIMITS,
  ARCHIVE_PRIMARY_ARTIFACT_ID,
  archiveArtifactId,
  archiveKey,
  canonicalArchiveContentPayload,
  formatArchiveDigest,
  serializeArchiveManifest,
  type ArchiveIdentity,
  type ArchiveCaptureStatus,
  type ArchiveManifest,
  type ArchiveManifestArtifact,
  type ArchiveManifestRepository,
} from "@shared/archives.ts";
import { verifyArchiveBundle } from "./bundle.ts";
import type { ArchiveCaptureJob } from "./capture-store.ts";
import { headOf, resolveRoots } from "./checkout.ts";
import { archiveDir, archiveRelativePath, stagingRoot, statRealDirectory } from "./paths.ts";
import type { CapturePlan, CapturePlanDeps, PlannedFile, ResolvedRoot } from "./plan.ts";
import { plannerFor } from "./planners.ts";

/**
 * Turning a planned set of checkout files into a published, verified bundle.
 *
 * Kind-agnostic. WHICH files those are is the kind's planner's answer (`plan.ts`), and this
 * module never asks what the archive is of.
 *
 * Everything here treats the checkout as hostile input even though our own agent wrote it.
 * A path is a claim until it has been resolved beneath a realpath'd root the SERVER chose,
 * proved to be an ordinary file with no symbolic link at any component, proved not to be
 * ignored, and copied through a handle that is re-checked afterwards. A file that changed
 * while it was being read fails the whole operation rather than producing a digest for bytes
 * nobody verified.
 *
 * The publication order is filesystem-first and deliberately so: stage, verify the staged
 * bundle with the SAME importer that verifies a stranger's bundle, atomically rename into
 * place, verify the final directory, and only then tell anyone. A row pointing at files that
 * were never durably renamed cannot be repaired; a complete bundle can always rebuild its row.
 */

/** Copy buffer. Matches `digestFile`'s, for the same streaming reason. */
const COPY_CHUNK = 256 * 1024;

export type ArchiveCaptureOutcome =
  | {
      ok: true;
      identity: ArchiveIdentity;
      relativePath: string;
      captureStatus: ArchiveCaptureStatus;
      artifactCount: number;
      /** True when the bundle was already published and this call only re-verified it. */
      replayed: boolean;
    }
  | {
      ok: false;
      /** Every offending path or rule, named. Never one blanket sentence. */
      problems: string[];
      /** A final key that already holds different content. Preserves both sides. */
      conflict?: boolean;
    };

export interface ArchiveCaptureDeps extends CapturePlanDeps {
  /** The root this capture publishes under. Staging, trash, and namespaces live below it. */
  libraryRoot: string;
  /** This producer's optional display label, copied into the manifest as an unverified claim. */
  producerLabel: string | null;
  /** Injected so a test can prove a failed publication leaves the previous state readable. */
  rename?: (from: string, to: string) => Promise<void>;
  /** Injected so a test can swap a validated path immediately before its source is opened. */
  beforeCopy?: (source: string) => Promise<void>;
  now?: () => number;
}

/**
 * Plan, stage, verify, and publish one capture job.
 *
 * The kind is settled first and settled ONCE: a job whose kind has no registered planner is
 * refused here rather than half-captured, which is what makes "only the kinds this build can
 * produce are ever written" a property of the code rather than of every caller.
 */
export async function captureArchive(
  job: ArchiveCaptureJob,
  deps: ArchiveCaptureDeps,
): Promise<ArchiveCaptureOutcome> {
  const now = deps.now ?? Date.now;
  const identity: ArchiveIdentity = { producerId: job.producerId, archiveId: job.archiveId };
  if (!job.producerId || !job.archiveId) {
    return { ok: false, problems: ["this capture job has no generated archive identity"] };
  }

  // A job whose bundle is already on disk and still verifies is DONE, whatever its row says.
  // The filesystem is the authority, so this is the replay answer for a lost response, a
  // duplicated completion click, and a restart between the rename and the row write alike.
  const already = await verifyPublished(deps.libraryRoot, identity);
  if (already) {
    return {
      ok: true,
      identity,
      relativePath: archiveRelativePath(identity.producerId, identity.archiveId),
      captureStatus: already.captureStatus,
      artifactCount: already.artifactCount,
      replayed: true,
    };
  }

  const planner = plannerFor(job.kind);
  if (!planner) {
    return { ok: false, problems: [`this build cannot capture a ${job.kind} archive`] };
  }

  const roots = await resolveRoots(job.repos);
  const plan = await planner(job, roots, deps);
  if (!plan.ok) return { ok: false, problems: plan.problems };

  return publish(job, identity, plan, roots, deps, now);
}


// ---------------------------------------------------------------------------
// Staging, verification, publication
// ---------------------------------------------------------------------------

async function publish(
  job: ArchiveCaptureJob,
  identity: ArchiveIdentity,
  plan: Extract<CapturePlan, { ok: true }>,
  roots: ResolvedRoot[],
  deps: ArchiveCaptureDeps,
  now: () => number,
): Promise<ArchiveCaptureOutcome> {
  const renameDir = deps.rename ?? ((from, to) => rename(from, to));
  const staging = stagingRoot(deps.libraryRoot);
  // Staged under `<staging>/<producer>/<archive>` rather than a flat temp name, so the SAME
  // importer that verifies a stranger's bundle can verify this one before it is published -
  // it derives the directory from the identity, and a flat name would need a second, weaker
  // verifier that only the local path ever used.
  const stageProducer = path.join(staging, identity.producerId);
  const stageDir = path.join(stageProducer, identity.archiveId);

  try {
    await rm(stageDir, { recursive: true, force: true, maxRetries: 2 });
    await mkdir(stageDir, { recursive: true, mode: 0o700 });

    const artifacts: ArchiveManifestArtifact[] = [];
    const copyProblems: string[] = [];
    let ordinal = 0;
    for (const file of plan.files) {
      await deps.beforeCopy?.(file.source);
      const copied = await copyIntoBundle(file, stageDir);
      if (!copied.ok) {
        copyProblems.push(`${file.originalPath}: ${copied.reason}`);
        continue;
      }
      artifacts.push({
        id: file.role === "primary_report" ? ARCHIVE_PRIMARY_ARTIFACT_ID : archiveArtifactId(++ordinal),
        role: file.role,
        repoSlot: file.repoSlot,
        originalPath: file.originalPath,
        archivePath: file.archivePath,
        mediaType: null,
        bytes: copied.bytes,
        sha256: copied.sha256,
      });
    }
    if (copyProblems.length > 0) return { ok: false, problems: copyProblems };

    const repositories: ArchiveManifestRepository[] = [];
    for (const root of roots) {
      repositories.push({ slot: root.slot, label: root.label, head: await headOf(root) });
    }

    const manifest: ArchiveManifest = {
      formatVersion: ARCHIVE_FORMAT_VERSION,
      kind: job.kind,
      producer: { id: identity.producerId, label: deps.producerLabel },
      archive: {
        id: identity.archiveId,
        createdAt: new Date(job.createdAt).toISOString(),
        completedAt: new Date(now()).toISOString(),
        captureStatus: plan.captureStatus,
        title: job.title,
        question: job.question,
        prompts: job.prompts,
        summary: job.submission?.summary ?? null,
        tags: job.submission?.tags ?? [],
      },
      origin: { ...job.origin, repositories },
      primaryArtifactId:
        artifacts.find((artifact) => artifact.role === "primary_report")?.id ?? null,
      artifacts,
      missing: plan.missing,
      contentDigest:
        formatArchiveDigest(
          createHash("sha256").update(canonicalArchiveContentPayload(artifacts)).digest("hex"),
        ) ?? "",
    };
    await writeFile(path.join(stageDir, "manifest.json"), serializeArchiveManifest(manifest), {
      encoding: "utf8",
      mode: 0o600,
    });

    // Re-read what was just written, through the importer a foreign bundle goes through. This
    // is where an invalid report, a companion the page links to but that was not captured, a
    // digest that does not describe its own contents, and a limit crossed after the plan was
    // made all surface - BEFORE anything is visible in the library.
    const stagingReal = await realpath(staging);
    const staged = await verifyArchiveBundle(stagingReal, identity);
    if (staged.kind !== "verified") {
      return { ok: false, problems: [stagedProblem(staged)] };
    }

    // Never overwrite a final key. `rename` over a non-empty directory fails anyway on POSIX,
    // but a directory that happens to be EMPTY would be replaced silently, and "the archive
    // that was there is gone" is not a failure mode a scout's completion may cause.
    const finalDir = archiveDir(deps.libraryRoot, identity.producerId, identity.archiveId);
    if (await statRealDirectory(finalDir)) {
      return {
        ok: false,
        conflict: true,
        problems: [
          `an archive already exists at ${archiveRelativePath(identity.producerId, identity.archiveId)}`,
        ],
      };
    }
    await mkdir(path.dirname(finalDir), { recursive: true, mode: 0o700 });
    await renameDir(stageDir, finalDir);

    // The bundle is the completion authority, so it is verified WHERE IT LANDED rather than
    // trusted because staging verified. A rename that crossed a filesystem, a library on a
    // synchronised volume that rewrote something, an injected failure in a test - all of them
    // show up here, before anything is told that a scout finished.
    const published = await verifyPublished(deps.libraryRoot, identity);
    if (!published) {
      return { ok: false, problems: ["the published archive could not be verified after it was written"] };
    }
    return {
      ok: true,
      identity,
      relativePath: archiveRelativePath(identity.producerId, identity.archiveId),
      captureStatus: published.captureStatus,
      artifactCount: published.artifactCount,
      replayed: false,
    };
  } catch (error) {
    return { ok: false, problems: [describe(error)] };
  } finally {
    // Staging is disposable by construction: a failed attempt re-stages from scratch next
    // time, and a successful one has already renamed the directory away.
    await rm(stageDir, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
    await rmdir(stageProducer).catch(() => {});
  }
}

/** The published bundle, re-verified from disk, or null when there is not a usable one there. */
async function verifyPublished(
  libraryRoot: string,
  identity: ArchiveIdentity,
): Promise<{ captureStatus: ArchiveCaptureStatus; artifactCount: number } | null> {
  const real = await realpath(libraryRoot).catch(() => null);
  if (!real) return null;
  const read = await verifyArchiveBundle(real, identity);
  if (read.kind !== "verified") return null;
  return {
    captureStatus: read.bundle.manifest.archive.captureStatus,
    artifactCount: read.bundle.manifest.artifacts.length,
  };
}

function stagedProblem(read: Awaited<ReturnType<typeof verifyArchiveBundle>>): string {
  if (read.kind === "unreadable") return read.reason;
  if (read.kind === "incomplete") return read.reason;
  return "the staged archive was not written";
}

/**
 * Copy one file into the staging bundle, hashing as it goes and re-checking afterwards.
 *
 * Opened with `O_NOFOLLOW` so a final-component symlink swapped in between the plan and this
 * open is refused by the kernel. Parent symlinks are followed by `open`, so the device/inode
 * from the opened handle must also match the identity validated during planning. The size is
 * taken from the OPEN handle rather than the earlier `lstat`, and the second `fstat` at the
 * end turns "the file changed while we were reading it" from a silent half-copy with a
 * confident digest into a named failure.
 */
async function copyIntoBundle(
  file: PlannedFile,
  stageDir: string,
): Promise<{ ok: true; bytes: number; sha256: string } | { ok: false; reason: string }> {
  const destination = path.join(stageDir, ...file.archivePath.split("/"));
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });

  let source: FileHandle;
  try {
    source = await open(file.source, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return { ok: false, reason: "could not be opened" };
  }
  let sink: FileHandle | null = null;
  try {
    const before = await source.stat();
    if (!before.isFile()) return { ok: false, reason: "is not an ordinary file" };
    if (before.dev !== file.sourceDev || before.ino !== file.sourceIno) {
      return { ok: false, reason: "changed after its checkout path was validated" };
    }
    const cap = capFor(file);
    if (before.size > cap) return { ok: false, reason: `exceeds its ${cap}-byte limit` };

    sink = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_CHUNK);
    let bytes = 0;
    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, bytes);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > cap) return { ok: false, reason: `exceeds its ${cap}-byte limit` };
      hash.update(buffer.subarray(0, bytesRead));
      await sink.write(buffer, 0, bytesRead);
    }
    const after = await source.stat();
    if (
      after.size !== bytes ||
      after.mtimeMs !== before.mtimeMs ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      return { ok: false, reason: "changed while it was being archived" };
    }
    const digest = formatArchiveDigest(hash.digest("hex"));
    if (!digest) return { ok: false, reason: "could not be digested" };
    return { ok: true, bytes, sha256: digest };
  } catch (error) {
    return { ok: false, reason: describe(error) };
  } finally {
    await source.close().catch(() => {});
    await sink?.close().catch(() => {});
  }
}

function capFor(file: PlannedFile): number {
  if (file.role === "primary_report") return ARCHIVE_LIMITS.primaryReportBytes;
  if (file.role === "report_companion") return ARCHIVE_LIMITS.reportDirectoryBytes;
  return ARCHIVE_LIMITS.supportingFileBytes;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The key one capture publishes under, for a log line and for a test's assertion. */
export function captureArchiveKey(job: ArchiveCaptureJob): string {
  return archiveKey(job.producerId, job.archiveId);
}
