import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The session rail beside an open session folds down to a 40px strip, so the conversation and
 * the terminal take the width it held.
 *
 * Only a browser settles what this promises. That the detail pane actually widens once the
 * grid track and the Board's `--board-rail-width` have both had their say. That a click on the
 * fold reaches the daemon and comes back as a fold that survives a reload. That `[` folds and
 * unfolds from the keyboard, and that Escape out of the reader still leaves it when no rail
 * row exists to take focus. And that a folded strip still reacts when a session starts waiting
 * on you, which is a server event arriving at a rail that has no rows drawn.
 *
 * No model tokens: the agents are `e2e/fixtures/fake-agents.ts`, and the question is posted over
 * `POST /mcp/reviews`, the route the agent's MCP child uses.
 */

const EVIDENCE = artifactsDir("session-rail-fold");

interface LiveSession {
  id: string;
  state: string;
  cwd: string | null;
}

async function sessions(daemon: DaemonHandle): Promise<LiveSession[]> {
  const response = await fetch(`${daemon.baseURL}/api/sessions`);
  if (!response.ok) throw new Error(`/api/sessions answered ${response.status}`);
  return (await response.json()) as LiveSession[];
}

async function railFolded(daemon: DaemonHandle): Promise<boolean> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`);
  if (!response.ok) throw new Error(`/api/ui/config answered ${response.status}`);
  return ((await response.json()) as { config: { sessionRailFolded: boolean } }).config.sessionRailFolded;
}

/** Dispatch one agent and wait for it to settle idle with a checkout. */
async function dispatchIdleAgent(page: Page, daemon: DaemonHandle, goal: string): Promise<LiveSession> {
  const before = new Set((await sessions(daemon)).map((s) => s.id));
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // The repo combobox portals its listbox over the Task field; close it before the next fill.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(goal);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let fresh: LiveSession | undefined;
  await expect.poll(async () => {
    fresh = (await sessions(daemon)).find((s) => !before.has(s.id) && s.state !== "exited");
    return fresh?.cwd ? fresh.state : "";
  }, { timeout: 60_000, message: `the dispatch for "${goal}" settled with a checkout` })
    .toBe("idle");
  return fresh!;
}

/** Ask this session's human a question, which sorts it into Needs you. */
async function askForInput(daemon: DaemonHandle, cwd: string): Promise<void> {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const res = await fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({
      env: {},
      cwd,
      kind: "input",
      title: "Should this reach a folded rail?",
      body: "Should this reach a folded rail?",
      decisions: [{
        id: "q",
        question: "Should this reach a folded rail?",
        options: [{ id: "o0", label: "yes", recommended: true }],
        allowOther: false,
      }],
    }),
  });
  expect(res.status, `the review channel accepted the question: ${await res.clone().text()}`)
    .toBe(200);
}

/** Write UI preferences out of band, then reload so the web store hydrates them. */
async function useUi(page: Page, daemon: DaemonHandle, patch: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  expect(response.ok, `the daemon accepted ${JSON.stringify(patch)}`).toBe(true);
  await page.reload();
}

async function capture(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
}

async function widthOf(element: Locator): Promise<number> {
  const box = await element.boundingBox();
  expect(box, "the element is laid out").not.toBeNull();
  return box!.width;
}

test("the Console rail folds to a strip, the detail takes its width, and the fold survives a reload", async ({
  dashboard: page,
  daemon,
}) => {
  await dispatchIdleAgent(page, daemon, "Sit beside a folded rail");
  await useUi(page, daemon, { layout: "console" });

  const rail = page.getByRole("navigation", { name: "Sessions", exact: true });
  const detail = page.locator(".console-detail");
  await rail.locator(".rail-row").first().click();
  await expect(page.locator(".console-detail .detail-title")).toContainText(/Sit Beside A Folded Rail/i);
  const openRail = await widthOf(rail);
  const openDetail = await widthOf(detail);
  expect(openRail, "the open rail holds its usual track").toBeGreaterThan(250);
  await capture(page, "01-console-open");

  // The fold control sits in the rail's head, which stays put while the rows scroll.
  await rail.getByRole("button", { name: "Fold the session rail" }).click();
  const strip = page.getByRole("button", { name: "Unfold All sessions: 1 idle" });
  await expect(strip).toBeVisible();
  await expect(rail.locator(".rail-row")).toHaveCount(0);
  await expect.poll(() => widthOf(rail)).toBeLessThanOrEqual(41);
  // Every pixel the rail gave up went to the conversation's pane.
  await expect.poll(() => widthOf(detail)).toBeGreaterThanOrEqual(openDetail + openRail - 41);
  await expect(strip.locator(".session-rail-strip-n.tone-idle")).toHaveText("1");
  await capture(page, "02-console-folded");

  // Saved on the daemon, which is what makes the fold outlive the page.
  await expect.poll(() => railFolded(daemon)).toBe(true);
  await page.reload();
  await expect(page.getByRole("button", { name: "Unfold All sessions: 1 idle" })).toBeVisible();
  await expect(rail.locator(".rail-row")).toHaveCount(0);

  // The strip is the way back.
  await page.getByRole("button", { name: "Unfold All sessions: 1 idle" }).click();
  await expect(rail.locator(".rail-row")).toHaveCount(1);
  await expect.poll(() => widthOf(rail)).toBeGreaterThan(250);
  await expect.poll(() => railFolded(daemon)).toBe(false);
});

test("[ folds and unfolds the rail, and Escape out of the reader lands on the strip", async ({
  dashboard: page,
  daemon,
}) => {
  await dispatchIdleAgent(page, daemon, "Fold from the keyboard");
  await useUi(page, daemon, { layout: "console" });

  const rail = page.getByRole("navigation", { name: "Sessions", exact: true });
  await rail.locator(".rail-row").first().click();

  await page.keyboard.press("[");
  const strip = page.getByRole("button", { name: /^Unfold All sessions/ });
  await expect(strip).toBeVisible();
  await expect.poll(() => railFolded(daemon)).toBe(true);

  // Into the reader and back out. No rail row exists to take the keyboard, so the strip does -
  // and a second Escape must then reach past the reader rather than re-entering it.
  await page.keyboard.press("Tab");
  await expect(page.locator(".cdetail .detail-body")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(strip).toBeFocused();

  await page.keyboard.press("[");
  await expect(rail.locator(".rail-row")).toHaveCount(1);
  await expect.poll(() => railFolded(daemon)).toBe(false);

  // A bare key, so it must never be eaten out of a half-written reply.
  await page.getByRole("button", { name: "Fold the session rail" }).click();
  await expect(strip).toBeVisible();
  await strip.click();
  const composer = page.locator(".cdetail textarea").first();
  await composer.click();
  await page.keyboard.type("[draft]");
  await expect(composer).toHaveValue(/\[draft\]/);
  await expect(rail.locator(".rail-row")).toHaveCount(1);
});

test("the arrow keys still switch sessions while the rail is folded", async ({
  dashboard: page,
  daemon,
}) => {
  // Two sessions, so a step has somewhere to go. Folding removes every rail row, so this is the
  // claim that App walks its own session order rather than the rows on screen.
  await dispatchIdleAgent(page, daemon, "Walk the first session");
  await dispatchIdleAgent(page, daemon, "Walk the second session");
  await useUi(page, daemon, { layout: "console" });

  const rail = page.getByRole("navigation", { name: "Sessions", exact: true });
  const title = page.locator(".console-detail .detail-title");
  await rail.locator(".rail-row").first().click();
  // `textContent`, the same reading `toHaveText` compares against. `innerText` is the rendered
  // text - line breaks between the badges and the kind badge upper-cased by CSS - so a value
  // captured with it never equals the title, and a `not.toHaveText` on it passes vacuously.
  const titleText = async (): Promise<string> => ((await title.textContent()) ?? "").trim();
  const first = await titleText();
  expect(first).toMatch(/Walk the (First|Second) Session/i);

  await rail.getByRole("button", { name: "Fold the session rail" }).click();
  const strip = page.getByRole("button", { name: "Unfold All sessions: 2 idle" });
  await expect(strip).toBeVisible();
  await expect(rail.locator(".rail-row")).toHaveCount(0);

  // Down opens the other session; the keyboard stays on the strip that stands in for the rows.
  await page.keyboard.press("ArrowDown");
  await expect(title).not.toHaveText(first);
  const second = await titleText();
  // The two titles are the two sessions, one each - not the same session read twice.
  expect([first, second].join(" | ")).toMatch(/Walk the First Session/i);
  expect([first, second].join(" | ")).toMatch(/Walk the Second Session/i);
  await expect(strip).toBeFocused();
  await expect(rail.locator(".rail-row")).toHaveCount(0);

  // And Up walks back.
  await page.keyboard.press("ArrowUp");
  await expect(title).toHaveText(first);
});

test("a folded rail counts and pulses each time another session starts waiting on you", async ({
  dashboard: page,
  daemon,
}) => {
  await dispatchIdleAgent(page, daemon, "Stay open in the reader");
  const firstAsker = await dispatchIdleAgent(page, daemon, "Ask first while the rail is folded");
  const secondAsker = await dispatchIdleAgent(page, daemon, "Ask second while the rail is folded");
  await useUi(page, daemon, { layout: "console", sessionRailFolded: true });

  const strip = page.getByRole("button", { name: "Unfold All sessions: 3 idle" });
  await expect(strip).toBeVisible();
  await expect(strip.locator(".session-rail-strip-n.tone-attention")).toHaveCount(0);

  // The first arrival: a Needs you count appears where there was none, and pulses.
  await askForInput(daemon, firstAsker.cwd!);
  const one = page.getByRole("button", { name: "Unfold All sessions: 1 needs you, 2 idle" });
  await expect(one).toBeVisible();
  const pill = one.locator(".session-rail-strip-n.tone-attention");
  await expect(pill).toHaveText("1");
  await expect(pill).toHaveClass(/\bis-pulsing\b/);
  await capture(page, "03-console-folded-needs-you");
  const firstPill = await pill.elementHandle();

  // A second arrival onto a count already showing: the count rises and the pulse plays again.
  // A CSS animation plays once per element, so "again" means a fresh pill replaced the old one;
  // an implementation that only animated the first arrival would keep the same, spent element.
  await askForInput(daemon, secondAsker.cwd!);
  const two = page.getByRole("button", { name: "Unfold All sessions: 2 needs you, 1 idle" });
  await expect(two).toBeVisible();
  const risen = two.locator(".session-rail-strip-n.tone-attention");
  await expect(risen).toHaveText("2");
  await expect(risen).toHaveClass(/\bis-pulsing\b/);
  await expect.poll(() => firstPill!.evaluate((el) => el.isConnected)).toBe(false);
  await capture(page, "06-console-folded-needs-you-rises");
});

test("both Board drill-in rails fold to the strip and give the reader the width", async ({
  dashboard: page,
  daemon,
}) => {
  await dispatchIdleAgent(page, daemon, "Drill into a folded rail");
  await useUi(page, daemon, { layout: "board", sessionRailFolded: false });

  // The default drill-in: the clicked column becomes the rail.
  await page.locator(".board-col.tone-idle .tile-name").click();
  const columnRail = page.locator(".board-col.is-rail");
  const reader = page.locator(".board-detail");
  await expect(columnRail.locator(".rail-row")).toHaveCount(1);
  await expect.poll(() => widthOf(columnRail)).toBeGreaterThan(250);
  const openReader = await widthOf(reader);
  await capture(page, "04-board-rail-open");

  await columnRail.getByRole("button", { name: "Fold the session rail" }).click();
  const columnStrip = page.getByRole("button", { name: "Unfold idle: 1 idle" });
  await expect(columnStrip).toBeVisible();
  await expect.poll(() => widthOf(columnRail)).toBeLessThanOrEqual(41);
  await expect.poll(() => widthOf(reader)).toBeGreaterThan(openReader + 200);
  await capture(page, "05-board-rail-folded");

  // The overview keeps its own columns: folding the rail never folds a Board column.
  await page.keyboard.press("Escape");
  await expect(page.locator(".board-col.tone-idle .tile")).toHaveCount(1);
  await expect(page.locator(".board-col.tone-idle")).not.toHaveClass(/\bis-collapsed\b/);
  await expect.poll(() => railFolded(daemon)).toBe(true);
  // And `[` is not claimed there, because no rail is on screen to fold. The next drill-in is
  // what proves it: it opens folded only if this press left the preference alone.
  await page.keyboard.press("[");

  // "Show all sessions": the drill-in is the Console's own rail, folded by the same flag.
  await useUi(page, daemon, { boardSidebarAllSessions: true });
  await page.locator(".board-col.tone-idle .tile-name").click();
  const allStrip = page.getByRole("button", { name: "Unfold All sessions: 1 idle" });
  await expect(allStrip).toBeVisible();
  await expect.poll(() => widthOf(page.getByRole("navigation", { name: "Sessions", exact: true })))
    .toBeLessThanOrEqual(41);
  await allStrip.click();
  const rail = page.getByRole("navigation", { name: "Sessions", exact: true });
  await expect(rail.locator(".rail-row")).toHaveCount(1);
  // Unfolding here unfolds every rail: the column rail reads the same flag.
  await page.getByRole("button", { name: "Back to the board" }).click();
  await useUi(page, daemon, { boardSidebarAllSessions: false });
  await page.locator(".board-col.tone-idle .tile-name").click();
  await expect(page.locator(".board-col.is-rail .rail-row")).toHaveCount(1);
});
