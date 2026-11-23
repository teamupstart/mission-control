import { mkdirSync } from "node:fs";
import { test, expect } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

test("recurring MCP preview is opt-in and its toggle reaches another window", async ({ dashboard: page, context, daemon }) => {
  await page.goto(`${daemon.baseURL}/#/settings/feature-flags`);
  const peer = await context.newPage();
  await peer.goto(page.url());
  const toggle = page.getByRole("button", { name: /^Recurring missions through MCP:/ });
  const peerToggle = peer.getByRole("button", { name: /^Recurring missions through MCP:/ });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(peerToggle).toHaveAttribute("aria-pressed", "false");
  await expect(peerToggle).toBeEnabled();
  await toggle.click();
  await expect(peerToggle).toHaveAccessibleName("Recurring missions through MCP: on");
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("textbox", { name: "Filter feature flags" }).fill("create_schedule");
  await expect(toggle).toBeVisible();
  if (process.env.MC_E2E_EVIDENCE === "1") {
    mkdirSync(artifactsDir("mcp-schedules"), { recursive: true });
    await page.screenshot({ path: `${artifactsDir("mcp-schedules")}flag-enabled.png` });
  }
  await toggle.click();
  await expect(peerToggle).toHaveAttribute("aria-pressed", "false");
});
