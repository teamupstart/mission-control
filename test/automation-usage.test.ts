import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake: the two subsystems that spend tokens with nobody asking them to were
// the two whose cost nothing could see.
//
// `usage_ledger` is keyed on a session, and a headless run has none. So Foreman and
// Inspector spend reached it either not at all (a `codex exec --ephemeral` run exports
// nothing and writes no rollout file for the usage poller to read) or as an orphan row
// under a uuid belonging to no card (`claude -p` still exports OTel, under the fresh
// session id every run mints). The first is invisible; the second is worse, because it was
// silently counted as SESSION spend - the fleet total included the app's own overhead and
// no drill-down could find it.
//
// These tests hold the shape of the fix: a run lands under its ROLE, reads back per role,
// stays out of the fleet's session figures, survives a retried report without doubling, and
// takes its OTel twin out of the session total with it.

const home = mkdtempSync(join(tmpdir(), "mission-automation-usage-"));
process.env.MISSION_HOME = home;

const {
  openDb,
  automationEstimatedCostSince,
  automationSpendSince,
  automationTokensSince,
  fleetEstimatedCostSince,
  fleetTokensSince,
  recordAutomationUsage,
  sessionCostFor,
  upsertUsageCell,
} = await import("../src/server/db.ts");
const { recordSpendReport } = await import("../src/server/spend-ledger.ts");

after(() => rmSync(home, { recursive: true, force: true }));

openDb();

const T0 = 1_700_000_000_000;

/** One priced model row, as a runner would have valued it. */
function model(over: Partial<Parameters<typeof recordAutomationUsage>[0]["models"][number]> = {}) {
  return {
    modelId: "gpt-5.6-terra",
    input: 1_000,
    output: 200,
    reasoningOutput: 50,
    cacheRead: 300,
    cacheWrite: 100,
    costUsd: 0.5,
    basis: "api-equivalent",
    pricingVersion: "openai-standard-2026-07-22",
    ...over,
  };
}

test("a headless run lands under its role and reads back per role", () => {
  recordAutomationUsage({
    role: "foreman:review",
    agent: "codex",
    runId: "run-review-1",
    ts: T0,
    models: [model()],
  });
  recordAutomationUsage({
    role: "inspector:review",
    agent: "codex",
    runId: "run-inspector-1",
    ts: T0 + 1,
    models: [model({ costUsd: 2 })],
  });

  const spend = automationSpendSince(T0 - 1);
  // Ordered by cost, so the heaviest role is the one an operator reads first.
  assert.deepEqual(
    spend.map((r) => [r.role, r.costUsd, r.runs]),
    [["inspector:review", 2, 1], ["foreman:review", 0.5, 1]],
  );
  // Every tier summed, reasoning excluded from the token total exactly as `fleetTokensSince`
  // sums it - reasoning tokens are already inside `output`.
  assert.equal(spend[0]!.tokens, 1_600);
  assert.equal(automationEstimatedCostSince(T0 - 1), 2.5);
  assert.equal(automationTokensSince(T0 - 1), 3_200);
});

test("role spend stays out of the fleet's session figures", () => {
  // The decision this locks in: automation is a separate line, not part of the fleet total.
  // Session cost is work an operator asked for; this is the overhead of watching it, and it
  // moves while nobody is asking for anything.
  assert.equal(fleetEstimatedCostSince(T0 - 1), 0);
  assert.equal(fleetTokensSince(T0 - 1), 0);

  upsertUsageCell(
    {
      noteKey: "a-real-card",
      sessionId: null,
      agent: "claude",
      modelId: "claude-opus-5",
      querySource: "main",
      windowEndNs: "1700000000000000001",
      ts: T0 + 2,
    },
    "costUsd",
    7,
  );
  assert.equal(fleetEstimatedCostSince(T0 - 1), 7, "a card's spend still counts");
  assert.equal(automationEstimatedCostSince(T0 - 1), 2.5, "and did not leak into automation");
});

test("a role key is never mistaken for a card", () => {
  // `sessionCostFor` is the per-card read. A role is not a card, and asking for one must
  // report the same "never heard of it" a missing session does rather than the loop's bill.
  assert.equal(sessionCostFor("foreman:review"), null);
});

test("a retried report records the run once", () => {
  const before = automationEstimatedCostSince(T0 - 1);
  // Not `?? 0`: everything recorded so far is priced, so a null here would mean the
  // unpriced rule had fired early and the delta below would be measuring the wrong thing.
  assert.notEqual(before, null);
  // The Foreman worker POSTs this over HTTP and retries what it cannot confirm. The run id
  // is the dedup identity, so the second arrival must change nothing at all.
  for (let i = 0; i < 3; i++) {
    recordAutomationUsage({
      role: "foreman:verify",
      agent: "codex",
      runId: "run-verify-1",
      ts: T0 + 3,
      models: [model({ costUsd: 1.25 })],
    });
  }
  assert.equal(automationEstimatedCostSince(T0 - 1), before! + 1.25);
  const verify = automationSpendSince(T0 - 1).find((r) => r.role === "foreman:verify");
  assert.equal(verify?.runs, 1);
});

test("an unpriced model refuses to report a subtotal as a total", () => {
  recordAutomationUsage({
    role: "foreman:backlog",
    agent: "codex",
    runId: "run-backlog-1",
    ts: T0 + 4,
    models: [model({ modelId: "gpt-未来", costUsd: null, basis: "unpriced", pricingVersion: "" })],
  });
  const backlog = automationSpendSince(T0 - 1).find((r) => r.role === "foreman:backlog");
  assert.equal(backlog?.costUsd, null, "the role's own cost is unknown");
  assert.equal(backlog?.tokens, 1_600, "but its tokens are still counted");
  assert.equal(
    automationEstimatedCostSince(T0 - 1),
    null,
    "and the automation total refuses to present the priced rows as complete",
  );
});

test("a claude run's OTel twin leaves the session total with it", () => {
  // A headless `claude -p` is Claude Code, so it exports OTel like any session, under the
  // fresh uuid it minted for itself. Those datapoints carry a real `session.id`, so the
  // ingest accepts them and they land as an ordinary session row keyed to a card that does
  // not exist. Recording the same run under its role as well would bill it twice.
  const twinUuid = "11111111-2222-3333-4444-555555555555";
  const sessionCostBefore = fleetEstimatedCostSince(T0 + 90);
  upsertUsageCell(
    {
      noteKey: twinUuid,
      sessionId: null,
      agent: "claude",
      modelId: "claude-opus-5",
      querySource: "main",
      windowEndNs: "1700000000000000002",
      ts: T0 + 100,
    },
    "costUsd",
    3,
  );
  assert.equal(
    fleetEstimatedCostSince(T0 + 90),
    (sessionCostBefore ?? 0) + 3,
    "before we know better, the orphan reads as session spend",
  );

  // Now the run itself reports. `window_end_ns` holds the run id, which IS the note key its
  // twin arrived under - so the exclusion is exact rather than a prefix guess, and it works
  // whichever of the two arrived first.
  recordAutomationUsage({
    role: "inspector:reply",
    agent: "claude",
    runId: twinUuid,
    ts: T0 + 101,
    models: [model({ costUsd: 3, basis: "reported" })],
  });
  assert.equal(
    fleetEstimatedCostSince(T0 + 90),
    sessionCostBefore ?? 0,
    "once the run is attributed, its twin stops counting as a card's spend",
  );
  assert.equal(
    automationSpendSince(T0 + 90).find((r) => r.role === "inspector:reply")?.costUsd,
    3,
    "and it is counted exactly once, as automation",
  );
});

test("a report is priced by its own runner before it is written", () => {
  // The worker reports TOKENS; the daemon values them. This is the seam where that happens,
  // and the figure has to come from the same versioned snapshot an interactive Codex
  // session is priced against rather than from a second table.
  const written = recordSpendReport({
    role: "foreman:triage",
    runner: "codex",
    runId: "run-triage-1",
    ts: T0 + 200,
    models: [{
      modelId: "gpt-5.6-luna",
      input: 1_000_000,
      output: 0,
      reasoningOutput: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reportedCostUsd: null,
    }],
  });
  assert.equal(written.kind, "recorded", "the report was recorded");
  const triage = automationSpendSince(T0 + 199).find((r) => r.role === "foreman:triage");
  // gpt-5.6-luna is $0.20/M input, doubled past the 272k long-context threshold - so 1M input
  // tokens is $0.40, not $0.20. Asserting the doubled figure is the point: it proves the real
  // snapshot's rules are being applied rather than a flat rate reimplemented here.
  assert.equal(triage?.costUsd, 0.4);
});

test("a claude report keeps the cost the provider itself calculated", () => {
  recordSpendReport({
    role: "foreman:triage",
    runner: "claude",
    runId: "run-triage-2",
    ts: T0 + 201,
    models: [{
      modelId: "claude-haiku-4-5-20251001",
      input: 9,
      output: 40,
      reasoningOutput: 0,
      cacheRead: 0,
      cacheWrite: 6_661,
      reportedCostUsd: 0.013531,
    }],
  });
  const rows = openDb()
    .prepare(
      `SELECT cost_usd, cost_basis, spend_kind FROM usage_ledger WHERE window_end_ns = ?`,
    )
    .all("run-triage-2") as unknown as Array<{ cost_usd: number; cost_basis: string; spend_kind: string }>;
  assert.equal(rows.length, 1);
  // `reported` rather than `api-equivalent`: Claude Code did the arithmetic from rates this
  // repo does not hold, and the ledger records which of the two estimators was used.
  assert.equal(rows[0]!.cost_basis, "reported");
  assert.equal(rows[0]!.spend_kind, "automation");
  assert.equal(rows[0]!.cost_usd, 0.013531);
});

test("a run that spent nothing is not recorded at all", () => {
  const before = automationSpendSince(T0 - 1).length;
  const written = recordSpendReport({
    role: "inspector:review",
    runner: "codex",
    runId: "run-empty",
    ts: T0 + 300,
    models: [{
      modelId: "gpt-5.6-terra",
      input: 0,
      output: 0,
      reasoningOutput: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reportedCostUsd: null,
    }],
  });
  // "empty" rather than a refusal: there is no spend to lose, so the sender should forget
  // it rather than hold it for a recovery that has nothing to recover.
  assert.equal(written.kind, "empty", "a zero-token run is the shape of a call that never happened");
  assert.equal(automationSpendSince(T0 - 1).length, before);
});

test("a run with no id is dropped rather than recorded unattributably", () => {
  // Without a run id there is no dedup identity, so a retry would double-count. Losing one
  // row is the cheaper mistake, and the only one that cannot corrupt a total.
  const written = recordSpendReport({
    role: "inspector:review",
    runner: "codex",
    runId: "",
    ts: T0 + 301,
    models: [{
      modelId: "gpt-5.6-terra",
      input: 10,
      output: 10,
      reasoningOutput: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reportedCostUsd: null,
    }],
  });
  // "empty" for the same reason a zero-token run is: without a run id there is no dedup
  // identity, so recording it could double-count on any retry. The worker already filters
  // these before sending, so acknowledging is right - there is nothing to hold on to.
  assert.equal(written.kind, "empty");
});

test("a runner this build cannot value is refused, not silently accepted", () => {
  // The mirror of the worker-side rule. This daemon has no pricing for a runner a newer
  // worker might name, so the run cannot become a ledger row - and saying "empty" or
  // acknowledging it would have the worker delete its durable copy of spend that never
  // landed. It has to be an explicit refusal so the sender keeps the run.
  const written = recordSpendReport({
    role: "foreman:review",
    runner: "some-future-runner",
    runId: "run-from-the-future",
    ts: T0 + 400,
    models: [{
      modelId: "future-model",
      input: 1_000,
      output: 100,
      reasoningOutput: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reportedCostUsd: null,
    }],
  });
  assert.equal(written.kind, "unsupported");
  assert.match(
    written.kind === "unsupported" ? written.reason : "",
    /unknown runner/,
    "and it says why, so the refusal is diagnosable",
  );
  assert.equal(
    automationSpendSince(T0 + 399).length,
    0,
    "nothing was written for a report this build cannot price",
  );
});
