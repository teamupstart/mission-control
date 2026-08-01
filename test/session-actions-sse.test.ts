import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ServerEvent } from "../src/shared/types.ts";
import type { SessionAction } from "../src/shared/workflow.ts";

// What is at stake: the SessionAction catalog is SSE state, not a second polling subsystem. A
// reconnect snapshot and the incremental stream must converge on the same catalog, including
// after an archive - which is an UPSERT, because the row stays addressable by every draft and
// published version that names it.

const home = mkdtempSync(join(tmpdir(), "mission-session-actions-sse-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { SessionActionManager } = await import("../src/server/workflows/session-actions.ts");
const { WorkflowStore, clearWorkflowTables } = await import("../src/server/workflows/store.ts");

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));

test("snapshot, upsert, archive and reconnect produce one equivalent catalog", () => {
  clearWorkflowTables(db);
  const registry = new Registry();
  const manager = new SessionActionManager(registry, new WorkflowStore(db));
  // A client that never authored an action still opens on the catalog this build ships, and
  // it arrives in the SNAPSHOT rather than as events - so the reduction starts there.
  const opening = registry.snapshot().sessionActions;
  assert.ok(opening.length > 0, "the shipped catalog seeds the reconnect snapshot");

  const events: ServerEvent[] = [];
  const unsubscribe = registry.subscribe((event) => events.push(event));
  const created = manager.create({
    name: "Ship it",
    description: "",
    promptMarkdown: "# Ship it\n",
    requiredSkillId: null,
    completion: { kind: "session_turn" },
  }, 100);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(manager.update(created.action.id, { expectedRevision: 1, description: "d" }, 200).ok, true);
  assert.equal(manager.archive(created.action.id, 2, 300).ok, true);
  unsubscribe();

  // Archive is an UPSERT. A remove would drop the row from the browser's map and leave a
  // draft node pointing at an id it could no longer name.
  assert.equal(
    events.every((event) => event.type === "session_action_upsert"),
    true,
    "no write in this catalog removes a row",
  );
  const archived = events.flatMap((event) =>
    event.type === "session_action_upsert" && event.action.id === created.action.id
      ? [event.action]
      : []).at(-1);
  assert.equal(archived?.archivedAt, 300, "the archive arrives as the row's own upsert");

  const reduced = new Map<string, SessionAction>(opening.map((action) => [action.id, action]));
  for (const event of events) {
    if (event.type === "session_action_upsert") reduced.set(event.action.id, event.action);
    if (event.type === "session_action_remove") reduced.delete(event.id);
  }
  assert.deepEqual([...reduced.values()], registry.snapshot().sessionActions);

  // And a browser that connects fresh sees the same catalog, keyed rather than sequenced:
  // the two paths are allowed to order the collection differently, not to disagree about it.
  const reconnect = new Registry();
  new SessionActionManager(reconnect, new WorkflowStore(db));
  const byId = (actions: readonly SessionAction[]) =>
    Object.fromEntries(actions.map((action) => [action.id, action]));
  assert.deepEqual(byId(reconnect.snapshot().sessionActions), byId(registry.snapshot().sessionActions));
});

test("archiving a shadowing row re-publishes the built-in it was hiding", () => {
  clearWorkflowTables(db);
  const registry = new Registry();
  const store = new WorkflowStore(db);
  const manager = new SessionActionManager(registry, store);
  const shipped = store.sessionActionCatalog().find((action) => action.builtin);
  assert.ok(shipped);

  // A row can only take a shipped name if it predates the built-in, so it is written
  // directly - `create` refuses the name, which is what stops a NEW shadow appearing.
  db.prepare(
    `INSERT INTO session_actions (id, name, normalized_name, description, prompt_md,
       required_skill_id, completion_kind, revision, archived_at, created_at, updated_at)
     VALUES ('legacy', ?, ?, '', '# Mine', NULL, 'session_turn', 1, NULL, 1, 1)`,
  ).run(shipped.name, shipped.normalizedName);

  const events: ServerEvent[] = [];
  const unsubscribe = registry.subscribe((event) => events.push(event));
  assert.equal(manager.archive("legacy", 1, 400).ok, true);
  unsubscribe();

  // Two upserts: the archived row, and the built-in whose visibility it just changed. A
  // manager that published only the written row would leave the browser showing a library
  // with a hole in it until the next reconnect.
  const ids = events.flatMap((event) =>
    event.type === "session_action_upsert" ? [event.action.id] : []);
  assert.ok(ids.includes("legacy"));
  assert.ok(ids.includes(shipped.id));
});

test("the browser reduces both events, and the reducer stays exhaustive", () => {
  // A source-parity check for the same reason the Persona one exists: `ServerEvent` is a
  // wire union, and a variant the daemon emits but `useEventStream` never handles is dropped
  // in total silence - nothing throws, no test fails, the UI just never reflects it.
  const source = readFileSync(
    resolve(import.meta.dirname, "..", "src", "web", "useEventStream.ts"),
    "utf8",
  );
  assert.match(source, /case "session_action_upsert":/);
  assert.match(source, /case "session_action_remove":/);
  assert.match(source, /setSessionActions\(new Map\(msg\.sessionActions\.map\(/);
  assert.match(source, /const unhandled: never = msg;/);
});

test("the catalog stays a bounded snapshot payload, and switching to detail fetches is a decision", () => {
  clearWorkflowTables(db);
  const registry = new Registry();
  new SessionActionManager(registry, new WorkflowStore(db));
  const actions = registry.snapshot().sessionActions;
  const bytes = new TextEncoder().encode(JSON.stringify(actions)).byteLength;

  // The full record rides the snapshot, prompt Markdown included, exactly as a Persona's
  // guidance does. This bound is the RECORD of that decision: the shipped catalog is small
  // against the ~60 KB of Persona guidance already in every snapshot, so a detail-only fetch
  // would be complexity with nothing to buy. If this fails because the shipped catalog grew,
  // move the prompt to an HTTP detail route on purpose rather than raising the number.
  assert.ok(
    bytes < 32_000,
    `the shipped action catalog is ${bytes} bytes; decide detail-fetching rather than widening the snapshot`,
  );
  assert.ok(actions.every((action) => typeof action.promptMarkdown === "string"));
});
