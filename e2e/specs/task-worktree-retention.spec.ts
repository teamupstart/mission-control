import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * The 30-day task worktree rule, both halves of it, through a real native checkout.
 *
 * The contract a person actually experiences is a pair, and neither half means much without
 * the other:
 *
 *  - **Work you did resets the clock.** A local commit nobody pushed is still work. The
 *    checkout stays, and the manual **Clean up** control stays with it.
 *  - **An untouched checkout is eventually taken back.** No confirmation, no click - the task
 *    update that removes the cleanup control arrives on its own, and the native slot it held
 *    is available for the next dispatch.
 *
 * Everything here is real: a real native worktree from the daemon's own pool, a real git
 * commit made in it, the real observation pass, the real claim, and the real provider-aware
 * teardown. Two things are staged, both while the daemon is STOPPED and both only because a
 * browser test cannot wait a month: the ledger's own timestamps are moved backwards, and the
 * daemon is restarted so its observation pass runs now rather than on its six-hour cadence.
 * Moving a stored timestamp is a fixture technique - there is deliberately no production
 * setting for the duration and none for switching retention off, so there is nothing else to
 * turn. The exhaustive staged/unstaged/untracked/ignored fingerprint matrix lives in the
 * `node:test` suite, where a case costs milliseconds.
 *
 * Agent binaries are faked by `e2e/fixtures/fake-agents.ts`, as everywhere in this suite.
 */

const EVIDENCE = artifactsDir("task-worktree-retention");
const INTENT = "Leave a native checkout behind for the retention clock";
const REUSE_INTENT = "Reuse the slot automatic cleanup released";
const DAY_MS = 24 * 60 * 60 * 1000;

interface TaskSnapshot {
  id: string;
  title: string;
  intent: string;
  status: string;
  worktreePath: string | null;
  worktreeLeaseId: string | null;
}

async function taskFor(daemon: DaemonHandle, intent: string): Promise<TaskSnapshot | undefined> {
  const response = await fetch(`${daemon.baseURL}/api/tasks`);
  if (!response.ok) return undefined;
  return ((await response.json()) as TaskSnapshot[]).find((task) => task.intent === intent);
}

function retentionRow(daemon: DaemonHandle, taskId: string): {
  fingerprint: string;
  lastChangedAt: number;
  cleanupDueAt: number;
  cleanupState: string;
} | undefined {
  return withDaemonDb(daemon, (db) =>
    db.prepare(
      `SELECT fingerprint, last_changed_at AS lastChangedAt, cleanup_due_at AS cleanupDueAt,
              cleanup_state AS cleanupState
         FROM task_worktree_retention WHERE task_id = ?`,
    ).get(taskId) as {
      fingerprint: string;
      lastChangedAt: number;
      cleanupDueAt: number;
      cleanupState: string;
    } | undefined);
}

function slotState(daemon: DaemonHandle, path: string): string | undefined {
  return withDaemonDb(daemon, (db) =>
    (db.prepare(`SELECT state FROM worktree_slots WHERE path = ?`).get(path) as
      | { state: string }
      | undefined)?.state);
}

/** Move a task's whole retention window back, so its deadline is already behind us. */
function ageRetention(daemon: DaemonHandle, taskId: string, days: number): void {
  withDaemonDb(daemon, (db) => {
    const shift = days * DAY_MS;
    const changed = db.prepare(
      `UPDATE task_worktree_retention
         SET last_changed_at = last_changed_at - ?, cleanup_due_at = cleanup_due_at - ?,
             observed_at = observed_at - ?
       WHERE task_id = ?`,
    ).run(shift, shift, shift, taskId).changes;
    expect(Number(changed), "no retention row to age").toBe(1);
  });
}

/** A local commit in the task's own checkout that nobody has pushed anywhere. */
function commitLocally(worktree: string): void {
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", worktree, ...args], {
      stdio: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "e2e",
        GIT_AUTHOR_EMAIL: "e2e@example.com",
        GIT_COMMITTER_NAME: "e2e",
        GIT_COMMITTER_EMAIL: "e2e@example.com",
      },
    });
  };
  writeFileSync(join(worktree, "unpushed-note.md"), "# work in progress\n");
  git("add", "-A");
  git("-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "commit", "-qm", "local work nobody pushed");
}

async function dispatch(page: Page, daemon: DaemonHandle, intent: string): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(intent);
  await dialog.getByLabel("Kind").selectOption("ship");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

/**
 * Open the Sitrep panel and hand back its dialog.
 *
 * The chord is fleet-scoped and bound by the mounted app, so a press that arrives while the
 * page is still coming up is dropped in silence - and both of this spec's presses follow a
 * reload, which is exactly that window. Waiting for a mounted control first is necessary and
 * not sufficient: the binding and the first paint are not the same instant. So re-press until
 * the panel is actually up, rather than assert that one press must have been heard.
 */
async function openSitrep(page: Page) {
  await expect(page.getByRole("button", { name: "Dispatch" })).toBeVisible({ timeout: 60_000 });
  await expect(async () => {
    await page.keyboard.press("Shift+P");
    await expect(page.getByRole("dialog", { name: "Sitrep" })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  return page.getByRole("dialog", { name: "Sitrep" });
}

test("an edited checkout postpones automatic cleanup; an untouched one is reclaimed", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon, INTENT);
  // Every wait here is on real server work - provisioning a checkout, settling a killed
  // session, a restart's first retention pass - so each names a timeout instead of taking
  // Playwright's 5 s default. Under a loaded suite that default is a coin flip, not a bound.
  await expect.poll(() => taskFor(daemon, INTENT), { timeout: 60_000 }).toMatchObject({
    status: "running",
    worktreeLeaseId: expect.any(String),
  });
  const dispatched = (await taskFor(daemon, INTENT))!;
  const worktree = dispatched.worktreePath!;
  expect(worktree).toContain(join(daemon.home, "worktree-pools"));

  // The agent goes away without recording an outcome, which is the ordinary way a task ends
  // up holding a checkout nobody has decided about. Its tree is KEPT - that is the existing
  // contract, and retention is what eventually bounds it.
  await dashboard
    .getByRole("navigation", { name: "Sessions" })
    .locator("button.rail-row", { hasText: dispatched.title })
    .click();
  await dashboard.locator(".console-detail").getByRole("button", { name: /kill$/i }).click();
  const kill = dashboard.getByRole("dialog", { name: "Kill session" });
  await expect(kill).toContainText("automatically after 30 days");
  await kill.getByRole("button", { name: "Kill" }).click();
  await expect(kill).toBeHidden();
  await expect.poll(() => taskFor(daemon, INTENT), { timeout: 60_000 }).toMatchObject({
    status: "failed",
    worktreePath: worktree,
  });

  // A restart is the honest way to make the daemon observe now rather than on its own slow
  // cadence - and it also proves the thing that used to happen here instead: a restart no
  // longer frees a dead agent's checkout on the spot.
  await daemon.crash();
  await daemon.restart();
  await expect
    .poll(() => retentionRow(daemon, dispatched.id)?.cleanupState, { timeout: 60_000 })
    .toBe("observing");
  const seeded = retentionRow(daemon, dispatched.id)!;
  expect((await taskFor(daemon, INTENT))?.worktreePath, "a restart kept the checkout").toBe(worktree);

  // --- half one: work you did resets the clock ---
  //
  // The deadline is moved past, and a local commit that was never pushed is made in the tree
  // while the daemon is down. The next observation must see the change, not the deadline.
  await daemon.crash();
  commitLocally(worktree);
  ageRetention(daemon, dispatched.id, 31);
  await daemon.restart();

  await expect
    .poll(() => retentionRow(daemon, dispatched.id)?.fingerprint, { timeout: 60_000 })
    .not.toBe(seeded.fingerprint);
  const postponed = retentionRow(daemon, dispatched.id)!;
  expect(postponed.cleanupDueAt).toBeGreaterThan(Date.now());
  expect((await taskFor(daemon, INTENT))?.worktreePath, "unpushed work was not discarded").toBe(
    worktree,
  );
  expect(slotState(daemon, worktree)).toBe("leased");

  // And the manual control is exactly where it was, for the whole of the new window.
  await dashboard.reload();
  const sitrep = await openSitrep(dashboard);
  const row = sitrep.locator(".report-row", { hasText: dispatched.title });
  const cleanup = row.getByRole("button", { name: "Clean up" });
  await expect(cleanup).toBeVisible();

  if (process.env.MC_E2E_EVIDENCE === "1") {
    mkdirSync(EVIDENCE, { recursive: true });
    await dashboard.screenshot({ path: join(EVIDENCE, "retention-postponed.png"), fullPage: true });
  }

  // --- half two: an untouched checkout is taken back, with no click ---
  //
  // Nothing is edited this time, and nobody presses Clean up: the daemon takes the checkout
  // back on its own. The reclaim is asserted against the server's own state below, and then
  // read back through a fresh page - a restarted daemon has to be reconnected to either way,
  // so this half claims durability, not live delivery.
  await dashboard.keyboard.press("Escape");
  await daemon.crash();
  ageRetention(daemon, dispatched.id, 31);
  await daemon.restart();

  await expect.poll(() => taskFor(daemon, INTENT), { timeout: 60_000 }).toMatchObject({
    status: "failed",
    worktreePath: null,
    worktreeLeaseId: null,
  });
  expect(retentionRow(daemon, dispatched.id), "the clock is dropped with the tree").toBeUndefined();
  expect(slotState(daemon, worktree)).toBe("available");

  await dashboard.reload();
  const settled = await openSitrep(dashboard);
  const settledRow = settled.locator(".report-row", { hasText: dispatched.title });
  await expect(settledRow).toContainText("failed");
  await expect(settledRow.getByRole("button", { name: "Clean up" })).toHaveCount(0);

  if (process.env.MC_E2E_EVIDENCE === "1") {
    mkdirSync(EVIDENCE, { recursive: true });
    await dashboard.screenshot({ path: join(EVIDENCE, "retention-reclaimed.png"), fullPage: true });
  }
  await dashboard.keyboard.press("Escape");

  // The slot is genuinely back in the pool, not merely unrecorded.
  await dispatch(dashboard, daemon, REUSE_INTENT);
  await expect
    .poll(() => taskFor(daemon, REUSE_INTENT), { timeout: 60_000 })
    .toMatchObject({ status: "running" });
  expect((await taskFor(daemon, REUSE_INTENT))?.worktreePath).toBe(worktree);
});
