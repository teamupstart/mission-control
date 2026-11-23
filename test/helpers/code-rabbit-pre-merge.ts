// Synthetic version of the summary-table format seen in agent-platform-api PR #70.
export function preMergeBody(status = "Error", detail = "Use an online constraint migration."): string {
  return `<!-- walkthrough_start -->Unrelated review summary<!-- walkthrough_end -->
<!-- pre_merge_checks_walkthrough_start -->
| Check name | Status | Explanation | Resolution |
| :--- | :---: | :--- | :--- |
| Zero-Downtime Deployment Safety | ![${status}](https://example.test/pre-merge.svg) | Migration takes a strong lock... | Split the migration... |
| Security Review (Advisory) | ![Warning](https://example.test/warning.svg) | Permissions are too broad... | Scope permissions... |
| Out-Of-Band Config Coordination | ![Warning](https://example.test/warning.svg) (previously flagged, unaddressed) | Provisioning is not documented... | Record provisioning owners... |
<details><summary>Passed checks: 1 passed</summary>
| Check name | Status | Explanation |
| :--- | :---: | :--- |
| Title check | ![Passed](https://example.test/passed.svg) | Title is accurate. |
</details>
<details><summary><strong>Full details: Zero-Downtime Deployment Safety</strong></summary>
**Explanation**
The migration can block traffic.
**Resolution**
${detail}
</details>
<!-- pre_merge_checks_walkthrough_end -->`;
}

export function preMergeComment(body = preMergeBody(), url = "https://github.com/acme/mission-e2e/pull/27#issuecomment-70") {
  return { id: "IC_premerge", url, body, updatedAt: "2026-01-01T00:00:00Z",
    author: { __typename: "Bot", login: "coderabbitai" } };
}
