import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../src/server/routes.ts";
import type { Registry } from "../src/server/registry.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { TaskManager } from "../src/server/tasks.ts";
import type { QueueManager } from "../src/server/queue.ts";

// What is at stake: this route is the one place a request causes the daemon to hand a
// PATH to an application launcher. Everything that stops that path being an arbitrary one
// is here - the same containment `readSessionFile` gets, because both go through
// `rootAndTarget` - plus the closed set of targets, which is what keeps any part of a
// request out of an argv.
//
// The success path is deliberately NOT driven through HTTP: it would launch a real
// browser on whoever's machine is running the tests. `open-target-contract.test.ts` drives
// the same call with injected deps and asserts the exact argv instead.

const checkout = await mkdtemp(path.join(os.tmpdir(), "mission-open-"));
execFileSync("git", ["-C", checkout, "init", "-q"]);
await writeFile(path.join(checkout, "page.html"), "<h1>hi</h1>");
await mkdir(path.join(checkout, "docs"));
await symlink(path.join(os.tmpdir()), path.join(checkout, "escape"));
test.after(() => rm(checkout, { recursive: true, force: true }));

const registry = {
  getSession: (id: string) => (id === "live" ? { id, cwd: checkout } : id === "homeless" ? { id, cwd: "" } : undefined),
} as unknown as Registry;
const app = buildApp({
  registry,
  reviews: {} as unknown as ReviewManager,
  tasks: {} as unknown as TaskManager,
  queues: {} as unknown as QueueManager,
});

const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

async function open(id: string, body: unknown): Promise<Response> {
  return app.request(`/api/sessions/${id}/file/open`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
}

test("the target is a registered id, never a command", async () => {
  for (const target of ["", "editor", "/usr/bin/open", null, undefined]) {
    const res = await open("live", { path: "page.html", target });
    assert.equal(res.status, 400, `${JSON.stringify(target)} must not be accepted`);
  }
});

test("a path leaving the checkout is refused before anything is launched", async () => {
  assert.equal((await open("live", { path: "../../etc/passwd", target: "browser" })).status, 403);
  assert.equal((await open("live", { path: "/etc/passwd", target: "browser" })).status, 400);
  // Through a symlink that points out of the tree: the lstat guard refuses the link
  // itself, which is what stops a checkout from choosing what gets opened.
  assert.equal((await open("live", { path: "escape", target: "browser" })).status, 403);
});

test("a file that is not there, or is not a file, is refused", async () => {
  assert.equal((await open("live", { path: "nope.html", target: "browser" })).status, 404);
  assert.equal((await open("live", { path: "docs", target: "browser" })).status, 400);
});

test("a session with no checkout, and one that does not exist", async () => {
  assert.equal((await open("homeless", { path: "page.html", target: "browser" })).status, 400);
  assert.equal((await open("ghost", { path: "page.html", target: "browser" })).status, 404);
});

test("the loopback guard applies here too", async () => {
  const res = await app.request("/api/sessions/live/file/open", {
    method: "POST",
    headers: { host: "evil.example.com", "content-type": "application/json" },
    body: JSON.stringify({ path: "page.html", target: "browser" }),
  });
  assert.equal(res.status, 403);
});

test("the menu's target list is served, one row per registered target", async () => {
  const res = await app.request("/api/open-targets", { headers: HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { targets: { id: string; label: string; blurb: string }[] };
  assert.ok(body.targets.length > 0, "a build with no targets would draw an empty menu");
  for (const target of body.targets) {
    assert.ok(target.label.trim().length > 0);
    assert.ok(target.blurb.trim().length > 0);
  }
});
