import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

// The resident profile editor as a card grid: every section a card, two columns once the
// workspace is wide enough and one when it is not, a live preview of the board card the next
// launch draws, and the loop's six limits as tiles. No model tokens: nothing here launches.

const EVIDENCE = artifactsDir("residents-editor-cards");

async function capture(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
}

async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error("the card is not laid out");
  return rect;
}

function card(editor: Locator, title: string): Locator {
  return editor.getByRole("region", { name: title, exact: true });
}

/** The workspace's content width: the inline size its container query reads. */
async function workspaceWidth(page: Page): Promise<number> {
  return page.locator(".residents-workspace").evaluate((element) => {
    const style = getComputedStyle(element);
    return element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  });
}

/** Resize the viewport until the workspace is exactly `target` pixels wide. */
async function sizeWorkspace(page: Page, target: number): Promise<void> {
  const { height } = page.viewportSize()!;
  let { width } = page.viewportSize()!;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await workspaceWidth(page);
    if (current === target) return;
    width += target - current;
    await page.setViewportSize({ width, height });
  }
  expect(await workspaceWidth(page)).toBe(target);
}

/** How many columns the cards form: two when Board presence sits beside Identity. */
async function columns(editor: Locator): Promise<number> {
  const identity = await box(card(editor, "Identity"));
  const board = await box(card(editor, "Board presence"));
  if (board.x > identity.x + identity.width && Math.abs(board.y - identity.y) < 2) return 2;
  if (Math.abs(board.x - identity.x) < 2 && board.y > identity.y) return 1;
  return 0;
}

test("the resident editor lays its sections out as a card grid with a live board card preview", async ({
  dashboard: page,
  daemon,
}) => {
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto(`${daemon.baseURL}/#/residents`);
  await page.getByRole("complementary", { name: "Resident profiles" }).getByRole("button", { name: "New" }).click();
  const editor = page.getByRole("region", { name: "New resident profile" });

  // Every section is still its own labelled card, in the grid's reading order.
  const titles = [
    "Identity", "Persona", "Board presence", "Instructions", "Harness, model and effort",
    "Workspace", "Loop and guardrails", "MCP servers", "Authority",
  ];
  for (const title of titles) await expect(card(editor, title)).toBeVisible();
  await expect(editor.locator(".resident-cards > section h4")).toHaveText(titles);

  // Wide: identity and persona stack on the left, beside the board card on the right.
  await expect(async () => {
    const identity = await box(card(editor, "Identity"));
    const persona = await box(card(editor, "Persona"));
    const board = await box(card(editor, "Board presence"));
    const instructions = await box(card(editor, "Instructions"));
    const execution = await box(card(editor, "Harness, model and effort"));
    const loop = await box(card(editor, "Loop and guardrails"));
    const mcp = await box(card(editor, "MCP servers"));
    const authority = await box(card(editor, "Authority"));
    expect(board.x).toBeGreaterThan(identity.x + identity.width);
    expect(Math.abs(board.y - identity.y)).toBeLessThan(2);
    expect(persona.y).toBeGreaterThan(identity.y + identity.height - 1);
    expect(board.height).toBeGreaterThan(identity.height);
    expect(execution.x).toBeGreaterThan(instructions.x + instructions.width);
    expect(Math.abs(execution.y - instructions.y)).toBeLessThan(2);
    // The loop card spans both columns, under both.
    expect(Math.abs(loop.x - identity.x)).toBeLessThan(2);
    expect(Math.abs(loop.x + loop.width - (board.x + board.width))).toBeLessThan(2);
    expect(loop.y).toBeGreaterThan(Math.max(instructions.y + instructions.height, execution.y));
    expect(authority.x).toBeGreaterThan(mcp.x + mcp.width);
    expect(mcp.y).toBeGreaterThan(loop.y + loop.height - 1);
  }).toPass();

  // The board card preview follows the draft: name, harness, label, color and pin.
  const preview = editor.getByRole("group", { name: "Board card preview" });
  await expect(preview).toContainText("New resident");
  await expect(preview).toContainText("Claude Code · harness default");
  // A runtime edit reaches the preview: a chosen model, then a harness change, which clears it.
  const model = editor.getByRole("combobox", { name: "Model", exact: true });
  await model.selectOption({ index: 1 });
  const chosen = await model.inputValue();
  expect(chosen).not.toBe("");
  await expect(preview).toContainText(`Claude Code · ${chosen}`);
  const harness = editor.getByRole("combobox", { name: "Harness" });
  await harness.selectOption("codex");
  await expect(preview).toContainText("Codex · harness default");
  await expect(preview).not.toContainText(chosen);
  await harness.selectOption("claude");
  await expect(preview).toContainText("Claude Code · harness default");
  await editor.getByLabel("Name").fill("Fleet Watch");
  await expect(preview).toContainText("Fleet Watch");
  await expect(preview.locator(".resident-chip")).toHaveText(/^⤒?FW$/);
  await editor.getByLabel("Marker label").fill("FLT");
  await expect(preview.locator(".resident-chip")).toHaveText(/^⤒?FLT$/);
  await editor.getByRole("radio", { name: "Rose" }).click();
  const glow = preview.locator(".resident-board-preview-card");
  await expect(glow).toHaveAttribute("style", /--resident-rose/);

  // Pinned, the card sorts above its neighbours; unpinned, one sits above it.
  const pin = editor.getByRole("checkbox", { name: "Pin to top of column" });
  const firstNeighbour = preview.locator(".resident-board-preview-ghost").first();
  if (await pin.isChecked()) await pin.uncheck();
  await expect(preview.getByLabel("pinned")).toHaveCount(0);
  await expect(async () => expect((await box(glow)).y).toBeGreaterThan((await box(firstNeighbour)).y)).toPass();
  await pin.check();
  await expect(preview.getByLabel("pinned")).toHaveCount(1);
  await expect(async () => expect((await box(glow)).y).toBeLessThan((await box(firstNeighbour)).y)).toPass();

  // The six limits are tiles, three to a row, and each is still reachable by its label.
  const loopCard = card(editor, "Loop and guardrails");
  const limits = [
    "Wake cadence (seconds)", "Minimum requested delay (seconds)", "Maximum requested delay (seconds)",
    "Iterations per 24 hours", "Spend per 24 hours (USD)", "Compact at context (%)",
  ];
  for (const label of limits) await expect(loopCard.getByLabel(label, { exact: true })).toBeVisible();
  const first = await box(loopCard.getByLabel(limits[0], { exact: true }));
  const third = await box(loopCard.getByLabel(limits[2], { exact: true }));
  const fourth = await box(loopCard.getByLabel(limits[3], { exact: true }));
  expect(Math.abs(first.y - third.y)).toBeLessThan(2);
  expect(fourth.y).toBeGreaterThan(first.y + first.height);
  const prompt = await box(loopCard.getByLabel("Loop prompt"));
  expect(first.x).toBeGreaterThan(prompt.x + prompt.width);

  // Granting authority marks its row in the attention color.
  const control = editor.getByRole("checkbox", { name: "Control other sessions" });
  const row = card(editor, "Authority").locator(".resident-authority");
  const before = await row.evaluate((element) => getComputedStyle(element).borderTopColor);
  await control.check();
  await expect.poll(() => row.evaluate((element) => getComputedStyle(element).borderTopColor)).not.toBe(before);

  await editor.getByLabel("Profile instructions").fill("Watch the fleet and summarize blockers.");
  await editor.getByRole("button", { name: "Save" }).click();
  const saved = page.getByRole("region", { name: "Resident profile Fleet Watch" });
  await expect(saved).toContainText("Revision 1");
  // A saved profile adds its durable state as the last card, beside MCP servers.
  await expect(async () => {
    const state = await box(saved.getByRole("region", { name: "Durable resident state" }));
    const savedMcp = await box(card(saved, "MCP servers"));
    const savedAuthority = await box(card(saved, "Authority"));
    expect(state.x).toBeGreaterThan(savedMcp.x + savedMcp.width);
    expect(state.y).toBeGreaterThan(savedAuthority.y + savedAuthority.height - 1);
  }).toPass();
  await capture(page, "01-wide-card-grid");
  await card(saved, "MCP servers").scrollIntoViewIfNeeded();
  await capture(page, "02-wide-loop-mcp-authority-state");

  // The grid turns on at exactly 860px of workspace: two columns there, one a pixel below.
  await sizeWorkspace(page, 860);
  await expect(async () => expect(await columns(saved)).toBe(2)).toPass();
  await sizeWorkspace(page, 859);
  await expect(async () => expect(await columns(saved)).toBe(1)).toPass();
  // Narrow, the cards stack in the same order at the same width.
  await expect(async () => {
    const narrowIdentity = await box(card(saved, "Identity"));
    const narrowPersona = await box(card(saved, "Persona"));
    const narrowBoard = await box(card(saved, "Board presence"));
    expect(Math.abs(narrowBoard.width - narrowIdentity.width)).toBeLessThan(2);
    expect(narrowBoard.y).toBeGreaterThan(narrowPersona.y + narrowPersona.height - 1);
  }).toPass();
  await card(saved, "Identity").scrollIntoViewIfNeeded();
  await capture(page, "03-narrow-one-column");
});
