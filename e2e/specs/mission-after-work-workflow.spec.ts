import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * The after-work handoff on a Recurring Mission, driven through the browser.
 *
 * The fixture that matters: a published Workflow is made the machine's DISPATCH DEFAULT
 * before anything else runs. Without one configured, a mission that files no Workflow
 * proves nothing - `resolveTaskWorkflowId` answers null either way.
 *
 * No agent is dispatched and no occurrence is fired, so nothing here spends model tokens.
 * Every control is reached by role and accessible name.
 */

const EVIDENCE = artifactsDir("mission-after-work-workflow");

/** A viewport frame, scrolled so `scrollTo` is actually in it. */
async function shoot(page: Page, name: string, scrollTo?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // `Tooltip` portals a bubble over whatever is being photographed once anything is hovered.
  await page.mouse.move(0, 0);
  if (scrollTo) await scrollTo.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/mission-after-work-workflow/${name}.png`);
}

async function api<T>(
  daemon: DaemonHandle,
  path: string,
  init?: { method: string; body?: unknown },
): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: init?.method ?? "GET",
    headers: { "content-type": "application/json" },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${text}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${path} answered ${response.status} with non-JSON: ${text.slice(0, 160)}`);
  }
}

interface StoredSchedule {
  id: string;
  name: string;
  template: { workflowId?: string | null } | null;
}

const WORKFLOW_NAME = "Nightly review";

/**
 * A published Workflow, made the machine's DISPATCH DEFAULT.
 *
 * The default is the point. Without one configured, a mission that files a task with no
 * Workflow proves nothing - `resolveTaskWorkflowId` would answer null either way, and the
 * regression this spec exists for would sail through it.
 */
async function publishDefaultWorkflow(daemon: DaemonHandle): Promise<string> {
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    method: "POST",
    body: { name: "Nightly reviewer", guidanceMarkdown: "# Nightly reviewer\n\nRead the diff." },
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    method: "POST",
    body: {
      name: WORKFLOW_NAME,
      draft: {
        nodes: [
          { id: "session", kind: "session", position: { x: 0, y: 0 } },
          { id: "reviewer", kind: "persona", personaId: persona.id, position: { x: 220, y: 0 } },
          { id: "end", kind: "end", outcome: "Approved", position: { x: 440, y: 0 } },
        ],
        edges: [
          {
            id: "submit",
            source: "session",
            sourcePort: "submitted",
            target: "reviewer",
            targetPort: "activate",
          },
          { id: "pass", source: "reviewer", sourcePort: "pass", target: "end", targetPort: "terminal" },
          {
            id: "fail",
            source: "reviewer",
            sourcePort: "fail",
            target: "session",
            targetPort: "return_for_changes",
          },
        ],
      },
    },
  });
  await api(daemon, `/api/workflows/${workflow.workflow.id}/publish`, {
    method: "POST",
    body: { expectedDraftRevision: 1 },
  });
  await api(daemon, "/api/workflows/config", {
    method: "PUT",
    body: { liveEnabled: false, repoAllowlist: [], defaultWorkflowId: workflow.workflow.id },
  });
  return workflow.workflow.id;
}

/** A mission saved WITHOUT the field, which is what an older caller sends. */
async function seedMission(daemon: DaemonHandle, name: string): Promise<StoredSchedule> {
  return api<StoredSchedule>(daemon, "/api/schedules", {
    method: "POST",
    body: {
      name,
      expression: "0 3 * * *",
      timezone: "UTC",
      overlapPolicy: "skip-active",
      missedPolicy: "coalesce-latest",
      template: {
        title: `${name} task`,
        intent: `Whatever ${name} is for.`,
        repoRoot: daemon.repo,
        kind: "ship",
      },
    },
  });
}

function storedWorkflowId(
  daemon: DaemonHandle,
  id: string,
): Promise<string | null | undefined> {
  return api<StoredSchedule[]>(daemon, "/api/schedules").then(
    (all) => all.find((s) => s.id === id)?.template?.workflowId,
  );
}

const AFTER_WORK = "After work";

test("a mission's after-work Workflow is chosen in the editor and shown on its detail", async ({
  dashboard,
  daemon,
}) => {
  const workflowId = await publishDefaultWorkflow(daemon);
  const mission = await seedMission(daemon, "Nightly sweep");
  // With a dispatch default armed: a request that never mentioned the field must not
  // inherit it.
  expect(await storedWorkflowId(daemon, mission.id)).toBe(null);

  await dashboard.getByRole("button", { name: "Recurring missions" }).click();
  await dashboard.getByRole("button", { name: "Nightly sweep", exact: false }).first().click();

  await dashboard.getByText(/^Configuration/).first().click();
  await expect(dashboard.getByText(/None - each run finishes without a Workflow/)).toBeVisible();
  await shoot(
    dashboard,
    "01-detail-none",
    dashboard.getByText(/None - each run finishes without a Workflow/),
  );

  await dashboard.getByRole("button", { name: "Edit" }).first().click();
  const afterWork = dashboard.getByRole("combobox", { name: AFTER_WORK });
  await expect(afterWork).toBeVisible();
  await expect(afterWork).toHaveValue("");
  await expect(afterWork.getByRole("option", { name: /Dispatch default/ })).toHaveCount(0);
  await shoot(dashboard, "02-editor-none", afterWork);

  await afterWork.selectOption({ label: `${WORKFLOW_NAME} · v1` });
  await dashboard.getByRole("button", { name: "Save & enable" }).click();

  await expect
    .poll(async () => storedWorkflowId(daemon, mission.id), {
      message: "choosing an after-work Workflow should reach the daemon",
    })
    .toBe(workflowId);

  await dashboard.getByText(/^Configuration/).first().click();
  await expect(dashboard.getByText(`${WORKFLOW_NAME} · v1`).first()).toBeVisible();
  await shoot(dashboard, "03-detail-armed", dashboard.getByText(`${WORKFLOW_NAME} · v1`).first());
});

test("a new mission offers the published Workflows and rests on none of them", async ({
  dashboard,
  daemon,
}) => {
  await publishDefaultWorkflow(daemon);

  await dashboard.getByRole("button", { name: "Recurring missions" }).click();
  await dashboard.getByRole("button", { name: "Create mission" }).click();

  const afterWork = dashboard.getByRole("combobox", { name: AFTER_WORK });
  await expect(afterWork).toBeVisible();
  await expect(afterWork).toHaveValue("");
  await expect(afterWork.getByRole("option", { name: `${WORKFLOW_NAME} · v1` })).toHaveCount(1);
  await shoot(dashboard, "04-new-mission-default", afterWork);

  await afterWork.selectOption({ label: `${WORKFLOW_NAME} · v1` });
  await dashboard.getByRole("combobox", { name: "Task kind" }).selectOption("scout");
  await expect(dashboard.getByText(/A scout has no diff to review/)).toBeVisible();
  await expect(afterWork).toBeDisabled();
  await expect(afterWork).toHaveValue("");
  await shoot(dashboard, "05-scout-stands-down", afterWork);

  await dashboard.getByRole("combobox", { name: "Task kind" }).selectOption("ship");
  await expect(afterWork).toBeEnabled();
  await expect(afterWork).not.toHaveValue("");
});

test("a mission can be saved with no Workflow selected, and the daemon stores none", async ({
  dashboard,
  daemon,
}) => {
  await publishDefaultWorkflow(daemon);

  await dashboard.getByRole("button", { name: "Recurring missions" }).click();
  await dashboard.getByRole("button", { name: "Create mission" }).click();

  await dashboard.getByPlaceholder("e.g. Dependency audit").fill("Quiet sweep");
  await dashboard.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // `RepoCombobox` portals its listbox over the fields below it; close it before reaching them.
  await dashboard.keyboard.press("Escape");
  await dashboard
    .getByPlaceholder("e.g. Run dependency audit and update unsafe packages")
    .fill("Quiet sweep task");
  await dashboard
    .getByPlaceholder("What should the agent do each run?")
    .fill("Sweep, and hand off to nobody.");

  const afterWork = dashboard.getByRole("combobox", { name: AFTER_WORK });
  await expect(afterWork).toHaveValue("");

  // Save PAUSED so no clock starts; this asserts the write and nothing else.
  await dashboard.getByRole("button", { name: "Save paused" }).click();

  await expect
    .poll(
      async () => {
        const all = await api<StoredSchedule[]>(daemon, "/api/schedules");
        const saved = all.find((s) => s.name === "Quiet sweep");
        return saved ? saved.template?.workflowId ?? null : "not-saved";
      },
      { message: "saving with None selected should store no Workflow" },
    )
    .toBe(null);

  await shoot(dashboard, "06-saved-with-none", dashboard.getByText("Quiet sweep").first());
});
