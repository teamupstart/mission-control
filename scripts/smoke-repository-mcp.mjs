import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export async function smokeRepositoryMcp(
  args = [resolve("dist/repository-mcp/server.mjs")],
) {
  const root = await mkdtemp(join(tmpdir(), "repository-mcp-smoke-"));
  const descriptor = join(root, "descriptor.json");
  const auditPath = join(root, "audit.jsonl");
  const operations = [
    "read",
    "search",
    "glob",
    "git_status",
    "git_diff",
    "git_show",
    "git_log",
    "git_blame",
  ];
  const view = {
    version: 1,
    snapshotDigest: "a".repeat(64),
    policyVersion: 1,
    objectView: "empty-fixture",
    head: null,
    base: null,
    indexTree: "0".repeat(40),
    worktreeTree: "0".repeat(40),
    historyPolicy: {
      version: 1,
      root: "captured_head",
      traversal: "all_parent_breadth_first",
      maxCommits: 2048,
      maxUniqueBlobBytes: 536870912,
      overflow: "stop_before_overflow",
      timestampCutoff: null,
    },
    retainedRevisions: [],
    frontier: [],
    retainedCommitCount: 0,
    retainedBlobBytes: 0,
    worktree: [],
    index: [],
  };
  await writeFile(auditPath, "");
  await writeFile(
    descriptor,
    JSON.stringify({
      view,
      objectDirectory: root,
      gitBinary: "git",
      workloadId: "smoke",
      attemptId: "smoke",
      budgets: {},
      auditPath,
      deadline: Date.now() + 30000,
    }),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: root,
      REPOSITORY_MCP_DESCRIPTOR: descriptor,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "repository-smoke", version: "1" });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  try {
    await client.connect(transport);
    assert.deepEqual(
      (await client.listTools()).tools.map((t) => t.name).sort(),
      operations.sort(),
    );
    const response = await client.callTool({ name: "glob", arguments: {} });
    assert.equal(response.isError, undefined, stderr);
    const result = JSON.parse(response.content[0].text);
    assert.equal(result.status, "ok");
    assert.deepEqual(result.items, []);
    const audit = JSON.parse((await readFile(auditPath, "utf8")).trim());
    assert.equal(audit.operationId, result.operationId);
    assert.equal(audit.operation, "glob");
    assert.deepEqual(audit.handles, []);
    assert.equal("text" in audit, false);
    const invalid = await client.callTool({
      name: "read",
      arguments: { path: "../outside" },
    });
    assert.equal(JSON.parse(invalid.content[0].text).code, "invalid_request");
    const rows = (await readFile(auditPath, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].code, "invalid_request");
    assert.deepEqual(rows[1].handles, []);
    // A pre-existing inode makes atomic publication observable without racing the writer.
    const sealPath = auditPath + ".seal";
    await writeFile(sealPath, "previous seal");
    const before = await stat(sealPath, { bigint: true });
    await client.close();
    assert.notEqual((await stat(sealPath, { bigint: true })).ino, before.ino);
    assert.deepEqual(JSON.parse(await readFile(sealPath, "utf8")), {
      workloadId: "smoke",
      attemptId: "smoke",
      count: 2,
      sha256: createHash("sha256").update(await readFile(auditPath)).digest("hex"),
    });
    console.log(
      "[smoke] repository MCP: exact eight tools, fixture query, safe audit, clean close",
    );
  } finally {
    await client.close();
    await transport.close();
    await rm(root, { recursive: true, force: true });
  }
}
