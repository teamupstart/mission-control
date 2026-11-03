import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { writeGhProductScript } from "../fixtures/fake-agents.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { recordsIn } from "../fixtures/records.ts";
import { expect, test } from "../fixtures/test.ts";

// A dispatch that never started used to be drawn nowhere: its placeholder tile left the board
// the moment the dispatch failed, and the only signal was a chime. These cases fail a real
// dispatch at a real boundary - the fixture repository's origin is pointed at a path that does
// not exist, so the daemon's own `git fetch origin` refuses it before anything is provisioned -
// and follow the failure from the dispatcher's record to the DOM and back through each action.
//
// No model tokens: every agent the daemon launches here, including the report session, is the
// fake from `e2e/fixtures/fake-agents.ts`.

const EVIDENCE = artifactsDir("dispatch-launch-failure");

async function shoot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await (target ?? page).screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/dispatch-launch-failure/${name}.png`);
}

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

async function useLayout(page: Page, daemon: DaemonHandle, layout: "board" | "console"): Promise<void> {
  await api(daemon, "/api/ui/config", { layout }, "PUT");
  await page.reload();
  await expect(page.getByRole("button", { name: "Dispatch" })).toBeVisible();
}

/** Point the fixture repository's origin somewhere unfetchable, and hand back the undo. */
function breakOrigin(daemon: DaemonHandle): () => void {
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", daemon.repo, ...args], { stdio: "pipe" }).toString().trim();
  const original = git("remote", "get-url", "origin");
  git("remote", "set-url", "origin", join(daemon.home, "no-such-origin.git"));
  return () => git("remote", "set-url", "origin", original);
}

/** Whether whatever is painted at the toast's centre belongs to an open modal, not the toast. */
async function toastIsUnderAModal(page: Page): Promise<boolean> {
  const box = await page.getByRole("region", { name: "Launch failures" }).boundingBox();
  if (!box) return false;
  return page.evaluate(([x, y]) => Boolean(document.elementFromPoint(x!, y!)?.closest(".modal-backdrop")),
    [box.x + box.width / 2, box.y + box.height / 2]);
}

async function dispatch(daemon: DaemonHandle, kind: "chat" | "ship" | "scout", title: string): Promise<{ id: string }> {
  return api<{ id: string }>(daemon, "/api/tasks", {
    repoRoot: daemon.repo,
    title,
    intent: `${title}, then report back.`,
    kind,
    agent: "claude",
    workflowId: null,
  });
}

test("a chat that did not start stays where it was dispatched, then reports and retries", async ({
  dashboard,
  daemon,
}) => {
  await useLayout(dashboard, daemon, "board");
  const restore = breakOrigin(daemon);
  const title = "Plan the CSS skins work";
  await dispatch(daemon, "chat", title);

  // The placeholder became a failed tile in the same Working column, with the reason in full.
  const failed = dashboard.getByRole("list", { name: "Did not start" });
  const tile = failed.getByRole("listitem").filter({ hasText: title });
  await expect(tile).toBeVisible();
  await expect(tile).toContainText("Did not start");
  await expect(tile).toContainText("while provisioning");
  await expect(tile).toContainText(/git fetch origin|could not freeze/);
  await expect(tile).toContainText("chat");

  // The moment it failed: a toast that says so, and a count that stays in the top bar.
  const toasts = dashboard.getByRole("region", { name: "Launch failures" });
  await expect(toasts.getByRole("status")).toContainText(`${title} did not start`);
  const count = dashboard.getByRole("button", { name: /1\s*did not start/ });
  await expect(count).toBeVisible();
  await shoot(dashboard, "01-failed-tile-and-toast");

  // Fix the cause, then report it. The confirm says what will happen before anything does -
  // and opened while the toast is still up, it is drawn over the toast, never under it.
  restore();
  await tile.getByRole("button", { name: "Report bug" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Report this launch failure" });
  await expectContentClearsBorder(dialog);
  await expect(toasts).toBeVisible();
  expect(await toastIsUnderAModal(dashboard), "a toast must never paint over a dialog").toBe(true);
  await expect(dialog).toContainText(`Report: ${title} did not start`);
  await expect(dialog).toContainText("Submit public issue");
  await expect(dialog.getByRole("combobox")).toHaveValue(daemon.repo);
  await shoot(dashboard, "02-report-confirm", dialog);
  await dialog.getByRole("button", { name: "Start report session" }).click();
  await expect(dialog).toBeHidden();

  // One report session, a Claude chat whose brief the daemon wrote from the failure.
  await expect.poll(async () => {
    const tasks = await api<Array<{ title: string; kind: string; agent: string; intent: string }>>(daemon, "/api/tasks");
    const report = tasks.find((t) => t.title === `Report: ${title} did not start`);
    return report ? `${report.kind}/${report.agent}/${/report_product_issue/.test(report.intent)}` : null;
  }).toBe("chat/claude/true");
  await expect(tile.getByRole("button", { name: "Open report session" })).toBeVisible({ timeout: 60_000 });
  await expect(tile.getByRole("button", { name: "Report bug" })).toHaveCount(0);

  // Retry files the chat again; once it starts, the failure it retried is answered and leaves.
  await tile.getByRole("button", { name: "Retry" }).click();
  await expect(tile).toHaveCount(0, { timeout: 60_000 });
  await expect(count).toHaveCount(0);
  // Nothing goes on announcing a failure the retry answered.
  await expect(toasts).toHaveCount(0);
  await shoot(dashboard, "03-retried");
});

test("a ship task sent back to the Backlog says it did not start, and Dismiss clears the alert", async ({
  dashboard,
  daemon,
}) => {
  await useLayout(dashboard, daemon, "board");
  const restore = breakOrigin(daemon);
  const title = "Rename the flexbox helper";
  try {
    await dispatch(daemon, "ship", title);

    const card = dashboard.locator(".bl-card").filter({ hasText: title });
    await expect(card).toContainText("Did not start, back in Backlog");
    await expect(card).toContainText(/git fetch origin|could not freeze/);
    await expect(dashboard.getByRole("region", { name: "Launch failures" }).getByRole("status"))
      .toContainText(`${title} did not start and went back to the Backlog`);
    await expect(dashboard.getByRole("button", { name: /1\s*did not start/ })).toBeVisible();
    // Not a failed tile: the work is back where the operator dispatches it from.
    await expect(dashboard.getByRole("list", { name: "Did not start" })).toHaveCount(0);
    await shoot(dashboard, "04-returned-to-backlog");
    const toasts = dashboard.getByRole("region", { name: "Launch failures" });
    const notice = card.getByRole("button", { name: "Dismiss" });
    await notice.scrollIntoViewIfNeeded();
    await shoot(dashboard, "04b-returned-card", card);

    // Dismissed while its toast is still up: the toast goes with the failure, rather than
    // going on saying it did not start and offering a Report bug for it.
    await expect(toasts).toBeVisible();
    await card.getByRole("button", { name: "Dismiss" }).click();
    await expect(card).not.toContainText("Did not start, back in Backlog");
    await expect(dashboard.getByRole("button", { name: /did not start/ })).toHaveCount(0);
    await expect(toasts).toHaveCount(0);
    // The reason stays on the card; only the request for attention is answered.
    await expect(card).toContainText(/git fetch origin|could not freeze/);
  } finally {
    restore();
  }
});

test("the Console rail draws the failed row in the placeholder's place", async ({ dashboard, daemon }) => {
  await useLayout(dashboard, daemon, "console");
  const restore = breakOrigin(daemon);
  const title = "Talk through the lease lifecycle";
  try {
    await dispatch(daemon, "chat", title);
    const row = dashboard.getByRole("list", { name: "Did not start" }).getByRole("listitem").filter({ hasText: title });
    await expect(row).toContainText("did not start");
    await expect(row).toContainText(/git fetch origin|could not freeze/);
    await shoot(dashboard, "05-console-rail");
    const toasts = dashboard.getByRole("region", { name: "Launch failures" });
    await toasts.getByRole("button", { name: "Close" }).click();
    await expect(toasts).toHaveCount(0);
    await expect(row, "closing the toast leaves the failure on the rail").toBeVisible();
    await row.getByRole("button", { name: "Dismiss" }).click();
    await expect(row).toHaveCount(0);
  } finally {
    restore();
  }
});

/**
 * The Console has no Backlog column, so a dispatch that went back to the Backlog would have no
 * surface there at all: the count and Show would point at nothing. The rail draws it instead,
 * and both ways in reach it.
 */
test("in Console layout a failure sent back to the Backlog is reachable from Show and from the count", async ({ dashboard, daemon }) => {
  await useLayout(dashboard, daemon, "console");
  const restore = breakOrigin(daemon);
  const title = "Rename the grid helper";
  try {
    await dispatch(daemon, "ship", title);
    const row = dashboard.getByRole("list", { name: "Did not start" }).getByRole("listitem").filter({ hasText: title });
    const toasts = dashboard.getByRole("region", { name: "Launch failures" });
    await expect(toasts.getByRole("status")).toContainText(`${title} did not start and went back to the Backlog`);

    await toasts.getByRole("button", { name: "Show" }).click();
    const anchor = row.getByLabel(`${title} did not start and went back to the Backlog`);
    await expect(anchor).toBeFocused();
    await expect(row).toContainText("back in Backlog");
    await expect(row).toContainText(/git fetch origin|could not freeze/);
    await expect(row.getByRole("button", { name: "Report bug" })).toBeVisible();
    await expect(row.getByRole("button", { name: "Retry" }), "it is back in the Backlog, which dispatches it").toHaveCount(0);
    await shoot(dashboard, "05b-console-returned");

    // With the toast gone, the count is the way back to it.
    await expect(toasts).toHaveCount(0);
    await anchor.evaluate((element) => (element as HTMLElement).blur());
    await expect(anchor).not.toBeFocused();
    await dashboard.getByRole("button", { name: /1\s*did not start/ }).click();
    await expect(anchor).toBeFocused();
  } finally {
    restore();
  }
});

/** Only the product-report creates, marked by the fixed triage label the daemon adds. */
function productCreates(daemon: DaemonHandle): Array<{ argv: string[] }> {
  return recordsIn<{ argv: string[] }>(daemon.recordDir, (file) => file.startsWith("gh-")).filter(
    (record) => record.argv[0] === "issue" && record.argv[1] === "create" && record.argv.includes("status:needs-triage"),
  );
}

/**
 * The whole Report bug path, through the session it starts. The fake Claude recognises the
 * brief the daemon wrote, starts its own bundled Mission Control MCP server from its launch
 * config and calls the real `report_product_issue`, which blocks on the public preview. Nothing
 * reaches the fake `gh` until the one Submit public issue press in the dashboard.
 */
test("the report session calls report_product_issue and publishes only after one Submit", async ({ dashboard, daemon }) => {
  writeGhProductScript(daemon.home, { preflight: "ok", issueCreate: "created" });
  await useLayout(dashboard, daemon, "console");
  const restore = breakOrigin(daemon);
  const title = "Plan the archive reader";
  try {
    await dispatch(daemon, "chat", title);
    const row = dashboard.getByRole("list", { name: "Did not start" }).getByRole("listitem").filter({ hasText: title });
    await expect(row).toBeVisible();
  } finally {
    restore();
  }

  const row = dashboard.getByRole("list", { name: "Did not start" }).getByRole("listitem").filter({ hasText: title });
  await row.getByRole("button", { name: "Report bug" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Report this launch failure" });
  await dialog.getByRole("button", { name: "Start report session" }).click();
  await expect(dialog).toBeHidden();

  // The report session, not the spec, reaches the tool: its call opens the public preview.
  const reportName = `Report: ${title} did not start`;
  await dashboard.getByRole("navigation", { name: "Sessions" }).getByRole("button")
    .filter({ hasText: reportName }).first().click({ timeout: 60_000 });
  const detail = dashboard.locator(".console-detail");
  await detail.getByRole("button", { name: "to review" }).click({ timeout: 60_000 });
  const form = dashboard.locator(".review-modal");
  await expect(form).toContainText("Public GitHub issue preview");
  await expect(form).toContainText("A chat dispatch did not start");
  await expect(form).toContainText("acme/public-issues");
  const submitOption = form.getByRole("radio", { name: "Submit public issue" });
  await expect(submitOption).not.toBeChecked();
  await expect(form.getByRole("button", { name: "Submit" })).toBeDisabled();
  // Review before submit: the session is waiting, and nothing has been published.
  expect(productCreates(daemon)).toHaveLength(0);
  await shoot(dashboard, "06-report-issue-review", form);

  await submitOption.check();
  await form.getByRole("button", { name: "Submit" }).click();
  await expect(form).toBeHidden();
  await expect.poll(() => productCreates(daemon).length).toBe(1);
  expect(productCreates(daemon)[0]!.argv).toContain("source:agent");
  await expect(detail).toContainText("report_product_issue answered: Product issue created", { timeout: 30_000 });
  await shoot(dashboard, "07-report-issue-created");
});

/**
 * A kept failure, as the dashboard draws it. No fake reaches the dispatcher's kept branch on
 * demand - it needs a launch that fails AFTER its agent exists - so the record that branch
 * writes is seeded while the daemon is down (the suite's convention for states nothing here can
 * produce for real), and everything after it is real: the restarted daemon reads it back, the
 * dashboard draws it, and the retry route refuses it. The task is not yet bound to the session
 * it kept, which is the common shape of that branch, so it is drawn as a tile.
 */
test("a launch that failed but kept its session says so, offers Report bug, and never Retry", async ({ dashboard, daemon }) => {
  await useLayout(dashboard, daemon, "board");
  const title = "Ship the parser rewrite";
  const task = await api<{ id: string }>(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title, intent: `${title}, then report back.`, kind: "ship", agent: "claude", workflowId: null, backlog: true,
  });
  const reason = "the first prompt was not delivered - its session and worktree were kept; open or Cancel it";
  await daemon.crash();
  withDaemonDb(daemon, (db) => db.prepare(
    "UPDATE tasks SET status = 'failed', error = ?, launch_failure = ?, dispatched_at = ? WHERE id = ?",
  ).run(reason, JSON.stringify({
    at: Date.now(), phase: "handover", dismissedAt: null, reportTaskId: null, residentProfileId: null, sessionKept: true,
  }), Date.now(), task.id));
  await daemon.restart();
  await dashboard.reload();

  const tile = dashboard.getByRole("list", { name: "Did not start" }).getByRole("listitem").filter({ hasText: title });
  await expect(tile).toContainText("Launch failed, session kept");
  await expect(tile).toContainText("its session and worktree were kept");
  await expect(tile.getByRole("button", { name: "Report bug" })).toBeVisible();
  await expect(tile.getByRole("button", { name: "Dismiss" })).toBeVisible();
  await expect(tile.getByRole("button", { name: "Retry" }), "a retry would reclaim the worktree its agent may be using").toHaveCount(0);
  await expect(dashboard.getByRole("button", { name: /1\s*did not start/ })).toBeVisible();
  await shoot(dashboard, "08-kept-session");
  // And the server agrees: the route refuses a retry the tile does not offer.
  const forced = await fetch(`${daemon.baseURL}/api/launch-failures/retry`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: task.id }),
  });
  expect(forced.status).toBe(409);
});

/**
 * The remaining dispatch kinds and launch paths, each failing at the same real boundary and
 * each reaching the same visible feedback: a scout from Dispatch, a ship task filed over MCP and
 * launched through the dispatch route Foreman's autopilot calls, a recurring mission's Run now,
 * and a resident launched from its profile.
 */
test("scout, MCP, Foreman-route, recurring-mission and resident launches all reach the same feedback", async ({ dashboard, daemon }) => {
  await useLayout(dashboard, daemon, "board");
  const restore = breakOrigin(daemon);
  try {
    // Dispatch: a scout, which can come back through the Backlog.
    await dispatch(daemon, "scout", "Scout the lease leak");

    // MCP create_task files it; the dispatch route is the one `ForemanClient.dispatchTask` calls.
    const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
    const filed = await fetch(`${daemon.baseURL}/mcp/v3/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-harness-token": token },
      body: JSON.stringify({
        env: {}, cwd: daemon.repo, repoRoot: daemon.repo, title: "Filed over MCP", intent: "Filed over MCP, then report back.",
        kind: "ship", agent: "claude", workflowId: null,
      }),
    });
    expect(filed.ok, await filed.clone().text()).toBe(true);
    const mcpTask = await filed.json() as { id?: string; task?: { id: string } };
    const mcpTaskId = mcpTask.task?.id ?? mcpTask.id!;
    const viaForeman = await fetch(`${daemon.baseURL}/api/tasks/${encodeURIComponent(mcpTaskId)}/dispatch`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ defaultModel: null }),
    });
    expect(viaForeman.ok, await viaForeman.clone().text()).toBe(true);

    // A recurring mission's Run now.
    const mission = await api<{ id: string }>(daemon, "/api/schedules", {
      name: "Nightly sweep", expression: "0 * * * *", timezone: "UTC", overlapPolicy: "skip-active", missedPolicy: "coalesce-latest",
      template: { title: "Nightly sweep", intent: "Sweep the stale branches.", repoRoot: daemon.repo, kind: "ship", workflowId: null },
    });
    await api(daemon, `/api/schedules/${mission.id}/run-now`, {});
    await expect.poll(async () => {
      const all = await api<Array<{ intent: string }>>(daemon, "/api/tasks");
      return all.some((t) => t.intent === "Sweep the stale branches.");
    }, { timeout: 30_000 }).toBe(true);
    const sweep = await api<Array<{ id: string; intent: string; status: string }>>(daemon, "/api/tasks");
    const sweepTask = sweep.find((t) => t.intent === "Sweep the stale branches.")!;
    // A mission files its task into the Backlog; the dispatch route launches it.
    if (sweepTask.status === "backlog") {
      const launched = await fetch(`${daemon.baseURL}/api/tasks/${encodeURIComponent(sweepTask.id)}/dispatch`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ defaultModel: null }),
      });
      expect(launched.ok, await launched.clone().text()).toBe(true);
    }

    // A resident launched from its profile, which has no Backlog to return to.
    const personas = await api<Array<{ id: string; name: string }>>(daemon, "/api/personas");
    const profile = await api<{ id: string }>(daemon, "/api/residents/profiles", { settings: {
      identity: { name: "Lease Wrangler" }, persona: { personaId: personas[0]!.id },
      workspace: { defaultRepoRoot: daemon.repo },
    } });
    await fetch(`${daemon.baseURL}/api/residents/profiles/${profile.id}/launch`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoRoot: daemon.repo, requestId: "launch-failure-resident" }),
    });

    for (const name of ["Scout the lease leak", "Filed over MCP", "Nightly sweep"]) {
      const card = dashboard.locator(".bl-card").filter({ hasText: name });
      await expect(card, name).toContainText("Did not start, back in Backlog", { timeout: 30_000 });
      await expect(card.getByRole("button", { name: "Report bug" }), name).toBeVisible();
    }
    const resident = dashboard.getByRole("list", { name: "Did not start" }).getByRole("listitem").filter({ hasText: "Lease Wrangler" });
    await expect(resident).toContainText("Did not start", { timeout: 30_000 });
    await expect(resident).toContainText(/git fetch origin|could not freeze/);
    await expect(resident.getByRole("button", { name: "Launch again" })).toBeVisible();
    await expect(resident.getByRole("button", { name: "Open profile" })).toBeVisible();
    await expect(resident.getByRole("button", { name: "Report bug" })).toBeVisible();
    await expect(dashboard.getByRole("button", { name: /4\s*did not start/ })).toBeVisible();
    // Close the toasts so the frame shows the surfaces themselves; the failures stay.
    const toasts = dashboard.getByRole("region", { name: "Launch failures" });
    while (await toasts.getByRole("button", { name: "Close" }).count() > 0) {
      await toasts.getByRole("button", { name: "Close" }).first().click();
    }
    await expect(dashboard.getByRole("button", { name: /4\s*did not start/ })).toBeVisible();
    await shoot(dashboard, "09-every-path");
  } finally {
    restore();
  }
});

/**
 * The two ways back to a failure must land somewhere, and the dialog they open must hand focus
 * back. A folded Working column draws only its strip, so the count unfolds it before revealing
 * the tile; and the Report bug dialog returns focus to the button that opened it, not to its
 * own auto-focused Cancel, which is gone once it closes.
 */
test("Show unfolds a folded Working column, and the report dialog hands focus back", async ({ dashboard, daemon }) => {
  await api(daemon, "/api/ui/config", { layout: "board", collapsedBoardColumns: ["working"] }, "PUT");
  await dashboard.reload();
  await expect(dashboard.getByRole("button", { name: "Dispatch" })).toBeVisible();
  const restore = breakOrigin(daemon);
  const title = "Plan the folded column";
  try {
    await dispatch(daemon, "chat", title);
    const tile = dashboard.getByRole("list", { name: "Did not start" }).getByRole("listitem").filter({ hasText: title });
    await expect(dashboard.getByRole("button", { name: /1\s*did not start/ })).toBeVisible();
    await expect(tile, "a folded Working column draws only its strip").toHaveCount(0);

    await dashboard.getByRole("region", { name: "Launch failures" }).getByRole("button", { name: "Close" }).click();
    await dashboard.getByRole("button", { name: /1\s*did not start/ }).click();
    await expect(tile.getByLabel(`${title} did not start`)).toBeFocused();

    const report = tile.getByRole("button", { name: "Report bug" });
    await report.focus();
    await dashboard.keyboard.press("Enter");
    const dialog = dashboard.getByRole("dialog", { name: "Report this launch failure" });
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(report, "focus returns to the button that opened the dialog").toBeFocused();
  } finally {
    restore();
  }
});

/**
 * A drilled-in Board session makes every other column inert, and focus cannot land inside an
 * inert subtree. Show must not stop at an anchor nobody can reach: it closes the drill-in, then
 * focuses the failure.
 */
test("Show closes a drilled-in Board session to reach a failure in an inert column", async ({ dashboard, daemon }) => {
  await useLayout(dashboard, daemon, "board");
  const live = "Keep this session open";
  await dispatch(daemon, "chat", live);
  const openLive = dashboard.getByRole("button", { name: new RegExp(`^Open ${live}`) });
  await expect(openLive).toBeAttached({ timeout: 60_000 });
  // Idle, so it sits in the Idle column and drilling into it leaves Working inert.
  await expect.poll(async () => {
    const sessions = await api<Array<{ state: string; task: { title: string } | null }>>(daemon, "/api/sessions");
    return sessions.find((s) => s.task?.title === live)?.state ?? null;
  }, { timeout: 60_000 }).toBe("idle");

  const restore = breakOrigin(daemon);
  const title = "Fail while drilled in";
  try {
    await dispatch(daemon, "chat", title);
    const tile = dashboard.getByRole("list", { name: "Did not start" }).getByRole("listitem").filter({ hasText: title });
    const anchor = tile.getByLabel(`${title} did not start`);
    await expect(anchor).toBeAttached();
    await dashboard.getByRole("region", { name: "Launch failures" }).getByRole("button", { name: "Close" }).click();

    await openLive.focus();
    await dashboard.keyboard.press("Enter");
    await expect.poll(() => anchor.evaluate((element) => Boolean(element.closest("[inert]"))),
      { message: "drilling into the idle session makes the Working column inert" }).toBe(true);

    await dashboard.getByRole("button", { name: /1\s*did not start/ }).click();
    await expect(anchor).toBeFocused();
    expect(await anchor.evaluate((element) => Boolean(element.closest("[inert]"))), "the drill-in was closed").toBe(false);
  } finally {
    restore();
  }
});
