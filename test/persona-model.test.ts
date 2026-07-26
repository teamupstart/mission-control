import { test } from "node:test";
import assert from "node:assert/strict";
import type { Persona } from "../src/shared/workflow.ts";
import {
  resolvePersonaDefaults,
  resolvePersonaExecution,
} from "../src/server/workflows/personas.ts";

// What is at stake: the editor promises to show the same provider and model a future Persona
// attempt will actually spawn. The app runner, Persona override, environment, and provider-
// compatible default are four independent layers, and silently dropping one spends the wrong model.

const BASE: Persona = {
  id: "p",
  name: "Quality",
  normalizedName: "quality",
  description: "",
  guidanceMarkdown: "# Review",
  runner: null,
  model: null,
  revision: 1,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  builtin: false,
};

const CLAUDE = { id: "claude", source: "default", unknown: null } as const;
const CODEX = { id: "codex", source: "config", unknown: null } as const;

test("a Persona runner override wins over the app runner", () => {
  const execution = resolvePersonaExecution({ ...BASE, runner: "codex" }, CLAUDE, undefined);
  assert.deepEqual(execution.runner, { id: "codex", source: "config", unknown: null });
  assert.deepEqual(execution.model, { id: "gpt-5.6-terra", source: "default" });
});

test("a blank Persona runner follows the resolved app runner", () => {
  const execution = resolvePersonaExecution(BASE, CODEX, undefined);
  assert.equal(execution.runner, CODEX);
  assert.deepEqual(execution.model, { id: "gpt-5.6-terra", source: "default" });
});

test("a stored Persona model wins over the environment and default", () => {
  const execution = resolvePersonaExecution(
    { ...BASE, runner: "codex", model: "gpt-5.6-sol" },
    CLAUDE,
    "gpt-5.6-luna",
  );
  assert.deepEqual(execution.model, { id: "gpt-5.6-sol", source: "config" });
});

test("the Persona environment model wins when there is no stored override", () => {
  assert.deepEqual(resolvePersonaExecution(BASE, CLAUDE, "claude-opus-4-8").model, {
    id: "claude-opus-4-8",
    source: "env",
  });
});

test("Persona defaults expose the complete server-side model ladder to new drafts", () => {
  const defaults = resolvePersonaDefaults(CODEX, "model-from-env");
  assert.equal(defaults.runner, CODEX);
  assert.deepEqual(defaults.models.claude, { id: "model-from-env", source: "env" });
  assert.deepEqual(defaults.models.codex, { id: "model-from-env", source: "env" });

  const fallbacks = resolvePersonaDefaults(CODEX, undefined);
  assert.deepEqual(fallbacks.models.claude, { id: "claude-sonnet-5", source: "default" });
  assert.deepEqual(fallbacks.models.codex, { id: "gpt-5.6-terra", source: "default" });
});

test("the fallback is compatible with the resolved provider", () => {
  assert.equal(resolvePersonaExecution(BASE, CLAUDE, undefined).model.id, "claude-sonnet-5");
  assert.equal(resolvePersonaExecution(BASE, CODEX, undefined).model.id, "gpt-5.6-terra");
});

test("an unknown stored runner falls back through the shared resolver and is reported", () => {
  const execution = resolvePersonaExecution({ ...BASE, runner: "ollama" as never }, CODEX, undefined);
  assert.deepEqual(execution.runner, { id: "claude", source: "default", unknown: "ollama" });
  assert.equal(execution.model.id, "claude-sonnet-5");
});
