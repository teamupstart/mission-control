import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findRolloutForSession,
  readHeadLine,
  parseRolloutMeta,
  parseRolloutRateLimits,
  parseSessionMeta,
  readRolloutPassive,
} from "../src/server/harness/codex/rollout.ts";
import type { Session } from "@shared/types.ts";

// Records shaped like real Codex rollout JSONL lines.
const sessionMeta = (cwd: string, ts: string): string =>
  JSON.stringify({ timestamp: ts, type: "session_meta", payload: { id: "x", timestamp: ts, cwd, cli_version: "1", source: "cli", thread_source: "user" } });
const turnContext = (model: string, effort: string | null, timestamp = "t"): string =>
  JSON.stringify({ timestamp, type: "turn_context", payload: { model, effort } });
const tokenCount = (current: number, window: number, cumulative = current): string =>
  JSON.stringify({
    timestamp: "t",
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: { total_tokens: cumulative }, last_token_usage: { total_tokens: current }, model_context_window: window } },
  });

test("parseSessionMeta reads cwd + start, rejects other records", () => {
  assert.deepEqual(parseSessionMeta(sessionMeta("/repo/app", "2026-07-12T10:00:00.000Z")), {
    cwd: "/repo/app",
    start: Date.parse("2026-07-12T10:00:00.000Z"),
    sessionId: "x",
    subagent: false,
  });
  assert.equal(parseSessionMeta(turnContext("gpt-5-codex", "high")), null);
  assert.equal(parseSessionMeta("{not json"), null);
  assert.equal(parseSessionMeta(null), null);
});

test("readHeadLine preserves a real-sized session header with embedded instructions", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-head-"));
  const path = join(root, "rollout.jsonl");
  const header = JSON.stringify({
    timestamp: "2026-07-12T10:00:00.000Z",
    type: "session_meta",
    payload: { id: "large", cwd: "/repo/app", source: "cli", base_instructions: { text: "x".repeat(24_000) } },
  });
  writeFileSync(path, `${header}\n${turnContext("gpt-5", "high")}\n`);
  assert.equal(readHeadLine(path), header);
  assert.equal(parseSessionMeta(readHeadLine(path))?.sessionId, "large");
});

test("parseRolloutMeta derives model, effort, and context% from the newest records", () => {
  const m = parseRolloutMeta([
    sessionMeta("/repo/app", "2026-07-12T10:00:00.000Z"),
    turnContext("gpt-5-codex", "high"),
    tokenCount(129_200, 258_400),
  ]);
  assert.deepEqual(m, {
    modelId: "gpt-5-codex",
    contextTokens: 129_200,
    contextWindow: 258_400,
    contextPct: 50,
    longContext: false,
    thinkingLevel: "high",
    effortRevision: "t",
  });
});

test("parseRolloutMeta uses the newest turn_context + token_count", () => {
  const m = parseRolloutMeta([
    turnContext("gpt-5", "low", "turn-1"),
    tokenCount(10, 100),
    turnContext("gpt-5-codex", "xhigh", "turn-2"), // newer
    tokenCount(60, 100), // newer
  ]);
  assert.equal(m?.modelId, "gpt-5-codex");
  assert.equal(m?.thinkingLevel, "xhigh");
  assert.equal(m?.effortRevision, "turn-2");
  assert.equal(m?.contextPct, 60);
});

test("context uses current-turn usage, not cumulative usage, and can reset after clear", () => {
  assert.equal(parseRolloutMeta([tokenCount(155_944, 258_400, 8_873_454)])?.contextPct, 60);
  assert.equal(parseRolloutMeta([tokenCount(420, 258_400, 8_873_874)])?.contextPct, 0);
});

test("passive reads retain Codex model and effort after they leave the tail window", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-meta-tail-"));
  const path = join(root, "rollout.jsonl");
  writeFileSync(path, [
    sessionMeta("/repo/app", "2026-07-12T10:00:00.000Z"),
    turnContext("gpt-5.6-sol", "medium"),
    JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "x".repeat(300_000) } }),
    tokenCount(25_840, 258_400),
  ].join("\n") + "\n");

  const meta = readRolloutPassive(path).meta;
  assert.equal(meta?.modelId, "gpt-5.6-sol");
  assert.equal(meta?.thinkingLevel, "medium");
  assert.equal(meta?.contextPct, 10);
});

test("Codex rate limits retain their declared duration and source", () => {
  const line = JSON.stringify({
    timestamp: "2026-07-21T19:15:00.000Z", type: "event_msg", payload: {
      type: "token_count", info: {}, rate_limits: {
        primary: { used_percent: 9, window_minutes: 10080, resets_at: 1785258595 }, secondary: null,
      },
    },
  });
  assert.deepEqual(parseRolloutRateLimits([line]), {
    source: "codex", updatedAt: Date.parse("2026-07-21T19:15:00.000Z"),
    windows: [{ id: "primary", label: "1-week", durationMinutes: 10080, usedPercentage: 9, resetsAt: 1785258595 }],
  });
});

test("parseRolloutMeta normalizes effort variants and handles emptiness", () => {
  assert.equal(parseRolloutMeta([turnContext("gpt-5", "minimal")])?.thinkingLevel, "low");
  assert.equal(parseRolloutMeta([turnContext("gpt-5", "ultra")])?.thinkingLevel, "max");
  assert.equal(parseRolloutMeta([turnContext("gpt-5", "bogus")])?.thinkingLevel, null);
  assert.equal(parseRolloutMeta(["", "{}"]), null);
});

// ---- findRolloutForSession (filesystem) ----

const codexSession = (over: Partial<Session>): Session =>
  ({ agent: "codex", cwd: "/repo/app", startedAt: null, ...over }) as Session;

function seedRollouts(): string {
  const root = mkdtempSync(join(tmpdir(), "codex-sess-"));
  const day = join(root, "2026", "07", "12");
  mkdirSync(day, { recursive: true });
  writeFileSync(
    join(day, "rollout-2026-07-12T09-00-00-aaa.jsonl"),
    sessionMeta("/repo/app", "2026-07-12T09:00:00.000Z") + "\n" + turnContext("gpt-5-codex", "high") + "\n",
  );
  writeFileSync(
    join(day, "rollout-2026-07-12T10-00-00-bbb.jsonl"),
    sessionMeta("/other/repo", "2026-07-12T10:00:00.000Z") + "\n",
  );
  writeFileSync(
    join(day, "rollout-2026-07-12T11-00-00-ccc.jsonl"),
    sessionMeta("/repo/app", "2026-07-12T11:00:00.000Z") + "\n",
  );
  return root;
}

test("findRolloutForSession matches cwd and the nearest start time", () => {
  const root = seedRollouts();
  // startedAt near the 11:00 rollout -> that one, not the 09:00 same-cwd sibling.
  const s = codexSession({ cwd: "/repo/app", startedAt: Date.parse("2026-07-12T10:59:45.000Z") });
  assert.equal(findRolloutForSession(s, root), join(root, "2026", "07", "12", "rollout-2026-07-12T11-00-00-ccc.jsonl"));
});

test("findRolloutForSession rejects a newer same-cwd guardian subagent rollout", () => {
  const root = seedRollouts();
  const day = join(root, "2026", "07", "12");
  const guardian = join(day, "rollout-2026-07-12T11-01-00-guardian.jsonl");
  writeFileSync(guardian, JSON.stringify({
    timestamp: "2026-07-12T11:00:11.000Z",
    type: "session_meta",
    payload: {
      id: "guardian", session_id: "parent", cwd: "/repo/app",
      timestamp: "2026-07-12T11:00:11.000Z",
      source: { subagent: { other: "guardian" } }, thread_source: "subagent",
    },
  }) + "\n");
  const s = codexSession({ cwd: "/repo/app", startedAt: Date.parse("2026-07-12T11:00:10.000Z") });
  assert.equal(findRolloutForSession(s, root), join(day, "rollout-2026-07-12T11-00-00-ccc.jsonl"));
});

test("fallback refuses a same-cwd rollout minted long after process start by clear", () => {
  const root = seedRollouts();
  const s = codexSession({ cwd: "/repo/app", startedAt: Date.parse("2026-07-12T10:00:00.000Z") });
  // Nearest interactive candidates are an hour away in either direction. With two live
  // processes in this cwd, selecting either would put one session's cleared context on both.
  assert.equal(findRolloutForSession(s, root), null);
});

// It used to also assert that a `claude` session got null from here. That check moved
// UP, to `HARNESSES` (`harness/index.ts`): which reader runs is the registry's decision
// now, so a rollout scan is unreachable for a Claude session and a guard restating it
// inside this function would be the agent hardcode the migration removed. What is left is
// what this function actually decides - whether a rollout matches.
test("findRolloutForSession returns null when no rollout matches the cwd", () => {
  const root = seedRollouts();
  assert.equal(findRolloutForSession(codexSession({ cwd: "/nowhere", startedAt: 0 }), root), null);
  assert.equal(findRolloutForSession(codexSession({ cwd: null }), root), null);
});
