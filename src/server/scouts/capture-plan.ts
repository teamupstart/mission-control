import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import {
  ARCHIVE_ARTIFACTS_DIR,
  ARCHIVE_LIMITS,
  ARCHIVE_PRIMARY_REPORT_PATH,
  ARCHIVE_REPORT_DIR,
  validateArchivePath,
  type ArchiveManifestMissing,
} from "@shared/archives.ts";
import {
  SCOUT_REPORT_FILENAME,
  SCOUT_REPORT_PATH_SHAPE,
  SCOUT_REPORT_ROOT,
  scoutReportDirectory,
  scoutReportSlug,
} from "@shared/scouts.ts";
import type { ArchiveCaptureJob } from "../archives/capture-store.ts";
import {
  isIgnored,
  primaryRoot,
  resolveCheckoutDirectory,
  resolveCheckoutFile,
} from "../archives/checkout.ts";
import {
  clipReason,
  limitProblems,
  type CapturePlan,
  type CapturePlanDeps,
  type PlannedFile,
  type ResolvedRoot,
} from "../archives/plan.ts";

/**
 * Which files in a scout's checkout become its archive.
 *
 * This is everything about capture that is scout-shaped, and it is deliberately all of it:
 * the conventional report path, the report directory captured as one relative unit, the
 * explicitly submitted supporting files, and the recovery rule for a scout that ended
 * without submitting. `archives/` publishes whatever this returns and knows none of it.
 *
 * Registered as the `scout` planner in `archives/planners.ts`. A second kind arrives as a
 * second module beside this one, not as a branch inside it.
 */
export async function planScoutCapture(
  job: ArchiveCaptureJob,
  roots: ResolvedRoot[],
  deps: CapturePlanDeps,
): Promise<CapturePlan> {
  return job.submission ? planSubmitted(job, roots, deps) : planRecovery(job, roots, deps);
}

/**
 * The plan for a scout that submitted: its report directory, plus the files it named.
 *
 * Every refusal collects rather than short-circuits, so an agent correcting its submission
 * learns about all four bad paths at once instead of one per round trip.
 */
async function planSubmitted(
  job: ArchiveCaptureJob,
  roots: ResolvedRoot[],
  deps: CapturePlanDeps,
): Promise<CapturePlan> {
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
  } else if (report.bytes > ARCHIVE_LIMITS.primaryReportBytes) {
    problems.push(`${submission.reportPath} exceeds the ${ARCHIVE_LIMITS.primaryReportBytes}-byte report limit`);
  } else if (await isIgnored(primary.realRoot, submission.reportPath)) {
    problems.push(
      `${submission.reportPath} is ignored by git - a report under an ignored path is not archived`,
    );
  } else {
    files.push({
      source: report.path,
      sourceDev: report.dev,
      sourceIno: report.ino,
      archivePath: ARCHIVE_PRIMARY_REPORT_PATH,
      role: "primary_report",
      repoSlot: primary.slot,
      originalPath: submission.reportPath,
      bytes: report.bytes,
    });
    const companions = await planReportDirectory(
      primary,
      reportDir,
      report.path,
      deps.beforeCompanionDirectory,
    );
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
async function planRecovery(
  job: ArchiveCaptureJob,
  roots: ResolvedRoot[],
  deps: CapturePlanDeps,
): Promise<CapturePlan> {
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
  if (!report.ok || report.bytes > ARCHIVE_LIMITS.primaryReportBytes) {
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
      archivePath: ARCHIVE_PRIMARY_REPORT_PATH,
      role: "primary_report",
      repoSlot: only.root.slot,
      originalPath: only.relativePath,
      bytes: report.bytes,
    },
  ];
  const companions = await planReportDirectory(
    only.root,
    reportDir,
    report.path,
    deps.beforeCompanionDirectory,
  );
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
 * (`validateArchivePath`), so `.DS_Store` and an editor swap file CANNOT be archived; and
 * a hidden file the report actually depends on does not slip through unnoticed, because the
 * report then links to a companion that is not in the bundle and validation refuses the whole
 * capture by name. Silence for bookkeeping, a loud refusal when it mattered.
 */
async function planReportDirectory(
  root: ResolvedRoot,
  reportDir: string,
  reportRealPath: string,
  beforeDirectory?: (directory: string) => Promise<void>,
): Promise<
  | {
      ok: true;
      files: PlannedFile[];
      missing: ArchiveManifestMissing[];
    }
  | { ok: false; problems: string[] }
> {
  const files: PlannedFile[] = [];
  const missing: ArchiveManifestMissing[] = [];
  const problems: string[] = [];

  const walk = async (relative: string): Promise<void> => {
    if (problems.length > 0) return;
    const directoryPath = relative === "" ? reportDir : `${reportDir}/${relative}`;
    const before = await resolveCheckoutDirectory(root.realRoot!, directoryPath);
    if (!before.ok) {
      problems.push(`${directoryPath}: ${before.reason}`);
      return;
    }
    const entries = await readdir(before.path, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      problems.push(`${reportDir}/${relative}: could not be read (${error.code ?? "unknown"})`);
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
          expectedSource: `${reportDir}/${rel}`,
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
          expectedSource: `${reportDir}/${rel}`,
          reason: "a file beside the report is not an ordinary file and was not archived",
        });
        continue;
      }
      // The report itself arrives through the primary entry, with its own role and id.
      if (absolute === reportRealPath) continue;
      const originalPath = `${reportDir}/${rel}`;
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

/** The additional files a scout explicitly named, each through the same defences. */
async function planSupporting(
  job: ArchiveCaptureJob,
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
    const archivePath = `${ARCHIVE_ARTIFACTS_DIR}/${root.slot}/${relative}`;
    if (!validateArchivePath(archivePath)) {
      problems.push(`${locator.path} cannot be represented inside an archive`);
      continue;
    }
    if (claimed.has(archivePath)) {
      problems.push(`${locator.path} was submitted twice for ${root.slot}`);
      continue;
    }
    if (resolved.bytes > ARCHIVE_LIMITS.supportingFileBytes) {
      problems.push(`${locator.path} exceeds the ${ARCHIVE_LIMITS.supportingFileBytes}-byte supporting-file limit`);
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
