import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

/**
 * A swept GitHub sub-issue names its parent in the task editor, beside the upstream link.
 *
 * The chain: the faked `gh issue list` returns an issue with a `parent` -> a hand sweep
 * (`POST /api/task-sources/:id/sweep`) -> ingest stores it as `Task.sourceParent` -> the
 * editor draws "Sub-issue of #M" linking to the parent. The parent is display data only, so
 * the swept task must also carry no dependency edge for it.
 *
 * Nothing here reaches GitHub: `MISSION_GH_BIN` points every `gh` call at the fixture fake,
 * which answers `issue list` from `MC_E2E_GH_ISSUES`.
 */

const EVIDENCE = artifactsDir("swept-sub-issue-parent");
const TITLE = "Export archives as CSV";
const ISSUE_URL = "https://github.com/acme/demo-repo/issues/42";
const PARENT_URL = "https://github.com/acme/demo-repo/issues/7";

async function shoot(page: Page, name: string, target: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/swept-sub-issue-parent/${name}.png`);
}

test("the editor shows the parent of a swept sub-issue beside its upstream link", async ({
  dashboard,
  daemon,
}) => {
  writeFileSync(
    join(daemon.home, "gh-issues.json"),
    JSON.stringify([
      {
        number: 42,
        title: TITLE,
        body: "A CSV download.",
        url: ISSUE_URL,
        labels: [],
        assignees: [],
        updatedAt: "2026-09-01T00:00:00Z",
        state: "OPEN",
        stateReason: null,
        blockedBy: { nodes: [], totalCount: 0 },
        parent: { number: 7, title: "Archive exports", state: "OPEN", url: PARENT_URL },
      },
    ]),
  );
  const config = await dashboard.request.put(`${daemon.baseURL}/api/task-sources/config`, {
    data: {
      sources: [
        { id: "gh-e2e", kind: "github-issues", label: "demo issues", repoRoot: daemon.repo, config: { labelsAny: ["mission"] } },
      ],
    },
  });
  expect(config.ok(), await config.text()).toBe(true);
  const sweep = await dashboard.request.post(`${daemon.baseURL}/api/task-sources/gh-e2e/sweep`);
  expect(sweep.ok(), await sweep.text()).toBe(true);
  expect(((await sweep.json()) as { filed?: number }).filed, "the sweep filed the sub-issue").toBe(1);

  // Stored as display data, and never as an edge.
  const tasks = (await (await dashboard.request.get(`${daemon.baseURL}/api/tasks`)).json()) as Array<{
    title?: string;
    sourceParent?: { externalId?: string; url?: string } | null;
    dependencies?: unknown[];
  }>;
  const swept = tasks.find((t) => t.title === TITLE);
  expect(swept?.sourceParent).toMatchObject({ externalId: "acme/demo-repo#7", url: PARENT_URL });
  expect(swept?.dependencies).toEqual([]);

  const board = await dashboard.request.put(`${daemon.baseURL}/api/ui/config`, { data: { layout: "board" } });
  expect(board.ok()).toBe(true);
  await dashboard.reload();
  const card = dashboard.locator(".bl-card", { hasText: TITLE });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: TITLE, exact: true }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Edit a backlog task" });
  await expect(dialog).toBeVisible();

  const note = dialog.locator(".source-provenance-note");
  await expect(note).toContainText("Filed upstream as acme/demo-repo#42.");
  await expect(note).toContainText("Sub-issue of #7.");
  await expect(dialog.getByRole("link", { name: "acme/demo-repo#42" })).toHaveAttribute("href", ISSUE_URL);
  const parent = dialog.getByRole("link", { name: "#7", exact: true });
  await expect(parent).toHaveAttribute("href", PARENT_URL);
  await expect(parent).toHaveAttribute("target", "_blank");
  await shoot(dashboard, "01-editor-sub-issue-parent", dialog);
});
