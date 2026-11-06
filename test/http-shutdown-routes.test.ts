import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake: every route that holds a response open must register it with
// `openEndedRequests`, or the daemon's shutdown waits on it until the grace runs out and then
// cuts it. `test/daemon-shutdown-open-stream.test.ts` proves `/events` through a real daemon;
// this proves the other two registrations through the real routes, by beginning shutdown the
// way `closeHttpServer` does and asserting each response completes promptly.

const home = mkdtempSync(join(tmpdir(), "mission-http-shutdown-routes-"));
process.env.HARNESS_HOME = home;
process.env.MISSION_HOME = home;
const dir = mkdtempSync(join(tmpdir(), "mission-http-shutdown-routes-tx-"));
after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

const { openDb } = await import("../src/server/db.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { openEndedRequests } = await import("../src/server/http-shutdown.ts");
const { mkSession } = await import("./helpers/session-fixture.ts");
import type { Registry as RegistryType } from "../src/server/registry.ts";
import type { ReviewItem, Session } from "../src/shared/types.ts";

openDb();
const TOKEN = ensureToken();
const LOOPBACK = { host: "127.0.0.1:7317" };

// The transcript stream reads one session's file; a two-method fake is all it asks of the
// registry, as in `transcript-stream-resume.test.ts`.
const path = join(dir, "session.jsonl");
writeFileSync(path, `${JSON.stringify({
  type: "assistant",
  uuid: "a",
  timestamp: new Date(1000).toISOString(),
  message: { role: "assistant", content: [{ type: "text", text: "FIRST" }] },
})}\n`);
const session: Session = { ...mkSession(), id: "s1", agent: "claude", transcriptPath: path };
const transcriptApp = buildApp({
  registry: {
    getSession: (id: string) => (id === "s1" ? session : undefined),
    launchTurnFor: () => null,
  } as unknown as RegistryType,
  reviews: {} as never,
  tasks: {} as never,
  queues: {} as never,
});

// The review long-poll needs the real manager behind the real route.
const registry = new Registry();
const reviews = new ReviewManager(registry);
const reviewApp = buildApp({
  registry,
  reviews,
  tasks: new TaskManager(registry),
  queues: new QueueManager(registry),
});

const settledWithin = <T>(promise: Promise<T>, ms: number): Promise<T | "still open"> =>
  Promise.race([promise, new Promise<"still open">((resolve) => setTimeout(() => resolve("still open"), ms))]);

test("beginning shutdown completes an open transcript stream and answers a review long-poll", async () => {
  // Transcript stream: read the opening frame, then wait for the body to end.
  const streamRes = await transcriptApp.request("/api/sessions/s1/transcript/stream", { headers: LOOPBACK });
  assert.equal(streamRes.status, 200);
  const reader = streamRes.body!.getReader();
  const first = await reader.read();
  assert.equal(first.done, false, "the stream sent no opening frame");
  const drain = (async () => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return "ended" as const;
    }
  })();

  // Review long-poll: a pending question the route would otherwise hold for 30 seconds.
  const review = reviews.create("sdk:http-shutdown-routes", "input", "Ship it?", "Ship it?", null);
  const waitRes = Promise.resolve(reviewApp.request(`/mcp/reviews/${review.id}/wait`, {
    headers: { ...LOOPBACK, "x-harness-token": TOKEN },
  }));

  // Both are genuinely open before shutdown begins.
  assert.equal(await settledWithin(drain, 300), "still open", "the transcript stream ended on its own");
  assert.equal(await settledWithin(waitRes, 50), "still open", "the review wait returned on its own");

  const started = Date.now();
  openEndedRequests.endAll();

  assert.equal(await settledWithin(drain, 2_000), "ended", "the transcript stream was not registered for shutdown");
  const answered = await settledWithin(waitRes, 2_000);
  assert.notEqual(answered, "still open", "the review wait route was not registered for shutdown");
  const res = answered as Response;
  assert.equal(res.status, 200);
  const body = (await res.json()) as ReviewItem;
  assert.equal(body.id, review.id);
  assert.equal(body.status, "pending", "a shutdown must answer as a timeout, never as a decision");
  assert.ok(Date.now() - started < 2_000);
});
