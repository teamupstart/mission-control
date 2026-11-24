import assert from "node:assert/strict";
import test from "node:test";
import { githubIssueCreateOutcome } from "../src/server/github/issue-create.ts";
import { stubRun, type RunResult } from "../src/server/util/exec.ts";

// A public create has three outcomes, not two. These cases pin the generic classifier now
// shared by task-source pushes and product reports, including the load-bearing ordering.

test("issue-create outcome classification preserves refusal and uncertainty", () => {
  const killed: RunResult = {
    ...stubRun({ stdout: "https://github.com/acme/issues/issues/1\n", stderr: "", code: 1 }),
    outcomeUnknown: true,
  };
  assert.deepEqual(githubIssueCreateOutcome(killed, "acme/issues"), {
    kind: "unknown",
    reason: "process",
  });

  assert.deepEqual(
    githubIssueCreateOutcome(
      stubRun({ stdout: "", stderr: "label missing\nmore", code: 1 }),
      "acme/issues",
    ),
    { kind: "refused", detail: "label missing" },
  );

  assert.deepEqual(
    githubIssueCreateOutcome(
      stubRun({
        stdout: "https://github.com/acme/issues/issues/3\n",
        stderr: "failed to upload second.png\nmore",
        code: 1,
      }),
      "acme/issues",
    ),
    {
      kind: "created",
      url: "https://github.com/acme/issues/issues/3",
      partialFailure: true,
    },
  );

  assert.deepEqual(
    githubIssueCreateOutcome(
      stubRun({
        stdout:
          "https://github.com/acme/issues/issues/1\n" +
          "https://github.com/acme/issues/issues/2\n",
        stderr: "",
        code: 0,
      }),
      "ACME/Issues",
    ),
    { kind: "created", url: "https://github.com/acme/issues/issues/2" },
  );

  assert.deepEqual(
    githubIssueCreateOutcome(
      stubRun({ stdout: "created\n", stderr: "", code: 0 }),
      "acme/issues",
    ),
    { kind: "unknown", reason: "missing-url" },
  );

  assert.deepEqual(
    githubIssueCreateOutcome(
      stubRun({
        stdout: "https://cli.github.com/manual/gh_issue_create\n",
        stderr: "request failed",
        code: 1,
      }),
      "acme/issues",
    ),
    { kind: "refused", detail: "request failed" },
  );

  assert.deepEqual(
    githubIssueCreateOutcome(
      stubRun({
        stdout: "https://other-host.example/acme/issues/issues/3\n",
        stderr: "request failed",
        code: 1,
      }),
      "acme/issues",
    ),
    { kind: "refused", detail: "request failed" },
  );

  assert.deepEqual(
    githubIssueCreateOutcome(
      stubRun({
        stdout: "http://github.com/acme/issues/issues/3\n",
        stderr: "request failed",
        code: 1,
      }),
      "acme/issues",
    ),
    { kind: "refused", detail: "request failed" },
  );

  assert.deepEqual(
    githubIssueCreateOutcome(
      stubRun({
        stdout: "https://github.com:444/acme/issues/issues/3\n",
        stderr: "request failed",
        code: 1,
      }),
      "acme/issues",
    ),
    { kind: "refused", detail: "request failed" },
  );

  assert.deepEqual(
    githubIssueCreateOutcome(
      stubRun({
        stdout: "https://github.example.com/acme/issues/issues/3\n",
        stderr: "",
        code: 0,
      }),
      "github.example.com/acme/issues",
    ),
    { kind: "created", url: "https://github.example.com/acme/issues/issues/3" },
  );

  assert.deepEqual(
    githubIssueCreateOutcome(
      stubRun({
        stdout: "https://github.com/other/repository/issues/3\n",
        stderr: "request failed",
        code: 1,
      }),
      "acme/issues",
    ),
    { kind: "refused", detail: "request failed" },
  );

  assert.deepEqual(
    githubIssueCreateOutcome(
      stubRun({
        stdout: "",
        stderr: "https://github.com/acme/issues/issues/3\nfailed to upload",
        code: 1,
      }),
      "acme/issues",
    ),
    { kind: "refused", detail: "https://github.com/acme/issues/issues/3" },
  );
});

// The fork case the empty-repository wildcard used to accept: a create run in a checkout whose
// `upstream` is the parent, where gh filed the issue on the parent. Only the repository the
// caller resolved and named proves creation, and a blank target names none, so neither
// reads as created and nothing is recorded against an issue on somebody else's repository.
test("a create URL on any repository but the targeted one is not a created issue", () => {
  const onParent = "https://github.com/teamupstart/mission-control/issues/7\n";
  assert.deepEqual(
    githubIssueCreateOutcome(stubRun({ stdout: onParent, stderr: "", code: 0 }), "octo-fork/mission-control"),
    { kind: "unknown", reason: "missing-url" },
  );
  for (const blank of ["", "/", "acme/"]) {
    assert.deepEqual(
      githubIssueCreateOutcome(stubRun({ stdout: onParent, stderr: "", code: 0 }), blank),
      { kind: "unknown", reason: "missing-url" },
      `expected repository ${JSON.stringify(blank)} accepted a URL`,
    );
  }
});

// Captured from released gh 2.99.0 against disposable public issue #5 on 2026-09-03.
// The first image uploaded, the second disappeared after argument validation, and gh created
// the issue with the successful image before reporting the second upload failure.
test("released gh 2.99 partial output identifies the created issue for its target", () => {
  assert.deepEqual(
    githubIssueCreateOutcome(
      stubRun({
        stdout: "https://github.com/teamupstart/mission-control/issues/5\n",
        stderr:
          "failed to upload /private/tmp/second.png: open /private/tmp/second.png: " +
          "no such file or directory\n",
        code: 1,
      }),
      "teamupstart/mission-control",
    ),
    {
      kind: "created",
      url: "https://github.com/teamupstart/mission-control/issues/5",
      partialFailure: true,
    },
  );
});
