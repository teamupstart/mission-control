import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReportItem } from "../src/shared/reports.ts";
import type { PendingTurn } from "../src/shared/types.ts";
import { unexpectedActiveSdkDelivery } from "./helpers/pending-turn-sender.ts";

// `POST /api/reports/:id/reply`, as the report card reaches it.
//
// A reply is the operator's own message: it goes through the same outbox the composer's Send
// uses, carrying a line that names the report, the report restated, then the operator's words.
// The outbox accepting it marks the report read with `readBy` "reply"; a session busy with a
// turn queues it and the report is read all the same; a session that has exited refuses, and the
// report stays unread. Nothing but the operator replies.

const home = mkdtempSync(join(tmpdir(), "mission-reports-reply-http-"));
process.env.HARNESS_HOME = home;

const { Registry } = await import("../src/server/registry.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { ReportManager } = await import("../src/server/reports.ts");
const { PendingTurnManager } = await import("../src/server/pending-turns.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const flags = await import("../src/server/feature-flags/index.ts");

type ReviewManager = import("../src/server/reviews.ts").ReviewManager;
type TaskManager = import("../src/server/tasks.ts").TaskManager;
type QueueManager = import("../src/server/queue.ts").QueueManager;
type SdkSupervisor = import("../src/server/sdk/supervisor.ts").SdkSupervisor;

after(() => rmSync(home, { recursive: true, force: true }));

const LOOPBACK = { host: "127.0.0.1:7317", "content-type": "application/json" };
flags.applyFeatureFlagIntent({ kind: "flag", id: "inbox", enabled: true });

let serial = 0;

/** `outboxStarted: false` leaves the real outbox unstarted, so it refuses every submit. */
function setup({ outboxStarted = true }: { outboxStarted?: boolean } = {}) {
  serial += 1;
  const registry = new Registry();
  const session = registry.registerSdkSession({
    id: `sdk:reply-http:${serial}`,
    agent: "claude",
    name: "reply routes",
    cwd: `/repo/reply-${serial}`,
    agentSessionId: `agent:reply-http:${serial}`,
  });
  // Nothing is delivered in these tests: what is asserted is what the outbox accepted.
  const supervisor = {
    send: async () => "started" as const,
    interruptForDelivery: unexpectedActiveSdkDelivery.interruptForDelivery,
    sendWhenIdle: async () => "started" as const,
  } as unknown as SdkSupervisor;
  const pending = new PendingTurnManager(registry, supervisor, { idleSettleMs: 60_000 });
  if (outboxStarted) pending.start();
  const reports = new ReportManager(registry);
  after(() => {
    reports.stop();
    pending.stop();
  });
  const app = buildApp({
    registry,
    reviews: {} as ReviewManager,
    tasks: {} as TaskManager,
    queues: {} as QueueManager,
    sdkSessions: supervisor,
    pendingTurns: pending,
    reports,
  });
  const reply = async (id: string, text: string, headers: Record<string, string> = {}) => {
    const res = await app.request(`/api/reports/${id}/reply`, {
      method: "POST",
      headers: { ...LOOPBACK, ...headers },
      body: JSON.stringify({ text }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const replyRaw = async (id: string, raw: string) => {
    const res = await app.request(`/api/reports/${id}/reply`, { method: "POST", headers: LOOPBACK, body: raw });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { registry, session, reports, reply, replyRaw };
}

async function post(f: ReturnType<typeof setup>, title: string): Promise<ReportItem> {
  return await f.reports.post(f.registry.getSession(f.session.id)!, { title, body: "The cache key ignored the lockfile." });
}

test("a reply to a live session is queued as the operator's message naming the report, and marks it read", async () => {
  const f = setup();
  const report = await post(f, "Build failure diagnosed");
  const answered = await f.reply(report.id, "Good. Fix it and open a PR.");
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  const turn = answered.body.pendingTurn as PendingTurn;
  assert.match(turn.text, new RegExp(`^Reply to your report 'Build failure diagnosed' \\(${report.id}\\), posted just now\\.`));
  assert.match(turn.text, /The cache key ignored the lockfile\./);
  assert.ok(turn.text.endsWith("Your operator's reply:\nGood. Fix it and open a PR."));
  assert.equal(answered.body.sessionId, f.session.id);
  // Exactly the composer's queued turn: the outbox holds it for the session.
  assert.deepEqual(f.registry.getSession(f.session.id)!.pendingTurns.map((t) => t.id), [turn.id]);
  const read = f.reports.get(report.id)!;
  assert.equal(read.readBy, "reply");
  assert.ok(read.readAt !== null);
  assert.equal(f.registry.reportsToRead().some((r) => r.id === report.id), false, "it left to read");
});

test("a reply to a busy session is queued behind its turn, and the report is read all the same", async () => {
  const f = setup();
  const report = await post(f, "Busy report");
  f.registry.applyDriverEvent(f.session.id, { kind: "state", state: "working", activity: null });
  const answered = await f.reply(report.id, "Carry on, then look at this.");
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.equal((answered.body.pendingTurn as PendingTurn).state, "queued");
  assert.equal(f.reports.get(report.id)!.readBy, "reply");
});

test("a live session whose outbox refuses the reply leaves the report unread and says why", async () => {
  const f = setup({ outboxStarted: false });
  const report = await post(f, "Outbox refused report");
  // The target is live: the refusal comes from the outbox's submit, not from the target check.
  assert.deepEqual(f.reports.replyTargetFor(report), { kind: "live", sessionId: f.session.id });
  const refused = await f.reply(report.id, "Did this arrive?");
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "pending turns are still starting");
  const unread = f.reports.get(report.id)!;
  assert.equal(unread.readAt, null);
  assert.equal(unread.readBy, null);
  assert.equal(f.registry.reportsToRead().some((r) => r.id === report.id), true, "still to read");
  assert.deepEqual(f.registry.getSession(f.session.id)?.pendingTurns ?? [], [], "nothing was queued");
});

test("a reply to an exited session is refused and the report stays unread", async () => {
  const f = setup();
  const report = await post(f, "Exited report");
  f.registry.applyDriverEvent(f.session.id, { kind: "exited", reason: "done", resumable: false });
  const refused = await f.reply(report.id, "Too late?");
  assert.equal(refused.status, 409);
  // This fixture session has no repository, so not even a follow-up can be started from the card.
  assert.match(String(refused.body.error), /has ended/);
  assert.equal(f.reports.get(report.id)!.readAt, null);
  assert.deepEqual(f.registry.getSession(f.session.id)?.pendingTurns ?? [], []);
});

test("only the operator replies, and a reply needs words", async () => {
  const f = setup();
  const report = await post(f, "Guarded report");
  assert.equal((await f.reply(report.id, "x", { "x-harness-token": ensureToken() })).status, 403);
  assert.equal((await f.reply(report.id, "x", { "x-mission-operation-actor": "foreman" })).status, 403);
  const empty = await f.reply(report.id, "   ");
  assert.equal(empty.status, 400);
  // The card prints the refusal beneath itself, so it is the schema's sentence, not its issue list.
  assert.equal(empty.body.error, "a reply needs words");
  const tooLong = await f.reply(report.id, "x".repeat(4_001));
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.body.error, "a reply can be at most 4000 characters");
  assert.equal((await f.reply("r-999999", "x")).status, 404);
  // A body that is present but not JSON is refused as such, not read as {}.
  const garbled = await f.replyRaw(report.id, "{not json");
  assert.equal(garbled.status, 400);
  assert.equal(garbled.body.error, "the request body is not valid JSON");
  assert.equal(f.reports.get(report.id)!.readAt, null);
});

test("with the inbox flag off the reply route refuses", async () => {
  const f = setup();
  const report = await post(f, "Flag report");
  flags.applyFeatureFlagIntent({ kind: "flag", id: "inbox", enabled: false });
  try {
    const refused = await f.reply(report.id, "hello");
    assert.equal(refused.status, 404);
    assert.equal(refused.body.feature, "inbox");
  } finally {
    flags.applyFeatureFlagIntent({ kind: "flag", id: "inbox", enabled: true });
  }
  assert.equal(f.reports.get(report.id)!.readAt, null);
});

test("parseBody hands a route the schema's issues, so a refusal sentence never depends on the error string's format", async () => {
  const { Hono } = await import("hono");
  const { parseBody } = await import("../src/server/http-body.ts");
  const { ReportReplySchema } = await import("../src/shared/protocol.ts");
  const app = new Hono();
  app.post("/probe", async (c) => {
    const parsed = await parseBody(c, ReportReplySchema);
    return parsed.ok ? c.json({ ok: true }) : c.json({ issues: parsed.issues ?? null });
  });
  const probe = async (body: string) =>
    (await (await app.request("/probe", { method: "POST", headers: { "content-type": "application/json" }, body })).json()) as {
      issues: Array<{ message: string }> | null;
    };
  assert.equal((await probe(JSON.stringify({ text: "   " }))).issues?.[0]?.message, "a reply needs words");
  assert.equal((await probe(JSON.stringify({ text: "x".repeat(4_001) }))).issues?.[0]?.message, "a reply can be at most 4000 characters");
});

test("a reply to a replaced or already-read report is refused, and nothing is sent", async () => {
  const f = setup();
  const first = await post(f, "First version");
  const second = await f.reports.post(f.registry.getSession(f.session.id)!, { title: "Second version", body: "Corrected.", replaces: first.id });
  const replaced = await f.reply(first.id, "About the first one");
  assert.equal(replaced.status, 409);
  assert.equal(replaced.body.error, `This report was replaced by ${second.id}. Reply to that version instead.`);
  f.reports.markRead(second.id, "mark-read");
  const read = await f.reply(second.id, "Too late");
  assert.equal(read.status, 409);
  assert.equal(read.body.error, "This report has already been read.");
  assert.deepEqual(f.registry.getSession(f.session.id)?.pendingTurns ?? [], [], "nothing was queued");
  assert.equal(f.reports.get(second.id)!.readBy, "mark-read", "it keeps how it was cleared");
});
