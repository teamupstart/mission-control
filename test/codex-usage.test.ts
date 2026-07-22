import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexUsage } from "../src/server/harness/codex/usage.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function file(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "codex-usage-"));
  dirs.push(dir);
  const path = join(dir, "rollout.jsonl");
  writeFileSync(path, contents);
  return path;
}

const turn = JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol" } });
const token = JSON.stringify({
  timestamp: "2026-07-22T12:00:00.000Z",
  type: "event_msg",
  payload: { type: "token_count", info: { last_token_usage: {
    input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 10,
    output_tokens: 12, reasoning_output_tokens: 4,
  } } },
});

test("reads request deltas, carries the model, and splits every input tier", () => {
  const path = file(`${turn}\n${token}\n`);
  const read = readCodexUsage(path, { offset: 0, modelId: null, discardPartial: false }, 1024 * 1024);
  assert.equal(read.reset, false);
  assert.equal(read.events.length, 1);
  assert.deepEqual(
    { ...read.events[0], identity: "stable" },
    {
      identity: "stable", ts: Date.parse("2026-07-22T12:00:00.000Z"),
      modelId: "gpt-5.6-sol", querySource: "main", input: 70, cacheRead: 20,
      cacheWrite: 10, output: 12, reasoningOutput: 4,
    },
  );
  assert.equal(read.cursor.modelId, "gpt-5.6-sol");
  assert.equal(read.cursor.offset, Buffer.byteLength(`${turn}\n${token}\n`));
});

test("does not advance across an incomplete final record", () => {
  const complete = `${turn}\n`;
  const path = file(`${complete}${token.slice(0, 30)}`);
  const read = readCodexUsage(path, { offset: 0, modelId: null, discardPartial: false }, 1024 * 1024);
  assert.equal(read.events.length, 0);
  assert.equal(read.cursor.offset, Buffer.byteLength(complete));
});

test("the same exact record has the same replay identity", () => {
  const path = file(`${turn}\n${token}\n`);
  const cursor = { offset: Buffer.byteLength(`${turn}\n`), modelId: "gpt-5.6-sol", discardPartial: false };
  const a = readCodexUsage(path, cursor, 1024);
  const b = readCodexUsage(path, cursor, 1024);
  assert.equal(a.events[0]?.identity, b.events[0]?.identity);
});

test("malformed and negative usage records are skipped without aborting the stream", () => {
  const bad = token.replace('"output_tokens":12', '"output_tokens":-1');
  const path = file(`not-json\n${turn}\n${bad}\n${token}\n`);
  const read = readCodexUsage(path, { offset: 0, modelId: null, discardPartial: false }, 1024 * 1024);
  assert.equal(read.events.length, 1);
});

test("usage whose cache tiers exceed total input is skipped", () => {
  const inconsistent = token.replace(
    '"cached_input_tokens":20,"cache_write_input_tokens":10',
    '"cached_input_tokens":80,"cache_write_input_tokens":30',
  );
  const path = file(`${turn}\n${inconsistent}\n${token}\n`);
  const read = readCodexUsage(path, { offset: 0, modelId: null, discardPartial: false }, 1024 * 1024);
  assert.equal(read.events.length, 1);
  assert.equal(read.events[0]?.input, 70);
});

test("a shorter file is surfaced as a reset rather than silently replayed", () => {
  const path = file(`${turn}\n`);
  const read = readCodexUsage(path, { offset: 10_000, modelId: "gpt-5.6-sol", discardPartial: false }, 1024);
  assert.equal(read.reset, true);
  assert.equal(read.cursor.offset, 10_000);
});

test("an oversized non-usage record is skipped without stranding later token usage", () => {
  const oversized = JSON.stringify({ type: "response_item", payload: { text: "x".repeat(1_200) } });
  const path = file(`${turn}\n${oversized}\n${token}\n`);
  let cursor = { offset: 0, modelId: null as string | null, discardPartial: false };
  const events = [];
  for (let i = 0; i < 10; i += 1) {
    const read = readCodexUsage(path, cursor, 512);
    events.push(...read.events);
    cursor = read.cursor;
    if (!read.more) break;
  }
  assert.equal(events.length, 1);
  assert.equal(events[0]?.modelId, "gpt-5.6-sol");
  assert.equal(cursor.offset, Buffer.byteLength(`${turn}\n${oversized}\n${token}\n`));
  assert.equal(cursor.discardPartial, false);
});
