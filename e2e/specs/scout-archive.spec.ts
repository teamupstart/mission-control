import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { settled } from "../fixtures/settle.ts";

/**
 * A scout's answer, from the prompt that demands it to the archive that outlives it.
 *
 * This is the one layer that can prove the claim, because the claim spans four things no
 * single-layer test sees at once: the daemon composes a report requirement into a real
 * dispatch's first prompt, a real agent process reads it and calls the real MCP submission
 * route, the daemon captures real files into a real bundle, and the completion the operator
 * clicks waits for that bundle to exist and verify.
 *
 * Nothing is stubbed on the browser side and nothing inside the daemon. The ONE substitution
 * is the model: `MISSION_CLAUDE_BIN` points at a fake that, on seeing the scout contract in
 * its prompt, writes a static page into its own checkout and POSTs to `/mcp/scouts/submit`
 * with the harness token. No model API is reached and no tokens are spent - see
 * `e2e/fixtures/fake-claude.mjs`.
 */

const SCOUT_TASK = "find out why a resumed agent lost repository permissions";
/** Visible text that exists ONLY inside the report the fake writes. */
const FINDING = "the resume path never replayed the repository grant";
/** Turns the fake into a scout that writes its page and deliberately never submits it. */
const NO_SUBMIT = "E2E_SCOUT_NO_SUBMIT";
/** Turns the fake into a scout whose page the daemon must refuse. */
const INVALID = "E2E_SCOUT_INVALID_REPORT";

interface ScoutArchiveRow {
  key: string;
  status: string;
  title: string;
  summary: string | null;
  captureStatus: string | null;
  artifactCount: number;
  hasPrimaryReport: boolean;
  missingCount: number;
}

/** One bounded page of the library, straight off the daemon's own API. */
async function archives(daemon: DaemonHandle, query = ""): Promise<ScoutArchiveRow[]> {
  const res = await fetch(`${daemon.baseURL}/api/scouts${query}`);
  if (!res.ok) throw new Error(`GET /api/scouts -> ${res.status}`);
  return ((await res.json()) as { archives: ScoutArchiveRow[] }).archives;
}

/** Switch the shipped skills off, so the scout contract is provably not coming from one. */
async function disableSkills(daemon: DaemonHandle): Promise<void> {
  const res = await fetch(`${daemon.baseURL}/api/skills/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  expect(res.ok, "the skills panel should accept being switched off").toBeTruthy();
  const view = (await res.json()) as { enabled: boolean; skills: Array<{ id: string; enabled: boolean }> };
  expect(view.enabled, "skills are globally off for this daemon").toBe(false);
  expect(
    view.skills.find((skill) => skill.id === "html-report")?.enabled ?? false,
    "and the HTML Report skill in particular is not what asks for the page",
  ).toBe(false);
}

async function dispatchScout(page: Page, daemon: DaemonHandle, task: string): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(task);
  await dialog.getByLabel("Kind").selectOption("scout");
  // Choosing scout already defaults this to None; selecting it explicitly keeps the spec
  // independent of the machine's configured Workflow default.
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  const go = dialog.getByRole("button", { name: "Dispatch now" });
  await expect(go).toBeEnabled();
  await go.click();
  await expect(dialog).toBeHidden();
}

/**
 * The card with its conversation open.
 *
 * Expanded rather than read from the card face, because a card shows an ACTIVITY line while
 * a turn runs and drops it when the turn ends - so an assertion on the card would be racing
 * the turn boundary. The conversation is read from the real transcript file by the real SSE
 * stream, and it is where the agent's own account of the submission actually lands.
 */
async function scoutCard(page: Page) {
  const card = page.locator("article.card").first();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Expand conversation" }).click();
  return card;
}

test("a dispatched scout is told to write a report, and archives it, with skills switched off", async ({
  dashboard,
  daemon,
}) => {
  await disableSkills(daemon);
  await dispatchScout(dashboard, daemon, SCOUT_TASK);

  const card = await scoutCard(dashboard);
  // The fake writes the page and submits it only because the DAEMON's prompt told it to -
  // the spec typed nothing but the question. Its answer is the proof the contract arrived.
  await expect(card).toContainText("Submitted the scout report", { timeout: 30_000 });

  // The page really is in the checkout, at the conventional path.
  await expect
    .poll(() => archives(daemon).then((rows) => rows.length), { timeout: 20_000 })
    .toBe(1);
  const [archive] = await archives(daemon);
  expect(archive.status, "a complete archive is ready, not partial").toBe("ready");
  expect(archive.hasPrimaryReport).toBe(true);
  expect(archive.captureStatus).toBe("complete");
  // The report plus the companion the fake wrote beside it. Nothing else from the checkout.
  expect(archive.artifactCount).toBe(2);
  expect(archive.summary ?? "").toContain("Resume rebuilt the session");

  // Searchable by text that exists only inside the report's HTML, which is the whole point
  // of extracting it at index time.
  await expect
    .poll(() => archives(daemon, `?q=${encodeURIComponent(FINDING)}`).then((r) => r.length), {
      timeout: 20_000,
      message: "the report's visible text should be searchable",
    })
    .toBe(1);
  // And by the companion's path, which is metadata rather than page text.
  expect(await archives(daemon, "?q=evidence.csv")).toHaveLength(1);

  // No pull request was expected or opened: a scout ships an answer, not a change.
  await expect(card).not.toContainText("PR #");
});

test("a scout that has not submitted a report cannot be completed, and keeps its checkout", async ({
  dashboard,
  daemon,
}) => {
  await disableSkills(daemon);
  await dispatchScout(dashboard, daemon, `${NO_SUBMIT} ${SCOUT_TASK}`);

  const card = await scoutCard(dashboard);
  await expect(card).toContainText("deliberately not submitted", { timeout: 30_000 });
  expect(await archives(daemon), "nothing is archived until a scout submits").toHaveLength(0);

  const complete = card.getByRole("button", { name: "Complete" });
  await expect(complete).toBeVisible();
  await settled(complete);
  await complete.click();

  const dialog = dashboard.getByRole("dialog", { name: "Complete task and close session" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Complete & close" }).click();

  // The modal stays open carrying the daemon's own sentence, naming the path and the tool -
  // which is the whole affordance: the operator can see what the agent still owes.
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("docs/reports/<slug>/report.html");
  await expect(dialog).toContainText("submit_scout_artifacts");

  // And nothing was lost to the attempt: the task is still live, on its own worktree, so the
  // agent can still be told to finish the job.
  await dashboard.getByRole("button", { name: "Close" }).first().click();
  await expect(dialog).toBeHidden();
  await expect(card).toContainText("worktrees/");
  await expect(card.getByRole("button", { name: "Complete" })).toBeVisible();
});

test("a report the daemon refuses is reported to the scout and archives nothing", async ({
  dashboard,
  daemon,
}) => {
  await disableSkills(daemon);
  await dispatchScout(dashboard, daemon, `${INVALID} ${SCOUT_TASK}`);

  const card = await scoutCard(dashboard);
  // The refusal reaches the AGENT, in its own conversation, with the reason - which is what
  // lets it correct the page rather than sit there believing it finished.
  await expect(card).toContainText("refused the scout submission", { timeout: 30_000 });
  await expect(card).toContainText("not a static report");
  expect(await archives(daemon), "a refused report publishes no archive at all").toHaveLength(0);
});

test("completing a submitted scout closes it, and the archive survives its task", async ({
  dashboard,
  daemon,
}) => {
  await disableSkills(daemon);
  await dispatchScout(dashboard, daemon, SCOUT_TASK);

  const card = await scoutCard(dashboard);
  await expect(card).toContainText("Submitted the scout report", { timeout: 30_000 });
  await expect.poll(() => archives(daemon).then((r) => r.length), { timeout: 20_000 }).toBe(1);
  const [before] = await archives(daemon);

  const complete = card.getByRole("button", { name: "Complete" });
  await expect(complete).toBeVisible();
  await settled(complete);
  await complete.click();
  const dialog = dashboard.getByRole("dialog", { name: "Complete task and close session" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Complete & close" }).click();
  // The archive already exists, so this is a cheap replay rather than a capture - the modal
  // closes on the daemon's answer rather than hanging on one.
  await expect(dialog).toBeHidden({ timeout: 10_000 });

  // Stop tracking the task entirely - the row, its worktree, and its session all go.
  const removed = await fetch(`${daemon.baseURL}/api/tasks/${await taskId(daemon)}`, {
    method: "DELETE",
  });
  expect(removed.ok, await removed.text()).toBeTruthy();

  // The answer is still here, still readable, still complete. That is the whole feature.
  const [after] = await archives(daemon);
  expect(after.key).toBe(before.key);
  expect(after.status).toBe("ready");
  const detail = await fetch(`${daemon.baseURL}/api/scouts/${encodeURIComponent(after.key)}`);
  expect(detail.ok).toBeTruthy();
  const body = (await detail.json()) as { bundlePath: string; artifacts: Array<{ id: string }> };
  expect(existsSync(join(body.bundlePath, "report", "report.html"))).toBe(true);
  expect(existsSync(join(body.bundlePath, "manifest.json"))).toBe(true);

  // And the report's bytes are served through the archive's own route, by generated id.
  const report = await fetch(
    `${daemon.baseURL}/api/scouts/${encodeURIComponent(after.key)}/artifacts/report`,
  );
  expect(report.ok).toBeTruthy();
  expect(await report.text()).toContain(FINDING);
});

test("reclaiming an unarchived scout keeps the page it had already written", async ({
  dashboard,
  daemon,
}) => {
  await disableSkills(daemon);
  await dispatchScout(dashboard, daemon, `${NO_SUBMIT} ${SCOUT_TASK}`);

  const card = await scoutCard(dashboard);
  await expect(card).toContainText("deliberately not submitted", { timeout: 30_000 });
  expect(await archives(daemon)).toHaveLength(0);

  // Cancel tears the worktree down, which is where an unsubmitted report would be lost. The
  // guard publishes it first, so a scout that did the work but never handed it over still
  // leaves its answer behind.
  const id = await taskId(daemon);
  const cancelled = await fetch(`${daemon.baseURL}/api/tasks/${id}/cancel`, { method: "POST" });
  expect(cancelled.ok, await cancelled.text()).toBeTruthy();

  await expect.poll(() => archives(daemon).then((r) => r.length), { timeout: 20_000 }).toBe(1);
  const [recovered] = await archives(daemon);
  expect(recovered.status, "the report was found and captured, so this is complete").toBe("ready");
  expect(recovered.hasPrimaryReport).toBe(true);
});

/** The one task this daemon has. Read from the API rather than guessed from the DOM. */
async function taskId(daemon: DaemonHandle): Promise<string> {
  const res = await fetch(`${daemon.baseURL}/api/tasks`);
  const tasks = (await res.json()) as Array<{ id: string; kind: string }>;
  const scout = tasks.find((task) => task.kind === "scout");
  if (!scout) throw new Error(`no scout task on this daemon: ${JSON.stringify(tasks)}`);
  return scout.id;
}
