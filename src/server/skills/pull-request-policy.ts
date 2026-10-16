/** Live lookup, rather than a preference frozen into an immutable workflow version. */
export function pullRequestPolicyContract(): string {
  return [
    "## Pull request creation policy",
    "Read the current shared setting with Mission Control get_pull_request_policy immediately before creating each PR, including each repository in a multi-repository task. Do not reuse a value from an earlier turn or a prepared workflow packet. If the policy cannot be read, stop before creating the PR and report the blocker.",
    "When alwaysDraftPr is true, every new PR must use gh pr create --draft (or the equivalent draft flag). Only the human may promote it to ready for review; do not run gh pr ready or an equivalent API, even to trigger CI or finish this workflow. Verify the created PR is a draft. With the option off, follow the task's normal creation instructions. Updating an existing PR preserves its draft or ready status, including a PR the human already promoted.",
  ].join("\n\n");
}
