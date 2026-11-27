import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import type { ReviewItem, Session, Task } from "../../src/shared/types.ts";

/**
 * What is at stake: with `filed-plan-decisions` and `async-input` both on, `request_plan_decisions`
 * files its form instead of holding the MCP call open, and the form is still a gate. The session
 * is amber and the form is counted in "to answer" from filing, while the agent is still finishing
 * its turn; the card says the agent is waiting on the operator's decisions and offers no snooze;
 * a half-filled form cannot be submitted; and the answer reaches the agent as a message. With the
 * plan flag off, the same ask blocks in the call as before.
 *
 * Real daemon, real routes, real SSE and the real built dashboard. The form is posted on the exact
 * channel the MCP tool uses, with the `asyncCapable` marker it sends, and the agents are the
 * suite's fakes, so no model tokens are spent.
 */

const EVIDENCE = artifactsDir("filed-plan-decisions");
const HELD_TURN = "E2E_HOLD_TURN_UNTIL_RELEASED";

async function capture(target: Locator | Page, name: string, page: Page): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(0, 0);
  await expect(page.locator(".tooltip")).toHaveCount(0, { timeout: 3000 }).catch(() => undefined);
  await target.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  console.log(`CAPTURED e2e/.artifacts/filed-plan-decisions/${name}.png`);
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

const PLAN_TITLE = "Linter rollout plan";

function linterPlan(title = PLAN_TITLE): Record<string, unknown> {
  return {
    kind: "plan-decisions",
    title,
    body: "# Linter rollout\n\nAdd one linter to CI, then fix what it reports.",
    decisions: [
      {
        id: "linter", question: "Which linter?", options: [
          { id: "biome", label: "biome", detail: "lint + format in one fast binary" },
          { id: "eslint", label: "eslint", detail: "type-aware rules", recommended: true },
        ],
      },
      {
        id: "rollout", question: "How should it roll out?", options: [
          { id: "warn", label: "Warn first" },
          { id: "block", label: "Block CI at once" },
        ],
      },
    ],
  };
}

type Filed = { id: string; wait: "call" | "message"; receipt?: string };

/** File a plan the way the MCP `request_plan_decisions` tool does. */
async function filePlan(daemon: DaemonHandle, cwd: string, body: Record<string, unknown>): Promise<Filed> {
  const res = await fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({ env: {}, cwd, asyncCapable: true, ...body }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return await res.json() as Filed;
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
  await expectContentClearsBorder(inbox);
  return inbox;
}

test("the File plan decisions row appears in Settings beside Ask without stopping, off by default", async ({ dashboard: page, daemon }) => {
  await page.goto(`${daemon.baseURL}/#/settings/feature-flags`);
  const row = page.locator('[data-anchor="feature-flags/filed-plan-decisions"]');
  await expect(row).toContainText("File plan decisions");
  await expect(row).toContainText("Takes effect only while Ask without stopping is on");
  const toggle = page.getByRole("button", { name: /^File plan decisions:/ });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAccessibleName("File plan decisions: on");
  await capture(row, "01-settings-row", page);
});

test("a filed plan form is a gate: amber and counted while its agent still works, no snooze, complete before submit, answered by message", async ({ dashboard: page, daemon }) => {
  test.setTimeout(150_000);
  await setFlag(daemon, "async-input", true);
  await setFlag(daemon, "filed-plan-decisions", true);
  const task = await api<Task>(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title: "Roll out a linter", intent: `${HELD_TURN} roll out a linter`,
    kind: "ship", agent: "claude", runtime: "sdk", workflowId: null,
  });
  // The fake holds its first turn open: the agent is still working when it files the plan.
  let session!: Session;
  await expect.poll(async () => {
    session = (await sessionFor(daemon, task.id))!;
    return session?.agentSessionId ? session.state : null;
  }, { timeout: 60_000 }).toBe("working");

  const filed = await filePlan(daemon, session.cwd!, linterPlan());
  expect(filed.wait).toBe("message");
  expect(filed.receipt).toMatch(/^Filed, not answered: your plan/);
  expect(filed.receipt).toMatch(/still a gate/);
  // No `/wait` call is needed or made: the response is the whole result.
  await expect.poll(async () => {
    const s = await sessionFor(daemon, task.id);
    return s && { state: s.state, pendingReviews: s.pendingReviews, openQuestions: s.openQuestions };
  }).toEqual({ state: "working", pendingReviews: 1, openQuestions: 0 });

  // Amber and counted from filing, while the agent is still in its turn.
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row", { hasText: session.name }).first().click();
  const detail = page.locator(".console-detail");
  const badge = detail.locator(".badge", { has: page.locator(".badge-dot") }).first();
  await expect(badge).toHaveText(/to review/);
  await expect(badge).toHaveClass(/badge-attention/);
  await expect(page.locator("button.pulse-seg", { hasText: "to answer" }).locator(".pulse-n")).toHaveText("1");
  // The conversation shows the plan where it was filed, as a gate.
  const entry = detail.getByRole("note", { name: `Plan filed: ${PLAN_TITLE}` });
  await expect(entry).toContainText("Open, not answered yet");
  await expect(entry.locator(".review-asked-status")).toHaveText("Waiting on your decisions");
  await expect(entry.getByRole("button", { name: "Open" })).toBeVisible();
  await capture(page, "02-working-but-amber", page);

  // The card in the inbox: the gate line, Submit and Dismiss, and no Remind me later.
  const inbox = await openInbox(page);
  await expect(inbox).toContainText(PLAN_TITLE);
  const wait = inbox.locator(".review-wait");
  await expect(wait).toContainText("Waiting on your decisions");
  await expect(wait).toContainText(/filed (just now|\d+s ago)/);
  await expect(wait).not.toContainText("Still working");
  await expect(inbox.getByRole("button", { name: /Remind me later/ })).toHaveCount(0);
  await expect(inbox.getByRole("button", { name: "Dismiss", exact: true })).toBeVisible();
  const submit = inbox.getByRole("button", { name: /^Submit/ });

  // A half-filled form cannot be submitted.
  await inbox.getByRole("radio", { name: /eslint/ }).check();
  await expect(submit).toBeDisabled();
  await capture(inbox, "03-half-filled", page);
  await inbox.getByRole("radio", { name: /Warn first/ }).check();
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(inbox.getByText("Nothing to answer")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(inbox).toBeHidden();

  // The agent finishes its turn; the answer then reaches it as a message, which starts its next turn.
  writeFileSync(join(daemon.recordDir, "e2e-release-held-turn"), "");
  // The message opens with the review marker line, then exactly the answer text.
  await expect(detail.getByText(`Mock reply to: [mission-control:answer review=${filed.id}]`, { exact: false }).first())
    .toBeVisible({ timeout: 30_000 });
  // The fake agent replies with the prompt it received, so its reply is the delivered message:
  // one message restating the plan and every decision with what was chosen.
  const reply = detail.locator(".turn-assistant", { hasText: `answer to your filed plan ${filed.id}` });
  await expect(reply).toHaveCount(1);
  const delivered = await reply.innerText();
  expect(delivered).toContain(`Plan: ${PLAN_TITLE}`);
  expect(delivered).toContain("Add one linter to CI, then fix what it reports.");
  expect(delivered).toMatch(/Which linter\?\s+→ eslint/);
  expect(delivered).toMatch(/How should it roll out\?\s+→ Warn first/);
  expect(delivered).toContain("The gate is lifted for what was decided");
  await expect(entry).toContainText("Answered");
  await expect(entry.getByRole("button", { name: "Open" })).toHaveCount(0);
  // The daemon's message is never drawn as an operator turn.
  await expect(detail.locator(".turn-user", { hasText: `answer to your filed plan ${filed.id}` })).toHaveCount(0);
  expect((await api<ReviewItem[]>(daemon, "/api/reviews")).find((r) => r.id === filed.id)).toMatchObject({
    status: "answered", waitMode: "message",
  });
  await capture(page, "04-answered-by-message", page);

  // With the plan flag off, the same kind of ask waits in the call exactly as before.
  await setFlag(daemon, "filed-plan-decisions", false);
  const blocking = await filePlan(daemon, session.cwd!, linterPlan("Second linter plan"));
  expect(blocking.wait).toBe("call");
  expect(blocking.receipt).toBeUndefined();
  expect((await api<ReviewItem[]>(daemon, "/api/reviews")).find((r) => r.id === blocking.id)?.waitMode).toBeUndefined();
});
