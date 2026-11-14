import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { codexResidentCompactionArgs } from "../src/server/harness/codex/compaction.ts";
import { RESIDENT_RESTATEMENT_HEADING, RESIDENT_STANDING_HEADING, composeResidentLaunch, residentStandingRestatement, residentStandingSection } from "../src/server/residents/launch.ts";
import { RESIDENT_COMPACTION_FOCUS, ResidentProfileRevisionSchema, residentCompactionFocus, type ResidentRun } from "../src/shared/residents.ts";
import { HARNESS_MODEL_CATALOG_LIMITS } from "../src/shared/protocol.ts";
import { Registry, type SessionCompacted } from "../src/server/registry.ts";

test("Codex compaction refuses an oversized native model catalog", (t) => {
  const home = mkdtempSync(join(tmpdir(), "resident-model-window-bound-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "models_cache.json");
  const entry = { slug: "test-model", context_window: 100_000, effective_context_window_percent: 100 };
  const models = Array.from({ length: HARNESS_MODEL_CATALOG_LIMITS.choices }, () => entry);
  writeFileSync(path, JSON.stringify({ models }));
  assert.deepEqual(codexResidentCompactionArgs("test-model", 70, path), ["-c", "model_auto_compact_token_limit=70000"]);
  writeFileSync(path, JSON.stringify({ models: [...models, null] }));
  assert.throws(() => codexResidentCompactionArgs("test-model", 70, path), /context window is unavailable/);
});

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
    profileId: "compaction-profile",
    persona: { personaId: "p", name: "Observer", guidanceMarkdown: "" }, runInstructions: "",
    settings: ResidentProfileRevisionSchema.parse({ identity: { name: "Observer" }, persona: { personaId: "p" }, loop: { contextThreshold: 42 } }),
  } as ResidentRun;
  const repository = { text: "", mechanism: "none" as const, sources: [] };
  assert.deepEqual(composeResidentLaunch({ run, agent: "codex", runtime: "sdk" }, repository).residentCompaction, { threshold: 42 });
  assert.equal(composeResidentLaunch({ run, agent: "claude", runtime: "sdk" }, repository).residentCompaction, undefined);
});

test("the restatement is the resident section its launch delivered, verbatim, after the repository rules", () => {
  const run = {
    profileId: "restatement-profile",
    persona: { personaId: "p", name: "Shepherd", guidanceMarkdown: "Watch every running task." },
    runInstructions: "Focus on the release branch today.",
    settings: ResidentProfileRevisionSchema.parse({ identity: { name: "Shepherd" }, persona: { personaId: "p" },
      instructions: { markdown: "Unblock stuck work.\n\n- Never merge." } }),
  } as ResidentRun;
  const repository = { text: "Repository rule: run the linter.", mechanism: "claude-sdk-system-prompt-append" as const, sources: [] };
  const delivered = composeResidentLaunch({ run, agent: "claude", runtime: "sdk" }, repository).standing.text;
  const section = residentStandingSection(run);
  assert.ok(section.startsWith(`${RESIDENT_STANDING_HEADING}: Shepherd\n\nWatch every running task.`));
  for (const part of ["### Profile instructions\n\nUnblock stuck work.\n\n- Never merge.", "### Instructions for this run\n\nFocus on the release branch today.", "### Durable resident state"]) {
    assert.ok(section.includes(part), part);
  }
  assert.equal(delivered, `${repository.text}\n\n${section}`, "the launch delivered exactly this section after the repository rules");
  assert.ok(!section.includes(repository.text), "repository rules are not restated: they never left the conversation's instructions");
  const restatement = residentStandingRestatement(run);
  assert.ok(restatement.startsWith(`${RESIDENT_RESTATEMENT_HEADING}\n\n`));
  assert.ok(restatement.includes(`\n\n${section}\n\n---`), "the section is carried whole, not summarized");
});

test("every resident compaction carries the mission-preserving focus ahead of the profile's own", () => {
  assert.equal(residentCompactionFocus(""), RESIDENT_COMPACTION_FOCUS);
  assert.equal(residentCompactionFocus("  "), RESIDENT_COMPACTION_FOCUS);
  assert.equal(residentCompactionFocus(" Keep the release list. "), `${RESIDENT_COMPACTION_FOCUS} Keep the release list.`);
  assert.doesNotMatch(RESIDENT_COMPACTION_FOCUS, /\n/, "it rides on the /compact argument line");
});

test("a driver's compaction reaches the registry's internal listeners, and only an SDK session's does", () => {
  const registry = new Registry();
  const heard: SessionCompacted[] = [];
  const unsubscribe = registry.onCompacted((event) => heard.push(event));
  registry.registerSdkSession({ id: "sdk:compacting", agent: "claude", name: "compacting", cwd: tmpdir() });
  registry.applyDriverEvent("sdk:compacting", { kind: "compacted" });
  registry.applyDriverEvent("sdk:unknown", { kind: "compacted" });
  assert.deepEqual(heard, [{ sessionId: "sdk:compacting" }]);
  unsubscribe();
  registry.applyDriverEvent("sdk:compacting", { kind: "compacted" });
  assert.equal(heard.length, 1, "unsubscribed listeners hear nothing");
});
