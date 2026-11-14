import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { ResidentProfile } from "../../src/shared/residents.ts";

// A resident keeps its mission through a compaction. The daemon sends `/compact` with a focus
// that asks the summary to keep the standing task, and the first wake after it restates that
// task in full, in the conversation the operator reads. The fake CLI answers `/compact` with
// the real CLI's boundary frame, so the measured compaction, the wake and the turn are real.

const PROFILE_BRIEF = "Unblock stuck work on the release branch, and never merge a pull request yourself.";
const RUN_BRIEF = "Watch the release train today.";

async function request<T>(daemon: DaemonHandle, path: string, body?: unknown, method = "POST"): Promise<T> {
  const response = await fetch(daemon.baseURL + path, body === undefined && method === "GET" ? {} : {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}
type Run = { id: string; iteration: number; loop_state: string; compaction_epoch: number; reanchored_epoch: number };
function live(daemon: DaemonHandle): Run | undefined {
  return withDaemonDb(daemon, db => db.prepare("SELECT * FROM resident_runs WHERE ended_at IS NULL AND launch_state = 'launched'").get() as Run | undefined);
}
async function launch(daemon: DaemonHandle, name: string): Promise<ResidentProfile> {
  const personas = await request<Array<{ id: string; name: string }>>(daemon, "/api/personas", undefined, "GET");
  const profile = await request<ResidentProfile>(daemon, "/api/residents/profiles", { settings: {
    identity: { name }, persona: { personaId: personas.find(p => p.name === "Code Risk Reviewer")!.id },
    instructions: { markdown: PROFILE_BRIEF },
    workspace: { defaultRepoRoot: daemon.repo },
    execution: { model: "claude-fable-5" }, // The fake measures 18% context for this catalog model.
    // Above the 10% threshold after the launch turn, so Run now compacts before it wakes.
    loop: { delaySeconds: 3600, minDelaySeconds: 1, maxDelaySeconds: 3600, contextThreshold: 10 },
  } });
  await request(daemon, `/api/residents/profiles/${profile.id}/launch`, { repoRoot: daemon.repo, instructions: RUN_BRIEF, requestId: `launch-${profile.id}` });
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
  const dir = artifactsDir("residents-compaction-restatement"); mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}${name}.png` });
}

test("after a compaction, the resident's next wake restates its standing task in the conversation", async ({ dashboard: page, daemon }) => {
  const profile = await launch(daemon, "Release shepherd");
  await expect.poll(() => live(daemon)?.loop_state, { timeout: 60_000 }).toBe("waiting");
  expect(live(daemon)?.iteration).toBe(1);
  const host = await band(page, daemon, profile);
  const conversation = page.locator(".console-detail");
  const wakes = conversation.getByRole("article", { name: "resident", exact: true });
  await expect(wakes).toHaveCount(0);

  await host.getByRole("button", { name: "Run now", exact: true }).click();
  await expect.poll(() => live(daemon)?.iteration, { timeout: 30_000 }).toBe(2);
  const compactions = readFileSync(join(daemon.recordDir, "claude-compactions.jsonl"), "utf8").trim().split("\n")
    .map(line => (JSON.parse(line) as { prompt: string }).prompt);
  expect(compactions, "the conversation was compacted before this wake").toHaveLength(1);

  // The wake the operator reads, and the first thing the resident acts on after the summary.
  // Captured before any assertion on it, so a run against code without the fix records what
  // that resident was handed instead: the loop prompt alone, naming no mission.
  await expect(wakes).toHaveCount(1);
  const wake = wakes.first();
  await wake.scrollIntoViewIfNeeded();
  await capture(page, "wake-after-compaction");

  // The restated role, then the loop prompt, never the marker.
  await expect(wake.getByRole("heading", { name: "Your standing task, restated after compaction" })).toBeVisible();
  await expect(wake).toContainText("Its summary records what you were doing, not what you are for");
  await expect(wake).toContainText("Resident role: Code Risk Reviewer");
  await expect(wake).toContainText(PROFILE_BRIEF);
  await expect(wake).toContainText(RUN_BRIEF);
  await expect(wake).toContainText("Continue your standing task. Check what has changed since your last iteration");
  await expect(wake).not.toContainText("[mission-resident:");
  await wake.getByRole("heading", { name: "Your standing task, restated after compaction" }).scrollIntoViewIfNeeded();
  await capture(page, "restated-wake-opening");
  await wake.getByText(PROFILE_BRIEF).scrollIntoViewIfNeeded();
  await capture(page, "restated-wake-profile-and-run");

  // What the daemon asked the summary to keep, as the CLI received it.
  expect(compactions[0]).toMatch(/^\/compact This is a long-running resident whose standing task is defined in its standing instructions\./);
  expect(compactions[0]).toContain("every instruction, correction or decision the operator gave in this conversation verbatim");

  // Delivered and confirmed, so this compaction owes nothing more.
  const run = live(daemon)!;
  expect(run.compaction_epoch, "one compaction, recorded once, from the driver's boundary").toBe(1);
  expect(run.reanchored_epoch).toBe(run.compaction_epoch);
});

test("the profile editor says what Compaction focus adds to, and what follows every compaction", async ({ dashboard: page, daemon }) => {
  await page.goto(`${daemon.baseURL}/#/residents`);
  await page.getByRole("complementary", { name: "Resident profiles" }).getByRole("button", { name: "New" }).click();
  const editor = page.getByRole("region", { name: "New resident profile" });
  const guardrails = editor.getByRole("region", { name: "Loop and guardrails" });
  const focus = guardrails.getByLabel("Compaction focus", { exact: true });
  await expect(focus).toHaveValue("");
  await expect(focus).toHaveAccessibleDescription(
    "Added to the built-in focus, which asks the summary to keep the standing task and your instructions word for word. " +
    "Claude Code uses it; Codex compacts without one. After any compaction, the next wake restates the standing task in full.",
  );
  await expect(guardrails.getByText("After any compaction, the next wake restates the standing task in full.", { exact: false })).toBeVisible();
  await focus.scrollIntoViewIfNeeded();
  await capture(page, "compaction-focus-hint");
});
