import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { recordsIn } from "../fixtures/records.ts";

// Claude's deduplication is explicitly simulated by fake-claude.mjs. Tool discovery and
// execution use a real loopback MCP server. No Claude model, OAuth account or external server.
for (const optOut of [false, true]) {
  test(`duplicate native plugin tool is ${optOut ? "available after opt-out" : "suppressed without opt-out"}`, async ({ dashboard: page, daemon }) => {
    const receipt = `Plugin tool answered: ${randomUUID()}`;
    let requests = 0;
    let calls = 0;
    const server = createServer(async (request, response) => {
      requests += 1;
      const mcp = new McpServer({ name: "duplicate-plugin-fixture", version: "1" });
      mcp.registerTool("plugin_ping", { description: "Return this fixture server's receipt", inputSchema: {} }, async () => {
        calls += 1;
        return { content: [{ type: "text", text: receipt }] };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      response.on("close", () => { void mcp.close(); });
      try {
        await mcp.connect(transport);
        await transport.handleRequest(request, response);
      } catch (error) {
        if (!response.headersSent) response.writeHead(500);
        response.end(String(error));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
      const pluginRoot = join(daemon.home, ".claude", "plugins", "cache", "duplicate-tools", "1.0.0");
      mkdirSync(join(pluginRoot, ".claude-plugin"), { recursive: true });
      writeFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "duplicate-tools", version: "1.0.0" }));
      writeFileSync(join(pluginRoot, ".mcp.json"), JSON.stringify({ mcpServers: { fixture: { type: "http", url } } }));
      writeFileSync(join(daemon.recordDir, "duplicate-plugin-fixture.json"), JSON.stringify({
        pluginRoot, connector: { name: "claude.ai Fixture", url },
      }));

      await page.goto(`${daemon.baseURL}/#/residents/new`);
      const editor = page.getByRole("region", { name: "New resident profile" });
      await editor.getByLabel("Name").fill("Duplicate Plugin Fixture");
      await editor.getByLabel("Profile instructions").fill("Probe the local duplicate plugin fixture.");
      await editor.getByLabel("Default repository").fill(daemon.repo);
      await page.keyboard.press("Escape");
      await editor.getByRole("radio", { name: "All native sources (not pinned)" }).click();
      const confirm = page.getByRole("dialog", { name: "Import all native MCP sources" });
      await expectContentClearsBorder(confirm);
      await confirm.getByRole("button", { name: "Import all sources" }).click();
      const checkbox = editor.getByRole("checkbox", { name: "Disable claude.ai connectors" });
      await expect(checkbox).not.toBeChecked();
      if (optOut) await checkbox.check();
      await editor.getByRole("button", { name: "Save" }).click();
      const saved = page.getByRole("region", { name: "Resident profile Duplicate Plugin Fixture" });
      await saved.getByRole("button", { name: "Launch" }).click();
      const dispatch = page.getByRole("dialog", { name: "Dispatch an agent" });
      await expectContentClearsBorder(dispatch);
      await dispatch.getByRole("button", { name: "Launch resident" }).click();
      await expect(dispatch).toBeHidden({ timeout: 60_000 });

      const readProof = () => recordsIn<{
        duplicateConfigured: boolean; connectors: string[]; plugins: string[]; tools: string[]; results: string[];
      }>(join(daemon.recordDir, "plugin-probes"))[0];
      await expect.poll(readProof, { timeout: 60_000 }).toBeTruthy();
      const proof = readProof()!;
      expect(proof).toEqual({
        duplicateConfigured: true,
        connectors: [],
        plugins: optOut ? ["plugin:duplicate-tools:fixture"] : [],
        tools: optOut ? ["plugin:duplicate-tools:fixture/plugin_ping"] : [],
        results: optOut ? [receipt] : [],
      });
      expect(calls).toBe(optOut ? 1 : 0);
      expect(requests).toBe(optOut ? 4 : 0); // initialize, initialized, tools/list, tools/call
      console.log(JSON.stringify({ fixture: "simulated Claude deduplication; real loopback MCP", optOut, requests, calls, ...proof }));

      await page.goto(`${daemon.baseURL}/#/fleet`);
      await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
      const conversation = page.locator(".console-detail");
      await expect(conversation).toContainText("Connectors: none");
      await expect(conversation).toContainText(optOut ? receipt : "Plugin tools: none");
      if (process.env.MC_E2E_EVIDENCE) {
        const dir = artifactsDir("issue-1441-plugin-availability");
        mkdirSync(dir, { recursive: true });
        await page.mouse.move(0, 0);
        await conversation.screenshot({ path: join(dir, optOut ? "opt-out-enabled.png" : "default-suppressed.png") });
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
}
