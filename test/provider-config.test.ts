import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-provider-config-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { getForemanConfig, setForemanConfig } = await import("../src/server/foreman/config.ts");
const { getInspectorConfig, inspectorModel, setInspectorConfig } = await import(
  "../src/server/inspector/config.ts"
);

after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => openDb().exec("DELETE FROM app_config"));

test("Foreman persists Codex independently from the app-wide background provider", () => {
  setForemanConfig({ runner: "codex", reviewModel: "gpt-5.6-terra" });
  const cfg = getForemanConfig();
  assert.equal(cfg.runner, "codex");
  assert.equal(cfg.reviewModel, "gpt-5.6-terra");
});

test("Foreman merges backlog launch defaults per harness", () => {
  setForemanConfig({ backlogDefaultModel: { codex: "gpt-5.6-terra" } });
  const cfg = setForemanConfig({ backlogDefaultModel: { claude: "claude-sonnet-5" } });
  assert.deepEqual(cfg.backlogDefaultModel, {
    claude: "claude-sonnet-5",
    codex: "gpt-5.6-terra",
    pi: null,
  });
});

test("Inspector persists Codex and resolves its Codex default after restart-style reread", () => {
  setInspectorConfig({ runner: "codex", model: "" });
  const cfg = getInspectorConfig();
  assert.equal(cfg.runner, "codex");
  assert.equal(cfg.model, "");
  assert.equal(inspectorModel(cfg).id, "gpt-5.6-sol");
});
