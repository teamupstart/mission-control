import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("the scout MCP tool gates older daemons, refreshes session authority, and never completes work", { timeout: 60_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "mission-scout-mcp-"));
  let supported = false;
  const submissions: { body: Record<string, unknown>; authority: unknown }[] = [];
  const daemon = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/health") {
        res.end(JSON.stringify({ service: "mission-control", capabilities: supported ? ["multiple-scout-reports-v1"] : [] }));
      } else if (req.url === "/mcp/scouts/submit") {
        submissions.push({ body: JSON.parse(body), authority: req.headers["x-mission-scout-credential"] });
        res.end(JSON.stringify({ replayed: submissions.length > 1, archive: { key: "producer~report", artifactCount: 2, captureStatus: "complete" } }));
      } else {
        res.statusCode = 500; res.end("unexpected request");
      }
    });
  });
  const client = new Client({ name: "scout-test", version: "1" });
  const oldPort = process.env.MISSION_PORT;
  const oldHome = process.env.MISSION_HOME;
  let paths: string[] = [];
  try {
    await new Promise<void>((resolve) => daemon.listen(0, "127.0.0.1", resolve));
    const address = daemon.address(); assert(address && typeof address !== "string");
    process.env.MISSION_PORT = String(address.port);
    process.env.MISSION_HOME = home;
    const { provisionSessionScoutCredential } = await import("../src/server/scouts/submission-auth.ts");
    const authority = { sessionId: "sdk:scout-tool", taskId: null, episodeId: "episode-one", cwd: process.cwd(), pid: 0, agentSessionId: "native-one" };
    paths = provisionSessionScoutCredential(authority);
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: ["--import", "tsx", fileURLToPath(new URL("../src/mcp/server.ts", import.meta.url))],
      env: { ...process.env, MISSION_API_TOKEN: "fixture-token", MISSION_SESSION_ID: authority.sessionId } as Record<string, string>, stderr: "pipe" }));
    const args = { title: "Report one", reportPath: "docs/reports/one/report.html", summary: "Finding" };
    const old = await client.callTool({ name: "submit_scout_artifacts", arguments: args });
    assert.equal(old.isError, true);
    assert.match(JSON.stringify(old.content), /Update\/restart/);
    assert.equal(submissions.length, 0);
    supported = true;
    const first = await client.callTool({ name: "submit_scout_artifacts", arguments: args });
    assert.notEqual(first.isError, true);
    assert.match(JSON.stringify(first.content), /does not complete your task/);
    assert.equal(submissions[0]?.body.title, args.title);
    assert.equal(submissions[0]?.body.sessionId, undefined);
    provisionSessionScoutCredential({ ...authority, episodeId: "episode-two" });
    const retry = await client.callTool({ name: "submit_scout_artifacts", arguments: args });
    assert.notEqual(submissions[0]?.authority, submissions[1]?.authority);
    assert.match(JSON.stringify(retry.content), /Edited source bytes were not republished/);
    assert.match(JSON.stringify(retry.content), /#\/scouts\/producer~report/);
  } finally {
    await client.close();
    await new Promise<void>((resolve) => daemon.close(() => resolve()));
    for (const path of paths) rmSync(path, { force: true });
    rmSync(home, { recursive: true, force: true });
    if (oldPort === undefined) delete process.env.MISSION_PORT; else process.env.MISSION_PORT = oldPort;
    if (oldHome === undefined) delete process.env.MISSION_HOME; else process.env.MISSION_HOME = oldHome;
  }
});
