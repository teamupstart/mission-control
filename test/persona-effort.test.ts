import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PersonaSnapshot, WorkflowDraftGraph } from "../src/shared/workflow.ts";

// What is at stake: an operator picks how hard a workflow reviewer thinks, and that choice has
// to (1) reach the provider in the documented order - node override, then Persona, then the
// provider default - (2) be frozen into a published version exactly like the model is, and
// (3) never be silently dropped when the chosen provider and model cannot honour it. A Persona
// with no effort, and every version published before effort existed, must behave exactly as
// they did.

const home = mkdtempSync(join(tmpdir(), "mission-persona-effort-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { WorkflowStore, clearWorkflowTables } = await import("../src/server/workflows/store.ts");
const {
  PersonaManager,
  resolvePersonaExecution,
  resolveWorkflowNodeExecution,
} = await import("../src/server/workflows/personas.ts");
const {
  CreatePersonaSchema,
  PublishedWorkflowGraphSchema,
  WorkflowDraftGraphSchema,
} = await import("../src/shared/protocol.ts");
const { validateWorkflowGraph } = await import("../src/shared/workflow-graph.ts");
const {
  normalizePersonaName,
  personaEffortLabel,
  personaEffortLevels,
  personaSnapshotOf,
  routingLine,
} = await import("../src/shared/workflow.ts");
const { personaRoutingLabel } = await import("../src/web/library/library-model.ts");

const db = openDb();
const store = new WorkflowStore(db);
after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => clearWorkflowTables(db));

const CLAUDE = { id: "claude", source: "default", unknown: null } as const;

const snapshot = (patch: Partial<PersonaSnapshot> = {}): PersonaSnapshot => ({
  sourcePersonaId: "p",
  sourceRevision: 1,
  name: "Quality",
  description: "",
  guidanceMarkdown: "# Review",
  runner: "claude",
  model: "claude-opus-5-5",
  ...patch,
});

const resolve = (persona: PersonaSnapshot) => resolvePersonaExecution(persona, CLAUDE, undefined);

test("resolution order: node override effort, then the Persona's, then the provider default", () => {
  const persona = snapshot({ effort: "high" });
  // Persona effort beats the provider default.
  assert.deepEqual(resolveWorkflowNodeExecution({ persona }, resolve).effort, { level: "high", unsupported: null });
  // A node override's effort beats the Persona's.
  assert.deepEqual(
    resolveWorkflowNodeExecution(
      { persona, executionOverride: { runner: "claude", model: "claude-opus-5-5", effort: "max" } },
      resolve,
    ).effort,
    { level: "max", unsupported: null },
  );
  // Nothing set anywhere: no effort is passed, so the provider default applies.
  assert.deepEqual(resolveWorkflowNodeExecution({ persona: snapshot() }, resolve).effort, { level: null, unsupported: null });
});

test("an override without an effort runs at the provider default, not the Persona's level", () => {
  // The override replaces the Persona's whole execution choice: a level picked for the
  // Persona's own model is not carried onto a model the workflow chose.
  const execution = resolveWorkflowNodeExecution(
    { persona: snapshot({ effort: "max" }), executionOverride: { runner: "codex", model: "gpt-6-sol" } },
    resolve,
  );
  assert.deepEqual(execution.effort, { level: null, unsupported: null });
});

test("an effort the resolved model cannot run is flagged, never silently dropped or passed", () => {
  // Codex offers `max` only on its newest models; an older one cannot run it.
  const execution = resolvePersonaExecution(snapshot({ runner: "codex", model: "gpt-5.6-luna", effort: "max" }), CLAUDE, undefined);
  assert.deepEqual(execution.effort, { level: null, unsupported: "max" });
  assert.deepEqual(
    resolvePersonaExecution(snapshot({ runner: "codex", model: "gpt-6-sol", effort: "max" }), CLAUDE, undefined).effort,
    { level: "max", unsupported: null },
  );
});

test("an inherited provider is offered only the levels every provider supports", () => {
  assert.equal(personaEffortLevels("claude", null).includes("max"), true);
  assert.equal(personaEffortLevels(null, null).includes("max"), false);
  assert.deepEqual([...personaEffortLevels(null, null)], ["low", "medium", "high", "xhigh"]);
});

test("a Persona with no effort, and a pre-effort version, snapshot and parse exactly as before", () => {
  const legacy = snapshot();
  assert.equal("effort" in legacy, false);
  const graph = {
    nodes: [{ id: "judge", kind: "persona" as const, persona: legacy, position: { x: 0, y: 0 } }],
    edges: [],
  };
  // A stored version with no effort key still parses, and resolves with no effort at all.
  const parsed = PublishedWorkflowGraphSchema.parse(graph);
  assert.equal("effort" in (parsed.nodes[0] as { persona: object }).persona, false);
  assert.deepEqual(resolve(legacy).effort, { level: null, unsupported: null });
});

test("create refuses an effort the stored provider and model do not offer", () => {
  const base = { name: "R", guidanceMarkdown: "# R" };
  assert.equal(CreatePersonaSchema.safeParse({ ...base, runner: "claude", effort: "max" }).success, true);
  assert.equal(CreatePersonaSchema.safeParse({ ...base, runner: "codex", model: "gpt-5.6-luna", effort: "max" }).success, false);
  // Inheriting the provider: refused, because the app provider may be one that lacks `max`.
  assert.equal(CreatePersonaSchema.safeParse({ ...base, effort: "max" }).success, false);
  assert.equal(CreatePersonaSchema.safeParse({ ...base, effort: "ultra" }).success, false);
});

test("an update is checked against the MERGED provider and model, and stored when valid", () => {
  const manager = new PersonaManager(new Registry(), store);
  const created = manager.create({ name: "Effortful", description: "", guidanceMarkdown: "# E", runner: "claude", model: null, effort: "max" });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.persona.effort, "max");
  assert.deepEqual(created.persona.execution.effort, { level: "max", unsupported: null });
  // Moving to a provider that cannot run `max` without changing the effort is refused.
  const refused = manager.update(created.persona.id, { expectedRevision: 1, runner: "codex", model: "gpt-5.6-luna" });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.reason, "unsupported_effort");
  // Changing both together is fine, and the stored effort reads back.
  const changed = manager.update(created.persona.id, { expectedRevision: 1, runner: "codex", model: "gpt-5.6-luna", effort: "xhigh" });
  assert.equal(changed.ok, true);
  assert.equal(store.getPersona(created.persona.id)?.effort, "xhigh");
});

test("an override effort the override's model cannot run is a publish-blocking diagnostic", () => {
  const draft = (effort: "max" | "high"): WorkflowDraftGraph => ({
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      {
        id: "judge",
        kind: "persona",
        personaId: "p",
        position: { x: 220, y: 0 },
        executionOverride: { runner: "codex", model: "gpt-5.6-luna", effort },
      },
      { id: "end", kind: "end", outcome: "Approved", position: { x: 440, y: 0 } },
    ],
    edges: [],
  });
  // The schema accepts the vocabulary, so a stored draft stays readable...
  assert.equal(WorkflowDraftGraphSchema.safeParse(draft("max")).success, true);
  // ...and the graph validator is what flags it.
  const bad = validateWorkflowGraph({ graph: draft("max") }).diagnostics.find((item) => item.code === "unsupported_effort");
  assert.equal(bad?.severity, "error");
  assert.equal(bad?.nodeId, "judge");
  assert.equal(
    validateWorkflowGraph({ graph: draft("high") }).diagnostics.some((item) => item.code === "unsupported_effort"),
    false,
  );
});

test("publish freezes the Persona's effort; editing the Persona later leaves the version alone", () => {
  const manager = new PersonaManager(new Registry(), store);
  const created = manager.create({ name: "Frozen", description: "", guidanceMarkdown: "# F", runner: "claude", model: "claude-opus-5-5", effort: "high" });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const draft: WorkflowDraftGraph = {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      {
        id: "judge",
        kind: "persona",
        personaId: created.persona.id,
        position: { x: 220, y: 0 },
      },
      {
        id: "judge-2",
        kind: "persona",
        personaId: created.persona.id,
        position: { x: 220, y: 120 },
        executionOverride: { runner: "claude", model: "claude-opus-5-5", effort: "max" },
      },
      { id: "end", kind: "end", outcome: "Approved", position: { x: 440, y: 0 } },
    ],
    edges: [
      { id: "start", source: "session", sourcePort: "submitted", target: "judge", targetPort: "activate" },
      { id: "start-2", source: "session", sourcePort: "submitted", target: "judge-2", targetPort: "activate" },
      { id: "pass", source: "judge", sourcePort: "pass", target: "end", targetPort: "terminal" },
      { id: "fail", source: "judge", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
      { id: "pass-2", source: "judge-2", sourcePort: "pass", target: "end", targetPort: "terminal" },
      { id: "fail-2", source: "judge-2", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
    ],
  };
  const inserted = store.insertWorkflow({
    id: "w1",
    name: "Gate",
    normalizedName: normalizePersonaName("Gate"),
    description: "",
    draft,
    completionPolicy: { kind: "none" },
    resumptionPolicy: "manual",
    bindingDefaults: { triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 },
    createdAt: 1,
    updatedAt: 1,
  });
  assert.equal(inserted.ok, true);
  if (!inserted.ok) return;
  const published = store.publishWorkflow("w1", inserted.workflow.draftRevision, "v1", 3);
  assert.equal(published.ok, true, JSON.stringify(published));
  if (!published.ok) return;

  // Editing the Persona after publish must not reach the published version.
  const edited = manager.update(created.persona.id, { expectedRevision: 1, effort: "low" });
  assert.equal(edited.ok, true);

  const version = store.getWorkflowVersion("w1", published.version.version);
  const nodes = version?.graph.nodes ?? [];
  const inherit = nodes.find((node) => node.id === "judge");
  const overridden = nodes.find((node) => node.id === "judge-2");
  assert.equal(inherit?.kind, "persona");
  assert.equal(overridden?.kind, "persona");
  if (inherit?.kind !== "persona" || overridden?.kind !== "persona") return;
  assert.equal(inherit.persona.effort, "high");
  assert.deepEqual(overridden.executionOverride, { runner: "claude", model: "claude-opus-5-5", effort: "max" });
  assert.equal(resolveWorkflowNodeExecution(inherit, resolve).effort?.level, "high");
  assert.equal(resolveWorkflowNodeExecution(overridden, resolve).effort?.level, "max");
  // And a Persona with no effort freezes without the key, byte-identical to a pre-effort version.
  assert.equal("effort" in personaSnapshotOf({ ...created.persona, effort: null }), false);
});

test("a configured but unsupported effort is visible on every routing line, never silently dropped", () => {
  const unsupported = { level: null, unsupported: "max" } as const;
  assert.equal(personaEffortLabel(unsupported), "max effort unsupported, provider default");
  assert.equal(
    routingLine("codex", "gpt-5.6-luna", unsupported),
    "codex · gpt-5.6-luna · max effort unsupported, provider default",
  );
  // The library, palette and editors read the resolved execution through this one label.
  const execution = resolvePersonaExecution(snapshot({ runner: "codex", model: "gpt-5.6-luna", effort: "max" }), CLAUDE, undefined);
  assert.equal(
    personaRoutingLabel({ execution }),
    "codex · gpt-5.6-luna · max effort unsupported, provider default",
  );
  // A level that applies is named; no effort at all reads exactly as it did before effort existed.
  assert.equal(routingLine("claude", "claude-opus-5-5", { level: "high", unsupported: null }), "claude · claude-opus-5-5 · high effort");
  assert.equal(routingLine("claude", "claude-opus-5-5", { level: null, unsupported: null }), "claude · claude-opus-5-5");
  assert.equal(personaEffortLabel({ level: null, unsupported: null }), null);
});
