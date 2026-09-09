import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the daemon's state dir (db, token, uploads) before config is read.
process.env.MISSION_HOME = mkdtempSync(join(tmpdir(), "mission-upload-http-"));

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { MAX_UPLOAD_BYTES, UPLOADS_DIR, UPLOAD_TTL_MS, resolveImageUpload } = await import("../src/server/uploads.ts");

// POST /api/uploads over the real Hono app - the exact request the compose box
// makes when an image is dropped on it. What comes back is a PATH, because that's
// the only form an agent can be handed one in: the last hop is keystrokes into a
// pty, so the file goes to disk and the prompt cites where.

openDb();
const app = buildApp({
  registry: new Registry(),
  reviews: null as never,
  tasks: null as never,
  queues: null as never,
});

const LOOPBACK = { host: "127.0.0.1:7317" };

/** A real 1x1 PNG - the route sniffs actual bytes, so this must be one. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * Post one file part exactly as a browser's FormData would.
 *
 * `async` so the awaited `app.request` collapses Hono's `Response |
 * Promise<Response>` - returning that union straight out of a `Promise<Response>`
 * function is a type error the test runner never sees, since tsx strips types
 * rather than checking them.
 */
async function upload(bytes: Buffer, name: string, type = "image/png"): Promise<Response> {
  const body = new FormData();
  body.append("file", new File([new Uint8Array(bytes)], name, { type }));
  return await app.request("/api/uploads", { method: "POST", body, headers: LOOPBACK });
}

test("POST /api/uploads: stores the image and returns a path that exists", async () => {
  const res = await upload(PNG, "screenshot.png");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { path: string; name: string; uploadId: string; bytes: number };
  assert.ok(body.path.startsWith(UPLOADS_DIR + "/"), body.path);
  assert.equal(body.bytes, PNG.byteLength);
  assert.equal(body.uploadId, body.name);
  assert.equal(resolveImageUpload(body.uploadId)?.path, body.path);
  assert.equal(resolveImageUpload(body.uploadId, Date.now() + UPLOAD_TTL_MS + 1), null);
  // The path is a promise to the agent, so the file had better be behind it.
  assert.ok(existsSync(body.path));
  assert.deepEqual(readFileSync(body.path), PNG);
});

test("POST /api/uploads: bytes decide the type, not the filename", async () => {
  // The whole point of the sniff: this endpoint writes a file that an agent is
  // then told to go read. A .png name over a shell script must not become a .png.
  const res = await upload(Buffer.from("#!/bin/sh\nrm -rf /\n", "utf8"), "cute-cat.png");
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /not a recognised image/);
});

test("POST /api/uploads: the client cannot choose where the file lands", async () => {
  const res = await upload(PNG, "../../../../tmp/pwned.png");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { path: string; name: string };
  assert.ok(body.path.startsWith(UPLOADS_DIR + "/"), body.path);
  assert.ok(!body.name.includes("/"), body.name);
  assert.equal(existsSync("/tmp/pwned.png"), false);
});

test("POST /api/uploads: refuses an image past the size cap", async () => {
  // Just over the cap: small enough to clear bodyLimit's envelope slack, so it's
  // the decoded part's own size that rejects it - and the message says "10MB"
  // about the image rather than about the request that carried it.
  const over = Buffer.concat([PNG, Buffer.alloc(MAX_UPLOAD_BYTES - PNG.byteLength + 1)]);
  const res = await upload(over, "huge.png");
  assert.equal(res.status, 413);
  assert.match(((await res.json()) as { error: string }).error, /larger than 10MB/);
});

test("POST /api/uploads: an oversized body is refused before it is parsed", async () => {
  // bodyLimit's job, and this asks in the one way that can tell it ran: the body is
  // huge AND isn't multipart at all. A 413 can only come from the size guard, since
  // parsing this would fail as a 400 ("expected a `file` part"). Sending a huge
  // valid upload wouldn't distinguish - the per-file check would answer 413 too.
  const res = await app.request("/api/uploads", {
    method: "POST",
    body: Buffer.alloc(MAX_UPLOAD_BYTES * 3),
    headers: { ...LOOPBACK, "content-type": "application/octet-stream" },
  });
  assert.equal(res.status, 413, "a body this size must not reach formData()");
  assert.match(((await res.json()) as { error: string }).error, /larger than 10MB/);
});

test("POST /api/uploads: a request with no file part is a 400, not a crash", async () => {
  const empty = await app.request("/api/uploads", {
    method: "POST",
    body: new FormData(),
    headers: LOOPBACK,
  });
  assert.equal(empty.status, 400);

  // Hono's formData() throws on a body that isn't multipart at all.
  const wrong = await app.request("/api/uploads", {
    method: "POST",
    body: JSON.stringify({ file: "hi" }),
    headers: { ...LOOPBACK, "content-type": "application/json" },
  });
  assert.equal(wrong.status, 400);
});

test("POST /api/uploads: a text part named `file` is not a file", async () => {
  const body = new FormData();
  body.append("file", "just a string");
  const res = await app.request("/api/uploads", { method: "POST", body, headers: LOOPBACK });
  assert.equal(res.status, 400);
});

test("POST /api/uploads: is refused from a non-loopback Host", async () => {
  // Same DNS-rebinding guard as every other data endpoint. It matters more here:
  // this one writes a file that an agent will be pointed at.
  const res = await app.request("/api/uploads", {
    method: "POST",
    body: new FormData(),
    headers: { host: "evil.example.com" },
  });
  assert.equal(res.status, 403);
});

test("POST /api/uploads: two drops of the same screenshot both survive", async () => {
  const [a, b] = await Promise.all([upload(PNG, "Screenshot.png"), upload(PNG, "Screenshot.png")]);
  const one = (await a.json()) as { path: string };
  const two = (await b.json()) as { path: string };
  assert.notEqual(one.path, two.path, "the second must not clobber the first");
  assert.ok(existsSync(one.path) && existsSync(two.path));
});
