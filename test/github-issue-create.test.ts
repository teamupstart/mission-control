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
  assert.deepEqual(githubIssueCreateOutcome(killed), {
    kind: "unknown",
    reason: "process",
  });

  assert.deepEqual(
    githubIssueCreateOutcome(stubRun({ stdout: "", stderr: "label missing\nmore", code: 1 })),
    { kind: "refused", detail: "label missing" },
  );

  assert.deepEqual(
    githubIssueCreateOutcome(stubRun({
      stdout:
        "https://github.com/acme/issues/issues/1\n" +
        "https://github.com/acme/issues/issues/2\n",
      stderr: "",
      code: 0,
    })),
    { kind: "created", url: "https://github.com/acme/issues/issues/2" },
  );

  assert.deepEqual(
    githubIssueCreateOutcome(stubRun({ stdout: "created\n", stderr: "", code: 0 })),
    { kind: "unknown", reason: "missing-url" },
  );
});
