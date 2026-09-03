import type { RunResult } from "../util/exec.ts";

/** The generic reading of one `gh issue create` subprocess. */
export type GitHubIssueCreateOutcome =
  | { kind: "created"; url: string; partialFailure?: true }
  | { kind: "refused"; detail: string }
  | { kind: "unknown"; reason: "process" | "missing-url" };

/** Accept only the GitHub host and issue path for the repository this invocation targeted. */
function createdIssueUrl(stdout: string, expectedRepo: string): string | undefined {
  const parts = expectedRepo.split("/");
  const target = expectedRepo === ""
    ? { host: "github.com", owner: undefined, name: undefined }
    : parts.length === 2 && parts[0] && parts[1]
      ? { host: "github.com", owner: parts[0], name: parts[1] }
      : parts.length === 3 && parts[0] && parts[1] && parts[2]
        ? { host: parts[0], owner: parts[1], name: parts[2] }
        : null;
  if (!target) return undefined;

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
        candidate.protocol === "https:" &&
        candidate.host.toLowerCase() === target.host.toLowerCase() &&
        (target.owner === undefined || owner?.toLowerCase() === target.owner.toLowerCase()) &&
        (target.name === undefined || name?.toLowerCase() === target.name.toLowerCase()) &&
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
 * issue URL whose host and path match the invocation's target repository proves creation. A
 * non-zero run without that URL is safe to retry; malformed success is unknown. Process output
 * never crosses this boundary on a created result because attachment errors can contain local
 * filesystem paths.
 */
export function githubIssueCreateOutcome(
  res: RunResult,
  expectedRepo: string,
): GitHubIssueCreateOutcome {
  if (res.outcomeUnknown) return { kind: "unknown", reason: "process" };
  const url = createdIssueUrl(res.stdout, expectedRepo);
  if (res.code !== 0) {
    if (url) return { kind: "created", url, partialFailure: true };
    const detail = ((res.stderr || res.stdout).trim().split("\n")[0] ?? "").slice(0, 1_000);
    return { kind: "refused", detail };
  }
  return url
    ? { kind: "created", url }
    : { kind: "unknown", reason: "missing-url" };
}
