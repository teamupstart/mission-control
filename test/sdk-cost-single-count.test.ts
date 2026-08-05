import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake: an embedded session has TWO parties who can report what a turn cost,
// and exactly one of them may write it down.
//
// This file used to pin the opposite assignment. The rule was that the ledger has one writer
// per HARNESS - OpenTelemetry for Claude, the rollout reader for Codex - so the driver's own
// figure was display enrichment and the `turn_done` handler deliberately dropped it. The
// subprocess is the operator's own `claude`, launched with the OTel environment
// `~/.claude/settings.json` installs, so it was expected to report the same turn itself.
//
// That rule had one failure mode and no error path for it: it made every Claude session's
// spend depend on an exporter nothing here controls. A CLI whose metrics pipeline produces
// nothing - an inert build, a managed policy, a version regression - takes the whole fleet's
// session cost to zero, and the ledger cannot tell "nothing was spent" from "nobody wrote it
// down". The dashboard reads $0 and everything else looks healthy. That is what happened.
//
// So the writer is now chosen by RUNTIME instead of by harness. A session the daemon DRIVES
// is written by its driver, off the `result` frame it already reads, which no external
// setting can switch off. `applyOtelMetrics` yields for those note keys via
// `sdkOwnedNoteKey`, so the count stays single. OTel remains the writer for the sessions no
// driver owns - a human's terminal `claude`, which Mission Control merely discovered.
//
// The invariant under test is unchanged and is the only one that matters: ONE report of a
// turn is spent. These tests pin which party makes it, and that neither doubles the other.

const home = mkdtempSync(join(tmpdir(), "mission-sdk-cost-"));
process.env.MISSION_HOME = home;

const { openDb, sessionCostFor, upsertUsageCell, usageLedgerHasRows } = await import(
  "../src/server/db.ts"
);
const { Registry, SDK_SESSION_ID_PREFIX } = await import("../src/server/registry.ts");
const { recordSdkSessionBinding, upsertSdkSession } = await import("../src/server/sdk/store.ts");
import type { SdkEvent } from "../src/server/harness/types.ts";

after(() => rmSync(home, { recursive: true, force: true }));

openDb();

const ID = `${SDK_SESSION_ID_PREFIX}44444444-4444-4444-8444-444444444444`;
const AGENT_SESSION = "agent-cost-1";

/**
 * A driver's `turn_done` with both halves of the ledger attribution.
 *
 * `turnId` is the `result` frame's own uuid and `models` its `modelUsage` breakdown - what
 * `claudeTurnUsage` reads off the wire. The flat fields alongside them are the display view.
 */
const TURN_DONE: SdkEvent = {
  kind: "turn_done",
  usage: {
    input: 1200,
    output: 800,
    cacheRead: 4000,
    cacheWrite: 100,
    modelId: "claude-opus-4-8[1m]",
    costUsd: 0.42,
    turnId: "11111111-1111-4111-8111-111111111111",
    models: [
      {
        modelId: "claude-opus-4-8[1m]",
        input: 1200,
        output: 800,
        reasoningOutput: 0,
        cacheRead: 4000,
        cacheWrite: 100,
        reportedCostUsd: 0.42,
      },
    ],
  },
};

/** The same turn with the display view only - what a driver that owns no ledger write sends. */
const TURN_DONE_UNATTRIBUTED: SdkEvent = {
  kind: "turn_done",
  usage: {
    input: 1200,
    output: 800,
    cacheRead: 4000,
    cacheWrite: 100,
    modelId: "claude-opus-4-8[1m]",
    costUsd: 0.42,
  },
};

test("a driver's attributed turn is spent, and spent exactly once", () => {
  const registry = new Registry();
  registry.registerSdkSession({ id: ID, agent: "claude", name: "embedded", cwd: "/repo" });
  registry.applyDriverEvent(ID, {
    kind: "bound",
    agentSessionId: AGENT_SESSION,
    transcriptPath: null,
    modelId: "claude-opus-4-8[1m]",
    pid: null,
  });

  assert.equal(usageLedgerHasRows(), false, "nothing has reported usage yet");
  registry.applyDriverEvent(ID, TURN_DONE);
  // The same turn again - a resumed stream replaying its tail, a supervisor reconnecting.
  // `window_end_ns` holds the turn's uuid, so this is a conflict rather than a second row.
  registry.applyDriverEvent(ID, TURN_DONE);

  const cost = sessionCostFor(AGENT_SESSION);
  assert.ok(cost, "the driver's report reached the ledger");
  assert.equal(cost.costUsd, 0.42, "re-reporting one turn does not double its cost");
  assert.equal(cost.input, 1200, "nor its tokens");
  assert.equal(cost.output, 800);
});

test("the turn's cost is denormalized onto the card, not just into the ledger", () => {
  // A regression with a very specific shape, caught first by the browser spec and pinned here
  // because it costs milliseconds to hold. `turn_done` does two things - the idle transition
  // and the ledger write - and `applyDriverState` REBUILDS the session from the snapshot the
  // handler captured on entry, then writes it back to the map. Recording the usage before that
  // put the cost on an object the state change immediately overwrote: the ledger row was
  // correct and durable, the fleet total (an aggregate, read straight from the ledger) was
  // correct, and only the card's own figure was missing. So the two surfaces disagreed while
  // the one under test looked right.
  const registry = new Registry();
  const id = `${SDK_SESSION_ID_PREFIX}99999999-9999-4999-8999-999999999999`;
  const noteKey = "agent-cost-5";
  registry.registerSdkSession({ id, agent: "claude", name: "embedded", cwd: "/repo" });
  registry.applyDriverEvent(id, {
    kind: "bound",
    agentSessionId: noteKey,
    transcriptPath: null,
    modelId: "claude-opus-4-8[1m]",
    pid: null,
  });
  registry.applyDriverEvent(id, { kind: "state", state: "working", activity: "Editing" });
  registry.applyDriverEvent(id, {
    ...TURN_DONE,
    usage: { ...TURN_DONE.usage!, turnId: "44444444-4444-4444-8444-444444444444" },
  });

  const session = registry.getSession(id);
  assert.equal(session?.state, "idle", "the turn still ended");
  assert.equal(session?.cost?.costUsd, 0.42, "and the card carries what it cost");
  assert.equal(
    sessionCostFor(noteKey)?.costUsd,
    0.42,
    "the ledger and the card agree, which is the whole point",
  );
});

test("a turn the driver could not identify is not written at all", () => {
  // Both halves or neither. A breakdown with no turn id cannot be deduplicated, so writing
  // it would double the session's cost on the first replayed `result` - and a synthesized
  // key would be worse, because a counter restarts when the daemon does and would collide
  // with a real turn's row. This is also how Codex's driver, which reports the flat view
  // only, leaves its spend to the rollout reader without this path naming a harness.
  const registry = new Registry();
  const id = `${SDK_SESSION_ID_PREFIX}77777777-7777-4777-8777-777777777777`;
  const noteKey = "agent-cost-3";
  registry.registerSdkSession({ id, agent: "claude", name: "embedded", cwd: "/repo" });
  registry.applyDriverEvent(id, {
    kind: "bound",
    agentSessionId: noteKey,
    transcriptPath: null,
    modelId: "claude-opus-4-8[1m]",
    pid: null,
  });
  registry.applyDriverEvent(id, TURN_DONE_UNATTRIBUTED);
  assert.equal(
    sessionCostFor(noteKey),
    null,
    "an unattributable turn reads as unknown, not as zero and not as a guess",
  );
});

test("the turn still ends the session's turn, whether or not the usage was spendable", () => {
  // The `turn_done` handler's other job is the IDLE transition (the same fact a `Stop` hook
  // carries). A usage path that threw or returned early must not cost the state change -
  // that would leave an embedded session reading `working` for ever.
  const registry = new Registry();
  const id = `${SDK_SESSION_ID_PREFIX}55555555-5555-4555-8555-555555555555`;
  registry.registerSdkSession({ id, agent: "claude", name: "embedded", cwd: "/repo" });
  registry.applyDriverEvent(id, { kind: "state", state: "working", activity: "Editing" });
  assert.equal(registry.getSession(id)?.state, "working");
  registry.applyDriverEvent(id, TURN_DONE_UNATTRIBUTED);
  assert.equal(registry.getSession(id)?.state, "idle", "an unspendable turn still idles");
  registry.applyDriverEvent(id, { kind: "state", state: "working", activity: "Editing" });
  registry.applyDriverEvent(id, TURN_DONE);
  assert.equal(registry.getSession(id)?.state, "idle", "and so does a spent one");
});

test("the subprocess's own OTel export does not double the driver's report", () => {
  // The half that makes the new assignment safe. A driven session's subprocess IS ordinary
  // Claude Code, so when its exporter works it reports the same turns under the same note
  // key. `applyOtelMetrics` has to yield for a key an SDK session owns, or every embedded
  // card reads roughly double - the exact error the old rule avoided in the other direction.
  const registry = new Registry();
  const id = `${SDK_SESSION_ID_PREFIX}66666666-6666-4666-8666-666666666666`;
  const noteKey = "agent-cost-2";
  registry.registerSdkSession({ id, agent: "claude", name: "embedded", cwd: "/repo" });
  registry.applyDriverEvent(id, {
    kind: "bound",
    agentSessionId: noteKey,
    transcriptPath: null,
    modelId: "claude-opus-4-8[1m]",
    pid: null,
  });
  registry.applyDriverEvent(id, {
    ...TURN_DONE,
    usage: { ...TURN_DONE.usage!, turnId: "22222222-2222-4222-8222-222222222222" },
  });

  registry.applyOtelMetrics({
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
                      asDouble: 0.42,
                      timeUnixNano: "1000000000000000002",
                      startTimeUnixNano: "1000000000000000001",
                      attributes: [
                        { key: "session.id", value: { stringValue: noteKey } },
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
  });

  const cost = sessionCostFor(noteKey);
  assert.ok(cost, "the driver's report is what the ledger holds");
  assert.equal(cost.costUsd, 0.42, "the export for a driven key is dropped, not added");
});

test("an export that beats the driver's first report is dropped, not banked", () => {
  // The race the ledger cannot recover from afterwards. A driven session's exporter runs on an
  // interval of its own, so a datapoint can land for turn one BEFORE that turn's `result`
  // frame has been written - at which point there is no driver row to recognise, and a guard
  // that only checked for one would bank the export and then add the driver's report on top.
  //
  // What closes it is the durable session record: the supervisor writes the binding when the
  // driver binds, on the `init` frame, which precedes every turn. This drives that seam
  // directly (`recordSdkSessionBinding`) because in production the supervisor owns it, not
  // the registry - so a test that only fed the registry would pass while production doubled.
  const registry = new Registry();
  const id = `${SDK_SESSION_ID_PREFIX}88888888-8888-4888-8888-888888888888`;
  const noteKey = "agent-cost-4";
  registry.registerSdkSession({ id, agent: "claude", name: "embedded", cwd: "/repo" });
  upsertSdkSession({
    id,
    agent: "claude",
    agentSessionId: null,
    cwd: "/repo",
    taskId: null,
    model: null,
    effort: null,
    permissionMode: null,
    status: "running",
    turnInProgress: false,
  });
  recordSdkSessionBinding(id, noteKey, "claude-opus-4-8[1m]");
  registry.applyDriverEvent(id, {
    kind: "bound",
    agentSessionId: noteKey,
    transcriptPath: null,
    modelId: "claude-opus-4-8[1m]",
    pid: null,
  });

  // The export arrives first, with no driver row anywhere in the ledger for this key.
  registry.applyOtelMetrics({
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
                      asDouble: 0.42,
                      timeUnixNano: "1000000000000000012",
                      startTimeUnixNano: "1000000000000000011",
                      attributes: [
                        { key: "session.id", value: { stringValue: noteKey } },
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
  });
  assert.equal(sessionCostFor(noteKey), null, "the export for a driven key never lands");

  registry.applyDriverEvent(id, {
    ...TURN_DONE,
    usage: { ...TURN_DONE.usage!, turnId: "33333333-3333-4333-8333-333333333333" },
  });
  const cost = sessionCostFor(noteKey);
  assert.ok(cost, "the driver's report is what the card reads");
  assert.equal(cost.costUsd, 0.42, "and it is the only figure counted for that turn");
});

test("OTel remains the writer for a session no driver owns", () => {
  // The sessions this must not break: a `claude` a human started in a terminal, which Mission
  // Control discovered rather than launched. Nothing drives it, so its exporter is the only
  // party that can ever report its cost, and `sdkOwnedNoteKey` must not match it.
  const noteKey = "discovered-session-1";
  upsertUsageCell(
    {
      noteKey,
      sessionId: null,
      agent: "claude",
      modelId: "claude-opus-4-8[1m]",
      querySource: "main",
      windowEndNs: "1000000000000000009",
      ts: 9_000,
    },
    "costUsd",
    0.17,
  );
  const cost = sessionCostFor(noteKey);
  assert.ok(cost, "a discovered session's telemetry still lands");
  assert.equal(cost.costUsd, 0.17);
});
