import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RepositoryJsonlAuditSink } from "../src/server/repository/jsonl-audit.ts";
import type { RepositoryQueryAuditMetadata } from "../src/shared/repository-access.ts";

function audit(operationInstanceId: string): RepositoryQueryAuditMetadata {
  return {
    operationInstanceId,
    operation: "read",
    normalizedInputHash: "a".repeat(64),
    status: "ok",
    failureCode: null,
    byteCount: 1,
    itemCount: 1,
    truncated: false,
    durationMs: 1,
    handles: [],
  };
}

test("repository JSONL audit sink serializes concurrent complete records", async () => {
  const records: string[] = [];
  let active = 0;
  let maximumActive = 0;
  const sink = new RepositoryJsonlAuditSink("unused", async (_path, record) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    records.push(record);
    active -= 1;
  });

  await Promise.all(Array.from({ length: 32 }, (_, index) => (
    sink.append(audit(`operation-${index}`), new AbortController().signal)
  )));

  assert.equal(maximumActive, 1);
  assert.equal(records.length, 32);
  assert.equal(records.every((record) => record.endsWith("\n") && record.indexOf("\n") === record.length - 1), true);
  assert.deepEqual(records.map((record) => JSON.parse(record).operationInstanceId), Array.from({ length: 32 }, (_, index) => `operation-${index}`));
});

test("repository JSONL audit sink writes a parseable concurrent journal", async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-repository-audit-test-"));
  const path = join(root, "audit.jsonl");
  try {
    const sink = new RepositoryJsonlAuditSink(path);
    await Promise.all(Array.from({ length: 64 }, (_, index) => (
      sink.append(audit(`operation-${index}`), new AbortController().signal)
    )));

    const records = (await readFile(path, "utf8")).trimEnd().split("\n");
    assert.equal(records.length, 64);
    assert.deepEqual(records.map((record) => JSON.parse(record).operationInstanceId), Array.from({ length: 64 }, (_, index) => `operation-${index}`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository JSONL audit sink skips queued cancellation and finishes an active record", async () => {
  const records: string[] = [];
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const sink = new RepositoryJsonlAuditSink("unused", async (_path, record) => {
    markFirstStarted();
    await firstReleased;
    records.push(record);
  });
  const activeController = new AbortController();
  const active = sink.append(audit("active"), activeController.signal);
  await firstStarted;
  activeController.abort();
  const queuedController = new AbortController();
  const queued = sink.append(audit("queued"), queuedController.signal);
  queuedController.abort();
  releaseFirst();

  await active;
  await assert.rejects(queued, { name: "AbortError" });
  assert.deepEqual(records.map((record) => JSON.parse(record).operationInstanceId), ["active"]);
  assert.equal(records[0]?.endsWith("\n"), true);
});
