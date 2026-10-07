// Every MCP tool call stamps an operation id on its daemon request, and it must keep doing
// so on a runtime without the `crypto` global. Node 18 has none, and when the header was
// minted through that global, every tool call in a session started on Node 18 failed with
// "ReferenceError: crypto is not defined" before a request was sent.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** Loaded after tsx, before the server: the server then starts on a runtime with no `crypto` global. */
const WITHOUT_CRYPTO_GLOBAL = "data:text/javascript,delete globalThis.crypto";

test("tool requests carry a generated operation id on a runtime with no crypto global", { timeout: 60_000 }, async () => {
  // The preload really removes the global, or this test proves nothing.
  assert.equal(
    execFileSync(process.execPath, ["--import", WITHOUT_CRYPTO_GLOBAL, "-e", "process.stdout.write(typeof globalThis.crypto)"], {
      encoding: "utf8",
    }),
    "undefined",
  );

  const home = mkdtempSync(join(tmpdir(), "mission-mcp-operation-id-"));
  const requests: Array<{ path: string; headers: IncomingHttpHeaders }> = [];
  const daemon = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests.push({ path: req.url!, headers: req.headers });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ commentId: "MC-376a.1", released: true }));
    });
  });
  const client = new Client({ name: "operation-id-test", version: "1" });
  try {
    await new Promise<void>((resolve) => daemon.listen(0, "127.0.0.1", resolve));
    const address = daemon.address();
    assert.ok(address && typeof address !== "string");
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import", "tsx",
        "--import", WITHOUT_CRYPTO_GLOBAL,
        fileURLToPath(new URL("../src/mcp/server.ts", import.meta.url)),
      ],
      env: {
        ...process.env,
        MISSION_HOME: home,
        MISSION_API_TOKEN: "fixture-token",
        MISSION_PORT: String(address.port),
        MISSION_SESSION_ID: "sdk:operation-id-test",
      } as Record<string, string>,
      stderr: "pipe",
    }));

    for (const body of ["first answer", "second answer"]) {
      const result = await client.callTool({
        name: "respond_to_file_comments",
        arguments: { commentId: "MC-376a.1", body },
      });
      assert.equal(result.isError, false, JSON.stringify(result.content));
      assert.match(JSON.stringify(result.content), /Answered MC-376a\.1/);
    }

    assert.deepEqual(requests.map((request) => request.path), ["/mcp/file-comments/replies", "/mcp/file-comments/replies"]);
    const ids = requests.map((request) => request.headers["x-mission-operation-id"]);
    for (const id of ids) assert.match(String(id), /^[0-9a-f]{32}$/, "a dashless UUID, minted per request");
    assert.notEqual(ids[0], ids[1], "each request gets its own operation id");
    assert.equal(requests[0]!.headers["x-mission-operation-surface"], "mcp");
    assert.equal(requests[0]!.headers["x-mission-operation-actor"], "agent");
  } finally {
    await client.close();
    await new Promise<void>((resolve) => daemon.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});
