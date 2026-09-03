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
        stdout: "https://github.com/acme/from-cwd/issues/3\n",
        stderr: "",
        code: 0,
      }),
      "",
    ),
    { kind: "created", url: "https://github.com/acme/from-cwd/issues/3" },
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

// Captured from released gh 2.99.0 against disposable public issue #5 on 2026-09-03.
// The first image uploaded, the second disappeared after argument validation, and gh created
// the issue with the successful image before reporting the second upload failure.
test("released gh 2.99 partial output identifies the created issue for its target", () => {
  assert.deepEqual(
    githubIssueCreateOutcome(
      stubRun({
        stdout: "https://github.com/mancej-cyc/mission-control-issues/issues/5\n",
        stderr:
          "failed to upload /private/tmp/second.png: open /private/tmp/second.png: " +
          "no such file or directory\n",
        code: 1,
      }),
      "mancej-cyc/mission-control-issues",
    ),
    {
      kind: "created",
      url: "https://github.com/mancej-cyc/mission-control-issues/issues/5",
      partialFailure: true,
    },
  );
});
