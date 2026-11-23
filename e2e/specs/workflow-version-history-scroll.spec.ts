import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The published-versions list shows five rows and scrolls the rest.
 *
 * Every publish adds a row, and a built-in that has shipped twenty-odd versions used to print
 * every one of them, so selecting a version put its canvas a screen or more below the row
 * that opened it. Only laid-out geometry can say which rows a person can actually see, so
 * this measures rectangles rather than counting markup.
 *
 * No model tokens: nothing here binds or runs the workflow.
 */

const EVIDENCE = artifactsDir("workflow-version-history-scroll");
const BUILTIN = "No-Mistakes Review (High Rigor)";
const BUILTIN_BUTTON = /^No-Mistakes Review \(High Rigor\)\s*built-in\b/i;
const VISIBLE_ROWS = 5;
const REQUESTED_VERSION_KEY = "mission-control.workflow.requested-version";

async function shoot(target: Page | Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/workflow-version-history-scroll/${name}.png`);
}

async function builtin(daemon: DaemonHandle): Promise<{ id: string; versions: number }> {
  const summaries = await (await fetch(`${daemon.baseURL}/api/workflows`)).json() as Array<{ id: string; name: string }>;
  const id = summaries.find((summary) => summary.name === BUILTIN)!.id;
  const detail = await (await fetch(`${daemon.baseURL}/api/workflows/${encodeURIComponent(id)}`)).json() as {
    versions: unknown[];
  };
  return { id, versions: detail.versions.length };
}

/** Whether `row` lies wholly inside the list's visible scrollport. */
async function rowIsVisibleInList(list: Locator, row: Locator): Promise<boolean> {
  const [bounds, box] = await Promise.all([list.boundingBox(), row.boundingBox()]);
  if (!bounds || !box) return false;
  return box.y >= bounds.y - 0.5 && box.y + box.height <= bounds.y + bounds.height + 0.5;
}

test("published versions show five rows, scroll the rest, and keep the selection beside the list", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.setViewportSize({ width: 1440, height: 900 });
  const workflow = await builtin(daemon);
  expect(workflow.versions).toBeGreaterThan(VISIBLE_ROWS + 1);

  await dashboard.goto(`${daemon.baseURL}/#/workflows`);
  await dashboard.getByRole("button", { name: BUILTIN_BUTTON }).click();
  await expect(dashboard.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(BUILTIN);

  const history = dashboard.locator(".workflow-version-history");
  const list = history.locator(".workflow-version-list");
  const rows = list.getByRole("button", { name: /^Version \d+/ });
  await expect(history.getByRole("heading", { name: "Published versions" })).toBeVisible();
  await expect(history).toContainText(
    `${workflow.versions} versions, newest first. Scroll the list for older ones.`,
  );
  await expect(rows).toHaveCount(workflow.versions);

  for (let index = 0; index < VISIBLE_ROWS; index += 1) {
    expect(await rowIsVisibleInList(list, rows.nth(index)), `row ${index + 1} is visible`).toBe(true);
  }
  const bounds = (await list.boundingBox())!;
  const sixth = (await rows.nth(VISIBLE_ROWS).boundingBox())!;
  expect(sixth.y).toBeGreaterThanOrEqual(bounds.y + bounds.height - 0.5);
  const overflow = await list.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(overflow.scrollHeight).toBeGreaterThan(overflow.clientHeight);
  await dashboard.mouse.move(0, 0);
  await shoot(history, "capped-list");

  const fifth = rows.nth(VISIBLE_ROWS - 1);
  await fifth.click();
  const detail = history.locator(".workflow-version-detail");
  await expect(detail.getByText("Maximum repair rounds")).toBeVisible();
  const detailBox = (await detail.boundingBox())!;
  const listAfter = (await list.boundingBox())!;
  expect(detailBox.y - (listAfter.y + listAfter.height)).toBeLessThan(40);

  const oldest = rows.filter({ hasText: /^Version 1(?!\d)/ });
  expect(await rowIsVisibleInList(list, oldest)).toBe(false);
  await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  expect(await rowIsVisibleInList(list, oldest)).toBe(true);
  await dashboard.mouse.move(0, 0);
  await shoot(history, "scrolled-to-oldest");
});

test("a version opened from elsewhere is scrolled into the capped list", async ({ dashboard, daemon }) => {
  await dashboard.setViewportSize({ width: 1440, height: 900 });
  const workflow = await builtin(daemon);
  expect(workflow.versions).toBeGreaterThan(VISIBLE_ROWS + 1);

  // What a run's version badge does: hand the version over in session storage, then route
  // to the workflow by hash.
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.evaluate(({ key, id }) => {
    sessionStorage.setItem(key, JSON.stringify({ workflowId: id, version: 1 }));
    window.location.hash = `#/library/workflows/${encodeURIComponent(id)}`;
  }, { key: REQUESTED_VERSION_KEY, id: workflow.id });
  await expect(dashboard.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(BUILTIN);

  const list = dashboard.locator(".workflow-version-history .workflow-version-list");
  const oldest = list.getByRole("button", { name: /^Version 1(?!\d)/ });
  await expect(oldest).toHaveClass(/\bactive\b/);
  await expect.poll(() => rowIsVisibleInList(list, oldest)).toBe(true);
  // The newest row has scrolled out, so it is the list that moved, not the rail.
  expect(await rowIsVisibleInList(list, list.getByRole("button", { name: /^Version \d+/ }).first())).toBe(false);
});

async function api<T>(daemon: DaemonHandle, path: string, body: unknown, method: "POST" | "PATCH" = "POST"): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

/**
 * A workflow of the operator's own with exactly `versions` published versions. Publishing an
 * unchanged draft revision is idempotent, so each version after the first edits the
 * description to cut a new draft revision before publishing it.
 */
async function seedWorkflow(daemon: DaemonHandle, name: string, versions: number): Promise<void> {
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    // Not named after the workflow: the Library lists Personas beside workflows, and a
    // shared prefix would make the workflow's button ambiguous.
    name: `Boundary reviewer ${versions}`,
    guidanceMarkdown: `# Boundary reviewer ${versions}\n\nReview the change.`,
  });
  const created = await api<{ workflow: { id: string; draftRevision: number } }>(daemon, "/api/workflows", {
    name,
    draft: {
      nodes: [
        { id: "session", kind: "session", position: { x: 0, y: 0 } },
        { id: "reviewer", kind: "persona", personaId: persona.id, position: { x: 220, y: 0 } },
        { id: "end", kind: "end", outcome: "Approved", position: { x: 440, y: 0 } },
      ],
      edges: [
        { id: "submit", source: "session", sourcePort: "submitted", target: "reviewer", targetPort: "activate" },
        { id: "pass", source: "reviewer", sourcePort: "pass", target: "end", targetPort: "terminal" },
        { id: "fail", source: "reviewer", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
      ],
    },
  });
  const id = created.workflow.id;
  let revision = created.workflow.draftRevision;
  for (let version = 1; version <= versions; version += 1) {
    if (version > 1) {
      const updated = await api<{ workflow: { draftRevision: number } }>(
        daemon,
        `/api/workflows/${encodeURIComponent(id)}`,
        { expectedDraftRevision: revision, description: `Draft for version ${version}` },
        "PATCH",
      );
      revision = updated.workflow.draftRevision;
    }
    await api(daemon, `/api/workflows/${encodeURIComponent(id)}/publish`, { expectedDraftRevision: revision });
  }
}

for (const { versions, overflows } of [
  { versions: VISIBLE_ROWS, overflows: false },
  { versions: VISIBLE_ROWS + 1, overflows: true },
]) {
  test(`${versions} published versions ${overflows ? "overflow the five-row list" : "fit the list without scrolling"}`, async ({
    dashboard,
    daemon,
  }) => {
    await dashboard.setViewportSize({ width: 1440, height: 900 });
    const name = `E2E ${versions} versions`;
    await seedWorkflow(daemon, name, versions);

    await dashboard.goto(`${daemon.baseURL}/#/workflows`);
    await dashboard.getByRole("button", { name: new RegExp(`^${name}`) }).click();
    await expect(dashboard.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(name);

    const history = dashboard.locator(".workflow-version-history");
    const list = history.locator(".workflow-version-list");
    const rows = list.getByRole("button", { name: /^Version \d+/ });
    await expect(rows).toHaveCount(versions);
    await expect(rows.first()).toHaveAccessibleName(new RegExp(`^Version ${versions}(?!\\d)`));

    const caption = history.getByText(/versions, newest first\. Scroll the list for older ones\./);
    const overflow = await list.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    if (overflows) {
      await expect(caption).toHaveText(`${versions} versions, newest first. Scroll the list for older ones.`);
      expect(overflow.scrollHeight).toBeGreaterThan(overflow.clientHeight);
      for (let index = 0; index < VISIBLE_ROWS; index += 1) {
        expect(await rowIsVisibleInList(list, rows.nth(index)), `row ${index + 1} is visible`).toBe(true);
      }
      expect(await rowIsVisibleInList(list, rows.nth(VISIBLE_ROWS))).toBe(false);
      await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      expect(await rowIsVisibleInList(list, rows.nth(VISIBLE_ROWS))).toBe(true);
    } else {
      await expect(caption).toHaveCount(0);
      expect(overflow.scrollHeight).toBeLessThanOrEqual(overflow.clientHeight);
      for (let index = 0; index < versions; index += 1) {
        expect(await rowIsVisibleInList(list, rows.nth(index)), `row ${index + 1} is visible`).toBe(true);
      }
    }

    const oldest = rows.last();
    await expect(oldest).toHaveAccessibleName(/^Version 1(?!\d)/);
    await oldest.click();
    await expect(oldest).toHaveClass(/\bactive\b/);
    expect(await rowIsVisibleInList(list, oldest)).toBe(true);
    await expect(history.locator(".workflow-version-detail").getByText("Maximum repair rounds")).toBeVisible();
    await dashboard.mouse.move(0, 0);
    await shoot(history, `boundary-${versions}-versions`);
  });
}
