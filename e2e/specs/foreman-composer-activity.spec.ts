import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

const FOREMAN_MESSAGE = "Foreman should wait for the operator's draft.";
const HUMAN_MESSAGE = "I am still writing this response.";

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("exercise composer activity protection");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

async function openConversation(page: Page): Promise<{ detail: Locator; reply: Locator }> {
  const row = page
    .getByRole("navigation", { name: "Sessions" })
    .locator("button.rail-row")
    .first();
  await row.click();
  const detail = page.locator(".console-detail");
  const reply = detail.getByPlaceholder(/^Reply to this session/);
  await expect(reply).toBeEnabled();
  return { detail, reply };
}

async function sessionId(daemon: DaemonHandle): Promise<string> {
  let id: string | null = null;
  await expect.poll(async () => {
    const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as Array<{
      id: string;
      agentSessionId: string | null;
      runtime: string;
    }>;
    id = sessions.find((session) => session.runtime === "sdk" && session.agentSessionId !== null)?.id ?? null;
    return id;
  }, { message: "the dispatched session should bind a conversation", timeout: 30_000 }).not.toBeNull();
  return id!;
}

async function foremanPost(daemon: DaemonHandle, id: string): Promise<Response> {
  return await fetch(`${daemon.baseURL}/api/sessions/${encodeURIComponent(id)}/inject`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: FOREMAN_MESSAGE, origin: "foreman", buffer: false }),
  });
}

async function reportsComposer(
  page: Page,
  expected: { focused: boolean; typed: boolean },
  action: () => Promise<void>,
): Promise<void> {
  const reported = page.waitForResponse((response) => {
    if (!response.url().includes("/composer-activity")) return false;
    const body = response.request().postDataJSON() as { focused?: boolean; typed?: boolean };
    return body.focused === expected.focused && body.typed === expected.typed;
  });
  await action();
  expect((await reported).ok(), "the daemon should acknowledge composer activity").toBe(true);
}

test("Foreman waits while the operator is composing and for one minute after input", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  const id = await sessionId(daemon);
  const { detail, reply } = await openConversation(dashboard);

  await reportsComposer(dashboard, { focused: true, typed: false }, () => reply.focus());
  await expect(reply).toBeFocused();
  expect((await foremanPost(daemon, id)).status).toBe(409);

  await reportsComposer(dashboard, { focused: true, typed: true }, () => reply.fill(HUMAN_MESSAGE));
  await reportsComposer(dashboard, { focused: false, typed: false }, () => reply.press("Escape"));
  await expect(reply).not.toBeFocused();

  const recent = await foremanPost(daemon, id);
  expect(recent.status).toBe(409);
  expect(await recent.json()).toMatchObject({
    error: "Foreman is waiting while the user composes a reply",
    pasted: false,
  });

  await reportsComposer(dashboard, { focused: true, typed: false }, () => reply.focus());
  await reply.press("Enter");
  await expect(detail.getByRole("article", { name: "you", exact: true })).toHaveCount(2);
  await reportsComposer(dashboard, { focused: false, typed: false }, () => reply.press("Escape"));
  await expect(reply).not.toBeFocused();

  const afterHumanSend = await foremanPost(daemon, id);
  expect(afterHumanSend.status, "a human send must not end the one-minute quiet period").toBe(409);
});
