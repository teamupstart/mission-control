import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { ResidentProfile } from "../../src/shared/residents.ts";

// The fake CLI hangs every `/compact` until interrupted, and the daemon gives up on one after
// two seconds instead of ten minutes. Ordinary turns are unaffected, and the Run now test's
// profile never reaches its compaction threshold.
test.use({ daemonEnv: { MC_E2E_CLAUDE_STALL_COMPACT: "1", MISSION_RESIDENT_COMPACTION_STALL_MS: "2000" } });

async function request<T>(daemon: DaemonHandle, path: string, body?: unknown, method = "POST"): Promise<T> {
  const response = await fetch(daemon.baseURL + path, body === undefined && method === "GET" ? {} : {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}
type Run = { id: string; task_id: string; iteration: number; loop_state: string; pause_reason: string | null; wake_reason: string | null; run_requested_at: number | null };
function live(daemon: DaemonHandle): Run | undefined {
  return withDaemonDb(daemon, db => db.prepare("SELECT * FROM resident_runs WHERE ended_at IS NULL AND launch_state = 'launched'").get() as Run | undefined);
}
function turnInProgress(daemon: DaemonHandle, run: Run): number | undefined {
  return withDaemonDb(daemon, db => (db.prepare("SELECT turn_in_progress FROM sdk_sessions WHERE task_id = ?").get(run.task_id) as { turn_in_progress: number } | undefined)?.turn_in_progress);
}
async function launch(daemon: DaemonHandle, name: string, loop: Record<string, unknown>): Promise<ResidentProfile> {
  const personas = await request<Array<{ id: string; name: string }>>(daemon, "/api/personas", undefined, "GET");
  const profile = await request<ResidentProfile>(daemon, "/api/residents/profiles", { settings: {
    identity: { name }, persona: { personaId: personas.find(p => p.name === "Code Risk Reviewer")!.id },
    workspace: { defaultRepoRoot: daemon.repo },
    execution: { model: "claude-fable-5" }, // The fake measures 18% context for this catalog model.
    loop,
  } });
  await request(daemon, `/api/residents/profiles/${profile.id}/launch`, { repoRoot: daemon.repo, requestId: `launch-${profile.id}` });
  return profile;
}
/** The resident's band, opened from the dock the way an operator reaches it. */
async function band(page: Page, daemon: DaemonHandle, profile: ResidentProfile): Promise<Locator> {
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await page.getByRole("button", { name: "Residents - 1 live", exact: true }).click();
  const dock = page.getByRole("dialog", { name: "Residents", exact: true });
  await dock.getByRole("button", { name: `Open ${profile.name}` }).click();
  const host = page.getByRole("group", { name: `Resident ${profile.name}` });
  await expect(host).toBeVisible();
  return host;
}
async function capture(page: Page, name: string) {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  const dir = artifactsDir("residents-busy-recovery"); mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}${name}.png` });
}

test("Run now on a busy resident queues the iteration instead of refusing, and Cancel drops it", async ({ dashboard: page, daemon }) => {
  const profile = await launch(daemon, "Queued run", { delaySeconds: 3600, minDelaySeconds: 1, maxDelaySeconds: 3600 });
  await expect.poll(() => live(daemon)?.loop_state, { timeout: 60_000 }).toBe("waiting");
  expect(live(daemon)?.iteration).toBe(1);
  const host = await band(page, daemon, profile);
  // A human turn the fake holds open until the spec releases it: the resident is busy.
  const reply = page.locator(".console-detail").getByPlaceholder(/^Reply to this session/);
  await reply.fill("E2E_HOLD_TURN_UNTIL_RELEASED while the operator asks for a run");
  await reply.press("Enter");
  await expect.poll(() => live(daemon)?.loop_state).toBe("working");

  await host.getByRole("button", { name: "Run now", exact: true }).click();
  await expect(host.getByLabel("Resident loop status")).toContainText("run queued");
  await expect(host.getByRole("alert")).toHaveCount(0);
  await expect(host.getByRole("button", { name: "Run now", exact: true })).toHaveCount(0);
  const cancel = host.getByRole("button", { name: "Cancel queued run", exact: true });
  await expect(cancel).toBeVisible();
  await expect(cancel).toHaveAccessibleDescription("Drop the queued iteration; the resident keeps its normal cadence");
  await capture(page, "run-now-queued");

  await cancel.click();
  await expect(host.getByRole("button", { name: "Run now", exact: true })).toBeVisible();
  await expect(host.getByLabel("Resident loop status")).not.toContainText("run queued");
  expect(live(daemon)?.run_requested_at).toBeNull();

  await host.getByRole("button", { name: "Run now", exact: true }).click();
  await expect(host.getByLabel("Resident loop status")).toContainText("run queued");
  expect(live(daemon)?.iteration, "nothing runs while the human turn is open").toBe(1);
  writeFileSync(join(daemon.recordDir, "e2e-release-held-turn"), "");
  // The human turn finishes first; the queued iteration then runs once, long before the
  // hour-long cadence would have woken the resident.
  await expect.poll(() => live(daemon)?.iteration, { timeout: 30_000 }).toBe(2);
  await expect(host.getByLabel("Resident loop status")).not.toContainText("run queued");
  await expect(host.getByRole("button", { name: "Run now", exact: true })).toBeVisible();
  expect(live(daemon)?.run_requested_at).toBeNull();
  await capture(page, "run-now-ran");
});

test("a stalled compaction is interrupted and retried on a backoff instead of leaving the resident stuck", async ({ dashboard: page, daemon }) => {
  const profile = await launch(daemon, "Stalled compaction", { delaySeconds: 1, minDelaySeconds: 1, maxDelaySeconds: 3600, contextThreshold: 10 });
  // Launch turn, a one-second wake, then a `/compact` the CLI never finishes.
  await expect.poll(() => live(daemon)?.wake_reason ?? null, { timeout: 60_000 }).toMatch(/Retrying in 1m \(retry 1 of 3\)/);
  const run = live(daemon)!;
  expect(run.loop_state).toBe("waiting");
  expect(run.pause_reason).toBeNull();
  expect(run.iteration, "a failed compaction is not an iteration").toBe(1);
  // The interrupt closed the CLI's turn, so the session is idle rather than working forever.
  await expect.poll(() => turnInProgress(daemon, run)).toBe(0);

  const host = await band(page, daemon, profile);
  const status = host.getByLabel("Resident loop status");
  await expect(status).toContainText("Compaction made no progress for 2 seconds and was interrupted. Retrying in 1m (retry 1 of 3).");
  await expect(status).not.toContainText("paused");
  await capture(page, "compaction-retry-scheduled");

  // The session is idle, so Run now starts at once rather than queueing - and the compaction
  // it starts stalls again, moving to the next, longer backoff.
  await host.getByRole("button", { name: "Run now", exact: true }).click();
  await expect(status).toContainText("Retrying in 5m (retry 2 of 3).", { timeout: 30_000 });
  await expect(host.getByRole("alert")).toHaveCount(0);
  await expect(status).not.toContainText("run queued");
  await expect.poll(() => turnInProgress(daemon, live(daemon)!)).toBe(0);
  await capture(page, "compaction-retry-backoff");
});
