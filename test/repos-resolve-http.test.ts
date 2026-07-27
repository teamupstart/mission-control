import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, URL } from "node:url";
import { buildApp } from "../src/server/routes.ts";
import type { Registry } from "../src/server/registry.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { TaskManager } from "../src/server/tasks.ts";
import type { QueueManager } from "../src/server/queue.ts";

// The /api/repos/resolve handler reads none of the managers (it just shells out to git),
// so minimal stubs keep this hermetic, like health.test.ts. It backs the Foreman allowlist
// picker: a typed path is canonicalized to a repo root or refused before it's trusted.
const registry = {} as unknown as Registry;
const reviews = {} as unknown as ReviewManager;
const tasks = {} as unknown as TaskManager;
const queues = {} as unknown as QueueManager;
const app = buildApp(registry, reviews, tasks, queues);

const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

async function resolve(path: unknown): Promise<Response> {
  return app.request("/api/repos/resolve", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ path }),
  });
}

test("resolves a real repo path to a canonical git root", async () => {
  // This test file lives inside the repo, so its parent tree is a git checkout.
  const repoDir = fileURLToPath(new URL("..", import.meta.url));
  const res = await resolve(repoDir);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { repoRoot: string };
  assert.equal(typeof body.repoRoot, "string");
  assert.ok(body.repoRoot.length > 0, "a resolved root should be a non-empty path");
});

test("rejects a path that isn't a git repository", async () => {
  const res = await resolve("/definitely/not/a/repo/xyzzy");
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /not a git repository/);
});

test("rejects a missing/blank path at the schema", async () => {
  assert.equal((await resolve(undefined)).status, 400);
  assert.equal((await resolve("")).status, 400);
});

test("the loopback guard applies here too", async () => {
  const res = await app.request("/api/repos/resolve", {
    method: "POST",
    headers: { host: "evil.example.com", "content-type": "application/json" },
    body: JSON.stringify({ path: "/tmp" }),
  });
  assert.equal(res.status, 403);
});

test("a subdirectory resolves to the repository AND back to itself", async () => {
  // The route answers two questions, because resolving to a repository throws away the
  // subdirectory - and a caller configuring a per-package check command needs it back.
  // Without `path`, `/repo/packages/web` typed into Settings is stored as `/repo` and the
  // documented subdirectory override is unreachable from the UI.
  const repoDir = fileURLToPath(new URL("..", import.meta.url));
  const subDir = fileURLToPath(new URL("../src/shared", import.meta.url)).replace(/\/$/, "");
  const res = await resolve(subDir);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { repoRoot: string; path: string };
  // The repository is the same one the root resolves to...
  const rootRes = await resolve(repoDir);
  const rootBody = (await rootRes.json()) as { repoRoot: string; path: string };
  assert.equal(body.repoRoot, rootBody.repoRoot);
  // ...and the path is the subdirectory, expressed AGAINST that repository rather than
  // against whichever tree the caller stood in. That distinction is what this assertion is
  // really for: this suite often runs from a linked worktree under `~/.treehouse/`, where a
  // bare realpath answers with a path that is not inside the resolved main root at all, and
  // a caller comparing the two by prefix would discard the subdirectory as "outside".
  assert.ok(body.path.endsWith("/src/shared"), `expected a src/shared path, got ${body.path}`);
  assert.ok(
    body.path.startsWith(`${body.repoRoot}/`),
    `${body.path} should sit inside ${body.repoRoot}`,
  );
  // The root's own canonical path is the root, so an entry typed there stays repo-wide.
  assert.equal(rootBody.path, rootBody.repoRoot);
});
