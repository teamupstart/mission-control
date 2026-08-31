import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";

const home = mkdtempSync(join(tmpdir(), "mission-scout-submission-auth-"));
process.env.MISSION_HOME = home;
const inheritedCredential = process.env.MISSION_SCOUT_SUBMISSION_CREDENTIAL;
const inheritedCredentialFile = process.env.MISSION_SCOUT_SUBMISSION_CREDENTIAL_FILE;
delete process.env.MISSION_SCOUT_SUBMISSION_CREDENTIAL;
delete process.env.MISSION_SCOUT_SUBMISSION_CREDENTIAL_FILE;

const {
  provisionScoutSubmissionCredential,
  verifyScoutSubmissionCredential,
} = await import("../src/server/scouts/submission-auth.ts");
const {
  SCOUT_SUBMISSION_CREDENTIAL_FILE_ENV,
  isolatedScoutSubmissionCredentialPath,
  readScoutSubmissionCredential,
  scoutSubmissionCredentialPath,
} = await import("../src/shared/harness-runtime.mjs");

const isolatedCredentialPaths: string[] = [];

after(() => {
  if (inheritedCredential === undefined) delete process.env.MISSION_SCOUT_SUBMISSION_CREDENTIAL;
  else process.env.MISSION_SCOUT_SUBMISSION_CREDENTIAL = inheritedCredential;
  if (inheritedCredentialFile === undefined) delete process.env.MISSION_SCOUT_SUBMISSION_CREDENTIAL_FILE;
  else process.env.MISSION_SCOUT_SUBMISSION_CREDENTIAL_FILE = inheritedCredentialFile;
  rmSync(home, { recursive: true, force: true });
  for (const path of isolatedCredentialPaths) rmSync(path, { force: true });
});

test("a provisioned scout credential authenticates exactly one task and checkout", () => {
  const cwd = resolve(home, "checkout-a");
  const token = provisionScoutSubmissionCredential("task-a", cwd);

  assert.equal(readScoutSubmissionCredential(cwd), token);
  assert.deepEqual(verifyScoutSubmissionCredential(token), { taskId: "task-a", cwd });
  assert.equal(readScoutSubmissionCredential(resolve(home, "checkout-b")), "");
  assert.equal(statSync(join(home, "scout-submission.key")).mode & 0o777, 0o600);
  assert.equal(statSync(scoutSubmissionCredentialPath(cwd)).mode & 0o777, 0o600);
  const isolatedPath = isolatedScoutSubmissionCredentialPath(cwd);
  isolatedCredentialPaths.push(isolatedPath);
  assert.equal(readFileSync(isolatedPath, "utf8").trim(), token);
  assert.equal(statSync(isolatedPath).mode & 0o777, 0o600);
});

test("an isolated MCP process reads a credential rotated after it launched", () => {
  const cwd = resolve(home, "checkout-late-assignment");
  const credentialFile = isolatedScoutSubmissionCredentialPath(cwd);
  isolatedCredentialPaths.push(credentialFile);
  const previous = process.env[SCOUT_SUBMISSION_CREDENTIAL_FILE_ENV];
  process.env[SCOUT_SUBMISSION_CREDENTIAL_FILE_ENV] = credentialFile;
  try {
    assert.equal(readScoutSubmissionCredential(cwd), "");
    const first = provisionScoutSubmissionCredential("task-first", cwd);
    assert.equal(readScoutSubmissionCredential(cwd), first);
    const second = provisionScoutSubmissionCredential("task-second", cwd);
    assert.notEqual(second, first);
    assert.equal(readScoutSubmissionCredential(cwd), second);
  } finally {
    if (previous === undefined) delete process.env[SCOUT_SUBMISSION_CREDENTIAL_FILE_ENV];
    else process.env[SCOUT_SUBMISSION_CREDENTIAL_FILE_ENV] = previous;
  }
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
