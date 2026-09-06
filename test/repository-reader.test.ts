import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { RepositoryReader } from "../src/server/repository/reader.ts";
import type { RepositoryQueryAuditMetadata } from "../src/shared/repository-access.ts";
import { repositoryViewFixture } from "./helpers/repository-view.ts";

test("reader returns canonical line, raw-byte, and independent diff handles", async () => {
  const fixture = repositoryViewFixture();
  const audits: RepositoryQueryAuditMetadata[] = [];
  try {
    const reader = new RepositoryReader({
      descriptor: fixture.descriptor,
      identity: { workloadId: "workload-1", workflowAttemptId: "attempt-1" },
      budgets: { maxCalls: 20, maxAttemptBytes: 1024 * 1024, maxResponseBytes: 64 * 1024, maxAttemptMs: 60_000, maxItemsPerCall: 100, maxCallMs: 5_000 },
      cursorSecret: Buffer.alloc(32, 1),
      audit: { async append(metadata) { audits.push(metadata); } },
    });
    const line = await reader.execute({ operation: "read", path: "source.txt", layer: "worktree", window: { kind: "line", startLine: 2, maxLines: 1 } }, new AbortController().signal);
    assert.equal(line.status, "ok");
    assert.equal(line.items[0]?.kind, "text");
    if (line.items[0]?.kind === "text") assert.equal(line.items[0].text, "beta staged");
    assert.deepEqual(audits[0]?.handles[0]?.range, { kind: "line", startLine: 2, endLineExclusive: 3 });
    const bytes = await reader.execute({ operation: "read", path: "source.txt", layer: "index", window: { kind: "byte", startByte: 0, maxBytes: 5 } }, new AbortController().signal);
    assert.equal(bytes.items[0]?.kind, "text");
    if (bytes.items[0]?.kind === "text") assert.equal(bytes.items[0].text, "alpha");
    assert.deepEqual(audits[1]?.handles[0]?.range, { kind: "byte", startByte: 0, endByteExclusive: 5, encoding: "raw" });
    const diff = await reader.execute({ operation: "git_diff", layers: "head:worktree", paths: ["source.txt"] }, new AbortController().signal);
    assert.equal(diff.status, "ok");
    assert.equal(diff.items[0]?.kind, "diff");
    const range = audits[2]?.handles[0]?.range;
    assert.equal(range?.kind, "diff");
    if (range?.kind === "diff") {
      assert.ok(range.old.endLineExclusive >= range.old.startLine);
      assert.ok(range.new.endLineExclusive >= range.new.startLine);
    }
    assert.equal(new Set(audits.flatMap((audit) => audit.handles.map((handle) => handle.operationInstanceId))).size, 3);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("reader denies sensitive paths before content access and emits body-free audits", async () => {
  const fixture = repositoryViewFixture();
  const audits: RepositoryQueryAuditMetadata[] = [];
  try {
    assert.equal(existsSync(join(fixture.root, ".env")), false);
    const reader = new RepositoryReader({ descriptor: fixture.descriptor, identity: { workloadId: "w", workflowAttemptId: "a" }, budgets: { maxCalls: 8, maxAttemptBytes: 1024, maxResponseBytes: 1024, maxAttemptMs: 10_000, maxItemsPerCall: 10, maxCallMs: 1_000 }, audit: { async append(metadata) { audits.push(metadata); } } });
    const denied = await reader.execute({ operation: "read", path: ".env", layer: "worktree", window: { kind: "line", startLine: 1, maxLines: 5 } }, new AbortController().signal);
    assert.equal(denied.status, "denied");
    assert.equal(denied.code, "path_denied");
    assert.deepEqual(denied.items, []);
    assert.deepEqual(audits[0]?.handles, []);
    assert.doesNotMatch(JSON.stringify(audits[0]), /secret-that-must-not-leak|\.env/);
    const patch = await reader.execute({ operation: "git_diff", layers: "head:worktree", paths: [] }, new AbortController().signal);
    assert.equal(patch.code, "path_denied");
    assert.deepEqual(patch.items, []);
    assert.doesNotMatch(JSON.stringify(audits[1]), /secret-that-must-not-leak|\.env/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("reader cancellation and audit failure are fail-closed structured results", async () => {
  const fixture = repositoryViewFixture();
  try {
    const cancelledReader = new RepositoryReader({ descriptor: fixture.descriptor, identity: { workloadId: "w", workflowAttemptId: "a" }, budgets: { maxCalls: 8, maxAttemptBytes: 1024, maxResponseBytes: 1024, maxAttemptMs: 10_000, maxItemsPerCall: 10, maxCallMs: 1_000 }, audit: { async append() {} } });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const cancelled = await cancelledReader.execute({ operation: "glob", pattern: "**" }, controller.signal);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.code, "cancelled");

    const unauditedReader = new RepositoryReader({ descriptor: fixture.descriptor, identity: { workloadId: "w", workflowAttemptId: "a" }, budgets: { maxCalls: 8, maxAttemptBytes: 1024, maxResponseBytes: 1024, maxAttemptMs: 10_000, maxItemsPerCall: 10, maxCallMs: 1_000 }, audit: { async append() { throw new Error("sink unavailable"); } } });
    const unaudited = await unauditedReader.execute({ operation: "read", path: "source.txt", layer: "worktree", window: { kind: "line", startLine: 1, maxLines: 1 } }, new AbortController().signal);
    assert.equal(unaudited.status, "unavailable");
    assert.equal(unaudited.code, "audit_unavailable");
    assert.deepEqual(unaudited.items, []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("reader binds continuation cursors to the exact operation shape and snapshot", async () => {
  const fixture = repositoryViewFixture();
  try {
    const reader = new RepositoryReader({ descriptor: fixture.descriptor, identity: { workloadId: "w", workflowAttemptId: "a" }, budgets: { maxCalls: 8, maxAttemptBytes: 4096, maxResponseBytes: 4096, maxAttemptMs: 10_000, maxItemsPerCall: 1, maxCallMs: 1_000 }, cursorSecret: Buffer.alloc(32, 2), audit: { async append() {} } });
    const first = await reader.execute({ operation: "read", path: "source.txt", layer: "worktree", window: { kind: "line", startLine: 1, maxLines: 1 } }, new AbortController().signal);
    assert.ok(first.continuationCursor);
    const tampered = `${first.continuationCursor!.slice(0, -1)}x`;
    const result = await reader.execute({ operation: "read", path: "source.txt", layer: "worktree", window: { kind: "line", startLine: 1, maxLines: 1 }, cursor: tampered }, new AbortController().signal);
    assert.equal(result.code, "cursor_invalid");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("worktree reads fail closed when materialized bytes change after capture", async () => {
  const fixture = repositoryViewFixture();
  const audits: RepositoryQueryAuditMetadata[] = [];
  try {
    writeFileSync(join(fixture.root, "source.txt"), "changed after capture\n", "utf8");
    const reader = new RepositoryReader({
      descriptor: fixture.descriptor,
      identity: { workloadId: "w", workflowAttemptId: "a" },
      budgets: { maxCalls: 8, maxAttemptBytes: 4096, maxResponseBytes: 1024, maxAttemptMs: 10_000, maxItemsPerCall: 10, maxCallMs: 1_000 },
      audit: { async append(metadata) { audits.push(metadata); } },
    });

    const result = await reader.execute({ operation: "read", path: "source.txt", layer: "worktree", window: { kind: "line", startLine: 1, maxLines: 1 } }, new AbortController().signal);

    assert.equal(result.status, "unavailable");
    assert.equal(result.code, "view_unavailable");
    assert.deepEqual(result.items, []);
    assert.equal(result.continuationCursor, null);
    assert.deepEqual(audits[0]?.handles, []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("line windows fail when no complete line fits the response budget", async () => {
  const fixture = repositoryViewFixture();
  try {
    const reader = new RepositoryReader({
      descriptor: fixture.descriptor,
      identity: { workloadId: "w", workflowAttemptId: "a" },
      budgets: { maxCalls: 8, maxAttemptBytes: 4096, maxResponseBytes: 10, maxAttemptMs: 10_000, maxItemsPerCall: 10, maxCallMs: 1_000 },
      cursorSecret: Buffer.alloc(32, 4),
      audit: { async append() {} },
    });

    const result = await reader.execute({ operation: "read", path: "source.txt", layer: "worktree", window: { kind: "line", startLine: 2, maxLines: 1 } }, new AbortController().signal);

    assert.equal(result.status, "unavailable");
    assert.equal(result.code, "response_too_large");
    assert.deepEqual(result.items, []);
    assert.equal(result.continuationCursor, null);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("search returns a byte-bounded progressing page without collecting later matches", async () => {
  const fixture = repositoryViewFixture();
  try {
    const content = "hit\n".repeat(3_000);
    writeFileSync(join(fixture.root, "source.txt"), content, "utf8");
    const worktreeObjectId = createHash("sha1")
      .update(`blob ${Buffer.byteLength(content)}\0`)
      .update(content)
      .digest("hex");
    const descriptor = {
      ...fixture.descriptor,
      entries: fixture.descriptor.entries.map((entry) => (
        entry.path === "source.txt" ? { ...entry, worktreeObjectId } : entry
      )),
    };
    const reader = new RepositoryReader({
      descriptor,
      identity: { workloadId: "w", workflowAttemptId: "a" },
      budgets: { maxCalls: 8, maxAttemptBytes: 64 * 1024, maxResponseBytes: 4_096, maxAttemptMs: 10_000, maxItemsPerCall: 100_000, maxCallMs: 1_000 },
      cursorSecret: Buffer.alloc(32, 5),
      audit: { async append() {} },
    });
    const controller = new AbortController();
    setImmediate(() => setImmediate(() => setImmediate(() => controller.abort())));

    const first = await reader.execute({
      operation: "search",
      literal: "hit",
      caseSensitive: true,
      paths: [],
      globs: [],
      contextLines: 0,
    }, controller.signal);

    assert.equal(first.status, "ok");
    assert.equal(first.truncationReason, "bytes");
    assert.ok(first.byteCount <= 4_096);
    assert.ok(first.continuationCursor);
    const lastItem = first.items.at(-1);
    assert.equal(lastItem?.kind, "text");
    const lastRange = lastItem?.kind === "text" ? lastItem.range : null;
    assert.equal(lastRange?.kind, "line");

    const second = await reader.execute({
      operation: "search",
      literal: "hit",
      caseSensitive: true,
      paths: [],
      globs: [],
      contextLines: 0,
      cursor: first.continuationCursor!,
    }, new AbortController().signal);
    assert.equal(second.status, "ok");
    const firstItem = second.items[0];
    assert.equal(firstItem?.kind, "text");
    const firstRange = firstItem?.kind === "text" ? firstItem.range : null;
    assert.equal(firstRange?.kind, "line");
    if (lastRange?.kind === "line" && firstRange?.kind === "line") {
      assert.equal(firstRange.startLine, lastRange.endLineExclusive);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
