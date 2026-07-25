import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake: an embedded session has TWO parties who can report what a turn cost,
// and only one of them may write it down.
//
// The subprocess is the operator's own `claude`, launched with the same OpenTelemetry
// environment `~/.claude/settings.json` installs for every session on the machine, so it
// emits the same usage metrics an interactive session does and the usage poller ingests
// them into the same ledger under the same note key. Separately, the driver watches its own
// message stream and sees a `result` frame carrying that turn's usage - which is why
// `SdkEvent.turn_done` can carry a `usage` field at all.
//
// Spending both is double-counting, and it is the kind that is invisible: nothing errors,
// the card just reads roughly twice what the session cost, and the fleet total does too.
// The rule the plan settles on is that the ledger has ONE writer per harness (OTel for
// Claude, the rollout reader for Codex) and both of them already see an embedded session's
// files - so the driver's figure is display enrichment and nothing else. This pins that the
// registry's `turn_done` handler does not write it.

const home = mkdtempSync(join(tmpdir(), "mission-sdk-cost-"));
process.env.MISSION_HOME = home;

const { openDb, sessionCostFor, upsertUsageCell, usageLedgerHasRows } = await import(
  "../src/server/db.ts"
);
const { Registry, SDK_SESSION_ID_PREFIX } = await import("../src/server/registry.ts");
import type { SdkEvent } from "../src/server/harness/types.ts";

after(() => rmSync(home, { recursive: true, force: true }));

openDb();

const ID = `${SDK_SESSION_ID_PREFIX}44444444-4444-4444-8444-444444444444`;
const AGENT_SESSION = "agent-cost-1";

/** A driver's `turn_done`, with the usage the SDK's `result` frame reports. */
const TURN_DONE: SdkEvent = {
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

test("a driver's turn usage never reaches the ledger", () => {
  const registry = new Registry();
  registry.registerSdkSession({ id: ID, agent: "claude", name: "embedded", cwd: "/repo" });
  registry.applyDriverEvent(ID, {
    kind: "bound",
    agentSessionId: AGENT_SESSION,
    transcriptPath: null,
    pid: null,
  });

  assert.equal(usageLedgerHasRows(), false, "nothing has reported usage yet");
  registry.applyDriverEvent(ID, TURN_DONE);
  registry.applyDriverEvent(ID, TURN_DONE);
  assert.equal(
    usageLedgerHasRows(),
    false,
    "the driver reported a turn's cost twice and neither may be spent",
  );
  assert.equal(sessionCostFor(AGENT_SESSION), null, "an unwritten cost reads as unknown, not zero");
});

test("the turn still ends the session's turn - the usage is what is withheld, not the event", () => {
  // The `turn_done` handler's job is the IDLE transition (the same fact a `Stop` hook
  // carries). Dropping the whole event to avoid the double-count would leave every embedded
  // session reading `working` for ever, which is the failure this must not trade for.
  const registry = new Registry();
  const id = `${SDK_SESSION_ID_PREFIX}55555555-5555-4555-8555-555555555555`;
  registry.registerSdkSession({ id, agent: "claude", name: "embedded", cwd: "/repo" });
  registry.applyDriverEvent(id, { kind: "state", state: "working", activity: "Editing" });
  assert.equal(registry.getSession(id)?.state, "working");
  registry.applyDriverEvent(id, TURN_DONE);
  assert.equal(registry.getSession(id)?.state, "idle");
});

test("the OTel ingest is the one writer, and an embedded session's cost reaches its card", () => {
  // The other half of the claim: withholding the driver's figure is only correct because the
  // subprocess's own telemetry still lands. It is keyed on the note key - `agentSessionId`
  // once bound - which is exactly what `bound` fills in, so the card reads the same field it
  // reads for a pane-backed session.
  const registry = new Registry();
  const id = `${SDK_SESSION_ID_PREFIX}66666666-6666-4666-8666-666666666666`;
  const noteKey = "agent-cost-2";
  registry.registerSdkSession({ id, agent: "claude", name: "embedded", cwd: "/repo" });
  registry.applyDriverEvent(id, {
    kind: "bound",
    agentSessionId: noteKey,
    transcriptPath: null,
    pid: null,
  });
  upsertUsageCell(
    {
      noteKey,
      sessionId: null,
      agent: "claude",
      modelId: "claude-opus-4-8[1m]",
      querySource: "main",
      windowEndNs: "1000000000000000002",
      ts: 2_000,
    },
    "costUsd",
    0.42,
  );
  registry.applyDriverEvent(id, TURN_DONE);
  const cost = sessionCostFor(noteKey);
  assert.ok(cost, "the subprocess's own telemetry is what the ledger holds");
  assert.equal(
    cost.costUsd,
    0.42,
    "exactly one report of this turn is spent, whatever the driver also observed",
  );
});
