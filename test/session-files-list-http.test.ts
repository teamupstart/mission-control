import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureNativeStateLockAddon } from "./helpers/native-state-lock.ts";

ensureNativeStateLockAddon();
const home = realpathSync(mkdtempSync(join(tmpdir(), "mission-files-list-http-")));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { buildApp } = await import("../src/server/routes.ts");
type Registry = import("../src/server/registry.ts").Registry;
type ReviewManager = import("../src/server/reviews.ts").ReviewManager;
type TaskManager = import("../src/server/tasks.ts").TaskManager;
type QueueManager = import("../src/server/queue.ts").QueueManager;

function appFor(cwd: string, failResolution = false) {
  const registry = {
    getSession: (id: string) => ({
      id, cwd, task: { kind: "resident", workspaceKind: "resident-workspace" },
      ...(failResolution ? { workspace: { authority: "provider" } } : {}),
    }),
    subscribe: () => () => {},
    onSessionsObserved: () => () => {},
    ...(failResolution ? { resolveSessionWorkspace: () => { throw new Error("internal detail"); } } : {}),
  } as unknown as Registry;
  return buildApp({ registry, reviews: {} as ReviewManager, tasks: {} as TaskManager, queues: {} as QueueManager });
}

const headers = { host: "127.0.0.1:7317" };

test("Files preserves the depth-limit response from an actual resident directory scan", async () => {
  const root = join(home, "deep");
  mkdirSync(join(root, ...Array<string>(65).fill("d")), { recursive: true });
  const response = await appFor(root).request("/api/sessions/live/files", { headers });
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /depth limit/);
});

test("Files preserves an exhausted directory scan's time-budget response", async (t) => {
  const root = join(home, "slow");
  mkdirSync(root);
  let reads = 0;
  t.mock.method(performance, "now", () => reads++ === 0 ? 0 : 15_001);
  const response = await appFor(root).request("/api/sessions/live/files", { headers });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /time budget/);
});

test("Files preserves refused-boundary and missing-directory statuses", async () => {
  const root = join(home, "linked");
  symlinkSync(home, root);
  const refused = await appFor(root).request("/api/sessions/live/files", { headers });
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error, /symbolic link/);
  const missing = await appFor(join(home, "missing")).request("/api/sessions/live/files", { headers });
  assert.equal(missing.status, 404);
});

test("Files still hides unexpected failures behind a generic server-error response", async () => {
  const response = await appFor(home, true).request("/api/sessions/live/files", { headers });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "could not list session files" });
});
