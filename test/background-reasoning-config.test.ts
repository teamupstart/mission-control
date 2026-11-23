import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_REASONING_EFFORT_FLAG_ID } from "../src/shared/feature-flag-registry.ts";
import { ForemanConfigPatchSchema, InspectorConfigPatchSchema, LlmConfigPatchSchema } from "../src/shared/protocol.ts";
import { applyFeatureFlagIntent } from "../src/server/feature-flags/index.ts";
import { getForemanConfig, setForemanConfig } from "../src/server/foreman/config.ts";
import { inspectorExecution, setInspectorConfig } from "../src/server/inspector/config.ts";
import { getLlmConfig, setLlmConfig } from "../src/server/llm/config.ts";

test("background settings preserve sibling overrides and accept a reset to provider default", () => {
  assert.equal(getLlmConfig().efforts, undefined);
  assert.equal(getForemanConfig().efforts, undefined);

  setLlmConfig({ efforts: { goal: "low" } });
  setLlmConfig({ efforts: { "task-title": "high" } });
  setLlmConfig({ efforts: { goal: null } });
  assert.deepEqual(getLlmConfig().efforts, { goal: null, "task-title": "high" });

  setForemanConfig({ efforts: { review: "high", triage: "low" } });
  setForemanConfig({ efforts: { verify: "medium" } });
  setForemanConfig({ efforts: { triage: null } });
  assert.deepEqual(getForemanConfig().efforts, { review: "high", triage: null, verify: "medium" });

  assert.equal(LlmConfigPatchSchema.safeParse({ efforts: { typo: "low" } }).success, false);
  assert.equal(ForemanConfigPatchSchema.safeParse({ efforts: { verify: "extreme" } }).success, false);
  assert.equal(InspectorConfigPatchSchema.safeParse({ effort: "extreme" }).success, false);
  assert.equal(InspectorConfigPatchSchema.safeParse({ effort: null }).success, true);
});

test("Inspector effort resolves live against its selected provider and model", () => {
  setInspectorConfig({ runner: "codex", model: "gpt-5.6-test", effort: "max" });
  assert.equal(inspectorExecution().effort, undefined);
  applyFeatureFlagIntent({ kind: "flag", id: BACKGROUND_REASONING_EFFORT_FLAG_ID, enabled: true });
  assert.equal(inspectorExecution().effort, undefined);
  setInspectorConfig({ model: "gpt-6-sol" });
  assert.equal(inspectorExecution().effort, "max");
  setInspectorConfig({ effort: null });
  assert.equal(inspectorExecution().effort, undefined);
});
