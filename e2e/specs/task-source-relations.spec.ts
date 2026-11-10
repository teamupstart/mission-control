import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { Locator, Page } from "@playwright/test";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import type { Task } from "../../src/shared/types.ts";

// A GitHub issue swept with a blocking link (gh `--json blockedBy`) arrives in the backlog
// waiting on that blocker. The blocker is outside the sweep's filter, so it becomes a
// `source` dependency the sweep re-reads (`gh issue view`). Closed as not planned, the card
// shows the stopped-dependency warning, and its Resolve action removes the dependency.

const BLOCKER_URL = "https://github.com/acme/infra/issues/99";

function upstream(daemon: DaemonHandle, blocker: { state: string; stateReason: string }): void {
  writeFileSync(daemon.ghIssuesPath, JSON.stringify([
    {
      number: 17, title: "Ship the widget", body: "Needs the infra change first",
      url: "https://github.com/acme/demo/issues/17", labels: [], state: "OPEN", stateReason: "",
      blockedBy: { nodes: [{ number: 99, state: blocker.state, title: "Provision the queue", url: BLOCKER_URL }], totalCount: 1 },
      parent: { number: 5, state: "OPEN", title: "Widget epic", url: "https://github.com/acme/demo/issues/5" },
    },
    // Not listed by the sweep (another repo), only readable through `gh issue view`.
    { number: 99, title: "Provision the queue", body: "", url: BLOCKER_URL, labels: [],
      discoverable: false, ...blocker },
  ]));
}

async function sweep(page: Page, daemon: DaemonHandle): Promise<void> {
  const res = await page.request.post(`${daemon.baseURL}/api/task-sources/s/sweep`);
  expect(res.ok()).toBe(true);
}

/** Save one evidence screenshot, only when the run asks for evidence. */
async function evidence(target: Page | Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  const dir = artifactsDir("task-source-relations"); mkdirSync(dir, { recursive: true });
  await target.screenshot({ path: `${dir}${name}.png` });
}

async function tasks(page: Page, daemon: DaemonHandle): Promise<Task[]> {
  return (await page.request.get(`${daemon.baseURL}/api/tasks`)).json();
}

test("a swept issue arrives waiting on its blocker, and a not-planned blocker can be resolved", async ({ page, daemon }) => {
  upstream(daemon, { state: "OPEN", stateReason: "" });
  expect((await page.request.put(`${daemon.baseURL}/api/task-sources/config`, { data: { sources: [{
    id: "s", kind: "github-issues", label: "Relations", repoRoot: daemon.repo, enabled: false,
    config: { repo: "acme/demo" },
  }] } })).ok()).toBe(true);
  await page.request.put(`${daemon.baseURL}/api/ui/config`, { data: { layout: "board" } });
  await sweep(page, daemon);

  // One task - the parent link filed nothing - carrying one source dependency.
  const filed = await tasks(page, daemon);
  expect(filed.map((t) => t.title)).toEqual(["Ship the widget"]);
  expect(filed[0]!.dependencies).toMatchObject([
    { type: "source", externalId: "acme/infra#99", state: "open", satisfiedAt: null, title: "Provision the queue" },
  ]);

  await page.goto(`${daemon.baseURL}/#/fleet`);
  const card = page.locator("section.board-backlog .bl-card").filter({ hasText: "Ship the widget" });
  await expect(card.getByText("after Provision the queue")).toBeVisible();
  const warning = card.getByRole("button", { name: /Blocked by a stopped dependency/ });
  await expect(warning).toHaveCount(0);
  await evidence(card, "1-swept-dependency-card");

  // The task editor lists the external item and treats it as unmet: only the source's
  // sweep can satisfy it, so the task cannot be dispatched from here yet.
  await page.getByRole("button", { name: "Ship the widget", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Edit a backlog task" });
  await expect(editor.getByRole("button", { name: "Remove dependency: Provision the queue (acme/infra#99)" })).toBeVisible();
  await expect(editor.getByText("Waits for 1 dependency")).toBeVisible();
  await expect(editor.getByRole("button", { name: "Waiting for dependencies" })).toBeDisabled();
  await editor.getByText("Waits for 1 dependency").scrollIntoViewIfNeeded();
  await evidence(page, "2-editor-waits-for-source-dependency");
  await editor.getByRole("button", { name: "Cancel" }).click();
  await expect(editor).toBeHidden();

  // Upstream closes the blocker as not planned; the next sweep re-reads it.
  upstream(daemon, { state: "CLOSED", stateReason: "NOT_PLANNED" });
  await sweep(page, daemon);
  await expect(card.getByText("needs you - Provision the queue didn't finish")).toBeVisible();
  await expect(warning).toBeVisible();
  await evidence(card, "3-stopped-dependency-card");
  await warning.click();
  const dialog = page.getByRole("dialog", { name: "Resolve a stopped prerequisite" });
  await expect(dialog.getByText("acme/infra#99")).toBeVisible();
  await expect(dialog.getByText("not planned", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Provision the queue" })).toHaveAttribute("href", BLOCKER_URL);
  await page.mouse.move(700, 600);
  await dialog.scrollIntoViewIfNeeded();
  await evidence(dialog, "4-stopped-dependency-resolve-dialog");
  await evidence(page, "5-stopped-dependency-board");

  await dialog.getByRole("button", { name: "Remove dependency" }).click();
  await expect(warning).toHaveCount(0);
  await expect(card.getByText(/needs you|after Provision/)).toHaveCount(0);
  await evidence(card, "6-card-released-after-remove");
  expect((await tasks(page, daemon))[0]!.dependencies).toEqual([]);
});

test("a blocker closed as completed releases the swept task", async ({ page, daemon }) => {
  upstream(daemon, { state: "OPEN", stateReason: "" });
  expect((await page.request.put(`${daemon.baseURL}/api/task-sources/config`, { data: { sources: [{
    id: "s", kind: "github-issues", repoRoot: daemon.repo, enabled: false, config: { repo: "acme/demo" },
  }] } })).ok()).toBe(true);
  await page.request.put(`${daemon.baseURL}/api/ui/config`, { data: { layout: "board" } });
  await sweep(page, daemon);
  await page.goto(`${daemon.baseURL}/#/fleet`);
  const card = page.locator("section.board-backlog .bl-card").filter({ hasText: "Ship the widget" });
  await expect(card.getByText("after Provision the queue")).toBeVisible();

  upstream(daemon, { state: "CLOSED", stateReason: "COMPLETED" });
  await sweep(page, daemon);
  await expect(card.getByText("after Provision the queue")).toHaveCount(0);
  expect((await tasks(page, daemon))[0]!.dependencies[0]).toMatchObject({ state: "completed" });

  // A completed item is a satisfied edge, so the editor no longer holds the task back.
  await page.getByRole("button", { name: "Ship the widget", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Edit a backlog task" });
  await expect(editor.getByRole("button", { name: "Remove dependency: Provision the queue (acme/infra#99)" })).toBeVisible();
  await expect(editor.getByText(/Waits for \d+ dependenc/)).toHaveCount(0);
  await expect(editor.getByRole("button", { name: "Dispatch now" })).toBeEnabled();
});
