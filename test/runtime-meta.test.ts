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

function recordBaseline(
  r: InstanceType<typeof Registry>,
  revision: string | null,
): boolean {
  return r.recordRuntimeEffortBaseline("s1", revision, r.getSession("s1")!);
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

test("an orderable later passive revision reconciles an independently changed effort", () => {
  const r = seeded();
  r.applyRuntimeMeta(
    "s1",
    { ...transcriptRead, effortRevision: "2026-07-22T12:00:00.000Z" },
    "transcript",
  );
  r.recordObservedSessionEffort("s1", "xhigh");
  r.applyRuntimeMeta(
    "s1",
    {
      ...transcriptRead,
      thinkingLevel: "medium",
      effortRevision: "2026-07-22T12:00:01.000Z",
    },
    "transcript",
  );
  assert.equal(metaOf(r)?.thinkingLevel, "medium");
});

test("an orderable confirmation releases the observation to later passive metadata", () => {
  const r = seeded();
  r.applyRuntimeMeta(
    "s1",
    { ...transcriptRead, effortRevision: "2026-07-22T12:00:00.000Z" },
    "transcript",
  );
  r.recordObservedSessionEffort("s1", "xhigh");
  r.applyRuntimeMeta(
    "s1",
    {
      ...transcriptRead,
      thinkingLevel: "xhigh",
      effortRevision: "2026-07-22T12:00:01.000Z",
    },
    "transcript",
  );
  r.applyRuntimeMeta(
    "s1",
    { ...transcriptRead, effortRevision: "2026-07-22T12:00:02.000Z" },
    "transcript",
  );
  assert.equal(metaOf(r)?.thinkingLevel, "high");
});

test("an opaque passive revision cannot overwrite a verified effort change", () => {
  const r = seeded();
  r.applyRuntimeMeta(
    "s1",
    { ...transcriptRead, effortRevision: "4ed47a6b-8d93-4b80-af8d-7ebaf442b32a" },
    "transcript",
  );
  r.recordObservedSessionEffort("s1", "xhigh");
  r.applyRuntimeMeta(
    "s1",
    {
      ...transcriptRead,
      modelId: "claude-opus-4-8",
      thinkingLevel: "high",
      effortRevision: "abdf4e48-5097-46d2-9e72-e8e111a97870",
    },
    "transcript",
  );
  assert.equal(metaOf(r)?.thinkingLevel, "xhigh");
  assert.equal(metaOf(r)?.modelId, "claude-sonnet-5");
});

test("a new agent session releases the prior session's observed effort", () => {
  const r = seeded();
  r.applyStatusLine(statusIngest({ effort: "high" }));
  recordBaseline(r, null);
  r.recordObservedSessionEffort("s1", "xhigh");
  r.applyStatusLine(statusIngest({ sessionId: "new-session", effort: "high" }));
  assert.equal(metaOf(r)?.thinkingLevel, "high");
});

test("only a timestamped post-change statusLine overrides an observed effort", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 2_000 });
  const r = seeded();
  r.applyStatusLine(statusIngest({ effort: "high", ts: 1_000 }));
  recordBaseline(r, null);
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
  assert.equal(metaOf(r)?.thinkingLevel, "xhigh");
});

test("out-of-order statusLine metadata cannot regress a confirmed effort", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 2_000 });
  const r = seeded();
  r.applyStatusLine(statusIngest({ effort: "high", ts: 1_000 }));
  recordBaseline(r, null);
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
  recordBaseline(r, null);
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
  assert.equal(metaOf(r)?.thinkingLevel, "xhigh");

  r.applyStatusLine(statusIngest({ effort: "xhigh", ts: undefined }));
  assert.equal(metaOf(r)?.thinkingLevel, "xhigh");
  r.applyStatusLine(statusIngest({ effort: "xhigh", ts: 2_100 }));
  assert.equal(metaOf(r)?.thinkingLevel, "xhigh");
});

test("an observed effort requires a synchronously captured passive baseline", () => {
  const r = seeded();
  r.applyStatusLine(statusIngest({ effort: "high", ts: 1_000 }));
  assert.equal(r.recordObservedSessionEffort("s1", "xhigh"), false);
  assert.equal(metaOf(r)?.thinkingLevel, "high");

  recordBaseline(r, "2026-07-22T12:00:00.000Z");
  assert.equal(r.recordObservedSessionEffort("s1", "xhigh"), true);
  r.applyRuntimeMeta(
    "s1",
    {
      ...transcriptRead,
      modelId: "claude-opus-4-8",
      thinkingLevel: "high",
      effortRevision: "2026-07-22T12:00:00.000Z",
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
      effortRevision: "2026-07-22T12:00:01.000Z",
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

  assert.equal(r.recordRuntimeEffortBaseline("s1", "old-baseline", expected), false);
  assert.equal(rebound.effortBaselineReady, false);
  assert.equal(recordBaseline(r, "new-baseline"), true);
  assert.equal(r.recordObservedSessionEffort("s1", "xhigh", expected), false);
  assert.equal(metaOf(r)?.thinkingLevel, "high");
});

// ---- an accepted level the conversation has not run yet ----
//
// Codex's driver puts `effort` on `turn/start`; `turn/steer` has no such field. So a level
// chosen while a turn is running is a promise about the NEXT turn, and every rollout read
// until then describes the turn that is going - correctly, with the old level. These pin
// what that projection is defended against and what retires it.

const codexRead = (
  thinkingLevel: "high" | "xhigh" | "max",
  effortRevision: string,
  over: Partial<RuntimeMetaRead> = {},
): RuntimeMetaRead => ({
  modelId: "gpt-5.6-sol",
  contextTokens: 20_000,
  contextWindow: 258_400,
  contextPct: 8,
  longContext: false,
  thinkingLevel,
  effortRevision,
  ...over,
});

function pendingSeeded(): InstanceType<typeof Registry> {
  const r = new Registry();
  r.applyDiscovery([disco({ agent: "codex", agentSessionId: "thread-1", transcriptPath: "/tmp/roll.jsonl" })]);
  r.applyRuntimeMeta("s1", codexRead("high", "2026-07-25T12:00:01.000Z"), "codex-rollout");
  recordBaseline(r, "2026-07-25T12:00:01.000Z");
  assert.equal(r.recordPendingSessionEffort("s1", "max", r.getSession("s1")!), true);
  assert.equal(r.getSession("s1")?.pendingEffort, "max");
  return r;
}

test("a pending effort is not a claim about the running turn", () => {
  const r = pendingSeeded();
  // The card keeps reporting the level the conversation is ACTUALLY on. That is the whole
  // reason this is a second field and not a write to `meta.thinkingLevel`.
  assert.equal(metaOf(r)?.thinkingLevel, "high");
});

test("a pending effort survives the running turn's own newer metadata", () => {
  const r = pendingSeeded();
  // Same `turn_context` behind every one of these; only the usage moved. `updatedAt`
  // advances on each, which is exactly what used to drop the selection.
  for (const pct of [11, 17, 24]) {
    r.applyRuntimeMeta("s1", codexRead("high", "2026-07-25T12:00:01.000Z", { contextPct: pct }), "codex-rollout");
    assert.equal(r.getSession("s1")?.pendingEffort, "max", `context ${pct}%`);
  }
  // An UNORDERABLE revision is not evidence either - a harness whose revisions are opaque
  // record ids can never prove a turn started, so it must not be able to retire one.
  r.applyRuntimeMeta("s1", codexRead("high", "turn-uuid-9"), "codex-rollout");
  assert.equal(r.getSession("s1")?.pendingEffort, "max");
});

test("the next turn_context settles a pending effort, kept or not", () => {
  const kept = pendingSeeded();
  kept.applyRuntimeMeta("s1", codexRead("max", "2026-07-25T12:09:00.000Z"), "codex-rollout");
  assert.equal(kept.getSession("s1")?.pendingEffort, null);
  assert.equal(metaOf(kept)?.thinkingLevel, "max");

  const broken = pendingSeeded();
  broken.applyRuntimeMeta("s1", codexRead("xhigh", "2026-07-25T12:09:00.000Z"), "codex-rollout");
  assert.equal(broken.getSession("s1")?.pendingEffort, null, "a turn ran and did not take it");
  assert.equal(metaOf(broken)?.thinkingLevel, "xhigh");
});

test("a model change retires a pending effort without waiting for a turn", () => {
  const r = pendingSeeded();
  // Levels are a fact about the model - `levelsFor` narrows them per model id - so a
  // promise made for the old one says nothing about the new one.
  r.applyRuntimeMeta(
    "s1",
    codexRead("high", "2026-07-25T12:00:01.000Z", { modelId: "gpt-5.6-luna" }),
    "codex-rollout",
  );
  assert.equal(r.getSession("s1")?.pendingEffort, null);
});

test("a rebind and a context clear each drop a pending effort", () => {
  const rebound = pendingSeeded();
  rebound.applyStatus({ tmuxPane: "%3" }, "thread-2", "rebound");
  assert.equal(rebound.getSession("s1")?.pendingEffort, null);
  // ...and it does not come back on the next read of the NEW conversation.
  rebound.applyRuntimeMeta("s1", codexRead("high", "2026-07-25T12:00:01.000Z"), "codex-rollout");
  assert.equal(rebound.getSession("s1")?.pendingEffort, null);

  const cleared = pendingSeeded();
  cleared.clearObservedSessionEffort("s1");
  assert.equal(cleared.getSession("s1")?.pendingEffort, null);
  assert.equal(cleared.getSession("s1")?.effortBaselineReady, false);
});

test("choosing back the level the conversation is on retires a pending effort", () => {
  const r = pendingSeeded();
  assert.equal(r.recordPendingSessionEffort("s1", "high", r.getSession("s1")!), true);
  assert.equal(r.getSession("s1")?.pendingEffort, null, "nothing is left for a next turn to change");
});

test("a pending effort is refused when the session moved under the caller", () => {
  const r = pendingSeeded();
  const stale = { agentSessionId: "thread-0", transcriptPath: "/tmp/roll.jsonl" };
  assert.equal(r.recordPendingSessionEffort("s1", "xhigh", stale), false);
  assert.equal(r.getSession("s1")?.pendingEffort, "max", "the earlier selection is untouched");
  assert.equal(r.recordPendingSessionEffort("gone", "xhigh"), false);
});

test("a pending effort change emits the session, so the chip is not waiting on a poll", () => {
  const r = pendingSeeded();
  const seen: string[] = [];
  r.on("event", (e: ServerEvent) => {
    if (e.type === "session_upsert" && e.session.id === "s1") seen.push(String(e.session.pendingEffort));
  });
  r.recordPendingSessionEffort("s1", "xhigh", r.getSession("s1")!);
  assert.deepEqual(seen, ["xhigh"]);
  // Idempotent: recording the same selection again changes nothing and says nothing.
  r.recordPendingSessionEffort("s1", "xhigh", r.getSession("s1")!);
  assert.deepEqual(seen, ["xhigh"]);
  r.applyRuntimeMeta("s1", codexRead("xhigh", "2026-07-25T12:09:00.000Z"), "codex-rollout");
  assert.deepEqual(seen, ["xhigh", "null"]);
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
