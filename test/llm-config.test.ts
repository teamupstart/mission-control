import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake: the LLM config is the one blob two PROCESSES read - the daemon resolves
// its background jobs from it, and the Foreman worker reads the runner off a route backed by
// it. So the two things that must hold are the ones a single-reader config never has to
// think about.
//
// First, a stored value this build cannot resolve must DEGRADE, not throw. `getLlmConfig` is
// on the path of every titling, every goal refresh, every digest and the settings route; a
// schema that rejected a runner id from a newer build would take all of them down over a
// preference, and a downgrade is an ordinary thing to do.
//
// Second, a patch merges the model map PER KEY. Two dashboards are the normal case, and a
// replacing write means the second tab's stale map silently clears an override the first tab
// just typed. The PATCH schema is strict where the config's is tolerant, for the opposite
// reason: a typo from the panel should be a refusal the operator can read, not a key that
// sits in the blob forever doing nothing.
//
// Real db, so the round-trip through zod's defaults is exercised rather than mocked.

const home = mkdtempSync(join(tmpdir(), "mission-llm-cfg-"));
// Set before importing anything that resolves the state dir.
process.env.HARNESS_HOME = join(home, "state");

const { openDb, setAppConfig } = await import("../src/server/db.ts");
const {
  claudeTransportChoice,
  getLlmConfig,
  llmJobModel,
  llmRunnerChoice,
  llmStatus,
  setLlmConfig,
} = await import("../src/server/llm/config.ts");
const { LLM_JOB_IDS, LLM_JOB_SPECS } = await import("../src/shared/llm-jobs.ts");
const { CLAUDE_TRANSPORTS, DEFAULT_LLM_RUNNER_ID, LLM_RUNNER_IDS } = await import(
  "../src/shared/llm.ts"
);
const { LlmConfigPatchSchema } = await import("../src/shared/protocol.ts");

after(() => rmSync(home, { recursive: true, force: true }));

beforeEach(() => {
  openDb().exec("DELETE FROM app_config");
  for (const job of LLM_JOB_IDS) delete process.env[LLM_JOB_SPECS[job].envVar];
  delete process.env.MISSION_LLM_RUNNER;
  delete process.env.MISSION_CLAUDE_TRANSPORT;
});

test("an unconfigured daemon spawns exactly what the hardcoded constants did", () => {
  // The whole promise of this migration: never open the panel, get the old behaviour.
  assert.equal(llmRunnerChoice().id, DEFAULT_LLM_RUNNER_ID);
  assert.equal(claudeTransportChoice(), "print");
  for (const job of LLM_JOB_IDS) {
    const resolved = llmJobModel(job);
    assert.equal(resolved.id, LLM_JOB_SPECS[job].fallback, job);
    assert.equal(resolved.source, "default", job);
  }
});

test("Claude transport resolves config, then env, then the print default", () => {
  process.env.MISSION_CLAUDE_TRANSPORT = "sdk";
  assert.equal(claudeTransportChoice(), "sdk", "the environment fallback was ignored");

  setLlmConfig({ claudeTransport: "print" });
  assert.equal(claudeTransportChoice(), "print", "the stored choice must beat the environment");

  setLlmConfig({ claudeTransport: "sdk" });
  assert.equal(claudeTransportChoice(), "sdk");
});

test("an unknown Claude transport degrades to print instead of breaking background work", () => {
  setAppConfig("llm", { claudeTransport: "future-wire", models: {} });
  assert.doesNotThrow(() => getLlmConfig());
  assert.equal(getLlmConfig().claudeTransport, "");
  assert.equal(claudeTransportChoice(), "print");

  process.env.MISSION_CLAUDE_TRANSPORT = "future-wire";
  assert.equal(claudeTransportChoice(), "print");
});

test("a model override is stored and resolves as `config`", () => {
  setLlmConfig({ models: { goal: "claude-sonnet-5" } });
  assert.equal(llmJobModel("goal").id, "claude-sonnet-5");
  assert.equal(llmJobModel("goal").source, "config");
  // The others are untouched by a write that named one job.
  assert.equal(llmJobModel("task-title").source, "default");
});

test("Codex background-job defaults are persisted and provider-compatible", () => {
  setLlmConfig({ runner: "codex", models: { goal: "" } });
  assert.equal(getLlmConfig().runner, "codex");
  assert.deepEqual(llmJobModel("goal"), {
    job: "goal",
    id: "gpt-5.6-luna",
    source: "default",
  });
});

test("the model map merges per key, so two panels editing different jobs commute", () => {
  setLlmConfig({ models: { goal: "a" } });
  setLlmConfig({ models: { "task-title": "b" } });
  const cfg = getLlmConfig();
  assert.equal(cfg.models.goal, "a", "a later write cleared an earlier, unrelated one");
  assert.equal(cfg.models["task-title"], "b");
});

test("an empty string is stored, and means 'go back to the ladder'", () => {
  setLlmConfig({ models: { goal: "claude-sonnet-5" } });
  setLlmConfig({ models: { goal: "" } });
  assert.equal(getLlmConfig().models.goal, "", "a cleared box must not be dropped from the patch");
  assert.equal(llmJobModel("goal").id, LLM_JOB_SPECS.goal.fallback);
  assert.equal(llmJobModel("goal").source, "default");
});

test("an env var outranks the shipped default and is reported as such", () => {
  process.env[LLM_JOB_SPECS.goal.envVar] = "claude-opus-4-8";
  const resolved = llmJobModel("goal");
  assert.equal(resolved.id, "claude-opus-4-8");
  // The SOURCE is what the panel prints under an empty box - the one thing an empty greyed
  // field cannot tell you is whether it is a shipped default or an env var overriding it.
  assert.equal(resolved.source, "env");
});

test("a config override still beats the env var", () => {
  process.env[LLM_JOB_SPECS.goal.envVar] = "from-env";
  setLlmConfig({ models: { goal: "from-config" } });
  assert.equal(llmJobModel("goal").id, "from-config");
});

test("a stored runner this build cannot resolve degrades instead of throwing", () => {
  // Written straight to the KV, as a newer build (or a hand edit) would leave it. Every
  // reader below is on a hot path; a throw here is a daemon that cannot title a dispatch.
  setAppConfig("llm", { runner: "ollama", models: { goal: "claude-sonnet-5" } });
  assert.doesNotThrow(() => getLlmConfig());
  assert.equal(llmRunnerChoice().id, DEFAULT_LLM_RUNNER_ID);
  // ...and the rest of the blob survives the one field that could not be read.
  assert.equal(llmJobModel("goal").id, "claude-sonnet-5");
});

test("a stored models map of the wrong shape degrades instead of throwing", () => {
  setAppConfig("llm", { models: "not an object" });
  assert.doesNotThrow(() => getLlmConfig());
  assert.equal(llmJobModel("goal").id, LLM_JOB_SPECS.goal.fallback);
});

test("the PATCH refuses what the config tolerates, so a typo is answerable", () => {
  // The panel writes through this. Tolerating an unknown job here would store a key that
  // never resolves - a control that appears to work and does nothing.
  assert.equal(LlmConfigPatchSchema.safeParse({ models: { "not-a-job": "x" } }).success, false);
  assert.equal(LlmConfigPatchSchema.safeParse({ runner: "ollama" }).success, false);
  assert.equal(LlmConfigPatchSchema.safeParse({ claudeTransport: "future-wire" }).success, false);
  assert.equal(LlmConfigPatchSchema.safeParse({}).success, false, "an empty patch says nothing");
  assert.equal(LlmConfigPatchSchema.safeParse({ runner: LLM_RUNNER_IDS[0] }).success, true);
  assert.equal(LlmConfigPatchSchema.safeParse({ runner: "" }).success, true, "clearing the pick");
  for (const transport of CLAUDE_TRANSPORTS) {
    assert.equal(LlmConfigPatchSchema.safeParse({ claudeTransport: transport }).success, true);
  }
  assert.equal(
    LlmConfigPatchSchema.safeParse({ claudeTransport: "" }).success,
    true,
    "clearing the transport pick",
  );
  assert.equal(LlmConfigPatchSchema.safeParse({ models: { goal: "" } }).success, true);
});

test("the status route carries every job, the runner, and the providers this build has", () => {
  const status = llmStatus();
  assert.deepEqual(Object.keys(status.models).sort(), [...LLM_JOB_IDS].sort());
  assert.deepEqual(
    status.runners.map((r) => r.id),
    [...LLM_RUNNER_IDS],
  );
  // A LABEL, not just an id: the browser cannot import a runner implementation to find one.
  for (const r of status.runners) assert.ok(r.label.trim().length > 0, `${r.id} has no label`);
  assert.equal(status.runner.id, DEFAULT_LLM_RUNNER_ID);
  assert.equal(status.claudeTransport, "print");

  setLlmConfig({ claudeTransport: "sdk" });
  assert.equal(llmStatus().claudeTransport, "sdk", "the resolved transport did not reach status");
});
