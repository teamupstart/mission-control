import { readFile } from "node:fs/promises";
import {
  ARCHIVE_LIMITS,
  ARCHIVE_PRIMARY_REPORT_PATH,
  ARCHIVE_REPORT_DIR,
  type ArchiveManifestMissing,
} from "@shared/archives.ts";
import { PLAN_PAGE_FILENAME } from "@shared/plans.ts";
import type { ArchiveCaptureJob } from "../archives/capture-store.ts";
import { isIgnored, resolveCheckoutFile } from "../archives/checkout.ts";
import { validateStaticReportHtml } from "../archives/html.ts";
import {
  clipReason,
  limitProblems,
  type CapturePlan,
  type CapturePlanDeps,
  type PlannedFile,
  type ResolvedRoot,
} from "../archives/plan.ts";
import { planCapturedDirectory } from "../archives/report-directory.ts";
import { planPagePath } from "./capture-scopes.ts";

/**
 * Which files in a plan task's checkout become one plan archive.
 *
 * The `plan` counterpart of `scouts/capture-plan.ts`, and a second module beside it rather
 * than a branch inside it, exactly as that file said the second kind would arrive.
 *
 * Registered as the `plan` planner in `archives/planners.ts`. It captures ONE directory: the
 * one its job's scope names, which `plans/capture-scopes.ts` derived from the task's own diff
 * when the job was reserved. Nothing here rediscovers directories, which is what makes a
 * capture resumed after a restart archive what was reserved rather than whatever the tree
 * holds by then - the same reason the job's `kind` is frozen at reservation.
 *
 * ## Why this planner degrades where a scout's refuses
 *
 * A scout's submitted report is the deliverable, it is an untracked file, and a scout cannot
 * be marked done without it - so refusing a capture is how the agent is told to fix its
 * report, and the loop closes. A plan is the opposite on all three counts: it is committed,
 * it lands in a pull request, its task completes on Foreman's ordinary boundary, and there is
 * no submission to correct. Refusing a capture over the CONTENT of a page the agent wrote
 * would therefore block every teardown path for that task permanently, with no way for
 * anyone to clear it, to protect files that are already safe in git.
 *
 * So a content problem - an unreachable checkout, a page over its limit, a page that is not
 * self-contained - produces an honest `partial` that names what is missing and still captures
 * everything else in the directory, INCLUDING the page itself as an ordinary companion under
 * its own name. Only the mechanical failures a retry can fix - a copy that could not be made,
 * a bundle that would not stage - come back as refusals, and those are raised by the
 * publication path rather than here.
 */
export async function planPlanCapture(
  job: ArchiveCaptureJob,
  roots: ResolvedRoot[],
  deps: CapturePlanDeps,
): Promise<CapturePlan> {
  const scope = job.scope;
  if (!scope) {
    // Structural rather than content: a plan job with no scope was never told what to
    // capture, so there is no honest partial to publish - a bundle claiming to preserve "a
    // plan" while naming none is exactly the empty archive the planner registry exists to
    // prevent.
    return { ok: false, problems: ["this plan capture job does not name a plan directory"] };
  }
  const pagePath = planPagePath(scope.directory);
  const root = roots.find((entry) => entry.slot === scope.slot);
  if (!root?.realRoot) {
    return unavailable(pagePath, "the checkout this plan was written in is no longer available");
  }

  const page = await resolveCheckoutFile(root.realRoot, pagePath);
  const primary =
    page.ok && page.bytes <= ARCHIVE_LIMITS.primaryReportBytes && !(await isIgnored(root.realRoot, pagePath))
      ? page
      : null;

  // The page is skipped from the directory walk only when it is going to arrive as the
  // primary. When it is not, it is captured under its own name instead of being dropped: a
  // plan whose page cannot lead the bundle is still a plan worth keeping, and `plan.html`
  // sitting beside `plan.md` is also what keeps the other documents' links to it resolving.
  const captured = await planCapturedDirectory(
    root,
    scope.directory,
    primary ? primary.path : null,
    deps.beforeCompanionDirectory,
  );
  if (!captured.ok) {
    return unavailable(pagePath, captured.problems[0] ?? "the plan directory could not be read");
  }

  const missing: ArchiveManifestMissing[] = [...captured.missing];
  const files: PlannedFile[] = [];

  if (primary) {
    // Validated HERE rather than left to the staging verifier, and that placement is the
    // whole difference between an honest partial and a wedged worktree. The verifier's only
    // vocabulary is "refuse the bundle", which on this path means refusing the teardown of
    // every plan task whose agent wrote one remote `<img>`.
    const problem = await pageProblem(primary.path, captured.files, scope.directory);
    if (problem) {
      missing.push({ kind: "primary_report", expectedSource: pagePath, reason: clipReason(problem) });
      // The walk above skipped this file because it was going to be the primary. It is not,
      // so it is added back under its own name - the same resolved identity, not a second
      // lookup, so the bytes copied are the ones that were validated.
      files.push({
        source: primary.path,
        sourceDev: primary.dev,
        sourceIno: primary.ino,
        archivePath: `${ARCHIVE_REPORT_DIR}/${PLAN_PAGE_FILENAME}`,
        role: "report_companion",
        repoSlot: root.slot,
        originalPath: pagePath,
        bytes: primary.bytes,
      });
    } else {
      files.push({
        source: primary.path,
        sourceDev: primary.dev,
        sourceIno: primary.ino,
        archivePath: ARCHIVE_PRIMARY_REPORT_PATH,
        role: "primary_report",
        repoSlot: root.slot,
        originalPath: pagePath,
        bytes: primary.bytes,
      });
    }
  } else {
    missing.push({
      kind: "primary_report",
      expectedSource: pagePath,
      reason: clipReason(
        !page.ok
          ? `the plan's page ${page.reason}`
          : page.bytes > ARCHIVE_LIMITS.primaryReportBytes
            ? "the plan's page exceeds its size limit"
            : "the plan's page is ignored by git and was not archived",
      ),
    });
  }

  files.push(...captured.files);

  const limits = limitProblems(files);
  if (limits.length > 0) {
    // Over a limit is a property of the directory, not a transient fault, so retrying the
    // teardown would refuse for ever. The bundle records why it holds nothing instead.
    return unavailable(pagePath, limits[0]!);
  }

  const hasPrimary = files.some((file) => file.role === "primary_report");
  if (!hasPrimary && files.length === 0) {
    return unavailable(pagePath, "the plan directory held no file that could be archived");
  }
  return {
    ok: true,
    files,
    missing,
    captureStatus: hasPrimary && missing.length === 0 ? "complete" : "partial",
  };
}

/**
 * Why a page cannot lead the bundle, or null when it can.
 *
 * The same rules `verifyArchiveBundle` will apply at staging, asked one step earlier so the
 * answer can be "publish a partial" rather than "refuse everything". The companion set is
 * passed so a page linking to a file that was not captured is caught here too - a plan page
 * linking to a phase document that git ignores would otherwise stage a bundle with a dead
 * link and be refused for it.
 */
async function pageProblem(
  realPath: string,
  companions: readonly PlannedFile[],
  directory: string,
): Promise<string | null> {
  const html = await readFile(realPath, { encoding: "utf8" }).catch(() => null);
  if (html === null) return "the plan's page could not be read as UTF-8 text";
  const targets = new Set<string>();
  for (const file of companions) {
    if (file.originalPath.startsWith(`${directory}/`)) {
      targets.add(file.originalPath.slice(directory.length + 1));
    }
  }
  const validation = validateStaticReportHtml(html, targets);
  if (validation.ok) return null;
  return `the plan's page is not a self-contained static page: ${validation.problems
    .map((problem) => problem.message)
    .join("; ")}`;
}

/** A published record that this plan could not be reached, rather than a blocked teardown. */
function unavailable(pagePath: string, reason: string): CapturePlan {
  return {
    ok: true,
    files: [],
    missing: [{ kind: "primary_report", expectedSource: pagePath, reason: clipReason(reason) }],
    captureStatus: "partial",
  };
}
