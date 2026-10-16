import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { APP_CONFIG_ENTRIES } from "../src/shared/app-config-entries.ts";

const home = mkdtempSync(join(tmpdir(), "mission-pr-policy-"));
process.env.MISSION_HOME = home;
for (const agent of ["CLAUDE", "CODEX", "PI"]) process.env[`${agent}_SKILLS_DIR`] = join(home, agent);
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { openDb, closeDb, setAppConfig } = await import("../src/server/db.ts");
const { getSkillsConfig } = await import("../src/server/skills/config.ts");
after(() => { closeDb(); rmSync(home, { recursive: true, force: true }); });

test("HTTP settings and the real MCP policy tool share one live preference, including legacy, disabled, and invalid settings", { timeout: 30_000 }, async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const app = buildApp({ registry, tasks, reviews: new ReviewManager(registry), queues: new QueueManager(registry) });
  const token = ensureToken();
  let mode: "live" | "old-daemon" | "malformed" = "live";
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
    if (mode === "old-daemon") return new Response("Not found", { status: 404 });
    if (mode === "malformed") return Response.json({});
    return app.fetch(request);
  } });
  await new Promise<void>((resolve) => server.listening ? resolve() : server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const client = new Client({ name: "pr-policy-test", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: ["--import", "tsx", fileURLToPath(new URL("../src/mcp/server.ts", import.meta.url))],
      env: { ...process.env, MISSION_HOME: home, MISSION_PORT: String(address.port), MISSION_API_TOKEN: token } as Record<string, string>,
      stderr: "pipe",
    }));
    const read = () => client.callTool({ name: "get_pull_request_policy", arguments: {} });
    const expectPolicy = async (alwaysDraftPr: boolean) => {
      const result = await read();
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.deepEqual(JSON.parse((result.content as { text: string }[])[0]!.text), { alwaysDraftPr });
    };
    const write = (body: object) => app.request("/api/skills/config", {
      method: "PUT", headers: { host: "127.0.0.1", "content-type": "application/json", "x-harness-token": token }, body: JSON.stringify(body),
    });
    await expectPolicy(false);
    setAppConfig(APP_CONFIG_ENTRIES.skills, { enabled: false, skills: {}, generation: 7, generationAt: 42 });
    await expectPolicy(false);
    for (const alwaysDraftPr of [true, false, true]) {
      const response = await write({ alwaysDraftPr });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await response.json()).alwaysDraftPr, alwaysDraftPr);
      await expectPolicy(alwaysDraftPr);
      assert.equal(getSkillsConfig().generation, 7);
      assert.equal(getSkillsConfig().enabled, false);
    }
    assert.equal((await write({ alwaysDraftPr: "false" })).status, 400);
    await expectPolicy(true);
    closeDb();
    await expectPolicy(true); // Reopening persistence does not reset the choice.
    openDb().prepare("UPDATE app_config SET value = ? WHERE key = ?").run(JSON.stringify({ alwaysDraftPr: "false" }), "skills");
    assert.equal((await read()).isError, true, "corrupt settings must not become a false policy");
    openDb().prepare("UPDATE app_config SET value = ? WHERE key = ?").run("{", "skills");
    assert.equal((await read()).isError, true, "corrupt JSON must also refuse");
    mode = "old-daemon";
    assert.equal((await read()).isError, true, "an unavailable endpoint must not default off");
    mode = "malformed";
    assert.equal((await read()).isError, true, "a missing boolean must not default off");
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await tasks.stop();
  }
});
