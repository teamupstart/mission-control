import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { ResidentProfile } from "../../src/shared/residents.ts";

/**
 * Issue #1324: a resident asked two `request_input` questions, both were answered, and the
 * dashboard went on showing "Waiting on you: needs-you · Answered in the session, not here"
 * with nothing to answer, while `schedule_next_iteration` refused every call with
 * "Nothing was recorded: needs-you".
 *
 * The loop pauses a resident while its session needs you, and nothing lifted that pause once
 * the question was answered. These specs drive the real built daemon: two back-to-back questions
 * posted on the `request_input` HTTP channel and answered on two different surfaces (the
 * attention inbox, then the session's review card), an ask its card could not carry, which is
 * refused before it reaches the dashboard, and a hold left behind by an older daemon, restored
 * on restart.
 */

const QUESTION = [
  "Which rollout should the resident take for the nightly migration?",
  "",
  "- The staging copy finished cleanly last night.",
  "- Production holds three times the rows and a hot index.",
  "- The on-call rotation changes at 18:00.",
].join("\n");

/** The issue's shape: four detailed options, the first recommended, and Other allowed. */
const ASK = {
  kind: "input",
  title: QUESTION,
  body: QUESTION,
  decisions: [{
    id: "q",
    question: QUESTION,
    options: [
      { id: "o0", label: "Run it tonight", detail: "Same window as staging.", recommended: true },
      { id: "o1", label: "Split by tenant", detail: "Smaller batches across the week." },
      { id: "o2", label: "Wait for on-call", detail: "Start after the rotation changes." },
      { id: "o3", label: "Skip this cycle", detail: "Re-plan next iteration." },
    ],
    allowOther: true,
  }],
};

async function request<T>(daemon: DaemonHandle, path: string, body?: unknown, method = "POST"): Promise<T> {
  const response = await fetch(daemon.baseURL + path, body === undefined && method === "GET" ? {} : {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}
type Run = { id: string; loop_state: string; pause_reason: string | null; next_wake_at: number | null };
function live(daemon: DaemonHandle): Run | undefined {
  return withDaemonDb(daemon, db => db.prepare("SELECT * FROM resident_runs WHERE ended_at IS NULL AND launch_state = 'launched'").get() as Run | undefined);
}
async function launch(daemon: DaemonHandle, name: string): Promise<ResidentProfile> {
  const personas = await request<Array<{ id: string; name: string }>>(daemon, "/api/personas", undefined, "GET");
  const profile = await request<ResidentProfile>(daemon, "/api/residents/profiles", { settings: {
    identity: { name }, persona: { personaId: personas.find(p => p.name === "Code Risk Reviewer")!.id },
    workspace: { defaultRepoRoot: daemon.repo },
    execution: { model: "claude-fable-5" }, // The fake records measured context for this catalog model.
    // A long cadence keeps the resident waiting between steps instead of iterating under the test.
    loop: { delaySeconds: 3600, minDelaySeconds: 60, maxDelaySeconds: 3600 },
  } });
  await request(daemon, `/api/residents/profiles/${profile.id}/launch`, { repoRoot: daemon.repo, requestId: `launch-${name.toLowerCase().replace(/\W+/g, "-")}` });
  await expect.poll(() => live(daemon)?.loop_state, { timeout: 60_000 }).toBe("waiting");
  return profile;
}
async function openBand(page: Page, daemon: DaemonHandle, profile: ResidentProfile) {
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await page.getByRole("button", { name: "Residents - 1 live", exact: true }).click();
  const dock = page.getByRole("dialog", { name: "Residents", exact: true });
  await dock.getByRole("button", { name: `Open ${profile.name}` }).click();
  const band = page.getByRole("group", { name: `Resident ${profile.name}` });
  await expect(band).toBeVisible();
  return band;
}
async function capture(page: Page, name: string) {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  const dir = artifactsDir("residents-needs-you"); mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}${name}.png` });
}

/** Stand in for the resident calling the bundled request_input tool, on the exact channel it uses. */
async function askResident(daemon: DaemonHandle, ask: Record<string, unknown>): Promise<Response> {
  const sessions = await request<Array<{ cwd: string | null; task?: { kind?: string } }>>(daemon, "/api/sessions", undefined, "GET");
  const cwd = sessions.find(s => s.task?.kind === "resident")?.cwd;
  expect(cwd, "the resident session has a workspace to bind the question to").toBeTruthy();
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  return fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST", headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({ env: {}, cwd, ...ask }),
  });
}

/** The issue's second call: another detailed choice, asked straight after the first answer. */
const FOLLOW_UP = {
  ...ASK,
  title: "Which tenants go first?",
  body: "Which tenants go first?\n\n- Small tenants finish fastest.\n- The largest tenant has the hot index.",
  decisions: [{
    id: "q",
    question: "Which tenants go first?\n\n- Small tenants finish fastest.\n- The largest tenant has the hot index.",
    options: [
      { id: "o0", label: "Smallest first", detail: "Build confidence before the big one.", recommended: true },
      { id: "o1", label: "Largest first", detail: "Get the risky one done while staffed." },
      { id: "o2", label: "Alphabetical", detail: "No judgement, just order." },
      { id: "o3", label: "Ask on-call", detail: "Let the rotation decide." },
    ],
    allowOther: true,
  }],
};

test("two back-to-back questions answered on two different surfaces resume the loop with no needs-you card", async ({ dashboard: page, daemon }) => {
  const profile = await launch(daemon, "Migration watcher");
  await page.goto(`${daemon.baseURL}/#/fleet`);

  // First question, answered from the attention inbox rather than the session.
  const first = await askResident(daemon, ASK);
  expect(first.status, await first.clone().text()).toBe(200);
  await expect.poll(() => live(daemon)?.pause_reason).toBe("needs-you");
  await page.locator("button.pulse-seg", { hasText: "to answer" }).click();
  const inbox = page.getByRole("dialog", { name: "Attention inbox" });
  // While it is open, the inbox offers the question itself, never the loop's hold.
  await expect(inbox.getByRole("radio", { name: /Split by tenant/ })).toBeVisible();
  await expect(inbox).not.toContainText("Waiting on you: needs-you");
  await capture(page, "question-in-inbox");
  await inbox.getByRole("radio", { name: /Split by tenant/ }).check();
  await inbox.getByRole("button", { name: "Submit" }).click();
  await expect(inbox.getByRole("radio", { name: /Split by tenant/ })).toHaveCount(0);
  await expect(inbox).not.toContainText("Waiting on you: needs-you");
  await page.keyboard.press("Escape");

  // Second question straight after, answered on the session's own review card.
  const second = await askResident(daemon, FOLLOW_UP);
  expect(second.status, await second.clone().text()).toBe(200);
  await expect.poll(() => live(daemon)?.pause_reason).toBe("needs-you");
  const band = await openBand(page, daemon, profile);
  await page.locator(".console-detail").getByRole("button", { name: /to review/ }).click();
  const modal = page.locator(".review-modal");
  await expect(modal.getByRole("radio", { name: /Largest first/ })).toBeVisible();
  await capture(page, "question-card");
  await modal.getByRole("radio", { name: /Largest first/ }).check();
  await modal.getByRole("button", { name: "Submit" }).click();
  await expect(modal).toBeHidden();

  // The hold lifts by itself: the loop is back on its cadence, with nothing left to resume.
  await expect.poll(() => live(daemon)?.loop_state).toBe("waiting");
  expect(live(daemon)?.pause_reason).toBeNull();
  await expect(band).toContainText("next in");
  await expect(band).not.toContainText("needs-you");
  await expect(page.locator("button.pulse-seg", { hasText: "to answer" })).toHaveCount(0);
  await expect(page.getByText("Waiting on you: needs-you")).toHaveCount(0);
  await capture(page, "answered-resumed");
});

test("a question its card could not carry is refused and never reaches the dashboard", async ({ dashboard: page, daemon }) => {
  const profile = await launch(daemon, "Ambiguous ask");
  const refused = await askResident(daemon, { ...ASK, decisions: [{ ...ASK.decisions[0], options: [
    { id: "o0", label: "Run it tonight" }, { id: "o1", label: "run it tonight " },
  ] }] });
  expect(refused.status).toBe(400);
  expect(await refused.text()).toContain("cannot be answered on its card");
  const band = await openBand(page, daemon, profile);
  await expect(band).toContainText("next in");
  await expect(page.locator(".console-detail").getByRole("button", { name: /to review/ })).toHaveCount(0);
  await expect(page.locator("button.pulse-seg", { hasText: "to answer" })).toHaveCount(0);
  expect(live(daemon)?.loop_state).toBe("waiting");
});

test("a needs-you hold an older daemon left behind clears on restart, with no card to answer", async ({ dashboard: page, daemon }) => {
  const profile = await launch(daemon, "Stale hold");
  // The state issue #1324 left on disk: paused for needs-you, with the question long answered.
  await daemon.crash();
  withDaemonDb(daemon, db => db.prepare("UPDATE resident_runs SET loop_state = 'paused', pause_reason = 'needs-you', next_wake_at = NULL WHERE ended_at IS NULL").run());
  await daemon.restart();
  await expect.poll(() => live(daemon)?.loop_state, { timeout: 30_000 }).toBe("waiting");
  expect(live(daemon)?.pause_reason).toBeNull();

  const band = await openBand(page, daemon, profile);
  await expect(band).toContainText("next in");
  await expect(band).not.toContainText("needs-you");
  await expect(page.locator("button.pulse-seg", { hasText: "to answer" })).toHaveCount(0);
  await expect(page.getByText("Waiting on you: needs-you")).toHaveCount(0);
  await capture(page, "stale-hold-healed");
});
