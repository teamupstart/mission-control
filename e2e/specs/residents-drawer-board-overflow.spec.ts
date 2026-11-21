import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { ResidentProfile } from "../../src/shared/residents.ts";

/**
 * A Board whose columns do not fit beside the Residents drawer (#1579). Columns keep their 250px
 * floor and the Board scrolls sideways, as it always could; what this holds is where that scroll
 * is cut. It used to be cut at the drawer's own border, and with macOS's overlay scrollbar hidden
 * at rest a half-drawn column there read as the drawer laid over the Board. Now the Board keeps
 * its gutter outside its scrollport and draws a real scrollbar track.
 *
 * Its own file because Playwright launches Chromium with `--hide-scrollbars`, which draws no
 * track at all, and only a file-level `test.use` can launch the browser without it.
 *
 * Same setup as `residents-drawer.spec.ts`. No model tokens are spent: every agent binary is
 * redirected by `e2e/fixtures/fake-agents.ts`.
 */
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

const EVIDENCE = artifactsDir("residents-drawer-board-overflow");
const NAME = "Drawer watcher";

async function capture(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
}

async function request<T>(daemon: DaemonHandle, path: string, body?: unknown, method = "POST"): Promise<T> {
  const response = await fetch(daemon.baseURL + path, body === undefined && method === "GET" ? {} : {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

function waitingResidents(daemon: DaemonHandle): number {
  return withDaemonDb(daemon, (db) => (db.prepare(
    "SELECT COUNT(*) AS n FROM resident_runs WHERE ended_at IS NULL AND launch_state = 'launched' AND loop_state = 'waiting'",
  ).get() as { n: number }).n);
}

/** Author a resident profile and launch it through the real routes, then wait until it is waiting. */
async function launch(daemon: DaemonHandle): Promise<void> {
  const personas = await request<Array<{ id: string; name: string }>>(daemon, "/api/personas", undefined, "GET");
  const profile = await request<ResidentProfile>(daemon, "/api/residents/profiles", { settings: {
    identity: { name: NAME }, persona: { personaId: personas.find((p) => p.name === "Code Risk Reviewer")!.id },
    workspace: { defaultRepoRoot: daemon.repo }, execution: { model: "claude-fable-5" },
    // A long cadence keeps the resident waiting between steps instead of iterating under the test.
    loop: { delaySeconds: 3600, minDelaySeconds: 60, maxDelaySeconds: 3600 },
  } });
  await request(daemon, `/api/residents/profiles/${profile.id}/launch`, { repoRoot: daemon.repo, requestId: "launch-overflow" });
  await expect.poll(() => waitingResidents(daemon), { timeout: 60_000 }).toBe(1);
}

const drawerOf = (page: Page): Locator => page.getByRole("complementary", { name: "Residents", exact: true });

test("a Board too wide to fit beside the drawer scrolls inside its own gutter, never under the drawer, pinned or not", async ({ dashboard: page, daemon }) => {
  await launch(daemon);
  // Two columns, Backlog and Idle, which a 760px window cannot fit beside the 330px drawer.
  await request(daemon, "/api/tasks", { repoRoot: daemon.repo, title: "Overflow neighbour", intent: "settle and wait", workflowId: null });
  await request(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title: "Overflow later", intent: "Overflow later", backlog: true, workflowId: null, enabled: false,
  });
  const placement = { residentPlacement: "drawer", residentDrawerPinned: false, layout: "board" };
  await request(daemon, "/api/ui/config", placement, "PUT");
  await page.evaluate((next) => {
    const raw = JSON.parse(window.localStorage.getItem("mission-control.ui") ?? "{}") as Record<string, unknown>;
    window.localStorage.setItem("mission-control.ui", JSON.stringify({ ...raw, ...next }));
  }, placement);
  await page.setViewportSize({ width: 760, height: 800 });
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await page.reload();
  const board = page.locator(".board");
  await expect(board.getByText("Overflow neighbour").first()).toBeVisible({ timeout: 60_000 });
  await expect(board.getByText("Overflow later").first()).toBeVisible();

  await page.keyboard.press("Shift+KeyH");
  const drawer = drawerOf(page);
  await expect(drawer).toBeVisible();

  const expectBoardBesideDrawer = async (label: string): Promise<void> => {
    const g = await board.evaluate((el) => ({
      right: el.getBoundingClientRect().right,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      track: el.offsetHeight - el.clientHeight,
    }));
    const drawerLeft = (await drawer.boundingBox())!.x;
    expect(g.scrollWidth, `${label}: the Board's columns do not fit beside the drawer`).toBeGreaterThan(g.clientWidth);
    // The Board's scrollport ends a gutter short of the drawer, as its left edge sits a gutter in
    // from the window: a column cut off by the scroll is cut there, not at the drawer's border.
    expect(drawerLeft - g.right, `${label}: gutter between the Board's scrollport and the drawer`).toBe(20);
    // A reserved track rather than macOS's overlay, which hides at rest.
    expect(g.track, `${label}: the Board reserves its scrollbar track`).toBe(10);

    // At either end of the scroll, what sits just left of the drawer's border is the gutter, never a card.
    for (const end of [false, true]) {
      await board.evaluate((el, toEnd) => { el.scrollLeft = toEnd ? el.scrollWidth : 0; }, end);
      const hit = await page.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        return el?.closest(".board-col") ? "column" : el?.closest(".residents-drawer") ? "drawer" : "gutter";
      }, { x: drawerLeft - 4, y: 400 });
      expect(hit, `${label}, scrolled to the ${end ? "end" : "start"}: just left of the drawer`).toBe("gutter");
    }
  };

  /**
   * Press Pin or Unpin with the Board overflowing, and watch every frame from the press until
   * well past the Board's 0.34s transitions: at no frame may the Board's scrollport reach into
   * its gutter, or a column be what sits just left of the drawer's border.
   */
  const expectEveryFrameBesideDrawer = async (button: "Pin" | "Unpin", after: "Pin" | "Unpin"): Promise<void> => {
    await board.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await page.evaluate(() => {
      const w = window as unknown as { __frames: Array<{ gap: number; hit: string; overflow: boolean }>; __sampling: boolean };
      w.__frames = [];
      w.__sampling = true;
      const sample = (): void => {
        const board = document.querySelector<HTMLElement>(".board");
        const drawer = document.querySelector<HTMLElement>(".residents-drawer");
        if (board && drawer) {
          const left = drawer.getBoundingClientRect().left;
          const el = document.elementFromPoint(left - 4, 400);
          w.__frames.push({
            gap: left - board.getBoundingClientRect().right,
            hit: el?.closest(".board-col") ? "column" : el?.closest(".residents-drawer") ? "drawer" : "gutter",
            overflow: board.scrollWidth > board.clientWidth,
          });
        } else {
          w.__frames.push({ gap: Number.NaN, hit: board ? "no drawer" : "no board", overflow: false });
        }
        if (w.__sampling) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await drawer.getByRole("button", { name: button, exact: true }).click();
    await expect(drawer.getByRole("button", { name: after, exact: true })).toBeVisible();
    await page.waitForTimeout(800);
    const frames = await page.evaluate(() => {
      const w = window as unknown as { __frames: Array<{ gap: number; hit: string; overflow: boolean }>; __sampling: boolean };
      w.__sampling = false;
      return w.__frames;
    });
    expect(frames.length, `${button}: frames sampled through the change`).toBeGreaterThan(10);
    for (const [i, frame] of frames.entries()) {
      expect(frame, `${button}, frame ${i}: the Board overflows and stays a gutter short of the drawer`)
        .toEqual({ gap: 20, hit: "gutter", overflow: true });
    }
  };

  await expectBoardBesideDrawer("unpinned");
  await capture(page, "01-unpinned");
  // Pinning and unpinning in place, with no reload between: the same column, every frame.
  await expectEveryFrameBesideDrawer("Pin", "Unpin");
  await expectBoardBesideDrawer("pinned in place");
  await expectEveryFrameBesideDrawer("Unpin", "Pin");
  await expectBoardBesideDrawer("unpinned in place");
  await drawer.getByRole("button", { name: "Pin", exact: true }).click();
  await expect(drawer.getByRole("button", { name: "Unpin", exact: true })).toBeVisible();
  await page.reload();
  await expect(drawer).toBeVisible();
  await expect(board.getByText("Overflow neighbour").first()).toBeVisible({ timeout: 60_000 });
  await expectBoardBesideDrawer("pinned");
  await board.evaluate((el) => { el.scrollLeft = 0; });
  await capture(page, "02-pinned");

  // The drill-in still runs edge to edge up to the drawer: the gutter belongs to the overview.
  await board.getByText("Overflow neighbour").first().click();
  await expect(page.locator(".board-detail")).toBeVisible();
  await expect.poll(async () => {
    const boardBox = (await board.boundingBox())!;
    return Math.round((await drawer.boundingBox())!.x - (boardBox.x + boardBox.width));
  }).toBe(0);
});
