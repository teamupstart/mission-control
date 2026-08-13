import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ServerEvent } from "../src/shared/types.ts";
import type { WorkflowCommandView } from "../src/shared/workflow.ts";
import { WORKFLOW_CHECK_SLOTS } from "../src/shared/workflow.ts";

// What is at stake: the Command catalog is SSE state, not a second polling subsystem. A
// reconnect snapshot and the incremental stream must converge on the same four slots, and
// every slot must be present in both whether or not anybody configured it - a collection that
// only carried the written slots would make "no command here" and "not loaded yet" the same
// observation for the surface that has to draw four cards.

const home = mkdtempSync(join(tmpdir(), "mission-workflow-commands-sse-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { WorkflowCommandManager } = await import("../src/server/workflows/commands.ts");
const { WorkflowStore, clearWorkflowTables } = await import("../src/server/workflows/store.ts");

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));

test("the opening snapshot carries every slot, configured or not", () => {
  clearWorkflowTables(db);
  const registry = new Registry();
  new WorkflowCommandManager(registry, new WorkflowStore(db));
  const opening = registry.snapshot().workflowCommands;
  assert.deepEqual(opening.map((view) => view.slot), [...WORKFLOW_CHECK_SLOTS]);
  assert.ok(opening.every((view) => view.defaultCommand === null && view.overrides.length === 0));
});

test("snapshot, upsert and reconnect produce one equivalent catalog", () => {
  clearWorkflowTables(db);
  const registry = new Registry();
  const manager = new WorkflowCommandManager(registry, new WorkflowStore(db));
  const opening = registry.snapshot().workflowCommands;

  const events: ServerEvent[] = [];
  const unsubscribe = registry.subscribe((event) => events.push(event));
  assert.equal(
    manager.replace("test", {
      expectedRevision: 1,
      defaultCommand: ["npm", "test"],
      overrides: [{ repoRoot: "/repo", command: ["npm", "run", "test:ci"] }],
    }, 100).ok,
    true,
  );
  // A refusal must publish nothing: every open window would otherwise redraw a slot that
  // never moved.
  assert.equal(
    manager.replace("test", { expectedRevision: 1, defaultCommand: null, overrides: [] }, 200).ok,
    false,
  );
  assert.equal(
    manager.replace("build", { expectedRevision: 1, defaultCommand: ["npm", "run", "build"], overrides: [] }, 300).ok,
    true,
  );
  unsubscribe();

  // There is no remove twin, and there must not be: a built-in slot is emptied, never
  // deleted, and an emptied slot is still a card that has to say it is unconfigured.
  assert.deepEqual(
    [...new Set(events.map((event) => event.type))],
    ["workflow_command_upsert"],
  );
  assert.equal(events.length, 2, "one committed mutation is one event, and a refusal is none");

  const reduced = new Map<string, WorkflowCommandView>(opening.map((view) => [view.slot, view]));
  for (const event of events) {
    if (event.type === "workflow_command_upsert") reduced.set(event.command.slot, event.command);
  }
  const bySlot = (views: readonly WorkflowCommandView[]) =>
    Object.fromEntries(views.map((view) => [view.slot, view]));
  assert.deepEqual(bySlot([...reduced.values()]), bySlot(registry.snapshot().workflowCommands));

  // And a browser that connects fresh sees the same catalog, keyed rather than sequenced: the
  // two paths are allowed to order the collection differently, not to disagree about it.
  const reconnect = new Registry();
  new WorkflowCommandManager(reconnect, new WorkflowStore(db));
  assert.deepEqual(
    bySlot(reconnect.snapshot().workflowCommands),
    bySlot(registry.snapshot().workflowCommands),
  );
});

test("the browser replaces the collection on snapshot and reduces the upsert exhaustively", () => {
  // A source-parity check for the same reason the Persona and SessionAction ones exist:
  // `ServerEvent` is a wire union, and a variant the daemon emits but `useEventStream` never
  // handles is dropped in total silence - nothing throws, no test fails, the UI just never
  // reflects it. The `never` assignment is what makes the omission a compile error instead.
  const source = readFileSync(
    resolve(import.meta.dirname, "..", "src", "web", "useEventStream.ts"),
    "utf8",
  );
  assert.match(source, /case "workflow_command_upsert":/);
  assert.match(source, /setWorkflowCommands\(new Map\(\(msg\.workflowCommands \?\? \[\]\)\.map\(/);
  assert.match(source, /const unhandled: never = msg;/);
  // No polling: the snapshot and that one event are the whole refresh mechanism.
  assert.equal(/setInterval[^\n]*workflow-commands/.test(source), false);
});

test("the collection is bounded by the slot list rather than by operator data", () => {
  clearWorkflowTables(db);
  const registry = new Registry();
  const manager = new WorkflowCommandManager(registry, new WorkflowStore(db));
  manager.replace("test", {
    expectedRevision: 1,
    defaultCommand: ["npm", "test"],
    overrides: Array.from({ length: 20 }, (_, index) => ({
      repoRoot: `/repos/project-${index}`,
      command: ["npm", "test"],
    })),
  });
  const views = registry.snapshot().workflowCommands;
  // Four entries however many exceptions an operator wrote: the key space IS the append-only
  // slot list. The bytes scale only with the overrides, each a path and a short argv.
  assert.equal(views.length, WORKFLOW_CHECK_SLOTS.length);
  const bytes = new TextEncoder().encode(JSON.stringify(views)).byteLength;
  assert.ok(
    bytes < 32_000,
    `the command catalog is ${bytes} bytes; decide detail-fetching rather than widening the snapshot`,
  );
});
