import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";

const home = mkdtempSync(join(tmpdir(), "mission-scout-submission-auth-"));
process.env.MISSION_HOME = home;

const {
  provisionScoutSubmissionCredential,
  verifyScoutSubmissionCredential,
} = await import("../src/server/scouts/submission-auth.ts");
const { readScoutSubmissionCredential, scoutSubmissionCredentialPath } = await import(
  "../src/shared/harness-runtime.mjs"
);

after(() => rmSync(home, { recursive: true, force: true }));

test("a provisioned scout credential authenticates exactly one task and checkout", () => {
  const cwd = resolve(home, "checkout-a");
  const token = provisionScoutSubmissionCredential("task-a", cwd);

  assert.equal(readScoutSubmissionCredential(cwd), token);
  assert.deepEqual(verifyScoutSubmissionCredential(token), { taskId: "task-a", cwd });
  assert.equal(readScoutSubmissionCredential(resolve(home, "checkout-b")), "");
  assert.equal(statSync(join(home, "scout-submission.key")).mode & 0o777, 0o600);
  assert.equal(statSync(scoutSubmissionCredentialPath(cwd)).mode & 0o777, 0o600);
});

test("a caller holding only a changed or invented bearer cannot forge its scope", () => {
  const token = provisionScoutSubmissionCredential("task-a", resolve(home, "checkout-a"));
  const [payload, signature] = token.split(".");
  const different = provisionScoutSubmissionCredential("task-b", resolve(home, "checkout-b"));
  const [differentPayload] = different.split(".");

  assert.equal(verifyScoutSubmissionCredential(undefined), null);
  assert.equal(verifyScoutSubmissionCredential("not-a-credential"), null);
  assert.equal(verifyScoutSubmissionCredential(`${differentPayload}.${signature}`), null);
  assert.equal(verifyScoutSubmissionCredential(`${payload}.${signature?.slice(1)}x`), null);
});
