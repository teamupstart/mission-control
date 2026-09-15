import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The typed browser ingress, from the daemon's side.
//
// What is at stake: this is the ONE endpoint in the app that accepts a fact from an untrusted
// page. Everything else the telemetry facility records is observed by the daemon itself, so a
// forged daemon start, a fabricated workflow verdict or a self-reported "a human did this" has
// to be impossible here rather than merely unlikely. The tests below are the four ways that
// could go wrong: naming an event the browser may not send, sending a shape the catalog does
// not admit, sending too much, and sending the same thing twice.
//
// The operation-context half is asserted with it, because the two are one claim: what a record
// is attributed to comes from the request, never from the body, and the basis attached to it
// says how much that attribution is worth.

const home = mkdtempSync(join(tmpdir(), "mission-telemetry-ingress-"));
process.env.HARNESS_HOME = join(home, "state");

const { closeDb, openDb } = await import("../src/server/db.ts");
const { setTelemetryConfig } = await import("../src/server/telemetry/config.ts");
const { admitBrowserTelemetry, resetIngressRateLimitForTesting } = await import(
  "../src/server/telemetry/ingress.ts"
);
const { registerBuiltinTelemetry } = await import("../src/server/telemetry/service.ts");
const {
  DAEMON_STARTED_EVENT,
  TELEMETRY_SETTINGS_OPENED_EVENT,
  browserIngressEvents,
  TELEMETRY_EVENTS,
} = await import("../src/shared/telemetry-catalog.ts");
const {
  TELEMETRY_INGRESS_LIMITS,
  TelemetryIngressRequestSchema,
  resolveOperationContext,
} = await import("../src/shared/telemetry-ingress.ts");

registerBuiltinTelemetry();

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

const TELEMETRY_TABLES = [
  "telemetry_journal",
  "telemetry_source_identities",
  "telemetry_projection_state",
  "telemetry_series",
  "telemetry_batches",
  "telemetry_delivery",
  "telemetry_destinations",
  "telemetry_secrets",
  "telemetry_gaps",
  "telemetry_contexts",
  "telemetry_resources",
];

beforeEach(() => {
  const d = openDb();
  for (const table of TELEMETRY_TABLES) d.exec(`DELETE FROM ${table}`);
  d.exec("DELETE FROM app_config");
  resetIngressRateLimitForTesting();
  assert.equal(setTelemetryConfig({ enabled: true }).ok, true);
});

const FROM_APP = resolveOperationContext(
  new Headers({
    "x-mission-operation-id": "abcdef0123456789",
    "x-mission-operation-surface": "settings",
    "x-mission-operation-actor": "human",
  }),
);

const OPENED = {
  event: TELEMETRY_SETTINGS_OPENED_EVENT.name,
  facts: { collection_enabled: true, destinations_enabled: 0 },
};

// ---- the allowlist ----

test("a browser-eligible event is admitted and committed to the journal", () => {
  const result = admitBrowserTelemetry([OPENED], FROM_APP);
  assert.deepEqual(result, { accepted: 1, rejected: [] });
  assert.equal(journalCount(TELEMETRY_SETTINGS_OPENED_EVENT.name), 1, "accepted means committed");
});

test("a daemon-owned event cannot be forged from the browser", () => {
  const result = admitBrowserTelemetry(
    [
      {
        event: DAEMON_STARTED_EVENT.name,
        facts: { startup_ms: 1, schema_upgraded: false, launch_mode: "daemon" },
      },
    ],
    FROM_APP,
  );
  assert.deepEqual(result.rejected, [{ index: 0, reason: "not_browser_eligible" }]);
  assert.equal(journalCount(DAEMON_STARTED_EVENT.name), 0);
});

test("an event name that does not exist is refused rather than invented", () => {
  const result = admitBrowserTelemetry([{ event: "mission.made.up", facts: {} }], FROM_APP);
  assert.deepEqual(result.rejected, [{ index: 0, reason: "unknown_event" }]);
});

test("the allowlist is a catalog property, so it cannot be widened from a call site", () => {
  // The set of browser-eligible entries is small and deliberate. This test is the tripwire for
  // a later phase adding one without meaning to: if this fails, the addition was either correct
  // and this list needs updating with a reason, or it was a `ingress: "browser"` pasted from a
  // neighbouring definition.
  assert.deepEqual(
    browserIngressEvents().map((e) => e.name),
    [TELEMETRY_SETTINGS_OPENED_EVENT.name],
  );
  // And everything else is explicitly not.
  for (const event of Object.values(TELEMETRY_EVENTS)) {
    if (event.name === TELEMETRY_SETTINGS_OPENED_EVENT.name) continue;
    assert.equal(event.ingress, null, `${event.name} must not be reachable from a page`);
  }
});

// ---- malformed and oversized ----

test("facts outside the event's strict schema are refused, not passed through", () => {
  const result = admitBrowserTelemetry(
    [
      {
        event: TELEMETRY_SETTINGS_OPENED_EVENT.name,
        // A plausible-looking payload with one extra key - which is exactly what a component
        // spreading its own props into a telemetry call produces.
        facts: { collection_enabled: true, destinations_enabled: 0, operator_email: "a@b.c" },
      },
    ],
    FROM_APP,
  );
  assert.deepEqual(result.rejected, [{ index: 0, reason: "invalid_facts" }]);
  assert.equal(journalCount(TELEMETRY_SETTINGS_OPENED_EVENT.name), 0);
});

test("a fact of the wrong type is refused", () => {
  const result = admitBrowserTelemetry(
    [
      {
        event: TELEMETRY_SETTINGS_OPENED_EVENT.name,
        facts: { collection_enabled: "yes", destinations_enabled: 0 },
      },
    ],
    FROM_APP,
  );
  assert.deepEqual(result.rejected, [{ index: 0, reason: "invalid_facts" }]);
});

test("an oversized batch is refused by the wire schema before any of it is admitted", () => {
  const records = Array.from({ length: TELEMETRY_INGRESS_LIMITS.maxRecordsPerRequest + 1 }, () => OPENED);
  const parsed = TelemetryIngressRequestSchema.safeParse({ records });
  assert.equal(parsed.success, false, "the request never reaches the admission path at all");
});

test("a batch with one bad record still admits the good ones", () => {
  const result = admitBrowserTelemetry(
    [
      OPENED,
      { event: "mission.made.up", facts: {} },
      { ...OPENED, facts: { collection_enabled: false, destinations_enabled: 1 } },
    ],
    FROM_APP,
  );
  assert.equal(result.accepted, 2);
  assert.deepEqual(result.rejected, [{ index: 1, reason: "unknown_event" }]);
});

// ---- rate limiting ----

test("the rate limit is enforced across every browser, not per connection", () => {
  const now = Date.now();
  let accepted = 0;
  // One record per call, from a fresh operation each time, so nothing is deduped away and the
  // only thing that can stop it is the limit.
  for (let i = 0; i < TELEMETRY_INGRESS_LIMITS.maxRecordsPerMinute + 10; i += 1) {
    accepted += admitBrowserTelemetry([OPENED], operation(`op${String(i).padStart(14, "0")}`), now)
      .accepted;
  }
  assert.equal(accepted, TELEMETRY_INGRESS_LIMITS.maxRecordsPerMinute);

  const over = admitBrowserTelemetry([OPENED], operation("opzzzzzzzzzzzzzz"), now);
  assert.deepEqual(over.rejected, [{ index: 0, reason: "rate_limited" }]);

  // And the window rolls: a minute later the budget is back, rather than being a permanent cap.
  const later = admitBrowserTelemetry(
    [OPENED],
    operation("opyyyyyyyyyyyyyy"),
    now + TELEMETRY_INGRESS_LIMITS.windowMs + 1,
  );
  assert.equal(later.accepted, 1);
});

test("a record refused for bad facts is still charged against the rate limit", () => {
  // The expensive half of the endpoint is everything past the allowlist check: a strict schema
  // parse, and for a valid record a transaction. Charging only on ACCEPTANCE left that half
  // uncapped - a browser-eligible event name carrying facts its schema refuses reached
  // `captureTelemetry` on every submission and was never counted, so the same malformed payload
  // could be resubmitted forever straight past the documented ceiling.
  const now = Date.now();
  const malformed = {
    event: TELEMETRY_SETTINGS_OPENED_EVENT.name,
    facts: { collection_enabled: "yes", destinations_enabled: 0 },
  };
  for (let i = 0; i < TELEMETRY_INGRESS_LIMITS.maxRecordsPerMinute; i += 1) {
    const result = admitBrowserTelemetry([malformed], FROM_APP, now);
    assert.deepEqual(result.rejected, [{ index: 0, reason: "invalid_facts" }]);
  }

  // The budget is now spent, so a WELL-FORMED record from a different operation is refused for
  // rate rather than admitted. Without the charge it would sail through.
  const good = admitBrowserTelemetry([OPENED], operation("aaaaaaaaaaaaaaaa"), now);
  assert.deepEqual(good.rejected, [{ index: 0, reason: "rate_limited" }]);
  assert.equal(good.accepted, 0);
});

test("a stream of unknown event names cannot exhaust a real caller's budget", () => {
  const now = Date.now();
  for (let i = 0; i < TELEMETRY_INGRESS_LIMITS.maxRecordsPerMinute * 2; i += 1) {
    admitBrowserTelemetry([{ event: "mission.made.up", facts: {} }], FROM_APP, now);
  }
  const real = admitBrowserTelemetry([OPENED], operation("oprealrealreal11"), now);
  assert.equal(real.accepted, 1, "nonsense is refused before it is charged");
});

// ---- replay ----

test("the same operation replayed collapses to one fact", () => {
  const operation = FROM_APP;
  assert.equal(admitBrowserTelemetry([OPENED], operation).accepted, 1);
  const replay = admitBrowserTelemetry([OPENED], operation);
  assert.equal(replay.accepted, 0);
  assert.deepEqual(replay.rejected, [{ index: 0, reason: "duplicate" }]);
  assert.equal(journalCount(TELEMETRY_SETTINGS_OPENED_EVENT.name), 1, "a retry is not a second action");
});

test("two different operations are two facts, even with identical contents", () => {
  assert.equal(admitBrowserTelemetry([OPENED], operation("aaaaaaaaaaaaaaaa")).accepted, 1);
  assert.equal(admitBrowserTelemetry([OPENED], operation("bbbbbbbbbbbbbbbb")).accepted, 1);
  assert.equal(journalCount(TELEMETRY_SETTINGS_OPENED_EVENT.name), 2);
});

test("one request may carry two distinct records for one operation", () => {
  const result = admitBrowserTelemetry(
    [OPENED, { ...OPENED, facts: { collection_enabled: false, destinations_enabled: 2 } }],
    FROM_APP,
  );
  assert.equal(result.accepted, 2, "the index distinguishes them within one operation");
});

// ---- attribution ----

test("attribution comes from the request, and its basis says how much it is worth", () => {
  assert.equal(admitBrowserTelemetry([OPENED], FROM_APP).accepted, 1);
  const actor = JSON.parse(journalActor(TELEMETRY_SETTINGS_OPENED_EVENT.name));
  assert.deepEqual(actor, { kind: "human", origin: "dashboard", basis: "app_context" });
});

test("a declared actor with no app context is recorded as declared, not believed", () => {
  const declared = resolveOperationContext(
    new Headers({ "x-mission-operation-actor": "human" }),
  );
  assert.equal(admitBrowserTelemetry([OPENED], declared).accepted, 1);
  const actor = JSON.parse(journalActor(TELEMETRY_SETTINGS_OPENED_EVENT.name));
  assert.equal(actor.basis, "declared", "somebody said so is a different fact from we know");
  assert.equal(actor.kind, "human");
});

test("no header can mint the daemon's own basis", () => {
  // `owner` is what the daemon uses for observations of itself. A request that could claim it
  // would make every other basis meaningless, so it is unreachable by construction - there is
  // no branch in `resolveOperationContext` that produces it.
  for (const claim of ["owner", "OWNER", "app_context", "inferred", "nonsense"]) {
    const context = resolveOperationContext(
      new Headers({ "x-mission-operation-actor": claim }),
    );
    assert.notEqual(context.actor.basis, "owner", `a request claiming ${claim} must not earn owner`);
  }
});

test("a malformed operation id is dropped rather than recorded", () => {
  const context = resolveOperationContext(
    new Headers({
      // Far too long, and with characters the pattern does not admit.
      "x-mission-operation-id": `${"x".repeat(500)}<script>`,
      "x-mission-operation-surface": "settings",
    }),
  );
  assert.equal(context.operationId, null);
  assert.equal(context.actor.basis, "unknown", "a dropped id cannot earn app context");
  assert.equal(admitBrowserTelemetry([OPENED], context).accepted, 1);
  assert.equal(
    JSON.parse(journalRefs(TELEMETRY_SETTINGS_OPENED_EVENT.name)).operation_id,
    undefined,
  );
});

test("an unknown surface falls back to unknown rather than being recorded verbatim", () => {
  const context = resolveOperationContext(
    new Headers({
      "x-mission-operation-id": "abcdef0123456789",
      "x-mission-operation-surface": "../../etc/passwd",
    }),
  );
  assert.equal(context.surface, "unknown");
  assert.equal(context.actor.basis, "unknown", "an unrecognised surface is not app context");
});

// ---- consent still governs ----

test("nothing is admitted while collection is off", () => {
  assert.equal(setTelemetryConfig({ enabled: false }).ok, true);
  const result = admitBrowserTelemetry([OPENED], FROM_APP);
  assert.deepEqual(result.rejected, [{ index: 0, reason: "disabled" }]);
  assert.equal(journalCount(TELEMETRY_SETTINGS_OPENED_EVENT.name), 0);
});

// ---- clock skew ----

test("a browser clock in the future is not believed", () => {
  const now = Date.now();
  assert.equal(
    admitBrowserTelemetry([{ ...OPENED, occurredAt: now + 86_400_000 }], FROM_APP, now).accepted,
    1,
  );
  assert.equal(occurredAt(TELEMETRY_SETTINGS_OPENED_EVENT.name), now);
});

test("a recent browser timestamp inside the skew budget is honoured", () => {
  const now = Date.now();
  const slightlyEarlier = now - 1500;
  assert.equal(
    admitBrowserTelemetry([{ ...OPENED, occurredAt: slightlyEarlier }], FROM_APP, now).accepted,
    1,
  );
  assert.equal(occurredAt(TELEMETRY_SETTINGS_OPENED_EVENT.name), slightlyEarlier);
});

test("a browser clock wrong by years falls back to the daemon's", () => {
  const now = Date.now();
  assert.equal(
    admitBrowserTelemetry([{ ...OPENED, occurredAt: 1 }], FROM_APP, now).accepted,
    1,
  );
  assert.equal(occurredAt(TELEMETRY_SETTINGS_OPENED_EVENT.name), now);
});

// ---- helpers ----

function operation(id: string): ReturnType<typeof resolveOperationContext> {
  return resolveOperationContext(
    new Headers({
      "x-mission-operation-id": id,
      "x-mission-operation-surface": "settings",
      "x-mission-operation-actor": "human",
    }),
  );
}

function journalCount(name: string): number {
  const row = openDb()
    .prepare(`SELECT COUNT(*) AS n FROM telemetry_journal WHERE name = ?`)
    .get(name) as { n: number };
  return row.n;
}

function journalActor(name: string): string {
  return column(name, "actor_json");
}

function journalRefs(name: string): string {
  return column(name, "refs_json");
}

function occurredAt(name: string): number {
  return Number(column(name, "occurred_at"));
}

function column(name: string, field: string): string {
  const row = openDb()
    .prepare(`SELECT ${field} AS v FROM telemetry_journal WHERE name = ? ORDER BY seq DESC LIMIT 1`)
    .get(name) as { v: string } | undefined;
  assert.ok(row, `no journal row for ${name}`);
  return String(row.v);
}
