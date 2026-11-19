import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * A Recurring Mission whose runs are chats, so no after-work Workflow follows them.
 *
 * Chat is otherwise Dispatch-only: it never sits in the backlog. A mission is the one creator
 * that may file one there, and this drives the whole path a person takes: choose chat in the
 * mission editor, watch After work stand down, save, press Run now, find the chat on the
 * Backlog, and launch it from its card's editor.
 *
 * NO MODEL TOKENS ARE SPENT: every agent binary is redirected at `e2e/fixtures/fake-agents.ts`.
 */

const EVIDENCE = artifactsDir("mission-chat-kind");

async function shoot(page: Page, name: string, scrollTo?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  if (scrollTo) await scrollTo.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/mission-chat-kind/${name}.png`);
}

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown, method = "PUT"): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

interface StoredSchedule {
  id: string;
  name: string;
  template: { kind: string; workflowId: string | null } | null;
}

interface TaskSnapshot {
  id: string;
  title: string;
  kind: string;
  status: string;
  scheduleId: string | null;
  workflowId: string | null;
}

const MISSION = "Morning check-in";
const TITLE = "Talk through today";

test("a recurring mission can file a chat that runs with no after-work", async ({ dashboard, daemon }) => {
  await dashboard.getByRole("button", { name: "Recurring missions" }).click();
  await dashboard.getByRole("button", { name: "Create mission" }).click();

  const kind = dashboard.getByRole("combobox", { name: "Task kind" });
  await expect(kind.getByRole("option", { name: /^chat - / })).toHaveCount(1);
  await kind.selectOption("chat");
  const afterWork = dashboard.getByRole("combobox", { name: "After work" });
  await expect(dashboard.getByText("A chat has no diff to review, so no Workflow runs after it.")).toBeVisible();
  await expect(afterWork).toBeDisabled();
  await expect(afterWork).toHaveValue("");
  await shoot(dashboard, "01-editor-chat-kind", afterWork);

  await dashboard.getByPlaceholder("e.g. Dependency audit").fill(MISSION);
  await dashboard.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // `RepoCombobox` portals its listbox over the fields below it; close it before reaching them.
  await dashboard.keyboard.press("Escape");
  await dashboard.getByPlaceholder("e.g. Run dependency audit and update unsafe packages").fill(TITLE);
  await dashboard.getByPlaceholder("What should the agent do each run?").fill("What is on your mind this morning?");
  // Paused, so no clock starts; Run now below is the only occurrence.
  await dashboard.getByRole("button", { name: "Save paused" }).click();

  let mission: StoredSchedule | undefined;
  await expect
    .poll(async () => {
      mission = (await api<StoredSchedule[]>(daemon, "/api/schedules")).find((s) => s.name === MISSION);
      return mission?.template ?? null;
    }, { message: "the chat mission should reach the daemon" })
    .toMatchObject({ kind: "chat", workflowId: null });

  await dashboard.getByRole("button", { name: MISSION, exact: false }).first().click();
  await dashboard.getByRole("button", { name: "Run now" }).click();

  let filed: TaskSnapshot | undefined;
  await expect
    .poll(async () => {
      filed = (await api<TaskSnapshot[]>(daemon, "/api/tasks")).find((t) => t.title === TITLE);
      return filed ? { kind: filed.kind, status: filed.status, scheduleId: filed.scheduleId, workflowId: filed.workflowId } : null;
    }, { message: "Run now should file a chat into the backlog" })
    .toEqual({ kind: "chat", status: "backlog", scheduleId: mission!.id, workflowId: null });

  // The chat waits on the Board's Backlog like any other mission run.
  await api(daemon, "/api/ui/config", { layout: "board" });
  await dashboard.reload();
  const card = dashboard.locator("main.board section.board-backlog .bl-card", { hasText: TITLE });
  await expect(card).toBeVisible();
  await shoot(dashboard, "02-backlog-chat-card", card);

  await card.getByRole("button", { name: TITLE, exact: true }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Edit a backlog task" });
  await expect(dialog).toBeVisible();
  await expectContentClearsBorder(dialog);
  await expect(dialog.getByRole("combobox", { name: "Kind", exact: true })).toHaveValue("chat");
  // A mission's chat runs no after-work, and its editor does not offer one.
  const editAfterWork = dialog.getByRole("combobox", { name: "After work" });
  await expect(editAfterWork).toBeDisabled();
  await expect(editAfterWork).toHaveValue("__none");
  await expect(dialog.getByText("A chat a recurring mission files runs no after-work Workflow.")).toBeVisible();
  await shoot(dashboard, "03-edit-scheduled-chat", dialog.getByText("A chat a recurring mission files runs no after-work Workflow."));

  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect
    .poll(async () => (await api<TaskSnapshot[]>(daemon, "/api/tasks")).find((t) => t.id === filed!.id)?.status, {
      message: "a mission-filed chat should launch from its backlog card",
      timeout: 60_000,
    })
    .toBe("running");
  const launched = (await api<TaskSnapshot[]>(daemon, "/api/tasks")).find((t) => t.id === filed!.id)!;
  expect(launched.kind).toBe("chat");
  expect(launched.workflowId).toBeNull();
});

test("Foreman launches a mission-filed chat on its own, with nobody pressing Dispatch", async ({ dashboard, daemon }) => {
  const title = "Unattended check-in";
  const mission = await api<StoredSchedule>(daemon, "/api/schedules", {
    name: "Unattended chat mission",
    // Monthly, so the cadence never fires during the test: Run now is the only occurrence.
    expression: "0 9 1 * *",
    timezone: "UTC",
    overlapPolicy: "skip-active",
    missedPolicy: "coalesce-latest",
    template: {
      title,
      intent: "Ask me how the week is going.",
      repoRoot: daemon.repo,
      kind: "chat",
      agent: "claude",
    },
  }, "POST");
  expect(mission.template).toMatchObject({ kind: "chat", workflowId: null });

  // Arm the backlog autopilot for this repo, live, and start the worker - the same switch an
  // operator turns on. From here no step in this test dispatches anything.
  await api(daemon, "/api/foreman/config", {
    enabled: true,
    mode: "live",
    autoBacklog: true,
    maxSessions: 2,
    repoAllowlist: [daemon.repo],
  });
  await daemon.startForeman();

  await api(daemon, "/api/ui/config", { layout: "board" });
  await dashboard.reload();
  await dashboard.getByRole("button", { name: "Recurring missions" }).click();
  await dashboard.getByRole("button", { name: "Unattended chat mission", exact: false }).first().click();
  await dashboard.getByRole("button", { name: "Run now" }).click();

  let launched: (TaskSnapshot & { sessionId: string | null }) | undefined;
  try {
    await expect
      .poll(async () => {
        launched = (await api<Array<TaskSnapshot & { sessionId: string | null }>>(daemon, "/api/tasks"))
          .find((t) => t.title === title);
        return launched ? { status: launched.status, bound: launched.sessionId !== null } : null;
      }, { message: "Foreman should launch the mission-filed chat without a manual dispatch", timeout: 90_000 })
      .toEqual({ status: "running", bound: true });
  } catch (error) {
    throw new Error(`${(error as Error).message}\n\n--- daemon log ---\n${daemon.readLog()}`);
  }
  expect(launched!.kind).toBe("chat");
  expect(launched!.scheduleId).toBe(mission.id);
  expect(launched!.workflowId).toBeNull();

  // What a person sees: the chat has left the Backlog and is running on the fleet.
  await dashboard.keyboard.press("Escape");
  const board = dashboard.locator("main.board");
  await expect(board.locator("section.board-backlog .bl-card", { hasText: title })).toHaveCount(0);
  await expect(board.getByText(title).first()).toBeVisible();
  await shoot(dashboard, "04-foreman-launched-chat-running");
});

test("editing a dependent mission task into a chat drops its dependencies and Workflow, and the saved chat waits on nothing", async ({ dashboard, daemon }) => {
  const prerequisite = await api<TaskSnapshot>(daemon, "/api/tasks", {
    repoRoot: daemon.repo,
    title: "Finish the prerequisite",
    intent: "Land the groundwork first.",
    kind: "ship",
    agent: "claude",
    backlog: true,
  }, "POST");
  const mission = await api<StoredSchedule>(daemon, "/api/schedules", {
    name: "Ship that becomes a chat",
    expression: "0 9 1 * *",
    timezone: "UTC",
    overlapPolicy: "skip-active",
    missedPolicy: "coalesce-latest",
    template: {
      title: "Weekly sync",
      intent: "Talk through the week.",
      repoRoot: daemon.repo,
      kind: "ship",
      agent: "claude",
      // A review the ship run would arm, so the switch to chat has one to drop.
      workflowId: "builtin-workflow:general-review",
    },
  }, "POST");
  await api(daemon, `/api/schedules/${mission.id}/run-now`, {}, "POST");
  let filed: TaskSnapshot & { dependencies: unknown[] } | undefined;
  await expect.poll(async () => {
    filed = (await api<Array<TaskSnapshot & { dependencies: unknown[] }>>(daemon, "/api/tasks"))
      .find((t) => t.scheduleId === mission.id);
    return filed?.status ?? null;
  }).toBe("backlog");
  await api(daemon, `/api/tasks/${filed!.id}/update`, {
    dependencies: [{ type: "task", taskId: prerequisite.id }],
  }, "POST");

  await api(daemon, "/api/ui/config", { layout: "board" });
  await dashboard.reload();
  await dashboard.locator("main.board section.board-backlog .bl-card", { hasText: "Weekly sync" })
    .getByRole("button", { name: "Weekly sync", exact: true }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Edit a backlog task" });
  await expect(dialog).toBeVisible();
  // The fold opens on its own for a task that carries dependencies; open it only if it did not.
  const fold = dialog.getByRole("button", { name: "Backlog details" });
  if ((await fold.getAttribute("aria-expanded")) !== "true") await fold.click();
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await expect(dialog.getByText("Finish the prerequisite").first()).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Add dependency" })).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "After work" })).toHaveValue("builtin-workflow:general-review");

  await dialog.getByRole("combobox", { name: "Kind", exact: true }).selectOption("chat");
  await expect(dialog.getByRole("combobox", { name: "After work" })).toBeDisabled();
  await expect(dialog.getByRole("combobox", { name: "After work" })).toHaveValue("__none");
  await expect(dialog.getByRole("combobox", { name: "Add dependency" })).toHaveCount(0);
  await expect(dialog.getByText("Finish the prerequisite")).toHaveCount(0);
  await shoot(dashboard, "05-chat-drops-dependencies", dialog.getByRole("button", { name: "Save" }));
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();

  await expect.poll(async () => {
    const saved = (await api<Array<TaskSnapshot & { dependencies: unknown[] }>>(daemon, "/api/tasks"))
      .find((t) => t.id === filed!.id);
    return saved ? { kind: saved.kind, dependencies: saved.dependencies.length, workflowId: saved.workflowId } : null;
  }, { message: "the saved chat should carry no dependencies and no after-work Workflow" })
    .toEqual({ kind: "chat", dependencies: 0, workflowId: null });
});

test("a configured chat Workflow that loads after an edit switches to chat does not land on the mission chat", async ({ dashboard, daemon }) => {
  // The chat row on Settings -> Tasks names a review, which a hand-dispatched chat would arm.
  await api(daemon, "/api/workflows/config", {
    liveEnabled: false,
    repoAllowlist: [],
    kindWorkflowDefaults: { chat: "builtin-workflow:general-review" },
  });
  const mission = await api<StoredSchedule>(daemon, "/api/schedules", {
    name: "Late config mission",
    expression: "0 9 1 * *",
    timezone: "UTC",
    overlapPolicy: "skip-active",
    missedPolicy: "coalesce-latest",
    template: { title: "Late config sync", intent: "Check in.", repoRoot: daemon.repo, kind: "ship", agent: "claude" },
  }, "POST");
  await api(daemon, `/api/schedules/${mission.id}/run-now`, {}, "POST");
  let filed: TaskSnapshot | undefined;
  await expect.poll(async () => {
    filed = (await api<TaskSnapshot[]>(daemon, "/api/tasks")).find((t) => t.scheduleId === mission.id);
    return filed?.status ?? null;
  }).toBe("backlog");

  await api(daemon, "/api/ui/config", { layout: "board" });
  await dashboard.reload();

  // Hold the editor's Workflow config read until the kind has already moved to chat.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await dashboard.route("**/api/workflows/config", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await held;
    await route.continue();
  });

  await dashboard.locator("main.board section.board-backlog .bl-card", { hasText: "Late config sync" })
    .getByRole("button", { name: "Late config sync", exact: true }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Edit a backlog task" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox", { name: "Kind", exact: true }).selectOption("chat");
  const afterWork = dialog.getByRole("combobox", { name: "After work" });
  await expect(afterWork).toHaveValue("__none");

  const configRead = dashboard.waitForResponse((response) =>
    response.url().endsWith("/api/workflows/config") && response.request().method() === "GET");
  release();
  await configRead;
  // Give the late rows a render to land, then check they did not.
  await expect(afterWork).toHaveValue("__none");
  await expect(afterWork).toBeDisabled();

  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => {
    const saved = (await api<TaskSnapshot[]>(daemon, "/api/tasks")).find((t) => t.id === filed!.id);
    return saved ? { kind: saved.kind, workflowId: saved.workflowId } : null;
  }, { message: "the save should succeed as a chat with no Workflow" }).toEqual({ kind: "chat", workflowId: null });
});
