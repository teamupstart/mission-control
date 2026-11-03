// The existing poll owner must observe CodeRabbit without paying for an Inspector review.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Registry } from "../src/server/registry.ts";
import { preMergeComment } from "./helpers/code-rabbit-pre-merge.ts";
const dir = mkdtempSync(join(tmpdir(), "mission-coderabbit-worker-"));
const gh = join(dir, "gh"), calls = join(dir, "calls"), snapshot = join(dir, "snapshot.json");
const model = join(dir, "model"), modelCalls = join(dir, "model-calls");
writeFileSync(modelCalls, "");
writeFileSync(model, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(modelCalls)}, 'called'); process.exit(1);\n`);
chmodSync(model, 0o755);
process.env.MISSION_CLAUDE_BIN = model;
process.env.MISSION_CODEX_BIN = model;
process.env.MISSION_PI_BIN = model;
process.env.MISSION_GH_BIN = gh;
process.env.MISSION_INSPECTOR_POLL_MS = "40";
writeFileSync(calls, "");
writeFileSync(gh, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write(fs.readFileSync(${JSON.stringify(snapshot)}, 'utf8'));
`); chmodSync(gh, 0o755);
const { setShippingConfig } = await import("../src/server/shipping/config.ts");
const { setInspectorConfig } = await import("../src/server/inspector/config.ts");
const { adoptPr, startInspector } = await import("../src/server/inspector/worker.ts");
const { readCodeRabbit, getInspectorPr } = await import("../src/server/db.ts");
const { fetchPr, fetchIssueCommentPage } = await import("../src/server/inspector/github.ts");
after(() => rmSync(dir, { force: true, recursive: true }));
const pause = () => new Promise((r) => setTimeout(r, 20));
async function until(check: () => boolean, description: string) {
  // The real poll owner launches a child, whose production budget is 20 seconds. A
  // five-second fixture deadline expired under full-suite Electron/process contention.
  const end = Date.now() + 20_000;
  while (!check() && Date.now() < end) await pause();
  assert.ok(check(), `${description}; latest CodeRabbit state: ${JSON.stringify(readCodeRabbit("a/b#1"))}`);
}

test("CodeRabbit-only sweeps use one shared snapshot, never call a model or write GitHub, and stop with both flags off", async () => {
  setInspectorConfig({ enabled: false }); setShippingConfig({ codeRabbitAutoResolve: false });
  adoptPr("https://github.com/a/b/pull/1", { cwd: dir, repoRoot: dir, sessionId: "owner" }, "hook", Date.now());
  const data = { data: { repository: { pullRequest: {
    state: "OPEN", headRefOid: "sha", headRefName: "fix", isDraft: false,
    comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    reviewThreads: { nodes: [{ id: "thread", isResolved: false, path: "a.ts", comments: { nodes: [{
      id: "root", url: "https://github.com/a/b/pull/1#discussion_r1", databaseId: 1,
      body: "finding", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      author: { __typename: "Bot", login: "coderabbitai" },
    }] } }], pageInfo: { hasNextPage: false, endCursor: null } },
  } } } };
  writeFileSync(snapshot, JSON.stringify(data));
  let sweeps = 0;
  const registry = { onPrOpened: () => () => {}, onPipelineRun: () => () => {}, refreshInspections: () => { sweeps++; } } as unknown as Registry;
  const stop = startInspector(registry);
  try {
    await new Promise((r) => setTimeout(r, 150)); assert.equal(readFileSync(calls, "utf8"), "");
    setShippingConfig({ codeRabbitAutoResolve: true });
    await until(() => (readCodeRabbit("a/b#1")?.findings.length ?? 0) === 1 && sweeps >= 2, "initial finding and completed sweep");
    const row = getInspectorPr("a/b#1")!;
    assert.equal(row.round, 0); assert.equal(row.headSha, null); assert.equal(row.observedHeadSha, "sha");
    assert.equal(row.lastError, null); assert.equal(row.mergeBlock, null);
    assert.equal(readFileSync(modelCalls, "utf8"), "");
    const invocations = readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    for (const args of invocations) {
      assert.deepEqual(args.slice(0, 2), ["api", "graphql"]);
      assert.ok(args.some((a) => a.startsWith("query=query(")));
      assert.ok(args.some((a) => a.includes("comments(first:100){ nodes{ id url body")));
      assert.ok(!args.some((a) => /mutation|--method/.test(a)));
    }
    const withChecks = { ...data.data.repository.pullRequest,
      reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      comments: { nodes: [preMergeComment(undefined, "https://github.com/a/b/pull/1#issuecomment-70")], pageInfo: { hasNextPage: false, endCursor: null } },
    };
    writeFileSync(snapshot, JSON.stringify({ data: { repository: { pullRequest: withChecks } } }));
    await until(() => readCodeRabbit("a/b#1")?.findings.filter((f) => f.present && !f.resolved).length === 3, "three pre-merge findings");
    // A malformed issue-comment read invalidates delivery and preserves prior check history.
    writeFileSync(snapshot, JSON.stringify({ data: { repository: { pullRequest: { ...withChecks, comments: null } } } }));
    await until(() => !!readCodeRabbit("a/b#1")?.error, "malformed comment read");
    assert.equal(readCodeRabbit("a/b#1")!.findings.filter((f) => f.present && !f.resolved).length, 3);
    // A malformed newer thread read also invalidates delivery without an Inspector failure.
    writeFileSync(snapshot, JSON.stringify({ data: { repository: { pullRequest: { ...data.data.repository.pullRequest, reviewThreads: null } } } }));
    await until(() => !!readCodeRabbit("a/b#1")?.error, "malformed thread read");
    assert.equal(readCodeRabbit("a/b#1")!.findings.filter((f) => f.present && !f.resolved).length, 3);
    assert.equal(getInspectorPr("a/b#1")!.lastError, null);
    setShippingConfig({ codeRabbitAutoResolve: false });
    await new Promise((r) => setTimeout(r, 150));
    const before = readFileSync(calls, "utf8"); await new Promise((r) => setTimeout(r, 150));
    assert.equal(readFileSync(calls, "utf8"), before);
  } finally { stop(); }
});

test("provider requests issue comments only when enabled and validates paginated comment metadata", async () => {
  const comments = { nodes: [preMergeComment(undefined, "https://github.com/a/b/pull/1#issuecomment-70")],
    pageInfo: { hasNextPage: false, endCursor: null } };
  const pr = { state: "OPEN", headRefOid: "sha", isDraft: false, comments,
    reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } };
  writeFileSync(snapshot, JSON.stringify({ data: { repository: { pullRequest: pr } } }));
  const disabled = await fetchPr(dir, "a", "b", 1);
  assert.equal(disabled.value?.issueComments, undefined);
  const lastCall = () => JSON.parse(readFileSync(calls, "utf8").trim().split("\n").at(-1)!) as string[];
  assert.equal(lastCall().some((arg) => arg.includes("comments(first:100){ nodes{ id url body")), false);
  assert.equal((await fetchPr(dir, "a", "b", 1, true)).value?.issueComments?.comments.length, 1);
  const page = await fetchIssueCommentPage(dir, "a", "b", 1, "next");
  assert.equal(page.value?.comments.length, 1);
  assert.ok(lastCall().includes("after=next"));
  for (const malformed of [null, { ...comments, pageInfo: {} },
    { ...comments, nodes: [{ ...comments.nodes[0], author: null }] }]) {
    writeFileSync(snapshot, JSON.stringify({ data: { repository: { pullRequest: { ...pr, comments: malformed } } } }));
    assert.ok((await fetchPr(dir, "a", "b", 1, true)).value?.issueComments?.error);
    assert.ok((await fetchIssueCommentPage(dir, "a", "b", 1, "next")).value?.error);
  }
  writeFileSync(snapshot, JSON.stringify({ errors: [{ message: "denied" }], data: { repository: { pullRequest: pr } } }));
  assert.equal((await fetchIssueCommentPage(dir, "a", "b", 1, "next")).ok, false);
});
