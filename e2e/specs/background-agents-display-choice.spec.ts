import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";

/**
 * Settings > Display > Board card > Background sub-agents, end to end: one radio, Nested
 * sub-cards (the default) or Chip and popover, switching the board card and the conversation
 * together - live, in the same document, with no reload.
 *
 * A dispatched fake Claude launches three background agents through the real Agent SDK stream
 * (`E2E_BACKGROUND_AGENTS`, the same fixture the Phase 1 and 2 specs use) and ends its turn with
 * them running. Under the default the card hangs sub-cards and the conversation docks the tray;
 * under Chip and popover the card wears a chip that opens a popover of the agents, and the
 * conversation rail gains an Agents tab instead of the tray. Switching back restores both.
 *
 * "No reload" is checked rather than assumed: a marker set on `window` after the last load must
 * still be there at the end. No model is spent.
 */

const EVIDENCE = artifactsDir("background-agents-display-choice");

const AGENTS = { title: "Ledger with background agents", intent: "E2E_BACKGROUND_AGENTS launch three" };

interface LiveSession {
  id: string;
  state: string;
  cwd: string | null;
}

async function sessions(daemon: DaemonHandle): Promise<LiveSession[]> {
  const response = await fetch(`${daemon.baseURL}/api/sessions`);
  return (await response.json()) as LiveSession[];
}

async function dispatchIdle(page: Page, daemon: DaemonHandle, task: { title: string; intent: string }): Promise<void> {
  const before = new Set((await sessions(daemon)).map((s) => s.id));
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(task.intent);
  await dialog.getByRole("button", { name: /Backlog details/ }).click();
  await dialog.getByPlaceholder("summarized from the task if left blank").fill(task.title);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => {
    const fresh = (await sessions(daemon)).find((s) => !before.has(s.id) && s.state !== "exited");
    return fresh?.cwd ? fresh.state : "";
  }, { timeout: 60_000, message: `the dispatch for "${task.title}" settled idle` }).toBe("idle");
}

async function useBoardLayout(page: Page, daemon: DaemonHandle): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "board" }),
  });
  expect(response.ok, "the daemon accepted the Board layout").toBe(true);
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();
}

async function shoot(page: Page, target: Locator | Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: a resting pointer portals a tooltip over what is photographed.
  await page.mouse.move(0, 0);
  await target.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/background-agents-display-choice/${name}.png`);
}

/**
 * The popover's whole outer box - border and padding included - against the area a fixed
 * panel is actually visible in (the viewport less any scrollbar), with the 8px inset placement
 * keeps from every edge.
 */
async function expectPopoverOnScreen(page: Page, popover: Locator): Promise<void> {
  const fit = await popover.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const view = { w: document.documentElement.clientWidth, h: document.documentElement.clientHeight };
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, ...view };
  });
  expect(fit.left, "the popover's left edge is inside the inset").toBeGreaterThanOrEqual(8 - 0.5);
  expect(fit.top, "the popover's top edge is inside the inset").toBeGreaterThanOrEqual(8 - 0.5);
  expect(fit.right, "the popover's right edge is inside the inset").toBeLessThanOrEqual(fit.w - 8 + 0.5);
  expect(fit.bottom, "the popover's bottom edge is inside the inset").toBeLessThanOrEqual(fit.h - 8 + 0.5);
}

/** Navigate inside the open document, the way the app's own links do: a hash, never a load. */
async function go(page: Page, hash: string): Promise<void> {
  await page.evaluate((next) => {
    window.location.hash = next;
  }, hash);
}

/** Settings > Display, with the Background sub-agents picker in view. */
async function openPicker(page: Page): Promise<{ picker: Locator; preview: Locator }> {
  await go(page, "#/settings/display");
  const panel = page.locator('[data-anchor="display/board-card"]');
  const picker = panel.getByRole("radiogroup", { name: "Board card: Background sub-agents" });
  await picker.scrollIntoViewIfNeeded();
  await expect(picker).toBeVisible();
  return { picker, preview: panel.locator(".board-card-preview-stage").first() };
}

async function pick(page: Page, label: "Nested sub-cards" | "Chip and popover"): Promise<void> {
  const { picker } = await openPicker(page);
  await picker.getByText(label, { exact: true }).click();
  await expect(picker.getByRole("radio", { name: label, exact: true })).toBeChecked();
}

async function backToBoard(page: Page): Promise<Locator> {
  await go(page, "#/");
  await expect(page.locator("main.board")).toBeVisible();
  const tile = page.locator("main.board .tile").filter({ hasText: AGENTS.title });
  await expect(tile).toHaveCount(1);
  return tile;
}

/** Drill into the session from its card and wait for its conversation. */
async function openConversation(page: Page, tile: Locator): Promise<Locator> {
  await tile.locator(".tile-activity").click();
  const detail = page.locator(".cdetail");
  await expect(detail).toBeVisible();
  await expect(detail.getByPlaceholder(/^Reply to this session/)).toBeVisible();
  return detail;
}

async function closeConversation(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.locator(".cdetail")).toHaveCount(0);
}

test("one radio switches the board card and the conversation between sub-cards and tray, and chip and Agents tab, without a reload", async ({
  dashboard,
  daemon,
}) => {
  await dispatchIdle(dashboard, daemon, AGENTS);
  await useBoardLayout(dashboard, daemon);
  await dashboard.evaluate(() => {
    (window as unknown as { __noReload?: boolean }).__noReload = true;
  });

  // ---- the picker: exactly two values, Nested sub-cards selected ----
  const { picker, preview } = await openPicker(dashboard);
  await expect(picker.getByRole("radio")).toHaveCount(2);
  await expect(picker.getByRole("radio", { name: "Nested sub-cards", exact: true })).toBeChecked();
  await expect(picker.getByRole("radio", { name: "Chip and popover", exact: true })).not.toBeChecked();
  // The preview card has sample agents, so the default hangs sub-cards beneath it.
  await expect(preview.getByRole("group", { name: /^Background sub-agents of / })).toBeVisible();
  await expect(preview.locator(".tf-agents")).toHaveCount(0);
  await shoot(dashboard, picker.locator(".."), "01-picker-nested-default");

  // ---- the default on the board and in the conversation ----
  let tile = await backToBoard(dashboard);
  const tree = dashboard.getByRole("group", { name: /^Background sub-agents of / });
  await expect(tree).toHaveCount(1);
  await expect(tile.getByRole("button", { name: /\d agents$/ })).toHaveCount(0);
  let detail = await openConversation(dashboard, tile);
  await expect(detail.getByRole("region", { name: "Background agents" })).toBeVisible();
  const rail = detail.getByRole("tablist", { name: "Rail view" });
  await expect(rail.getByRole("tab")).toHaveCount(2);
  await closeConversation(dashboard);

  // ---- Chip and popover ----
  await pick(dashboard, "Chip and popover");
  // The preview redraws at once: a chip in the card's flags, no sub-cards.
  await expect(preview.locator(".tile-flag.tf-agents")).toBeVisible();
  await expect(preview.getByRole("group", { name: /^Background sub-agents of / })).toHaveCount(0);
  await shoot(dashboard, preview, "02-preview-chip");

  tile = await backToBoard(dashboard);
  // No sub-cards on the board, and the card's flag row carries the chip with a pip per agent.
  await expect(tree).toHaveCount(0);
  const chip = tile.getByRole("button", { name: "3 agents" });
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute("aria-expanded", "false");
  await expect(chip.locator(".tf-agents-pip")).toHaveCount(3);
  // The chip sits in the flags, so the card keeps its height: no sibling hangs beneath it.
  expect(
    await tile.evaluate((el) => el.nextElementSibling?.classList.contains("subagent-tree") ?? false),
    "nothing hangs beneath the card under Chip and popover",
  ).toBe(false);

  // Clicking the chip opens the agent list, and does not open the session behind it.
  await chip.click();
  const popover = dashboard.getByRole("dialog", { name: "Background agents" });
  await expect(popover).toBeVisible();
  await expect(chip).toHaveAttribute("aria-expanded", "true");
  await expect(dashboard.locator(".cdetail")).toHaveCount(0);
  await expect(popover).toContainText("Background agents · ");
  // A chip in the upper half of the window opens its list below itself.
  {
    const chipBox = (await chip.boundingBox())!;
    const box = (await popover.boundingBox())!;
    expect(chipBox.y, "the chip starts in the upper half").toBeLessThanOrEqual(dashboard.viewportSize()!.height / 2);
    expect(box.y, "the popover opens below the chip").toBeGreaterThanOrEqual(chipBox.y + chipBox.height);
  }
  await expectPopoverOnScreen(dashboard, popover);
  const rows = popover.getByRole("listitem");
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: "Map every offset-pagination call site" })).toContainText("18 tools · Grep");
  await expect(rows.filter({ hasText: "Convert billing report queries" })).toContainText("general-purpose");
  await expect(rows.filter({ hasText: "Find contract tests for /ledger" })).toContainText("done");
  // Foreground, ambient and non-agent work was on the wire and is not listed.
  for (const absent of ["Foreground planning", "Housekeeping", "npm run watch"]) {
    await expect(popover).not.toContainText(absent);
  }
  // A portalled panel of its own, so its text is measured clear of its border like a modal's.
  await expectContentClearsBorder(popover);
  await shoot(dashboard, dashboard, "03-chip-popover-open");

  // A click inside the list is not a click on the card.
  await rows.first().click();
  await expect(dashboard.locator(".cdetail")).toHaveCount(0);
  await expect(popover).toBeVisible();
  // Escape closes it, hands focus back to the chip, and leaves the board where it was.
  await dashboard.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(chip).toBeFocused();
  await expect(chip).toHaveAttribute("aria-expanded", "false");
  // And a press outside closes it too.
  await chip.click();
  await expect(popover).toBeVisible();
  await dashboard.locator("main.board").click({ position: { x: 4, y: 4 } });
  await expect(popover).toHaveCount(0);

  // A chip in the lower half opens its list ABOVE itself, so a card low on the board never
  // pushes the list off the bottom of the window. The window is shortened until the same chip
  // sits below the middle, rather than relying on where a second card happens to land.
  const tall = dashboard.viewportSize()!;
  const chipTop = (await chip.boundingBox())!.y;
  await dashboard.setViewportSize({ width: tall.width, height: Math.floor(chipTop * 2 - 40) });
  await expect(chip).toBeInViewport();
  const low = (await chip.boundingBox())!;
  const short = dashboard.viewportSize()!.height;
  expect(low.y, "the chip now sits in the lower half of the window").toBeGreaterThan(short / 2);
  await chip.click();
  await expect(popover).toBeVisible();
  const above = (await popover.boundingBox())!;
  expect(above.y + above.height, "the popover ends above the chip").toBeLessThanOrEqual(low.y + 0.5);
  expect(above.y, "the popover's top is on screen").toBeGreaterThanOrEqual(0);
  expect(above.x, "the popover's left edge is on screen").toBeGreaterThanOrEqual(0);
  expect(above.x + above.width, "the popover's right edge is on screen").toBeLessThanOrEqual(tall.width);
  // Every row is reachable, not clipped by the window.
  for (const row of await popover.getByRole("listitem").all()) await expect(row).toBeInViewport({ ratio: 1 });
  await expectPopoverOnScreen(dashboard, popover);
  await shoot(dashboard, dashboard, "03b-chip-popover-above");
  await dashboard.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await dashboard.setViewportSize(tall);

  // A window narrower than the chip's left edge plus the panel's width: placement pulls the
  // panel left so its right edge - border and padding included - stays on screen.
  await dashboard.setViewportSize({ width: 340, height: tall.height });
  await expect(chip).toBeInViewport();
  const chipLeft = (await chip.boundingBox())!.x;
  expect(chipLeft + 320, "the panel would overrun the right edge where the chip starts").toBeGreaterThan(340 - 8);
  await chip.click();
  await expect(popover).toBeVisible();
  await expectPopoverOnScreen(dashboard, popover);
  await shoot(dashboard, dashboard, "03c-chip-popover-narrow");
  await dashboard.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await dashboard.setViewportSize(tall);

  // The conversation: no tray, and an Agents tab on the rail that lists the agents.
  detail = await openConversation(dashboard, tile);
  await expect(detail.getByRole("region", { name: "Background agents" })).toHaveCount(0);
  await expect(rail.getByRole("tab")).toHaveCount(3);
  const agentsTab = rail.getByRole("tab", { name: /^Agents/ });
  await expect(agentsTab).toHaveText(/^Agents\s*3$/);
  await agentsTab.click();
  await expect(agentsTab).toHaveAttribute("aria-selected", "true");
  const panel = detail.getByRole("tabpanel");
  const agentRows = panel.getByRole("listitem");
  await expect(agentRows).toHaveCount(3);
  const mapRow = agentRows.filter({ hasText: "Map every offset-pagination call site" });
  await expect(mapRow).toContainText("Explore");
  await expect(mapRow).toContainText("Grep · 41k tokens");
  await expect(agentRows.filter({ hasText: "Find contract tests for /ledger" })).toContainText("done");
  await shoot(dashboard, detail, "04-conversation-agents-tab");
  await closeConversation(dashboard);

  // ---- and back to Nested sub-cards, which restores both halves ----
  await pick(dashboard, "Nested sub-cards");
  await expect(preview.getByRole("group", { name: /^Background sub-agents of / })).toBeVisible();
  await expect(preview.locator(".tf-agents")).toHaveCount(0);
  tile = await backToBoard(dashboard);
  await expect(tree).toHaveCount(1);
  await expect(tile.getByRole("button", { name: "3 agents" })).toHaveCount(0);
  detail = await openConversation(dashboard, tile);
  await expect(detail.getByRole("region", { name: "Background agents" })).toBeVisible();
  // The rail was last left on Agents; with no Agents tab to offer it reads Activity.
  await expect(rail.getByRole("tab")).toHaveCount(2);
  await expect(rail.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true");
  await shoot(dashboard, detail, "05-back-to-tray");

  // Stored in the daemon, and every switch happened in this one document.
  const view = (await (await fetch(`${daemon.baseURL}/api/ui/config`)).json()) as { config: { backgroundAgentsStyle: string } };
  expect(view.config.backgroundAgentsStyle).toBe("nested");
  expect(await dashboard.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
});

/** A JSON request to the daemon that must succeed. */
async function request<T>(daemon: DaemonHandle, path: string, body?: unknown, method = "POST"): Promise<T> {
  const response = await fetch(daemon.baseURL + path, method === "GET" ? {} : {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

test("a resident visitor card carries the chip under Chip and popover, and its sub-cards under Nested", async ({
  dashboard,
  daemon,
}) => {
  // A resident launched through the real routes, as residents-needs-you-rail.spec.ts does,
  // with a long cadence so it waits between steps instead of iterating under the test.
  const personas = await request<Array<{ id: string; name: string }>>(daemon, "/api/personas", undefined, "GET");
  const profile = await request<{ id: string }>(daemon, "/api/residents/profiles", { settings: {
    identity: { name: "Ledger Keeper" },
    persona: { personaId: personas.find((p) => p.name === "Code Risk Reviewer")!.id },
    workspace: { defaultRepoRoot: daemon.repo },
    execution: { model: "claude-fable-5" },
    loop: { delaySeconds: 3600, minDelaySeconds: 60, maxDelaySeconds: 3600 },
  } });
  await request(daemon, `/api/residents/profiles/${profile.id}/launch`, { repoRoot: daemon.repo, requestId: "launch-ledger-keeper" });
  let sessionId = "";
  await expect.poll(async () => {
    const run = withDaemonDb(daemon, (db) => db.prepare(
      "SELECT task_id FROM resident_runs WHERE profile_id = ? AND ended_at IS NULL AND launch_state = 'launched' AND loop_state = 'waiting'",
    ).get(profile.id) as { task_id: string } | undefined);
    if (!run) return "";
    const live = await request<Array<{ id: string; task?: { id?: string } }>>(daemon, "/api/sessions", undefined, "GET");
    sessionId = live.find((s) => s.task?.id === run.task_id)?.id ?? "";
    return sessionId;
  }, { timeout: 60_000, message: "the resident launched and is waiting" }).not.toBe("");

  // Its next turn launches the three background agents, and it then asks a question, so it
  // needs you: with the drawer closed it stands in Needs you as a visitor card.
  await request(daemon, `/api/sessions/${sessionId}/send`, { text: "E2E_BACKGROUND_AGENTS launch three for the resident", submit: true });
  await expect.poll(async () => {
    const live = await request<Array<{ id: string; state: string; subagents?: { agents: unknown[] } }>>(daemon, "/api/sessions", undefined, "GET");
    const session = live.find((s) => s.id === sessionId);
    return session && session.state !== "working" ? session.subagents?.agents.length ?? 0 : 0;
  }, { timeout: 60_000, message: "the resident's turn ended with its background agents listed" }).toBe(3);
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const asked = await fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST", headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({
      env: {}, sessionId, kind: "input", title: "Ledger Keeper: ship it?", body: "Ledger Keeper: ship it?",
      decisions: [{ id: "q", question: "Ledger Keeper: ship it?", options: [
        { id: "yes", label: "Ship it" }, { id: "no", label: "Hold it" },
      ], allowOther: false }],
    }),
  });
  expect(asked.status, await asked.clone().text()).toBe(200);

  const useBoard = async (style: "chip" | "nested"): Promise<Locator> => {
    await request(daemon, "/api/ui/config", {
      layout: "board", residentPlacement: "drawer", residentDrawerPinned: false, backgroundAgentsStyle: style,
    }, "PUT");
    await dashboard.goto(`${daemon.baseURL}/#/fleet`);
    await dashboard.reload();
    await expect(dashboard.locator("main.board")).toBeVisible();
    const visitor = dashboard.locator(".resident-visitor-tile").filter({ hasText: "Ledger Keeper" });
    await expect(visitor).toHaveCount(1, { timeout: 30_000 });
    return visitor;
  };

  // Chip and popover: the visitor card wears the chip, which opens the list, not the resident.
  let visitor = await useBoard("chip");
  const chip = visitor.getByRole("button", { name: "3 agents" });
  await expect(chip).toBeVisible();
  await expect(dashboard.getByRole("group", { name: /^Background sub-agents of / })).toHaveCount(0);
  await chip.click();
  const popover = dashboard.getByRole("dialog", { name: "Background agents" });
  await expect(popover).toBeVisible();
  await expect(popover.getByRole("listitem")).toHaveCount(3);
  await expect(dashboard.locator(".cdetail")).toHaveCount(0);
  await shoot(dashboard, dashboard, "06-resident-visitor-chip");
  await dashboard.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);

  // Nested sub-cards: no chip, and the sub-cards hang beneath the visitor card.
  visitor = await useBoard("nested");
  await expect(visitor.getByRole("button", { name: "3 agents" })).toHaveCount(0);
  const tree = dashboard.getByRole("group", { name: /^Background sub-agents of / });
  await expect(tree).toHaveCount(1);
  expect(
    await visitor.evaluate((el) => el.nextElementSibling?.classList.contains("subagent-tree") ?? false),
    "the sub-cards hang directly beneath the visitor card",
  ).toBe(true);
});

test("searching for the Agents tab lands on the Board card entry that holds the picker", async ({ dashboard, daemon }) => {
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.keyboard.press("Meta+k");
  const palette = dashboard.getByRole("dialog", { name: "Search everything" });
  await expect(palette).toBeVisible();
  await palette.getByRole("combobox", { name: "Search everything" }).fill("agents tab");
  // One settings result, labelled for the section the picker is in - not Conversation header,
  // which jumps to the same panel but reads as a different control.
  const boardCard = palette.getByRole("option", { name: /^Board card\b/ });
  await expect(boardCard).toHaveCount(1);
  await expect(palette.getByRole("option", { name: /^Conversation header\b/ })).toHaveCount(0);
  await shoot(dashboard, palette, "07-search-agents-tab");
  await boardCard.click();
  // The jump brings the panel that holds the picker on screen.
  const panel = dashboard.locator('[data-anchor="display/board-card"]');
  await expect(panel).toBeInViewport();
  await expect(panel.getByRole("radiogroup", { name: "Board card: Background sub-agents" })).toBeVisible();
});
