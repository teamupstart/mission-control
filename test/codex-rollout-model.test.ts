// A bounded tail must never turn an older model in the rollout head into the current one.
import assert from "node:assert/strict";
import fs, { appendFileSync, mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readRolloutMeta, retainRolloutMeta } from "../src/server/harness/codex/rollout.ts";
import { codexTranscript } from "../src/server/harness/codex/transcript.ts";
import { mkSession } from "./helpers/session-fixture.ts";

const turn = (model: string, effort: string, timestamp: string) =>
  JSON.stringify({ type: "turn_context", timestamp, payload: { model, effort } }) + "\n";
const output = JSON.stringify({ type: "response_item", payload: { text: "x".repeat(300_000) } }) + "\n";
const tokens = JSON.stringify({ type: "event_msg", payload: {
  type: "token_count", info: { last_token_usage: { total_tokens: 100 }, model_context_window: 1000 },
} }) + "\n";

for (const [older, newer] of [
  ["gpt-5.6-sol", "gpt-6.1-sol"],
  ["gpt-5.6-terra", "gpt-6.1-terra"],
  ["custom-model-old", "custom-model-new"],
]) {
  for (const warm of [false, true]) {
    test(`${warm ? "warm" : "cold"} rollout reads keep ${newer} when its turn leaves the tail`, (t) => {
      const dir = mkdtempSync(join(tmpdir(), "codex-model-"));
      t.after(() => { retainRolloutMeta(new Set()); rmSync(dir, { recursive: true, force: true }); });
      const path = join(dir, "rollout.jsonl");
      writeFileSync(path, turn(older!, "medium", "2026-10-28T10:00:00Z") + output);
      if (warm) assert.equal(readRolloutMeta(path)?.modelId, older);
      // The change and a large tool result arrive between polls. Neither the bounded
      // head nor the bounded tail contains the newest turn_context.
      appendFileSync(path, turn(newer!, "high", "2026-10-28T11:00:00Z") + output + tokens);
      const meta = readRolloutMeta(path);
      assert.equal(meta?.modelId, newer);
      assert.equal(meta?.thinkingLevel, "high");
      assert.equal(meta?.effortRevision, "2026-10-28T11:00:00Z");
      assert.equal(meta?.contextPct, 10);
    });
  }
}

test("bound rollout paths keep verified model evidence through the poller's retention pass", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "codex-bound-model-"));
  t.after(() => { codexTranscript.retain!(new Set()); rmSync(dir, { recursive: true, force: true }); });
  const path = join(dir, "rollout.jsonl");
  const session = mkSession({ id: "sdk:bound-model", agent: "codex", runtime: "sdk",
    cwd: dir, agentSessionId: "bound-thread", transcriptPath: path });
  writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id: "bound-thread", cwd: dir } }) + "\n" +
    turn("gpt-6.1-sol", "high", "latest"));
  // Grow past the cold-read budget in small, fully observed increments. The SDK
  // binding must retain its cache just as a discovered terminal binding does.
  for (let i = 0; i < 30; i++) {
    expectBound();
    appendFileSync(path, output + output + tokens);
  }
  expectBound();
  function expectBound(): void {
    assert.equal(codexTranscript.locate(session), path);
    assert.equal(codexTranscript.passiveRead(path).meta?.modelId, "gpt-6.1-sol");
    codexTranscript.retain!(new Set([session.id]));
  }
});

test("rollout replacement, truncation, and disappearance cannot reuse another file's model", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "codex-replaced-model-"));
  t.after(() => { retainRolloutMeta(new Set()); rmSync(dir, { recursive: true, force: true }); });
  const path = join(dir, "rollout.jsonl");
  writeFileSync(path, turn("gpt-6.1-sol", "high", "old") + output);
  assert.equal(readRolloutMeta(path)?.modelId, "gpt-6.1-sol");
  writeFileSync(join(dir, "replacement"), turn("gpt-6.1-terra", "low", "new") + output + output + tokens);
  renameSync(join(dir, "replacement"), path);
  assert.equal(readRolloutMeta(path)?.modelId, "gpt-6.1-terra");
  writeFileSync(path, tokens);
  assert.equal(readRolloutMeta(path)?.modelId, null);
  rmSync(path);
  assert.equal(readRolloutMeta(path), null);
});

test("a split turn record is retried, and an explicit move to an older model is respected", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "codex-split-model-"));
  t.after(() => { retainRolloutMeta(new Set()); rmSync(dir, { recursive: true, force: true }); });
  const path = join(dir, "rollout.jsonl");
  const next = turn("gpt-5.6-sol", "low", "new");
  writeFileSync(path, turn("gpt-6.1-sol", "high", "old") + next.slice(0, -5));
  assert.equal(readRolloutMeta(path)?.modelId, "gpt-6.1-sol");
  appendFileSync(path, next.slice(-5) + output + tokens);
  assert.equal(readRolloutMeta(path)?.modelId, "gpt-5.6-sol");
});

test("an in-place rewrite with unchanged size invalidates the cached model", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "codex-rewritten-model-"));
  t.after(() => { retainRolloutMeta(new Set()); rmSync(dir, { recursive: true, force: true }); });
  const path = join(dir, "rollout.jsonl");
  writeFileSync(path, turn("gpt-5.6-sol", "high", "old") + output + tokens);
  utimesSync(path, 1, 1);
  const before = statSync(path);
  assert.equal(readRolloutMeta(path)?.modelId, "gpt-5.6-sol");
  // Keep the new turn outside the initial tail, so a stale cache would hide it.
  writeFileSync(path, turn("gpt-6.1-sol", "high", "new") + output + tokens);
  utimesSync(path, 2, 2);
  const after = statSync(path);
  assert.equal(after.ino, before.ino);
  assert.equal(after.size, before.size);
  assert.notEqual(after.mtimeMs, before.mtimeMs);
  assert.equal(readRolloutMeta(path)?.modelId, "gpt-6.1-sol");
});

test("an unobserved gap beyond the scan budget stays unknown without rescanning history on each append", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "codex-bounded-model-"));
  t.after(() => { retainRolloutMeta(new Set()); rmSync(dir, { recursive: true, force: true }); });
  const path = join(dir, "rollout.jsonl");
  writeFileSync(path, turn("gpt-5.6-sol", "medium", "old"));
  assert.equal(readRolloutMeta(path)?.modelId, "gpt-5.6-sol");
  appendFileSync(path, turn("gpt-6.1-sol", "high", "new") + output.repeat(60) + tokens);
  assert.equal(readRolloutMeta(path)?.modelId, null);
  assert.equal(readRolloutMeta(path)?.modelId, null, "unchanged unreadable history stays unknown");
  // Observe actual file I/O rather than elapsed time: small appends should only
  // read the live tail, even when the cached model is unknown.
  const reads = t.mock.method(fs, "readSync");
  syncBuiltinESMExports();
  try {
    for (let i = 0; i < 3; i++) {
      reads.mock.resetCalls();
      appendFileSync(path, tokens);
      assert.equal(readRolloutMeta(path)?.modelId, null);
      const bytesRead = reads.mock.calls.reduce((sum, call) => sum + call.result!, 0);
      t.diagnostic(`Unknown-model append ${i + 1}: ${bytesRead} bytes read`);
      assert.ok(bytesRead > 0 && bytesRead <= 128 * 1024, `small append read ${bytesRead} bytes`);
    }
  } finally {
    reads.mock.restore();
    syncBuiltinESMExports();
  }
  const next = turn("gpt-6.1-terra", "medium", "newest");
  appendFileSync(path, next.slice(0, -5));
  assert.equal(readRolloutMeta(path)?.modelId, null);
  appendFileSync(path, next.slice(-5) + output + tokens);
  assert.equal(readRolloutMeta(path)?.modelId, "gpt-6.1-terra");
});
