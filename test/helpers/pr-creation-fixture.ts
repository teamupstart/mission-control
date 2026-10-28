import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Registry } from "../../src/server/registry.ts";

/** Real HTTP and MCP, with a stateful GitHub subprocess fixture and no model or GitHub calls. */
export async function prCreationFixture(registry: Registry, home: string) {
  // Import after the caller establishes its isolated test home.
  const { ReviewManager } = await import("../../src/server/reviews.ts");
  const { QueueManager } = await import("../../src/server/queue.ts");
  const { buildApp } = await import("../../src/server/routes.ts");
  const { ensureToken } = await import("../../src/server/auth.ts");
  const { TaskManager } = await import("./task-manager-fixture.ts");
  const tasks = new TaskManager(registry);
  const app = buildApp({ registry, tasks, reviews: new ReviewManager(registry), queues: new QueueManager(registry) });
  const token = ensureToken();
  const reads: Array<{ alwaysDraftPr: boolean }> = [];
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    const response = await app.fetch(request);
    if (new URL(request.url).pathname === "/api/skills/pull-request-policy" && response.ok) {
      reads.push(await response.clone().json());
    }
    return response;
  } });
  await new Promise<void>((resolve) => server.listening ? resolve() : server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const client = new Client({ name: "pr-creation-integration", version: "1" });
  const close = async () => {
    await client.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await tasks.stop();
  };
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: ["--import", "tsx", fileURLToPath(new URL("../../src/mcp/server.ts", import.meta.url))],
      env: { ...process.env, MISSION_HOME: home, MISSION_PORT: String(address.port), MISSION_API_TOKEN: token } as Record<string, string>,
      stderr: "pipe",
    }));
  } catch (error) {
    await close();
    throw error;
  }
  const commands: string[][] = [];
  return {
    reads,
    commands,
    async setPolicy(alwaysDraftPr: boolean) {
      const response = await app.request("/api/skills/config", { method: "PUT",
        headers: { host: "127.0.0.1", "content-type": "application/json", "x-harness-token": token },
        body: JSON.stringify({ alwaysDraftPr }),
      });
      assert.equal(response.status, 200, await response.clone().text());
    },
    async readPolicy(): Promise<{ alwaysDraftPr: boolean }> {
      const result = await client.callTool({ name: "get_pull_request_policy", arguments: {} });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return JSON.parse((result.content as { text: string }[])[0]!.text);
    },
    async gh(args: string[]): Promise<string> {
      commands.push(args);
      const { stdout } = await promisify(execFile)(process.execPath, [
        fileURLToPath(new URL("../fixtures/draft-pr-gh.mjs", import.meta.url)), ...args,
      ], { env: { ...process.env, DRAFT_PR_FIXTURE_STORE: join(home, "created-prs.json") } });
      return stdout.trim();
    },
    close,
  };
}
