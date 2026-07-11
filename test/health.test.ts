import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { buildApp } from "../src/server/routes.ts";
import type { Registry } from "../src/server/registry.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { TaskManager } from "../src/server/tasks.ts";

// The /api/health handler reads none of the managers, so minimal stubs keep this
// test hermetic (no db, no discovery pollers).
const registry = {} as unknown as Registry;
const reviews = {} as unknown as ReviewManager;
const tasks = {} as unknown as TaskManager;
const app = buildApp(registry, reviews, tasks);

// The endpoint should surface exactly the version declared in package.json.
const pkgVersion = (
  JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
    version: string;
  }
).version;

test("/api/health reports ok, service, the package.json version, and pid", async () => {
  const res = await app.request("/api/health", { headers: { host: "127.0.0.1:7317" } });
  assert.equal(res.status, 200);

  const body = (await res.json()) as {
    ok: boolean;
    service: string;
    version: string;
    pid: number;
  };
  assert.equal(body.ok, true);
  assert.equal(body.service, "ai-harness");
  assert.equal(typeof body.version, "string");
  assert.equal(body.version, pkgVersion);
  assert.equal(body.pid, process.pid);
});

test("the loopback guard rejects a non-loopback Host (DNS-rebinding defense)", async () => {
  const res = await app.request("/api/health", { headers: { host: "evil.example.com" } });
  assert.equal(res.status, 403);
});
