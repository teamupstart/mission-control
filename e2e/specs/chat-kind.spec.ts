import { readFileSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { settled } from "../fixtures/settle.ts";

const OPENER = "Help me reason through the session lifecycle";
const LATER_TURN = "How does eviction change that answer?";

async function api<T>(
  daemon: DaemonHandle,
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

async function openDispatch(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  return dialog;
}

function options(select: Locator): Promise<string[]> {
  return select.evaluate((element) =>
    [...(element as HTMLSelectElement).options].map((option) => option.value),
  );
}

async function builtinWorkflowId(afterWork: Locator): Promise<string> {
  await expect.poll(() => afterWork.evaluate(
    (element) => (element as HTMLSelectElement).selectedOptions[0]?.textContent ?? "",
  )).not.toContain("loading");
  const id = await afterWork.evaluate((element) =>
    [...(element as HTMLSelectElement).options].find((option) =>
      option.textContent?.startsWith("No-Mistakes Review"),
    )?.value ?? "",
  );
  expect(id).not.toBe("");
  return id;
}

async function seedBacklogTask(daemon: DaemonHandle, title: string): Promise<void> {
  await api(daemon, "/api/tasks", {
    repoRoot: daemon.repo,
    title,
    intent: "Finish the prerequisite first.",
    kind: "ship",
    agent: "claude",
    backlog: true,
  });
}

test("chat is immediate and restores Workflow and dependencies after a detour", async ({
  dashboard,
  daemon,
}) => {
  const dependencyTitle = "Prepare the session notes";
  await seedBacklogTask(daemon, dependencyTitle);

  const dialog = await openDispatch(dashboard);
  const kind = dialog.getByRole("combobox", { name: "Kind", exact: true });
  const afterWork = dialog.getByRole("combobox", { name: "After work", exact: true });
  expect(await options(kind)).toEqual(["ship", "scout", "plan", "chat"]);

  await dialog.getByRole("button", { name: "Backlog details" }).click();
  const dependency = dialog.getByRole("combobox", { name: "Add dependency" });
  const dependencyValue = await dependency.evaluate(
    (element, title) =>
      [...(element as HTMLSelectElement).options].find((option) =>
        option.textContent?.includes(title),
      )?.value ?? "",
    dependencyTitle,
  );
  expect(dependencyValue).not.toBe("");
  await dependency.selectOption(dependencyValue);

  const workflowId = await builtinWorkflowId(afterWork);
  await afterWork.selectOption(workflowId);
  await kind.selectOption("chat");

  await expect(afterWork).toHaveValue("__none");
  await expect(dialog.getByRole("textbox", { name: "What would you like to talk about?" }))
    .toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Add dependency" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Add to backlog" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Dispatch now" })).toBeVisible();

  await kind.selectOption("scout");
  await expect(afterWork).toHaveValue("__none");
  await kind.selectOption("plan");
  await expect(afterWork).toHaveValue("__none");
  await kind.selectOption("ship");
  await expect(afterWork).toHaveValue(workflowId);
  await expect(dialog.locator(".dep-chip", { hasText: dependencyTitle })).toBeVisible();

  await kind.selectOption("chat");
  await afterWork.selectOption(workflowId);
  await kind.selectOption("plan");
  await expect(afterWork).toHaveValue(workflowId);
  await kind.selectOption("ship");
  await expect(afterWork).toHaveValue(workflowId);
});

test("guided dispatch selects chat with c and uses the same conversational form", async ({
  dashboard,
}) => {
  const dialog = await openDispatch(dashboard);
  await dialog.getByRole("switch", { name: "Guided" }).click();
  await dashboard.keyboard.press("Enter");

  const picker = dialog.getByRole("listbox", { name: "What kind of run is this?" });
  const chat = picker.getByRole("option", { name: /^chat/ });
  await expect(chat).toContainText("Talk with an agent without a planned artifact");
  await expect(chat).toContainText("c");

  await dashboard.keyboard.press("c");
  await expect(dialog.getByRole("combobox", { name: "Kind", exact: true })).toHaveValue("chat");
  await expect(dialog.getByRole("textbox", { name: "What would you like to talk about?" }))
    .toBeVisible();
});

test("backlog edit, ensemble, schedules, and task sources do not offer chat", async ({
  dashboard,
  daemon,
}) => {
  const title = "Backlog-only work";
  await seedBacklogTask(daemon, title);

  const dispatch = await openDispatch(dashboard);
  await dispatch.getByRole("radio", { name: "Ensemble" }).click();
  await expect(dispatch.getByRole("combobox", { name: "Kind", exact: true })).toHaveCount(0);
  await dispatch.getByRole("button", { name: "Close", exact: true }).click();

  await dashboard.keyboard.press("Shift+P");
  await dashboard.getByRole("button", { name: title, exact: true }).click();
  const editor = dashboard.getByRole("dialog", { name: "Edit a backlog task" });
  expect(await options(editor.getByRole("combobox", { name: "Kind", exact: true })))
    .toEqual(["ship", "scout", "plan"]);
  await editor.getByRole("button", { name: "Cancel" }).click();

  await dashboard.getByRole("button", { name: "Recurring missions" }).click();
  const missions = dashboard.getByRole("dialog", { name: "Recurring missions" });
  await missions.getByRole("button", { name: "Create mission" }).click();
  expect(await options(missions.getByRole("combobox", { name: "Task kind" })))
    .toEqual(["ship", "scout", "plan", "pipeline"]);
  await missions.getByRole("button", { name: "Close" }).click();

  await api(daemon, "/api/task-sources/config", {
    sources: [{
      id: "source-chat-scope",
      kind: "github-issues",
      label: "Issues",
      enabled: false,
      repoRoot: daemon.repo,
      intervalMs: 900_000,
      defaults: { kind: "ship", agent: "claude", priority: null, labels: [] },
      maxPerSweep: 25,
      config: {},
    }],
  }, "PUT");
  await dashboard.goto(`${daemon.baseURL}/#/settings/task-sources`);
  const sourceKind = dashboard.getByRole("combobox", { name: "Kind", exact: true });
  await expect(sourceKind).toBeVisible();
  expect(await options(sourceKind)).toEqual(["ship", "scout", "plan", "pipeline"]);
});

test("a fake-agent chat survives idle and a later turn until Complete and close", async ({
  dashboard,
  daemon,
}) => {
  await api(daemon, "/api/foreman/config", {
    enabled: true,
    wrapup: "ask",
    wrapupTriggers: ["prompted"],
  }, "PUT");

  const dialog = await openDispatch(dashboard);
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByRole("combobox", { name: "Kind", exact: true }).selectOption("chat");
  const opener = dialog.getByRole("textbox", { name: "What would you like to talk about?" });
  await expect(dialog.getByRole("button", { name: "Dispatch now" })).toBeDisabled();
  await opener.fill(OPENER);
  await expect(dialog.getByRole("button", { name: "Add to backlog" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  const card = dashboard.locator("article.card").first();
  await expect(card).toBeVisible();
  await expect(card.getByText("chat", { exact: true })).toBeVisible();

  let session: {
    id: string;
    agent: string;
    agentSessionId: string | null;
    cwd: string;
    state: string;
  } | null = null;
  await expect.poll(async () => {
    session = (await api<Array<NonNullable<typeof session>>>(daemon, "/api/sessions"))[0] ?? null;
    return session?.agentSessionId && session.state === "idle" ? "ready" : session?.state ?? null;
  }, { timeout: 60_000 }).toBe("ready");
  if (!session) throw new Error("chat session did not bind");

  const token = readFileSync(`${daemon.home}/token`, "utf8").trim();
  // Agent SDK launch already captured the accepted opener. Only the completion hook is
  // supplied here to establish the instrumentation and work-cycle proof this Foreman case
  // needs; reposting the opener would create a second human Goal revision that never existed.
  const response = await fetch(`${daemon.baseURL}/hooks/Stop`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({
      agent: session.agent,
      sessionId: session.agentSessionId,
      cwd: session.cwd,
      env: {},
    }),
  });
  expect(response.status).toBe(204);

  await expect.poll(async () => {
    const current = (await api<Array<{
      id: string;
      hooksSeen: boolean;
      instrumented: boolean;
      goal: {
        relationship: string | null;
        promptRevision: number;
        resolvedPromptRevision: number;
      } | null;
    }>>(daemon, "/api/sessions")).find((candidate) => candidate.id === session!.id);
    return current ? {
      hooksSeen: current.hooksSeen,
      instrumented: current.instrumented,
      relationship: current.goal?.relationship ?? null,
      revisions: current.goal
        ? [current.goal.resolvedPromptRevision, current.goal.promptRevision]
        : null,
    } : null;
  }, {
    message: "the completion hooks should leave a reconciled chat objective",
    timeout: 30_000,
  }).toEqual({
    hooksSeen: true,
    instrumented: true,
    relationship: "initial",
    revisions: [1, 1],
  });

  await daemon.startForeman();
  await expect.poll(async () =>
    (await api<{ promptedConsumedGeneration: number | null } | null>(
      daemon,
      `/api/sessions/${session!.id}/queue`,
    ))?.promptedConsumedGeneration ?? 0,
  { timeout: 40_000 }).toBeGreaterThan(0);
  await expect.poll(async () =>
    (await api<Array<{ id: string; status: string; kind: string }>>(daemon, "/api/tasks"))
      .find((task) => task.kind === "chat")?.status ?? null,
  ).toBe("running");

  await card.getByRole("button", { name: "Queue" }).click();
  await expect(card.getByRole("button", { name: "Run No-Mistakes Review" })).toHaveCount(0);
  await expect(card.getByLabel("Direct shipping instruction")).toHaveCount(0);

  await card.getByRole("button", { name: "Expand conversation" }).click();
  const reply = card.getByPlaceholder(/^Reply to this session/);
  await expect(reply).toBeEnabled();
  await reply.fill(LATER_TURN);
  await reply.press("Enter");
  await expect(card.getByText(`Mock reply to: ${LATER_TURN}`, { exact: true }))
    .toBeVisible({ timeout: 30_000 });

  const complete = card.getByRole("button", { name: "Complete" });
  await settled(complete);
  await complete.click();
  const completeDialog = dashboard.getByRole("dialog", {
    name: "Complete task and close session",
  });
  await completeDialog.getByRole("button", { name: "Complete & close" }).click();
  await expect(completeDialog).toBeHidden();
  await expect.poll(async () =>
    (await api<Array<{ kind: string; status: string }>>(daemon, "/api/tasks"))
      .find((task) => task.kind === "chat")?.status ?? null,
  ).toBe("done");
});
