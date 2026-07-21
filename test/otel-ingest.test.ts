import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OtlpMetrics } from "../src/shared/protocol.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

// What is at stake: the ledger is the only record of what the fleet spent, and every way
// it can be wrong is silent.
//
// A retried export that ADDS instead of REPLACING inflates the total forever with nothing
// to notice it. A `timeUnixNano` parsed as a JS number (it is ~1.78e18, past
// Number.MAX_SAFE_INTEGER) collapses adjacent windows into one and loses spend just as
// quietly. And these datapoints carry `user.email` and `organization.id` alongside the
// numbers, into a durable file in the user's home directory - so "we never read it" has to
// be a property the tests hold, not a claim in a comment.

const home = mkdtempSync(join(tmpdir(), "mission-otel-"));
process.env.MISSION_HOME = home;

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { OtlpMetricsSchema } = await import("../src/shared/protocol.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const db = openDb();

/** A datapoint's attribute list, in OTLP's key/value shape. */
function attrs(map: Record<string, string>): Array<{ key: string; value: { stringValue: string } }> {
  return Object.entries(map).map(([key, v]) => ({ key, value: { stringValue: v } }));
}

/**
 * One export, shaped exactly as Claude Code puts it on the wire - including the PII
 * attributes, because a fixture that omitted them could not prove they are dropped.
 */
function exportBody(o: {
  sessionId: string;
  costUsd?: number;
  tokens?: Partial<Record<"input" | "output" | "cacheRead" | "cacheCreation", number>>;
  startNs?: string;
  endNs?: string;
  model?: string;
  querySource?: string;
  temporality?: number;
}): OtlpMetrics {
  const base = {
    "session.id": o.sessionId,
    model: o.model ?? "claude-opus-4-8[1m]",
    query_source: o.querySource ?? "main",
    // PII, present on every real datapoint. Must never reach the database.
    "user.email": "someone@example.test",
    "user.account_uuid": "acct-uuid-1",
    "user.account_id": "acct-1",
    "organization.id": "org-1",
  };
  const startTimeUnixNano = o.startNs ?? "1784489513278000000";
  const timeUnixNano = o.endNs ?? "1784489513488000000";
  const metrics: unknown[] = [];
  if (o.costUsd != null) {
    metrics.push({
      name: "claude_code.cost.usage",
      sum: {
        aggregationTemporality: o.temporality ?? 1,
        isMonotonic: true,
        dataPoints: [
          { asDouble: o.costUsd, startTimeUnixNano, timeUnixNano, attributes: attrs(base) },
        ],
      },
    });
  }
  if (o.tokens) {
    metrics.push({
      name: "claude_code.token.usage",
      sum: {
        aggregationTemporality: o.temporality ?? 1,
        dataPoints: Object.entries(o.tokens).map(([type, n]) => ({
          asDouble: n,
          startTimeUnixNano,
          timeUnixNano,
          attributes: attrs({ ...base, type }),
        })),
      },
    });
  }
  // Through the real schema, so a fixture that the route would reject can't pass here.
  return OtlpMetricsSchema.parse({
    resourceMetrics: [{ resource: { attributes: [] }, scopeMetrics: [{ metrics }] }],
  });
}

function ledgerRows(noteKey: string): Array<Record<string, unknown>> {
  return db
    .prepare(`SELECT * FROM usage_ledger WHERE note_key = ? ORDER BY id`)
    .all(noteKey) as unknown as Array<Record<string, unknown>>;
}

test("a token.usage datapoint lands in the column its `type` names", () => {
  const registry = new Registry();
  registry.applyOtelMetrics(
    exportBody({
      sessionId: "sess-cols",
      costUsd: 0.25,
      tokens: { input: 2, output: 561, cacheRead: 91_000, cacheCreation: 27_298 },
    }),
  );
  const rows = ledgerRows("sess-cols");
  assert.equal(rows.length, 1, "one window, one row - cost and tokens share it");
  const r = rows[0]!;
  assert.equal(r.cost_usd, 0.25);
  assert.equal(r.input, 2);
  assert.equal(r.output, 561);
  // camelCase on the wire, snake_case in the table - the near-miss that would silently
  // drop most of the tokens, since 99%+ of them are cache reads.
  assert.equal(r.cache_read, 91_000);
  assert.equal(r.cache_write, 27_298);
});

test("re-posting an identical export changes neither the row count nor the sums", () => {
  const registry = new Registry();
  const body = exportBody({ sessionId: "sess-retry", costUsd: 0.5, tokens: { input: 10 } });
  registry.applyOtelMetrics(body);
  registry.applyOtelMetrics(body);
  registry.applyOtelMetrics(body);
  const rows = ledgerRows("sess-retry");
  assert.equal(rows.length, 1, "a retried export must replace its window, not add one");
  assert.equal(rows[0]!.cost_usd, 0.5, "and must not accumulate into it");
  assert.equal(rows[0]!.input, 10);
});

test("distinct delta windows accumulate", () => {
  const registry = new Registry();
  for (const [startNs, endNs, usd] of [
    ["1784489513278000000", "1784489513488000000", 0.1],
    ["1784489513488000000", "1784489573488000000", 0.2],
    ["1784489573488000000", "1784489633488000000", 0.3],
  ] as const) {
    registry.applyOtelMetrics(exportBody({ sessionId: "sess-delta", costUsd: usd, startNs, endNs }));
  }
  const rows = ledgerRows("sess-delta");
  assert.equal(rows.length, 3);
  const total = rows.reduce((n, r) => n + (r.cost_usd as number), 0);
  assert.ok(Math.abs(total - 0.6) < 1e-9, `expected 0.6, got ${total}`);
});

test("window nanos past 2^53 round-trip without colliding", () => {
  // These two differ in their last digits only - far below the precision a double can
  // hold at 1.78e18, so a `Number(timeUnixNano)` anywhere in the path makes them equal
  // and the second export silently overwrites the first.
  const a = "1784489513488000001";
  const b = "1784489513488000002";
  assert.equal(Number(a), Number(b), "the two nanos are indistinguishable as JS numbers");
  const registry = new Registry();
  registry.applyOtelMetrics(exportBody({ sessionId: "sess-nanos", costUsd: 1, endNs: a }));
  registry.applyOtelMetrics(exportBody({ sessionId: "sess-nanos", costUsd: 2, endNs: b }));
  const rows = ledgerRows("sess-nanos");
  assert.equal(rows.length, 2, "two distinct windows must stay two rows");
  assert.deepEqual(
    rows.map((r) => r.window_end_ns),
    [a, b],
    "and must be stored as text, digit for digit",
  );
});

test("PII on a datapoint never reaches the database", () => {
  const registry = new Registry();
  registry.applyOtelMetrics(exportBody({ sessionId: "sess-pii", costUsd: 0.01 }));
  // Not a column-by-column check: the whole table, serialized, must not contain any of it.
  // A column added later that DID capture an attribute would fail this without anyone
  // having to remember to extend the assertion.
  const dump = JSON.stringify(db.prepare(`SELECT * FROM usage_ledger`).all());
  for (const secret of ["someone@example.test", "acct-uuid-1", "acct-1", "org-1"]) {
    assert.ok(!dump.includes(secret), `usage_ledger must not contain ${secret}`);
  }
});

test("a datapoint with no session.id is dropped rather than bucketed", () => {
  const registry = new Registry();
  const body = OtlpMetricsSchema.parse({
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: "claude_code.cost.usage",
                sum: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    {
                      asDouble: 99,
                      timeUnixNano: "1784489513488000000",
                      // No session.id: this is what OTEL_METRICS_INCLUDE_SESSION_ID=false
                      // produces for EVERY datapoint, so a placeholder bucket would
                      // quickly become the fleet's largest "session".
                      attributes: attrs({ model: "claude-opus-4-8" }),
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  });
  const before = (db.prepare(`SELECT COUNT(*) n FROM usage_ledger`).get() as { n: number }).n;
  registry.applyOtelMetrics(body);
  const after = (db.prepare(`SELECT COUNT(*) n FROM usage_ledger`).get() as { n: number }).n;
  assert.equal(after, before, "an unattributable datapoint writes nothing");
});

test("a datapoint with no `model` attribute still de-duplicates", () => {
  // The reason model_id is NOT NULL DEFAULT '': SQLite treats NULLs as distinct inside a
  // UNIQUE index, so a null here would make ON CONFLICT never fire and every retry would
  // insert a fresh row - a total that climbs on its own with no new work behind it.
  const registry = new Registry();
  const body = OtlpMetricsSchema.parse({
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: "claude_code.cost.usage",
                sum: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    {
                      asDouble: 0.75,
                      timeUnixNano: "1784489513488000000",
                      attributes: attrs({ "session.id": "sess-nomodel" }),
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  });
  registry.applyOtelMetrics(body);
  registry.applyOtelMetrics(body);
  const rows = ledgerRows("sess-nomodel");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.cost_usd, 0.75);
});

test("a cumulative series replaces its row instead of accumulating", () => {
  // Claude Code exports delta today, verified on the wire. Should that ever change, the
  // ingest keys a cumulative series on its fixed START time so each export replaces the
  // same row with the newer running total - because SUMming a cumulative counter's
  // successive values would report a wildly inflated figure with nothing to flag it.
  const registry = new Registry();
  const start = "1784489513278000000";
  registry.applyOtelMetrics(
    exportBody({ sessionId: "sess-cum", costUsd: 1, temporality: 2, startNs: start, endNs: "1784489513488000000" }),
  );
  registry.applyOtelMetrics(
    exportBody({ sessionId: "sess-cum", costUsd: 3, temporality: 2, startNs: start, endNs: "1784489573488000000" }),
  );
  const rows = ledgerRows("sess-cum");
  assert.equal(rows.length, 1, "one series, one row");
  assert.equal(rows[0]!.cost_usd, 3, "holding the latest running total, not their sum");
});

test("metrics we do not price are ignored", () => {
  const registry = new Registry();
  const body = OtlpMetricsSchema.parse({
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: "claude_code.active_time.total",
                sum: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    {
                      asDouble: 1234,
                      timeUnixNano: "1784489513488000000",
                      attributes: attrs({ "session.id": "sess-ignored" }),
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  });
  registry.applyOtelMetrics(body);
  assert.equal(ledgerRows("sess-ignored").length, 0);
});

test("a session discovered after a restart still carries spend a previous process recorded", () => {
  // The ledger outlives the daemon, and the sweep no longer re-reads it for every session
  // on every tick - so first sight is the one chance a rebuilt card has to be priced. Get
  // this wrong and it reads as unpriced until some later hook happens to fire, which looks
  // exactly like a fleet nobody enabled telemetry on.
  const before = new Registry();
  before.applyOtelMetrics(exportBody({ sessionId: "sess-restart", costUsd: 2.5 }));

  const restarted = new Registry();
  restarted.applyDiscovery([
    {
      syntheticId: "sess-restart",
      agent: "claude",
      name: "work",
      nameSource: "process",
      cwd: "/repo",
      gitBranch: "feature",
      nomistakesGated: false,
      pid: 1,
      tty: "ttys1",
      terminals: [mkMuxHandle({ session: "s", windowName: "w", windowIndex: 0, paneId: "%1" })],
      startedAt: 0,
    } as never,
  ]);
  assert.equal(restarted.getSession("sess-restart")?.cost?.costUsd, 2.5);
});

test("an ingest reaches a card that was already on screen", () => {
  // The other half of the same contract: once a session is known, `syncSessionsForCost` is
  // what moves the figure, since the sweep now carries the last one forward untouched.
  const registry = new Registry();
  registry.applyDiscovery([
    {
      syntheticId: "sess-live",
      agent: "claude",
      name: "work",
      nameSource: "process",
      cwd: "/repo",
      gitBranch: "feature",
      nomistakesGated: false,
      pid: 2,
      tty: "ttys2",
      terminals: [mkMuxHandle({ session: "s", windowName: "w", windowIndex: 1, paneId: "%2" })],
      startedAt: 0,
    } as never,
  ]);
  assert.equal(registry.getSession("sess-live")?.cost, null, "not told is not the same as cost nothing");
  registry.applyOtelMetrics(exportBody({ sessionId: "sess-live", costUsd: 0.75 }));
  assert.equal(registry.getSession("sess-live")?.cost?.costUsd, 0.75);
});

test("a hook does not blank an unpriced token count the ledger has never heard of", () => {
  // Two writers reach `Session.cost`, and only one of them is the ledger. A harness that
  // reports no dollars still reports TOKENS, which `applyPassiveUsage` puts straight onto
  // the session with `costUsd: null` - there is no ledger row to read it back out of.
  //
  // So a hook that re-derives the figure from the ledger on every event answers null for
  // exactly those sessions and wipes the chip, several times a turn, with the poller
  // putting it back a tick later. The rule is the one `applyRuntimeMeta` and
  // `mergeDiscovered` already hold: re-read on a note-key ROTATION, carry it otherwise.
  const registry = new Registry();
  registry.applyDiscovery([
    {
      syntheticId: "sess-passive",
      agent: "codex",
      name: "work",
      nameSource: "process",
      cwd: "/repo",
      gitBranch: "feature",
      nomistakesGated: false,
      pid: 3,
      tty: "ttys3",
      terminals: [mkMuxHandle({ session: "s", windowName: "w", windowIndex: 2, paneId: "%3" })],
      startedAt: 0,
    } as never,
  ]);
  registry.applyPassiveUsage("sess-passive", {
    costUsd: null,
    input: 1200,
    output: 340,
    cacheRead: 0,
    cacheWrite: 0,
    reasoningOutput: 0,
    updatedAt: 1,
  } as never);
  assert.equal(registry.getSession("sess-passive")?.cost?.input, 1200);

  registry.applyHook({
    agent: "codex",
    event: "PostToolUse",
    sessionId: null,
    cwd: "/repo",
    transcriptPath: null,
    toolName: "shell",
    env: { tmuxPane: "%3" },
  } as never);

  assert.equal(
    registry.getSession("sess-passive")?.cost?.input,
    1200,
    "the passively-read token count survived an ordinary mid-turn hook",
  );
});
