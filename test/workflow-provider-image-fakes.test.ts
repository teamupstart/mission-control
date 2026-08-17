import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const manifest = [
  "```workflow-image-manifest-untrusted",
  JSON.stringify([{
    id: "image-1",
    caption: "Pixels must cross the provider boundary",
    displayName: "proof.png",
    repositoryScope: "repo-01",
    mimeType: "image/png",
    bytes: 8,
    sha256: "a".repeat(64),
  }]),
  "```",
  "E2E_PASS_VERDICT",
].join("\n");

test("the fake Claude provider rejects a workflow manifest with no native image block", () => {
  const fake = fileURLToPath(new URL("../e2e/fixtures/fake-claude.mjs", import.meta.url));
  const frame = {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: manifest }] },
    parent_tool_use_id: null,
  };
  const result = spawnSync(process.execPath, [fake, "--setting-sources="], {
    input: `${JSON.stringify(frame)}\n`,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pixels did not match the manifest/);
});

test("the fake Codex provider rejects a workflow manifest with no --image bytes", () => {
  const fake = fileURLToPath(new URL("../e2e/fixtures/fake-codex.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [fake, "exec", "--json", "-"], {
    input: manifest,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /bytes did not match --image inputs/);
});
