import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";

// Real dispatch -> fake app-server frames -> Registry -> SSE -> existing Phase 1 renderer.
// No UI summaries are seeded and every agent invocation uses the fixture's fake binary.
test("Codex background children remain visible after their parent ends and fold on the next send", async ({ dashboard, daemon }) => {
  const config = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "board" }),
  });
  expect(config.ok).toBe(true);
  await dashboard.reload();
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("E2E_CODEX_BACKGROUND_AGENTS");
  await dialog.locator("select").filter({ hasText: "Claude Code" }).selectOption("codex");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await expectContentClearsBorder(dialog);
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  const tile = dashboard.locator("main.board .tile").filter({ hasText: "E2E_CODEX_BACKGROUND_AGENTS" });
  const tree = dashboard.getByRole("group", { name: /^Background sub-agents of / });
  await expect(tree.getByRole("button", { name: "2 sub-agents · 1 running" })).toBeVisible();
  await expect(tile.locator(".tile-activity")).toHaveText(/idle · 1 agent still running/);
  const rows = tree.getByRole("listitem");
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "Map the ledger" })).toContainText("explorer");
  const done = rows.filter({ hasText: "Review ledger tests" });
  await expect(done).toHaveClass(/is-completed/);
  await expect(done).toContainText("done");
  await expect(tree).not.toContainText(/\d+ tools|\d+ tokens/);
  if (process.env.MC_E2E_EVIDENCE === "1") {
    const dir = artifactsDir("codex-background-agents");
    mkdirSync(dir, { recursive: true });
    await dashboard.mouse.move(0, 0);
    await dashboard.locator("main.board section.board-col.tone-idle").screenshot({ path: join(dir, "children.png") });
  }

  await tile.click();
  const detail = dashboard.locator(".cdetail");
  const reply = detail.getByPlaceholder(/^Reply to this session/);
  await expect(reply).toBeEnabled();
  const restart = "restart the reviewer before acknowledging this send";
  await reply.fill(restart);
  await reply.press("Enter");
  await expect(detail.getByText(`Mock reply to: ${restart}`)).toBeVisible();
  await dashboard.keyboard.press("Escape");
  await dashboard.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);
  await expect(tree.getByRole("button", { name: "2 sub-agents · 1 running" })).toBeVisible();
  await expect(done).toBeVisible();
  await expect(done).toHaveClass(/is-completed/);
  await expect(tree.getByText("1 finished")).toHaveCount(0);
  if (process.env.MC_E2E_EVIDENCE === "1") {
    await dashboard.mouse.move(0, 0);
    await dashboard.locator("main.board section.board-col.tone-idle").screenshot({
      path: join(artifactsDir("codex-background-agents"), "completion-after-restart.png"),
    });
  }

  await tile.click();
  await expect(reply).toBeEnabled();
  await reply.fill("continue after reviewing the child result");
  await reply.press("Enter");
  await expect(detail.getByText("Mock reply to: continue after reviewing the child result")).toBeVisible();
  await dashboard.keyboard.press("Escape");
  await dashboard.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);
  await expect(tree.getByRole("button", { name: "1 sub-agent · 1 running" })).toBeVisible();
  await expect(tree.getByText("1 finished")).toBeVisible();
  await expect(rows.filter({ hasText: "Review ledger tests" })).toHaveCount(0);
});
