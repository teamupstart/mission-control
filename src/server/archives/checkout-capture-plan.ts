import path from "node:path";
import { ARCHIVE_ARTIFACTS_DIR, ARCHIVE_LIMITS, validateArchivePath } from "@shared/archives.ts";
import type { ArchiveCaptureJob } from "./capture-store.ts";
import { resolveCheckoutFile } from "./checkout.ts";
import { limitProblems, type CapturePlan, type CapturePlanDeps, type PlannedFile, type ResolvedRoot } from "./plan.ts";

/**
 * Which files a `checkout` archive holds: exactly the frozen list on the job's scope, and only
 * while each file still has the bytes the retention decision saw.
 *
 * Nothing is discovered here. Automatic retention found these files by comparing an orphaned
 * checkout with its proof commit and reserved this job immediately before removing the
 * directory, so the list is the decision; a file that moved, grew or was swapped for a link is
 * refused by name and the checkout stays. Every file is a supporting artifact under
 * `artifacts/<slot>/`, and the bundle is `partial` because there is no report.
 */
export async function planCheckoutCapture(
  job: ArchiveCaptureJob,
  roots: ResolvedRoot[],
  _deps: CapturePlanDeps,
): Promise<CapturePlan> {
  const scope = job.scope;
  if (!scope?.files?.length) return { ok: false, problems: ["this checkout archive names no files"] };
  const root = roots.find((entry) => entry.slot === scope.slot);
  if (!root?.realRoot) return { ok: false, problems: ["the checkout these files live in is no longer available"] };
  const files: PlannedFile[] = [];
  const problems: string[] = [];
  for (const file of scope.files) {
    const resolved = await resolveCheckoutFile(root.realRoot, file.path);
    if (!resolved.ok) {
      problems.push(`${file.path}: ${resolved.reason}`);
      continue;
    }
    const relative = path.relative(root.realRoot, resolved.path).split(path.sep).join("/");
    const archivePath = `${ARCHIVE_ARTIFACTS_DIR}/${root.slot}/${checkoutArchiveSegments(relative)}`;
    if (relative !== file.path || !validateArchivePath(archivePath)) {
      problems.push(`${file.path} cannot be represented inside an archive`);
    } else if (resolved.bytes !== file.bytes) {
      problems.push(`${file.path} changed after it was selected`);
    } else if (resolved.bytes > ARCHIVE_LIMITS.supportingFileBytes) {
      problems.push(`${file.path} exceeds the ${ARCHIVE_LIMITS.supportingFileBytes}-byte file limit`);
    } else {
      files.push({
        expectedSha256: file.sha256,
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
  }
  if (problems.length > 0) return { ok: false, problems };
  const limits = limitProblems(files);
  if (limits.length > 0) return { ok: false, problems: limits };
  return {
    ok: true,
    files,
    missing: [{ kind: "primary_report", expectedSource: null, reason: "an orphaned checkout's local-only files have no report" }],
    captureStatus: "partial",
  };
}

/**
 * The bundle path for one checkout-relative path, escaped so every checkout file can be held.
 *
 * Archive paths refuse a segment that starts with `.`, and an orphan's local-only work is often
 * exactly there - a modified `.github/workflows/ci.yml`, an untracked `.envrc`. Each segment is
 * percent-escaped: `%` becomes `%25`, then a leading `.` becomes `%2E`. The mapping is
 * reversible, so no two checkout paths share a bundle path, and the manifest's `original_path`
 * keeps the path exactly as it was in the checkout.
 */
export function checkoutArchiveSegments(relative: string): string {
  return relative.split("/").map((segment) => segment.replaceAll("%", "%25").replace(/^\./, "%2E")).join("/");
}
