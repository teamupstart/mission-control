import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import type { Session, Task } from "../../src/shared/types.ts";

/**
 * What is at stake: with the `markdown-questions` preview on, the context an agent sends with
 * `request_input` reads as the Markdown it was written in - a bulleted list is a list, on the
 * review card, in the attention inbox and in the conversation - and a checkout path inside it
 * still opens Files. With the preview off the body is the plain paragraph it always was.
 *
 * Real daemon, real routes, real SSE and the real built dashboard. The question is filed on the
 * channel the MCP `request_input` tool uses, the agent is the suite's fake, and the flag is
 * switched through its own route while the page stays open.
 */

const EVIDENCE = artifactsDir("markdown-questions");

async function capture(target: Locator, name: string, page: Page): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(0, 0);
  await expect(page.locator(".tooltip")).toHaveCount(0, { timeout: 3000 }).catch(() => undefined);
  await target.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  console.log(`CAPTURED e2e/.artifacts/markdown-questions/${name}.png`);
}

const token = (daemon: DaemonHandle) => readFileSync(join(daemon.home, "token"), "utf8").trim();

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

async function setFlag(daemon: DaemonHandle, id: string, enabled: boolean): Promise<void> {
  const { config } = await api<{ config: { overrides: Record<string, boolean> } }>(
    daemon, "/api/feature-flags", { kind: "flag", id, enabled }, "PUT");
  expect(config.overrides[id]).toBe(enabled);
}

const QUESTION = "Should the parser keep its old name?";
const OLD_NAME = "keep the old name; nothing downstream changes";
const RENAME = "rename it everywhere; README.md and the CLI help change too";
const CONTEXT = `Two ways to ship the rename:\n\n- ${OLD_NAME}\n- ${RENAME}\n\n## Found\n\nCI runs \`npm test\` only.`;

/** File the question the way the MCP `request_input` tool does: the question, then its context. */
async function ask(daemon: DaemonHandle, cwd: string, asyncCapable = false): Promise<{ wait: string }> {
  const res = await fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({
      env: {},
      cwd,
      ...(asyncCapable ? { asyncCapable: true, snoozable: true } : {}),
      kind: "input",
      title: QUESTION,
      body: `${QUESTION}\n\n${CONTEXT}`,
      decisions: [{
        id: "q",
        question: QUESTION,
        options: [{ id: "o0", label: "Keep it" }, { id: "o1", label: "Rename it" }],
      }],
    }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return await res.json() as { wait: string };
}

async function openReview(page: Page): Promise<Locator> {
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  await page.locator(".console-detail").getByRole("button", { name: "to review" }).click();
  const modal = page.getByRole("dialog", { name: "Review request" });
  await expect(modal).toBeVisible();
  await expectContentClearsBorder(modal);
  return modal;
}

async function openInbox(page: Page): Promise<Locator> {
  const inbox = page.getByRole("dialog", { name: "Attention inbox" });
  // By role: Settings > Display draws a preview of this same pulse, and only the title bar's is
  // a button by that name.
  const button = page.getByRole("button", { name: "to answer" });
  await expect(async () => {
    if (!(await inbox.isVisible())) await button.click({ timeout: 3000 });
    await expect(inbox).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 45_000 });
  await expectContentClearsBorder(inbox);
  return inbox;
}

async function closeOverlay(page: Page, overlay: Locator): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(overlay).toBeHidden();
}

/** Dispatch a task to the fake agent and wait until it has finished its turn. */
async function dispatch(daemon: DaemonHandle): Promise<Session> {
  const task = await api<Task>(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title: "Rename the parser", intent: "rename the parser", kind: "ship",
    agent: "claude", runtime: "sdk", workflowId: null,
  });
  let session!: Session;
  await expect.poll(async () => {
    session = (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.task?.id === task.id)!;
    return session?.agentSessionId ? session.state : null;
  }, { timeout: 60_000 }).toBe("idle");
  return session;
}

/** The question's body on a card: the context beneath its heading. */
const body = (scope: Locator) => scope.locator("section.review .review-content");

test("with the markdown-questions flag on, a bulleted context renders as list items on the review card and in the inbox, and its paths still open Files", async ({ dashboard: page, daemon }) => {
  test.setTimeout(120_000);
  const session = await dispatch(daemon);
  await ask(daemon, session.cwd!);
  await expect(page.locator("button.pulse-seg", { hasText: "to answer" }).locator(".pulse-n")).toHaveText("1");

  // Off: the plain paragraph, with the agent's dashes printed as typed.
  let modal = await openReview(page);
  await expect(body(modal).locator("p.question")).toContainText(`- ${OLD_NAME}`);
  await expect(body(modal).getByRole("listitem")).toHaveCount(0);
  await capture(modal, "01-modal-flag-off", page);
  await closeOverlay(page, modal);

  // On, with the page left open: the bullets are list items, the heading is a heading.
  await setFlag(daemon, "markdown-questions", true);
  modal = await openReview(page);
  const items = body(modal).getByRole("list").getByRole("listitem");
  await expect(items).toHaveText([OLD_NAME, RENAME]);
  await expect(body(modal).getByRole("heading", { name: "Found" })).toBeVisible();
  await expect(body(modal).locator("code", { hasText: "npm test" })).toBeVisible();
  await expect(body(modal)).not.toContainText(`- ${OLD_NAME}`);
  await capture(modal, "02-modal-flag-on", page);
  await closeOverlay(page, modal);

  const inbox = await openInbox(page);
  await expect(body(inbox).getByRole("list").getByRole("listitem")).toHaveText([OLD_NAME, RENAME]);
  await capture(inbox, "03-inbox-flag-on", page);
  await closeOverlay(page, inbox);

  // A checkout path inside a list item still opens the file in Files.
  modal = await openReview(page);
  await items.nth(1).getByRole("link", { name: "README.md" }).click();
  await expect(modal).toBeHidden();
  await expect(
    page.getByRole("tablist", { name: "Session detail" }).getByRole("tab", { name: /Files$/ }),
  ).toHaveAttribute("aria-selected", "true");
});

test("with the markdown-questions flag on, the conversation's entry for a filed question renders its bulleted context as list items", async ({ dashboard: page, daemon }) => {
  test.setTimeout(120_000);
  await setFlag(daemon, "async-input", true);
  await setFlag(daemon, "markdown-questions", true);
  const session = await dispatch(daemon);
  expect((await ask(daemon, session.cwd!, true)).wait, "the question waits as a message").toBe("message");
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row", { hasText: session.name }).first().click();
  const detail = page.locator(".console-detail");
  const asked = detail.getByRole("note", { name: `Asked: ${QUESTION}` });
  await expect(asked.getByRole("list").getByRole("listitem")).toHaveText([OLD_NAME, RENAME]);
  await expect(asked.getByRole("heading", { name: "Found" })).toBeVisible();
  await capture(asked, "04-conversation-flag-on", page);

  // Off again, live: the entry is the plain paragraph it was.
  await setFlag(daemon, "markdown-questions", false);
  await expect(asked.locator("p.review-asked-question")).toContainText(`- ${OLD_NAME}`);
  await expect(asked.getByRole("listitem")).toHaveCount(0);
});

/*
 * The inbox draws the same `ReviewCard` the session's own modal does, and it must link the
 * same paths. It used to draw it without the checkout listing or a way to open a file, so a
 * question opened from "to answer" printed its paths as plain text while the very same question
 * opened from the conversation's "to review" badge linked them. Opened straight from the title
 * bar on a fresh page, with no session selected first, so nothing else has warmed the listing.
 */
for (const markdown of [false, true]) {
  test(`with the markdown-questions flag ${markdown ? "on" : "off"}, a question opened from the inbox links its checkout paths exactly as the session's review modal does`, async ({ dashboard: page, daemon }) => {
    test.setTimeout(120_000);
    if (markdown) await setFlag(daemon, "markdown-questions", true);
    const session = await dispatch(daemon);
    await ask(daemon, session.cwd!);
    await page.reload();
    await expect(page.locator("button.pulse-seg", { hasText: "to answer" }).locator(".pulse-n")).toHaveText("1");

    const inbox = await openInbox(page);
    const link = body(inbox).getByRole("link", { name: "README.md" });
    await expect(link).toBeVisible();
    await capture(inbox, `05-inbox-path-link-flag-${markdown ? "on" : "off"}`, page);
    await link.click();
    await expect(inbox).toBeHidden();
    await expect(
      page.getByRole("tablist", { name: "Session detail" }).getByRole("tab", { name: /Files$/ }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      page.getByRole("listbox", { name: "Session files" }).getByRole("option", { name: "README.md" }),
    ).toHaveAttribute("aria-selected", "true");

    // The question is still owed, and the modal links the same path.
    const modal = await openReview(page);
    await expect(body(modal).getByRole("link", { name: "README.md" })).toBeVisible();
  });
}

/*
 * The inbox opens over any page, so a path clicked in it has to bring the session into view
 * first: from Settings it used to close the inbox and leave Settings on screen, and a Fleet
 * filter that excluded the session hid the detail the file opens in.
 */
test("a path clicked in the inbox over Settings, with a Fleet filter hiding the session, opens the file on Fleet", async ({ dashboard: page, daemon }) => {
  test.setTimeout(120_000);
  const session = await dispatch(daemon);
  await ask(daemon, session.cwd!);
  await page.reload();
  const filter = page.getByRole("textbox", { name: /Filter sessions/ });
  await page.locator(".filter-box").click();
  await filter.fill("no-session-matches-this");
  await page.evaluate(() => { window.location.hash = "#/settings"; });
  await expect(page).toHaveURL(/#\/settings/);

  const inbox = await openInbox(page);
  await body(inbox).getByRole("link", { name: "README.md" }).click();
  await expect(inbox).toBeHidden();
  await expect(page).toHaveURL(/#\/fleet/);
  await expect(filter).toHaveValue("");
  await expect(
    page.getByRole("tablist", { name: "Session detail" }).getByRole("tab", { name: /Files$/ }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("listbox", { name: "Session files" }).getByRole("option", { name: "README.md" }),
  ).toHaveAttribute("aria-selected", "true");
});
