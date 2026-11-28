import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

// The orphaned-worktree reclaim preview, against the shipped registry: its row appears in
// Settings > Feature flags with its description, switching it in one window reaches a second
// one without a reload, and the daemon's retention diagnostics follow the same choice. The
// deletion rules themselves are exercised against real Git fixtures in
// `test/task-worktree-orphan-reclaim.test.ts`, where a case costs milliseconds.
test("the orphaned-worktree reclaim row toggles live and the retention diagnostics follow it", async ({ dashboard: page, context, daemon }) => {
  await page.goto(`${daemon.baseURL}/#/settings/feature-flags`);
  const peer = await context.newPage();
  await peer.goto(page.url());
  let peerNavigations = 0;
  peer.on("framenavigated", (frame) => { if (frame === peer.mainFrame()) peerNavigations++; });
  const toggle = (window: Page) => window.getByRole("button", { name: /^Reclaim orphaned task worktrees:/ });
  const orphanReclaim = async () => {
    const response = await fetch(`${daemon.baseURL}/api/worktrees`);
    expect(response.ok).toBe(true);
    return ((await response.json()) as { retention: { orphanReclaim: string } }).retention.orphanReclaim;
  };

  await expect(page.getByText("Reclaim orphaned task worktrees", { exact: true })).toBeVisible();
  await expect(page.getByText(
    "Let automatic cleanup return task checkouts Git no longer recognizes after archiving their local-only files, and finish tasks whose terminal home is proved gone.",
  )).toBeVisible();
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  await expect(toggle(peer)).toHaveAttribute("aria-pressed", "false");
  expect(await orphanReclaim(), "the class is off until the operator chooses it").toBe("off");

  await toggle(page).click();
  await expect(toggle(page)).toHaveAccessibleName("Reclaim orphaned task worktrees: on");
  await expect(toggle(peer)).toHaveAttribute("aria-pressed", "true");
  await expect.poll(orphanReclaim).toBe("enforce");
  // The second window's own filter narrows it to this row; the toggle stays reachable.
  await peer.getByRole("textbox", { name: "Filter feature flags" }).fill("orphaned");
  await expect(peer.getByText("Reclaim orphaned task worktrees", { exact: true })).toBeVisible();
  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(artifactsDir("orphaned-worktree-reclaim-flag"), { recursive: true });
    await peer.screenshot({ path: `${artifactsDir("orphaned-worktree-reclaim-flag")}peer-on.png` });
  }

  await toggle(peer).click();
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  await expect.poll(orphanReclaim).toBe("off");
  expect(peerNavigations, "the second window changed without navigating").toBe(0);

  // The panel's filter finds it by a keyword.
  await page.getByRole("textbox", { name: "Filter feature flags" }).fill("orphaned");
  await expect(toggle(page)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Seven-day worktree cleanup:/ })).toHaveCount(0);
});
