import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readPipelineCallerCredential } from "../src/mcp/pipeline-credential.ts";
import {
  PIPELINE_CALLER_CREDENTIAL_ENV,
  PIPELINE_CALLER_CREDENTIAL_FILE_ENV,
} from "../src/shared/pipeline.ts";

const root = mkdtempSync(join(tmpdir(), "mission-pipeline-credential-"));
const legacy = "legacy-pipeline-credential-that-is-long-enough";
const current = "current-pipeline-credential-that-is-long-enough";

after(() => rmSync(root, { recursive: true, force: true }));

function credentialFile(name: string, body: unknown): string {
  const path = join(root, name);
  writeFileSync(path, JSON.stringify(body), { mode: 0o600 });
  return path;
}

test("the legacy environment credential is used only when no credential file is named", () => {
  assert.equal(
    readPipelineCallerCredential({ [PIPELINE_CALLER_CREDENTIAL_ENV]: legacy }, 100),
    legacy,
  );
});

test("a valid private credential file replaces the legacy environment credential", () => {
  const path = credentialFile("valid.json", { credential: current, expiresAt: 101 });
  assert.equal(
    readPipelineCallerCredential({
      [PIPELINE_CALLER_CREDENTIAL_FILE_ENV]: path,
      [PIPELINE_CALLER_CREDENTIAL_ENV]: legacy,
    }, 100),
    current,
  );
});

test("an invalid named credential file never falls back to the legacy credential", () => {
  const invalid = credentialFile("invalid.json", { credential: "short", expiresAt: 101 });
  const expired = credentialFile("expired.json", { credential: current, expiresAt: 100 });
  const malformed = join(root, "malformed.json");
  writeFileSync(malformed, "not json", { mode: 0o600 });

  for (const path of [invalid, expired, malformed, join(root, "missing.json")]) {
    assert.equal(
      readPipelineCallerCredential({
        [PIPELINE_CALLER_CREDENTIAL_FILE_ENV]: path,
        [PIPELINE_CALLER_CREDENTIAL_ENV]: legacy,
      }, 100),
      null,
      path,
    );
  }
});
