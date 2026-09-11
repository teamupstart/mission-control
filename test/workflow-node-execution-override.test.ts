import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WorkflowDraftGraphSchema,
  PublishedWorkflowGraphSchema,
} from "../src/shared/protocol.ts";
import { nodeExecutionOverride, withExecutionOverride } from "../src/shared/workflow.ts";
import type { PersonaSnapshot } from "../src/shared/workflow.ts";
import {
  resolvePersonaExecution,
  resolveWorkflowNodeExecution,
} from "../src/server/workflows/personas.ts";

// What is at stake: a workflow author chooses a provider and model for ONE reviewer in ONE
// workflow, and that choice has to beat everything else - the Persona's own recommendation,
// the app's configured provider, and a model id in the daemon's environment - without
// changing what any other node, workflow or non-workflow caller resolves. Every layer below
// used to have exactly one owner, so the risk this file pins is a second ladder quietly
// disagreeing with the first, and an omitted field being read as a choice.

const CLAUDE = { id: "claude", source: "default", unknown: null } as const;
const CODEX = { id: "codex", source: "config", unknown: null } as const;

const snapshot = (
  patch: Partial<PersonaSnapshot> = {},
): PersonaSnapshot => ({
  sourcePersonaId: "p",
  sourceRevision: 1,
  name: "Quality",
  description: "",
  guidanceMarkdown: "# Review",
  runner: null,
  model: null,
  ...patch,
});

const point = { x: 0, y: 0 };

test("a node with no override resolves exactly as the Persona alone does", () => {
  const persona = snapshot({ runner: "codex", model: "gpt-5.6-sol" });
  assert.deepEqual(
    resolveWorkflowNodeExecution(
      { persona },
      (input) => resolvePersonaExecution(input, CLAUDE, "claude-opus-4-8"),
    ),
    resolvePersonaExecution(persona, CLAUDE, "claude-opus-4-8"),
  );
});

test("an explicit pair wins over the Persona, the app provider and the environment", () => {
  const execution = resolveWorkflowNodeExecution(
    {
      persona: snapshot({ runner: "codex", model: "gpt-5.6-sol" }),
      executionOverride: { runner: "claude", model: "claude-opus-4-8" },
    },
    (input) => resolvePersonaExecution(input, CODEX, "gpt-5.6-luna"),
  );
  assert.deepEqual(execution.runner, { id: "claude", source: "config", unknown: null });
  assert.deepEqual(execution.model, { id: "claude-opus-4-8", source: "config" });
});

test("an override does not have to name a model the shipped catalog knows", () => {
  // Model ids are free text under the persisted vocabulary everywhere else in this app, and
  // a workflow node is not the place to start refusing ids the CLI accepts.
  const execution = resolveWorkflowNodeExecution({
    persona: snapshot(),
    executionOverride: { runner: "codex", model: "gpt-5.7-unreleased" },
  }, () => resolvePersonaExecution(snapshot(), CLAUDE, undefined));
  assert.deepEqual(execution.model, { id: "gpt-5.7-unreleased", source: "config" });
});

test("clearing an override restores inheritance, live app defaults included", () => {
  const persona = snapshot();
  const inherited = resolveWorkflowNodeExecution(
    { ...withExecutionOverride(null), persona },
    (input) => resolvePersonaExecution(input, CODEX, undefined),
  );
  assert.equal(inherited.runner.id, "codex");
  assert.deepEqual(inherited.model, { id: "gpt-5.6-terra", source: "default" });
});

test("two nodes sharing one Persona resolve independently", () => {
  const persona = snapshot({ runner: "codex" });
  const resolvePersona = (input: PersonaSnapshot) =>
    resolvePersonaExecution(input, CLAUDE, undefined);
  const overridden = resolveWorkflowNodeExecution(
    { persona, executionOverride: { runner: "claude", model: "claude-opus-4-8" } },
    resolvePersona,
  );
  const inherited = resolveWorkflowNodeExecution({ persona }, resolvePersona);
  assert.equal(overridden.model.id, "claude-opus-4-8");
  assert.equal(inherited.model.id, "gpt-5.6-terra");
});

test("omission survives a graph round trip rather than becoming a stored choice", () => {
  const legacy = {
    nodes: [
      { id: "session", kind: "session", position: point },
      { id: "p1", kind: "persona", personaId: "quality", position: point },
      { id: "end", kind: "end", outcome: "Complete", position: point },
    ],
    edges: [],
  };
  const parsed = WorkflowDraftGraphSchema.parse(legacy);
  const node = parsed.nodes[1]!;
  assert.equal(node.kind, "persona");
  // Not merely undefined: the key must not EXIST, or the draft fingerprint autosave diffs
  // against would report a change nobody made the first time an old workflow was opened.
  assert.equal(Object.hasOwn(node, "executionOverride"), false);
  assert.equal(nodeExecutionOverride(node as { executionOverride?: never }), null);
  assert.deepEqual(parsed.nodes[1], legacy.nodes[1]);
});

test("a complete pair survives both graph schemas", () => {
  const draft = WorkflowDraftGraphSchema.parse({
    nodes: [{
      id: "p1",
      kind: "persona",
      personaId: "quality",
      position: point,
      executionOverride: { runner: "codex", model: "gpt-5.6-sol" },
    }],
    edges: [],
  });
  assert.deepEqual(nodeExecutionOverride(draft.nodes[0] as never), {
    runner: "codex",
    model: "gpt-5.6-sol",
  });

  const published = PublishedWorkflowGraphSchema.parse({
    nodes: [{
      id: "p1",
      kind: "persona",
      persona: snapshot(),
      position: point,
      executionOverride: { runner: "claude", model: "claude-opus-4-8" },
    }],
    edges: [],
  });
  assert.deepEqual(nodeExecutionOverride(published.nodes[0] as never), {
    runner: "claude",
    model: "claude-opus-4-8",
  });
});

test("an incomplete or unsupported pair is refused at the schema boundary", () => {
  const graph = (executionOverride: unknown) => ({
    nodes: [{ id: "p1", kind: "persona", personaId: "quality", position: point, executionOverride }],
    edges: [],
  });
  for (const [reason, value] of [
    ["a model with no provider", { model: "claude-opus-4-8" }],
    ["a provider with no model", { runner: "claude" }],
    ["an empty model", { runner: "claude", model: "" }],
    ["a whitespace-only model", { runner: "claude", model: "   " }],
    ["a provider this build cannot spawn", { runner: "ollama", model: "llama-3" }],
    ["an interactive harness rather than a runner", { runner: "pi", model: "gpt-5.6-sol" }],
    ["a flag-shaped model id", { runner: "claude", model: "--dangerously" }],
    ["a null pair", null],
    ["a bare string", "claude"],
  ] as const) {
    assert.equal(
      WorkflowDraftGraphSchema.safeParse(graph(value)).success,
      false,
      `${reason} should be refused`,
    );
  }
});

test("withExecutionOverride plants no key for an absent choice", () => {
  assert.deepEqual(withExecutionOverride(null), {});
  assert.deepEqual(withExecutionOverride(undefined), {});
  assert.equal(Object.hasOwn(withExecutionOverride(null), "executionOverride"), false);
  assert.deepEqual(withExecutionOverride({ runner: "claude", model: "m" }), {
    executionOverride: { runner: "claude", model: "m" },
  });
});
