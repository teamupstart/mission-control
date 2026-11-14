import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Pausing sessions (issue #1471), end to end: a click on a pause control reaches the route,
 * the daemon really stops the agent's process with SIGSTOP, and the frozen state comes back
 * over SSE to every surface - the card, the console, the title bar - and back again on resume.
 *
 * The session is a real SDK-runtime session whose driver child is the fake Claude, so the
 * freeze is observable in the process table (`T`) without spending a token. A reply typed
 * while paused is held in the outbox and delivered on resume, which is the promise the
 * composer's "Queue" makes.
 */

const EVIDENCE = artifactsDir("session-pause");

interface LiveSession {
  id: string;
  name: string;
  state: string;
  cwd: string | null;
  pause?: { reason: string; phase: string } | null;
  pendingTurns?: unknown[];
}

async function sessions(daemon: DaemonHandle): Promise<LiveSession[]> {
  const response = await fetch(`${daemon.baseURL}/api/sessions`);
  return (await response.json()) as LiveSession[];
}

async function sessionById(daemon: DaemonHandle, id: string): Promise<LiveSession | undefined> {
  return (await sessions(daemon)).find((s) => s.id === id);
}

async function dispatchIdle(page: Page, daemon: DaemonHandle, title: string): Promise<LiveSession> {
  const before = new Set((await sessions(daemon)).map((s) => s.id));
  await page.getByRole("button", { name: "Dispatch", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(`${title}: say hello`);
  await dialog.getByRole("button", { name: /Backlog details/ }).click();
  await dialog.getByPlaceholder("summarized from the task if left blank").fill(title);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  let fresh: LiveSession | undefined;
  await expect.poll(async () => {
    fresh = (await sessions(daemon)).find((s) => !before.has(s.id) && s.state !== "exited");
    return fresh?.cwd ? fresh.state : "";
  }, { timeout: 60_000, message: `the dispatch for "${title}" settled idle` }).toBe("idle");
  return fresh!;
}

async function putUi(daemon: DaemonHandle, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.ok, "the daemon accepted the UI preference").toBe(true);
}

/**
 * The states of every process under the daemon running the fake Claude - the SDK driver's
 * child and its descendants. `T` is stopped.
 */
async function fakeAgentStates(daemon: DaemonHandle): Promise<string[]> {
  const health = (await (await fetch(`${daemon.baseURL}/api/health`)).json()) as { pid: number };
  const table = execFileSync("/bin/ps", ["-A", "-o", "pid=,ppid=,state=,command="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), state: m[3]!, command: m[4]! }));
  const under = new Set([health.pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of table) {
      if (!under.has(p.pid) && under.has(p.ppid)) {
        under.add(p.pid);
        grew = true;
      }
    }
  }
  return table.filter((p) => under.has(p.pid) && /fake-claude/.test(p.command)).map((p) => p.state);
}

async function shoot(page: Page, target: Locator | Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control, and nothing focused: a resting pointer or a focused trigger portals a
  // tooltip over what is photographed.
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await target.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/session-pause/${name}.png`);
}

async function boardCard(page: Page, name: string): Promise<Locator> {
  const card = page.locator(".tile").filter({ has: page.locator(".tile-name", { hasText: name }) });
  await expect(card).toBeVisible();
  return card;
}

test("the run chip pauses a card's agent for real, and resumes it", async ({ dashboard: page, daemon }) => {
  const session = await dispatchIdle(page, daemon, "Pause chip ledger");
  await putUi(daemon, { layout: "board" });
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();

  const card = await boardCard(page, session.name);
  const chip = card.getByRole("button", { name: "Pause controls: Running" });
  await expect(chip).toBeVisible();
  await expect.poll(() => fakeAgentStates(daemon), { message: "the fake agent is running" }).not.toContain("T");

  await chip.click();
  const menu = page.getByRole("menu", { name: "Pause" });
  await expect(menu).toBeVisible();
  await shoot(page, page, "card-chip-menu");
  await menu.getByRole("menuitem", { name: /^Pause now/ }).click();

  await expect.poll(async () => (await sessionById(daemon, session.id))?.pause?.phase).toBe("frozen");
  await expect(card).toHaveClass(/is-paused/);
  await expect(card.locator(".tf-paused")).toContainText("Paused");
  await expect(card.getByRole("button", { name: /^Pause controls: Paused/ })).toBeVisible();
  await expect.poll(() => fakeAgentStates(daemon), { message: "the agent's process is stopped" }).toContain("T");
  await shoot(page, card, "card-paused");

  await card.getByRole("button", { name: /^Pause controls: Paused/ }).click();
  await page.getByRole("menu", { name: "Pause" }).getByRole("menuitem", { name: /^Resume/ }).click();
  await expect.poll(async () => (await sessionById(daemon, session.id))?.pause ?? null).toBeNull();
  await expect(card).not.toHaveClass(/is-paused/);
  await expect(card.getByRole("button", { name: "Pause controls: Running" })).toBeVisible();
  await expect.poll(() => fakeAgentStates(daemon), { message: "the agent runs again" }).not.toContain("T");
});

test("every pause control is a Display choice with its own preview, and the board obeys it", async ({ dashboard: page, daemon }) => {
  const session = await dispatchIdle(page, daemon, "Pause settings ledger");
  await page.evaluate(() => {
    window.location.hash = "#/settings/display";
  });
  const panel = page.locator('[data-anchor="display/pause-controls"]');
  await panel.scrollIntoViewIfNeeded();
  await expect(panel.getByRole("heading", { name: "Pause controls" })).toBeVisible();

  const options = [
    ["Card: Corner buttons", "Preview: card corner buttons", false],
    ["Card: Run chip", "Preview: card run chip", true],
    ["Card: Card menu", "Preview: card card menu", false],
    ["Console: Toolbar button", "Preview: console toolbar button", true],
    ["Console: Message box button", "Preview: console message box button", false],
    ["Console: State badge and band", "Preview: console state badge and band", true],
  ] as const;
  for (const [box, preview, on] of options) {
    const checkbox = panel.getByRole("checkbox", { name: box, exact: true });
    if (on) await expect(checkbox, `${box} ships on`).toBeChecked();
    else await expect(checkbox, `${box} ships off`).not.toBeChecked();
    // Each preview draws its control on a running card or console and on a paused one.
    await expect(panel.getByRole("group", { name: preview, exact: true }), `${preview} is drawn`).toBeVisible();
  }
  // What each preview shows is that control, and only that one.
  await expect(panel.getByRole("group", { name: "Preview: card corner buttons" }).locator(".pause-corner")).toHaveCount(2);
  await expect(panel.getByRole("group", { name: "Preview: card run chip" }).locator(".pause-chip")).toHaveCount(2);
  await expect(panel.getByRole("group", { name: "Preview: card card menu" }).locator(".pause-more")).toHaveCount(2);
  await expect(panel.getByRole("group", { name: "Preview: card card menu" }).locator(".pause-pill")).toHaveCount(1);
  await expect(panel.getByRole("group", { name: "Preview: console toolbar button" }).locator(".pause-toolbar-btn")).toHaveCount(2);
  await expect(panel.getByRole("group", { name: "Preview: console message box button" }).locator(".composer-pause-btn")).toHaveCount(2);
  await expect(panel.getByRole("group", { name: "Preview: console state badge and band" }).locator(".badge-pause-half")).toHaveCount(2);
  await expect(panel.getByRole("group", { name: "Preview: console state badge and band" }).locator(".pause-band")).toHaveCount(1);
  // Tall enough to hold the whole panel, so the sticky title bar cannot cover part of it.
  if (process.env.MC_E2E_EVIDENCE === "1") {
    const size = page.viewportSize()!;
    await page.setViewportSize({ width: size.width, height: 2600 });
    await panel.scrollIntoViewIfNeeded();
    await shoot(page, panel, "settings-pause-controls");
    await page.setViewportSize(size);
  }

  // Corner buttons and the card menu on, the chip off.
  await panel.getByRole("checkbox", { name: "Card: Corner buttons", exact: true }).check();
  await panel.getByRole("checkbox", { name: "Card: Card menu", exact: true }).check();
  await panel.getByRole("checkbox", { name: "Card: Run chip", exact: true }).uncheck();
  await expect.poll(async () => {
    const body = (await (await fetch(`${daemon.baseURL}/api/ui/config`)).json()) as { config: { pauseCardControls: string[] } };
    return [...body.config.pauseCardControls].sort();
  }).toEqual(["corner", "menu"]);

  await putUi(daemon, { layout: "board" });
  await page.evaluate(() => {
    window.location.hash = "#/fleet";
  });
  await page.reload();
  const card = await boardCard(page, session.name);
  await expect(card.locator(".pause-chip")).toHaveCount(0);
  await card.hover();
  await card.getByRole("button", { name: "Pause", exact: true }).click();
  await expect.poll(async () => (await sessionById(daemon, session.id))?.pause?.phase).toBe("frozen");
  // A paused card keeps its one-click way back: the corner's play button and the menu's pill.
  await expect(card.getByRole("button", { name: "Resume", exact: true })).toHaveCount(2);
  await shoot(page, card, "card-corner-and-menu-paused");
  await card.locator(".pause-pill").click();
  await expect.poll(async () => (await sessionById(daemon, session.id))?.pause ?? null).toBeNull();

  // The ⋯ menu pauses after the current turn too.
  await card.getByRole("button", { name: "Session actions" }).click();
  await page.getByRole("menu", { name: "Pause" }).getByRole("menuitem", { name: /^Pause after this turn/ }).click();
  // Idle already, so there is no turn to wait for: it freezes at once.
  await expect.poll(async () => (await sessionById(daemon, session.id))?.pause?.phase).toBe("frozen");
  await card.locator(".pause-pill").click();
  await expect.poll(async () => (await sessionById(daemon, session.id))?.pause ?? null).toBeNull();
});

test("the console's toolbar, badge band and composer pause it, and a reply sent meanwhile waits for resume", async ({ dashboard: page, daemon }) => {
  const session = await dispatchIdle(page, daemon, "Pause console ledger");
  await putUi(daemon, { pauseConsoleControls: ["toolbar", "badge", "composer"] });
  await page.reload();
  await page.locator(".rail-row").filter({ hasText: session.name }).click();

  await page.getByRole("button", { name: "Pause controls: running" }).click();
  await page.getByRole("menu", { name: "Pause" }).getByRole("menuitem", { name: /^Pause now/ }).click();
  await expect.poll(async () => (await sessionById(daemon, session.id))?.pause?.phase).toBe("frozen");

  // The band under the header, the badge's own half, the composer's band and button, and Send
  // saying what it will do now.
  const band = page.locator(".cdetail > .pause-band");
  await expect(band).toContainText("Paused");
  await expect(page.locator(".badge.is-paused")).toContainText("paused");
  await expect(page.getByRole("button", { name: "Resume this session", exact: true })).toBeVisible();
  await expect(page.locator(".pause-band.is-inline")).toContainText("delivered when it resumes");
  await expect(page.getByRole("button", { name: "Resume session", exact: true })).toBeVisible();
  await expect(page.locator(".btn-send")).toHaveText("Queue");
  await expect(page.locator(".rail-row").filter({ hasText: session.name })).toHaveClass(/is-paused/);
  await shoot(page, page, "console-paused");

  // A reply typed now is held in the outbox, not typed into a frozen agent.
  await page.getByPlaceholder(/^Reply to this session/).fill("still there?");
  await page.locator(".btn-send").click();
  await expect.poll(async () => ((await sessionById(daemon, session.id))?.pendingTurns ?? []).length).toBe(1);
  await page.waitForTimeout(2_500);
  expect(((await sessionById(daemon, session.id))?.pendingTurns ?? []).length, "nothing was delivered while paused").toBe(1);

  // Resume from the band; the held reply goes out on its own.
  await band.getByRole("button", { name: /Resume/ }).click();
  await expect.poll(async () => (await sessionById(daemon, session.id))?.pause ?? null).toBeNull();
  await expect(page.locator(".btn-send")).toHaveText("Send");
  await expect.poll(async () => ((await sessionById(daemon, session.id))?.pendingTurns ?? []).length, {
    timeout: 30_000,
    message: "the held reply is delivered once the session resumes",
  }).toBe(0);

  // The composer's own button pauses too, and the badge's half resumes.
  await page.getByRole("button", { name: "Pause session", exact: true }).click();
  await expect.poll(async () => (await sessionById(daemon, session.id))?.pause?.phase).toBe("frozen");
  await page.getByRole("button", { name: "Resume this session", exact: true }).click();
  await expect.poll(async () => (await sessionById(daemon, session.id))?.pause ?? null).toBeNull();
});

test("Pause all freezes the fleet from the title bar, and priority keeps one session running", async ({ dashboard: page, daemon }) => {
  const first = await dispatchIdle(page, daemon, "Pause fleet one");
  const second = await dispatchIdle(page, daemon, "Pause fleet two");

  await page.getByRole("button", { name: "Pause all", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Pause all" });
  await expect(confirm).toContainText("Pause all 2 sessions");
  await expect(confirm.getByRole("checkbox", { name: /Hold automatic launches too/ })).toBeChecked();
  await shoot(page, page, "fleet-pause-confirm");
  await confirm.getByRole("button", { name: "Pause 2 sessions" }).click();

  const banner = page.getByRole("status", { name: "Everything is paused" });
  await expect(banner).toContainText("2 sessions frozen, and automatic launches are held");
  for (const s of [first, second]) {
    await expect.poll(async () => (await sessionById(daemon, s.id))?.pause?.reason).toBe("fleet");
  }
  await expect.poll(async () => {
    const states = await fakeAgentStates(daemon);
    return states.length >= 2 && states.every((state) => state.startsWith("T"));
  }, { message: "both agents' processes are stopped" }).toBe(true);
  const state = (await (await fetch(`${daemon.baseURL}/api/pause`)).json()) as { fleet: { holdDispatch: boolean } | null };
  expect(state.fleet?.holdDispatch).toBe(true);
  await expect(page.getByRole("button", { name: /^Resume all - 2 sessions paused/ })).toBeVisible();
  await shoot(page, page, "fleet-paused");

  await banner.getByRole("button", { name: /Resume all now/ }).click();
  await expect(banner).toBeHidden();
  for (const s of [first, second]) {
    await expect.poll(async () => (await sessionById(daemon, s.id))?.pause ?? null).toBeNull();
  }

  // Priority: the first keeps running, the second pauses for it.
  await page.locator(".rail-row").filter({ hasText: first.name }).click();
  await page.getByRole("button", { name: "Pause controls: running" }).click();
  await page.getByRole("menu", { name: "Pause" }).getByRole("menuitem", { name: /^Make priority/ }).click();
  const priority = page.getByRole("status", { name: "Priority session" });
  await expect(priority).toContainText(`Priority: ${first.name}`);
  await expect.poll(async () => (await sessionById(daemon, second.id))?.pause?.reason).toBe("priority");
  expect((await sessionById(daemon, first.id))?.pause ?? null).toBeNull();
  await expect(page.locator(".cdetail > .pause-band.is-priority")).toContainText("1 session paused");
  await expect(page.locator(".rail-row").filter({ hasText: second.name })).toHaveClass(/is-paused/);
  await shoot(page, page, "priority");

  await priority.getByRole("button", { name: /End priority/ }).click();
  await expect(priority).toBeHidden();
  await expect.poll(async () => (await sessionById(daemon, second.id))?.pause ?? null).toBeNull();
});
