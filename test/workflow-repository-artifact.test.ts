import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  truncateSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { deflateSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { openDb } from "../src/server/db.ts";
import { WorkflowStore } from "../src/server/workflows/store.ts";
import { WorkflowRepositoryArtifactService } from "../src/server/workflows/repository-artifact/service.ts";
import { sampleCheckoutBoundary, seal } from "../src/server/workflows/repository-artifact/seal.ts";
import { RepositoryArtifactStorage } from "../src/server/workflows/repository-artifact/storage.ts";
import { descriptor, manifestSchema, MAX_CAPTURE_OBJECT_BYTES, RepositoryCaptureChanged } from "../src/server/workflows/repository-artifact/format.ts";
import type { RepositoryMaterializationRequest } from "../src/server/workflows/persona-workload/contracts.ts";
import { createRepositoryReader } from "../src/server/workflows/persona-workload/reader.ts";
import { captureStableWorkflowContext } from "../src/server/workflows/context.ts";

import { ensureNativeStateLockAddon } from "./helpers/native-state-lock.ts";

ensureNativeStateLockAddon();
const signal = new AbortController().signal;
function fixture(t: TestContext, format = "sha1", storage?: RepositoryArtifactStorage) {
  const temp = mkdtempSync(join(tmpdir(), "artifact-fixture-")),
    checkout = join(temp, "source");
  const root = join(temp, "store");
  mkdirSync(checkout);
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: checkout,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: temp, GIT_CONFIG_NOSYSTEM: "1" },
    }).trim();
  git("init", "-q", "-b", "main", "--object-format=" + format);
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  const store = new WorkflowStore(),
    db = openDb();
  const requests = new Map<string, RepositoryMaterializationRequest>();
  const lookup = (id: string) => requests.get(id) ?? null;
  const service = WorkflowRepositoryArtifactService.forRoot(store, root, storage);
  service.setActiveRequestLookup(lookup);
  const write = (name: string, value: string | Buffer) => writeFileSync(join(checkout, name), value);
  function submission() {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO workflow_submissions (id,run_id,round,mode,trigger_source,trigger_key,
      evidence_fingerprint,context_json,evidence_json,status,created_at,updated_at)
      VALUES(?,?,1,'full_workflow','manual',?,'fp','{}','{}','capturing',1,1)`,
    ).run(id, id, id);
    return id;
  }
  function request(snapshot: { digest: string; locator: string; submissionId: string }) {
    const r = { ...snapshot, workloadId: randomUUID(), attemptId: randomUUID() };
    requests.set(r.workloadId, r);
    return r;
  }
  return {
    checkout,
    root,
    git,
    write,
    store,
    service,
    lookup,
    db,
    submission,
    request,
    prepare: (sourceBase: string | null = null) => service.prepare({ checkout, sourceBase }, signal),
  };
}

// Exit with a marked pending directory and, optionally, a second promoted candidate.
// The parent subsequently runs startup recovery with a genuinely fresh in-memory registry.
function interruptedCapture(f: ReturnType<typeof fixture>, submissionId?: string) {
  const output = execFileSync(process.execPath, [
    "--import", "tsx", "--input-type=module", "-e", `
      import { WorkflowStore } from "./src/server/workflows/store.ts";
      import { WorkflowRepositoryArtifactService } from "./src/server/workflows/repository-artifact/service.ts";
      const [root, checkout, submission] = process.argv.slice(1);
      const service = WorkflowRepositoryArtifactService.forRoot(new WorkflowStore(), root);
      const prepare = () => service.prepare({ checkout, sourceBase: null }, new AbortController().signal);
      const pending = await prepare();
      if (submission) await service.promote(await prepare(), submission);
      console.log(JSON.stringify(pending));
    `, f.root, f.checkout, ...(submissionId ? [submissionId] : []),
  ], { encoding: "utf8" });
  return JSON.parse(output.trimEnd().split("\n").at(-1)!) as { id: string; digest: string };
}

test("portable layered capture reads and diffs after source deletion, omits sensitive history and executes no filters", async (t) => {
  const f = fixture(t);
  f.write("a", "history\n");
  f.write(".env", "SECRET-committed");
  f.write("removed", "gone");
  f.write("before", "rename");
  f.git("add", ".");
  f.git("commit", "-qm", "base");
  const base = f.git("rev-parse", "HEAD");
  f.write("a", "commit\n");
  f.write(".env", "SECRET-head");
  f.git("commit", "-qam", "head");
  const head = f.git("rev-parse", "HEAD");
  f.git("mv", "before", "after");
  f.write("a", "index\n");
  f.write(".env", "SECRET-staged");
  f.git("add", "-u");
  f.write("a", "working\n");
  f.write(".env", "SECRET-working");
  f.git("update-index", "--split-index");
  f.write(".gitignore", "ignored\n");
  f.write("ignored", "SECRET-ignored");
  f.write("credentials.tmp", "SECRET-untracked");
  f.write("binary", Buffer.from([0, 255]));
  f.write("empty", "");
  f.write("executable", "hello");
  chmodSync(join(f.checkout, "executable"), 0o755);
  symlinkSync("ignored", join(f.checkout, "link"));
  rmSync(join(f.checkout, "removed"));
  f.write(".gitattributes", "a filter=unsafe diff=unsafe\n");
  for (const key of [
    "filter.unsafe.clean",
    "filter.unsafe.smudge",
    "filter.unsafe.process",
    "diff.unsafe.command",
    "diff.unsafe.textconv",
    "core.fsmonitor",
    "credential.helper",
  ])
    f.git("config", key, "touch EXECUTED");
  const idx = readFileSync(join(f.checkout, ".git/index"));
  const one = await f.prepare(base),
    two = await f.prepare(base);
  assert.equal(one.digest, two.digest);
  assert.equal(f.service.artifacts().length, 0);
  assert.deepEqual(idx, readFileSync(join(f.checkout, ".git/index")));
  assert.equal(readFileSync(join(f.checkout, "a"), "utf8"), "working\n");
  assert.equal(existsSync(join(f.checkout, "EXECUTED")), false);
  const first = await f.service.promote(one, f.submission());
  const second = await f.service.promote(two, f.submission());
  const request = f.request(first);
  await assert.rejects(f.service.materialize(request, signal));
  f.store.commitRepositoryCaptureActivation(first);
  f.store.commitRepositoryCaptureActivation(second);
  for (const field of ["workloadId", "attemptId", "submissionId", "digest", "locator"])
    await assert.rejects(f.service.materialize({ ...request, [field]: "stale" }, signal));
  assert.equal(existsSync(join(f.root, "leases")), false);
  const artifact = join(f.root, "digests", one.digest);
  for (const name of readdirSync(artifact))
    assert.ok(!readFileSync(join(artifact, name)).includes("SECRET-"));
  rmSync(f.checkout, { recursive: true });
  await f.service.release(second.submissionId);
  await f.service.reconcile();
  const lease = await f.service.materialize(request, signal);
  assert.deepEqual(
    lease.descriptor.retainedRevisions.map((r) => r.id),
    [head, base],
  );
  const reader = createRepositoryReader({
    view: lease.descriptor,
    objectDirectory: lease.objectDirectory,
    workloadId: request.workloadId,
    attemptId: request.attemptId,
    gitBinary: "git",
    budgets: {},
    signal,
    audit: async () => {},
  });
  assert.equal((await reader.query("read", { path: "a" })).items[0]?.text, "working");
  assert.equal((await reader.query("read", { path: "a", layer: "index" })).items[0]?.text, "index");
  await t.test("materialized reads preserve the untracked file bytes and literal symlink target", async () => {
    for (const [path, expected] of [["executable", "hello"], ["link", "ignored"]] as const) {
      const result = await reader.query("read", { path, unit: "byte" });
      assert.deepEqual(result.items.map(item => item.text), [Buffer.from(expected).toString("base64")], path);
    }
  });
  assert.equal((await reader.query("read", { path: ".env" })).code, "denied_path");
  for (const [pair, expected] of [
    ["base_head", "commit"],
    ["head_index", "index"],
    ["index_worktree", "working"],
  ]) {
    const result = await reader.query("git_diff", { pair, paths: ["a"] });
    assert.equal(result.status, "ok");
    assert.ok(JSON.stringify(result.items).includes(expected!));
  }
  assert.equal((await reader.query("git_log", {})).itemCount, 2);
  for (const revision of [head, base])
    assert.equal((await reader.query("git_show", { revision, patch: true })).status, "ok");
  assert.equal(
    (await reader.query("git_blame", { revision: head, path: "a", startLine: 1, endLineExclusive: 2 }))
      .itemCount,
    1,
  );
  assert.equal((await reader.query("git_show", { revision: "a".repeat(40) })).code, "revision_out_of_range");
  const launch = join(f.root, "launch.json"),
    auditPath = join(f.root, "audit.jsonl");
  writeFileSync(auditPath, "");
  writeFileSync(
    launch,
    JSON.stringify({
      view: lease.descriptor,
      objectDirectory: lease.objectDirectory,
      gitBinary: "git",
      workloadId: request.workloadId,
      attemptId: request.attemptId,
      budgets: {},
      auditPath,
      deadline: Date.now() + 30000,
    }),
  );
  const client = new Client({ name: "artifact-round-trip", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/repository-mcp/server.ts"],
    env: { PATH: process.env.PATH!, REPOSITORY_MCP_DESCRIPTOR: launch },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    for (const [path, expected] of [
      ["a", "working"],
      [".env", "denied_path"],
    ] as const) {
      const reply = await client.callTool({ name: "read", arguments: { path } });
      const content = reply.content as Array<{ text: string }>;
      const result = JSON.parse(content[0]!.text);
      assert.equal(result.code ?? result.items[0].text, expected);
    }
  } finally {
    await client.close();
    await transport.close();
  }
  const entries = lease.descriptor.worktree;
  assert.ok(entries.find((e) => e.path === "removed")?.classifications.includes("deleted"));
  assert.deepEqual(entries.find((e) => e.path === "a")?.classifications, ["committed", "staged", "unstaged"]);
  assert.equal(entries.find((e) => e.path === "link")?.kind, "symlink");
  assert.equal(entries.find((e) => e.path === "binary")?.binary, true);
  assert.ok(!entries.some((e) => e.path === "ignored"));
  assert.ok(entries.some((e) => e.path === "empty"));
  await lease.release();
  assert.equal(existsSync(lease.objectDirectory), false);
  await f.service.release(first.submissionId);
  await f.service.reconcile();
  assert.equal(existsSync(artifact), false);
});

test("startup removes only marked abandoned candidates and releases stranded provisional claims", async (t) => {
  const f = fixture(t);
  const pending = interruptedCapture(f, f.submission());
  const unowned = join(f.root, "pending", randomUUID());
  mkdirSync(unowned);
  symlinkSync(f.checkout, join(f.root, "pending", randomUUID()));
  assert.ok(existsSync(join(f.root, "digests", pending.digest)));
  const warnings = t.mock.method(console, "warn", () => {});
  const result = await f.service.reconcile();
  assert.equal(result.orphans, 2);
  assert.deepEqual(warnings.mock.calls.map(call => call.arguments[0]).sort(), [
    "[workflow] event=repository_orphan_cleanup error=ENOENT",
    "[workflow] event=repository_orphan_cleanup error=artifact_unavailable",
  ]);
  assert.ok(existsSync(unowned) && existsSync(f.checkout));
  assert.ok(!existsSync(join(f.root, "pending", pending.id)));
  assert.ok(!existsSync(join(f.root, "digests", pending.digest)));
});

for (const changed of [false, true]) {
  test(`restart allows a still-capturing submission to reclaim a ${changed ? "different" : "shared"} digest`, async (t) => {
    const f = fixture(t);
    f.write("a", "original");
    const holder = await f.service.promote(await f.prepare(), f.submission());
    f.store.commitRepositoryCaptureActivation(holder);
    const retryId = f.submission();
    const interrupted = await f.service.promote(await f.prepare(), retryId);
    assert.equal(interrupted.digest, holder.digest);
    interruptedCapture(f); // A new process runs startup reconciliation.
    await f.service.reconcile();
    const claim = () => f.db.prepare(
      "SELECT digest,state,created_at,activated_at,released_at FROM workflow_repository_snapshot_claims WHERE submission_id=?",
    ).get(retryId);
    const released = claim();
    assert.equal(released?.state, "released");
    assert.ok(released.released_at);
    if (changed) f.write("a", "updated");
    const candidate = await f.prepare();
    f.db.exec("CREATE TEMP TRIGGER refuse_retry BEFORE INSERT ON workflow_repository_snapshot_claims BEGIN SELECT RAISE(ABORT,'injected'); END");
    try {
      await assert.rejects(f.service.promote(candidate, retryId), { code: "artifact_unavailable" });
      assert.deepEqual(claim(), released);
    } finally {
      f.db.exec("DROP TRIGGER refuse_retry");
    }
    const retried = await f.service.promote(candidate, retryId);
    assert.equal(retried.digest !== holder.digest, changed);
    assert.equal(claim()?.state, "provisional");
    assert.equal(claim()?.activated_at, null);
    assert.equal(claim()?.released_at, null);
    await assert.rejects(f.service.materialize(f.request(retried), signal));
    f.store.commitRepositoryCaptureActivation(retried);
    for (const snapshot of [retried, holder]) {
      const lease = await f.service.materialize(f.request(snapshot), signal);
      assert.equal(lease.identity.digest, snapshot.digest);
      await lease.release();
      await f.service.release(snapshot.submissionId);
      await f.service.reconcile();
    }
  });
}

test("one service per root protects live candidates, provisional claims and leases across callers", async (t) => {
  const f = fixture(t);
  f.write("a", "submitted");
  const pending = await f.prepare();
  const first = await f.service.promote(await f.prepare(), f.submission());
  f.store.commitRepositoryCaptureActivation(first);
  const request = f.request(first);
  f.service.setActiveRequestLookup(undefined);
  await assert.rejects(f.service.materialize(request, signal), { code: "artifact_unavailable" });
  const supervisor = WorkflowRepositoryArtifactService.forRoot(new WorkflowStore(), f.root);
  assert.equal(supervisor, f.service);
  supervisor.setActiveRequestLookup(f.lookup);
  const lease = await supervisor.materialize(request, signal);
  const second = await supervisor.promote(await f.prepare(), f.submission());
  await Promise.all([supervisor.reconcile(), f.service.reconcile()]);
  assert.ok(existsSync(join(f.root, "pending", pending.id)));
  assert.ok(existsSync(join(lease.objectDirectory, "objects")));
  f.store.commitRepositoryCaptureActivation(second);
  assert.ok(supervisor.activeSnapshot(second.submissionId));
  await lease.release();
  await f.service.discard(pending);
  await supervisor.release(first.submissionId);
  await supervisor.release(second.submissionId);
  await f.service.reconcile();
});

test("verification detects object growth after fstat within the declared size plus one byte", async (t) => {
  const f = fixture(t);
  f.write("file", "submitted");
  const blob = f.git("hash-object", "file");
  const snapshot = await f.service.promote(await f.prepare(), f.submission());
  f.store.commitRepositoryCaptureActivation(snapshot);
  const path = realpathSync(join(f.root, "digests", snapshot.digest, blob));
  const expected = lstatSync(path).size;
  const fs = (await import("node:fs/promises")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const open = fs.open;
  let total = 0;
  const inspect = t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
    const fd = await open(...args);
    if (String(args[0]) !== path) return fd;
    const stat = fd.stat.bind(fd);
    t.mock.method(fd, "stat", async () => {
      const observed = await stat();
      chmodSync(path, 0o600);
      truncateSync(path, expected + 4096);
      chmodSync(path, 0o400);
      return observed;
    });
    const read = fd.read.bind(fd);
    t.mock.method(fd, "read", async (buffer: Buffer, offset: number, length: number, position: number) => {
      assert.ok(length <= expected + 1 - total);
      // A short read is possible even before EOF.
      const result = await read(buffer, offset, Math.min(length, 3), position);
      total += result.bytesRead;
      return result;
    });
    return fd;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.service.verify(snapshot, signal), { code: "artifact_unavailable" });
    assert.equal(total, expected + 1);
    assert.equal(f.service.artifacts()[0]?.state, "failed");
  } finally {
    inspect.mock.restore();
    syncBuiltinESMExports();
    await f.service.release(snapshot.submissionId);
    await f.service.reconcile();
  }
});

test("verification authenticates an oversized manifest before allocating space for it", async (t) => {
  const f = fixture(t);
  const snapshot = await f.service.promote(await f.prepare(), f.submission());
  f.store.commitRepositoryCaptureActivation(snapshot);
  const path = join(f.root, "digests", snapshot.digest, "manifest.json");
  chmodSync(path, 0o600);
  truncateSync(path, MAX_CAPTURE_OBJECT_BYTES + 1);
  chmodSync(path, 0o400);
  let largest = 0;
  const allocate = Buffer.allocUnsafe;
  const sizes = t.mock.method(Buffer, "allocUnsafe", (size: number) => {
    largest = Math.max(largest, size);
    return allocate(size);
  });
  try {
    await assert.rejects(f.service.verify(snapshot, signal), { code: "artifact_unavailable" });
    assert.equal(f.service.artifacts()[0]?.state, "failed");
    assert.ok(largest < MAX_CAPTURE_OBJECT_BYTES);
  } finally {
    sizes.mock.restore();
    await f.service.release(snapshot.submissionId);
    await f.service.reconcile();
  }
});

test("transient verification I/O errors preserve ready claims and both submissions can retry", async (t) => {
  const f = fixture(t);
  f.write("file", "shared bytes");
  const first = await f.service.promote(await f.prepare(), f.submission());
  const second = await f.service.promote(await f.prepare(), f.submission());
  f.store.commitRepositoryCaptureActivation(first);
  f.store.commitRepositoryCaptureActivation(second);
  assert.equal(first.digest, second.digest);
  const manifest = realpathSync(join(f.root, "digests", first.digest, "manifest.json"));
  const candidate = await f.prepare();
  const incoming = f.submission();
  const before = f.service.activeSnapshot(first.submissionId)!.artifact;
  const fs = (await import("node:fs/promises")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const open = fs.open;
  for (const code of ["EMFILE", "EIO", "ETIMEDOUT"]) {
    const failRead = t.mock.method(fs, "open", (...args: Parameters<typeof open>) => {
      if (String(args[0]) === manifest) throw Object.assign(new Error("read failed"), { code });
      return open(...args);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(f.service.verify(first, signal), { code: "artifact_unavailable" });
      await assert.rejects(f.service.materialize(f.request(second), signal), { code: "artifact_unavailable" });
      await assert.rejects(f.service.promote(candidate, incoming), { code: "artifact_unavailable" });
    } finally {
      failRead.mock.restore();
      syncBuiltinESMExports();
    }
    assert.deepEqual(f.service.activeSnapshot(first.submissionId)?.artifact, before);
    assert.deepEqual(f.service.activeSnapshot(second.submissionId)?.artifact, before);
  }
  await f.service.discard(candidate);
  for (const snapshot of [second, first]) {
    const lease = await f.service.materialize(f.request(snapshot), signal);
    assert.equal(lease.identity.digest, first.digest);
    await lease.release();
    assert.equal((await f.service.verify(snapshot, signal)).digest, first.digest);
    await f.service.release(snapshot.submissionId);
  }
  await f.service.reconcile();
});

test("oversized tracked, untracked and denied worktree files fail capture before any payload read", async (t) => {
  const f = fixture(t);
  const fs = (await import("node:fs/promises")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const open = fs.open;
  const warnings = t.mock.method(console, "warn", () => {});
  const oversized = new Set<string>();
  const read = () => assert.fail("attempted a payload read above the worktree limit");
  const inspect = t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
    const fd = await open(...args);
    if (oversized.has(String(args[0]))) {
      t.mock.method(fd, "read", read);
      t.mock.method(fd, "readFile", read);
    }
    return fd;
  });
  syncBuiltinESMExports();
  try {
    for (const name of ["tracked", "untracked", ".env"]) {
      f.write(name, "small");
      if (name === "tracked") f.git("add", name);
      const file = realpathSync(join(f.checkout, name));
      truncateSync(file, MAX_CAPTURE_OBJECT_BYTES + 1);
      oversized.add(file);
      await assert.rejects(f.service.sampleBoundary(f.checkout, signal), { code: "artifact_unavailable" });
      await assert.rejects(f.prepare(), { code: "artifact_unavailable" });
      rmSync(file);
    }
  } finally {
    inspect.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(warnings.mock.calls.map(call => call.arguments[0]), Array.from({ length: 3 }, () => [
    "[workflow] event=repository_boundary error=worktree_file_too_large",
    "[workflow] event=repository_seal error=worktree_file_too_large",
  ]).flat());
  assert.deepEqual(readdirSync(join(f.root, "pending")), []);
  assert.deepEqual(f.service.artifacts(), []);
});

test("oversized required Git objects in the index, HEAD or base are rejected before payload allocation", async (t) => {
  const f = fixture(t);
  f.write("large", "");
  truncateSync(join(f.checkout, "large"), MAX_CAPTURE_OBJECT_BYTES + 1);
  f.git("add", "large");
  rmSync(join(f.checkout, "large"));
  const alloc = Buffer.allocUnsafe;
  const sizes = t.mock.method(Buffer, "allocUnsafe", (size: number) => {
    assert.ok(size <= MAX_CAPTURE_OBJECT_BYTES, "allocated oversized Git object");
    return alloc(size);
  });
  const warnings = t.mock.method(console, "warn", () => {});
  try {
    await assert.rejects(f.prepare(), { code: "artifact_unavailable" }); // Index only.
    f.git("commit", "-qm", "large staged blob");
    const base = f.git("rev-parse", "HEAD");
    f.git("update-index", "--force-remove", "large");
    await assert.rejects(f.prepare(), { code: "artifact_unavailable" }); // HEAD only.
    const tip = objects(f.checkout).commit(f.git("write-tree"), [], "independent tip");
    f.git("update-ref", "HEAD", tip);
    await assert.rejects(f.prepare(base), { code: "artifact_unavailable" }); // Diff-only base.
  } finally {
    sizes.mock.restore();
  }
  assert.deepEqual(warnings.mock.calls.map(call => call.arguments[0]),
    Array(3).fill("[workflow] event=repository_seal error=git_object_too_large"));
  assert.deepEqual(readdirSync(join(f.root, "pending")), []);
  assert.deepEqual(f.service.artifacts(), []);
});

test("aggregate required storage is checked across layers before copying any blobs", async (t) => {
  const f = fixture(t, "sha1", new RepositoryArtifactStorage(12_000, 100_000));
  f.write("file", "a".repeat(5_000));
  f.git("add", "file");
  f.git("commit", "-qm", "first");
  f.write("file", "b".repeat(5_000));
  f.git("add", "file");
  f.write("duplicate", "b".repeat(5_000));
  f.write("extra", "c".repeat(4_000));
  const fs = (await import("node:fs/promises")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const write = fs.writeFile;
  let blobWrites = 0;
  const writes = t.mock.method(fs, "writeFile", (...args: Parameters<typeof write>) => {
    if (Buffer.isBuffer(args[1]) && args[1].toString("ascii", 0, 5) === "blob ") blobWrites++;
    return write(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.prepare(), { code: "artifact_unavailable" });
    assert.equal(blobWrites, 0);
    assert.deepEqual(readdirSync(join(f.root, "pending")), []);
    rmSync(join(f.checkout, "extra"));
    const candidate = await f.prepare();
    assert.equal(blobWrites, 2);
    await f.service.discard(candidate);
  } finally {
    writes.mock.restore();
    syncBuiltinESMExports();
  }
});

test("concurrent and sealed candidates retain their storage reservations until cleanup", async (t) => {
  const f = fixture(t, "sha1", new RepositoryArtifactStorage(128_000, 180_000));
  f.write("file", Buffer.alloc(96_000, 0x61));
  const fs = (await import("node:fs/promises")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const write = fs.writeFile;
  let notifyWrite!: () => void, resumeWrite!: () => void;
  const reached = new Promise<void>(resolve => { notifyWrite = resolve; });
  const resumed = new Promise<void>(resolve => { resumeWrite = resolve; });
  let blobWrites = 0;
  const writes = t.mock.method(fs, "writeFile", async (...args: Parameters<typeof write>) => {
    if (Buffer.isBuffer(args[1]) && args[1].toString("ascii", 0, 5) === "blob ") {
      blobWrites++;
      if (blobWrites === 1) {
        notifyWrite();
        await resumed;
      }
    }
    return write(...args);
  });
  syncBuiltinESMExports();
  try {
    const preparing = f.prepare();
    await Promise.race([reached, preparing.then(() => assert.fail("expected a paused object write"))]);
    await assert.rejects(f.prepare(), { code: "artifact_unavailable" });
    assert.equal(blobWrites, 1);
    resumeWrite();
    const candidate = await preparing;
    await assert.rejects(f.prepare(), { code: "artifact_unavailable" });
    assert.equal(blobWrites, 1);
    await f.service.discard(candidate);
    const holder = await f.service.promote(await f.prepare(), f.submission());
    await f.service.discard(await f.prepare());
    assert.deepEqual(readdirSync(join(f.root, "pending")), []);
    await f.service.release(holder.submissionId);
    await f.service.reconcile();
  } finally {
    resumeWrite();
    writes.mock.restore();
    syncBuiltinESMExports();
  }
});

test("first capture reports a startup reconciliation failure and retries before sealing", async (t) => {
  const f = fixture(t);
  const warnings = t.mock.method(console, "warn", () => {});
  const startup = t.mock.method(f.service, "reconcile", async () => {
    throw Object.assign(new Error("private storage details"), { code: "EIO" });
  });
  await assert.rejects(f.prepare(), { code: "artifact_unavailable" });
  assert.equal(f.service.status().failuresByCode.artifact_unavailable, 1);
  assert.deepEqual(warnings.mock.calls.map(call => call.arguments[0]), ["[workflow] event=repository_seal error=EIO"]);
  assert.equal(existsSync(join(f.root, "pending")), false);
  startup.mock.restore();
  await f.service.discard(await f.prepare());
  assert.deepEqual(readdirSync(join(f.root, "pending")), []);
});

test("displaced digest bytes reserve temporary storage until pending cleanup succeeds", async (t) => {
  const f = fixture(t, "sha1", new RepositoryArtifactStorage(150_000, 218_000));
  f.write("file", Buffer.alloc(64_000, 0x61));
  const holder = await f.service.promote(await f.prepare(), f.submission());
  f.store.commitRepositoryCaptureActivation(holder);
  const candidate = await f.prepare();
  const pending = join(realpathSync(f.root), "pending", candidate.id);
  const blob = f.git("hash-object", "file");
  const source = join(f.root, "digests", holder.digest, blob);
  chmodSync(source, 0o600);
  truncateSync(source, 240_000);
  const incoming = f.submission();
  await assert.rejects(f.service.promote(candidate, incoming), { code: "artifact_unavailable" });
  assert.equal(lstatSync(source).size, 240_000);
  assert.equal(existsSync(join(pending, "promotion")), false);
  truncateSync(source, 128_000);
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const remove = fs.rmSync, previous = join(pending, "previous");
  const fault = t.mock.method(fs, "rmSync", (...args: Parameters<typeof remove>) => {
    if (args[0] === previous) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    return remove(...args);
  });
  syncBuiltinESMExports();
  try {
    f.store.commitRepositoryCaptureActivation(await f.service.promote(candidate, incoming));
    assert.equal(lstatSync(join(previous, blob)).size, 128_000);
    for (let i = 0; i < 2; i++) assert.equal((await f.service.reconcile()).orphans, 1);
    f.write("file", Buffer.alloc(5_000));
    await f.service.discard(await f.prepare());
    f.write("file", Buffer.alloc(110_000));
    await assert.rejects(f.prepare(), { code: "artifact_unavailable" });
  } finally {
    fault.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal((await f.service.reconcile()).orphans, 0);
  assert.equal(existsSync(previous), false);
  await f.service.discard(await f.prepare());
  await f.service.release(holder.submissionId);
  await f.service.release(incoming);
  await f.service.reconcile();
});

test("recovery charges a previous writer's displaced bytes if cleanup still fails", async (t) => {
  const f = fixture(t, "sha1", new RepositoryArtifactStorage(120_000, 160_000));
  f.write("file", Buffer.alloc(80_000));
  const holder = await f.service.promote(await f.prepare(), f.submission());
  f.store.commitRepositoryCaptureActivation(holder);
  const candidate = interruptedCapture(f);
  const pending = join(realpathSync(f.root), "pending", candidate.id);
  const previous = join(pending, "previous"), dest = join(f.root, "digests", holder.digest);
  writeFileSync(join(pending, "promotion"), holder.digest);
  renameSync(dest, previous);
  renameSync(join(pending, "artifact"), dest);

  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const remove = fs.rmSync;
  const fault = t.mock.method(fs, "rmSync", (...args: Parameters<typeof remove>) => {
    if (args[0] === previous) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    return remove(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.equal((await f.service.reconcile()).orphans, 1);
    await assert.rejects(f.prepare(), { code: "artifact_unavailable" });
    assert.ok(f.service.activeSnapshot(holder.submissionId));
  } finally {
    fault.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal((await f.service.reconcile()).orphans, 0);
  await f.service.discard(await f.prepare());
  await f.service.release(holder.submissionId);
  await f.service.reconcile();
});

for (const kind of ["pending", "leases"] as const) {
  test(`startup charges an abandoned ${kind} allocation before admitting new writes`, async (t) => {
    const f = fixture(t, "sha1", new RepositoryArtifactStorage(128_000, 160_000));
    f.write("file", randomBytes(96_000));
    const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { WorkflowStore } from "./src/server/workflows/store.ts";
      import { WorkflowRepositoryArtifactService } from "./src/server/workflows/repository-artifact/service.ts";
      const [root, checkout, submission, kind] = process.argv.slice(1);
      const store = new WorkflowStore(), service = WorkflowRepositoryArtifactService.forRoot(store, root);
      const signal = new AbortController().signal;
      const prepare = () => service.prepare({ checkout, sourceBase: null }, signal);
      const snapshot = await service.promote(await prepare(), submission);
      store.commitRepositoryCaptureActivation(snapshot);
      const request = { ...snapshot, workloadId: "old", attemptId: "old" };
      service.setActiveRequestLookup(() => request);
      if (kind === "pending") await prepare();
      else await service.materialize(request, signal);
      console.log(JSON.stringify(snapshot));
    `, f.root, f.checkout, f.submission(), kind], { encoding: "utf8" });
    const snapshot = JSON.parse(output.trimEnd().split("\n").at(-1)!);
    const parent = join(realpathSync(f.root), kind);
    const [id] = readdirSync(parent);
    const payload = join(parent, id!, kind === "pending" ? "artifact" : "objects");
    const fs = (await import("node:fs")).default;
    const { syncBuiltinESMExports } = await import("node:module");
    const remove = fs.rmSync;
    const fault = t.mock.method(fs, "rmSync", (...args: Parameters<typeof remove>) => {
      if (args[0] === payload) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      return remove(...args);
    });
    syncBuiltinESMExports();
    try {
      // materialize can be the first caller after restart, before any new capture.
      const request = f.request(snapshot);
      await assert.rejects(kind === "pending" ? f.prepare() : f.service.materialize(request, signal),
        { code: "artifact_unavailable" });
      assert.ok(existsSync(payload));
      assert.equal((await f.service.reconcile()).orphans, 1);
      await assert.rejects(f.prepare(), { code: "artifact_unavailable" });
      await assert.rejects(f.service.materialize(request, signal), { code: "artifact_unavailable" });
      f.write("file", "small");
      await f.service.discard(await f.prepare());
    } finally {
      fault.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal((await f.service.reconcile()).orphans, 0);
    assert.equal(existsSync(payload), false);
    const lease = await f.service.materialize(f.request(snapshot), signal);
    await lease.release();
    await f.service.release(snapshot.submissionId);
    await f.service.reconcile();
  });
}

test("reader leases share storage with pending candidates until their directories are removed", async (t) => {
  const f = fixture(t, "sha1", new RepositoryArtifactStorage(128_000, 160_000));
  f.write("file", randomBytes(96_000));
  const snapshot = await f.service.promote(await f.prepare(), f.submission());
  f.store.commitRepositoryCaptureActivation(snapshot);
  const request = f.request(snapshot);
  const first = await f.service.materialize(request, signal);
  await assert.rejects(f.service.materialize(request, signal), { code: "artifact_unavailable" });
  await assert.rejects(f.prepare(), { code: "artifact_unavailable" });
  assert.ok(f.service.activeSnapshot(snapshot.submissionId));
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const remove = fs.rmdirSync;
  const blocked = t.mock.method(fs, "rmdirSync", (...args: Parameters<typeof remove>) => {
    if (args[0] === first.objectDirectory) throw Object.assign(new Error("lease still busy"), { code: "EBUSY" });
    return remove(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(first.release(), { code: "EBUSY" });
    await assert.rejects(f.service.materialize(request, signal), { code: "artifact_unavailable" });
  } finally {
    blocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal((await f.service.reconcile()).orphans, 0);
  const disk = t.mock.method(fs, "statfsSync", () => ({ bsize: 4096, bavail: 1 }));
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.service.materialize(request, signal), { code: "artifact_unavailable" });
    assert.deepEqual(readdirSync(join(f.root, "leases")), []);
    assert.ok(f.service.activeSnapshot(snapshot.submissionId));
  } finally {
    disk.mock.restore();
    syncBuiltinESMExports();
  }
  const retry = await f.service.materialize(request, signal);
  await retry.release();
  await f.service.release(snapshot.submissionId);
  await f.service.reconcile();
});

test("capture leaves free space on the state volume and releases failed reservations", async (t) => {
  const f = fixture(t);
  f.write("file", "submitted");
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const observed = fs.statfsSync(f.checkout);
  const disk = t.mock.method(fs, "statfsSync", () => ({ ...observed, bavail: 1 }));
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.prepare(), { code: "artifact_unavailable" });
    assert.deepEqual(readdirSync(join(f.root, "pending")), []);
  } finally {
    disk.mock.restore();
    syncBuiltinESMExports();
  }
  await f.service.discard(await f.prepare());
});

test("worktree growth after fstat retries without extending the read buffer", async (t) => {
  const f = fixture(t);
  f.write("growing", "a");
  const path = realpathSync(join(f.checkout, "growing"));
  const fs = (await import("node:fs/promises")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const open = fs.open;
  let grew = false;
  const inspect = t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
    const fd = await open(...args);
    if (String(args[0]) === path && !grew) {
      const stat = fd.stat.bind(fd);
      t.mock.method(fd, "stat", async () => {
        const observed = await stat();
        writeFileSync(path, "grown bytes");
        grew = true;
        return observed;
      });
      const read = fd.read.bind(fd);
      t.mock.method(fd, "read", (buf: Buffer, offset: number, length: number, position: number) => {
        assert.equal(buf.length, 2);
        return read(buf, offset, length, position);
      });
    }
    return fd;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.prepare(), RepositoryCaptureChanged);
  } finally {
    inspect.mock.restore();
    syncBuiltinESMExports();
  }
  assert.ok(grew);
  await f.service.discard(await f.prepare());
  assert.deepEqual(readdirSync(join(f.root, "pending")), []);
});

for (const kind of ["pending", "leases"] as const) {
  test(`failed ${kind} cleanup preserves the operation error and reconciliation retries without restart`, async (t) => {
    const f = fixture(t);
    f.write("a", "shared bytes");
    const snapshot = await f.service.promote(await f.prepare(), f.submission());
    f.store.commitRepositoryCaptureActivation(snapshot);
    const fs = (await import("node:fs")).default;
    const promises = (await import("node:fs/promises")).default;
    const { syncBuiltinESMExports } = await import("node:module");
    const writeFile = promises.writeFile;
    const code = kind === "pending" ? "ENOSPC" : "ENOENT";
    const warnings = t.mock.method(console, "warn", () => {});
    const write = t.mock.method(promises, "writeFile", (...args: Parameters<typeof writeFile>) => {
      const path = String(args[0]);
      if ((kind === "pending" && path.endsWith("/manifest.json")) ||
          (kind === "leases" && path.includes("/leases/") && path.includes("/objects/")))
        throw Object.assign(new Error("private write details"), { code });
      return writeFile(...args);
    });
    const failCleanup = () => { throw Object.assign(new Error("private cleanup details"), { code: "EBUSY" }); };
    // Fail once during payload deletion and once after the owner marker is unlinked.
    const cleanup = kind === "pending" ? t.mock.method(fs, "rmSync", failCleanup)
      : t.mock.method(fs, "rmdirSync", failCleanup);
    syncBuiltinESMExports();
    try {
      await assert.rejects(kind === "pending" ? f.prepare() : f.service.materialize(f.request(snapshot), signal),
        { code: "artifact_unavailable" });
    } finally {
      cleanup.mock.restore();
      write.mock.restore();
      syncBuiltinESMExports();
    }
    assert.deepEqual(warnings.mock.calls.map(call => call.arguments[0]), [
      `[workflow] event=repository_${kind === "pending" ? "pending" : "lease"}_cleanup error=EBUSY`,
      `[workflow] event=repository_${kind === "pending" ? "seal" : "materialize"} error=${code}`,
    ]);
    const dir = join(f.root, kind);
    const leftovers = readdirSync(dir);
    if (kind === "pending") {
      assert.equal(leftovers.length, 1);
      assert.ok(existsSync(join(dir, leftovers[0]!, "owner.json")));
    } else {
      assert.equal(leftovers.length, 2);
      assert.ok(leftovers.some(name => name.endsWith(".cleanup")));
    }
    assert.deepEqual(await f.service.reconcile(), { deleted: 1, orphans: 0 });
    assert.deepEqual(readdirSync(dir), []);
    const lease = await f.service.materialize(f.request(snapshot), signal);
    await lease.release();
    await f.service.release(snapshot.submissionId);
    await f.service.reconcile();
  });
}

for (const kind of ["pending", "leases"] as const) {
  test(`cleanup ownership survives process exit ${kind === "pending" ? "before" : "after"} removing a ${kind} directory`, async (t) => {
    const f = fixture(t);
    f.write("file", "submitted");
    const snapshot = await f.service.promote(await f.prepare(), f.submission());
    f.store.commitRepositoryCaptureActivation(snapshot);
    const request = f.request(snapshot);
    assert.throws(() => execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import fs from "node:fs";
      import { join } from "node:path";
      import { syncBuiltinESMExports } from "node:module";
      import { WorkflowStore } from "./src/server/workflows/store.ts";
      import { WorkflowRepositoryArtifactService } from "./src/server/workflows/repository-artifact/service.ts";
      const [root, checkout, kind, json] = process.argv.slice(1);
      const request = JSON.parse(json), signal = new AbortController().signal;
      const service = WorkflowRepositoryArtifactService.forRoot(new WorkflowStore(), root);
      service.setActiveRequestLookup(() => request);
      const allocation = kind === "pending" ? await service.prepare({ checkout, sourceBase: null }, signal)
        : await service.materialize(request, signal);
      const path = kind === "pending" ? join(fs.realpathSync(root), kind, allocation.id) : allocation.objectDirectory;
      const remove = fs.rmdirSync;
      fs.rmdirSync = (...args) => {
        if (args[0] !== path) return remove(...args);
        if (kind === "leases") remove(...args);
        process.exit(71);
      };
      syncBuiltinESMExports();
      if (kind === "pending") await service.discard(allocation);
      else await allocation.release();
    `, f.root, f.checkout, kind, JSON.stringify(request)]), { status: 71 });
    const parent = join(f.root, kind);
    const ticket = readdirSync(parent).find(name => name.endsWith(".cleanup"));
    assert.ok(ticket);
    const path = join(parent, ticket.split(".")[0]!);
    if (kind === "pending") {
      assert.deepEqual(readdirSync(path), []);
      const original = join(f.checkout, "..", "interrupted-removal");
      renameSync(path, original);
      mkdirSync(path);
      assert.equal((await f.service.reconcile()).orphans, 1);
      assert.deepEqual(readdirSync(path), []);
      assert.ok(existsSync(join(parent, ticket)));
      rmSync(path, { recursive: true });
      renameSync(original, path);
    } else assert.equal(existsSync(path), false);
    assert.deepEqual(await f.service.reconcile(), { deleted: 1, orphans: 0 });
    assert.deepEqual(readdirSync(parent), []);
    await f.service.release(snapshot.submissionId);
    await f.service.reconcile();
  });
}

test("failed owner marker writes and renames clean up only their new pending and lease directories", async (t) => {
  const f = fixture(t);
  const holder = await f.service.promote(await f.prepare(), f.submission());
  f.store.commitRepositoryCaptureActivation(holder);
  const other = await f.prepare();
  const lease = await f.service.materialize(f.request(holder), signal);
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const write = fs.writeFileSync, rename = fs.renameSync;
  const warnings = t.mock.method(console, "warn", () => {});
  for (const kind of ["pending", "leases"]) {
    const directory = join(f.root, kind);
    const before = readdirSync(directory);
    for (const operation of ["write", "rename"]) {
      const failure = Object.assign(new Error("marker installation failed"), { code: "EIO" });
      const install = operation === "write"
        ? t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof write>) => {
          if (String(args[0]).endsWith("/owner.tmp")) {
            write(args[0], "{");
            throw failure;
          }
          return write(...args);
        })
        : t.mock.method(fs, "renameSync", (...args: Parameters<typeof rename>) => {
          if (String(args[0]).endsWith("/owner.tmp")) throw failure;
          return rename(...args);
        });
      syncBuiltinESMExports();
      try {
        await assert.rejects(kind === "pending" ? f.prepare() : f.service.materialize(f.request(holder), signal),
          { code: "artifact_unavailable" });
      } finally {
        install.mock.restore();
        syncBuiltinESMExports();
      }
      assert.deepEqual(readdirSync(directory), before);
      assert.equal((await f.service.reconcile()).orphans, 0);
    }
  }
  assert.deepEqual(warnings.mock.calls.map(call => call.arguments[0]), [
    ...Array(2).fill("[workflow] event=repository_seal error=EIO"),
    ...Array(2).fill("[workflow] event=repository_materialize error=EIO"),
  ]);
  await lease.release();
  await f.service.discard(other);
  await f.service.release(holder.submissionId);
  await f.service.reconcile();
});

test("allocation sync failures stop pending and lease writers before their first payload", async (t) => {
  const storage = new RepositoryArtifactStorage();
  const f = fixture(t, "sha1", storage);
  f.write("file", "submitted");
  const holder = await f.service.promote(await f.prepare(), f.submission());
  f.store.commitRepositoryCaptureActivation(holder);
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const rename = fs.renameSync, fsync = fs.fsyncSync;
  const writes = t.mock.method(storage, "write");
  for (const kind of ["pending", "leases"]) {
    for (let fault = 0; fault < 4; fault++) {
      let allocation = "", observed = 0;
      const install = t.mock.method(fs, "renameSync", (...args: Parameters<typeof rename>) => {
        rename(...args);
        if (String(args[1]).endsWith("/owner.json")) allocation = dirname(String(args[1]));
      });
      const sync = t.mock.method(fs, "fsyncSync", (fd: number) => {
        if (allocation && fs.fstatSync(fd).isDirectory()) {
          const root = dirname(dirname(allocation));
          const expected = [allocation, dirname(allocation), root, dirname(root)][observed]!;
          assert.equal(fs.fstatSync(fd).ino, lstatSync(expected).ino);
          assert.deepEqual(readdirSync(allocation), ["owner.json"]);
          if (observed++ === fault) throw Object.assign(new Error("directory sync failed"), { code: "EIO" });
        }
        fsync(fd);
      });
      syncBuiltinESMExports();
      try {
        await assert.rejects(kind === "pending" ? f.prepare() : f.service.materialize(f.request(holder), signal),
          { code: "artifact_unavailable" });
        assert.equal(observed, fault + 1);
        assert.equal(writes.mock.callCount(), 0);
        assert.deepEqual(readdirSync(join(f.root, kind)), []);
      } finally {
        sync.mock.restore();
        install.mock.restore();
        syncBuiltinESMExports();
      }
    }
  }
  await f.service.discard(await f.prepare());
  const retry = await f.service.materialize(f.request(holder), signal);
  await retry.release();
  await f.service.release(holder.submissionId);
  await f.service.reconcile();
});

for (const [operation, replacement] of [
  ["verify", "file"], ["materialize", "symlink"], ["reconcile", "file"], ["verify", "missing"],
] as const) {
  test(`invalid digest namespace fails all ready artifacts during ${operation} (${replacement})`, async (t) => {
    const f = fixture(t);
    f.write("file", "first");
    const first = await f.service.promote(await f.prepare(), f.submission());
    f.store.commitRepositoryCaptureActivation(first);
    f.write("file", "second");
    const second = await f.service.promote(await f.prepare(), f.submission());
    f.store.commitRepositoryCaptureActivation(second);
    assert.notEqual(first.digest, second.digest);
    const root = realpathSync(join(f.root, "digests"));
    const run = () => {
      if (operation === "verify") return f.service.verify(first, signal);
      if (operation === "materialize") return f.service.materialize(f.request(first), signal);
      return f.service.reconcile();
    };
    const fs = (await import("node:fs")).default;
    const { syncBuiltinESMExports } = await import("node:module");
    const stat = fs.lstatSync;
    const fault = t.mock.method(fs, "lstatSync", (...args: Parameters<typeof stat>) => {
      if (String(args[0]) === root) throw Object.assign(new Error("read failed"), { code: "EIO" });
      return stat(...args);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(run(), { code: operation === "reconcile" ? "EIO" : "artifact_unavailable" });
    } finally {
      fault.mock.restore();
      syncBuiltinESMExports();
    }
    for (const s of [first, second]) assert.equal(f.service.activeSnapshot(s.submissionId)?.artifact.state, "ready");

    const saved = root + "-saved";
    renameSync(root, saved);
    if (replacement === "symlink") symlinkSync(saved, root);
    if (replacement === "file") writeFileSync(root, "unrelated bytes");
    await assert.rejects(run(), { code: "artifact_unavailable" });
    for (const s of [first, second]) {
      assert.equal(f.service.activeSnapshot(s.submissionId), null);
      const row = f.service.artifacts().find(a => a.digest === s.digest);
      assert.equal(row?.state, "failed");
      assert.equal(row?.verificationError, "artifact_unavailable");
    }
    if (replacement === "symlink") assert.ok(lstatSync(root).isSymbolicLink());
    if (replacement === "file") assert.equal(readFileSync(root, "utf8"), "unrelated bytes");
    if (replacement !== "missing") rmSync(root);
    else assert.equal(existsSync(root), false);
    renameSync(saved, root);
    const retried = await f.service.promote(await f.prepare(), f.submission());
    assert.equal(retried.digest, second.digest);
    assert.equal(f.service.activeSnapshot(second.submissionId)?.artifact.state, "ready");
    assert.equal(f.service.activeSnapshot(first.submissionId), null);
    for (const s of [first, second, retried]) await f.service.release(s.submissionId);
    await f.service.reconcile();
  });
}

test("materializing a damaged source object fails the shared digest for every holder", async (t) => {
  const f = fixture(t);
  f.write("file", "shared bytes");
  const first = await f.service.promote(await f.prepare(), f.submission());
  const second = await f.service.promote(await f.prepare(), f.submission());
  f.store.commitRepositoryCaptureActivation(first);
  f.store.commitRepositoryCaptureActivation(second);
  const path = join(f.root, "digests", first.digest, f.git("hash-object", "file"));
  chmodSync(path, 0o600);
  writeFileSync(path, "blob 12\0broken bytes");
  chmodSync(path, 0o400);
  await assert.rejects(f.service.materialize(f.request(first), signal), { code: "artifact_unavailable" });
  assert.equal(f.service.artifacts().find(row => row.digest === first.digest)?.state, "failed");
  for (const snapshot of [first, second]) {
    assert.equal(f.service.activeSnapshot(snapshot.submissionId), null);
    await f.service.release(snapshot.submissionId);
  }
  assert.deepEqual(readdirSync(join(f.root, "leases")), []);
  await f.service.reconcile();
});

test("artifact readiness guards first activation and a failed artifact permits later running transitions", async (t) => {
  const f = fixture(t);
  const snapshot = await f.service.promote(await f.prepare(), f.submission());
  const id = snapshot.submissionId;
  assert.throws(() => f.store.setSubmissionState(id, "running"), /repository claim is not active/);
  f.store.commitRepositoryCaptureActivation(snapshot);
  const warnings = t.mock.method(console, "warn", () => {});
  const cancelled = AbortSignal.abort(new TypeError("private cancellation details"));
  await assert.rejects(f.service.verify(snapshot, cancelled), { code: "artifact_unavailable" });
  rmSync(join(f.root, "digests", snapshot.digest, "manifest.json"));
  await assert.rejects(f.service.materialize(f.request(snapshot), signal), { code: "artifact_unavailable" });
  assert.equal(f.service.artifacts().find(artifact => artifact.digest === snapshot.digest)?.state, "failed");
  await assert.rejects(f.service.verify(snapshot, signal), { code: "artifact_unavailable" });
  assert.deepEqual(warnings.mock.calls.map(call => call.arguments[0]), [
    "[workflow] event=repository_verify error=TypeError",
    "[workflow] event=repository_materialize error=ENOENT",
    "[workflow] event=repository_verify error=artifact_unavailable",
  ]);
  assert.equal(f.store.updateSubmissionCapture(id, { context: {}, evidence: {} }).status, "running");
  f.store.setSubmissionState(id, "waiting_for_session");
  assert.equal(f.store.setSubmissionState(id, "running").status, "running");
  await assert.rejects(f.service.materialize(f.request(snapshot), signal), { code: "artifact_unavailable" });
  await f.service.release(id);
  await f.service.reconcile();
});

test("activation rolls back both writes and corruption and namespace substitution fail closed", async (t) => {
  const f = fixture(t);
  f.write("a", "allowed");
  const c = await f.prepare(),
    s = await f.service.promote(c, f.submission());
  for (const table of ["workflow_submissions", "workflow_repository_snapshot_claims"]) {
    f.db.exec(
      `CREATE TEMP TRIGGER injected BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'injected'); END`,
    );
    assert.throws(() => f.store.commitRepositoryCaptureActivation(s), /injected/);
    f.db.exec("DROP TRIGGER injected");
    assert.equal(
      f.db.prepare("SELECT status FROM workflow_submissions WHERE id=?").get(s.submissionId)?.status,
      "capturing",
    );
    assert.equal(
      f.db
        .prepare("SELECT state FROM workflow_repository_snapshot_claims WHERE submission_id=?")
        .get(s.submissionId)?.state,
      "provisional",
    );
  }
  f.store.commitRepositoryCaptureActivation(s);
  const artifact = join(f.root, "digests", c.digest),
    r = f.request(s);
  const lease = await f.service.materialize(r, signal);
  assert.equal(lease.descriptor.head, null);
  assert.deepEqual(lease.descriptor.retainedRevisions, []);
  await lease.release();
  const obj = join(
    artifact,
    readdirSync(artifact).find((p) => p !== "manifest.json")!,
  );
  chmodSync(obj, 0o600);
  writeFileSync(obj, "corrupt");
  chmodSync(obj, 0o400);
  await assert.rejects(f.service.verify(s, signal));
  assert.equal(f.service.artifacts().find(row => row.digest === s.digest)?.state, "failed");
  rmSync(obj);
  await assert.rejects(f.service.materialize(r, signal));
  assert.deepEqual(readdirSync(join(f.root, "leases")), []);
  f.db.prepare("DELETE FROM workflow_submissions WHERE id=?").run(s.submissionId);
  renameSync(artifact, artifact + "-saved");
  symlinkSync(f.checkout, artifact);
  await f.service.reconcile();
  assert.equal(f.service.artifacts()[0]?.cleanupError, "deletion_failed");
  assert.ok(lstatSync(artifact).isSymbolicLink() && existsSync(f.checkout));
  rmSync(artifact);
  renameSync(artifact + "-saved", artifact);
  await f.service.reconcile();
  assert.ok(!existsSync(artifact));
});

test("promotion repairs an owned corrupt digest from verified bytes and preserves both claims", async (t) => {
  const f = fixture(t);
  f.write("a", "submitted bytes");
  const first = await f.service.promote(await f.prepare(), f.submission());
  f.store.commitRepositoryCaptureActivation(first);
  const digestDir = join(f.root, "digests", first.digest);
  const object = f.git("hash-object", "a");
  const path = join(digestDir, object);
  const valid = readFileSync(path);
  rmSync(path);
  writeFileSync(path, "corrupt", { mode: 0o400 });
  await assert.rejects(f.service.verify(first, signal));

  const invalid = await f.prepare();
  rmSync(join(f.root, "pending", invalid.id, "artifact", object));
  const id = f.submission();
  await assert.rejects(f.service.promote(invalid, id));
  assert.equal(readFileSync(path, "utf8"), "corrupt");
  await f.service.discard(invalid);

  const candidate = await f.prepare();
  const unknown = join(digestDir, "foreign");
  mkdirSync(unknown);
  await assert.rejects(f.service.promote(candidate, id));
  assert.ok(lstatSync(unknown).isDirectory());
  const pending = join(f.root, "pending", candidate.id);
  assert.equal(existsSync(join(pending, "promotion")), false);
  await f.service.discard(candidate);
  assert.equal(existsSync(pending), false);
  // Replay an older intent written before discovering the foreign entry.
  const legacy = interruptedCapture(f);
  writeFileSync(join(f.root, "pending", legacy.id, "promotion"), legacy.digest);
  assert.deepEqual(await f.service.reconcile(), { deleted: 1, orphans: 0 });
  assert.ok(lstatSync(unknown).isDirectory());
  assert.equal(f.service.activeSnapshot(first.submissionId), null);
  rmSync(unknown, { recursive: true });
  const second = await f.service.promote(await f.prepare(), id);
  assert.equal(second.digest, first.digest);
  f.store.commitRepositoryCaptureActivation(second);
  assert.deepEqual(readFileSync(path), valid);
  for (const claim of [first, second]) {
    const lease = await f.service.materialize(f.request(claim), signal);
    assert.equal(lease.descriptor.worktree.find(entry => entry.path === "a")?.blob, object);
    await lease.release();
    await f.service.release(claim.submissionId);
  }
  assert.deepEqual(readdirSync(join(f.root, "pending")), []);
  await f.service.reconcile();
});

for (const published of [false, true]) {
  test(`interrupted digest replacement recovers ${published ? "after" : "before"} the final rename`, async (t) => {
    const f = fixture(t);
    f.write("file", "intact bytes");
    const holder = await f.service.promote(await f.prepare(), f.submission());
    f.store.commitRepositoryCaptureActivation(holder);
    const dest = join(f.root, "digests", holder.digest);
    rmSync(join(dest, "manifest.json"));
    await assert.rejects(f.service.verify(holder, signal));
    const candidate = interruptedCapture(f);
    assert.equal(candidate.digest, holder.digest);
    const pending = join(f.root, "pending", candidate.id);
    writeFileSync(join(pending, "promotion"), holder.digest);
    renameSync(dest, join(pending, "previous"));
    if (published) renameSync(join(pending, "artifact"), dest);

    assert.equal((await f.service.reconcile()).orphans, 0);
    assert.equal(existsSync(pending), false);
    assert.deepEqual(f.db.prepare(
      "SELECT submission_id, state FROM workflow_repository_snapshot_claims WHERE digest=?",
    ).all(holder.digest).map(row => [row.submission_id, row.state]), [[holder.submissionId, "active"]]);
    const lease = await f.service.materialize(f.request(holder), signal);
    assert.equal(lease.descriptor.worktree.find(entry => entry.path === "file")?.blob, f.git("hash-object", "file"));
    await lease.release();
    await f.service.release(holder.submissionId);
    await f.service.reconcile();
  });
}

for (const when of ["before", "after"]) {
  test(`missing digest repair survives process exit ${when} publishing the candidate`, async (t) => {
    const f = fixture(t);
    f.write("file", "holder bytes");
    const holder = await f.service.promote(await f.prepare(), f.submission());
    f.store.commitRepositoryCaptureActivation(holder);
    const dest = join(realpathSync(f.root), "digests", holder.digest);
    rmSync(dest, { recursive: true });
    await assert.rejects(f.service.verify(holder, signal), { code: "artifact_unavailable" });
    const incoming = f.submission();
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import { WorkflowStore } from "./src/server/workflows/store.ts";
      import { WorkflowRepositoryArtifactService } from "./src/server/workflows/repository-artifact/service.ts";
      const [root, checkout, dest, submissionId, when] = process.argv.slice(1);
      const service = WorkflowRepositoryArtifactService.forRoot(new WorkflowStore(), root);
      const candidate = await service.prepare({ checkout, sourceBase: null }, new AbortController().signal);
      const rename = fs.renameSync;
      fs.renameSync = (from, to) => {
        if (to === dest && when === "before") process.exit(0);
        rename(from, to);
        if (to === dest && when === "after") process.exit(0);
      };
      syncBuiltinESMExports();
      await service.promote(candidate, submissionId);
      throw new Error("promotion missed simulated crash");
    `, f.root, f.checkout, dest, incoming, when]);
    const [candidate] = readdirSync(join(f.root, "pending"));
    assert.ok(candidate);
    const pending = join(f.root, "pending", candidate);
    assert.equal(readFileSync(join(pending, "promotion"), "utf8"), holder.digest);
    assert.equal(existsSync(join(pending, "previous")), false);
    assert.equal(existsSync(dest), when === "after");
    // Recovery may have to recreate the entire digest namespace as well as the leaf.
    if (when === "before") rmSync(join(f.root, "digests"), { recursive: true });
    assert.equal(f.service.activeSnapshot(holder.submissionId), null);
    if (when === "after") {
      const blob = join(dest, f.git("hash-object", "file"));
      const valid = readFileSync(blob);
      chmodSync(blob, 0o600);
      writeFileSync(blob, "bad");
      chmodSync(blob, 0o400);
      assert.equal((await f.service.reconcile()).orphans, 1);
      assert.equal(f.service.activeSnapshot(holder.submissionId), null);
      assert.ok(existsSync(pending));
      chmodSync(blob, 0o600);
      writeFileSync(blob, valid);
      chmodSync(blob, 0o400);
    }
    assert.equal((await f.service.reconcile()).orphans, 0);
    assert.equal(existsSync(pending), false);
    assert.deepEqual(f.db.prepare("SELECT submission_id, state FROM workflow_repository_snapshot_claims WHERE digest=?")
      .all(holder.digest).map(row => [row.submission_id, row.state]), [[holder.submissionId, "active"]]);
    const lease = await f.service.materialize(f.request(holder), signal);
    assert.equal(lease.descriptor.worktree.find(e => e.path === "file")?.blob, f.git("hash-object", "file"));
    await lease.release();
    await f.service.release(holder.submissionId);
    await f.service.reconcile();
  });
}

test("promotion preserves an unowned corrupt directory at the candidate digest", async (t) => {
  const f = fixture(t);
  const candidate = await f.prepare();
  const dest = join(f.root, "digests", candidate.digest);
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "manifest.json"), "unowned", { mode: 0o400 });
  await assert.rejects(f.service.promote(candidate, f.submission()), { code: "artifact_unavailable" });
  await f.service.discard(candidate);
  assert.equal(readFileSync(join(dest, "manifest.json"), "utf8"), "unowned");
  assert.equal((await f.service.reconcile()).orphans, 1);
});

test("cleanup records a retry and logs the filesystem code when unlink fails", async (t) => {
  const f = fixture(t);
  const snapshot = await f.service.promote(await f.prepare(), f.submission());
  await f.service.release(snapshot.submissionId);
  const warnings = t.mock.method(console, "warn", () => {});
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const unlink = t.mock.method(fs, "unlinkSync", () => {
    throw Object.assign(new Error("private path"), { code: "EBUSY" });
  });
  syncBuiltinESMExports();
  try {
    await f.service.reconcile();
  } finally {
    unlink.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(f.service.artifacts()[0]?.cleanupError, "deletion_failed");
  assert.deepEqual(warnings.mock.calls.map(call => call.arguments[0]), [
    "[workflow] event=repository_digest_cleanup error=EBUSY",
  ]);
  await f.service.reconcile();
  assert.deepEqual(f.service.artifacts(), []);
});

test("digest deletion keeps cleanup ownership until the parent sync succeeds on retry", async (t) => {
  const f = fixture(t);
  const snapshot = await f.service.promote(await f.prepare(), f.submission());
  await f.service.release(snapshot.submissionId);
  const parent = join(f.root, "digests"), path = join(parent, snapshot.digest);
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const inode = lstatSync(parent).ino, sync = fs.fsyncSync;
  let attempts = 0;
  const fail = t.mock.method(fs, "fsyncSync", (fd: number) => {
    if (fs.fstatSync(fd).ino === inode) {
      assert.equal(existsSync(path), false);
      attempts++;
      throw Object.assign(new Error("directory sync failed"), { code: "EIO" });
    }
    sync(fd);
  });
  syncBuiltinESMExports();
  try {
    for (let n = 1; n <= 2; n++) {
      assert.equal((await f.service.reconcile()).deleted, 0);
      assert.equal(attempts, n);
      assert.equal(f.service.artifacts().find(row => row.digest === snapshot.digest)?.state, "cleanup_pending");
      assert.ok(f.db.prepare("SELECT 1 FROM workflow_repository_snapshot_claims WHERE submission_id=?").get(snapshot.submissionId));
    }
  } finally {
    fail.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(await f.service.reconcile(), { deleted: 1, orphans: 0 });
  assert.deepEqual(f.service.artifacts(), []);
  assert.equal(f.db.prepare("SELECT 1 FROM workflow_repository_snapshot_claims WHERE submission_id=?").get(snapshot.submissionId), undefined);
});

test("capture discards stale candidates on retry and on boundary exceptions", async () => {
  const discarded: number[] = [];
  let n = 0;
  const read = async () => ++n;
  const seam = {
    sampleBoundary: async () => "same",
    stillCurrent: async () => true,
    prepare: async (value: number) => ({ value, boundary: "same" }),
    discard: async (candidate: { value: number; boundary: string }) => {
      discarded.push(candidate.value);
    },
  };
  const result = await captureStableWorkflowContext(read, async (value) => value === 1, seam);
  assert.deepEqual(result, { captured: 2, candidate: { value: 2, boundary: "same" } });
  await assert.rejects(
    captureStableWorkflowContext(
      read,
      async () => {
        throw Error("guard");
      },
      seam,
    ),
  );
  assert.deepEqual(discarded, [1, 3]);
});

test("a discard filesystem failure preserves retry, exhaustion and the original guard error", async (t) => {
  const f = fixture(t);
  f.write("submitted", "stable bytes");
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const warnings = t.mock.method(console, "warn", () => {});
  const original = fs.rmSync;
  for (const outcome of ["retry", "exhausted", "guard-error"]) {
    const stale = new Set<string>();
    let reads = 0;
    const guardError = new Error("guard rejected the submission");
    const blocked = t.mock.method(fs, "rmSync", (...args: Parameters<typeof original>) => {
      if (stale.has(dirname(String(args[0])))) throw Object.assign(new Error("private path"), { code: "EBUSY" });
      return original(...args);
    });
    syncBuiltinESMExports();
    let accepted: Awaited<ReturnType<typeof f.prepare>> | undefined;
    try {
      const capture = captureStableWorkflowContext(async () => ++reads, async () => {
        if (outcome === "guard-error") throw guardError;
        return outcome === "exhausted" || reads === 1;
      }, {
        sampleBoundary: () => f.service.sampleBoundary(f.checkout, signal),
        prepare: () => f.prepare(),
        stillCurrent: c => f.service.stillCurrent(c, signal),
        discard: async c => {
          stale.add(realpathSync(join(f.root, "pending", c.id)));
          await f.service.discard(c);
        },
      });
      if (outcome === "guard-error") await assert.rejects(capture, error => error === guardError);
      else {
        const result = await capture;
        if (outcome === "retry") {
          assert.equal(result?.captured, 2);
          accepted = result!.candidate;
        } else assert.equal(result, null);
      }
      assert.equal(reads, outcome === "guard-error" ? 1 : 2);
    } finally {
      blocked.mock.restore();
      syncBuiltinESMExports();
    }
    assert.deepEqual(await f.service.reconcile(), { deleted: stale.size, orphans: 0 });
    assert.deepEqual(readdirSync(join(f.root, "pending")), accepted ? [accepted.id] : []);
    if (accepted) await f.service.discard(accepted);
  }
  assert.deepEqual(warnings.mock.calls.map(c => c.arguments[0]), Array(4).fill("[workflow] event=repository_pending_cleanup error=EBUSY"));
});

test("ambiguous allowed and sensitive object aliases, missing selected objects, and cancellation produce no claim", async (t) => {
  const f = fixture(t);
  f.write(".env", "same");
  f.write("elsewhere", "same");
  await assert.rejects(f.prepare());
  rmSync(join(f.checkout, ".env"));
  f.git("add", "elsewhere");
  f.git("commit", "-qm", "base");
  const historical = f.git("rev-parse", "HEAD:elsewhere");
  f.write("elsewhere", "new");
  f.git("commit", "-qam", "next");
  rmSync(join(f.checkout, ".git/objects", historical.slice(0, 2), historical.slice(2)));
  await assert.rejects(f.prepare());
  await assert.rejects(f.service.prepare({ checkout: f.checkout, sourceBase: null }, AbortSignal.abort()));
  assert.deepEqual(readdirSync(join(f.root, "pending")), []);
  assert.deepEqual(f.service.artifacts(), []);
});

for (const format of ["sha1", "sha256"]) {
  test(`empty blob aliases in ${format} preserve allowed bytes and deny the sensitive path`, async (t) => {
    const f = fixture(t, format);
    f.write(".env", "");
    f.git("add", ".env");
    f.git("commit", "-qm", "empty placeholder");
    const empty = f.git("rev-parse", "HEAD:.env");
    f.write(".env", "private");
    f.write("__init__.py", "");
    const snapshot = await f.service.promote(await f.prepare(), f.submission());
    f.store.commitRepositoryCaptureActivation(snapshot);
    const artifact = join(f.root, "digests", snapshot.digest);
    assert.deepEqual(readFileSync(join(artifact, empty)), Buffer.from("blob 0\0"));
    assert.equal(existsSync(join(artifact, f.git("hash-object", ".env"))), false);
    const request = f.request(snapshot);
    const lease = await f.service.materialize(request, signal);
    const reader = createRepositoryReader({
      view: lease.descriptor,
      objectDirectory: lease.objectDirectory,
      workloadId: request.workloadId,
      attemptId: request.attemptId,
      gitBinary: "git",
      signal,
      budgets: {},
      audit: async () => {},
    });
    assert.equal((await reader.query("read", { path: "__init__.py" })).status, "ok");
    assert.equal((await reader.query("read", { path: ".env" })).code, "denied_path");
    await lease.release();
    await f.service.release(snapshot.submissionId);
    await f.service.reconcile();
  });
}

for (const parent of ["sha1", "sha256"]) {
  test(`embedded repositories must have a gitlink representable in a ${parent} parent tree`, async (t) => {
    const f = fixture(t, parent);
    const initNested = (format: string) => {
      f.git("init", "-q", "--object-format=" + format, "nested");
      f.git("-C", "nested", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
        "commit", "-qm", "nested tip", "--allow-empty");
      return f.git("-C", "nested", "rev-parse", "HEAD");
    };
    const incompatibleChild = initNested(parent === "sha1" ? "sha256" : "sha1");
    assert.equal(f.git("ls-files", "--others", "--exclude-standard"), "nested/");
    await assert.rejects(f.service.sampleBoundary(f.checkout, signal), { code: "artifact_unavailable" });
    await assert.rejects(f.prepare(), { code: "artifact_unavailable" });
    assert.deepEqual(f.service.artifacts(), []);
    assert.deepEqual(readdirSync(join(f.root, "pending")), []);
    rmSync(join(f.checkout, "nested"), { recursive: true });
    const child = initNested(parent);
    const snapshot = await f.service.promote(await f.prepare(), f.submission());
    f.store.commitRepositoryCaptureActivation(snapshot);
    const lease = await f.service.materialize(f.request(snapshot), signal);
    const entry = lease.descriptor.worktree.find(e => e.path === "nested");
    assert.equal(entry?.kind, "submodule");
    assert.equal(entry.blob, child);
    const tree = Buffer.concat([Buffer.from("160000 nested\0"), Buffer.from(child, "hex")]);
    assert.deepEqual(readFileSync(join(f.root, "digests", snapshot.digest, lease.descriptor.worktreeTree)),
      Buffer.concat([Buffer.from(`tree ${tree.length}\0`), tree]));
    assert.equal(existsSync(join(f.root, "digests", snapshot.digest, child)), false);
    const legacy = manifestSchema.parse(JSON.parse(readFileSync(join(f.root, "digests", snapshot.digest, "manifest.json"), "utf8")));
    const legacyLink = legacy.view.worktree.find(e => e.path === "nested");
    assert.ok(legacyLink);
    legacyLink.blob = incompatibleChild;
    assert.throws(() => descriptor(legacy, snapshot.digest, "legacy"), { code: "artifact_unavailable" });
    await lease.release();
    await f.service.release(snapshot.submissionId);
    await f.service.reconcile();
  });
}

test("raw path identity and gitlinks survive a round trip without following the submodule", async (t) => {
  const f = fixture(t);
  f.write("text", "version one");
  f.git("add", ".");
  f.git("commit", "-qm", "first");
  const linkId = f.git("rev-parse", "HEAD");
  f.git("update-index", "--add", "--cacheinfo", "160000," + linkId + ",vendor");
  mkdirSync(join(f.checkout, "vendor"));
  writeFileSync(join(f.checkout, "vendor", "hidden"), "SECRET-submodule");
  const raw = Buffer.concat([Buffer.from(f.checkout + "/"), Buffer.from([255])]);
  let bytePath = true;
  try {
    writeFileSync(raw, "SECRET-unaddressable");
  } catch (e) {
    if (!["EILSEQ", "EINVAL", "EPERM"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
    bytePath = false;
  }
  f.write("Case", "ONE");
  f.write("case", "two");
  const caseSensitive = readFileSync(join(f.checkout, "Case"), "utf8") === "ONE";
  const candidate = await f.prepare();
  const s = await f.service.promote(candidate, f.submission());
  f.store.commitRepositoryCaptureActivation(s);
  const lease = await f.service.materialize(f.request(s), signal);
  assert.equal(lease.descriptor.worktree.find((e) => e.path === "vendor")?.blob, linkId);
  assert.equal(lease.descriptor.worktree.find((e) => e.path === "vendor")?.kind, "submodule");
  assert.equal(
    lease.descriptor.worktree.some((e) => e.path.startsWith("vendor/")),
    false,
  );
  if (caseSensitive)
    assert.ok(["Case", "case"].every((path) => lease.descriptor.worktree.some((e) => e.path === path)));
  const path = join(f.root, "digests", s.digest);
  const manifest = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8"));
  if (bytePath)
    assert.deepEqual(
      manifest.paths.find((p: { bytes: string }) => p.bytes === "ff"),
      { bytes: "ff", allowed: false, classifications: ["untracked", "sensitive_denied"] },
    );
  for (const file of readdirSync(path)) assert.ok(!readFileSync(join(path, file)).includes("SECRET-"));
  await lease.release();
  await f.service.release(s.submissionId);
  await f.service.reconcile();
});

// Build immutable fixture history directly. Thousands of individual git invocations would
// make the production limit prohibitively expensive to exercise on every CI shard.
function objects(checkout: string) {
  function write(type: string, body: Buffer) {
    const bytes = Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]);
    const id = createHash("sha1").update(bytes).digest("hex");
    const dir = join(checkout, ".git/objects", id.slice(0, 2));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, id.slice(2)), deflateSync(bytes));
    return id;
  }
  return {
    write,
    commit(tree: string, parents: string[], message: string) {
      return write(
        "commit",
        Buffer.from(
          [
            `tree ${tree}`,
            ...parents.map((p) => "parent " + p),
            "author Fixture <a@test> 123 +0000",
            "committer Fixture <a@test> 123 +0000",
            "",
            message,
            "",
          ].join("\n"),
        ),
      );
    },
  };
}

test("object reads refuse linked loose files, fanout directories, pack files, indexes and alternates", async (t) => {
  const f = fixture(t);
  f.write("a", "fixture bytes");
  f.git("add", "a");
  f.git("commit", "-qm", "contained object");
  const head = f.git("rev-parse", "HEAD");
  const objects = join(f.checkout, ".git", "objects");
  async function requiresOrdinary(path: string) {
    const held = join(f.checkout, "..", "held");
    renameSync(path, held);
    symlinkSync(held, path);
    try {
      await assert.rejects(f.prepare(), { code: "artifact_unavailable" });
      assert.deepEqual(readdirSync(join(f.root, "pending")), []);
    } finally {
      rmSync(path);
      renameSync(held, path);
    }
  }
  const fanout = join(objects, head.slice(0, 2));
  await requiresOrdinary(join(fanout, head.slice(2)));
  await requiresOrdinary(fanout);
  await f.service.discard(await f.prepare(head.slice(0, 9)));
  f.git("repack", "-ad");
  const pack = join(objects, "pack");
  for (const ext of [".idx", ".pack"]) await requiresOrdinary(join(pack, readdirSync(pack).find(s => s.endsWith(ext))!));
  for (const name of ["alternates", "http-alternates"]) {
    const path = join(objects, "info", name);
    writeFileSync(path, "");
    await assert.rejects(f.prepare(), { code: "artifact_unavailable" });
    rmSync(path);
  }
  const packed = await f.prepare(head.slice(0, 9));
  const snapshot = await f.service.promote(packed, f.submission());
  f.store.commitRepositoryCaptureActivation(snapshot);
  rmSync(f.checkout, { recursive: true });
  const lease = await f.service.materialize(f.request(snapshot), signal);
  assert.deepEqual(lease.descriptor.retainedRevisions.map(e => e.id), [head]);
  assert.equal(lease.descriptor.base, head);
  await lease.release();
  await f.service.release(snapshot.submissionId);
  await f.service.reconcile();
});

test("abbreviated bases require one distinct object across loose and packed storage", async (t) => {
  const f = fixture(t);
  const tree = f.git("write-tree");
  const header = "tree " + tree + "\nauthor Fixture <a@example.test> 1 +0000\ncommitter Fixture <a@example.test> 1 +0000\n\n";
  // These three messages give different commit IDs beginning with 18c7.
  const bodies = [1177, 2196, 3265].map(n => header + n + "\n");
  const input = f.checkout + "-commit";
  const writeCommit = (body: string) => {
    writeFileSync(input, body);
    return f.git("hash-object", "-w", "-t", "commit", input);
  };
  const packed = bodies.slice(0, 2).map(writeCommit);
  packed.forEach((id, i) => f.git("update-ref", "refs/heads/packed-" + i, id));
  const first = packed[0]!;
  const loosePath = join(f.checkout, ".git", "objects", first.slice(0, 2), first.slice(2));
  const copy = readFileSync(loosePath);
  f.git("repack", "-ad");
  assert.equal(existsSync(loosePath), false);
  const loose = writeCommit(bodies[2]!);
  const prefix = loose.slice(0, 4);
  assert.deepEqual(f.git("rev-parse", "--disambiguate=" + prefix).split("\n").sort(), [...packed, loose].sort());
  await assert.rejects(f.prepare(prefix), { code: "artifact_unavailable" });
  assert.deepEqual(readdirSync(join(f.root, "pending")), []);
  // Two storage locations for one ID still give one unambiguous base.
  mkdirSync(dirname(loosePath), { recursive: true });
  writeFileSync(loosePath, copy);
  for (const id of [first, packed[1]!, loose]) {
    const candidate = await f.prepare(id.slice(0, 12));
    const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(f.root, "pending", candidate.id, "artifact", "manifest.json"), "utf8")));
    assert.equal(manifest.view.base, id);
    await f.service.discard(candidate);
  }
});

test("a depth-two clone seals its declared frontier, rejects a missing undeclared parent and reads after deletion", async (t) => {
  const f = fixture(t);
  const revisions: string[] = [];
  for (const content of ["old", "boundary", "tip"]) {
    f.write("a", content + "\n");
    f.git("add", "a");
    f.git("commit", "-qm", content);
    revisions.push(f.git("rev-parse", "HEAD"));
  }
  const [old, boundary, tip] = revisions as [string, string, string];
  const checkout = join(f.checkout, "..", "shallow-clone");
  f.git("clone", "-q", "--depth=2", pathToFileURL(f.checkout).href, checkout);
  const marker = join(checkout, ".git", "shallow");
  assert.equal(readFileSync(marker, "utf8"), boundary + "\n");
  const prepare = () => f.service.prepare({ checkout, sourceBase: null }, signal);
  const candidate = await prepare();
  rmSync(marker);
  assert.equal(await f.service.stillCurrent(candidate, signal), false);
  await assert.rejects(prepare(), { code: "artifact_unavailable" });
  writeFileSync(marker, boundary + "\n");
  assert.equal(await f.service.stillCurrent(candidate, signal), true);
  const snapshot = await f.service.promote(candidate, f.submission());
  f.store.commitRepositoryCaptureActivation(snapshot);
  rmSync(checkout, { recursive: true });
  rmSync(f.checkout, { recursive: true });
  const request = f.request(snapshot);
  const lease = await f.service.materialize(request, signal);
  assert.deepEqual(lease.descriptor.retainedRevisions.map(rev => rev.id), [tip, boundary]);
  assert.deepEqual(lease.descriptor.frontier, [{ revision: boundary, omittedParents: [old] }]);
  assert.equal(readFileSync(join(lease.objectDirectory, "shallow"), "utf8"), boundary + "\n");
  const reader = createRepositoryReader({
    view: lease.descriptor, objectDirectory: lease.objectDirectory, gitBinary: "git",
    workloadId: request.workloadId, attemptId: request.attemptId, signal, budgets: {}, audit: async () => {},
  });
  assert.equal((await reader.query("git_log", {})).itemCount, 2);
  assert.equal((await reader.query("git_show", { revision: old })).code, "revision_out_of_range");
  assert.equal((await reader.query("git_show", { revision: boundary, patch: true })).code, "history_boundary");
  const blame = await reader.query("git_blame", { revision: boundary, path: "a", startLine: 1, endLineExclusive: 2 });
  assert.equal(blame.status, "ok");
  assert.equal(blame.historyTruncated, true);
  await lease.release();
  await f.service.release(snapshot.submissionId);
  await f.service.reconcile();
});

test("a shallow merge preserves the breadth-first prefix when another branch has deeper history", async (t) => {
  const f = fixture(t);
  const tree = f.git("write-tree");
  const { commit } = objects(f.checkout);
  const omitted = commit(tree, [], "parent beyond shallow boundary");
  const boundary = commit(tree, [omitted], "shallow boundary");
  const deeper = commit(tree, [], "available parent");
  const other = commit(tree, [deeper], "other branch");
  const tip = commit(tree, [boundary, other], "merge");
  f.git("update-ref", "HEAD", tip);
  writeFileSync(join(f.checkout, ".git", "shallow"), boundary + "\n");
  const snapshot = await f.service.promote(await f.prepare(), f.submission());
  f.store.commitRepositoryCaptureActivation(snapshot);
  const lease = await f.service.materialize(f.request(snapshot), signal);
  assert.deepEqual(lease.descriptor.retainedRevisions.map(rev => rev.id), [tip, boundary, other]);
  assert.deepEqual(lease.descriptor.frontier, [
    { revision: boundary, omittedParents: [omitted] }, { revision: other, omittedParents: [deeper] },
  ]);
  await lease.release();
  await f.service.release(snapshot.submissionId);
  await f.service.reconcile();
});

test("wide merges preserve the largest representable breadth-first prefix and diff-only base", async (t) => {
  const f = fixture(t);
  const { write, commit } = objects(f.checkout);
  const tree = write("tree", Buffer.alloc(0));
  const roots = Array.from({ length: 101 }, (_, i) => commit(tree, [], String(i)));
  const wide = commit(tree, roots, "101 parents");
  const parents = [wide, ...roots.slice(1, 100)];
  const head = commit(tree, parents, "100 parents");
  f.git("update-ref", "HEAD", head);
  const candidate = await f.prepare(wide);
  const artifact = join(f.root, "pending", candidate.id, "artifact");
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(artifact, "manifest.json"), "utf8")));
  assert.deepEqual(manifest.view.retainedRevisions, [{ id: head, tree, parents }]);
  assert.deepEqual(manifest.view.frontier, [{ revision: head, omittedParents: parents }]);
  assert.equal(manifest.view.base, wide);
  assert.equal(existsSync(join(artifact, wide)), true);
  assert.equal(existsSync(join(artifact, roots[0]!)), false);
  await f.service.discard(candidate);
  f.git("update-ref", "HEAD", wide);
  await assert.rejects(f.prepare(), { code: "artifact_unavailable" });
  assert.deepEqual(readdirSync(join(f.root, "pending")), []);
});

test("history sealing releases commit and tree payloads during a zero-blob history walk", (t) => {
  const f = fixture(t);
  const { write, commit } = objects(f.checkout);
  const revisions: string[] = [], trees: string[] = [];
  for (let i = 0; i < 24; i++) {
    // Distinct trees of gitlinks add no blob bytes to the history budget.
    const entries = Array.from({ length: 96 }, (_, j) => Buffer.concat([
      Buffer.from(`160000 module-${String(j).padStart(3, "0")}\0`), Buffer.alloc(20, i + 1),
    ]));
    const tree = write("tree", Buffer.concat(entries));
    trees.push(tree);
    revisions.push(commit(tree, revisions.slice(-1), "m".repeat(16 * 1024)));
  }
  f.git("update-ref", "HEAD", revisions.at(-1)!);
  const pending = join(f.root, "probe");
  mkdirSync(pending, { recursive: true });
  const probeCommit = revisions[1]!;
  const result = execFileSync(process.execPath, ["--expose-gc", "--import", "./test/setup-state.mjs",
    "--import", "tsx", "test/helpers/repository-history-buffers.mjs", f.checkout, pending, probeCommit,
    f.git("cat-file", "-s", probeCommit), f.git("cat-file", "-s", trees[1]!)], { encoding: "utf8" });
  const sample = JSON.parse(result.trim());
  for (const kind of ["commits", "trees"]) {
    t.diagnostic(`${kind}: ${sample[kind].live} of ${sample[kind].allocated} payload buffers live at the traversal checkpoint`);
    assert.ok(sample[kind].allocated >= 20, `expected the probe to see earlier ${kind}`);
    assert.ok(sample[kind].live <= 3, `earlier ${kind} still occupy ${sample[kind].live} buffers`);
  }
  const artifact = join(pending, "artifact");
  const manifest = JSON.parse(readFileSync(join(artifact, "manifest.json"), "utf8"));
  assert.equal(manifest.view.retainedBlobBytes, 0);
  assert.deepEqual(manifest.view.retainedRevisions.map((r: { id: string }) => r.id), [...revisions].reverse());
  for (const id of [...revisions, ...trees])
    assert.equal(createHash("sha1").update(readFileSync(join(artifact, id))).digest("hex"), id);
});

test("2,048-commit breadth-first merge prefix survives source deletion with shallow blame and diff-only base", async (t) => {
  const f = fixture(t);
  f.write("a", "first\n");
  f.git("add", ".");
  f.git("commit", "-qm", "base");
  const base = f.git("rev-parse", "HEAD"),
    tree = f.git("rev-parse", "HEAD^{tree}");
  const { commit } = objects(f.checkout);
  const left = [base],
    right = [base];
  for (let i = 0; i < 1025; i++) {
    left.push(commit(tree, [left.at(-1)!], "left " + i));
    right.push(commit(tree, [right.at(-1)!], "right " + i));
  }
  const head = commit(tree, [left.at(-1)!, right.at(-1)!], "merge");
  f.git("update-ref", "HEAD", head);
  const expected = [head];
  for (let i = 1025; i > 0 && expected.length < 2048; i--) expected.push(left[i]!, right[i]!);
  const candidate = await f.prepare(base);
  const second = await f.prepare(base);
  assert.equal(second.digest, candidate.digest);
  await f.service.discard(second);
  const s = await f.service.promote(candidate, f.submission());
  f.store.commitRepositoryCaptureActivation(s);
  rmSync(f.checkout, { recursive: true });
  const r = f.request(s),
    lease = await f.service.materialize(r, signal);
  const view = lease.descriptor;
  assert.deepEqual(
    view.retainedRevisions.map((rec) => rec.id),
    expected.slice(0, 2048),
  );
  assert.equal(view.retainedBlobBytes, 0);
  assert.equal(view.frontier.length, 2);
  const reader = createRepositoryReader({
    view,
    objectDirectory: lease.objectDirectory,
    gitBinary: "git",
    workloadId: r.workloadId,
    attemptId: r.attemptId,
    signal,
    budgets: {},
    audit: async () => {},
  });
  const frontier = view.frontier[0]!.revision;
  assert.equal(
    (await reader.query("git_show", { revision: frontier, patch: true })).code,
    "history_boundary",
  );
  assert.equal((await reader.query("git_show", { revision: frontier })).status, "ok");
  assert.equal(
    (await reader.query("git_blame", { revision: frontier, path: "a", startLine: 1, endLineExclusive: 2 }))
      .historyTruncated,
    true,
  );
  for (const revision of [base, ...view.frontier.flatMap((v) => v.omittedParents)])
    assert.equal((await reader.query("git_log", { revision })).code, "revision_out_of_range");
  assert.equal((await reader.query("git_diff", { pair: "base_head" })).status, "ok");
  await lease.release();
  await f.service.release(s.submissionId);
  await f.service.reconcile();
});

for (const layer of ["staged", "untracked", "mixed"]) {
  test(`checkout path budgets reject ${layer} names before reading working bytes`, async (t) => {
    const f = fixture(t);
    mkdirSync(join(f.checkout, "dir"));
    const files = ["dir/a", "dir/.env", "dir/a:b"];
    for (const file of files) f.write(file, "contents");
    if (layer === "staged") f.git("add", ".");
    if (layer === "mixed") f.git("add", "dir/a");
    const pathBytes = "dir".length + files.reduce((n, path) => n + Buffer.byteLength(path), 0);
    const fs = (await import("node:fs/promises")).default;
    const { syncBuiltinESMExports } = await import("node:module");
    const open = fs.open;
    let reads = 0;
    const watch = t.mock.method(fs, "open", (...args: Parameters<typeof open>) => {
      if (String(args[0]).startsWith(realpathSync(f.checkout) + "/dir/")) reads++;
      return open(...args);
    });
    syncBuiltinESMExports();
    try {
      for (const limits of [{ entries: 3, pathBytes }, { entries: 4, pathBytes: pathBytes - 1 }]) {
        await assert.rejects(sampleCheckoutBoundary(f.checkout, signal, limits), { code: "tree_expansion_limit" });
        await assert.rejects(seal({ checkout: f.checkout, sourceBase: null }, f.root, signal, limits),
          { code: "tree_expansion_limit" });
      }
      assert.equal(reads, 0);
      assert.equal(existsSync(join(f.root, "artifact")), false);
      await sampleCheckoutBoundary(f.checkout, signal, { entries: 4, pathBytes });
      assert.equal(reads, 3);
    } finally {
      watch.mock.restore();
      syncBuiltinESMExports();
    }
  });
}

for (const limit of [{ entries: 4, pathBytes: 100 }, { entries: 100, pathBytes: 12 }]) {
  test(`tree expansion bounds ${limit.entries === 4 ? "entry count" : "path bytes"} across shared subtrees`, async (t) => {
    const f = fixture(t);
    const { write, commit } = objects(f.checkout);
    const empty = write("tree", Buffer.alloc(0));
    const blob = write("blob", Buffer.from("old"));
    const leaf = write("tree", Buffer.concat([Buffer.from("100644 f\0"), Buffer.from(blob, "hex")]));
    const subtree = (names: string[]) => write("tree", Buffer.concat(names.map(name =>
      Buffer.concat([Buffer.from("40000 " + name + "\0"), Buffer.from(leaf, "hex")]))));
    const excluded = commit(subtree(["aa", "bb", "cc"]), [], "three subtrees");
    const accepted = commit(subtree(["aa", "bb"]), [excluded], "two subtrees");
    const head = commit(empty, [accepted], "empty head");
    f.git("update-ref", "HEAD", head);
    const pending = join(f.root, "walk");
    mkdirSync(pending, { recursive: true });
    await seal({ checkout: f.checkout, sourceBase: null }, pending, signal, limit);
    const artifact = join(pending, "artifact");
    const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(artifact, "manifest.json"), "utf8")));
    assert.deepEqual(manifest.view.retainedRevisions.map(r => r.id), [head, accepted]);
    assert.deepEqual(manifest.view.frontier, [{ revision: accepted, omittedParents: [excluded] }]);
    assert.deepEqual(manifest.paths.map(p => Buffer.from(p.bytes, "hex").toString()), ["aa/f", "bb/f"]);
    assert.equal(existsSync(join(artifact, excluded)), false);
    const required = join(f.root, "required");
    mkdirSync(required);
    await assert.rejects(seal({ checkout: f.checkout, sourceBase: excluded }, required, signal, limit),
      { code: "tree_expansion_limit" });
    assert.equal(existsSync(join(required, "artifact", "manifest.json")), false);
  });
}

for (const limit of [{ entries: 5, pathBytes: 100 }, { entries: 100, pathBytes: 33 }]) {
  test(`cached subtrees count toward each revision's ${limit.entries === 5 ? "entry" : "path-byte"} limit`, async (t) => {
    const f = fixture(t);
    const { write, commit } = objects(f.checkout);
    const blob = write("blob", Buffer.from("data"));
    const file = (name: string) => Buffer.concat([Buffer.from("100644 " + name + "\0"), Buffer.from(blob, "hex")]);
    const shared = write("tree", Buffer.concat([file("a"), file("b")]));
    const directory = (name: string, id: string) => Buffer.concat([Buffer.from("40000 " + name + "\0"), Buffer.from(id, "hex")]);
    const tree = (...entries: Buffer[]) => write("tree", Buffer.concat(entries));
    const dir = directory("dir", shared);
    const pkg = directory("pkg", tree(dir, file("x")));
    const oldestTree = tree(pkg, file("y"));
    const omitted = commit(oldestTree, [], "above limit");
    const accepted = commit(tree(pkg), [omitted], "exact limit");
    const head = commit(tree(directory("pkg", tree(dir))), [accepted], "shared directory");
    f.git("update-ref", "HEAD", head);
    const pending = join(f.root, "walk");
    mkdirSync(pending, { recursive: true });
    await seal({ checkout: f.checkout, sourceBase: null }, pending, signal, limit);
    const artifact = join(pending, "artifact");
    const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(artifact, "manifest.json"), "utf8")));
    assert.deepEqual(manifest.view.retainedRevisions.map(r => r.id), [head, accepted]);
    assert.deepEqual(manifest.view.frontier, [{ revision: accepted, omittedParents: [omitted] }]);
    assert.deepEqual(manifest.paths.map(p => Buffer.from(p.bytes, "hex").toString()), ["pkg/dir/a", "pkg/dir/b", "pkg/x"]);
    for (const id of [omitted, oldestTree]) assert.equal(existsSync(join(artifact, id)), false);
  });
}

test("tree expansion bounds cumulative historical paths while allowing edits to an already retained path", async (t) => {
  const f = fixture(t);
  const { write, commit } = objects(f.checkout);
  const revisions: string[] = [];
  for (const [i, name] of ["more", "past", "file", "file", "file"].entries()) {
    const blob = write("blob", Buffer.from(String(i)));
    const tree = write("tree", Buffer.concat([Buffer.from("100644 " + name + "\0"), Buffer.from(blob, "hex")]));
    revisions.push(commit(tree, revisions.slice(-1), name));
  }
  f.git("update-ref", "HEAD", revisions.at(-1)!);
  const pending = join(f.root, "walk");
  mkdirSync(pending, { recursive: true });
  await seal({ checkout: f.checkout, sourceBase: null }, pending, signal, { entries: 1, pathBytes: 4 });
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(pending, "artifact", "manifest.json"), "utf8")));
  assert.deepEqual(manifest.view.retainedRevisions.map(r => r.id), revisions.slice(1).reverse());
  assert.deepEqual(manifest.view.frontier, [{ revision: revisions[1], omittedParents: [revisions[0]] }]);
  assert.deepEqual(manifest.paths.map(p => Buffer.from(p.bytes, "hex").toString()), ["file", "past"]);
});

for (const overflow of ["commit", "tree"]) {
  test(`64 MiB history metadata budget counts shared trees once and stops before an overflowing ${overflow}`, async (t) => {
    const f = fixture(t);
    const { write, commit } = objects(f.checkout);
    const empty = write("tree", Buffer.alloc(0));
    const leafBytes = Buffer.concat(Array.from({ length: 16 }, (_, i) =>
      Buffer.concat([Buffer.from("160000 module-" + i.toString(16) + "\0"), Buffer.alloc(20, i + 1)])));
    const leaf = write("tree", leafBytes);
    const treeBytes = Buffer.concat(["a", "b"].map(path =>
      Buffer.concat([Buffer.from("40000 " + path + "\0"), Buffer.from(leaf, "hex")])));
    const tree = write("tree", treeBytes);
    const omittedTree = write("tree", Buffer.concat([Buffer.from("40000 different\0"), Buffer.from(leaf, "hex")]));
    const omitted = commit(omittedTree, [], "omitted by metadata budget");
    const placeholder = commit(tree, [omitted], "small");
    const spare = overflow === "tree" ? Number(f.git("cat-file", "-s", omitted)) : 0;
    const paddedBytes = (64 << 20) - treeBytes.length - leafBytes.length - Number(f.git("cat-file", "-s", placeholder)) - spare;
    // Write a valid commit message in chunks to exercise the real ceiling.
    f.write("padded", `tree ${tree}\nparent ${omitted}\nauthor A <a@test> 123 +0000\ncommitter A <a@test> 123 +0000\n\n`);
    const paddedPath = join(f.checkout, "padded");
    const chunk = Buffer.alloc(1 << 20, 0x61);
    for (let pos = lstatSync(paddedPath).size; pos < paddedBytes; pos += chunk.length)
      appendFileSync(paddedPath, chunk.subarray(0, paddedBytes - pos));
    const padded = f.git("hash-object", "-w", "-t", "commit", "padded");
    rmSync(join(f.checkout, "padded"));
    const small = commit(tree, [padded], "small");
    const head = commit(empty, [small], "head");
    f.git("update-ref", "HEAD", head);
    const candidate = await f.prepare();
    const artifact = join(f.root, "pending", candidate.id, "artifact");
    const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(artifact, "manifest.json"), "utf8")));
    assert.equal(manifest.view.retainedBlobBytes, 0);
    assert.deepEqual(manifest.view.retainedRevisions.map(r => r.id), [head, small, padded]);
    assert.deepEqual(manifest.view.frontier, [{ revision: padded, omittedParents: [omitted] }]);
    assert.equal(existsSync(join(artifact, omitted)), false);
    assert.equal(existsSync(join(artifact, omittedTree)), false);
    const additional = manifest.objects.filter(e => [small, padded, tree, leaf].includes(e.id));
    assert.equal(additional.reduce((bytes, entry) => bytes + entry.size, 0), (64 << 20) - spare);
    await f.service.discard(candidate);
  });
}

for (const limit of ["64 MiB per object", "512 MiB total"]) {
  test(`history blob limit of ${limit} stops before a large first parent and leaves the later small parent outside`, async (t) => {
    const f = fixture(t);
    f.write("a", "tip\n");
    f.git("add", ".");
    f.git("commit", "-qm", "base");
    const base = f.git("rev-parse", "HEAD"),
      tree = f.git("rev-parse", "HEAD^{tree}");
    const blobs: string[] = [];
    const sizes = limit === "64 MiB per object" ? [MAX_CAPTURE_OBJECT_BYTES + 1]
      : [...Array<number>(8).fill(MAX_CAPTURE_OBJECT_BYTES), 1];
    for (const [i, size] of sizes.entries()) {
      f.write("large", String(i));
      truncateSync(join(f.checkout, "large"), size);
      blobs.push(f.git("hash-object", "-w", "--no-filters", "large"));
    }
    rmSync(join(f.checkout, "large"));
    const { commit, write } = objects(f.checkout);
    const bigTree = write("tree", Buffer.concat(blobs.map((id, i) =>
      Buffer.concat([Buffer.from("100644 large" + i + "\0"), Buffer.from(id, "hex")]))));
    const expensive = commit(bigTree, [base], "too large"),
      cheap = commit(tree, [base], "small");
    const head = commit(tree, [expensive, cheap], "merge");
    f.git("update-ref", "HEAD", head);
    const c = await f.prepare(base);
    const s = await f.service.promote(c, f.submission());
    f.store.commitRepositoryCaptureActivation(s);
    const lease = await f.service.materialize(f.request(s), signal);
    assert.deepEqual(lease.descriptor.frontier, [{ revision: head, omittedParents: [expensive, cheap] }]);
    assert.deepEqual(
      lease.descriptor.retainedRevisions.map((r) => r.id),
      [head],
    );
    for (const id of [...blobs, bigTree, expensive, cheap])
      assert.equal(existsSync(join(f.root, "digests", s.digest, id)), false);
    await lease.release();
    await f.service.release(s.submissionId);
    await f.service.reconcile();
  });
}

test("publication intent recovers a rename without a committed row and refuses unowned digest directories", async (t) => {
  const f = fixture(t);
  f.write("a", "partial promotion");
  const c = interruptedCapture(f);
  const parent = join(f.root, "pending", c.id),
    dest = join(f.root, "digests", c.digest);
  writeFileSync(join(parent, "promotion"), c.digest);
  mkdirSync(join(f.root, "digests"));
  renameSync(join(parent, "artifact"), dest);
  const foreign = join(f.root, "digests", "a".repeat(64));
  mkdirSync(foreign);
  writeFileSync(join(foreign, "unowned"), "preserve");
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const inode = lstatSync(dirname(dest)).ino, fsync = fs.fsyncSync;
  const fail = t.mock.method(fs, "fsyncSync", (fd: number) => {
    if (fs.fstatSync(fd).ino === inode) throw Object.assign(new Error("directory sync failed"), { code: "EIO" });
    fsync(fd);
  });
  syncBuiltinESMExports();
  try {
    for (let i = 0; i < 2; i++) {
      assert.equal((await f.service.reconcile()).orphans, 2);
      assert.ok(existsSync(join(parent, "promotion")));
      assert.equal(existsSync(dest), false);
    }
  } finally {
    fail.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal((await f.service.reconcile()).orphans, 1);
  assert.ok(existsSync(foreign));
  assert.ok(!existsSync(parent) && !existsSync(dest));
});

test("core.fileMode follows the indexed executable bit for tracked files and preserves working bytes", async (t) => {
  const f = fixture(t);
  f.git("config", "core.fileMode", "true");
  f.write("plain", "plain\n");
  f.write("exec", "exec\n");
  chmodSync(join(f.checkout, "exec"), 0o755);
  f.git("add", ".");
  f.git("commit", "-qm", "modes");
  chmodSync(join(f.checkout, "plain"), 0o755);
  chmodSync(join(f.checkout, "exec"), 0o644);
  f.git("config", "core.fileMode", "false");
  assert.equal(f.git("status", "--porcelain"), "");
  const candidate = await f.prepare();
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(f.root, "pending", candidate.id, "artifact", "manifest.json"), "utf8")));
  assert.equal(manifest.view.worktreeTree, f.git("write-tree"));
  assert.deepEqual(manifest.view.worktree.map(e => e.classifications), [["committed"], ["committed"]]);
  f.git("config", "core.fileMode", "true");
  assert.deepEqual(f.git("diff", "--name-only").split("\n"), ["exec", "plain"]);
  assert.equal(await f.service.stillCurrent(candidate, signal), false);
  await f.service.discard(candidate);
  const modes = await f.prepare();
  const changed = manifestSchema.parse(JSON.parse(readFileSync(join(f.root, "pending", modes.id, "artifact", "manifest.json"), "utf8")));
  assert.deepEqual(changed.view.worktree.map(e => e.classifications), [["committed", "unstaged"], ["committed", "unstaged"]]);
  await f.service.discard(modes);
  f.git("config", "core.fileMode", "false");
  f.write("exec", "edited\n");
  assert.equal(f.git("diff", "--name-only"), "exec");
  const edited = await f.prepare();
  const last = manifestSchema.parse(JSON.parse(readFileSync(join(f.root, "pending", edited.id, "artifact", "manifest.json"), "utf8")));
  assert.deepEqual(last.view.worktree.map(e => e.classifications), [["committed", "unstaged"], ["committed"]]);
  f.git("add", "exec");
  assert.equal(last.view.worktreeTree, f.git("write-tree"));
  await f.service.discard(edited);
  for (const name of ["intent", "untracked"]) {
    f.write(name, "new executable");
    chmodSync(join(f.checkout, name), 0o755);
  }
  f.git("add", "-N", "intent");
  const fresh = await f.prepare();
  const freshView = manifestSchema.parse(JSON.parse(readFileSync(join(f.root, "pending", fresh.id, "artifact", "manifest.json"), "utf8"))).view;
  f.git("add", "intent");
  f.git("-c", "core.fileMode=true", "add", "untracked");
  assert.equal(freshView.worktreeTree, f.git("write-tree"));
  await f.service.discard(fresh);
});

test("core.symlinks preserves the indexed link type and literal bytes of a regular placeholder", async (t) => {
  const f = fixture(t);
  symlinkSync("original-target", join(f.checkout, "link"));
  f.git("add", "link");
  f.git("commit", "-qm", "tracked link");
  f.git("config", "core.symlinks", "false");
  rmSync(join(f.checkout, "link"));
  f.git("checkout-index", "--", "link");
  assert.ok(lstatSync(join(f.checkout, "link")).isFile());
  assert.equal(f.git("status", "--porcelain"), "");
  const clean = await f.prepare();
  const view = manifestSchema.parse(JSON.parse(readFileSync(join(f.root, "pending", clean.id, "artifact", "manifest.json"), "utf8"))).view;
  assert.equal(view.worktreeTree, f.git("write-tree"));
  assert.deepEqual(view.worktree[0]?.classifications, ["committed"]);
  f.git("config", "core.symlinks", "true");
  assert.match(f.git("diff", "--summary"), /mode change 120000 => 100644 link/);
  assert.equal(await f.service.stillCurrent(clean, signal), false);
  await f.service.discard(clean);
  f.git("config", "core.symlinks", "false");
  f.git("config", "core.fileMode", "false");
  f.write("link", "new-target");
  f.write("new-target", "target contents");
  assert.match(f.git("diff", "--raw"), /:120000 120000 .* M\s+link/);
  const snapshot = await f.service.promote(await f.prepare(), f.submission());
  f.store.commitRepositoryCaptureActivation(snapshot);
  const request = f.request(snapshot);
  const lease = await f.service.materialize(request, signal);
  const reader = createRepositoryReader({ view: lease.descriptor, objectDirectory: lease.objectDirectory,
    gitBinary: "git", workloadId: request.workloadId, attemptId: request.attemptId, signal, budgets: {}, audit: async () => {} });
  const link = lease.descriptor.worktree.find(e => e.path === "link");
  assert.equal(link?.kind, "symlink");
  assert.deepEqual(link.classifications, ["committed", "unstaged"]);
  assert.equal((await reader.query("read", { path: "link" })).items[0]?.text, "new-target");
  assert.equal(lease.descriptor.worktree.find(e => e.path === "new-target")?.kind, "file");
  await lease.release();
  await f.service.release(snapshot.submissionId);
  await f.service.reconcile();
});

test("intent-to-add, executable mode and index-only changes agree with Git's own staged tree", async (t) => {
  const f = fixture(t);
  f.write("intent", "intended");
  f.write("staged", "");
  f.write("exec", "run");
  chmodSync(join(f.checkout, "exec"), 0o755);
  f.git("add", "staged", "exec");
  f.git("add", "-N", "intent");
  const tree = f.git("write-tree");
  const original = readFileSync(join(f.checkout, ".git/index"));
  const s = await f.service.promote(await f.prepare(), f.submission());
  f.store.commitRepositoryCaptureActivation(s);
  const lease = await f.service.materialize(f.request(s), signal);
  assert.equal(lease.descriptor.indexTree, tree);
  assert.deepEqual(lease.descriptor.worktree.find((e) => e.path === "intent")?.classifications, ["unstaged"]);
  assert.deepEqual(readFileSync(join(f.checkout, ".git/index")), original);
  await lease.release();
  await f.service.release(s.submissionId);
  await f.service.reconcile();
});

test("removed intent-to-add files appear only as unstaged status deletions after materialization", async (t) => {
  const f = fixture(t);
  for (const path of ["intent", ".env"]) f.write(path, "temporary");
  f.git("add", "-N", "--", "intent", ".env");
  for (const path of ["intent", ".env"]) rmSync(join(f.checkout, path));
  assert.deepEqual(f.git("diff", "--name-status").split("\n"), ["D\t.env", "D\tintent"]);
  assert.equal(f.git("diff", "--cached", "--name-status"), "");
  const snapshot = await f.service.promote(await f.prepare(), f.submission());
  f.store.commitRepositoryCaptureActivation(snapshot);
  rmSync(f.checkout, { recursive: true });
  const request = f.request(snapshot);
  const lease = await f.service.materialize(request, signal);
  assert.deepEqual(lease.descriptor.index, []);
  assert.deepEqual(lease.descriptor.worktree, []);
  assert.deepEqual(lease.descriptor.statusDeletions, [{ path: "intent", classifications: ["unstaged", "deleted"] }]);
  const reader = createRepositoryReader({ view: lease.descriptor, objectDirectory: lease.objectDirectory,
    gitBinary: "git", workloadId: request.workloadId, attemptId: request.attemptId, signal, budgets: {}, audit: async () => {} });
  const status = await reader.query("git_status", {});
  assert.deepEqual(status.items.map(e => [e.path, e.metadata?.classifications]), [["intent", ["unstaged", "deleted"]]]);
  assert.equal(status.items[0]?.evidenceHandleId, undefined);
  assert.equal((await reader.query("read", { path: "intent" })).code, "unavailable");
  assert.equal((await reader.query("glob", { glob: "intent" })).items.length, 0);
  await lease.release();
  await f.service.release(snapshot.submissionId);
  await f.service.reconcile();
});

test("stable submission retries an index-only edit across the outer evidence boundary", async (t) => {
  const f = fixture(t);
  f.write("a", "one");
  f.git("add", ".");
  f.git("commit", "-qm", "base");
  f.write("a", "staged A");
  f.git("add", "a");
  f.write("a", "working");
  let n = 0;
  const stable = await captureStableWorkflowContext(
    async () => ++n,
    async () => {
      if (n === 1) {
        f.write("a", "staged B");
        f.git("add", "a");
        f.write("a", "working");
      }
      return false; // HEAD, worktree, porcelain status and transcript all stayed the same.
    },
    {
      sampleBoundary: () => f.service.sampleBoundary(f.checkout, signal),
      prepare: () => f.prepare(),
      stillCurrent: (c) => f.service.stillCurrent(c, signal),
      discard: (c) => f.service.discard(c),
    },
  );
  assert.equal(stable?.captured, 2);
  assert.deepEqual(readdirSync(join(f.root, "pending")), [stable!.candidate.id]);
  const s = await f.service.promote(stable!.candidate, f.submission());
  f.store.commitRepositoryCaptureActivation(s);
  const lease = await f.service.materialize(f.request(s), signal);
  assert.equal(lease.descriptor.index.find((e) => e.path === "a")?.blob, f.git("rev-parse", ":a"));
  await lease.release();
  await f.service.release(s.submissionId);
  await f.service.reconcile();
});

for (const [initial, replacement] of [
  ["symlink", "removed"], ["symlink", "file"],
  ["file", "removed"], ["file", "file"], ["file", "symlink"],
] as const) {
  test(`stable capture retries a ${initial} changed to ${replacement} after lstat`, async (t) => {
    const f = fixture(t);
    const path = join(f.checkout, "racing-entry");
    if (initial === "symlink") symlinkSync("old-target", path);
    else f.write("racing-entry", "original");
    f.git("add", "racing-entry");
    f.git("commit", "-qm", "original");
    let reads = 0;
    let swapped = false;
    let retries = 0;
    const fs = (await import("node:fs/promises")).default;
    const { syncBuiltinESMExports } = await import("node:module");
    const original = fs.lstat;
    const inspect = t.mock.method(fs, "lstat", async (...args: Parameters<typeof original>) => {
      const stat = await original(...args);
      if (reads === 1 && !swapped && String(args[0]).endsWith("/racing-entry")) {
        swapped = true;
        if (replacement === "removed") rmSync(path);
        else {
          const next = join(f.checkout, ".git", "replacement");
          if (replacement === "symlink") symlinkSync("new-target", next);
          else writeFileSync(next, "new regular file");
          renameSync(next, path);
        }
      }
      return stat;
    });
    syncBuiltinESMExports();
    try {
      const stable = await captureStableWorkflowContext(async () => ++reads, async () => false, {
        sampleBoundary: () => f.service.sampleBoundary(f.checkout, signal),
        prepare: () => f.prepare().catch(error => {
          assert.ok(error instanceof RepositoryCaptureChanged);
          retries++;
          throw error;
        }),
        stillCurrent: candidate => f.service.stillCurrent(candidate, signal),
        discard: candidate => f.service.discard(candidate),
      });
      assert.ok(swapped && stable);
      assert.equal(retries, 1);
      assert.equal(stable.captured, 2);
      assert.deepEqual(readdirSync(join(f.root, "pending")), [stable.candidate.id]);
      const snapshot = await f.service.promote(stable.candidate, f.submission());
      f.store.commitRepositoryCaptureActivation(snapshot);
      const lease = await f.service.materialize(f.request(snapshot), signal);
      const entry = lease.descriptor.worktree.find(e => e.path === "racing-entry");
      assert.ok(entry);
      if (replacement === "removed") {
        assert.equal(entry.blob, null);
        assert.ok(entry.classifications.includes("deleted"));
      } else {
        assert.equal(entry.kind, replacement);
        assert.ok(entry.classifications.includes("unstaged") && entry.blob);
        assert.equal(readFileSync(join(f.root, "digests", snapshot.digest, entry.blob), "utf8"),
          replacement === "symlink" ? "blob 10\0new-target" : "blob 16\0new regular file");
      }
      await lease.release();
      await f.service.release(snapshot.submissionId);
      await f.service.reconcile();
    } finally {
      inspect.mock.restore();
      syncBuiltinESMExports();
    }
  });
}

for (const indexFlag of ["--sparse-index", "--no-sparse-index"]) {
  test(`sparse checkout ${indexFlag} preserves skipped index entries and reports real edits`, async (t) => {
    const f = fixture(t);
    mkdirSync(join(f.checkout, "outside"));
    mkdirSync(join(f.checkout, "inside"));
    mkdirSync(join(f.checkout, "edited"));
    f.write("outside/file", "out-of-cone bytes");
    f.write("outside/.env", "private value");
    f.write("edited/file", "indexed bytes");
    f.write("inside/removed", "deleted by the author");
    f.git("add", ".");
    f.git("commit", "-qm", "base");
    f.git("sparse-checkout", "set", "--cone", indexFlag, "inside");
    assert.equal(existsSync(join(f.checkout, "outside/file")), false);
    assert.equal(f.git("ls-files", "-t", "outside/file"), "S outside/file");
    mkdirSync(join(f.checkout, "edited"));
    f.write("edited/file", "local out-of-cone edit");
    rmSync(join(f.checkout, "inside/removed"));
    const secret = f.git("rev-parse", ":outside/.env");
    const index = readFileSync(join(f.checkout, ".git/index"));
    const snapshot = await f.service.promote(await f.prepare(), f.submission());
    assert.deepEqual(readFileSync(join(f.checkout, ".git/index")), index);
    f.store.commitRepositoryCaptureActivation(snapshot);
    rmSync(f.checkout, { recursive: true });
    assert.equal(existsSync(join(f.root, "digests", snapshot.digest, secret)), false);
    const request = f.request(snapshot);
    const lease = await f.service.materialize(request, signal);
    const reader = createRepositoryReader({
      view: lease.descriptor,
      objectDirectory: lease.objectDirectory,
      workloadId: request.workloadId,
      attemptId: request.attemptId,
      gitBinary: "git",
      budgets: {},
      signal,
      audit: async () => {},
    });
    assert.equal((await reader.query("read", { path: "outside/file" })).items[0]?.text, "out-of-cone bytes");
    assert.equal((await reader.query("read", { path: "edited/file" })).items[0]?.text, "local out-of-cone edit");
    assert.equal((await reader.query("read", { path: "edited/file", layer: "index" })).items[0]?.text, "indexed bytes");
    assert.equal((await reader.query("read", { path: "outside/.env" })).code, "denied_path");
    const status = await reader.query("git_status", {});
    assert.deepEqual(status.items.find(e => e.path === "outside/file")?.metadata?.classifications, ["committed"]);
    const diff = await reader.query("git_diff", { pair: "index_worktree" });
    assert.equal(diff.status, "ok");
    assert.deepEqual(diff.items.map(e => e.path), ["edited/file", "inside/removed"]);
    await lease.release();
    await f.service.release(snapshot.submissionId);
    await f.service.reconcile();
  });
}

test("an index-only change between the context read and artifact preparation retries both captures", async (t) => {
  const f = fixture(t);
  f.write("a", "committed");
  f.git("add", "a");
  f.git("commit", "-qm", "base");
  function stage(version: string) {
    f.write("a", version);
    f.git("add", "a");
    f.write("a", "working");
  }
  stage("staged A");
  const status = f.git("status", "--porcelain");
  const reads: string[] = [];
  const discarded: string[] = [];
  const stable = await captureStableWorkflowContext(
    async () => {
      const staged = f.git("rev-parse", ":a");
      reads.push(staged);
      return staged;
    },
    async () => false,
    {
      sampleBoundary: () => f.service.sampleBoundary(f.checkout, signal),
      prepare: async () => {
        if (reads.length === 1) {
          stage("staged B");
          assert.equal(f.git("status", "--porcelain"), status);
        }
        return f.prepare();
      },
      stillCurrent: candidate => f.service.stillCurrent(candidate, signal),
      discard: async candidate => {
        discarded.push(candidate.id);
        await f.service.discard(candidate);
      },
    },
  );
  assert.ok(stable);
  assert.equal(reads.length, 2);
  assert.notEqual(reads[0], reads[1]);
  assert.equal(discarded.length, 1);
  assert.deepEqual(readdirSync(join(f.root, "pending")), [stable.candidate.id]);
  const snapshot = await f.service.promote(stable.candidate, f.submission());
  f.store.commitRepositoryCaptureActivation(snapshot);
  const lease = await f.service.materialize(f.request(snapshot), signal);
  assert.equal(stable.captured, reads[1]);
  assert.equal(lease.descriptor.index.find(entry => entry.path === "a")?.blob, stable.captured);
  await lease.release();
  await f.service.release(snapshot.submissionId);
  await f.service.reconcile();
});

test("publication sync failures before and after rename roll back the claim and permit retry", async (t) => {
  const f = fixture(t);
  f.write("a", "sealed");
  const c = await f.prepare(), id = f.submission();
  const root = realpathSync(f.root), pending = join(root, "pending", c.id);
  const src = join(pending, "artifact"), dest = join(root, "digests", c.digest);
  const files = readdirSync(src).map(name => join(src, name));
  const fs = (await import("node:fs")).default;
  const fsp = (await import("node:fs/promises")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const open = fsp.open, openSync = fs.openSync, sync = fs.fsyncSync, rename = fs.renameSync, write = fs.writeFileSync;
  const dirs = new Map<number, string>(), events: string[] = [];
  let fault: "file" | "parent" | null = "file";
  const ioError = () => Object.assign(new Error("sync failure"), { code: "EIO" });
  t.mock.method(fsp, "open", async (...args: Parameters<typeof open>) => {
    const fd = await open(...args);
    const path = String(args[0]);
    if (dirname(path) === src || dirname(path) === dest) {
      const flush = fd.sync.bind(fd);
      t.mock.method(fd, "sync", async () => {
        if (fault === "file") throw ioError();
        await flush();
        events.push(path);
      });
    }
    return fd;
  });
  t.mock.method(fs, "openSync", (...args: Parameters<typeof openSync>) => {
    const fd = openSync(...args);
    if (typeof args[1] === "number" && (args[1] & fs.constants.O_DIRECTORY)) dirs.set(fd, String(args[0]));
    else dirs.delete(fd);
    return fd;
  });
  t.mock.method(fs, "fsyncSync", (fd: number) => {
    const path = dirs.get(fd);
    if (fault === "parent" && path === dirname(dest) && existsSync(dest)) throw ioError();
    sync(fd);
    if (path) events.push(path);
  });
  t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof write>) => {
    write(...args);
    if (String(args[0]) === join(pending, "promotion.tmp") && typeof args[2] === "object" && args[2]?.flush)
      events.push("flushed intent");
  });
  t.mock.method(fs, "renameSync", (...args: Parameters<typeof rename>) => {
    rename(...args);
    if (String(args[1]) === join(pending, "promotion")) events.push("installed intent");
    if (String(args[1]) === dest) events.push("published");
  });
  syncBuiltinESMExports();
  try {
    for (const failure of ["file", "parent"] as const) {
      fault = failure;
      await assert.rejects(f.service.promote(c, id), { code: "artifact_unavailable" });
      assert.equal(existsSync(dest), failure === "parent");
      assert.equal(existsSync(join(pending, "promotion")), failure === "parent");
      assert.equal(f.db.prepare("SELECT 1 FROM workflow_repository_artifacts WHERE digest=?").get(c.digest), undefined);
      assert.equal(f.db.prepare("SELECT 1 FROM workflow_repository_snapshot_claims WHERE submission_id=?").get(id), undefined);
    }
    const beforePublish = events.slice(0, events.indexOf("published"));
    for (const file of files) assert.ok(beforePublish.includes(file), file);
    assert.ok(beforePublish.includes(src));
    const flushed = beforePublish.indexOf("flushed intent"), installed = beforePublish.indexOf("installed intent");
    assert.ok(flushed >= 0 && installed > flushed);
    for (const directory of [pending, dirname(pending), root, dirname(root)])
      assert.ok(beforePublish.slice(installed + 1).includes(directory), directory);
    fault = null;
    events.length = 0;
    const snapshot = await f.service.promote(c, id);
    assert.ok(events.includes(dirname(dest)));
    f.store.commitRepositoryCaptureActivation(snapshot);
    await f.service.release(id);
    await f.service.reconcile();
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("disk failure and a deferred SQLite failure after rename leave no claim and recover only the marked bytes", async (t) => {
  const f = fixture(t);
  const warnings = t.mock.method(console, "warn", () => {});
  f.write("a", "sealed");
  let failedWrite = false;
  const fs = (await import("node:fs/promises")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const original = fs.writeFile;
  const write = t.mock.method(fs, "writeFile", (...args: Parameters<typeof original>) => {
    if (String(args[0]).endsWith("/manifest.json")) {
      failedWrite = true;
      throw Object.assign(new Error("out of space"), { code: "ENOSPC" });
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.prepare(), { code: "artifact_unavailable" });
  } finally {
    write.mock.restore();
    syncBuiltinESMExports();
  }
  assert.ok(failedWrite);
  assert.deepEqual(readdirSync(join(f.root, "pending")), []);
  const c = await f.prepare(),
    submissionId = f.submission();
  // COMMIT fails after both SQL writes and the filesystem rename. Rollback cannot undo
  // the rename. Discard uses the durable promotion intent, just as restart would.
  f.db.exec(`CREATE TEMP TABLE parent(id INTEGER PRIMARY KEY);
    CREATE TEMP TABLE deferred_failure(id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TEMP TRIGGER fail_after_publish AFTER INSERT ON workflow_repository_snapshot_claims
      BEGIN INSERT INTO deferred_failure VALUES(1); END;`);
  try {
    await assert.rejects(f.service.promote(c, submissionId), { code: "artifact_unavailable" });
  } finally {
    f.db.exec("DROP TRIGGER fail_after_publish; DROP TABLE deferred_failure; DROP TABLE parent;");
  }
  assert.deepEqual(f.service.artifacts(), []);
  assert.deepEqual(warnings.mock.calls.map(call => call.arguments[0]), [
    "[workflow] event=repository_seal error=ENOSPC",
    "[workflow] event=repository_promote error=ERR_SQLITE_ERROR",
  ]);
  assert.ok(existsSync(join(f.root, "digests", c.digest)));
  await f.service.discard(c);
  assert.deepEqual(readdirSync(join(f.root, "digests")), []);
  assert.deepEqual(readdirSync(join(f.root, "pending")), []);
});

test("a failed or cancelled capture releases its provisional claim while another submission can reuse the bytes", async (t) => {
  const f = fixture(t);
  for (const status of ["failed", "cancelled"]) {
    const first = await f.service.promote(await f.prepare(), f.submission());
    const second = await f.service.promote(await f.prepare(), f.submission());
    f.db.prepare("UPDATE workflow_submissions SET status=? WHERE id=?").run(status, first.submissionId);
    await f.service.reconcile();
    assert.throws(() => f.store.commitRepositoryCaptureActivation(first));
    const refused = await f.prepare();
    await assert.rejects(f.service.promote(refused, first.submissionId), { code: "artifact_unavailable" });
    await f.service.discard(refused);
    f.store.commitRepositoryCaptureActivation(second);
    const snapshot = f.service.activeSnapshot(second.submissionId);
    assert.ok(snapshot);
    assert.equal((await f.service.verify(snapshot, signal)).digest, second.digest);
    await f.service.release(second.submissionId);
    await f.service.reconcile();
    assert.equal(f.service.activeSnapshot(second.submissionId), null);
    assert.deepEqual(f.service.artifacts(), []);
  }
});

test("unaddressable historical filename bytes retain their exact tree identity and no blob body", async (t) => {
  const f = fixture(t);
  const { write, commit } = objects(f.checkout);
  const secret = write("blob", Buffer.from("denied historical bytes"));
  const tree = write(
    "tree",
    Buffer.concat([Buffer.from("100644 "), Buffer.from([255, 0]), Buffer.from(secret, "hex")]),
  );
  const head = commit(tree, [], "byte path");
  f.git("update-ref", "HEAD", head);
  const s = await f.service.promote(await f.prepare(), f.submission());
  const artifact = join(f.root, "digests", s.digest);
  assert.ok(existsSync(join(artifact, tree)));
  assert.ok(!existsSync(join(artifact, secret)));
  const m = JSON.parse(readFileSync(join(artifact, "manifest.json"), "utf8"));
  assert.deepEqual(m.paths, [
    { bytes: "ff", allowed: false, classifications: ["committed", "staged", "deleted", "sensitive_denied"] },
  ]);
  assert.deepEqual(m.view.worktree, []);
  await f.service.release(s.submissionId);
  await f.service.reconcile();
});

test("a staged deletion and a recreated working file retain both statuses and their separate contents", async (t) => {
  const f = fixture(t);
  f.write("file", "original\n");
  f.git("add", "file");
  f.git("commit", "-qm", "original");
  f.git("rm", "-q", "file");
  f.write("file", "recreated\n");
  assert.equal(f.git("status", "--porcelain"), "D  file\n?? file");
  const s = await f.service.promote(await f.prepare(), f.submission());
  f.store.commitRepositoryCaptureActivation(s);
  const request = f.request(s);
  const lease = await f.service.materialize(request, signal);
  const reader = createRepositoryReader({ view: lease.descriptor, objectDirectory: lease.objectDirectory,
    gitBinary: "git", workloadId: request.workloadId, attemptId: request.attemptId, signal, budgets: {}, audit: async () => {} });
  const status = await reader.query("git_status", {});
  assert.deepEqual(status.items.map(e => [e.path, e.metadata?.classifications]),
    [["file", ["committed", "staged", "untracked", "deleted"]]]);
  assert.equal((await reader.query("read", { path: "file" })).items[0]?.text, "recreated");
  assert.deepEqual(lease.descriptor.index, []);
  assert.match((await reader.query("git_diff", { pair: "head_index" })).items[0]?.text ?? "", /-original/);
  assert.match((await reader.query("git_diff", { pair: "index_worktree" })).items[0]?.text ?? "", /\+recreated/);
  const legacy = manifestSchema.parse(JSON.parse(readFileSync(join(f.root, "digests", s.digest, "manifest.json"), "utf8")));
  for (const entry of [...legacy.view.worktree, ...legacy.paths])
    entry.classifications = entry.classifications.filter(c => c !== "deleted");
  const oldView = descriptor(legacy, s.digest, "legacy");
  assert.deepEqual(oldView.worktree, lease.descriptor.worktree);
  await lease.release();
  await f.service.release(s.submissionId);
  await f.service.reconcile();
});

test("deletions beyond the live worktree limit remain visible through status-only records", async (t) => {
  const f = fixture(t);
  for (const path of ["old-a", "old-b", "old-c"]) f.write(path, path);
  f.git("add", ".");
  f.git("commit", "-qm", "old files");
  f.git("rm", "-q", "old-a", "old-b", "old-c");
  f.write("new-a", "live a");
  f.write("new-b", "live b");
  mkdirSync(f.root);
  const snapshot = await seal({ checkout: f.checkout, sourceBase: null }, f.root, signal, { entries: 3 });
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(f.root, "artifact", "manifest.json"), "utf8")));
  const view = descriptor(manifest, snapshot.digest, "lease");
  assert.deepEqual(view.worktree.map(e => e.path), ["new-a", "new-b", "old-a"]);
  assert.deepEqual(view.statusDeletions?.map(e => e.path), ["old-b", "old-c"]);
  const reader = createRepositoryReader({ view, objectDirectory: f.root, gitBinary: "git", workloadId: "work",
    attemptId: "attempt", signal, budgets: {}, audit: async () => {} });
  const status = await reader.query("git_status", {});
  assert.equal(status.status, "ok");
  assert.deepEqual(status.items.map(e => [e.path, e.metadata?.classifications]), [
    ["new-a", ["untracked"]], ["new-b", ["untracked"]],
    ...["old-a", "old-b", "old-c"].map(path => [path, ["committed", "staged", "deleted"]]),
  ]);
});

test("a directory replacement reports disjoint HEAD and index deletions above one layer's limit", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.checkout, "dir"));
  const old = ["dir/a", "dir/b", "dir/c"], added = ["dir/d", "dir/e", "dir/f"];
  for (const path of old) f.write(path, path);
  f.git("add", "dir");
  f.git("commit", "-qm", "original directory");
  f.git("rm", "-qr", "dir");
  mkdirSync(join(f.checkout, "dir"));
  for (const path of added) f.write(path, path);
  f.git("add", "dir");
  rmSync(join(f.checkout, "dir"), { recursive: true });
  f.write("dir", "replacement file");
  mkdirSync(f.root);
  const snapshot = await seal({ checkout: f.checkout, sourceBase: null }, f.root, signal, { entries: 5 });
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(f.root, "artifact", "manifest.json"), "utf8")));
  const view = descriptor(manifest, snapshot.digest, "verified");
  assert.deepEqual(view.worktree.map(e => e.path), ["dir"]);
  assert.deepEqual(view.statusDeletions?.map(e => [e.path, e.classifications]), [
    ...old.map(path => [path, ["committed", "staged", "deleted"]]),
    ...added.map(path => [path, ["staged", "unstaged", "deleted"]]),
  ]);
  const reader = createRepositoryReader({ view, objectDirectory: f.root, gitBinary: "git", workloadId: "work",
    attemptId: "attempt", signal, budgets: {}, audit: async () => {} });
  assert.deepEqual((await reader.query("git_status", {})).items.map(e => e.path), ["dir", ...old, ...added]);
});

test("base-only deletions stay in the base-to-HEAD diff and never appear as checkout status", async (t) => {
  const f = fixture(t);
  for (const path of ["removed", "recreated", "restaged"]) f.write(path, path);
  f.git("add", ".");
  f.git("commit", "-qm", "base");
  const base = f.git("rev-parse", "HEAD");
  f.git("rm", "-q", "removed", "recreated", "restaged");
  f.git("commit", "-qm", "committed deletions");
  assert.equal(f.git("status", "--porcelain"), "");
  for (const clean of [true, false]) {
    if (!clean) {
      f.write("recreated", "new untracked file");
      f.write("restaged", "new staged file");
      f.git("add", "restaged");
    }
    const snapshot = await f.service.promote(await f.prepare(base), f.submission());
    f.store.commitRepositoryCaptureActivation(snapshot);
    const request = f.request(snapshot);
    const lease = await f.service.materialize(request, signal);
    const reader = createRepositoryReader({ view: lease.descriptor, objectDirectory: lease.objectDirectory,
      gitBinary: "git", workloadId: request.workloadId, attemptId: request.attemptId, signal, budgets: {}, audit: async () => {} });
    const status = await reader.query("git_status", {});
    assert.equal(status.status, "ok");
    assert.deepEqual(status.items.map(e => [e.path, e.metadata?.classifications]),
      clean ? [] : [["recreated", ["untracked"]], ["restaged", ["staged"]]]);
    const diff = await reader.query("git_diff", { pair: "base_head", paths: ["removed"] });
    assert.equal(diff.status, "ok");
    assert.match(diff.items[0]?.text ?? "", /-removed/);
    if (clean) {
      const legacy = manifestSchema.parse(JSON.parse(readFileSync(join(f.root, "digests", snapshot.digest, "manifest.json"), "utf8")));
      // Earlier manifests could contain a tombstone in the view, or just in the raw path table.
      for (const entry of legacy.paths) entry.classifications.push("deleted");
      legacy.view.worktree.push({ path: "removed", classifications: ["committed", "deleted"], kind: "file", binary: false, blob: null });
      const view = descriptor(legacy, snapshot.digest, "legacy");
      assert.deepEqual(view.worktree, []);
      assert.deepEqual(view.statusDeletions ?? [], []);
    }
    await lease.release();
    await f.service.release(snapshot.submissionId);
    await f.service.reconcile();
  }
});

test("a looping symlink replacing a directory preserves the target and child deletions", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.checkout, "dir", "nested"), { recursive: true });
  f.write("dir/nested/child", "original child");
  f.git("add", ".");
  f.git("commit", "-qm", "tracked directory");
  rmSync(join(f.checkout, "dir"), { recursive: true });
  symlinkSync("dir", join(f.checkout, "dir"));
  const snapshot = await f.service.promote(await f.prepare(), f.submission());
  f.store.commitRepositoryCaptureActivation(snapshot);
  rmSync(f.checkout, { recursive: true });
  const request = f.request(snapshot);
  const lease = await f.service.materialize(request, signal);
  const reader = createRepositoryReader({ view: lease.descriptor, objectDirectory: lease.objectDirectory,
    gitBinary: "git", workloadId: request.workloadId, attemptId: request.attemptId, signal, budgets: {}, audit: async () => {} });
  assert.equal(lease.descriptor.worktree.find(entry => entry.path === "dir")?.kind, "symlink");
  assert.equal((await reader.query("read", { path: "dir" })).items[0]?.text, "dir");
  assert.equal((await reader.query("read", { path: "dir/nested/child" })).code, "unavailable");
  assert.equal((await reader.query("read", { path: "dir/nested/child", layer: "index" })).items[0]?.text, "original child");
  const status = await reader.query("git_status", { glob: "dir/nested/child" });
  assert.deepEqual(status.items[0]?.metadata?.classifications, ["committed", "unstaged", "deleted"]);
  await lease.release();
  await f.service.release(snapshot.submissionId);
  await f.service.reconcile();
});

test("status reports both sides of file and directory replacements without treating deletions as live files", async (t) => {
  const f = fixture(t);
  f.write("former-file", "old file");
  f.write("staged-away", "old staged file");
  mkdirSync(join(f.checkout, "former-directory"));
  f.write("former-directory/child", "old child");
  f.write("former-directory/.env", "private");
  f.git("add", ".");
  f.git("commit", "-qm", "before replacements");
  f.git("rm", "-q", "staged-away");
  rmSync(join(f.checkout, "former-file"));
  for (const path of ["former-file", "staged-away"]) {
    mkdirSync(join(f.checkout, path));
    f.write(path + "/child", "new child");
  }
  rmSync(join(f.checkout, "former-directory"), { recursive: true });
  f.write("former-directory", "new file");

  const snapshot = await f.service.promote(await f.prepare(), f.submission());
  f.store.commitRepositoryCaptureActivation(snapshot);
  rmSync(f.checkout, { recursive: true });
  const request = f.request(snapshot);
  const lease = await f.service.materialize(request, signal);
  const reader = createRepositoryReader({
    view: lease.descriptor, objectDirectory: lease.objectDirectory, gitBinary: "git",
    workloadId: request.workloadId, attemptId: request.attemptId, signal, budgets: { callItems: 2 }, audit: async () => {},
  });
  let page = await reader.query("git_status", {});
  const entries = [...page.items];
  while (page.nextCursor) {
    page = await reader.query("git_status", { cursor: page.nextCursor });
    entries.push(...page.items);
  }
  assert.equal(page.status, "ok");
  assert.deepEqual(entries.map(e => e.path).sort(), [
    "former-directory", "former-directory/child", "former-file", "former-file/child", "staged-away", "staged-away/child",
  ]);
  for (const path of ["former-directory/child", "former-file", "staged-away"]) {
    const item = entries.find(e => e.path === path)!;
    const classifications = item.metadata?.classifications;
    assert.ok(Array.isArray(classifications) && classifications.includes("deleted"));
    const filtered = await reader.query("git_status", { glob: path });
    assert.deepEqual(filtered.items.map(e => e.path), [path]);
    assert.equal(filtered.items[0]?.evidenceHandleId, undefined);
    assert.equal((await reader.query("read", { path })).code, "unavailable");
    assert.equal((await reader.query("glob", { glob: path })).items.length, 0);
  }
  assert.equal((await reader.query("read", { path: "former-file/child" })).items[0]?.text, "new child");
  assert.equal((await reader.query("read", { path: "former-directory" })).items[0]?.text, "new file");
  assert.equal((await reader.query("read", { path: "former-file", layer: "index" })).items[0]?.text, "old file");
  await lease.release();
  await f.service.release(snapshot.submissionId);
  await f.service.reconcile();
});

for (const which of ["worktree", "admin", "common", "temporarily displaced admin"] as const) {
  test(`capture rejects a byte-identical replacement of the ${which} directory`, async (t) => {
    const storage = new RepositoryArtifactStorage();
    const f = fixture(t, "sha1", storage);
    f.write("file", "submitted\n");
    f.git("add", "file");
    f.git("commit", "-qm", "initial");
    const checkout = f.checkout + "-session";
    f.git("worktree", "add", "-q", "--detach", checkout);
    const prepare = () => f.service.prepare({ checkout, sourceBase: null }, signal);
    const before = await prepare();
    const restored = which === "temporarily displaced admin";
    const path = { worktree: checkout, admin: f.git("-C", checkout, "rev-parse", "--absolute-git-dir"),
      common: join(f.checkout, ".git") }[restored ? "admin" : which];
    const saved = f.checkout + "-saved";
    const write = storage.write.bind(storage);
    let replaced = false;
    const hook = t.mock.method(storage, "write", async (...args: Parameters<typeof write>) => {
      if (!replaced) {
        renameSync(path, saved);
        cpSync(saved, path, { recursive: true });
        if (restored) {
          renameSync(path, saved + "-copy");
          renameSync(saved, path);
        }
        replaced = true;
      }
      return write(...args);
    });
    await assert.rejects(prepare(), RepositoryCaptureChanged);
    hook.mock.restore();
    assert.ok(replaced);
    assert.deepEqual(readdirSync(join(f.root, "pending")), [before.id]);
    assert.equal(await f.service.stillCurrent(before, signal), restored);
    const retry = await prepare();
    assert.equal(retry.digest, before.digest);
    assert.equal(retry.boundary === before.boundary, restored);
    await f.service.discard(retry);
    await f.service.discard(before);
  });
}

test("checkout ownership requires the Git directory to identify the submitted worktree", async (t) => {
  const f = fixture(t);
  f.git("commit", "--allow-empty", "-qm", "initial");
  const linked = f.checkout + "-linked";
  f.git("worktree", "add", "-q", "--detach", linked);
  const other = f.checkout + "-other";
  mkdirSync(other);
  const prepare = () => f.service.prepare({ checkout: other, sourceBase: null }, signal);
  for (const path of [f.checkout, linked]) {
    const admin = f.git("-C", path, "rev-parse", "--absolute-git-dir");
    writeFileSync(join(other, ".git"), "gitdir: " + admin + "\n");
    await assert.rejects(prepare(), { code: "artifact_unavailable" });
    assert.deepEqual(readdirSync(join(f.root, "pending")), []);
  }
});

test("checkout ownership accepts separate Git metadata with an explicit reciprocal worktree", async (t) => {
  const f = fixture(t);
  const checkout = f.checkout + "-separate", admin = f.checkout + "-metadata";
  f.git("init", "-q", "--separate-git-dir", admin, checkout);
  f.git("--git-dir", admin, "config", "--local", "core.worktree", relative(admin, checkout));
  writeFileSync(join(checkout, "owned"), "submitted bytes");
  const candidate = await f.service.prepare({ checkout, sourceBase: null }, signal);
  const snapshot = await f.service.promote(candidate, f.submission());
  f.store.commitRepositoryCaptureActivation(snapshot);
  const lease = await f.service.materialize(f.request(snapshot), signal);
  assert.equal(lease.descriptor.worktree.find(entry => entry.path === "owned")?.blob,
    f.git("-C", checkout, "hash-object", "owned"));
  await lease.release();
  await f.service.release(snapshot.submissionId);
  await f.service.reconcile();
});

test("a linked session checkout keeps its own staged and working bytes after the common repository disappears", async (t) => {
  const f = fixture(t);
  f.write("file", "shared commit\n");
  f.git("add", ".");
  f.git("commit", "-qm", "initial");
  const session = f.checkout + "-session";
  f.git("worktree", "add", "-q", "-b", "session", session);
  writeFileSync(join(session, "file"), "session index\n");
  f.git("-C", session, "add", "file");
  writeFileSync(join(session, "file"), "session worktree\n");
  f.write("file", "unsubmitted primary checkout");
  const includes = join(session, ".git-config-for-test");
  writeFileSync(includes, "[core]\nexcludesFile = " + join(session, "excludes") + "\n");
  f.git("config", "include.path", includes);
  writeFileSync(join(session, "excludes"), "private-output\n");
  writeFileSync(join(session, "private-output"), "SECRET-ignored");
  const base = f.git("rev-parse", "HEAD");
  f.git("commit", "--allow-empty", "-qm", "new primary head");
  f.git("branch", base.slice(0, 12), "HEAD");
  const c = await f.service.prepare({ checkout: session, sourceBase: base.slice(0, 12) }, signal);
  const s = await f.service.promote(c, f.submission());
  f.store.commitRepositoryCaptureActivation(s);
  const expected = f.git("-C", session, "rev-parse", ":file");
  rmSync(f.checkout, { recursive: true });
  rmSync(session, { recursive: true });
  const lease = await f.service.materialize(f.request(s), signal);
  assert.equal(lease.descriptor.base, base);
  assert.equal(lease.descriptor.index.find((e) => e.path === "file")?.blob, expected);
  assert.equal(
    lease.descriptor.worktree.some((e) => e.path === "private-output"),
    false,
  );
  const reader = createRepositoryReader({
    view: lease.descriptor,
    objectDirectory: lease.objectDirectory,
    gitBinary: "git",
    workloadId: "linked",
    attemptId: "linked",
    signal,
    budgets: {},
    audit: async () => {},
  });
  assert.equal((await reader.query("read", { path: "file" })).items[0]?.text, "session worktree");
  await lease.release();
  await f.service.release(s.submissionId);
  await f.service.reconcile();
});
