import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  SCOUT_ARCHIVE_FORMAT_VERSION,
  SCOUT_ARTIFACTS_DIR,
  SCOUT_LIMITS,
  SCOUT_PRIMARY_ARTIFACT_ID,
  SCOUT_PRIMARY_REPORT_PATH,
  SCOUT_REPORT_DIR,
  SCOUT_REPORT_FILENAME,
  SCOUT_REPORT_PATH_SHAPE,
  SCOUT_REPORT_ROOT,
  SCOUT_TEXT_LIMITS,
  canonicalScoutContentPayload,
  formatScoutDigest,
  scoutArchiveKey,
  scoutArtifactId,
  scoutReportDirectory,
  scoutReportSlug,
  serializeScoutManifest,
  validateScoutArchivePath,
  type ScoutArchiveIdentity,
  type ScoutCaptureStatus,
  type ScoutManifest,
  type ScoutManifestArtifact,
  type ScoutManifestMissing,
  type ScoutManifestRepository,
} from "@shared/scouts.ts";
import { run } from "../util/exec.ts";
import { verifyScoutBundle } from "./bundle.ts";
import type { ScoutCaptureJob } from "./capture-store.ts";
import { archiveDir, archiveRelativePath, isInside, stagingRoot, statRealDirectory } from "./paths.ts";
import type { ScoutRepoSlot } from "./repos.ts";

/**
 * Turning a scout's finished report into a published, verified bundle.
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

/** How long one git question about a checkout may take before it is treated as unanswerable. */
const GIT_TIMEOUT_MS = 10_000;

/** Copy buffer. Matches `digestFile`'s, for the same streaming reason. */
const COPY_CHUNK = 256 * 1024;

export type ScoutCaptureOutcome =
  | {
      ok: true;
      identity: ScoutArchiveIdentity;
      relativePath: string;
      captureStatus: ScoutCaptureStatus;
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

export interface ScoutCaptureDeps {
  /** The library root. Staging, trash, and every producer namespace live under it. */
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
 * Stage, verify, and publish one capture job.
 *
 * `job.submission === null` is the recovery path: nothing was submitted, so the job's retained
 * source roots are scanned for exactly one conventional report. Ambiguity is never guessed -
 * two candidates produce an honest partial, exactly as none does.
 */
export async function captureScoutArchive(
  job: ScoutCaptureJob,
  deps: ScoutCaptureDeps,
): Promise<ScoutCaptureOutcome> {
  const now = deps.now ?? Date.now;
  const identity: ScoutArchiveIdentity = { producerId: job.producerId, archiveId: job.archiveId };
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

  const roots = await resolveRoots(job.repos);
  const plan = job.submission
    ? await planSubmitted(job, roots)
    : await planRecovery(job, roots);
  if (!plan.ok) return { ok: false, problems: plan.problems };

  return publish(job, identity, plan, roots, deps, now);
}

// ---------------------------------------------------------------------------
// Source roots
// ---------------------------------------------------------------------------

interface ResolvedRoot extends ScoutRepoSlot {
  /** The realpath of `root`, or null when the checkout is gone or was never provisioned. */
  realRoot: string | null;
}

async function resolveRoots(repos: readonly ScoutRepoSlot[]): Promise<ResolvedRoot[]> {
  const out: ResolvedRoot[] = [];
  for (const repo of repos) {
    const realRoot = repo.root ? await realpath(repo.root).catch(() => null) : null;
    out.push({ ...repo, realRoot });
  }
  return out;
}

function primaryRoot(roots: readonly ResolvedRoot[]): ResolvedRoot | null {
  return roots.find((entry) => entry.primary) ?? roots[0] ?? null;
}

// ---------------------------------------------------------------------------
// What a capture is going to copy
// ---------------------------------------------------------------------------

/** One file the capture will copy, already resolved to a real path under a real root. */
interface PlannedFile {
  /** Absolute, realpath'd, proven to be a regular file with no symlinked component. */
  source: string;
  /** The validated file identity. The opened handle must still name this exact inode. */
  sourceDev: number;
  sourceIno: number;
  /** Where it lands inside the bundle. Already `validateScoutArchivePath`-legal. */
  archivePath: string;
  role: ScoutManifestArtifact["role"];
  repoSlot: string;
  /** The checkout-relative path, recorded in the manifest as provenance. */
  originalPath: string;
  bytes: number;
}

type CapturePlan =
  | { ok: true; files: PlannedFile[]; missing: ScoutManifestMissing[]; captureStatus: ScoutCaptureStatus }
  | { ok: false; problems: string[] };

/**
 * The plan for a scout that submitted: its report directory, plus the files it named.
 *
 * Every refusal collects rather than short-circuits, so an agent correcting its submission
 * learns about all four bad paths at once instead of one per round trip.
 */
async function planSubmitted(job: ScoutCaptureJob, roots: ResolvedRoot[]): Promise<CapturePlan> {
  const submission = job.submission!;
  const problems: string[] = [];
  const primary = primaryRoot(roots);
  if (!primary?.realRoot) {
    return {
      ok: false,
      problems: ["this scout's checkout is no longer available, so its report cannot be captured"],
    };
  }

  const reportDir = scoutReportDirectory(submission.reportPath);
  if (!reportDir) {
    return { ok: false, problems: [`the report must be at ${SCOUT_REPORT_PATH_SHAPE}`] };
  }

  const files: PlannedFile[] = [];
  const report = await resolveCheckoutFile(primary.realRoot, submission.reportPath);
  if (!report.ok) {
    problems.push(`${submission.reportPath}: ${report.reason}`);
  } else if (report.bytes > SCOUT_LIMITS.primaryReportBytes) {
    problems.push(`${submission.reportPath} exceeds the ${SCOUT_LIMITS.primaryReportBytes}-byte report limit`);
  } else if (await isIgnored(primary.realRoot, submission.reportPath)) {
    problems.push(
      `${submission.reportPath} is ignored by git - a report under an ignored path is not archived`,
    );
  } else {
    files.push({
      source: report.path,
      sourceDev: report.dev,
      sourceIno: report.ino,
      archivePath: SCOUT_PRIMARY_REPORT_PATH,
      role: "primary_report",
      repoSlot: primary.slot,
      originalPath: submission.reportPath,
      bytes: report.bytes,
    });
    const companions = await planReportDirectory(primary, reportDir, report.path);
    if (!companions.ok) return companions;
    problems.push(
      ...companions.missing.map(
        (entry) => `${entry.expectedSource}: ${entry.reason}`,
      ),
    );
    files.push(...companions.files);
  }

  const supporting = await planSupporting(job, roots, reportDir, primary.slot);
  if (!supporting.ok) problems.push(...supporting.problems);
  else files.push(...supporting.files);

  if (problems.length > 0) return { ok: false, problems };

  const limits = limitProblems(files);
  if (limits.length > 0) return { ok: false, problems: limits };
  return { ok: true, files, missing: [], captureStatus: "complete" };
}

/**
 * The plan for a scout that never submitted, from the sources it left behind.
 *
 * The rule is exactly one unambiguous candidate. Two reports in a checkout is not a puzzle to
 * solve with a heuristic - "the newest", "the one matching the slug" - because guessing wrong
 * publishes somebody's draft as the answer, permanently, in a format that is immutable by
 * contract. Zero and two are the same verdict: an honest partial that names what is missing.
 */
async function planRecovery(job: ScoutCaptureJob, roots: ResolvedRoot[]): Promise<CapturePlan> {
  const candidates: Array<{ root: ResolvedRoot; relativePath: string }> = [];
  for (const root of roots) {
    if (!root.realRoot) continue;
    for (const relativePath of await discoverReports(root.realRoot)) {
      candidates.push({ root, relativePath });
    }
  }

  if (candidates.length !== 1) {
    return {
      ok: true,
      files: [],
      missing: [
        {
          kind: "primary_report",
          expectedSource: SCOUT_REPORT_PATH_SHAPE,
          reason:
            candidates.length === 0
              ? "the scout ended without submitting a report, and no report was found in its checkout"
              : `the scout ended without submitting a report, and ${candidates.length} candidate reports ` +
                "were found, so none could be attributed",
        },
      ],
      captureStatus: "partial",
    };
  }

  const only = candidates[0]!;
  const reportDir = scoutReportDirectory(only.relativePath)!;
  const report = await resolveCheckoutFile(only.root.realRoot!, only.relativePath);
  if (!report.ok || report.bytes > SCOUT_LIMITS.primaryReportBytes) {
    return {
      ok: true,
      files: [],
      missing: [
        {
          kind: "primary_report",
          expectedSource: only.relativePath,
          reason: clipReason(
            report.ok ? "the recovered report exceeds its size limit" : `the recovered report ${report.reason}`,
          ),
        },
      ],
      captureStatus: "partial",
    };
  }
  if (await isIgnored(only.root.realRoot!, only.relativePath)) {
    return {
      ok: true,
      files: [],
      missing: [
        {
          kind: "primary_report",
          expectedSource: only.relativePath,
          reason: "the recovered report is ignored by git and was not archived",
        },
      ],
      captureStatus: "partial",
    };
  }

  const files: PlannedFile[] = [
    {
      source: report.path,
      sourceDev: report.dev,
      sourceIno: report.ino,
      archivePath: SCOUT_PRIMARY_REPORT_PATH,
      role: "primary_report",
      repoSlot: only.root.slot,
      originalPath: only.relativePath,
      bytes: report.bytes,
    },
  ];
  const companions = await planReportDirectory(only.root, reportDir, report.path);
  // A recovery that cannot even enumerate the report directory degrades to a partial rather
  // than failing: the alternative is refusing cleanup for ever over a checkout that is on its
  // way out anyway, which is the one thing this path exists to avoid.
  if (!companions.ok) {
    return {
      ok: true,
      files: [],
      missing: [
        {
          kind: "primary_report",
          expectedSource: only.relativePath,
          reason: clipReason(companions.problems[0] ?? "the report directory could not be read"),
        },
      ],
      captureStatus: "partial",
    };
  }
  files.push(...companions.files);
  const limits = limitProblems(files);
  if (limits.length > 0) {
    return {
      ok: true,
      files: [],
      missing: [
        { kind: "primary_report", expectedSource: only.relativePath, reason: clipReason(limits[0]!) },
      ],
      captureStatus: "partial",
    };
  }
  return {
    ok: true,
    files,
    missing: companions.missing,
    captureStatus: companions.missing.length === 0 ? "complete" : "partial",
  };
}

/**
 * Every conventional report path in one checkout: `docs/reports/<slug>/report.html`.
 *
 * One `readdir` of `docs/reports` and a stat per slug, rather than a walk. The convention is
 * the whole point of having one - a recovery that went looking for HTML anywhere in a checkout
 * would find node_modules fixtures and call one of them the answer.
 */
async function discoverReports(realRoot: string): Promise<string[]> {
  const reportsDir = path.join(realRoot, SCOUT_REPORT_ROOT);
  const entries = await readdir(reportsDir, { withFileTypes: true }).catch(() => null);
  if (!entries) return [];
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const relativePath = `${SCOUT_REPORT_ROOT}/${entry.name}/${SCOUT_REPORT_FILENAME}`;
    if (scoutReportSlug(relativePath) === null) continue;
    const info = await lstat(path.join(reportsDir, entry.name, SCOUT_REPORT_FILENAME)).catch(() => null);
    if (info?.isFile() && !info.isSymbolicLink()) found.push(relativePath);
  }
  return found.sort();
}

/**
 * Every file beside the report, recursively, keeping its layout under `report/`.
 *
 * The directory is captured as ONE relative unit because that is what keeps the page's own
 * links working: a report that says `<img src="chart.svg">` is only readable in the archive if
 * `chart.svg` arrived at the same relative position. It is also why the static-HTML validator
 * is handed the set of captured companions - a link to a file that was not captured is refused
 * rather than left dangling.
 *
 * Hidden entries are skipped silently, and that is a deliberate pair of decisions rather than
 * an oversight. A bundle path may not contain a dot-prefixed segment at all
 * (`validateScoutArchivePath`), so `.DS_Store` and an editor swap file CANNOT be archived; and
 * a hidden file the report actually depends on does not slip through unnoticed, because the
 * report then links to a companion that is not in the bundle and validation refuses the whole
 * capture by name. Silence for bookkeeping, a loud refusal when it mattered.
 */
async function planReportDirectory(
  root: ResolvedRoot,
  reportDir: string,
  reportRealPath: string,
): Promise<
  | {
      ok: true;
      files: PlannedFile[];
      missing: ScoutManifestMissing[];
    }
  | { ok: false; problems: string[] }
> {
  const base = path.join(root.realRoot!, reportDir);
  const files: PlannedFile[] = [];
  const missing: ScoutManifestMissing[] = [];
  const problems: string[] = [];

  const walk = async (dir: string, relative: string): Promise<void> => {
    if (problems.length > 0) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      problems.push(`${reportDir}/${relative}: could not be read (${error.code ?? "unknown"})`);
      return null;
    });
    if (!entries) return;
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.name.startsWith(".")) continue;
      const absolute = path.join(dir, entry.name);
      const rel = relative === "" ? entry.name : `${relative}/${entry.name}`;
      const info = await lstat(absolute).catch(() => null);
      if (!info) continue;
      if (info.isSymbolicLink()) {
        missing.push({
          kind: "report_companion",
          expectedSource: `${reportDir}/${rel}`,
          reason: "a symbolic link beside the report was not archived",
        });
        continue;
      }
      if (info.isDirectory()) {
        await walk(absolute, rel);
        continue;
      }
      if (!info.isFile()) {
        missing.push({
          kind: "report_companion",
          expectedSource: `${reportDir}/${rel}`,
          reason: "a file beside the report is not an ordinary file and was not archived",
        });
        continue;
      }
      // The report itself arrives through the primary entry, with its own role and id.
      if (absolute === reportRealPath) continue;
      const originalPath = `${reportDir}/${rel}`;
      if (await isIgnored(root.realRoot!, originalPath)) {
        missing.push({
          kind: "report_companion",
          expectedSource: originalPath,
          reason: "the file is ignored by git and was not archived",
        });
        continue;
      }
      const archivePath = `${SCOUT_REPORT_DIR}/${rel}`;
      if (!validateScoutArchivePath(archivePath)) {
        missing.push({
          kind: "report_companion",
          expectedSource: originalPath,
          reason: "the file's name cannot be represented inside an archive",
        });
        continue;
      }
      files.push({
        source: absolute,
        sourceDev: info.dev,
        sourceIno: info.ino,
        archivePath,
        role: "report_companion",
        repoSlot: root.slot,
        originalPath,
        bytes: info.size,
      });
    }
  };

  await walk(base, "");
  if (problems.length > 0) return { ok: false, problems };
  // Bounded before anything is copied, so a runaway directory costs one walk rather than
  // 128 MiB of writes that then have to be thrown away.
  return { ok: true, files, missing: missing.slice(0, 64) };
}

/** The additional files a scout explicitly named, each through the same defences. */
async function planSupporting(
  job: ScoutCaptureJob,
  roots: ResolvedRoot[],
  reportDir: string,
  primarySlot: string,
): Promise<{ ok: true; files: PlannedFile[] } | { ok: false; problems: string[] }> {
  const files: PlannedFile[] = [];
  const problems: string[] = [];
  const claimed = new Set<string>();

  for (const locator of job.submission?.supporting ?? []) {
    const root = roots.find((entry) => entry.slot === locator.repoSlot);
    if (!root) {
      problems.push(`${locator.repoSlot} is not a repository slot this task issued`);
      continue;
    }
    if (!root.realRoot) {
      problems.push(`${locator.repoSlot} has no available checkout, so ${locator.path} cannot be captured`);
      continue;
    }
    // Resolved BEFORE the archive path is built, because the archive path is derived from what
    // was actually found rather than from what was claimed. `./notes/x`, `notes//x` and
    // `notes/x` are the same file and must not become three different entries - and a name
    // carrying a character the format cannot represent must be refused rather than quietly
    // rewritten into a path that no longer describes the file it came from.
    const resolved = await resolveCheckoutFile(root.realRoot, locator.path);
    if (!resolved.ok) {
      problems.push(`${locator.path}: ${resolved.reason}`);
      continue;
    }
    const relative = path.relative(root.realRoot, resolved.path).split(path.sep).join("/");
    // Files beside the report arrive with the directory. Naming one here would archive it
    // twice under two ids, which is a manifest that describes the same bytes as two artifacts.
    if (root.slot === primarySlot && relative.startsWith(`${reportDir}/`)) {
      problems.push(
        `${locator.path} is already captured with the report directory - do not list files beside the report`,
      );
      continue;
    }
    const archivePath = `${SCOUT_ARTIFACTS_DIR}/${root.slot}/${relative}`;
    if (!validateScoutArchivePath(archivePath)) {
      problems.push(`${locator.path} cannot be represented inside an archive`);
      continue;
    }
    if (claimed.has(archivePath)) {
      problems.push(`${locator.path} was submitted twice for ${root.slot}`);
      continue;
    }
    if (resolved.bytes > SCOUT_LIMITS.supportingFileBytes) {
      problems.push(`${locator.path} exceeds the ${SCOUT_LIMITS.supportingFileBytes}-byte supporting-file limit`);
      continue;
    }
    if (await isIgnored(root.realRoot, relative)) {
      problems.push(`${locator.path} is ignored by git and was not archived`);
      continue;
    }
    claimed.add(archivePath);
    files.push({
      source: resolved.path,
      sourceDev: resolved.dev,
      sourceIno: resolved.ino,
      archivePath,
      role: "supporting",
      repoSlot: root.slot,
      originalPath: relative,
      bytes: resolved.bytes,
    });
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, files };
}

/** Every limit a planned capture would cross, by name. Applied before anything is written. */
function limitProblems(files: readonly PlannedFile[]): string[] {
  const problems: string[] = [];
  const reportFiles = files.filter((file) => file.archivePath.startsWith(`${SCOUT_REPORT_DIR}/`));
  const reportBytes = reportFiles.reduce((sum, file) => sum + file.bytes, 0);
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  if (reportFiles.length > SCOUT_LIMITS.reportDirectoryEntries) {
    problems.push(
      `the report directory holds ${reportFiles.length} files, over the ${SCOUT_LIMITS.reportDirectoryEntries} limit`,
    );
  }
  if (reportBytes > SCOUT_LIMITS.reportDirectoryBytes) {
    problems.push(
      `the report directory is ${reportBytes} bytes, over the ${SCOUT_LIMITS.reportDirectoryBytes} limit`,
    );
  }
  if (files.length > SCOUT_LIMITS.entries) {
    problems.push(`the archive would hold ${files.length} files, over the ${SCOUT_LIMITS.entries} limit`);
  }
  if (totalBytes > SCOUT_LIMITS.bundleBytes) {
    problems.push(`the archive would be ${totalBytes} bytes, over the ${SCOUT_LIMITS.bundleBytes} limit`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Checkout-side containment
// ---------------------------------------------------------------------------

type ResolvedCheckoutFile =
  | { ok: true; path: string; bytes: number; dev: number; ino: number }
  | { ok: false; reason: string };

/**
 * One checkout-relative path, resolved to a real regular file inside a real root.
 *
 * The same three refusals `resolveArchiveFile` makes on the archive side, for the same
 * reasons, against a different root: the path must be relative and free of NUL and control
 * characters, the JOINED path must stay under the root, and the REALPATH must too - which is
 * the only check that sees a symlink swapped in after the plan was made. `lstat` rather than
 * `stat` throughout, because `stat` follows a link and would report its target's type.
 */
async function resolveCheckoutFile(realRoot: string, relativePath: string): Promise<ResolvedCheckoutFile> {
  if (relativePath === "" || path.isAbsolute(relativePath)) {
    return { ok: false, reason: "must be a path relative to the checkout" };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(relativePath)) {
    return { ok: false, reason: "contains characters a path cannot carry" };
  }
  const joined = path.resolve(realRoot, relativePath);
  if (!isInside(realRoot, joined) || joined === realRoot) {
    return { ok: false, reason: "leaves the checkout" };
  }
  // Every component, not only the leaf: a symlinked DIRECTORY on the way down is how a
  // contained-looking path reads a file outside the checkout, and `lstat` on the leaf alone
  // would never see it.
  let walked = realRoot;
  for (const segment of path.relative(realRoot, joined).split(path.sep)) {
    walked = path.join(walked, segment);
    const info = await lstat(walked).catch(() => null);
    if (!info) return { ok: false, reason: "does not exist" };
    if (info.isSymbolicLink()) return { ok: false, reason: "resolves through a symbolic link" };
  }
  const info = await lstat(joined).catch(() => null);
  if (!info) return { ok: false, reason: "does not exist" };
  if (!info.isFile()) return { ok: false, reason: "is not an ordinary file" };
  const real = await realpath(joined).catch(() => null);
  if (!real || !isInside(realRoot, real)) {
    return { ok: false, reason: "resolves outside the checkout" };
  }
  return { ok: true, path: real, bytes: info.size, dev: info.dev, ino: info.ino };
}

/**
 * Whether git would exclude this path from the checkout.
 *
 * Two questions rather than one, because `check-ignore` consults only the exclude rules: a
 * file that is TRACKED but also matches an ignore pattern would be reported as ignored, and
 * refusing a committed report on that basis would be wrong. So an ignored-looking path gets a
 * second question - is it in the index? - and only a path that is both excluded and untracked
 * is refused.
 *
 * A directory that is not a git repository, or a machine with no git, answers "not ignored".
 * That is the permissive direction on purpose: the file is still contained, still an ordinary
 * file, and still explicitly named by the scout, and the alternative - refusing every capture
 * we cannot interrogate - would make a non-git checkout unarchivable.
 */
async function isIgnored(realRoot: string, relativePath: string): Promise<boolean> {
  const excluded = await run("git", ["-C", realRoot, "check-ignore", "-q", "--", relativePath], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (excluded.code !== 0) return false;
  const tracked = await run("git", ["-C", realRoot, "ls-files", "--error-unmatch", "--", relativePath], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  return tracked.code !== 0;
}

/** The commit a checkout is standing on right now, or the recorded fallback. Informational. */
async function headOf(root: ResolvedRoot): Promise<string | null> {
  if (!root.realRoot) return root.head;
  const result = await run("git", ["-C", root.realRoot, "rev-parse", "HEAD"], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  const sha = result.stdout.trim();
  return result.code === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : root.head;
}

// ---------------------------------------------------------------------------
// Staging, verification, publication
// ---------------------------------------------------------------------------

async function publish(
  job: ScoutCaptureJob,
  identity: ScoutArchiveIdentity,
  plan: Extract<CapturePlan, { ok: true }>,
  roots: ResolvedRoot[],
  deps: ScoutCaptureDeps,
  now: () => number,
): Promise<ScoutCaptureOutcome> {
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

    const artifacts: ScoutManifestArtifact[] = [];
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
        id: file.role === "primary_report" ? SCOUT_PRIMARY_ARTIFACT_ID : scoutArtifactId(++ordinal),
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

    const repositories: ScoutManifestRepository[] = [];
    for (const root of roots) {
      repositories.push({ slot: root.slot, label: root.label, head: await headOf(root) });
    }

    const manifest: ScoutManifest = {
      formatVersion: SCOUT_ARCHIVE_FORMAT_VERSION,
      producer: { id: identity.producerId, label: deps.producerLabel },
      archive: {
        id: identity.archiveId,
        createdAt: new Date(job.createdAt).toISOString(),
        completedAt: new Date(now()).toISOString(),
        captureStatus: plan.captureStatus,
        title: job.title,
        question: job.question,
        summary: job.submission?.summary ?? null,
        tags: job.submission?.tags ?? [],
      },
      origin: { ...job.origin, repositories },
      primaryArtifactId:
        artifacts.find((artifact) => artifact.role === "primary_report")?.id ?? null,
      artifacts,
      missing: plan.missing,
      contentDigest:
        formatScoutDigest(
          createHash("sha256").update(canonicalScoutContentPayload(artifacts)).digest("hex"),
        ) ?? "",
    };
    await writeFile(path.join(stageDir, "manifest.json"), serializeScoutManifest(manifest), {
      encoding: "utf8",
      mode: 0o600,
    });

    // Re-read what was just written, through the importer a foreign bundle goes through. This
    // is where an invalid report, a companion the page links to but that was not captured, a
    // digest that does not describe its own contents, and a limit crossed after the plan was
    // made all surface - BEFORE anything is visible in the library.
    const stagingReal = await realpath(staging);
    const staged = await verifyScoutBundle(stagingReal, identity);
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
  identity: ScoutArchiveIdentity,
): Promise<{ captureStatus: ScoutCaptureStatus; artifactCount: number } | null> {
  const real = await realpath(libraryRoot).catch(() => null);
  if (!real) return null;
  const read = await verifyScoutBundle(real, identity);
  if (read.kind !== "verified") return null;
  return {
    captureStatus: read.bundle.manifest.archive.captureStatus,
    artifactCount: read.bundle.manifest.artifacts.length,
  };
}

function stagedProblem(read: Awaited<ReturnType<typeof verifyScoutBundle>>): string {
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
    const digest = formatScoutDigest(hash.digest("hex"));
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
  if (file.role === "primary_report") return SCOUT_LIMITS.primaryReportBytes;
  if (file.role === "report_companion") return SCOUT_LIMITS.reportDirectoryBytes;
  return SCOUT_LIMITS.supportingFileBytes;
}

function clipReason(reason: string): string {
  return reason.slice(0, SCOUT_TEXT_LIMITS.error);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The key one capture publishes under, for a log line and for a test's assertion. */
export function captureArchiveKey(job: ScoutCaptureJob): string {
  return scoutArchiveKey(job.producerId, job.archiveId);
}
