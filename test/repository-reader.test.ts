import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  unlink,
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  REPOSITORY_HISTORY_POLICY_V1,
  REPOSITORY_DEFAULT_BUDGETS,
  type RepositoryViewDescriptor,
  type RepositoryQueryAuditMetadata,
} from "../src/shared/repository-access.ts";
import { createRepositoryReader } from "../src/server/workflows/persona-workload/reader.ts";

async function fixture(t: TestContext, content = "one\ntwo\nthree\n") {
  const root = await mkdtemp(join(tmpdir(), "repository-reader-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.test",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.test",
      },
      encoding: "utf8",
    }).trim();
  git("init", "-q");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/a.txt"), content);
  await writeFile(join(root, ".env"), "do not expose");
  await symlink("/etc/passwd", join(root, "link"));
  git("add", ".");
  git("commit", "-qm", "fixture");
  const head = git("rev-parse", "HEAD"),
    tree = git("rev-parse", "HEAD^{tree}"),
    blob = git("rev-parse", "HEAD:src/a.txt"),
    link = git("rev-parse", "HEAD:link");
  const deniedBlob = git("rev-parse", "HEAD:.env");
  await unlink(
    join(root, ".git/objects", deniedBlob.slice(0, 2), deniedBlob.slice(2)),
  );
  const view: RepositoryViewDescriptor = {
    version: 1,
    snapshotDigest: "a".repeat(64),
    policyVersion: 1,
    objectView: "fixture",
    head,
    base: null,
    indexTree: tree,
    worktreeTree: tree,
    historyPolicy: REPOSITORY_HISTORY_POLICY_V1,
    retainedRevisions: [{ id: head, parents: [], tree }],
    frontier: [],
    retainedCommitCount: 1,
    retainedBlobBytes: 100,
    worktree: [
      {
        path: "src/a.txt",
        kind: "file",
        blob,
        binary: false,
        classifications: ["committed"],
      },
      {
        path: "link",
        kind: "symlink",
        blob: link,
        binary: false,
        classifications: ["committed"],
      },
      {
        path: ".env",
        kind: "file",
        blob: "0".repeat(40),
        binary: false,
        classifications: ["sensitive_denied"],
      },
    ],
    index: [],
  };
  view.index = view.worktree;
  const audit: RepositoryQueryAuditMetadata[] = [];
  const make = (
    overrides: Partial<Parameters<typeof createRepositoryReader>[0]> = {},
  ) =>
    createRepositoryReader({
      view,
      objectDirectory: join(root, ".git"),
      gitBinary: "git",
      workloadId: "workload",
      attemptId: "attempt",
      budgets: { ...REPOSITORY_DEFAULT_BUDGETS, callItems: 2, callMs: 30000 },
      signal: new AbortController().signal,
      audit: async (row) => {
        audit.push(row);
      },
      ...overrides,
    });
  return { root, git, view, audit, make };
}
test("reads exact line pages with authenticated cursors and body-free audit", async (t) => {
  const f = await fixture(t),
    reader = f.make();
  const a = await reader.query("read", { path: "src/a.txt" });
  assert.equal(a.status, "ok");
  assert.equal(a.truncated, true);
  assert.equal(a.items.length, 2);
  assert.deepEqual(f.audit[0]!.handles[0]!.range, {
    kind: "line",
    startLine: 1,
    endLineExclusive: 2,
  });
  const b = await reader.query("read", {
    path: "src/a.txt",
    cursor: a.nextCursor,
  });
  assert.equal(b.items[0]!.text, "three");
  assert.equal(b.truncated, false);
  assert.equal(
    (await reader.query("read", { path: "link", cursor: a.nextCursor })).code,
    "invalid_cursor",
  );
  assert.equal(
    (
      await reader.query("read", {
        path: "src/a.txt",
        cursor: a.nextCursor + "x",
      })
    ).code,
    "invalid_cursor",
  );
  assert.equal(JSON.stringify(f.audit).includes('"text"'), false);
  assert.equal(JSON.stringify(f.audit).includes("three"), false);
  for (const suffix of [".extra", "#"])
    assert.equal(
      (
        await reader.query("read", {
          path: "src/a.txt",
          cursor: a.nextCursor + suffix,
        })
      ).code,
      "invalid_cursor",
    );
});
test("case-insensitive search returns one context line on each side and audits that exact range", async (t) => {
  const f = await fixture(t, "first\nBefore\nNeedle\nAfter\nlast\n");
  const result = await f.make().query("search", {
    query: "nEEDle",
    caseSensitive: false,
    context: 1,
  });
  assert.equal(result.status, "ok");
  assert.equal(result.items.length, 1);
  const [item] = result.items;
  assert.equal(item?.text, "Before\nNeedle\nAfter");
  assert.equal(item.path, "src/a.txt");
  assert.ok(item.evidenceHandleId);

  const [audit] = f.audit;
  assert.equal(audit?.operationId, result.operationId);
  assert.equal(audit.handles.length, 1);
  const [handle] = audit.handles;
  assert.equal(handle?.evidenceHandleId, item.evidenceHandleId);
  assert.deepEqual(handle.range, { kind: "line", startLine: 2, endLineExclusive: 5 });
});
test("glob and git_status return the allowed paths with their captured kinds and classifications", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "src/a.txt"), "staged edit\n");
  f.git("add", "--", "src/a.txt");
  // This sparse fixture omits the denied .env blob referenced by the tree.
  f.view.indexTree = f.git("write-tree", "--missing-ok");
  f.view.worktreeTree = f.view.indexTree;
  // Both manifests describe the staged file. The symlink is still committed.
  const staged = f.view.worktree.find((entry) => entry.path === "src/a.txt")!;
  staged.blob = f.git("rev-parse", ":src/a.txt");
  staged.classifications = ["staged"];
  const r = f.make({ budgets: REPOSITORY_DEFAULT_BUDGETS });
  for (const operation of ["glob", "git_status"] as const) {
    const result = await r.query(operation, {});
    assert.equal(result.status, "ok", operation);
    assert.equal(result.truncated, false, operation);
    assert.deepEqual(
      result.items.map(({ path, metadata }) => ({ path, metadata }))
        .sort((a, b) => a.path!.localeCompare(b.path!)),
      [
        { path: "link", metadata: { kind: "symlink", binary: false, classifications: ["committed"] } },
        { path: "src/a.txt", metadata: { kind: "file", binary: false, classifications: ["staged"] } },
      ],
      operation,
    );
  }
});
test("denied sparse blobs, symlinks and all eight operations share policy", async (t) => {
  const f = await fixture(t),
    r = f.make({ budgets: { ...REPOSITORY_DEFAULT_BUDGETS, callMs: 30000 } });
  assert.equal((await r.query("read", { path: ".env" })).code, "denied_path");
  assert.equal(
    (await r.query("read", { path: "link" })).items[0]!.text,
    "/etc/passwd",
  );
  assert.equal(
    (await r.query("search", { query: "two", caseSensitive: true })).items[0]!
      .text,
    "two",
  );
  assert.equal(
    (await r.query("git_diff", { pair: "base_head" })).items.some(
      (i) => i.path === ".env",
    ),
    false,
  );
  assert.equal(
    (await r.query("git_show", { revision: "HEAD", patch: true })).status,
    "ok",
  );
  assert.equal((await r.query("git_log", {})).status, "ok");
  assert.equal(
    (
      await r.query("git_blame", {
        revision: "HEAD",
        path: "src/a.txt",
        startLine: 1,
        endLineExclusive: 2,
      })
    ).status,
    "ok",
  );
  assert.equal(
    (await r.query("git_log", { path: ".env" })).code,
    "denied_path",
  );
  for (const op of ["git_show", "git_log", "git_blame"] as const)
    assert.equal(
      (
        await r.query(op, {
          revision: "f".repeat(40),
          ...(op === "git_blame"
            ? { path: "src/a.txt", startLine: 1, endLineExclusive: 2 }
            : {}),
        })
      ).code,
      "revision_out_of_range",
    );
});
test("raw-byte evidence is exact and missing allowed objects fail closed", async (t) => {
  const f = await fixture(t),
    r = f.make();
  const result = await r.query("read", {
    path: "src/a.txt",
    unit: "byte",
    start: 1,
    length: 3,
  });
  assert.equal(
    Buffer.from(result.items[0]!.text!, "base64").toString(),
    "ne\n",
  );
  assert.deepEqual(f.audit[0]!.handles[0]!.range, {
    kind: "byte",
    startByte: 1,
    endByteExclusive: 4,
    encoding: "raw",
  });
  f.view.worktree[0]!.blob = "f".repeat(40);
  assert.equal(
    (await f.make().query("read", { path: "src/a.txt" })).code,
    "unavailable",
  );
});
test("read refuses an allowed blob stored only in an external Git alternate", async (t) => {
  const content = "external fixture content";
  const f = await fixture(t, content);
  const alternate = await mkdtemp(join(tmpdir(), "alternate-objects-"));
  t.after(() => rm(alternate, { recursive: true, force: true }));
  const objects = join(f.root, ".git", "objects");
  const blob = f.git("rev-parse", "HEAD:src/a.txt");
  const looseObject = join(blob.slice(0, 2), blob.slice(2));
  await mkdir(join(alternate, blob.slice(0, 2)));
  await rename(join(objects, looseObject), join(alternate, looseObject));
  await writeFile(join(objects, "info", "alternates"), alternate + "\n");
  assert.equal(f.git("cat-file", "blob", blob), content);

  const result = await f.make().query("read", { path: "src/a.txt" });
  assert.equal(result.status, "failed");
  assert.equal(result.code, "unavailable");
  assert.deepEqual(result.items, []);
  assert.equal(f.audit.length, 1);
  const [audit] = f.audit;
  assert.equal(audit?.operationId, result.operationId);
  assert.equal(audit.code, "unavailable");
  assert.deepEqual(audit.handles, []);
});
test("search skips oversized and non-UTF-8 files while diff describes them without handles", async (t) => {
  const f = await fixture(t);
  const paths = ["a-large", "b-latin1", "c-text"];
  await writeFile(join(f.root, paths[0]!), Buffer.alloc(1048577, 65));
  await writeFile(join(f.root, paths[1]!), Buffer.from([0xe9, 0x0a]));
  await writeFile(join(f.root, paths[2]!), "needle\n");
  f.git("add", "--", ...paths);
  f.view.worktreeTree = f.git("write-tree", "--missing-ok");
  f.view.worktree = paths.map((path) => ({
    path, kind: "file", binary: false, blob: f.git("rev-parse", ":" + path), classifications: ["staged"],
  }));
  const reader = f.make({ budgets: REPOSITORY_DEFAULT_BUDGETS });
  const search = await reader.query("search", { query: "needle", caseSensitive: true });
  assert.equal(search.status, "ok");
  assert.deepEqual(search.items.map((item) => item.text), ["needle"]);
  const diff = await reader.query("git_diff", { pair: "index_worktree" });
  assert.equal(diff.status, "ok");
  assert.deepEqual(diff.items.map((item) => [item.path, item.metadata?.kind]), [
    ["a-large", "oversized"], ["b-latin1", "binary"], ["c-text", undefined],
  ]);
  assert.match(diff.items[2]!.text!, /\+needle/);
  for (const record of f.audit) assert.deepEqual(record.handles.map((h) => h.path), ["c-text"]);
  f.view.worktree[0]!.blob = "f".repeat(40);
  assert.equal((await f.make().query("search", { query: "needle", caseSensitive: true })).code, "unavailable");
});

// Delay one known object until the call times out. Count actual Git reads across pages.
async function pauseObjectRead(root: string, type: "blob" | "commit", oid: string) {
  const gitBinary = join(root, "pausing-git");
  await writeFile(gitBinary, [
    "#!/bin/sh", 'echo "$*" >> "$0.calls"', 'case " $* " in',
    `  *" cat-file ${type} ${oid} "*) if [ -f "$0.pause" ]; then exec sleep 10; fi;;`,
    'esac', 'exec git "$@"',
  ].join("\n"), { mode: 0o700 });
  await writeFile(gitBinary + ".pause", "");
  return {
    gitBinary,
    resume: () => unlink(gitBinary + ".pause"),
    reads: async (object: string) => (await readFile(gitBinary + ".calls", "utf8"))
      .split("\n").filter((line) => line.endsWith(`cat-file ${type} ${object}`)).length,
  };
}

test("search resumes a timed empty page at the next file, then paginates within its matches", async (t) => {
  const f = await fixture(t);
  const first = f.view.worktree[0]!;
  await writeFile(join(f.root, "last"), "found one\nfound two\n");
  f.git("add", "last");
  const last = f.git("rev-parse", ":last");
  f.view.worktree.push({ ...first, path: "last", blob: last });
  const gate = await pauseObjectRead(f.root, "blob", last);
  const reader = f.make({ gitBinary: gate.gitBinary, budgets: { ...REPOSITORY_DEFAULT_BUDGETS, callMs: 1500, callItems: 1 } });
  const query = { query: "found", caseSensitive: true };
  const empty = await reader.query("search", query);
  assert.equal(empty.status, "ok");
  assert.equal(empty.limit, "time");
  assert.ok(empty.nextCursor);
  assert.deepEqual(empty.items, []);
  assert.deepEqual(f.audit[0]!.handles, []);
  await gate.resume();
  const hit = await reader.query("search", { ...query, cursor: empty.nextCursor });
  assert.equal(hit.limit, "items");
  assert.ok(hit.nextCursor);
  const end = await reader.query("search", { ...query, cursor: hit.nextCursor });
  assert.equal(end.nextCursor, null);
  assert.deepEqual([...hit.items, ...end.items].map((item) => item.text), ["found one", "found two"]);
  assert.equal(await gate.reads(first.blob!), 1);
});

test("path-filtered log preserves earlier commits on timeout and resumes at the interrupted revision", async (t) => {
  const f = await fixture(t);
  const parent = f.view.retainedRevisions[0]!;
  await writeFile(join(f.root, "src/a.txt"), "change\n");
  f.git("add", "src/a.txt");
  f.git("rm", "--cached", ".env");
  f.git("commit", "-qm", "change");
  const head = f.git("rev-parse", "HEAD");
  f.view.head = head;
  f.view.retainedRevisions.unshift({ id: head, tree: f.git("rev-parse", "HEAD^{tree}"), parents: [parent.id] });
  f.view.retainedCommitCount = 2;
  const gate = await pauseObjectRead(f.root, "commit", parent.id);
  const reader = f.make({ gitBinary: gate.gitBinary, budgets: { ...REPOSITORY_DEFAULT_BUDGETS, callMs: 1500 } });
  const query = { path: "src/a.txt" };
  const page = await reader.query("git_log", query);
  assert.equal(page.limit, "time");
  assert.ok(page.nextCursor);
  assert.deepEqual(page.items.map((item) => item.metadata?.revision), [head]);
  await gate.resume();
  const end = await reader.query("git_log", { ...query, cursor: page.nextCursor });
  assert.equal(end.nextCursor, null);
  assert.deepEqual(end.items.map((item) => item.metadata?.revision), [parent.id]);
  assert.equal(await gate.reads(head), 1);
});
test("audit failure, cancellation and attempt limits never return evidence", async (t) => {
  const f = await fixture(t);
  const failed = await f
    .make({
      audit: async () => {
        throw Error("disk full");
      },
    })
    .query("read", { path: "src/a.txt" });
  assert.equal(failed.code, "audit_unavailable");
  assert.deepEqual(failed.items, []);
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    (
      await f
        .make({ signal: controller.signal })
        .query("read", { path: "src/a.txt" })
    ).code,
    "cancelled",
  );
  const r = f.make({
    budgets: { ...REPOSITORY_DEFAULT_BUDGETS, attemptCalls: 1 },
  });
  await r.query("glob", {});
  assert.equal((await r.query("glob", {})).code, "budget_exhausted");
  assert.deepEqual(f.audit.at(-1)!.handles, []);
});

test("queued requests beyond the call budget leave only the admitted audit records", async (t) => {
  const f = await fixture(t);
  const reader = f.make({ budgets: { ...REPOSITORY_DEFAULT_BUDGETS, attemptCalls: 2 } });
  const [cancelled, admitted, refused, lateCancel] = await Promise.all([
    reader.query("read", { path: "src/a.txt" }, AbortSignal.abort()),
    reader.query("read", { path: "src/a.txt" }),
    reader.query("read", { path: "src/a.txt" }),
    reader.query("read", { path: "src/a.txt" }, AbortSignal.abort()),
  ]);
  await reader.drain();
  assert.equal(cancelled.code, "cancelled");
  assert.equal(admitted.status, "ok");
  assert.equal(refused.code, "budget_exhausted");
  assert.deepEqual(refused.items, []);
  assert.equal(lateCancel.code, "budget_exhausted");
  assert.deepEqual(lateCancel.items, []);
  assert.deepEqual(f.audit.map((row) => row.operationId), [cancelled.operationId, admitted.operationId]);
});

test("retained history handles root, retained parent and omitted first-parent frontiers", async (t) => {
  const f = await fixture(t);
  const parent = f.view.head!;
  await writeFile(join(f.root, "src/a.txt"), "one\nchanged\nthree\n");
  f.git("add", "src/a.txt");
  // The retained tree references the denied .env blob, which the fixture deliberately omits.
  const tree = f.git("write-tree", "--missing-ok");
  const head = f.git("commit-tree", tree, "-p", parent, "-m", "next");
  f.git("update-ref", "HEAD", head, parent);
  f.view.head = head;
  f.view.retainedRevisions.unshift({ id: head, parents: [parent], tree });
  f.view.retainedCommitCount = 2;
  const full = f.make({
    budgets: { ...REPOSITORY_DEFAULT_BUDGETS, callMs: 30000 },
  });
  assert.equal(
    (await full.query("git_show", { revision: head, patch: true })).status,
    "ok",
  );
  f.view.retainedRevisions.pop();
  f.view.retainedCommitCount = 1;
  f.view.frontier = [{ revision: head, omittedParents: [parent] }];
  await writeFile(join(f.root, ".git/shallow"), head + "\n");
  const boundary = f.make({
    budgets: { ...REPOSITORY_DEFAULT_BUDGETS, callMs: 30000 },
  });
  assert.equal(
    (await boundary.query("git_show", { revision: head, patch: true })).code,
    "history_boundary",
  );
  const log = await boundary.query("git_log", {});
  assert.equal(log.historyTruncated, true);
  assert.equal(log.items.length, 1);
  const blame = await boundary.query("git_blame", {
    revision: head,
    path: "src/a.txt",
    startLine: 1,
    endLineExclusive: 2,
  });
  assert.equal(blame.status, "ok");
  assert.equal(blame.historyTruncated, true);
  assert.match(blame.items[0]!.text!, /boundary/);
  assert.equal(
    (await boundary.query("git_show", { revision: parent })).code,
    "revision_out_of_range",
  );
});

test("configured external diff, textconv and filters cannot execute", async (t) => {
  const f = await fixture(t);
  const marker = join(f.root, "executed");
  const driver = join(f.root, "driver.sh");
  await writeFile(driver, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
  f.git("config", "diff.external", driver);
  f.git("config", "diff.bad.textconv", driver);
  f.git("config", "filter.bad.clean", driver);
  await writeFile(
    join(f.root, ".git/info/attributes"),
    "* diff=bad filter=bad\n",
  );
  const r = f.make({
    budgets: { ...REPOSITORY_DEFAULT_BUDGETS, callMs: 30000 },
  });
  assert.equal((await r.query("git_diff", { pair: "base_head" })).status, "ok");
  assert.equal(
    (await r.query("git_show", { revision: "HEAD", patch: true })).status,
    "ok",
  );
  const { access } = await import("node:fs/promises");
  await assert.rejects(access(marker));
});

test("merge frontier retains first-parent patch and rejects the omitted reachable parent", async (t) => {
  const f = await fixture(t);
  const first = f.view.retainedRevisions[0]!;
  const second = f.git("commit-tree", first.tree, "-p", first.id, "-m", "side");
  const merge = f.git(
    "commit-tree",
    first.tree,
    "-p",
    first.id,
    "-p",
    second,
    "-m",
    "merge",
  );
  f.view.head = merge;
  f.view.retainedRevisions = [
    { id: merge, tree: first.tree, parents: [first.id, second] },
    first,
  ];
  f.view.retainedCommitCount = 2;
  f.view.frontier = [{ revision: merge, omittedParents: [second] }];
  const r = f.make();
  assert.equal(
    (await r.query("git_show", { revision: merge, patch: true })).status,
    "ok",
  );
  assert.equal(
    (await r.query("git_show", { revision: second })).code,
    "revision_out_of_range",
  );
});

test("four layer pairs, source base outside history, deleted-path log and exact diff ranges", async (t) => {
  const f = await fixture(t);
  const base = f.view.head!;
  f.git("rm", "--cached", ".env");
  await writeFile(join(f.root, "src/a.txt"), "committed\n");
  f.git("add", "src/a.txt");
  f.git("commit", "-qm", "change");
  const head = f.git("rev-parse", "HEAD"),
    headTree = f.git("rev-parse", "HEAD^{tree}");
  f.view.head = head;
  f.view.base = base;
  f.view.retainedRevisions = [{ id: head, tree: headTree, parents: [base] }];
  f.view.retainedCommitCount = 1;
  f.view.frontier = [{ revision: head, omittedParents: [base] }];
  await writeFile(join(f.root, "src/a.txt"), "staged\n");
  f.git("add", "src/a.txt");
  f.view.indexTree = f.git("write-tree");
  await writeFile(join(f.root, "src/a.txt"), "working\n");
  f.git("add", "src/a.txt");
  f.view.worktreeTree = f.git("write-tree");
  const r = f.make({
    budgets: { ...REPOSITORY_DEFAULT_BUDGETS, callMs: 30000 },
  });
  for (const [pair, content] of [
    ["base_head", "committed"],
    ["head_index", "staged"],
    ["index_worktree", "working"],
    ["base_worktree", "working"],
  ]) {
    const result = await r.query("git_diff", { pair, paths: ["src/a.txt"] });
    assert.equal(result.status, "ok");
    assert.match(result.items[0]!.text!, new RegExp("\\+" + content));
  }
  assert.equal(
    (await r.query("git_log", { revision: base })).code,
    "revision_out_of_range",
  );
  f.git("rm", "-f", "src/a.txt");
  f.git("commit", "-qm", "delete");
  const deleted = f.git("rev-parse", "HEAD"),
    tree = f.git("rev-parse", "HEAD^{tree}");
  f.view.head = deleted;
  f.view.retainedRevisions.unshift({ id: deleted, tree, parents: [head] });
  f.view.retainedCommitCount = 2;
  const deletion = await f.make().query("git_log", { path: "src/a.txt" });
  assert.equal(deletion.items[0]!.metadata!.revision, deleted);
  const patch = await f
    .make()
    .query("git_show", { revision: deleted, patch: true });
  assert.equal(patch.status, "ok");
  const range = f.audit.at(-1)!.handles[0]!.range;
  assert.equal(range.kind, "diff");
  if (range.kind === "diff")
    assert.equal(range.newStartLine, range.newEndLineExclusive);
});

test("blame never follows a rename into a denied missing blob and clamps evidence at EOF", async (t) => {
  const f = await fixture(t);
  const parent = f.view.retainedRevisions[0]!;
  // The denied predecessor's body is absent. Rename detection would try to open it.
  await writeFile(join(f.root, "safe.txt"), "do not expose\nchanged");
  f.git("rm", "--cached", ".env");
  f.git("add", "safe.txt");
  f.git("commit", "-qm", "rename");
  const head = f.git("rev-parse", "HEAD"),
    tree = f.git("rev-parse", "HEAD^{tree}");
  f.view.head = head;
  f.view.retainedRevisions = [{ id: head, tree, parents: [parent.id] }, parent];
  f.view.retainedCommitCount = 2;
  const result = await f.make().query("git_blame", {
    revision: head,
    path: "safe.txt",
    startLine: 1,
    endLineExclusive: 20,
  });
  assert.equal(result.status, "ok");
  assert.equal(result.items.length, 2);
  assert.deepEqual(f.audit.at(-1)!.handles[0]!.range, {
    kind: "line",
    startLine: 1,
    endLineExclusive: 2,
  });
  assert.equal(JSON.stringify(result).includes(".env"), false);
});

test("binary, submodule and non-UTF-8 entries cannot become text or host traversal", async (t) => {
  const f = await fixture(t);
  f.git("rm", "--cached", ".env");
  await writeFile(join(f.root, "binary"), Buffer.from([0, 255, 1]));
  f.git("add", "binary");
  f.git(
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${f.view.head},submodule`,
  );
  f.git("commit", "-qm", "opaque entries");
  f.view.worktreeTree = f.git("rev-parse", "HEAD^{tree}");
  const result = await f.make().query("git_diff", { pair: "index_worktree" });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.items.map((i) => i.metadata?.kind).sort(), [
    "binary",
    "submodule",
  ]);
  assert.deepEqual(f.audit.at(-1)!.handles, []);
  // Invalid UTF-8 remains unaddressable, never decoded through replacement characters.
  // Construct Git bytes directly: APFS itself refuses non-UTF-8 filenames.
  f.view.worktreeTree = execFileSync(
    "git",
    ["hash-object", "-w", "-t", "tree", "--stdin"],
    {
      cwd: f.root,
      input: Buffer.concat([
        Buffer.from("100644 "),
        Buffer.from([255, 0]),
        Buffer.from(f.view.worktree[0]!.blob!, "hex"),
      ]),
      encoding: "utf8",
    },
  ).trim();
  const invalid = await f.make().query("git_diff", { pair: "index_worktree" });
  assert.equal(invalid.code, "unavailable");
  assert.deepEqual(invalid.items, []);
});

test("response and cumulative byte ceilings, timeout, scrubbing and cursor attempt binding", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.root, "src/a.txt"),
    Array.from({ length: 200 }, (_, i) => `${i} ${"x".repeat(90)}`).join("\n"),
  );
  f.git("add", "src/a.txt");
  f.view.worktree[0]!.blob = f.git("rev-parse", ":src/a.txt");
  const budgets = {
    ...REPOSITORY_DEFAULT_BUDGETS,
    callBytes: 4096,
    attemptBytes: 8192,
    callMs: 30000,
  };
  const r = f.make({ budgets });
  let cursor: string | null = null,
    bytes = 0;
  for (let i = 0; i < 10; i++) {
    const page = await r.query("read", {
      path: "src/a.txt",
      ...(cursor ? { cursor } : {}),
    });
    if (page.code === "budget_exhausted") break;
    assert.equal(page.status, "ok");
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 4096);
    bytes += page.bytes;
    cursor = page.nextCursor;
    assert.ok(cursor);
    if (i === 0)
      assert.equal(
        (await f.make().query("read", { path: "src/a.txt", cursor })).code,
        "invalid_cursor",
      );
  }
  assert.ok(bytes <= 8192);
  assert.equal(f.audit.at(-1)!.code, "budget_exhausted");
  const slow = join(f.root, "slow-git");
  await writeFile(slow, "#!/bin/sh\nexec sleep 2\n", { mode: 0o700 });
  assert.equal(
    (
      await f
        .make({
          gitBinary: slow,
          budgets: { ...REPOSITORY_DEFAULT_BUDGETS, callMs: 10 },
        })
        .query("read", { path: "src/a.txt" })
    ).code,
    "timeout",
  );
  await writeFile(
    join(f.root, "src/a.txt"),
    "before\n-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\nafter\n",
  );
  f.git("add", "src/a.txt");
  f.view.worktree[0]!.blob = f.git("rev-parse", ":src/a.txt");
  const scrubbed = await f
    .make()
    .query("read", { path: "src/a.txt", start: 4, length: 1 });
  assert.equal(scrubbed.items.length, 1);
  assert.deepEqual(f.audit.at(-1)!.handles[0]!.range, {
    kind: "line",
    startLine: 5,
    endLineExclusive: 6,
  });
  assert.equal(JSON.stringify(scrubbed).includes("abc"), false);
  assert.equal(
    (await f.make().query("read", { path: "src/a.txt", unit: "byte" })).code,
    "denied_path",
  );
});
