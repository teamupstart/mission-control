import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findRolloutForSession,
  parseRolloutMeta,
  parseSessionMeta,
} from "../src/server/harness/codex/rollout.ts";
import type { Session } from "@shared/types.ts";

// Records shaped like real Codex rollout JSONL lines.
const sessionMeta = (cwd: string, ts: string): string =>
  JSON.stringify({ timestamp: ts, type: "session_meta", payload: { id: "x", timestamp: ts, cwd, cli_version: "1" } });
const turnContext = (model: string, effort: string | null): string =>
  JSON.stringify({ timestamp: "t", type: "turn_context", payload: { model, effort } });
const tokenCount = (total: number, window: number): string =>
  JSON.stringify({
    timestamp: "t",
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: { total_tokens: total }, model_context_window: window } },
  });

test("parseSessionMeta reads cwd + start, rejects other records", () => {
  assert.deepEqual(parseSessionMeta(sessionMeta("/repo/app", "2026-07-12T10:00:00.000Z")), {
    cwd: "/repo/app",
    start: Date.parse("2026-07-12T10:00:00.000Z"),
  });
  assert.equal(parseSessionMeta(turnContext("gpt-5-codex", "high")), null);
  assert.equal(parseSessionMeta("{not json"), null);
  assert.equal(parseSessionMeta(null), null);
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
  });
});

test("parseRolloutMeta uses the newest turn_context + token_count", () => {
  const m = parseRolloutMeta([
    turnContext("gpt-5", "low"),
    tokenCount(10, 100),
    turnContext("gpt-5-codex", "xhigh"), // newer
    tokenCount(60, 100), // newer
  ]);
  assert.equal(m?.modelId, "gpt-5-codex");
  assert.equal(m?.thinkingLevel, "xhigh");
  assert.equal(m?.contextPct, 60);
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
  const s = codexSession({ cwd: "/repo/app", startedAt: Date.parse("2026-07-12T10:59:00.000Z") });
  assert.equal(findRolloutForSession(s, root), join(root, "2026", "07", "12", "rollout-2026-07-12T11-00-00-ccc.jsonl"));
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
