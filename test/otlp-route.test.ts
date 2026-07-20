import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake at the route, as distinct from the ingest below it.
//
// Two things, both of which fail quietly. The endpoint is unauthenticated-by-default
// territory - it sits outside the `/api/*` loopback middleware, like `/hooks` and
// `/statusline`, so the token is the ONLY thing between any local process and the fleet's
// spend record. And the response body is load-bearing in a way an HTTP endpoint's usually
// is not: the OTel SDK reads a non-JSON 2xx as a partial failure and RETRIES, so a bare
// 204 here would silently double the export traffic from every Claude session on the
// machine while looking, from the daemon's side, like everything was fine.

const home = mkdtempSync(join(tmpdir(), "mission-otlp-route-"));
process.env.MISSION_HOME = home;

const { openDb } = await import("../src/server/db.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { buildApp } = await import("../src/server/routes.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const db = openDb();
const TOKEN = ensureToken();
const registry = new Registry();
const app = buildApp(
  registry,
  new ReviewManager(registry),
  new TaskManager(registry),
  new QueueManager(registry),
);

// Anchored to now, not to the day this was written: `spendToday` is measured from LOCAL
// midnight, so a hard-coded export window silently stops counting toward it the following
// day and the assertion below turns into a test of nothing.
const END_NS = `${Date.now()}000000`;
const START_NS = `${Date.now() - 210}000000`;

const BODY = {
  resourceMetrics: [
    {
      scopeMetrics: [
        {
          metrics: [
            {
              name: "claude_code.cost.usage",
              sum: {
                aggregationTemporality: 1,
                isMonotonic: true,
                dataPoints: [
                  {
                    asDouble: 0.0965845,
                    startTimeUnixNano: START_NS,
                    timeUnixNano: END_NS,
                    attributes: [
                      { key: "session.id", value: { stringValue: "route-sess" } },
                      { key: "model", value: { stringValue: "claude-opus-4-8[1m]" } },
                      { key: "query_source", value: { stringValue: "main" } },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  ],
};

async function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return await app.fetch(
    new Request("http://127.0.0.1:7317/v1/metrics", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

function rowCount(): number {
  return (db.prepare(`SELECT COUNT(*) n FROM usage_ledger`).get() as { n: number }).n;
}

test("an export without the token is refused and writes nothing", () => {
  const before = rowCount();
  return post(BODY).then(async (res) => {
    assert.equal(res.status, 401);
    assert.equal(rowCount(), before, "an unauthorized export must not reach the ledger");
  });
});

test("an authorized export is accepted with a JSON body, not a bare 204", async () => {
  const res = await post(BODY, { "x-harness-token": TOKEN });
  assert.equal(res.status, 200);
  // The SDK treats a non-JSON 2xx as a partial failure and retries - so this is the
  // difference between one export per interval and two.
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  assert.deepEqual(await res.json(), {});
  assert.equal(registry.snapshot().fleetCost?.spendToday, 0.0965845);
});

test("a malformed body is a 400, not a 500", async () => {
  const res = await post({ resourceMetrics: "not an array" }, { "x-harness-token": TOKEN });
  assert.equal(res.status, 400);
});

test("an unrecognised shape is tolerated rather than dropped whole", async () => {
  // The schema is deliberately loose: this is Claude Code's wire shape, not ours, and a
  // strict mirror would turn any upstream addition into total silent data loss here.
  const res = await post(
    {
      resourceMetrics: [
        {
          resource: { attributes: [{ key: "host.name", value: { stringValue: "mac" } }] },
          scopeMetrics: [
            {
              scope: { name: "com.anthropic.claude_code", version: "9.9.9" },
              metrics: [
                {
                  name: "claude_code.cost.usage",
                  description: "a field we have never seen",
                  unit: "USD",
                  sum: {
                    aggregationTemporality: 1,
                    isMonotonic: true,
                    dataPoints: [
                      {
                        asDouble: 1,
                        timeUnixNano: "1784489599999000000",
                        exemplars: [],
                        flags: 0,
                        attributes: [{ key: "session.id", value: { stringValue: "route-tolerant" } }],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    },
    { "x-harness-token": TOKEN },
  );
  assert.equal(res.status, 200);
  const n = (
    db.prepare(`SELECT COUNT(*) n FROM usage_ledger WHERE note_key = ?`).get("route-tolerant") as {
      n: number;
    }
  ).n;
  assert.equal(n, 1, "the datapoint still landed despite the unknown fields around it");
});
