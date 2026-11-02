import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { codexResidentCompactionArgs } from "../src/server/harness/codex/compaction.ts";
import { composeResidentLaunch } from "../src/server/residents/launch.ts";
import { ResidentProfileRevisionSchema, type ResidentRun } from "../src/shared/residents.ts";

test("Codex's backstop uses the native effective window and refuses absent or malformed metadata", (t) => {
  const home = mkdtempSync(join(tmpdir(), "resident-model-window-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "models_cache.json");
  writeFileSync(path, JSON.stringify({ models: [{ slug: "test-model", context_window: 272_000, effective_context_window_percent: 95 }] }));
  assert.deepEqual(codexResidentCompactionArgs("test-model", 70, path), ["-c", "model_auto_compact_token_limit=180880"]);
  writeFileSync(path, JSON.stringify({ models: [null, { slug: "unrelated", context_window: null },
    { slug: "test-model", context_window: 272_000, effective_context_window_percent: 95 }] }));
  assert.deepEqual(codexResidentCompactionArgs("test-model", 70, path), ["-c", "model_auto_compact_token_limit=180880"], "unrelated malformed entries cannot disable the selected model");
  assert.throws(() => codexResidentCompactionArgs("unrelated", 70, path), /context window is unavailable/);
  for (const model of [null, "unknown"]) assert.throws(() => codexResidentCompactionArgs(model, 70, path), /context window is unavailable/);
  for (const content of ["{}", "malformed", "x".repeat(4_000_001)]) {
    writeFileSync(path, content);
    assert.throws(() => codexResidentCompactionArgs("test-model", 70, path), /context window is unavailable/);
  }
});

test("the pinned launch contributor enables only the proven native layer", () => {
  const run = {
    persona: { personaId: "p", name: "Observer", guidanceMarkdown: "" }, runInstructions: "",
    settings: ResidentProfileRevisionSchema.parse({ identity: { name: "Observer" }, persona: { personaId: "p" }, loop: { contextThreshold: 42 } }),
  } as ResidentRun;
  const repository = { text: "", mechanism: "none" as const, sources: [] };
  assert.deepEqual(composeResidentLaunch({ run, agent: "codex", runtime: "sdk" }, repository).residentCompaction, { threshold: 42 });
  assert.equal(composeResidentLaunch({ run, agent: "claude", runtime: "sdk" }, repository).residentCompaction, undefined);
});
