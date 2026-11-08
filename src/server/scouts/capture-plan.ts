import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import {
  ARCHIVE_ARTIFACTS_DIR,
  ARCHIVE_LIMITS,
  ARCHIVE_PRIMARY_REPORT_PATH,
  ARCHIVE_REPORT_DIR,
  validateArchivePath,
} from "@shared/archives.ts";
import {
  SCOUT_REPORT_FILENAME,
  SCOUT_REPORT_PATH_SHAPE,
  SCOUT_REPORT_ROOT,
  scoutReportDirectory,
  scoutReportSlug,
} from "@shared/scouts.ts";
import type { ArchiveCaptureJob } from "../archives/capture-store.ts";
import { isIgnored, primaryRoot, resolveCheckoutFile } from "../archives/checkout.ts";
import { planCapturedDirectory } from "../archives/report-directory.ts";
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
 * the conventional report path, the explicitly submitted supporting files, and the recovery
 * rule for a scout that ended without submitting. `archives/` publishes whatever this returns
 * and knows none of it.
 *
 * Capturing a directory as one relative unit under `report/` is NOT one of those things and
 * moved to `archives/report-directory.ts` when the second kind arrived: a scout's
 * `docs/reports/<slug>/` and a plan's `docs/plans/<name>/` are the same problem wearing
 * different names, and two copies of that walk is how one kind's containment checks quietly
 * stop matching the other's.
 *
 * Registered as the `scout` planner in `archives/planners.ts`. The second kind did arrive as
 * a second module beside this one (`plans/capture-plan.ts`) rather than as a branch inside it.
 */
export async function planScoutCapture(
  job: ArchiveCaptureJob,
  roots: ResolvedRoot[],
  deps: CapturePlanDeps,
): Promise<CapturePlan> {
  return job.submission ? planSubmitted(job, roots, deps) : planRecovery(job, roots, deps);
}

/**
 * Explicit submissions capture only their selected files; legacy calls capture the directory.
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
  } else if (submission.files === undefined && await isIgnored(primary.realRoot, submission.reportPath)) {
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
    if (submission.files === undefined) {
      const companions = await planCapturedDirectory(
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
  const companions = await planCapturedDirectory(
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

/** Selected evidence (or legacy additional files), each through the same path defences. */
async function planSupporting(
  job: ArchiveCaptureJob,
  roots: ResolvedRoot[],
  reportDir: string,
  primarySlot: string,
): Promise<{ ok: true; files: PlannedFile[] } | { ok: false; problems: string[] }> {
  const files: PlannedFile[] = [];
  const problems: string[] = [];
  const claimed = new Set<string>();

  const submission = job.submission!;
  const explicit = submission.files !== undefined;
  let selectedPrimary = false;
  if (explicit && submission.supporting.length > 0) {
    return { ok: false, problems: ["files and supporting cannot be combined; put every selected file in files"] };
  }

  for (const locator of submission.files ?? submission.supporting) {
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
    // Legacy calls collect neighbors with the directory; explicit calls must name them.
    const besideReport = root.slot === primarySlot && relative.startsWith(`${reportDir}/`);
    if (!explicit && besideReport) {
      problems.push(
        `${locator.path} is already captured with the report directory - do not list files beside the report`,
      );
      continue;
    }
    const archivePath = explicit && besideReport
      ? `${ARCHIVE_REPORT_DIR}/${relative.slice(reportDir.length + 1)}`
      : `${ARCHIVE_ARTIFACTS_DIR}/${root.slot}/${relative}`;
    if (!validateArchivePath(archivePath)) {
      problems.push(`${locator.path} cannot be represented inside an archive`);
      continue;
    }
    if (claimed.has(archivePath)) {
      problems.push(`${locator.path} was submitted twice for ${root.slot}`);
      continue;
    }
    claimed.add(archivePath);
    if (explicit && root.slot === primarySlot && relative === submission.reportPath) {
      selectedPrimary = true;
      continue; // The primary entry above owns its stricter size limit and role.
    }
    if (resolved.bytes > ARCHIVE_LIMITS.supportingFileBytes) {
      problems.push(`${locator.path} exceeds the ${ARCHIVE_LIMITS.supportingFileBytes}-byte supporting-file limit`);
      continue;
    }
    if (!explicit && await isIgnored(root.realRoot, relative)) {
      problems.push(`${locator.path} is ignored by git and was not archived`);
      continue;
    }
    files.push({
      source: resolved.path,
      sourceDev: resolved.dev,
      sourceIno: resolved.ino,
      archivePath,
      role: explicit && besideReport ? "report_companion" : "supporting",
      repoSlot: root.slot,
      originalPath: relative,
      bytes: resolved.bytes,
    });
  }

  if (explicit && !selectedPrimary) {
    problems.push(`files must include the primary report ${submission.reportPath} in ${primarySlot}`);
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, files };
}
