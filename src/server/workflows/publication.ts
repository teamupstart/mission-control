import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { posix } from "node:path";
import { WORKFLOW_TEXT_EVIDENCE_LIMITS, type WorkflowContextSnapshot,
  type WorkflowEvidenceTextArtifact } from "@shared/workflow.ts";
import { scoutReportDirectory } from "@shared/scouts.ts";
import { validateStaticReportHtml } from "../archives/html.ts";
import { captureWorktreeTree, isolatedGitEnvironment } from "../git/worktree-tree.ts";
import { run } from "../util/exec.ts";
import { inspectCheckoutTextArtifact } from "./images.ts";

/**
 * Reports have an explicit local-artifact convention. A suffix alone grants no exemption:
 * the report must be untracked, static and self-contained, and every excluded byte is frozen
 * as ordinary workflow text evidence before the submission can use this projection.
 * Images belong inline in the page; independent ignored evidence uses the existing tray.
 */
export async function captureWorkflowPublication(
  cwd: string,
  reservedTextEvidence: readonly Pick<WorkflowEvidenceTextArtifact, "bytes">[] = [],
): Promise<{
  contentTreeOid: string;
  publication: NonNullable<WorkflowContextSnapshot["evidence"]["publication"]>;
  artifacts: WorkflowEvidenceTextArtifact[];
}> {
  const env = isolatedGitEnvironment();
  const toplevel = await run("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { env });
  if (toplevel.code !== 0) throw new Error("Could not resolve the workflow checkout");
  const root = realpathSync(toplevel.stdout.trim());
  const headFiles = await run("git", ["-C", root, "ls-tree", "-r", "--name-only", "-z", "HEAD"], { env });
  const tracked = new Set(headFiles.stdout.split("\0"));
  const listed = await run("git", ["-C", root, "ls-files", "--others", "--exclude-standard", "-z"], {
    env: isolatedGitEnvironment(),
  });
  if (listed.code !== 0) throw new Error("Could not enumerate local report artifacts");
  const untracked = listed.stdout.split("\0").filter((path) => path && !tracked.has(path)).sort();
  const artifacts: WorkflowEvidenceTextArtifact[] = [];
  const artifactProblems: string[] = [];
  const problem = (path: string, reason: string) => {
    if (artifactProblems.length < 100) artifactProblems.push(`${path}: ${reason}`.slice(0, 2_000));
  };
  // The submission's frozen reservation has first claim on the shared text budget.
  // A report group that cannot fit stays in the publication tree, including its companions.
  let bytes = reservedTextEvidence.reduce((total, item) => total + item.bytes, 0);
  for (const reportPath of untracked) {
    const directory = scoutReportDirectory(reportPath);
    if (!directory) continue;
    // Only bounded text evidence beside a conventional report is eligible. New source,
    // binary assets, other HTML and tracked documentation remain required publication.
    const paths = untracked.filter((path) => path === reportPath
      || (posix.dirname(path) === directory && /\.(?:txt|log|csv|json)$/.test(path)));
    if (paths.some((path) => path.length > WORKFLOW_TEXT_EVIDENCE_LIMITS.displayNameChars)) {
      problem(reportPath, "artifact path exceeds the retention limit");
      continue;
    }
    if (reservedTextEvidence.length + artifacts.length + paths.length > WORKFLOW_TEXT_EVIDENCE_LIMITS.maxCount) {
      problem(reportPath, "too many report artifacts to retain");
      continue;
    }
    const group: WorkflowEvidenceTextArtifact[] = [];
    try {
      for (const path of paths) {
        const inspected = await inspectCheckoutTextArtifact(root, path);
        group.push({
          id: `local-report-${createHash("sha256").update(path).digest("hex")}`,
          ordinal: artifacts.length + group.length,
          displayName: path,
          caption: `Local report artifact retained outside Git: ${path}`,
          repositoryScope: "all",
          mimeType: "text/plain",
          bytes: inspected.bytes,
          sha256: inspected.sha256,
          content: inspected.content,
          availability: "retained",
          prunedAt: null,
          createdAt: Date.now(),
        });
      }
    } catch (error) {
      problem(reportPath, error instanceof Error ? error.message : "artifact could not be retained");
      // Invalid, oversized, symlinked or unreadable artifacts remain publication work.
      continue;
    }
    const report = group.find((item) => item.displayName === reportPath)!;
    const validation = validateStaticReportHtml(report.content, new Set(paths.map((path) => posix.basename(path))));
    if (!validation.ok) {
      problem(reportPath, validation.problems.map((item) => item.message).join("; "));
      continue;
    }
    const groupBytes = group.reduce((total, item) => total + item.bytes, 0);
    if (bytes + groupBytes > WORKFLOW_TEXT_EVIDENCE_LIMITS.maxAggregateBytes) {
      problem(reportPath, "report artifacts exceed the retention byte limit");
      continue;
    }
    bytes += groupBytes;
    artifacts.push(...group);
  }
  const localArtifacts = artifacts.map((item) => ({
    path: item.displayName, sha256: item.sha256, bytes: item.bytes,
  }));
  const tree = await captureWorktreeTree(root, { localArtifacts });
  return {
    contentTreeOid: tree.treeOid,
    publication: {
      version: 1,
      treeOid: tree.publicationTreeOid,
      unpublishedPaths: tree.unpublishedPaths.slice(0, 500),
      pathsTruncated: tree.unpublishedPaths.length > 500,
      localArtifacts,
      artifactProblems,
    },
    artifacts,
  };
}
