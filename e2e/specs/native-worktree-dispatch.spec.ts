import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

const EVIDENCE = artifactsDir("native-worktree-dispatch");

/**
 * How long a native dispatch is allowed to take to reach `running`.
 *
 * Every other spec dispatches into an already-warm checkout; this one is the only place a
 * dispatch does real `git worktree` work in a pool - three times, once against a slot that
 * has to be recycled and re-leased first. That is seconds of disk on a busy machine, so the
 * implicit five-second poll is not a statement about the product, it is a statement about
 * the runner. The two teardown polls below already carry an explicit window for the same
 * reason; these are the matching pair.
 */
const DISPATCH_SETTLES_MS = 45_000;

/**
 * How long a confirmed Clean up may take to hand both leases back.
 *
 * This one reclaim tears down TWO pooled native worktrees - the primary and the attached
 * repo - and each teardown is real git plus a process-occupancy scan the allocator will not
 * skip. Measured end to end at 26 to 29 seconds with four suites on the box, and it does
 * complete: instrumenting the failure showed the lease handed back 11 to 14 seconds AFTER
 * the old fifteen-second window had already given up. So the assertion was reading "the
 * reclaim is quick" when what it means, and all it should mean, is "the reclaim frees both
 * leases".
 */
const RECLAIM_SETTLES_MS = 90_000;

interface TaskSnapshot {
  id: string;
  title: string;
  intent: string;
  status: string;
  worktreePath: string | null;
  provider: string | null;
  worktreeLeaseId: string | null;
  extraRepos: Array<{
    repoRoot: string;
    worktreePath: string | null;
    provider: string | null;
    worktreeLeaseId: string | null;
  }>;
}

async function taskFor(daemon: DaemonHandle, intent: string): Promise<TaskSnapshot | undefined> {
  const response = await fetch(`${daemon.baseURL}/api/tasks`);
  if (!response.ok) return undefined;
  return ((await response.json()) as TaskSnapshot[]).find((task) => task.intent === intent);
}

function slot(path: string, daemon: DaemonHandle): {
  path: string;
  state: string;
  leaseId: string | null;
  ownerKey: string | null;
} | undefined {
  return withDaemonDb(daemon, (db) =>
    db.prepare(
      `SELECT path, state, active_lease_id AS leaseId, active_owner_key AS ownerKey
         FROM worktree_slots WHERE path = ?`,
    ).get(path) as {
      path: string;
      state: string;
      leaseId: string | null;
      ownerKey: string | null;
    } | undefined);
}

async function dispatch(
  page: Page,
  daemon: DaemonHandle,
  intent: string,
  extras: readonly string[] = [],
): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  for (const repo of extras) {
    await dialog.getByRole("button", { name: "Add another repo" }).click();
    await dialog.getByPlaceholder("repo to attach…").fill(repo);
    await page.keyboard.press("Escape");
    await dialog.getByRole("button", { name: "Attach repo" }).click();
  }
  await dialog.getByPlaceholder("What should this agent do?").fill(intent);
  await dialog.getByLabel("Kind").selectOption("ship");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

test("native dispatch isolates concurrent work, cleans ownership, and reuses both repo slots", async ({
  dashboard,
  daemon,
}) => {
  // Three native dispatches, a kill, and a confirmed cleanup, each of them real git work on
  // real trees. The default thirty seconds covers the browser, not the disk underneath it.
  test.setTimeout(240_000);
  const firstIntent = "Prepare the first native multi repo change";
  const concurrentIntent = "Keep a concurrent native checkout active";
  const reusedIntent = "Reuse the released native multi repo slots";

  await dispatch(dashboard, daemon, firstIntent, [daemon.secondRepo]);
  await expect.poll(() => taskFor(daemon, firstIntent), { timeout: DISPATCH_SETTLES_MS }).toMatchObject({
    status: "running",
    provider: "mission",
    worktreeLeaseId: expect.any(String),
    extraRepos: [{ provider: "mission", worktreeLeaseId: expect.any(String) }],
  });
  const first = (await taskFor(daemon, firstIntent))!;
  expect(first.worktreePath).toContain(join(daemon.home, "worktree-pools"));
  expect(first.extraRepos[0]?.worktreePath).toContain(join(daemon.home, "worktree-pools"));
  expect(first.extraRepos[0]?.worktreePath).not.toBe(first.worktreePath);
  expect(slot(first.worktreePath!, daemon)).toMatchObject({
    state: "leased",
    leaseId: first.worktreeLeaseId,
    ownerKey: `${first.id}:0`,
  });
  expect(slot(first.extraRepos[0]!.worktreePath!, daemon)).toMatchObject({
    state: "leased",
    leaseId: first.extraRepos[0]!.worktreeLeaseId,
    ownerKey: `${first.id}:1`,
  });

  const firstSessionRow = dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row", { hasText: first.title });
  await firstSessionRow.click();
  const firstDetail = dashboard.locator(".console-detail");
  await expect(firstDetail.locator(".detail-sub dd.mono").first()).toContainText("worktree-pools/");
  if (process.env.MC_E2E_EVIDENCE === "1") {
    mkdirSync(EVIDENCE, { recursive: true });
    await firstDetail.locator(".detail-sub dd.mono").first().hover();
    await expect(dashboard.locator(".tooltip")).toHaveText(first.worktreePath!);
    await dashboard.screenshot({ path: `${EVIDENCE}native-multi-repo-path.png`, fullPage: true });
  }

  // A second live task in the primary repository must get a different slot. It stays active
  // while the first slot is returned and reused below, proving reuse never means sharing.
  await dispatch(dashboard, daemon, concurrentIntent);
  await expect.poll(() => taskFor(daemon, concurrentIntent), { timeout: DISPATCH_SETTLES_MS }).toMatchObject({
    status: "running",
    provider: "mission",
  });
  const concurrent = (await taskFor(daemon, concurrentIntent))!;
  expect(concurrent.worktreePath).not.toBe(first.worktreePath);
  expect(slot(concurrent.worktreePath!, daemon)).toMatchObject({ state: "leased" });

  // A live session disappearing keeps its task checkout. Kill it through the detail, then use
  // the existing explicit Clean up flow. This proves the allocator cutover did not turn
  // session exit into a second task-eviction path.
  await firstDetail.getByRole("button", { name: /kill$/i }).click();
  const kill = dashboard.getByRole("dialog", { name: "Kill session" });
  await kill.getByRole("button", { name: "Kill" }).click();
  await expect(kill).toBeHidden();
  await expect.poll(() => taskFor(daemon, firstIntent), { timeout: 15_000 }).toMatchObject({
    status: "failed",
    worktreePath: first.worktreePath,
    worktreeLeaseId: first.worktreeLeaseId,
  });

  await dashboard.keyboard.press("Shift+P");
  const sitrep = dashboard.getByRole("dialog", { name: "Sitrep" });
  const currentFirst = (await taskFor(daemon, firstIntent))!;
  const firstRow = sitrep.locator(".report-row", { hasText: currentFirst.title });
  await firstRow.getByRole("button", { name: "Clean up" }).click();
  await firstRow.getByRole("button", { name: "Clean up" }).click();
  await expect.poll(() => taskFor(daemon, firstIntent), { timeout: RECLAIM_SETTLES_MS })
    .toMatchObject({
      status: "failed",
      worktreePath: null,
      worktreeLeaseId: null,
      extraRepos: [{ worktreePath: null, worktreeLeaseId: null }],
    });
  await expect(sitrep.locator(".report-row", { hasText: currentFirst.title })).toContainText("failed");
  await expect(
    sitrep.locator(".report-row", { hasText: currentFirst.title }).getByRole("button", { name: "Clean up" }),
  ).toHaveCount(0);
  expect(slot(first.worktreePath!, daemon)).toMatchObject({ state: "available", leaseId: null });
  expect(slot(first.extraRepos[0]!.worktreePath!, daemon)).toMatchObject({ state: "available", leaseId: null });
  await dashboard.keyboard.press("Escape");

  await dispatch(dashboard, daemon, reusedIntent, [daemon.secondRepo]);
  await expect.poll(() => taskFor(daemon, reusedIntent), { timeout: DISPATCH_SETTLES_MS }).toMatchObject({
    status: "running",
    provider: "mission",
    extraRepos: [{ provider: "mission" }],
  });
  const reused = (await taskFor(daemon, reusedIntent))!;
  expect(reused.worktreePath).toBe(first.worktreePath);
  expect(reused.extraRepos[0]?.worktreePath).toBe(first.extraRepos[0]?.worktreePath);
  expect(reused.worktreeLeaseId).not.toBe(first.worktreeLeaseId);
  expect(reused.extraRepos[0]?.worktreeLeaseId).not.toBe(first.extraRepos[0]?.worktreeLeaseId);
  expect(slot(concurrent.worktreePath!, daemon)).toMatchObject({
    state: "leased",
    leaseId: concurrent.worktreeLeaseId,
  });

  if (process.env.MC_E2E_EVIDENCE === "1") {
    const reusedRow = dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row", { hasText: reused.title });
    await reusedRow.click();
    await dashboard.locator(".console-detail .detail-sub dd.mono").first().hover();
    await expect(dashboard.locator(".tooltip")).toHaveText(reused.worktreePath!);
    await dashboard.screenshot({ path: `${EVIDENCE}native-reuse-with-concurrent-slot.png`, fullPage: true });
  }
});
