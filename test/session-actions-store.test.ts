import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SessionAction, WorkflowDraftGraph } from "../src/shared/workflow.ts";
import { sessionActionSnapshotIsOutdated } from "../src/shared/workflow.ts";

// What is at stake: this catalog is the source of the exact text a workflow types into an
// operator's session, and of the proof contract that decides when it is done. A prompt that
// changed by one byte on the way through, a completion kind read tolerantly, or a snapshot
// resolved outside the publish transaction each turn one edit into a run doing something
// nobody authored.

const home = mkdtempSync(join(tmpdir(), "mission-session-actions-store-"));
process.env.HARNESS_HOME = join(home, "state");

const { DB_PATH } = await import("../src/server/config.ts");
const { openDb } = await import("../src/server/db.ts");
const { WorkflowStore, WorkflowRowError, clearWorkflowTables, parseSessionActionRow } =
  await import("../src/server/workflows/store.ts");

const db = openDb();
/** No shipped catalog: the merge rules are provable on a fabricated one. */
const store = new WorkflowStore(db, [], [], []);
after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => clearWorkflowTables(db));

const create = (patch: Partial<Parameters<typeof store.insertSessionAction>[0]> = {}) =>
  store.insertSessionAction({
    id: "a1",
    name: "Pull Request",
    normalizedName: "pull request",
    description: "Prepare the work",
    promptMarkdown: "# Pull Request\r\n\r\nExact trailing space  \r\n",
    requiredSkillId: "pull-request",
    completion: { kind: "pull_request" },
    createdAt: 100,
    updatedAt: 100,
    ...patch,
  });

test("a stored prompt survives the round trip byte-for-byte, on a fresh handle", () => {
  const exact = "# Pull Request\r\n\r\nExact trailing space  \r\n\u{1F680}\n";
  const created = create({ promptMarkdown: exact });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.action.promptMarkdown, exact);
  assert.equal(created.action.revision, 1);
  assert.equal(created.action.builtin, false);
  assert.deepEqual(created.action.completion, { kind: "pull_request" });

  const reopened = new DatabaseSync(DB_PATH);
  try {
    assert.equal(
      new WorkflowStore(reopened, [], [], []).getSessionAction("a1")?.promptMarkdown,
      exact,
    );
  } finally {
    reopened.close();
  }
});

test("a stale expected revision preserves both tabs' text and reports the current row", () => {
  const created = create();
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const first = store.updateSessionActionCas("a1", 1, { description: "First tab" }, 200);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.action.revision, 2);

  const stale = store.updateSessionActionCas("a1", 1, { description: "Second tab" }, 300);
  assert.deepEqual(stale, { ok: false, reason: "revision_conflict", current: first.action });
  assert.equal(store.getSessionAction("a1")?.description, "First tab");
});

test("every editable field is a revision, including the two that decide behaviour", () => {
  assert.equal(create().ok, true);
  const skill = store.updateSessionActionCas("a1", 1, { requiredSkillId: null }, 200);
  assert.equal(skill.ok, true);
  if (!skill.ok) return;
  assert.equal(skill.action.requiredSkillId, null);

  const completion = store.updateSessionActionCas(
    "a1",
    2,
    { completion: { kind: "session_turn" } },
    300,
  );
  assert.equal(completion.ok, true);
  if (!completion.ok) return;
  assert.deepEqual(completion.action.completion, { kind: "session_turn" });
  assert.equal(completion.action.revision, 3);
});

test("archive is a soft, revisioned write that keeps the row readable and its name reserved", () => {
  assert.equal(create().ok, true);
  const archived = store.archiveSessionActionCas("a1", 1, 500);
  assert.equal(archived.ok, true);
  if (!archived.ok) return;
  assert.equal(archived.action.archivedAt, 500);
  assert.deepEqual(store.listSessionActions(), []);
  assert.equal(store.listSessionActions(true)[0]?.id, "a1");
  // Still addressable by id, because a draft or a published version may already name it.
  assert.equal(store.getSessionAction("a1")?.id, "a1");
  // The name is NOT released: a second action claiming it would make an existing version's
  // reported source ambiguous.
  const second = create({ id: "a2" });
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.reason, "name_conflict");
  // And an archived row refuses further edits rather than silently reviving.
  assert.equal(store.updateSessionActionCas("a1", 2, { description: "x" }).ok, false);
  assert.equal(store.archiveSessionActionCas("a1", 2).ok, false);
});

test("names collide by their normalized spelling, not their bytes", () => {
  assert.equal(create().ok, true);
  const collision = create({ id: "a2", name: "  PULL   request ", normalizedName: "pull request" });
  assert.equal(collision.ok, false);
  if (collision.ok) return;
  assert.equal(collision.reason, "name_conflict");
  assert.equal(collision.current?.id, "a1");
});

test("a built-in is app data: never a row, never writable, and always addressable", () => {
  const shipped: SessionAction = {
    id: "builtin:fixture",
    name: "Fixture Action",
    normalizedName: "fixture action",
    description: "",
    promptMarkdown: "# Fixture Action\n",
    requiredSkillId: null,
    completion: { kind: "session_turn" },
    revision: 1,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
    builtin: true,
  };
  const withBuiltin = new WorkflowStore(db, [], [], [shipped]);

  assert.deepEqual(withBuiltin.listSessionActions().map((a) => a.id), ["builtin:fixture"]);
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM session_actions`).get() as { n: number }).n,
    0,
    "a built-in must not become a row",
  );

  for (const write of [
    () => withBuiltin.insertSessionAction({
      id: shipped.id, name: "Mine", normalizedName: "mine", description: "",
      promptMarkdown: "# Mine\n", requiredSkillId: null, completion: { kind: "session_turn" },
      createdAt: 1, updatedAt: 1,
    }),
    () => withBuiltin.updateSessionActionCas(shipped.id, 1, { description: "no" }),
    () => withBuiltin.archiveSessionActionCas(shipped.id, 1),
  ]) {
    assert.deepEqual(write(), { ok: false, reason: "builtin", current: shipped });
  }

  // Its name is reserved, so no NEW shadow can appear.
  const named = withBuiltin.insertSessionAction({
    id: "mine", name: "Fixture Action", normalizedName: "fixture action", description: "",
    promptMarkdown: "# Mine\n", requiredSkillId: null, completion: { kind: "session_turn" },
    createdAt: 1, updatedAt: 1,
  });
  assert.equal(named.ok, false);
  if (named.ok) return;
  assert.equal(named.reason, "name_conflict");
});

test("a pre-feature row under a shipped name shadows the display listing, not the catalog", () => {
  const shipped: SessionAction = {
    id: "builtin:fixture", name: "Fixture Action", normalizedName: "fixture action",
    description: "", promptMarkdown: "# Fixture Action\n", requiredSkillId: null,
    completion: { kind: "session_turn" }, revision: 1, archivedAt: null,
    createdAt: 0, updatedAt: 0, builtin: true,
  };
  const withBuiltin = new WorkflowStore(db, [], [], [shipped]);
  // The row an operator could only have authored before this action shipped, written by raw
  // SQL because the store now refuses the name.
  db.prepare(
    `INSERT INTO session_actions (id, name, normalized_name, description, prompt_md,
       required_skill_id, completion_kind, revision, archived_at, created_at, updated_at)
     VALUES ('legacy', ?, ?, '', '# Mine', NULL, 'session_turn', 3, NULL, 1, 1)`,
  ).run(shipped.name, shipped.normalizedName);

  assert.deepEqual(withBuiltin.listSessionActions().map((a) => a.id), ["legacy"]);
  // The CATALOG never shadows: a draft or a version may already point at the built-in's id,
  // and validation and Publish have to keep resolving it.
  assert.deepEqual(
    withBuiltin.sessionActionCatalog().map((a) => a.id).sort(),
    ["builtin:fixture", "legacy"],
  );
  assert.equal(withBuiltin.getSessionAction("builtin:fixture")?.builtin, true);
});

test("a row whose completion kind this build cannot read fails, and never degrades", () => {
  // The asymmetry with `personas.runner_id` is deliberate. An unreadable runner degrades to
  // the app default and the review still happens; reading a newer build's stricter adapter as
  // `session_turn` would complete an action on a settled idle turn when the version it belongs
  // to demanded durable proof.
  assert.throws(
    () => parseSessionActionRow({
      id: "x", name: "n", normalized_name: "n", description: "", prompt_md: "# p",
      required_skill_id: null, completion_kind: "shell", revision: 1,
      archived_at: null, created_at: 1, updated_at: 1,
    }),
    WorkflowRowError,
  );
  // A skill id that could carry a command fails the row for the same reason it fails the
  // HTTP boundary: it reaches the code that resolves a harness-native invocation.
  assert.throws(
    () => parseSessionActionRow({
      id: "x", name: "n", normalized_name: "n", description: "", prompt_md: "# p",
      required_skill_id: "npm test", completion_kind: "session_turn", revision: 1,
      archived_at: null, created_at: 1, updated_at: 1,
    }),
    WorkflowRowError,
  );
  assert.throws(
    () => parseSessionActionRow({
      id: "x", name: "n", normalized_name: "n", description: "", prompt_md: "   ",
      required_skill_id: null, completion_kind: "session_turn", revision: 1,
      archived_at: null, created_at: 1, updated_at: 1,
    }),
    WorkflowRowError,
  );
});

// ---- Publish ----

const actionGraph = (sessionActionId: string): WorkflowDraftGraph => ({
  nodes: [
    { id: "s", kind: "session", position: { x: 0, y: 0 } },
    { id: "act", kind: "session_action", sessionActionId, position: { x: 200, y: 0 } },
    { id: "end", kind: "end", outcome: "Complete", position: { x: 400, y: 0 } },
  ],
  edges: [
    { id: "e1", source: "s", sourcePort: "submitted", target: "act", targetPort: "activate" },
    { id: "e2", source: "act", sourcePort: "complete", target: "end", targetPort: "terminal" },
  ],
});

function draftWithAction(sessionActionId: string): string {
  const inserted = store.insertWorkflow({
    id: "w1",
    name: "Action workflow",
    normalizedName: "action workflow",
    description: "",
    draft: actionGraph(sessionActionId),
    completionPolicy: { kind: "none" },
    resumptionPolicy: "auto",
    bindingDefaults: { triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 },
    createdAt: 1,
    updatedAt: 1,
  });
  assert.equal(inserted.ok, true);
  return "w1";
}

test("publishing an action graph is refused while its ADAPTER has no runtime here", () => {
  // The default fixture selects `pull_request`, whose durable proof this build does not
  // have. The refusal is about that adapter and not about action nodes in general - see the
  // `session_turn` case below, which publishes.
  assert.equal(create().ok, true);
  const id = draftWithAction("a1");
  const published = store.publishWorkflow(id, 1, "v1", 900);
  assert.equal(published.ok, false);
  if (published.ok) return;
  assert.equal(published.reason, "validation");
  assert.ok(published.diagnostics?.some((item) =>
    item.code === "session_action_runtime_unavailable"));
  // The DRAFT is untouched and still saved, so the API and fixtures round-trip.
  assert.deepEqual(store.getWorkflow(id)?.draft, actionGraph("a1"));
  assert.equal(store.listWorkflowVersions(id).length, 0);
});

test("a missing or archived action is a publish refusal, not a snapshot of nothing", () => {
  const id = draftWithAction("gone");
  const missing = store.publishWorkflow(id, 1, "v1", 900);
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.ok(missing.diagnostics?.some((item) => item.code === "missing_session_action"));

  clearWorkflowTables(db);
  assert.equal(create().ok, true);
  assert.equal(store.archiveSessionActionCas("a1", 1, 500).ok, true);
  const archivedId = draftWithAction("a1");
  const archived = store.publishWorkflow(archivedId, 1, "v2", 900);
  assert.equal(archived.ok, false);
  if (archived.ok) return;
  assert.ok(archived.diagnostics?.some((item) => item.code === "archived_session_action"));
});

test("a draft summary counts the action's refusal as an error the library can see", () => {
  assert.equal(create().ok, true);
  const id = draftWithAction("a1");
  const summary = store.summary(store.getWorkflow(id)!);
  assert.ok(summary.errorCount > 0, "the Publish control must be refused where it is offered");
});

test("an action whose adapter IS available publishes, and freezes its snapshot", () => {
  assert.equal(create({ completion: { kind: "session_turn" }, requiredSkillId: null }).ok, true);
  const id = draftWithAction("a1");
  const published = store.publishWorkflow(id, 1, "v1", 900);
  assert.equal(published.ok, true);
  if (!published.ok) return;
  const node = published.version.graph.nodes.find((item) => item.id === "act");
  assert.equal(node?.kind, "session_action");
  if (node?.kind !== "session_action") return;
  assert.equal(node.action.completion.kind, "session_turn");
  assert.equal(node.action.sourceSessionActionId, "a1");
});

/**
 * A store told that EVERY adapter is available, so the SNAPSHOT contract is provable for the
 * `pull_request` arm too rather than only for whichever adapters happen to have shipped.
 * `builtins` is injected for exactly this reason.
 */
const runnable = new WorkflowStore(db, [], [], [], {
  session_turn: { available: true, unavailableReason: null },
  pull_request: { available: true, unavailableReason: null },
});

test("Publish replaces the live reference with a complete, exact snapshot", () => {
  const exact = "# Pull Request\r\n\r\nExact  \r\n";
  assert.equal(create({ promptMarkdown: exact }).ok, true);
  // A second revision, so the snapshot has a specific number to have captured rather than
  // the 1 every fresh row happens to carry.
  assert.equal(runnable.updateSessionActionCas("a1", 1, { description: "Prepare it" }, 200).ok, true);
  const id = draftWithAction("a1");

  const published = runnable.publishWorkflow(id, 1, "v1", 900);
  assert.equal(published.ok, true);
  if (!published.ok) return;
  const node = published.version.graph.nodes.find((candidate) => candidate.kind === "session_action");
  assert.ok(node && node.kind === "session_action");
  assert.deepEqual(node.action, {
    sourceSessionActionId: "a1",
    sourceRevision: 2,
    name: "Pull Request",
    description: "Prepare it",
    promptMarkdown: exact,
    requiredSkillId: "pull-request",
    completion: { kind: "pull_request" },
  });
  // The node's identity and position survive, because a published graph is the draft with
  // its references resolved - not a recompiled one.
  assert.equal(node.id, "act");
  assert.deepEqual(node.position, { x: 200, y: 0 });
  assert.deepEqual(published.version.graph.edges, actionGraph("a1").edges);
});

test("editing or archiving the source cannot reach a version already published", () => {
  const original = "# Pull Request\n";
  assert.equal(create({ promptMarkdown: original }).ok, true);
  const id = draftWithAction("a1");
  const published = runnable.publishWorkflow(id, 1, "v1", 900);
  assert.equal(published.ok, true);
  if (!published.ok) return;

  assert.equal(
    runnable.updateSessionActionCas("a1", 1, { promptMarkdown: "# Rewritten\n" }, 200).ok,
    true,
  );
  assert.equal(runnable.archiveSessionActionCas("a1", 2, 300).ok, true);

  const reread = runnable.getWorkflowVersion(id, published.version.version);
  const node = reread?.graph.nodes.find((candidate) => candidate.kind === "session_action");
  assert.ok(node && node.kind === "session_action");
  assert.equal(node.action.promptMarkdown, original, "a run pinned here still types what it froze");
  // History reports the drift rather than hiding it, exactly as it does for a Persona.
  assert.equal(
    sessionActionSnapshotIsOutdated(node.action, runnable.getSessionAction("a1")),
    true,
  );
});
