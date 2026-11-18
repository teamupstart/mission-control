import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";

/**
 * What is at stake: an operator who cannot answer a request_input question yet chooses
 * "Remind me later", picks when and what the agent does meanwhile, and the agent's blocking
 * call returns at once with that instruction. The question leaves the queue, waits in the
 * inbox's Snoozed section and in the conversation, and comes back as a reminder - here through
 * Answer now, which takes the same wake path the daemon's clock does when the time comes.
 *
 * Real daemon, real routes, real SSE and the real built dashboard. The question is posted
 * through the same `/mcp/reviews` route the MCP `request_input` tool posts to, carrying the
 * same `snoozable` flag, and the agent's long poll is the tool's own `/wait`.
 */

const EVIDENCE = artifactsDir("request-input-remind-later");

async function capture(target: Locator | Page, name: string, page: Page): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await target.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/request-input-remind-later/${name}.png`);
}

const token = (daemon: DaemonHandle) => readFileSync(join(daemon.home, "token"), "utf8").trim();

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("add a linter to CI");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row")).toHaveCount(1);
}

/** Ask the way `request_input` does, with or without the flag that offers Remind me later. */
async function ask(daemon: DaemonHandle, body: Record<string, unknown>): Promise<string> {
  const sessions = await (await fetch(`${daemon.baseURL}/api/sessions`)).json() as Array<{ cwd: string }>;
  const res = await fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({ env: {}, cwd: sessions[0]!.cwd, kind: "input", ...body }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json() as { id: string }).id;
}

interface Waited {
  status: string;
  response: string | null;
  snooze?: { mode: string; optionId: string | null; until: number; at: number; remindedAt: number | null };
}

/** The agent's blocked `request_input` call: the tool's own long poll. */
async function agentWait(daemon: DaemonHandle, id: string): Promise<Waited> {
  const res = await fetch(`${daemon.baseURL}/mcp/reviews/${id}/wait`, {
    headers: { "x-harness-token": token(daemon) },
  });
  expect(res.status).toBe(200);
  return await res.json() as Waited;
}

/**
 * Open the attention inbox from one pulse segment. Retried as a whole: an SSE frame re-renders
 * the pulse and replaces the segment's node, so a click resolved against the old one can miss.
 */
async function openInbox(page: Page, segment: "to answer" | "snoozed"): Promise<Locator> {
  const inbox = page.getByRole("dialog", { name: "Attention inbox" });
  const button = page.locator("button.pulse-seg", { hasText: segment });
  await expect(async () => {
    if (!(await inbox.isVisible())) await button.click({ timeout: 3000 });
    await expect(inbox).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 45_000 });
  await expectContentClearsBorder(inbox);
  return inbox;
}

async function openReview(page: Page): Promise<Locator> {
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  await page.locator(".console-detail").getByRole("button", { name: "to review" }).click();
  const dialog = page.getByRole("dialog", { name: "Review request" });
  await expectContentClearsBorder(dialog);
  return dialog;
}

const QUESTION = "Which linter should this repo use?";
const linter = {
  title: QUESTION,
  body: `${QUESTION}\n\nThe repo has no linter. CI runs Prettier only.`,
  decisions: [{
    id: "q",
    question: QUESTION,
    options: [
      { id: "o0", label: "biome", detail: "lint + format in one fast binary" },
      { id: "o1", label: "eslint", detail: "type-aware rules", recommended: true },
    ],
  }],
};

test("Remind me later releases the agent, parks the question in the inbox and conversation, and it comes back as a reminder", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon);
  const id = await ask(daemon, { ...linter, snoozable: true });
  // The agent is blocked on its tool call from here on.
  const blocked = agentWait(daemon, id);
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();

  // Snoozed from the attention inbox, the queue an operator drains across sessions.
  const inbox = await openInbox(dashboard, "to answer");
  await inbox.getByRole("button", { name: "Remind me later…" }).click();
  const sheet = inbox.getByRole("group", { name: "Remind me later" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("radio", { name: "2 hours" }).check();
  await sheet.getByRole("radio", { name: 'Go with "eslint" for now' }).check();
  await capture(inbox, "inbox-sheet", dashboard);
  await sheet.getByRole("button", { name: /^Remind me (at|tomorrow)/ }).click();

  // The agent's call returns at once, with what the operator chose.
  const released = await blocked;
  expect(released.status).toBe("snoozed");
  expect(released.snooze).toMatchObject({ mode: "option", optionId: "o1", remindedAt: null });
  expect(released.snooze!.until - released.snooze!.at).toBe(2 * 60 * 60_000);

  // Off the queue, into its own section, counted apart from what needs an answer now.
  await expect(inbox.getByText("Nothing to answer")).toBeVisible();
  await expect(inbox.getByRole("heading", { name: "Snoozed" })).toBeVisible();
  const row = inbox.getByRole("region", { name: `Snoozed: ${QUESTION}` });
  await expect(row).toContainText('Meanwhile: go with "eslint" for now');
  await expect(row).toContainText(/back .* · in \dh/);
  await expect(dashboard.locator("button.pulse-seg", { hasText: "to answer" })).toHaveCount(0);
  await expect(dashboard.locator("button.pulse-seg", { hasText: "snoozed" }).locator(".pulse-n")).toHaveText("1");
  await capture(inbox, "inbox-snoozed", dashboard);
  await dashboard.keyboard.press("Escape");
  await expect(inbox).toBeHidden();

  // The conversation shows where the answer will go.
  const parked = dashboard.locator(".console-detail").getByRole("note", { name: `Snoozed: ${QUESTION}` });
  await expect(parked).toBeVisible();
  await expect(parked).toContainText('meanwhile: go with "eslint" for now');
  // Drawn in the "not now" blue, never the gold of a question still owed.
  const byline = parked.getByText("Snoozed", { exact: true });
  expect(await byline.evaluate((el) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--working)";
    el.parentElement!.appendChild(probe);
    const same = getComputedStyle(probe).color === getComputedStyle(el).color;
    probe.remove();
    return same;
  })).toBe(true);
  await capture(dashboard.locator(".console-detail"), "conversation-snoozed", dashboard);

  // The snoozed segment opens the same inbox, where Answer now brings it back as a reminder.
  const again = await openInbox(dashboard, "snoozed");
  await again.getByRole("region", { name: `Snoozed: ${QUESTION}` }).getByRole("button", { name: "Answer now" }).click();
  await expect(again.getByRole("region", { name: `Snoozed: ${QUESTION}` })).toHaveCount(0);
  await expect(again.getByText("Questions from agents")).toBeVisible();
  await expect(again.locator(".kind-reminder")).toHaveText("reminder");
  await expect(again.getByRole("note")).toContainText("You snoozed this at");
  await expect(again.getByRole("note")).toContainText('kept working with "eslint" as a provisional answer');
  await expect(dashboard.locator("button.pulse-seg", { hasText: "to answer" }).locator(".pulse-n")).toHaveText("1");
  await expect(dashboard.locator("button.pulse-seg", { hasText: "snoozed" })).toHaveCount(0);
  await capture(again, "inbox-reminder", dashboard);

  // The answer settles it; the agent hears it as a message, since its call already returned.
  await again.getByRole("radio", { name: /eslint/ }).check();
  await again.getByRole("button", { name: /^Submit/ }).click();
  await expect(again.getByText("Nothing to answer")).toBeVisible();
  expect(await agentWait(daemon, id)).toMatchObject({ status: "answered" });
});

test("an open-ended question can be held, and a card request_input did not raise offers no snooze", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon);
  const plain = await ask(daemon, { title: "Confirm the public issue text", body: "Confirm the public issue text" });
  const open = await ask(daemon, { title: "What should the release notes call this?", body: "What should the release notes call this?", snoozable: true });
  const blocked = agentWait(daemon, open);

  const dialog = await openReview(dashboard);
  const plainCard = dialog.locator("section.review", { hasText: "Confirm the public issue text" });
  const openCard = dialog.locator("section.review", { hasText: "What should the release notes call this?" });
  await expect(plainCard.getByRole("button", { name: "Remind me later…" })).toHaveCount(0);

  await openCard.getByPlaceholder("Your answer…").fill("half a thought");
  await openCard.getByRole("button", { name: "Remind me later…" }).click();
  const sheet = openCard.getByRole("group", { name: "Remind me later" });
  await capture(dialog, "modal-sheet", dashboard);
  // Back returns to the answer form with what was typed; reopening works as before.
  await sheet.getByRole("button", { name: "Back" }).click();
  await expect(openCard.getByPlaceholder("Your answer…")).toHaveValue("half a thought");
  await openCard.getByRole("button", { name: "Remind me later…" }).click();
  // No options to carry on with: best judgment or hold.
  await expect(sheet.getByRole("radio", { name: /^Go with/ })).toHaveCount(0);
  await sheet.getByRole("radio", { name: "15 minutes" }).check();
  await sheet.getByRole("radio", { name: "Hold work that depends on this" }).check();
  await sheet.getByRole("button", { name: /^Remind me (at|tomorrow)/ }).click();

  await expect(openCard).toHaveCount(0);
  await expect(plainCard).toBeVisible();
  const released = await blocked;
  expect(released.status).toBe("snoozed");
  expect(released.snooze).toMatchObject({ mode: "hold" });
  expect(released.snooze!.until - released.snooze!.at).toBe(15 * 60_000);
  expect((await (await fetch(`${daemon.baseURL}/api/reviews`)).json() as Array<{ id: string; status: string }>)
    .find((r) => r.id === plain)?.status).toBe("pending");
});
