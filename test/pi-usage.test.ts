import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PI_PRICE_VERSION, piUsage } from "../src/server/harness/pi/usage.ts";
import type { UsageCursor } from "../src/server/harness/types.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const initial: UsageCursor = { offset: 0, modelId: null, discardPartial: false, fileId: null };
const header = { type: "session", version: 3, id: "pi-conversation" };
const model = { type: "model_change", provider: "provider", modelId: "model" };
const usage = { input: 11, output: 22, cacheRead: 30, cacheWrite: 40, reasoning: 5, cost: { total: 0.123 } };
function assistant(id: string, values: object = usage) {
  return { type: "message", id, timestamp: "2026-09-10T12:00:00.000Z", message: { role: "assistant", usage: values } };
}
function jsonl(...records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}
function file(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-usage-"));
  dirs.push(dir);
  const path = join(dir, "session.jsonl");
  writeFileSync(path, contents);
  return path;
}

test("Pi usage keeps disjoint tiers, request identities, reported cost and the resumed model", () => {
  const path = file(jsonl(header, model,
    { type: "message", message: { role: "user", usage } }, assistant("one"),
    { type: "message", message: { role: "toolResult", usage } }, assistant("two")));
  const first = piUsage.read(path, initial, 100_000);
  assert.equal(first.sourceId, header.id);
  assert.equal(first.events.length, 2);
  assert.deepEqual(first.events[0], {
    identity: "one", ts: Date.parse("2026-09-10T12:00:00.000Z"), modelId: "provider/model",
    querySource: "main", input: 11, output: 22, cacheRead: 30, cacheWrite: 40,
    reasoningOutput: 5, vendorCostUsd: 0.123,
  });
  assert.notEqual(first.events[0]!.identity, first.events[1]!.identity);
  assert.deepEqual(piUsage.estimate(first.events[0]!), {
    costUsd: 0.123, pricingModel: "provider/model", pricingVersion: PI_PRICE_VERSION,
  });
  assert.deepEqual(piUsage.read(path, initial, 100_000).events, first.events, "stable on replay");
  appendFileSync(path, jsonl(assistant("three")));
  const next = piUsage.read(path, first.cursor, 100_000);
  assert.deepEqual(next.events.map((event) => [event.identity, event.modelId]), [["three", "provider/model"]]);
  appendFileSync(path, jsonl({ ...model, modelId: "other" }, assistant("four")));
  assert.equal(piUsage.read(path, next.cursor, 100_000).events[0]?.modelId, "provider/other");
  writeFileSync(path, jsonl(header));
  assert.equal(piUsage.read(path, next.cursor, 100_000).reset, true);
});

test("unknown versions and missing or incomplete headers cannot publish usage", () => {
  for (const head of [{ ...header, version: 4 }, { ...header, version: 2 }, {}, null]) {
    assert.deepEqual(piUsage.read(file(jsonl(head, model, assistant("one"))), initial, 100_000).events, []);
  }
  const path = file(JSON.stringify(header));
  const incomplete = piUsage.read(path, initial, 100_000);
  assert.equal(incomplete.sourceId, null);
  assert.equal(incomplete.cursor.offset, 0);
  appendFileSync(path, "\n" + jsonl(model, assistant("one")));
  assert.equal(piUsage.read(path, incomplete.cursor, 100_000).events.length, 1);
});

test("invalid tiers and records are skipped; invalid cost stays unpriced, zero remains known", () => {
  for (const tier of ["input", "output", "cacheRead", "cacheWrite", "reasoning"]) {
    for (const value of [-1, null, "3"]) {
      const path = file(jsonl(header, model, assistant("bad", { ...usage, [tier]: value }), assistant("good")));
      assert.deepEqual(piUsage.read(path, initial, 100_000).events.map((event) => event.identity), ["good"]);
    }
  }
  for (const total of [-1, null, "0", undefined, 0]) {
    const path = file(jsonl(header, model, assistant("cost", { ...usage, cost: { total } })));
    const event = piUsage.read(path, initial, 100_000).events[0]!;
    assert.equal(event.vendorCostUsd, total === 0 ? 0 : null);
    assert.equal(piUsage.estimate(event)?.costUsd ?? null, total === 0 ? 0 : null);
  }
  const path = file(jsonl(header, model) + 'null\n{broken\n' + jsonl(assistant("good")));
  assert.equal(piUsage.read(path, initial, 100_000).events.length, 1);
  const nonfinite = file(jsonl(header, model, assistant("bad")).replace('"input":11', '"input":1e999'));
  assert.equal(piUsage.read(nonfinite, initial, 100_000).events.length, 0);
});

test("partial and oversized records retain bounded forward progress", () => {
  const prefix = jsonl(header, model);
  const message = jsonl(assistant("partial"));
  const path = file(prefix + message.slice(0, 40));
  const first = piUsage.read(path, initial, 100_000);
  assert.equal(first.cursor.offset, Buffer.byteLength(prefix));
  appendFileSync(path, message.slice(40));
  assert.equal(piUsage.read(path, first.cursor, 100_000).events[0]?.identity, "partial");

  const big = file(prefix + jsonl({ type: "message", message: { role: "user", text: "x".repeat(2000) } }, assistant("after")));
  let cursor = initial;
  const events = [];
  for (let i = 0; i < 15; i++) {
    const read = piUsage.read(big, cursor, 512);
    cursor = read.cursor;
    events.push(...read.events);
    if (!read.more) break;
  }
  assert.deepEqual(events.map((event) => event.identity), ["after"]);
  assert.equal(cursor.discardPartial, false);
});

test("atomic replacement is refused without overwriting the durable file identity", () => {
  const content = jsonl(header, model, assistant("one"));
  const path = file(content);
  const first = piUsage.read(path, initial, 100_000);
  writeFileSync(`${path}.new`, content);
  renameSync(`${path}.new`, path);
  const read = piUsage.read(path, first.cursor, 100_000);
  assert.equal(read.reset, true);
  assert.deepEqual(read.cursor, first.cursor);
});
