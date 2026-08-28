import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

const EVIDENCE = artifactsDir("file-list-resize");
const TASK = "resize the file list while reading a file and its diff";

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/file-list-resize/${name}.png`);
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(TASK);
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

async function sessionCwd(daemon: DaemonHandle): Promise<string> {
  await expect.poll(async () => {
    const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as {
      cwd: string | null;
    }[];
    return sessions[0]?.cwd ?? null;
  }).not.toBeNull();
  const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as {
    cwd: string | null;
  }[];
  return sessions[0]!.cwd!;
}

async function useConsoleLayout(page: Page, daemon: DaemonHandle): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "console" }),
  });
  expect(response.ok).toBe(true);
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Sessions" })).toBeVisible();
}

async function dragBy(page: Page, divider: Locator, deltaX: number): Promise<void> {
  const box = await divider.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + deltaX, y, { steps: 8 });
  await page.mouse.up();
}

async function width(locator: Locator): Promise<number> {
  return locator.evaluate((element) => element.getBoundingClientRect().width);
}

test("file lists can be dragged narrower to give Files and Diff more reading room", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.setViewportSize({ width: 1512, height: 900 });
  await dispatch(dashboard, daemon);
  const cwd = await sessionCwd(daemon);
  mkdirSync(join(cwd, "docs", "plans"), { recursive: true });
  writeFileSync(
    join(cwd, "docs", "plans", "long-file-name-for-pane-resizing.md"),
    "# Resizable file list\n\nThe document pane should gain the space the list gives up.\n",
  );
  writeFileSync(join(cwd, "src-long-file-name-for-pane-resizing.ts"), "export const width = 264;\n");
  await useConsoleLayout(dashboard, daemon);

  await dashboard
    .getByRole("navigation", { name: "Sessions" })
    .getByRole("button", { name: /Resize the File List/i })
    .click();
  const tabs = dashboard.getByRole("tablist", { name: "Session detail" });

  await tabs.getByRole("tab", { name: /Files$/ }).click();
  const filesList = dashboard.getByRole("listbox", { name: "Session files" });
  await expect(filesList).toBeVisible();
  const filesMain = dashboard.locator(".file-main");
  const filesDivider = dashboard.getByRole("separator", { name: "Resize file list" });
  await expect(filesDivider).toBeVisible();
  const filesBefore = { list: await width(dashboard.locator(".file-nav")), main: await width(filesMain) };
  await dragBy(dashboard, filesDivider, -96);
  const filesAfter = { list: await width(dashboard.locator(".file-nav")), main: await width(filesMain) };
  expect(filesBefore.list - filesAfter.list).toBeGreaterThanOrEqual(94);
  expect(filesAfter.main - filesBefore.main).toBeGreaterThanOrEqual(94);

  await filesDivider.focus();
  await dashboard.keyboard.press("ArrowRight");
  expect(Math.round(await width(dashboard.locator(".file-nav")) - filesAfter.list)).toBe(16);
  await shoot(dashboard, "files-list-narrower");

  await filesDivider.dblclick();
  await expect.poll(() => width(dashboard.locator(".file-nav"))).toBeCloseTo(filesBefore.list, 0);

  await tabs.getByRole("tab", { name: /Diff$/ }).click();
  const diff = dashboard.getByRole("region", { name: "Session diff" });
  await expect(diff).toBeVisible();
  const changed = dashboard.getByRole("navigation", { name: "Changed files" });
  const detail = dashboard.locator(".diff-detail");
  const diffDivider = dashboard.getByRole("separator", { name: "Resize changed files list" });
  await expect(diffDivider).toBeVisible();
  const diffBefore = { list: await width(changed), detail: await width(detail) };
  await dragBy(dashboard, diffDivider, -80);
  const diffAfter = { list: await width(changed), detail: await width(detail) };
  expect(diffBefore.list - diffAfter.list).toBeGreaterThanOrEqual(78);
  expect(diffAfter.detail - diffBefore.detail).toBeGreaterThanOrEqual(78);
  await shoot(dashboard, "diff-list-narrower");
});
