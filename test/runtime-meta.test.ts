import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { RuntimeMetaRead } from "../src/server/harness/types.ts";
import type { Session, ServerEvent } from "@shared/types.ts";
import type { StatusLineIngest } from "@shared/protocol.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

// Isolate the daemon's SQLite DB before anything reads config/db.
process.env.HARNESS_HOME = mkdtempSync(join(tmpdir(), "harness-meta-"));
const { Registry } = await import("../src/server/registry.ts");

const PANE = mkMuxHandle({ session: "w", windowName: "w", paneId: "%3" });

function disco(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    syntheticId: "s1",
    agent: "claude",
    name: "n",
    nameSource: "tmux",
    cwd: "/repo/app",
    gitBranch: "main",
    gitRoot: null,
    repoRoot: null,
    nomistakesGated: false,
    pid: 1,
    tty: "ttys1",
    terminals: [PANE],
    startedAt: 0,
    ...over,
  };
}

function seeded(): InstanceType<typeof Registry> {
  const r = new Registry();
  r.applyDiscovery([disco()]);
  return r;
}

function metaOf(r: InstanceType<typeof Registry>, id = "s1"): Session["meta"] {
  return r.snapshot().sessions.find((s) => s.id === id)?.meta ?? null;
}

const statusIngest = (over: Partial<StatusLineIngest> = {}): StatusLineIngest =>
  ({
    env: { tmuxPane: "%3" },
    sessionId: "abc",
    model: { id: "claude-opus-4-8", displayName: "Opus" },
    contextWindow: { usedPercentage: 34, contextWindowSize: 200_000, tokens: 68_000 },
    effort: "xhigh",
    thinkingEnabled: true,
    ...over,
  }) as StatusLineIngest;

const transcriptRead: RuntimeMetaRead = {
  modelId: "claude-sonnet-5",
  contextTokens: 20_000,
  contextWindow: 200_000,
  contextPct: 10,
  longContext: false,
  thinkingLevel: "high",
  effortRevision: "turn-1",
};

test("applyStatusLine populates meta on the bound session (exact %, effort, model)", () => {
  const r = seeded();
  r.applyStatusLine(statusIngest());
  const m = metaOf(r);
  assert.equal(m?.model, "Opus 4.8");
  assert.equal(m?.thinkingLevel, "xhigh");
  assert.equal(m?.thinkingEnabled, true);
  assert.equal(m?.contextPct, 34);
  assert.equal(m?.contextTokens, 68_000);
  assert.equal(m?.longContext, false);
  assert.equal(m?.source, "statusline");
});

test("applyStatusLine recovers a 1M window when size is absent but tokens exceed 200k", () => {
  const r = seeded();
  // No contextWindowSize and no usedPercentage from Claude - only raw tokens, over
  // 200k on a marker-less id. The window must floor up to 1M, not the 200k default.
  r.applyStatusLine(
    statusIngest({
      model: { id: "claude-opus-4-8", displayName: "Opus" },
      contextWindow: { tokens: 490_000 },
    }),
  );
  const m = metaOf(r);
  assert.equal(m?.contextWindow, 1_000_000);
  assert.equal(m?.contextPct, 49);
  assert.equal(m?.longContext, true);
});

test("applyRuntimeMeta populates meta from a passive transcript read", () => {
  const r = seeded();
  r.applyRuntimeMeta("s1", transcriptRead, "transcript");
  const m = metaOf(r);
  assert.equal(m?.model, "Sonnet 5");
  assert.equal(m?.contextPct, 10);
  assert.equal(m?.thinkingLevel, "high");
  assert.equal(m?.source, "transcript");
});

test("a fresh statusLine reading outranks a passive transcript read", () => {
  const r = seeded();
  r.applyStatusLine(statusIngest());
  r.applyRuntimeMeta("s1", transcriptRead, "transcript"); // must NOT clobber
  const m = metaOf(r);
  assert.equal(m?.source, "statusline");
  assert.equal(m?.model, "Opus 4.8");
  assert.equal(m?.contextPct, 34);
});

test("a null passive read is a no-op (never clears a good reading)", () => {
  const r = seeded();
  r.applyRuntimeMeta("s1", transcriptRead, "transcript");
  r.applyRuntimeMeta("s1", null, "transcript");
  assert.equal(metaOf(r)?.model, "Sonnet 5");
});

test("an observed session effort emits immediately and survives stale passive metadata", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const r = seeded();
  r.applyRuntimeMeta("s1", transcriptRead, "transcript");
  let observed = 0;
  r.subscribe((e: ServerEvent) => {
    if (e.type === "session_upsert" && e.session.meta?.thinkingLevel === "xhigh") observed++;
  });

  r.recordObservedSessionEffort("s1", "xhigh");
  const recordedAt = metaOf(r)!.updatedAt;
  assert.equal(metaOf(r)?.thinkingLevel, "xhigh");
  assert.equal(observed, 1);

  t.mock.timers.tick(60_000);
  r.applyRuntimeMeta("s1", transcriptRead, "transcript");
  assert.equal(metaOf(r)?.thinkingLevel, "xhigh");
  assert.ok(metaOf(r)!.updatedAt >= recordedAt);
});

test("passive metadata reconciles an independently changed effort", () => {
  const r = seeded();
  r.applyRuntimeMeta("s1", transcriptRead, "transcript");
  r.recordObservedSessionEffort("s1", "xhigh");
  r.applyRuntimeMeta(
    "s1",
    { ...transcriptRead, thinkingLevel: "medium", effortRevision: "turn-2" },
    "transcript",
  );
  assert.equal(metaOf(r)?.thinkingLevel, "medium");
});

test("a confirmed effort releases the observation to later passive metadata", () => {
  const r = seeded();
  r.applyRuntimeMeta("s1", transcriptRead, "transcript");
  r.recordObservedSessionEffort("s1", "xhigh");
  r.applyRuntimeMeta(
    "s1",
    { ...transcriptRead, thinkingLevel: "xhigh", effortRevision: "turn-2" },
    "transcript",
  );
  r.applyRuntimeMeta("s1", { ...transcriptRead, effortRevision: "turn-3" }, "transcript");
  assert.equal(metaOf(r)?.thinkingLevel, "high");
});

test("a newer passive revision publishes a native return to the prior effort", () => {
  const r = seeded();
  r.applyRuntimeMeta("s1", transcriptRead, "transcript");
  r.recordObservedSessionEffort("s1", "xhigh");
  r.applyRuntimeMeta(
    "s1",
    {
      ...transcriptRead,
      modelId: "claude-opus-4-8",
      thinkingLevel: "high",
      effortRevision: "turn-2",
    },
    "transcript",
  );
  assert.equal(metaOf(r)?.thinkingLevel, "high");
});

test("a new agent session releases the prior session's observed effort", () => {
  const r = seeded();
  r.applyStatusLine(statusIngest({ effort: "high" }));
  r.recordRuntimeEffortBaseline("s1", null);
  r.recordObservedSessionEffort("s1", "xhigh");
  r.applyStatusLine(statusIngest({ sessionId: "new-session", effort: "high" }));
  assert.equal(metaOf(r)?.thinkingLevel, "high");
});

test("only a timestamped post-change statusLine overrides an observed effort", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 2_000 });
  const r = seeded();
  r.applyStatusLine(statusIngest({ effort: "high", ts: 1_000 }));
  r.recordRuntimeEffortBaseline("s1", null);
  const acceptedAt = metaOf(r)!.updatedAt;
  r.recordObservedSessionEffort("s1", "xhigh");

  t.mock.timers.tick(100);
  r.applyStatusLine(statusIngest({ effort: "high", ts: 1_500 }));
  assert.equal(metaOf(r)?.thinkingLevel, "xhigh");
  assert.equal(metaOf(r)?.updatedAt, acceptedAt);
  t.mock.timers.tick(100);
  r.applyStatusLine(statusIngest({ effort: "high", ts: undefined }));
  assert.equal(metaOf(r)?.thinkingLevel, "xhigh");
  assert.equal(metaOf(r)?.updatedAt, acceptedAt);

  r.applyRuntimeMeta(
    "s1",
    { ...transcriptRead, thinkingLevel: "high", effortRevision: "turn-2" },
    "transcript",
  );
  assert.equal(metaOf(r)?.thinkingLevel, "high");
});

test("out-of-order statusLine metadata cannot regress a confirmed effort", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 2_000 });
  const r = seeded();
  r.applyStatusLine(statusIngest({ effort: "high", ts: 1_000 }));
  r.recordRuntimeEffortBaseline("s1", null);
  r.recordObservedSessionEffort("s1", "xhigh");

  r.applyStatusLine(statusIngest({ effort: "xhigh", ts: 2_001 }));
  assert.equal(metaOf(r)?.thinkingLevel, "xhigh");
  const confirmedAt = metaOf(r)!.updatedAt;

  t.mock.timers.tick(100);
  r.applyStatusLine(
    statusIngest({
      effort: "high",
      model: { id: "claude-sonnet-4-6", displayName: "Sonnet" },
      ts: 1_500,
    }),
  );
  assert.equal(metaOf(r)?.thinkingLevel, "xhigh");
  assert.equal(metaOf(r)?.model, "Opus 4.8");
  assert.equal(metaOf(r)?.updatedAt, confirmedAt);
});

test("unversioned statusLine effort stays guarded after confirmation", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 2_000 });
  const r = seeded();
  r.applyStatusLine(statusIngest({ effort: "high", ts: 1_000 }));
  r.recordRuntimeEffortBaseline("s1", null);
  r.recordObservedSessionEffort("s1", "xhigh");
  r.applyStatusLine(statusIngest({ effort: "xhigh", ts: 2_001 }));

  r.applyStatusLine(
    statusIngest({
      contextWindow: { usedPercentage: 55, contextWindowSize: 200_000, tokens: 110_000 },
      effort: "high",
      ts: undefined,
    }),
  );
  assert.equal(metaOf(r)?.thinkingLevel, "xhigh");
  assert.equal(metaOf(r)?.contextPct, 55);

  r.applyRuntimeMeta(
    "s1",
    {
      ...transcriptRead,
      modelId: "claude-opus-4-8",
      thinkingLevel: "high",
      effortRevision: "turn-2",
    },
    "transcript",
  );
  assert.equal(metaOf(r)?.thinkingLevel, "high");

  r.applyStatusLine(statusIngest({ effort: "xhigh", ts: undefined }));
  assert.equal(metaOf(r)?.thinkingLevel, "high");
  r.applyStatusLine(statusIngest({ effort: "xhigh", ts: 2_100 }));
  assert.equal(metaOf(r)?.thinkingLevel, "xhigh");
});

test("an observed effort requires a synchronously captured passive baseline", () => {
  const r = seeded();
  r.applyStatusLine(statusIngest({ effort: "high", ts: 1_000 }));
  assert.equal(r.recordObservedSessionEffort("s1", "xhigh"), false);
  assert.equal(metaOf(r)?.thinkingLevel, "high");

  r.recordRuntimeEffortBaseline("s1", "old-record");
  assert.equal(r.recordObservedSessionEffort("s1", "xhigh"), true);
  r.applyRuntimeMeta(
    "s1",
    {
      ...transcriptRead,
      modelId: "claude-opus-4-8",
      thinkingLevel: "high",
      effortRevision: "old-record",
    },
    "transcript",
  );
  assert.equal(metaOf(r)?.thinkingLevel, "xhigh");

  r.applyRuntimeMeta(
    "s1",
    {
      ...transcriptRead,
      modelId: "claude-opus-4-8",
      thinkingLevel: "high",
      effortRevision: "new-record",
    },
    "transcript",
  );
  assert.equal(metaOf(r)?.thinkingLevel, "high");
});

test("an agent-session rebind clears effort state before new metadata arrives", () => {
  const r = seeded();
  r.applyRuntimeMeta("s1", transcriptRead, "transcript");
  r.recordObservedSessionEffort("s1", "xhigh");

  r.applyStatus({ tmuxPane: "%3" }, "new-session", "rebound");
  assert.equal(metaOf(r)?.thinkingLevel, null);

  r.applyRuntimeMeta("s1", transcriptRead, "transcript");
  assert.equal(metaOf(r)?.thinkingLevel, "high");
});

test("a rebind clears transcript baseline identity before publication", () => {
  const r = new Registry();
  r.applyDiscovery([
    disco({
      agentSessionId: "old-session",
      transcriptPath: "/tmp/old-session.jsonl",
    }),
  ]);
  r.applyRuntimeMeta("s1", transcriptRead, "transcript");
  const expected = r.getSession("s1")!;
  assert.equal(expected.effortBaselineReady, true);

  r.applyStatusLine(statusIngest({ sessionId: "new-session", effort: "high" }));
  const rebound = r.getSession("s1")!;
  assert.equal(rebound.transcriptPath, null);
  assert.equal(rebound.effortBaselineReady, false);

  assert.equal(r.recordRuntimeEffortBaseline("s1", "new-baseline"), true);
  assert.equal(r.recordObservedSessionEffort("s1", "xhigh", expected), false);
  assert.equal(metaOf(r)?.thinkingLevel, "high");
});

test("meta only emits when a displayed value actually changes", () => {
  const r = seeded();
  let upserts = 0;
  r.subscribe((e: ServerEvent) => {
    if (e.type === "session_upsert") upserts++;
  });
  r.applyStatusLine(statusIngest()); // change -> 1 emit
  r.applyStatusLine(statusIngest()); // identical -> no emit
  assert.equal(upserts, 1);
});

test("passive Codex quota is source-scoped in the fleet snapshot", () => {
  const r = seeded();
  r.applyPassiveRateLimits({
    source: "codex", updatedAt: Date.now(),
    windows: [{ id: "primary", label: "1-week", durationMinutes: 10080, usedPercentage: 9, resetsAt: Date.now() / 1000 + 86400 }],
  });
  assert.deepEqual(r.snapshot().fleetCost?.rateLimitSources?.map((s) => s.source), ["codex"]);
  assert.equal(r.snapshot().fleetCost?.rateLimitSources?.[0]?.windows[0]?.usedPercentage, 9);
});
