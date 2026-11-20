/** GitHub-confirmed progress, scoped to one PR URL rather than a session branch. */
export interface PrBranchUpdate {
  status: "updating" | "checks" | "review" | "blocked" | "conflict";
  reason: string | null;
}
export function branchUpdateLabel(update: PrBranchUpdate): string {
  switch (update.status) {
    case "updating": return "Updating branch";
    case "checks": return "Waiting for checks";
    case "review": return "Waiting for review";
    case "conflict": return "Branch update conflicts";
    case "blocked": return "Branch update blocked";
  }
}
export function branchConflictPrompt(url: string): string {
  return `Resolve the branch update conflicts for ${url}. Fetch its current target branch, merge it into the PR branch, resolve conflicts, run focused checks and push. Do not merge the pull request.`;
}
