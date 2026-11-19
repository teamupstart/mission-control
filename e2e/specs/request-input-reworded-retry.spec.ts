import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { PARALLEL_ASK_WINDOW_MS } from "../../src/server/reviews.ts";
import type { ResidentProfile } from "../../src/shared/residents.ts";

/**
 * What is at stake (issue #1527): an agent's MCP client gives up on a blocking `request_input`
 * call after five minutes, and the model reissues the same decision in new words. The operator
 * used to see both cards and answer the same decision twice. Now the newer ask withdraws the
 * older one, so the queue holds exactly the card the agent is waiting on.
 *
 * Real daemon, real routes, real SSE and the real built dashboard. Both asks are posted through
 * the `/mcp/reviews` route the MCP `request_input` tool posts to, with its `snoozable` flag, and
 * the abandoned call is the tool's own `/wait` long poll, left running the way a client that
 * never sends a cancellation leaves it.
 */

const EVIDENCE = artifactsDir("request-input-reworded-retry");

async function capture(target: Locator, name: string, page: Page): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await target.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/request-input-reworded-retry/${name}.png`);
}

const token = (daemon: DaemonHandle) => readFileSync(join(daemon.home, "token"), "utf8").trim();

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("plan the release");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row")).toHaveCount(1);
}

type SessionRow = { cwd: string | null; pendingReviews: number; task?: { kind?: string } };
const sessionsOf = async (daemon: DaemonHandle) =>
  await (await fetch(`${daemon.baseURL}/api/sessions`)).json() as SessionRow[];

/**
 * Ask the way `request_input` does, on the session's own channel. `resident` picks the
 * resident's session, as `residents-needs-you.spec.ts` does; otherwise the dispatched one.
 */
async function ask(daemon: DaemonHandle, question: string, labels: string[], resident = false): Promise<string> {
  const sessions = await sessionsOf(daemon);
  const session = resident ? sessions.find((s) => s.task?.kind === "resident") : sessions[0];
  expect(session?.cwd, "the asking session has a workspace to bind the question to").toBeTruthy();
  const res = await fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({
      env: {},
      cwd: session!.cwd,
      kind: "input",
      title: question,
      body: question,
      snoozable: true,
      decisions: [{ id: "q", question, options: labels.map((label, i) => ({ id: `o${i}`, label })) }],
    }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json() as { id: string }).id;
}

/** The abandoned call's MCP child, long-polling until the review leaves `pending`. */
async function abandonedWait(daemon: DaemonHandle, id: string): Promise<{ status: string; resolvedBy: string | null }> {
  for (;;) {
    const res = await fetch(`${daemon.baseURL}/mcp/reviews/${id}/wait`, {
      headers: { "x-harness-token": token(daemon) },
    });
    expect(res.status).toBe(200);
    const review = await res.json() as { status: string; resolvedBy: string | null };
    if (review.status !== "pending") return review;
  }
}

async function openInbox(page: Page): Promise<Locator> {
  const inbox = page.getByRole("dialog", { name: "Attention inbox" });
  const button = page.locator("button.pulse-seg", { hasText: "to answer" });
  await expect(async () => {
    if (!(await inbox.isVisible())) await button.click({ timeout: 3000 });
    await expect(inbox).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 45_000 });
  await expectContentClearsBorder(inbox);
  return inbox;
}

const FIRST =
  "Approve this rollout and release authority before I create the four drafted tasks? Phase 1 " +
  "migrates workspace access, phases 2 and 3 run in parallel, and I merge each PR after checks pass.";
const RETRY =
  "The previous prompt timed out. May I proceed with the four drafted tasks and merge each PR " +
  "after checks pass? Phase 1 migrates workspace access, then phases 2 and 3 run in parallel.";
const OTHER = "Which linter should this repository use?";
/** A retry collapses only when it offers the same choices; only the question is reworded. */
const CHOICES = ["Approve parallel rollout and merges", "Schedule only; hold merges"];

test("a reworded retry replaces the timed-out card, while a different later question keeps its own", async ({ dashboard, daemon }) => {
  test.setTimeout(PARALLEL_ASK_WINDOW_MS + 120_000);
  await dispatch(dashboard, daemon);

  const first = await ask(daemon, FIRST, CHOICES);
  const abandoned = abandonedWait(daemon, first);
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const pulse = dashboard.locator("button.pulse-seg", { hasText: "to answer" }).locator(".pulse-n");
  await expect(pulse).toHaveText("1");

  // The client's timeout. Parallel calls arrive inside the window and are always kept, so
  // everything below lands after it.
  await dashboard.waitForTimeout(PARALLEL_ASK_WINDOW_MS + 1_000);

  // A different question from the same agent withdraws nothing: the operator still owes both.
  await ask(daemon, OTHER, ["biome", "eslint"]);
  await expect(pulse).toHaveText("2");

  // The model's reworded retry of the first question replaces it, and only it.
  await ask(daemon, RETRY, CHOICES);

  // The abandoned call is released with the withdrawal, which is nobody's answer.
  expect(await abandoned).toMatchObject({ status: "superseded", resolvedBy: null });

  await expect(pulse).toHaveText("2");
  const inbox = await openInbox(dashboard);
  await expect(inbox.getByText(RETRY).first()).toBeVisible();
  await expect(inbox.getByText(OTHER).first()).toBeVisible();
  await expect(inbox.getByText(FIRST)).toHaveCount(0);
  // One card offers the choices now: the retry's, not a second copy from the original.
  await expect(inbox.getByRole("radio", { name: "Approve parallel rollout and merges" })).toHaveCount(1);
  await capture(inbox, "inbox-retry-replaced-other-kept-r7", dashboard);

  const retryCard = inbox.locator("section", { has: dashboard.getByRole("radio", { name: /Approve parallel rollout/ }) }).last();
  await retryCard.getByRole("radio", { name: /Approve parallel rollout/ }).check();
  await retryCard.getByRole("button", { name: /^Submit/ }).click();
  await expect(pulse).toHaveText("1");
  await expect(inbox.getByText(OTHER).first()).toBeVisible();
  await expect(inbox.getByText(RETRY)).toHaveCount(0);
  // Answering the retry settled the decision once; the unrelated question is still owed.
  await capture(inbox, "inbox-one-card-r7", dashboard);
});

test("questions asked together in one batch both stay on screen", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon);
  await ask(daemon, "Which linter should this repo use?", ["biome", "eslint"]);
  await ask(daemon, "Which formatter should this repo use?", ["prettier", "dprint"]);
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  await expect(dashboard.locator("button.pulse-seg", { hasText: "to answer" }).locator(".pulse-n")).toHaveText("2");
  const inbox = await openInbox(dashboard);
  await expect(inbox.getByText("Which linter should this repo use?").first()).toBeVisible();
  await expect(inbox.getByText("Which formatter should this repo use?").first()).toBeVisible();
});

/** A real resident, launched on a long cadence so it waits between steps instead of iterating. */
async function launchResident(daemon: DaemonHandle, name: string): Promise<ResidentProfile> {
  const call = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(daemon.baseURL + path, body === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<T>;
  };
  const personas = await call<Array<{ id: string; name: string }>>("/api/personas");
  const profile = await call<ResidentProfile>("/api/residents/profiles", { settings: {
    identity: { name }, persona: { personaId: personas.find((p) => p.name === "Code Risk Reviewer")!.id },
    workspace: { defaultRepoRoot: daemon.repo },
    execution: { model: "claude-fable-5" },
    loop: { delaySeconds: 3600, minDelaySeconds: 60, maxDelaySeconds: 3600 },
  } });
  await call(`/api/residents/profiles/${profile.id}/launch`, { repoRoot: daemon.repo, requestId: "launch-retry-resident" });
  await expect.poll(() => withDaemonDb(daemon, (db) =>
    (db.prepare("SELECT loop_state FROM resident_runs WHERE ended_at IS NULL AND launch_state = 'launched'").get() as
      { loop_state: string } | undefined)?.loop_state), { timeout: 60_000 }).toBe("waiting");
  return profile;
}

test("a resident's reworded retry replaces its timed-out card the same way", async ({ dashboard, daemon }) => {
  test.setTimeout(PARALLEL_ASK_WINDOW_MS + 150_000);
  await launchResident(daemon, "Release planner");
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  const residentPending = async () => (await sessionsOf(daemon)).find((s) => s.task?.kind === "resident")?.pendingReviews;

  const first = await ask(daemon, FIRST, CHOICES, true);
  const abandoned = abandonedWait(daemon, first);
  await expect.poll(residentPending).toBe(1);

  await dashboard.waitForTimeout(PARALLEL_ASK_WINDOW_MS + 1_000);
  await ask(daemon, OTHER, ["biome", "eslint"], true);
  await expect.poll(residentPending).toBe(2);
  await ask(daemon, RETRY, CHOICES, true);

  expect(await abandoned).toMatchObject({ status: "superseded", resolvedBy: null });
  await expect.poll(residentPending).toBe(2);
  const inbox = await openInbox(dashboard);
  await expect(inbox.getByText(RETRY).first()).toBeVisible();
  await expect(inbox.getByText(OTHER).first()).toBeVisible();
  await expect(inbox.getByText(FIRST)).toHaveCount(0);
  await capture(inbox, "resident-inbox-retry-replaced-other-kept-r7", dashboard);
});
