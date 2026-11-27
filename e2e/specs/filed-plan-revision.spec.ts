import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import type { ReviewItem, Session, Task } from "../../src/shared/types.ts";

/**
 * What is at stake: with `filed-plan-decisions` and `async-input` both on, an agent whose scope
 * changed files its revised plan with `revises` naming the form it replaces. The operator sees
 * one card, tagged "Revision 2", never two cards for one plan; "Earlier version" shows the form
 * it replaced as a read-only record with no Submit; and the conversation keeps that earlier form
 * as withdrawn, with the reason the daemon gave.
 *
 * Real daemon, real routes, real SSE and the real built dashboard. Both forms are posted on the
 * exact channel the MCP tool uses, with the `asyncCapable` marker and the `revises` field it
 * sends, and the agent is the suite's fake, so no model tokens are spent.
 */

const EVIDENCE = artifactsDir("filed-plan-revision");

async function capture(target: Locator | Page, name: string, page: Page): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(0, 0);
  await expect(page.locator(".tooltip")).toHaveCount(0, { timeout: 3000 }).catch(() => undefined);
  await target.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  console.log(`CAPTURED e2e/.artifacts/filed-plan-revision/${name}.png`);
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

const FIRST_TITLE = "Linter rollout plan";
const REVISED_TITLE = "Linter and formatter rollout plan";

function plan(title: string, body: string, question: string): Record<string, unknown> {
  return {
    kind: "plan-decisions",
    title,
    body,
    decisions: [{
      id: "tool", question, options: [
        { id: "biome", label: "biome", detail: "lint + format in one fast binary" },
        { id: "eslint", label: "eslint", detail: "type-aware rules", recommended: true },
      ],
    }],
  };
}

type Filed = { id: string; wait: "call" | "message"; receipt?: string };

/** File a plan the way the MCP `request_plan_decisions` tool does. */
async function filePlan(daemon: DaemonHandle, cwd: string, body: Record<string, unknown>): Promise<Response> {
  return await fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({ env: {}, cwd, asyncCapable: true, ...body }),
  });
}

async function filed(response: Response): Promise<Filed> {
  expect(response.status, await response.clone().text()).toBe(200);
  return await response.json() as Filed;
}

async function sessionFor(daemon: DaemonHandle, taskId: string): Promise<Session | undefined> {
  return (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.task?.id === taskId);
}

async function openInbox(page: Page): Promise<Locator> {
  const inbox = page.getByRole("dialog", { name: "Attention inbox" });
  const button = page.locator("button.pulse-seg", { hasText: "to answer" });
  await expect(async () => {
    if (!(await inbox.isVisible())) await button.click({ timeout: 3000 });
    await expect(inbox).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 45_000 });
  return inbox;
}

/**
 * Both flags on, a dispatched SDK session, a filed plan, then its revision naming the open form,
 * filed the way the MCP tool files them. The revision is filed without withdrawing the first form.
 */
async function fileRevision(daemon: DaemonHandle): Promise<{ session: Session; first: Filed; revised: Filed }> {
  await setFlag(daemon, "async-input", true);
  await setFlag(daemon, "filed-plan-decisions", true);
  const task = await api<Task>(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title: "Roll out a linter", intent: "roll out a linter",
    kind: "ship", agent: "claude", runtime: "sdk", workflowId: null,
  });
  let session!: Session;
  await expect.poll(async () => {
    session = (await sessionFor(daemon, task.id))!;
    return Boolean(session?.agentSessionId);
  }, { timeout: 60_000 }).toBe(true);

  const first = await filed(await filePlan(daemon, session.cwd!, plan(FIRST_TITLE,
    "# Linter rollout\n\nAdd one linter to CI.", "Which linter?")));
  expect(first.wait).toBe("message");
  expect(first.receipt).toContain(`request_plan_decisions with revises set to ${first.id}`);

  // Scope changed: the agent files the revised plan naming the open form, without withdrawing it first.
  const revised = await filed(await filePlan(daemon, session.cwd!, {
    ...plan(REVISED_TITLE, "# Linter and formatter rollout\n\nAdd a linter and a formatter to CI.", "Which tool?"),
    revises: first.id,
  }));
  expect(revised.wait).toBe("message");
  return { session, first, revised };
}

test("a revised plan replaces its card, is tagged Revision 2, and shows the earlier version read-only", async ({ dashboard: page, daemon }) => {
  test.setTimeout(150_000);
  const { session, first, revised } = await fileRevision(daemon);
  const reviews = await api<ReviewItem[]>(daemon, "/api/reviews");
  expect(reviews.find((r) => r.id === revised.id)?.revision).toEqual({ number: 2, previousId: first.id });
  expect(reviews.find((r) => r.id === first.id)?.status).toBe("withdrawn");

  // A revises the daemon refuses files nothing and says why: the first form already has its revision.
  const refused = await filePlan(daemon, session.cwd!, { ...plan("Third plan", "# Third", "Which?"), revises: first.id });
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as { error: string }).error).toContain(`was already revised by ${revised.id}`);

  // One card in the inbox, tagged as the revision.
  await expect(page.locator("button.pulse-seg", { hasText: "to answer" }).locator(".pulse-n")).toHaveText("1");
  const inbox = await openInbox(page);
  const cards = inbox.locator("section.review");
  await expect(cards).toHaveCount(1);
  const card = cards.first();
  await expect(card.getByRole("heading", { name: REVISED_TITLE })).toBeVisible();
  await expect(card.locator(".kind-revision")).toHaveText(/Revision 2/i);
  await expect(inbox).not.toContainText(FIRST_TITLE);
  await expectContentClearsBorder(inbox);
  await capture(inbox, "01-inbox-one-card-revision-2", page);

  // The earlier version, read-only, in its own layer above the inbox.
  await card.getByRole("button", { name: "Earlier version" }).click();
  const earlier = page.getByRole("dialog", { name: "Earlier version" });
  await expect(earlier).toBeVisible();
  await expect(earlier.getByRole("heading", { name: FIRST_TITLE })).toBeVisible();
  await expect(earlier).toContainText("Withdrawn by the agent");
  await expect(earlier).toContainText("Revised: replaced by revision 2 of this plan.");
  await expect(earlier).toContainText("Add one linter to CI.");
  await expect(earlier).toContainText("Which linter?");
  await expect(earlier).toContainText(/Filed /);
  await expect(earlier.getByRole("button", { name: /Submit/ })).toHaveCount(0);
  await expect(earlier.getByRole("button", { name: "Dismiss", exact: true })).toHaveCount(0);
  await expect(earlier.getByRole("radio")).toHaveCount(0);
  await expectContentClearsBorder(earlier);
  await capture(earlier, "02-earlier-version", page);
  // One Escape closes one layer: the earlier version, not the inbox beneath it.
  await page.keyboard.press("Escape");
  await expect(earlier).toBeHidden();
  await expect(inbox).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(inbox).toBeHidden();

  // The conversation keeps the first form as withdrawn and shows the revision where it was filed.
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row", { hasText: session.name }).first().click();
  const detail = page.locator(".console-detail");
  const withdrawn = detail.getByRole("note", { name: `Plan filed: ${FIRST_TITLE}` });
  await expect(withdrawn).toContainText("Withdrawn by the agent");
  await expect(withdrawn).toContainText("Revised: replaced by revision 2 of this plan.");
  await expect(withdrawn.getByRole("button", { name: "Open" })).toHaveCount(0);
  const entry = detail.getByRole("note", { name: `Plan filed: ${REVISED_TITLE}` });
  await expect(entry.locator(".kind-revision")).toHaveText(/Revision 2/i);
  await expect(entry).toContainText("Open, not answered yet");
  await capture(detail, "03-conversation", page);

  // Opened from the conversation, the review modal's card carries the same tag.
  await entry.getByRole("button", { name: "Open" }).click();
  const modal = page.getByRole("dialog", { name: "Review request" });
  await expect(modal).toBeVisible();
  await expect(modal.locator(".kind-revision")).toHaveText(/Revision 2/i);
  await expect(modal.getByRole("button", { name: "Earlier version" })).toBeVisible();
});

test("when the earlier version cannot be read, its view says so and offers nothing to answer", async ({ dashboard: page, daemon }) => {
  test.setTimeout(150_000);
  const { first } = await fileRevision(daemon);
  // The daemon's read of the replaced form fails; every other request reaches it as usual.
  let failedReads = 0;
  await page.route(`**/api/reviews/${first.id}`, async (route) => {
    failedReads += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "read failed" }) });
  });

  const inbox = await openInbox(page);
  const card = inbox.locator("section.review").first();
  await expect(card.locator(".kind-revision")).toHaveText(/Revision 2/i);
  await card.getByRole("button", { name: "Earlier version" }).click();
  const earlier = page.getByRole("dialog", { name: "Earlier version" });
  await expect(earlier).toBeVisible();
  await expect(earlier).toContainText("The earlier version could not be read.");
  await expect(earlier).not.toContainText("Loading the earlier version");
  await expect(earlier.getByRole("heading", { name: FIRST_TITLE })).toHaveCount(0);
  await expect(earlier.getByRole("button", { name: /Submit/ })).toHaveCount(0);
  await expect(earlier.getByRole("radio")).toHaveCount(0);
  expect(failedReads).toBeGreaterThan(0);
  await expectContentClearsBorder(earlier);
  await capture(earlier, "04-earlier-version-unreadable", page);
  // Closing it leaves the inbox and the revised card as they were.
  await page.keyboard.press("Escape");
  await expect(earlier).toBeHidden();
  await expect(card.locator(".kind-revision")).toHaveText(/Revision 2/i);
});
