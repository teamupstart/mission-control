import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expect, test } from "../fixtures/test.ts";

const EVIDENCE = artifactsDir("fleet-pr-filter");
const PR_NUMBER = 864;
const PR_URL = `https://github.com/acme/mission-e2e/pull/${PR_NUMBER}`;

interface SessionRow {
  id: string;
  state: string;
  agent: string;
  cwd: string;
  agentSessionId: string | null;
  prNumber: number | null;
}

async function sessions(daemon: DaemonHandle): Promise<SessionRow[]> {
  const response = await fetch(`${daemon.baseURL}/api/sessions`);
  expect(response.ok).toBe(true);
  return response.json() as Promise<SessionRow[]>;
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<SessionRow> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("make the PR searchable");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let live: SessionRow | undefined;
  await expect.poll(async () => {
    live = (await sessions(daemon)).find((session) => session.state !== "exited");
    return live?.state ?? "";
  }, { timeout: 60_000, message: "the dispatched session should settle before its PR opens" })
    .toBe("idle");
  return live!;
}

async function announcePullRequest(daemon: DaemonHandle, session: SessionRow): Promise<void> {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const response = await fetch(`${daemon.baseURL}/hooks/Stop`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({
      agent: session.agent,
      sessionId: session.agentSessionId ?? session.id,
      cwd: session.cwd,
      prCreated: true,
      prUrl: PR_URL,
    }),
  });
  expect(response.ok, await response.text()).toBe(true);
  await expect.poll(async () => (await sessions(daemon))[0]?.prNumber ?? null).toBe(PR_NUMBER);
}

async function useLayout(
  page: Page,
  daemon: DaemonHandle,
  layout: "board" | "console",
): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout }),
  });
  expect(response.ok).toBe(true);
  await page.reload();
  await expect(page.getByRole("button", { name: "Dispatch" })).toBeVisible();
}

async function capture(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(EVIDENCE, name), fullPage: true });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/fleet-pr-filter/${name}`);
}

test("a visible PR number keeps its session in Board and Console search results", async ({
  dashboard,
  daemon,
}) => {
  const session = await dispatch(dashboard, daemon);
  await announcePullRequest(daemon, session);

  await useLayout(dashboard, daemon, "board");
  const filter = dashboard.getByRole("textbox", { name: /Filter sessions/ });
  const boardCard = dashboard.locator("main.board .tile");
  await expect(boardCard.getByRole("link", { name: /#864/ })).toBeVisible();
  await dashboard.locator(".filter-box").click();
  await filter.fill(String(PR_NUMBER));
  await expect(boardCard).toBeVisible();
  await expect(boardCard.getByRole("link", { name: /#864/ })).toBeVisible();
  await capture(dashboard, "board-pr-number-result.png");

  await useLayout(dashboard, daemon, "console");
  const consoleFilter = dashboard.getByRole("textbox", { name: /Filter sessions/ });
  const rail = dashboard.getByRole("navigation", { name: "Sessions" });
  const railPrLabel = rail.getByText(`#${PR_NUMBER}`, { exact: true });
  await expect(railPrLabel).toBeVisible();
  await dashboard.locator(".filter-box").click();
  await consoleFilter.fill(String(PR_NUMBER));
  await expect(railPrLabel).toBeVisible();
  await capture(dashboard, "console-pr-number-result.png");
});
