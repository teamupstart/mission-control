import type { RunResult } from "../util/exec.ts";

/** The generic reading of one `gh issue create` subprocess. */
export type GitHubIssueCreateOutcome =
  | { kind: "created"; url: string; warning?: string }
  | { kind: "refused"; detail: string }
  | { kind: "unknown"; reason: "process" | "missing-url" };

/** Accept only the exact issue URL path for the repository this invocation targeted. */
function createdIssueUrl(stdout: string, expectedRepo: string): string | undefined {
  const [expectedOwner, expectedName, ...extra] = expectedRepo.split("/");
  if (!expectedOwner || !expectedName || extra.length > 0) return undefined;

  return stdout
    .split("\n")
    .map((line) => line.trim())
    .flatMap((line) => {
      let candidate: URL;
      try {
        candidate = new URL(line);
      } catch {
        return [];
      }
      const [owner, name, resource, number, ...rest] = candidate.pathname
        .split("/")
        .filter(Boolean);
      return (
        (candidate.protocol === "https:" || candidate.protocol === "http:") &&
        owner?.toLowerCase() === expectedOwner.toLowerCase() &&
        name?.toLowerCase() === expectedName.toLowerCase() &&
        resource === "issues" &&
        /^\d+$/.test(number ?? "") &&
        rest.length === 0 &&
        candidate.search === "" &&
        candidate.hash === ""
      ) ? [line] : [];
    })
    .pop();
}

/**
 * Preserve the public-side-effect ordering shared by task-source pushes and product reports.
 * A child death wins over its exit code. The released gh 2.99 partial-upload contract is a
 * non-zero exit with the created issue URL on stdout and the upload error on stderr. Only an
 * issue URL whose path matches the invocation's target repository proves creation. A non-zero
 * run without that URL is safe to retry; malformed success is unknown.
 */
export function githubIssueCreateOutcome(
  res: RunResult,
  expectedRepo: string,
): GitHubIssueCreateOutcome {
  if (res.outcomeUnknown) return { kind: "unknown", reason: "process" };
  const url = createdIssueUrl(res.stdout, expectedRepo);
  if (res.code !== 0) {
    const detail = ((res.stderr || res.stdout).trim().split("\n")[0] ?? "").slice(0, 1_000);
    if (url) return { kind: "created", url, ...(detail ? { warning: detail } : {}) };
    return { kind: "refused", detail };
  }
  return url
    ? { kind: "created", url }
    : { kind: "unknown", reason: "missing-url" };
}
