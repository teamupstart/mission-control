import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * The nav-bar search finds a card by anything printed on it, not just its title, status and
 * agent: the repository a session runs in, the agent's product name, and on a backlog card
 * the task's agent and repository. Every query word must match, each in any field.
 *
 * One dispatch, answered by the fake agent - no model tokens.
 */

const EVIDENCE = artifactsDir("fleet-card-search");

async function api(daemon: DaemonHandle, path: string, body: unknown, method: "POST" | "PUT" = "POST"): Promise<unknown> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("tidy the readme");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => {
    const response = await fetch(`${daemon.baseURL}/api/sessions`);
    const rows = await response.json() as Array<{ state: string }>;
    return rows.find((row) => row.state !== "exited")?.state ?? "";
  }, { timeout: 60_000, message: "the dispatched session should settle" }).toBe("idle");
}

async function capture(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(EVIDENCE, name), fullPage: true });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/fleet-card-search/${name}`);
}

test("the nav-bar search matches a card's repository, agent name and backlog facts", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  await api(daemon, "/api/tasks", {
    repoRoot: daemon.secondRepo,
    title: "Rotate the deploy key",
    intent: "Rotate the deploy key.",
    agent: "codex",
    backlog: true,
    workflowId: null,
    enabled: false,
  });
  await api(daemon, "/api/ui/config", { layout: "board" }, "PUT");
  await dashboard.reload();

  const tiles = dashboard.locator("main.board .tile");
  const backlogCards = dashboard.locator("section.board-backlog .bl-card");
  await expect(tiles).toHaveCount(1);
  await expect(backlogCards).toHaveCount(1);

  const filter = dashboard.getByRole("textbox", { name: /Filter sessions/ });
  await dashboard.locator(".filter-box").click();

  // The session's repository is on its card but in none of the fields search used to read.
  await filter.fill("demo-repo");
  await expect(tiles).toHaveCount(1);
  await expect(backlogCards).toHaveCount(0);
  await capture(dashboard, "repository-match.png");

  // The agent's product name, as the card's agent dot names it.
  await filter.fill("claude code");
  await expect(tiles).toHaveCount(1);
  await expect(backlogCards).toHaveCount(0);

  // The cost chip, the last-seen cell, and the full checkout path its tooltip shows.
  const costChip = (await tiles.locator(".cost-chip").innerText()).replace("≈", "");
  await filter.fill(costChip);
  await expect(tiles).toHaveCount(1);
  await expect(backlogCards).toHaveCount(0);
  await filter.fill(await tiles.locator(".tile-seen").innerText());
  await expect(tiles).toHaveCount(1);
  await filter.fill(daemon.repo);
  await expect(tiles).toHaveCount(1);

  // The runtime chip the embedded session prints.
  await expect(tiles).toContainText("Agent SDK");
  await filter.fill("agent sdk");
  await expect(tiles).toHaveCount(1);
  await expect(backlogCards).toHaveCount(0);

  // A parked backlog card's autopilot line.
  await filter.fill("autopilot will skip");
  await expect(tiles).toHaveCount(0);
  await expect(backlogCards).toHaveCount(1);

  // Every word must match: one word the card does not carry hides it.
  await filter.fill("demo-repo zebra");
  await expect(tiles).toHaveCount(0);

  // A backlog card matches on its agent and repository, word by word.
  await filter.fill("codex second-repo");
  await expect(tiles).toHaveCount(0);
  await expect(backlogCards).toHaveCount(1);
  await expect(backlogCards).toContainText("Rotate the deploy key");
  await capture(dashboard, "backlog-agent-and-repository-match.png");
});

test("the nav-bar search skips the recent-command line on a card", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon);
  await api(daemon, "/api/ui/config", { layout: "board" }, "PUT");
  await dashboard.reload();

  // A tool call with a name nothing else on the card carries, through the real hook ingest:
  // the card's activity line then reads "running QuokkaProbe".
  const rows = await (await fetch(`${daemon.baseURL}/api/sessions`)).json() as Array<{
    agent: string; agentSessionId: string | null; cwd: string; state: string;
  }>;
  const live = rows.find((row) => row.state !== "exited" && row.agentSessionId !== null)!;
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const response = await fetch(`${daemon.baseURL}/hooks/PreToolUse`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({ agent: live.agent, sessionId: live.agentSessionId, cwd: live.cwd, env: {}, toolName: "QuokkaProbe" }),
  });
  expect(response.status, await response.text()).toBe(204);

  const tiles = dashboard.locator("main.board .tile");
  await expect(tiles.locator(".tile-activity")).toContainText("QuokkaProbe", { timeout: 15_000 });
  await capture(dashboard, "recent-command-on-card.png");

  const filter = dashboard.getByRole("textbox", { name: /Filter sessions/ });
  await dashboard.locator(".filter-box").click();
  await filter.fill("quokkaprobe");
  await expect(tiles).toHaveCount(0);
  await capture(dashboard, "recent-command-search-hides-card.png");

  // Control: the same card is still found by its title while the command line shows.
  await filter.fill("readme");
  await expect(tiles).toHaveCount(1);
  await expect(tiles.locator(".tile-activity")).toContainText("QuokkaProbe");
});
