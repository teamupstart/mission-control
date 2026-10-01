import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The open document's re-check, over a real checkout.
//
// The Files tab re-reads the selected file on an interval so an agent's edit re-renders where
// the reader is looking. `known` is the revision the reader already holds: while the file is
// still that revision the answer carries no text, and the moment it moves the whole document
// comes back as an ordinary read.

const home = mkdtempSync(join(tmpdir(), "mission-file-recheck-"));
process.env.MISSION_HOME = home;

const checkout = join(home, "checkout");
mkdirSync(join(checkout, "docs"), { recursive: true });

const { buildApp } = await import("../src/server/routes.ts");
type Registry = import("../src/server/registry.ts").Registry;
type ReviewManager = import("../src/server/reviews.ts").ReviewManager;
type TaskManager = import("../src/server/tasks.ts").TaskManager;
type QueueManager = import("../src/server/queue.ts").QueueManager;

after(() => rmSync(home, { recursive: true, force: true }));

const registry = {
  getSession: (id: string) => (id === "live" ? { id, cwd: checkout } : undefined),
  subscribe: () => () => {},
  onSessionsObserved: () => () => {},
} as unknown as Registry;

const stub = <T,>() => ({}) as unknown as T;
const app = buildApp({
  registry,
  reviews: stub<ReviewManager>(),
  tasks: stub<TaskManager>(),
  queues: stub<QueueManager>(),
});
const HEADERS = { host: "127.0.0.1:7317" };

async function read(known?: string): Promise<{ status: number; data: Record<string, unknown> }> {
  const query = `path=${encodeURIComponent("docs/spec.md")}`
    + (known === undefined ? "" : `&known=${encodeURIComponent(known)}`);
  const res = await app.request(`/api/sessions/live/file?${query}`, { headers: HEADERS });
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

test("an unchanged file answers without its text, and a changed one answers in full", async () => {
  writeFileSync(join(checkout, "docs/spec.md"), "The retry budget is thirty seconds.\n");
  const first = await read();
  assert.equal(first.status, 200);
  assert.equal(first.data.text, "The retry budget is thirty seconds.\n");
  const revision = first.data.revision as string;
  assert.ok(revision.length > 0);

  const same = await read(revision);
  assert.equal(same.status, 200);
  assert.deepEqual(same.data, { unchanged: true, revision });

  // The agent rewrites the sentence the comment quotes.
  writeFileSync(join(checkout, "docs/spec.md"), "Retries stop at the deadline.\n");
  const moved = await read(revision);
  assert.equal(moved.status, 200);
  assert.equal(moved.data.unchanged, undefined);
  assert.equal(moved.data.text, "Retries stop at the deadline.\n");
  assert.notEqual(moved.data.revision, revision);
});

test("a stale `known` never turns a missing file into an unchanged one", async () => {
  const gone = await app.request(
    `/api/sessions/live/file?path=${encodeURIComponent("docs/gone.md")}&known=anything`,
    { headers: HEADERS },
  );
  assert.equal(gone.status, 404);
});
