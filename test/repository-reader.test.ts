import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { RepositoryReader } from "../src/server/repository/reader.ts";
import type { RepositoryQueryAuditMetadata } from "../src/shared/repository-access.ts";
import { repositoryViewFixture } from "./helpers/repository-view.ts";

function fixtureGit(root: string, args: string[]): string {
  return execFileSync("git", [
    "-c", "commit.gpgsign=false",
    "-c", `core.hooksPath=${join(root, ".hooks-disabled")}`,
    "-C", root,
    ...args,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(root, ".gitconfig-disabled"),
      GIT_TERMINAL_PROMPT: "0",
    },
  }).trim();
}

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

test("byte windows reserve response space for the item envelope and return a progressing page", async () => {
  const fixture = repositoryViewFixture();
  try {
    const content = `${"é".repeat(300)}\n`;
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
      budgets: { maxCalls: 8, maxAttemptBytes: 4096, maxResponseBytes: 256, maxAttemptMs: 10_000, maxItemsPerCall: 10, maxCallMs: 1_000 },
      cursorSecret: Buffer.alloc(32, 7),
      audit: { async append() {} },
    });

    const result = await reader.execute({ operation: "read", path: "source.txt", layer: "worktree", window: { kind: "byte", startByte: 0, maxBytes: 256 } }, new AbortController().signal);

    assert.equal(result.status, "ok");
    assert.equal(result.truncationReason, "bytes");
    assert.ok(result.byteCount <= 256);
    assert.ok(result.continuationCursor);
    assert.equal(result.items[0]?.kind, "text");
    if (result.items[0]?.kind === "text") {
      assert.equal(result.items[0].range.kind, "byte");
      if (result.items[0].range.kind === "byte") {
        assert.ok(result.items[0].range.endByteExclusive > 0);
        assert.equal(result.items[0].range.endByteExclusive % 2, 0);
      }
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("in-flight repository calls cannot outlive the remaining attempt deadline", async () => {
  const fixture = repositoryViewFixture();
  let nowCalls = 0;
  try {
    const reader = new RepositoryReader({
      descriptor: fixture.descriptor,
      identity: { workloadId: "w", workflowAttemptId: "a" },
      budgets: { maxCalls: 8, maxAttemptBytes: 4096, maxResponseBytes: 4096, maxAttemptMs: 1_000, maxItemsPerCall: 10, maxCallMs: 5_000 },
      now: () => nowCalls++ === 0 ? 0 : 999,
      audit: { async append() {} },
    });

    const result = await reader.execute({ operation: "git_show", revision: fixture.descriptor.headRevision, patch: false, paths: [] }, new AbortController().signal);

    assert.equal(result.status, "cancelled");
    assert.equal(result.code, "deadline_exceeded");
    assert.deepEqual(result.items, []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("non-Git repository calls preserve internal deadline expiry", async () => {
  const fixture = repositoryViewFixture();
  try {
    const sourceEntry = fixture.descriptor.entries.find((entry) => entry.path === "source.txt")!;
    const reader = new RepositoryReader({
      descriptor: {
        ...fixture.descriptor,
        entries: Array.from({ length: 20_000 }, (_, index) => ({
          ...sourceEntry,
          path: `file-${index.toString().padStart(5, "0")}.txt`,
        })),
      },
      identity: { workloadId: "w", workflowAttemptId: "a" },
      budgets: { maxCalls: 8, maxAttemptBytes: 64 * 1024, maxResponseBytes: 64 * 1024, maxAttemptMs: 10_000, maxItemsPerCall: 20_000, maxCallMs: 1 },
      audit: { async append() {} },
    });

    const result = await reader.execute({ operation: "glob", pattern: "**" }, new AbortController().signal);

    assert.equal(result.status, "cancelled");
    assert.equal(result.code, "deadline_exceeded");
    assert.deepEqual(result.items, []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("worktree reads cannot return success after the absolute attempt deadline", async () => {
  const fixture = repositoryViewFixture();
  let nowCalls = 0;
  try {
    const reader = new RepositoryReader({
      descriptor: fixture.descriptor,
      identity: { workloadId: "w", workflowAttemptId: "a" },
      budgets: { maxCalls: 8, maxAttemptBytes: 4096, maxResponseBytes: 4096, maxAttemptMs: 1_000, maxItemsPerCall: 10, maxCallMs: 5_000 },
      now: () => nowCalls++ < 3 ? 0 : 1_000,
      audit: { async append() {} },
    });

    const result = await reader.execute({ operation: "read", path: "source.txt", layer: "worktree", window: { kind: "line", startLine: 1, maxLines: 1 } }, new AbortController().signal);

    assert.equal(result.status, "cancelled");
    assert.equal(result.code, "deadline_exceeded");
    assert.deepEqual(result.items, []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("repository audit records one deadline failure when audit crosses the attempt deadline", async () => {
  const fixture = repositoryViewFixture();
  const audits: RepositoryQueryAuditMetadata[] = [];
  try {
    const reader = new RepositoryReader({
      descriptor: fixture.descriptor,
      identity: { workloadId: "w", workflowAttemptId: "a" },
      budgets: { maxCalls: 8, maxAttemptBytes: 4096, maxResponseBytes: 4096, maxAttemptMs: 1_000, maxItemsPerCall: 10, maxCallMs: 5_000 },
      audit: {
        async append(metadata, signal) {
          if (metadata.status === "ok") {
            await new Promise<void>((_resolve, reject) => {
              const abort = () => reject(signal.reason);
              if (signal.aborted) abort();
              else signal.addEventListener("abort", abort, { once: true });
            });
          }
          audits.push(metadata);
        },
      },
    });

    const result = await reader.execute({ operation: "read", path: "source.txt", layer: "worktree", window: { kind: "line", startLine: 1, maxLines: 1 } }, new AbortController().signal);

    assert.equal(result.status, "cancelled");
    assert.equal(result.code, "deadline_exceeded");
    assert.deepEqual(result.items, []);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.status, "cancelled");
    assert.equal(audits[0]?.failureCode, "deadline_exceeded");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("glob treats brackets as literal path characters", async () => {
  const fixture = repositoryViewFixture();
  try {
    const reader = new RepositoryReader({
      descriptor: fixture.descriptor,
      identity: { workloadId: "w", workflowAttemptId: "a" },
      budgets: { maxCalls: 8, maxAttemptBytes: 4096, maxResponseBytes: 4096, maxAttemptMs: 10_000, maxItemsPerCall: 10, maxCallMs: 1_000 },
      audit: { async append() {} },
    });

    const result = await reader.execute({ operation: "glob", pattern: "source[.]txt" }, new AbortController().signal);

    assert.equal(result.status, "ok");
    assert.deepEqual(result.items, []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("reader does not return raw binary repository bytes", async () => {
  const fixture = repositoryViewFixture();
  try {
    const content = Buffer.from([0x61, 0x00, 0x62]);
    writeFileSync(join(fixture.root, "source.txt"), content);
    const worktreeObjectId = createHash("sha1")
      .update(`blob ${content.byteLength}\0`)
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
      budgets: { maxCalls: 8, maxAttemptBytes: 4096, maxResponseBytes: 4096, maxAttemptMs: 10_000, maxItemsPerCall: 10, maxCallMs: 1_000 },
      audit: { async append() {} },
    });

    const result = await reader.execute({ operation: "read", path: "source.txt", layer: "worktree", window: { kind: "byte", startByte: 0, maxBytes: 3 } }, new AbortController().signal);

    assert.equal(result.status, "denied");
    assert.equal(result.code, "path_denied");
    assert.deepEqual(result.items, []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("blame redacts non-retained revisions from previous fields", async () => {
  const fixture = repositoryViewFixture({ preserveSensitiveObject: true });
  const git = (args: string[]): string => fixtureGit(fixture.root, args);
  try {
    const omittedRevision = fixture.descriptor.headRevision;
    git(["add", "source.txt"]);
    git(["commit", "-qm", "second"]);
    const headRevision = git(["rev-parse", "HEAD"]);
    const tree = git(["rev-parse", "HEAD^{tree}"]);
    const blob = git(["rev-parse", "HEAD:source.txt"]);
    const descriptor = {
      ...fixture.descriptor,
      headRevision,
      sourceRevision: headRevision,
      indexTree: tree,
      worktreeTree: tree,
      retainedRevisions: [{ id: headRevision, parents: [], incrementalAllowedBlobBytes: 0 }],
      frontier: [headRevision],
      retainedCommitCount: 1,
      entries: fixture.descriptor.entries.map((entry) => (
        entry.path === "source.txt"
          ? { ...entry, indexObjectId: blob, worktreeObjectId: blob, status: "clean" as const }
          : entry
      )),
    };
    const reader = new RepositoryReader({
      descriptor,
      identity: { workloadId: "w", workflowAttemptId: "a" },
      budgets: { maxCalls: 8, maxAttemptBytes: 64 * 1024, maxResponseBytes: 64 * 1024, maxAttemptMs: 10_000, maxItemsPerCall: 10, maxCallMs: 1_000 },
      audit: { async append() {} },
    });

    const result = await reader.execute({ operation: "git_blame", path: "source.txt", revision: headRevision, startLine: 1, endLineExclusive: 4 }, new AbortController().signal);

    assert.equal(result.status, "ok");
    assert.equal(result.items[0]?.kind, "blame");
    if (result.items[0]?.kind === "blame") {
      assert.doesNotMatch(result.items[0].text, new RegExp(omittedRevision, "u"));
      assert.equal(result.items[0].metadata.historyTruncated, true);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("blame returns no content for an empty half-open line range", async () => {
  const fixture = repositoryViewFixture();
  try {
    const reader = new RepositoryReader({
      descriptor: fixture.descriptor,
      identity: { workloadId: "w", workflowAttemptId: "a" },
      budgets: { maxCalls: 8, maxAttemptBytes: 64 * 1024, maxResponseBytes: 64 * 1024, maxAttemptMs: 10_000, maxItemsPerCall: 10, maxCallMs: 1_000 },
      audit: { async append() {} },
    });

    const result = await reader.execute({
      operation: "git_blame",
      path: "source.txt",
      revision: fixture.descriptor.headRevision,
      startLine: 2,
      endLineExclusive: 2,
    }, new AbortController().signal);

    assert.equal(result.status, "ok");
    assert.deepEqual(result.items, []);
    assert.equal(result.itemCount, 0);
    assert.equal(result.byteCount, 0);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("blame omits historical path fields that could disclose denied names", async () => {
  const fixture = repositoryViewFixture({ preserveSensitiveObject: true });
  const git = (args: string[]): string => fixtureGit(fixture.root, args);
  try {
    git(["checkout", "HEAD", "--", ".env"]);
    git(["mv", ".env", "safe.txt"]);
    git(["commit", "-qm", "rename protected file"]);
    const headRevision = git(["rev-parse", "HEAD"]);
    const tree = git(["rev-parse", "HEAD^{tree}"]);
    const blob = git(["rev-parse", "HEAD:safe.txt"]);
    const descriptor = {
      ...fixture.descriptor,
      headRevision,
      sourceRevision: headRevision,
      indexTree: tree,
      worktreeTree: tree,
      retainedRevisions: [{ id: headRevision, parents: [], incrementalAllowedBlobBytes: 0 }],
      frontier: [headRevision],
      retainedCommitCount: 1,
      entries: [{
        path: "safe.txt",
        kind: "file" as const,
        addressable: true,
        mode: 0o100644,
        sensitive: false,
        worktreePresent: true,
        indexObjectId: blob,
        worktreeObjectId: blob,
        status: "clean" as const,
      }],
    };
    const reader = new RepositoryReader({
      descriptor,
      identity: { workloadId: "w", workflowAttemptId: "a" },
      budgets: { maxCalls: 8, maxAttemptBytes: 64 * 1024, maxResponseBytes: 64 * 1024, maxAttemptMs: 10_000, maxItemsPerCall: 10, maxCallMs: 1_000 },
      audit: { async append() {} },
    });

    const result = await reader.execute({ operation: "git_blame", path: "safe.txt", revision: headRevision, startLine: 1, endLineExclusive: 2 }, new AbortController().signal);

    assert.equal(result.status, "ok");
    assert.equal(result.items[0]?.kind, "blame");
    if (result.items[0]?.kind === "blame") {
      assert.doesNotMatch(result.items[0].text, /\.env/u);
      assert.doesNotMatch(result.items[0].text, /^(?:filename|previous) /mu);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("git log denies paths outside the captured descriptor even when retained history contains them", async () => {
  const fixture = repositoryViewFixture({ preserveSensitiveObject: true });
  const git = (args: string[]): string => fixtureGit(fixture.root, args);
  try {
    writeFileSync(join(fixture.root, "retired.txt"), "historical content\n", "utf8");
    git(["add", "retired.txt"]);
    git(["commit", "-qm", "add retired file"]);
    const addedRevision = git(["rev-parse", "HEAD"]);
    rmSync(join(fixture.root, "retired.txt"));
    git(["add", "-u", "retired.txt"]);
    git(["commit", "-qm", "remove retired file"]);
    const headRevision = git(["rev-parse", "HEAD"]);
    const tree = git(["rev-parse", "HEAD^{tree}"]);
    const descriptor = {
      ...fixture.descriptor,
      headRevision,
      sourceRevision: headRevision,
      indexTree: tree,
      retainedRevisions: [
        { id: headRevision, parents: [addedRevision], incrementalAllowedBlobBytes: 0 },
        { id: addedRevision, parents: [], incrementalAllowedBlobBytes: 0 },
      ],
      frontier: [addedRevision],
      retainedCommitCount: 2,
    };
    const reader = new RepositoryReader({
      descriptor,
      identity: { workloadId: "w", workflowAttemptId: "a" },
      budgets: { maxCalls: 8, maxAttemptBytes: 64 * 1024, maxResponseBytes: 64 * 1024, maxAttemptMs: 10_000, maxItemsPerCall: 10, maxCallMs: 1_000 },
      audit: { async append() {} },
    });

    const result = await reader.execute({ operation: "git_log", path: "retired.txt", limit: 10 }, new AbortController().signal);

    assert.equal(result.status, "denied");
    assert.equal(result.code, "path_denied");
    assert.deepEqual(result.items, []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("path-filtered git log stops before comparing against an omitted parent", async () => {
  const fixture = repositoryViewFixture({ preserveSensitiveObject: true });
  const git = (args: string[]): string => fixtureGit(fixture.root, args);
  try {
    const omittedRevision = fixture.descriptor.headRevision;
    writeFileSync(join(fixture.root, "source.txt"), "middle\n", "utf8");
    git(["add", "source.txt"]);
    git(["commit", "-qm", "middle changes source"]);
    const middleRevision = git(["rev-parse", "HEAD"]);
    writeFileSync(join(fixture.root, "source.txt"), "head\n", "utf8");
    git(["add", "source.txt"]);
    git(["commit", "-qm", "head changes source"]);
    const headRevision = git(["rev-parse", "HEAD"]);
    const tree = git(["rev-parse", "HEAD^{tree}"]);
    const blob = git(["rev-parse", "HEAD:source.txt"]);
    const descriptor = {
      ...fixture.descriptor,
      headRevision,
      sourceRevision: headRevision,
      indexTree: tree,
      worktreeTree: tree,
      retainedRevisions: [
        { id: headRevision, parents: [middleRevision], incrementalAllowedBlobBytes: 0 },
        { id: middleRevision, parents: [omittedRevision], incrementalAllowedBlobBytes: 0 },
      ],
      frontier: [middleRevision],
      omittedParents: [omittedRevision],
      retainedCommitCount: 2,
      entries: fixture.descriptor.entries.map((entry) => (
        entry.path === "source.txt"
          ? { ...entry, indexObjectId: blob, worktreeObjectId: blob, status: "clean" as const }
          : entry
      )),
    };
    const reader = new RepositoryReader({
      descriptor,
      identity: { workloadId: "w", workflowAttemptId: "a" },
      budgets: { maxCalls: 8, maxAttemptBytes: 64 * 1024, maxResponseBytes: 64 * 1024, maxAttemptMs: 10_000, maxItemsPerCall: 10, maxCallMs: 1_000 },
      audit: { async append() {} },
    });

    const result = await reader.execute({ operation: "git_log", path: "source.txt", limit: 10 }, new AbortController().signal);

    assert.equal(result.status, "ok");
    assert.deepEqual(result.items.map((item) => item.metadata.revision), [headRevision]);
    assert.deepEqual(result.historyBoundary, {
      truncated: true,
      frontier: [middleRevision],
      omittedParents: [omittedRevision],
    });
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

test("path-only repository results consume response bytes and paginate", async () => {
  const fixture = repositoryViewFixture();
  try {
    const sourceEntry = fixture.descriptor.entries.find((entry) => entry.path === "source.txt")!;
    const descriptor = {
      ...fixture.descriptor,
      entries: Array.from({ length: 100 }, (_, index) => ({
        ...sourceEntry,
        path: `file-${index.toString().padStart(3, "0")}.txt`,
      })),
    };
    const reader = new RepositoryReader({
      descriptor,
      identity: { workloadId: "w", workflowAttemptId: "a" },
      budgets: { maxCalls: 8, maxAttemptBytes: 512, maxResponseBytes: 512, maxAttemptMs: 10_000, maxItemsPerCall: 100_000, maxCallMs: 1_000 },
      cursorSecret: Buffer.alloc(32, 6),
      audit: { async append() {} },
    });

    const first = await reader.execute({ operation: "glob", pattern: "**" }, new AbortController().signal);

    assert.equal(first.status, "ok");
    assert.equal(first.truncationReason, "bytes");
    assert.ok(first.byteCount > 0);
    assert.ok(first.byteCount <= 512);
    assert.ok(first.items.length > 0);
    assert.ok(first.items.length < descriptor.entries.length);
    assert.ok(first.continuationCursor);

    const second = await reader.execute({ operation: "glob", pattern: "**", cursor: first.continuationCursor! }, new AbortController().signal);
    assert.equal(second.status, "unavailable");
    assert.equal(second.code, "budget_exhausted");
    assert.equal(second.byteCount, 0);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("concurrent repository calls reserve the cumulative byte budget before audit", async () => {
  const fixture = repositoryViewFixture();
  try {
    const calibration = new RepositoryReader({
      descriptor: fixture.descriptor,
      identity: { workloadId: "calibration", workflowAttemptId: "a" },
      budgets: { maxCalls: 8, maxAttemptBytes: 4096, maxResponseBytes: 4096, maxAttemptMs: 10_000, maxItemsPerCall: 10, maxCallMs: 1_000 },
      audit: { async append() {} },
    });
    const sample = await calibration.execute({ operation: "read", path: "source.txt", layer: "worktree", window: { kind: "line", startLine: 1, maxLines: 1 } }, new AbortController().signal);
    assert.equal(sample.status, "ok");

    let releaseAudits!: () => void;
    const auditsReleased = new Promise<void>((resolve) => { releaseAudits = resolve; });
    let auditCount = 0;
    const reader = new RepositoryReader({
      descriptor: fixture.descriptor,
      identity: { workloadId: "w", workflowAttemptId: "a" },
      budgets: { maxCalls: 8, maxAttemptBytes: sample.byteCount * 2 - 1, maxResponseBytes: 4096, maxAttemptMs: 10_000, maxItemsPerCall: 10, maxCallMs: 1_000 },
      audit: {
        async append() {
          auditCount += 1;
          if (auditCount === 2) releaseAudits();
          await auditsReleased;
        },
      },
    });
    const request = { operation: "read" as const, path: "source.txt", layer: "worktree" as const, window: { kind: "line" as const, startLine: 1, maxLines: 1 } };

    const results = await Promise.all([
      reader.execute(request, new AbortController().signal),
      reader.execute(request, new AbortController().signal),
    ]);

    assert.equal(results.filter((result) => result.status === "ok").length, 1);
    const refused = results.find((result) => result.status !== "ok");
    assert.equal(refused?.status, "unavailable");
    assert.equal(refused?.code, "budget_exhausted");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
