/** Runtime PR policy and publication checks, including for frozen workflow actions. */
export function pullRequestPolicyContract(): string {
  return [
    "## Pull request creation policy",
    "Read the current shared setting with Mission Control get_pull_request_policy immediately before creating each PR, including each repository in a multi-repository task. Do not reuse a value from an earlier turn or a prepared workflow packet. If the policy cannot be read, stop before creating the PR and report the blocker.",
    "When alwaysDraftPr is true, every new PR must be created as a draft by adding -F draft=true to the REST create command the pull-request skill gives. Only the human may promote it to ready for review; do not run gh pr ready or an equivalent API, even to trigger CI or finish this workflow. Verify the created PR is a draft. With the option off, follow the task's normal creation instructions. Updating an existing PR preserves its draft or ready status, including a PR the human already promoted.",
    "## Pull request publication verification",
    "Preflight and Persona review inspect draft PR content. Publication proof belongs here, when this action creates or updates the PR, including after a repair round. After creating or updating the PR, read back its URL, published title and body from GitHub. Check them against the task's title and description requirements, including required deviation notes; repair mismatches before reporting this action complete. Verify required notes posted in a comment by reading back that comment. Return the verified PR URL and report the publication checks. A local draft or a successful create/edit command alone is not publication proof. If read-back is unavailable, report the blocker instead of claiming verification. Keep all other review, evidence and CI obligations in place.",
  ].join("\n\n");
}
