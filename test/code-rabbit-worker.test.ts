// The existing poll owner must observe CodeRabbit without paying for an Inspector review.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Registry } from "../src/server/registry.ts";
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
after(() => rmSync(dir, { force: true, recursive: true }));
const pause = () => new Promise((r) => setTimeout(r, 20));
async function until(check: () => boolean) { const end = Date.now() + 5000; while (!check() && Date.now() < end) await pause(); assert.ok(check()); }

test("CodeRabbit-only sweeps use one shared snapshot, never call a model or write GitHub, and stop with both flags off", async () => {
  setInspectorConfig({ enabled: false }); setShippingConfig({ codeRabbitAutoResolve: false });
  adoptPr("https://github.com/a/b/pull/1", { cwd: dir, repoRoot: dir, sessionId: "owner" }, "hook", Date.now());
  const data = { data: { repository: { pullRequest: {
    state: "OPEN", headRefOid: "sha", headRefName: "fix", isDraft: false,
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
    await until(() => (readCodeRabbit("a/b#1")?.findings.length ?? 0) === 1 && sweeps >= 2);
    const row = getInspectorPr("a/b#1")!;
    assert.equal(row.round, 0); assert.equal(row.headSha, null); assert.equal(row.observedHeadSha, "sha");
    assert.equal(row.lastError, null); assert.equal(row.mergeBlock, null);
    assert.equal(readFileSync(modelCalls, "utf8"), "");
    const invocations = readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    for (const args of invocations) {
      assert.deepEqual(args.slice(0, 2), ["api", "graphql"]);
      assert.ok(args.some((a) => a.startsWith("query=query(")));
      assert.ok(!args.some((a) => /mutation|--method/.test(a)));
    }
    // A malformed newer read invalidates delivery without writing an Inspector failure.
    writeFileSync(snapshot, JSON.stringify({ data: { repository: { pullRequest: { ...data.data.repository.pullRequest, reviewThreads: null } } } }));
    await until(() => !!readCodeRabbit("a/b#1")?.error);
    assert.equal(readCodeRabbit("a/b#1")!.findings.length, 1);
    assert.equal(getInspectorPr("a/b#1")!.lastError, null);
    setShippingConfig({ codeRabbitAutoResolve: false });
    await new Promise((r) => setTimeout(r, 150));
    const before = readFileSync(calls, "utf8"); await new Promise((r) => setTimeout(r, 150));
    assert.equal(readFileSync(calls, "utf8"), before);
  } finally { stop(); }
});
