import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chmodSync,
  truncateSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { deflateSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash, randomUUID } from "node:crypto";
import { openDb } from "../src/server/db.ts";
import { WorkflowStore } from "../src/server/workflows/store.ts";
import { WorkflowRepositoryArtifactService } from "../src/server/workflows/repository-artifact/service.ts";
import type { RepositoryMaterializationRequest } from "../src/server/workflows/persona-workload/contracts.ts";
import { createRepositoryReader } from "../src/server/workflows/persona-workload/reader.ts";
import { captureStableWorkflowContext } from "../src/server/workflows/context.ts";

import { ensureNativeStateLockAddon } from "./helpers/native-state-lock.ts";

ensureNativeStateLockAddon();
const signal = new AbortController().signal;
function fixture(t: TestContext, format = "sha1") {
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
  const service = WorkflowRepositoryArtifactService.forRoot(store, root);
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
  const result = await f.service.reconcile();
  assert.equal(result.orphans, 2);
  assert.ok(existsSync(unowned) && existsSync(f.checkout));
  assert.ok(!existsSync(join(f.root, "pending", pending.id)));
  assert.ok(!existsSync(join(f.root, "digests", pending.digest)));
});

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

test("artifact readiness guards first activation and a failed artifact permits later running transitions", async (t) => {
  const f = fixture(t);
  const snapshot = await f.service.promote(await f.prepare(), f.submission());
  const id = snapshot.submissionId;
  assert.throws(() => f.store.setSubmissionState(id, "running"), /repository claim is not active/);
  f.store.commitRepositoryCaptureActivation(snapshot);
  rmSync(join(f.root, "digests", snapshot.digest, "manifest.json"));
  await assert.rejects(f.service.verify(snapshot, signal), { code: "artifact_unavailable" });
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
  await assert.rejects(f.service.verify(s, signal));
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

test("512 MiB history limit stops before a large first parent and leaves the later small parent outside", async (t) => {
  const f = fixture(t);
  f.write("a", "tip\n");
  f.git("add", ".");
  f.git("commit", "-qm", "base");
  const base = f.git("rev-parse", "HEAD"),
    tree = f.git("rev-parse", "HEAD^{tree}");
  // A sparse local fixture makes the real byte ceiling testable without allocating it on heap.
  f.write("large", "");
  truncateSync(join(f.checkout, "large"), (512 << 20) + 1);
  const big = f.git("hash-object", "-w", "--no-filters", "large");
  rmSync(join(f.checkout, "large"));
  const { commit, write } = objects(f.checkout);
  const bigTree = write("tree", Buffer.concat([Buffer.from("100644 large\0"), Buffer.from(big, "hex")]));
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
  assert.equal(existsSync(join(f.root, "digests", s.digest, big)), false);
  await lease.release();
  await f.service.release(s.submissionId);
  await f.service.reconcile();
});

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
  assert.equal((await f.service.reconcile()).orphans, 1);
  assert.ok(existsSync(foreign));
  assert.ok(!existsSync(parent) && !existsSync(dest));
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

for (const replace of [false, true]) {
  test(`stable capture retries a symlink ${replace ? "replaced" : "removed"} between lstat and readlinkat`, async (t) => {
    const f = fixture(t);
    const link = join(f.checkout, "racing-link");
    symlinkSync("old-target", link);
    f.git("add", "racing-link");
    f.git("commit", "-qm", "link");
    let reads = 0;
    let changed = false;
    const fs = (await import("node:fs/promises")).default;
    const { syncBuiltinESMExports } = await import("node:module");
    const original = fs.lstat;
    const inspect = t.mock.method(fs, "lstat", async (...args: Parameters<typeof original>) => {
      const stat = await original(...args);
      if (reads === 1 && !changed && String(args[0]).endsWith("/racing-link") && stat.isSymbolicLink()) {
        rmSync(link);
        if (replace) f.write("racing-link", "new regular file");
        changed = true;
      }
      return stat;
    });
    syncBuiltinESMExports();
    try {
      const stable = await captureStableWorkflowContext(async () => ++reads, async () => false, {
        sampleBoundary: () => f.service.sampleBoundary(f.checkout, signal),
        prepare: () => f.prepare(),
        stillCurrent: candidate => f.service.stillCurrent(candidate, signal),
        discard: candidate => f.service.discard(candidate),
      });
      assert.ok(changed && stable);
      assert.equal(stable.captured, 2);
      assert.deepEqual(readdirSync(join(f.root, "pending")), [stable.candidate.id]);
      const snapshot = await f.service.promote(stable.candidate, f.submission());
      f.store.commitRepositoryCaptureActivation(snapshot);
      const lease = await f.service.materialize(f.request(snapshot), signal);
      const entry = lease.descriptor.worktree.find(e => e.path === "racing-link");
      assert.ok(entry);
      assert.equal(entry.blob, replace ? f.git("hash-object", "racing-link") : null);
      assert.ok(entry.classifications.includes(replace ? "unstaged" : "deleted"));
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

test("disk failure and a deferred SQLite failure after rename leave no claim and recover only the marked bytes", async (t) => {
  const f = fixture(t);
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
    await assert.rejects(f.service.promote(c, submissionId));
  } finally {
    f.db.exec("DROP TRIGGER fail_after_publish; DROP TABLE deferred_failure; DROP TABLE parent;");
  }
  assert.deepEqual(f.service.artifacts(), []);
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
