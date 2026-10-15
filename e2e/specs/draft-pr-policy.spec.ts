import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

for (const skillsEnabled of [true, false]) {
  test(`the draft PR toggle beside the skill persists and reaches the live agent policy tool with Skills ${skillsEnabled ? "on" : "off"}`, async ({ dashboard, daemon }) => {
    await dashboard.goto(`${daemon.baseURL}/#/settings/skills`);
    const master = dashboard.getByRole("checkbox", { name: "Enable Mission Control skills", exact: true });
    await expect(master).toBeChecked();
    if (!skillsEnabled) await master.uncheck();
    const skillToggle = dashboard.getByRole("checkbox", { name: /^Enable \/pull-request in every/ });
    await expect(skillToggle).toBeEnabled({ enabled: skillsEnabled });
    const control = dashboard.getByRole("checkbox", { name: "Always create draft PRs", exact: true });
    await expect(control).toBeVisible();
    await expect(control).toBeEnabled();
    await expect(control).not.toBeChecked();
    const row = dashboard.locator('[data-anchor="skills/always-draft-pr"]');
    await expect(row).toContainText("Only a human promotes drafts to ready for review");
    await expect(row.locator("xpath=preceding-sibling::*[1]")).toContainText("/pull-request");
    const client = new Client({ name: "draft-pr-browser-proof", version: "1" });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath,
        args: [fileURLToPath(new URL("../../dist/mcp/server.mjs", import.meta.url))],
        env: { ...process.env, MISSION_HOME: daemon.home, MISSION_PORT: new URL(daemon.baseURL).port,
          MISSION_API_TOKEN: readFileSync(join(daemon.home, "token"), "utf8").trim() } as Record<string, string>,
        stderr: "pipe",
      }));
      const readPolicy = async () => {
        const result = await client.callTool({ name: "get_pull_request_policy", arguments: {} });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        return JSON.parse((result.content as { text: string }[])[0]!.text);
      };
      expect(await readPolicy()).toEqual({ alwaysDraftPr: false });
      await control.check();
      await expect.poll(readPolicy).toEqual({ alwaysDraftPr: true });
      await dashboard.reload();
      await expect(control).toBeChecked();
      await expect(master).toBeChecked({ checked: skillsEnabled });
      await daemon.crash();
      await daemon.restart();
      await dashboard.reload();
      await expect(control).toBeChecked();
      await expect(master).toBeChecked({ checked: skillsEnabled });
      expect(await readPolicy()).toEqual({ alwaysDraftPr: true });
      if (process.env.MC_E2E_EVIDENCE === "1") {
        const evidence = artifactsDir("draft-pr-policy");
        mkdirSync(evidence, { recursive: true });
        await control.scrollIntoViewIfNeeded();
        await dashboard.screenshot({ path: `${evidence}always-draft-enabled${skillsEnabled ? "" : "-skills-off"}.png` });
      }
      await control.uncheck();
      await expect.poll(readPolicy).toEqual({ alwaysDraftPr: false });
      await dashboard.reload();
      await expect(control).not.toBeChecked();
      // A failed save restores the confirmed value and names the error.
      await dashboard.route("**/api/skills/config", (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Draft preference could not be saved" }) }));
      await control.check();
      await expect(dashboard.getByText("Draft preference could not be saved")).toBeVisible();
      await expect(control).not.toBeChecked();
      expect(await readPolicy()).toEqual({ alwaysDraftPr: false });
    } finally {
      await client.close();
    }
  });
}
