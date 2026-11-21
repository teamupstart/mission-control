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
