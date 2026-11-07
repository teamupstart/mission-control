import { mkdirSync } from "node:fs";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";

const scenarios = [
  { layout: "console", view: "chat", pinned: false },
  { layout: "console", view: "terminal", pinned: false },
  { layout: "board", view: "chat", pinned: false },
  { layout: "board", view: "terminal", pinned: false },
  { layout: "board", view: "terminal", pinned: true },
] as const;

for (const { layout, view, pinned } of scenarios) {
  test(`${layout} ${view}${pinned ? " with pinned Residents" : ""}: reopening a long cached conversation stays at its tail`, async ({ dashboard: page, daemon }) => {
    // 330px belongs to the pinned drawer, leaving the Board just above its
    // 320px rail + 440px reader floor. A viewport-based reader width cannot fit.
    if (pinned) await page.setViewportSize({ width: 1100, height: 800 });
    const config = await fetch(`${daemon.baseURL}/api/ui/config`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        layout, conversationView: view,
        residentPlacement: pinned ? "drawer" : "fleet", residentDrawerPinned: pinned,
      }),
    });
    expect(config.ok).toBe(true);
    await page.reload();
    if (pinned) {
      await expect(page.getByRole("complementary", { name: "Residents", exact: true })).toBeVisible();
    }
    for (const title of ["Long conversation", "Other conversation"]) {
      await page.getByRole("button", { name: "Dispatch", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
      await expectContentClearsBorder(dialog);
      await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
      await page.keyboard.press("Escape");
      const intent = title === "Long conversation"
        ? Array.from({ length: 60 }, (_, i) => `Paragraph ${i}: Investigate this conversation carefully and preserve the reader's place while switching between active tasks. Check the recorded messages and their ordering.`).join("\n\n")
        : "Short conversation";
      await dialog.getByPlaceholder("What should this agent do?").fill(intent);
      await dialog.getByRole("button", { name: /Backlog details/ }).click();
      await dialog.getByPlaceholder("summarized from the task if left blank").fill(title);
      await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
      await dialog.getByRole("button", { name: "Dispatch now" }).click();
      await expect(dialog).toBeHidden();
    }
    await expect.poll(async () => {
      const sessions = await (await fetch(`${daemon.baseURL}/api/sessions`)).json() as { state: string }[];
      return sessions.length === 2 && sessions.every(s => s.state === "idle");
    }).toBe(true);
    if (pinned) {
      const board = await page.locator(".board").boundingBox();
      expect(board!.width).toBeLessThan(page.viewportSize()!.width - 200);
    }

    const open = async (title: string) => {
      const target = page.getByRole("button", { name: new RegExp(title, "i") }).first();
      await target.focus();
      await target.press("Enter");
      await expect(page.locator(".cdetail").getByRole("heading", { name: title })).toBeVisible();
      await expect(page.getByRole("article", { name: "claude", exact: true }).last()).toContainText("Mock reply");
      // Wait for the Board's own transition, not for a scroll correction to hide a failure.
      await page.locator(".cdetail").evaluate(async (el) => {
        await Promise.all((el.closest(".board") ?? el.parentElement!).getAnimations({ subtree: true })
          .filter(a => a instanceof CSSTransition).map(a => a.finished.catch(() => {})));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      const bounds = await page.locator(".cdetail").boundingBox();
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
      if (pinned) {
        const board = (await page.locator(".board").boundingBox())!;
        const drawer = (await page.getByRole("complementary", { name: "Residents", exact: true }).boundingBox())!;
        console.log(JSON.stringify({ title, reader: bounds, board, drawer }));
        expect(bounds!.x).toBeGreaterThanOrEqual(board.x);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(board.x + board.width + 1);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(drawer.x + 1);
      }
    };
    const log = page.locator(".transcript-log");
    for (let visit = 0; visit < 3; visit++) {
      await open("Long conversation");
      const geometry = await log.evaluate(el => ({ top: el.scrollTop, height: el.scrollHeight, viewport: el.clientHeight, gap: el.scrollHeight - el.scrollTop - el.clientHeight }));
      console.log(JSON.stringify({ layout, view, pinned, visit, ...geometry }));
      if (process.env.MC_E2E_EVIDENCE === "1") {
        const dir = artifactsDir("conversation-task-switch-scroll");
        mkdirSync(dir, { recursive: true });
        await page.mouse.move(0, 0);
        await page.screenshot({ path: `${dir}${layout}-${view}${pinned ? "-pinned" : ""}-${visit}.png` });
      }
      expect(geometry.height).toBeGreaterThan(geometry.viewport * 3);
      expect(geometry.gap).toBeLessThan(48);
      if (visit === 2) {
        // Live output must still leave a reader who deliberately scrolled back alone.
        await log.evaluate(async el => {
          const scrolled = new Promise<void>(resolve => el.addEventListener("scroll", () => resolve(), { once: true }));
          el.scrollTop = el.scrollHeight / 2;
          await scrolled;
        });
        const before = await log.evaluate(el => el.scrollTop);
        const sessions = await (await fetch(`${daemon.baseURL}/api/sessions`)).json() as { id: string; name: string }[];
        const target = sessions.find(s => s.name === "Long conversation");
        expect(target).toBeDefined();
        const response = await fetch(`${daemon.baseURL}/api/sessions/${encodeURIComponent(target!.id)}/inject`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "New output while reading earlier history", buffer: false }),
        });
        expect(response.ok).toBe(true);
        await expect(page.getByRole("article", { name: "claude", exact: true }).last()).toContainText("Mock reply to: New output while reading earlier history");
        expect(await log.evaluate(el => el.scrollTop)).toBeCloseTo(before, 0);
        console.log(`${layout} ${view}: intentional scrollback preserved at ${before}px after live output`);
      }
      if (layout === "board") await page.getByRole("button", { name: "Back to the board" }).click();
      await open("Other conversation");
      if (layout === "board") await page.getByRole("button", { name: "Back to the board" }).click();
    }
  });
}
