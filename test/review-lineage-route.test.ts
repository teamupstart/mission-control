import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { ReviewItem } from "../src/shared/types.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

// An answer can be delivered to a runtime-transfer successor for a question its predecessor
// asked. The dashboard draws that delivered turn's card from `?lineage=1`, which returns the
// predecessors' conversation history and never the session's own.

const home = mkdtempSync(join(tmpdir(), "mission-review-lineage-route-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { openDb } = await import("../src/server/db.ts");
const { Registry, noteKeyFor } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { buildApp } = await import("../src/server/routes.ts");

const HEADERS = { host: "127.0.0.1:7317" };

test("?lineage=1 returns the answered questions of the sessions this conversation was transferred from", async () => {
  const registry = new Registry();
  registry.applyDiscovery([{
    syntheticId: "proc:ttys901:901:0", agent: "claude", name: "successor", nameSource: "process", cwd: "/wt/lineage",
    gitBranch: null, gitRoot: null, repoRoot: null, pid: 901, tty: "ttys901",
    terminals: [mkMuxHandle({ session: "s", windowName: "w", windowIndex: 0, paneId: "%901" })], startedAt: 0,
  } as DiscoveredSession]);
  const session = registry.getSession("proc:ttys901:901:0")!;
  const app = buildApp({ registry, reviews: new ReviewManager(registry), tasks: new TaskManager(registry), queues: new QueueManager(registry) });

  const answer = (id: string, sessionId: string) => openDb().prepare(`INSERT INTO reviews
    (id, session_id, kind, title, body, status, response, created_at, resolved_at, resolved_by, wait_mode)
    VALUES (?, ?, 'input', 'Which linter?', 'Which linter?', 'answered', 'eslint', 1, 2, 'human', 'message')`).run(id, sessionId);
  const inherited = randomUUID();
  const own = randomUUID();
  answer(inherited, "predecessor");
  answer(own, session.id);
  answer(randomUUID(), "unrelated");
  openDb().prepare(`INSERT INTO session_runtime_transfers
    (id, revision, source_session_id, note_key, task_id, state, reason, successor_session_id, facts_json, created_at, updated_at)
    VALUES (?, 1, 'predecessor', ?, NULL, 'adopted', 'runtime', ?, '{}', 1, 1)`).run(randomUUID(), noteKeyFor(session), session.id);

  const path = `/api/sessions/${encodeURIComponent(session.id)}/resolved-reviews`;
  const lineage = await (await app.request(`${path}?lineage=1`, { headers: HEADERS })).json() as ReviewItem[];
  assert.deepEqual(lineage.map((r) => r.id), [inherited], "the predecessor's answer, and nothing of this session or another");
  const ownHistory = await (await app.request(path, { headers: HEADERS })).json() as ReviewItem[];
  assert.deepEqual(ownHistory.map((r) => r.id), [own], "the session's own history is unchanged");
});

test("the history always includes reviews this conversation's bound deliveries name, past the newest-500 cap", async () => {
  const { insertReviewDelivery } = await import("../src/server/db.ts");
  const registry = new Registry();
  registry.applyDiscovery([{
    syntheticId: "proc:ttys902:902:0", agent: "claude", name: "long", nameSource: "process", cwd: "/wt/long",
    gitBranch: null, gitRoot: null, repoRoot: null, pid: 902, tty: "ttys902",
    terminals: [mkMuxHandle({ session: "s", windowName: "w", windowIndex: 0, paneId: "%902" })], startedAt: 0,
  } as DiscoveredSession]);
  const session = registry.getSession("proc:ttys902:902:0")!;
  const app = buildApp({ registry, reviews: new ReviewManager(registry), tasks: new TaskManager(registry), queues: new QueueManager(registry) });
  const insert = openDb().prepare(`INSERT INTO reviews
    (id, session_id, kind, title, body, status, response, created_at, resolved_at, resolved_by, wait_mode)
    VALUES (?, ?, 'input', 'Which linter?', 'Which linter?', 'answered', 'eslint', ?, ?, 'human', 'message')`);
  // The answer delivered long ago, then 501 newer answers that push it out of the capped history.
  const old = randomUUID();
  insert.run(old, session.id, 1, 2);
  for (let i = 0; i < 501; i++) insert.run(randomUUID(), session.id, 10 + i, 10 + i);
  insertReviewDelivery({
    id: randomUUID(), noteKey: noteKeyFor(session), fingerprint: "f", envelope: "answer", reviewIds: [old],
    deliveredAt: 3, transcriptOffset: 0, contested: false, confirmedAt: 3, messageId: "delivered-turn", messageTs: 3,
    echoOwed: false, echoTurnGeneration: 1, echoEligibleAt: null, steerEcho: null,
  });
  const history = await (await app.request(`/api/sessions/${encodeURIComponent(session.id)}/resolved-reviews`, { headers: HEADERS })).json() as ReviewItem[];
  assert.equal(history.filter((r) => r.id !== old).length, 500, "the cap still applies to the rest");
  assert.ok(history.some((r) => r.id === old), "the delivered answer's review is always there for its card");
});
