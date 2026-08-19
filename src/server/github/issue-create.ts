import type { RunResult } from "../util/exec.ts";

/** The generic reading of one `gh issue create` subprocess. */
export type GitHubIssueCreateOutcome =
  | { kind: "created"; url: string }
  | { kind: "refused"; detail: string }
  | { kind: "unknown"; reason: "process" | "missing-url" };

/**
 * Preserve the public-side-effect ordering shared by task-source pushes and product reports.
 * A child death wins over its exit code; a command-reported failure is safe to retry; only
 * the last HTTP(S) line on a clean exit is success; malformed success is unknown.
 */
export function githubIssueCreateOutcome(res: RunResult): GitHubIssueCreateOutcome {
  if (res.outcomeUnknown) return { kind: "unknown", reason: "process" };
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout).trim().split("\n")[0] ?? "";
    return { kind: "refused", detail };
  }
  const url = res.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//.test(line))
    .pop();
  return url
    ? { kind: "created", url }
    : { kind: "unknown", reason: "missing-url" };
}
