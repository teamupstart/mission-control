import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { PIPELINE_CALLER_CREDENTIAL_FILE_ENV } from "../../src/shared/pipeline.ts";

export function pipelineCredentialFromDescriptor(
  descriptor: { args: string[]; env: Record<string, string> } | null | undefined,
): string {
  assert.ok(descriptor);
  const path = descriptor.env[PIPELINE_CALLER_CREDENTIAL_FILE_ENV];
  assert.ok(path, "the descriptor names its private credential file");
  assert.equal(statSync(path).mode & 0o077, 0, "the credential file is owner-only");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    credential?: unknown;
    expiresAt?: unknown;
  };
  assert.equal(typeof parsed.credential, "string");
  assert.equal(typeof parsed.expiresAt, "number");
  assert.ok(Number(parsed.expiresAt) > Date.now());
  assert.ok(!descriptor.args.some((argument) => argument.includes(String(parsed.credential))));
  return String(parsed.credential);
}
