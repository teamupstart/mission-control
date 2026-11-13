import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { settled } from "../fixtures/settle.ts";

/**
 * The conversation half of background sub-agent visibility, end to end: a dispatched fake
 * Claude launches three background agents through the real Agent SDK stream and ends its turn
 * with them running. The daemon reduces the frames into the session's summary, `session_upsert`
 * carries it, and the open conversation docks a Background agents tray above its reply box.
 *
 * `E2E_SPLIT_BACKGROUND_AGENTS` writes the launch the way the real CLI does - one transcript
 * record per tool call - so the launching turns fold into one tool row whose own id is a
 * different turn's. "Jump to launch" has to land there anyway, which is the case that broke
 * before this phase. A long prose turn follows the launch, so it starts above the fold.
 *
 * A resident is an ordinary Agent SDK session in the same panel, so the last test launches one
 * and checks that its conversation gets the tray too. No model is spent.
 */

const EVIDENCE = artifactsDir("conversation-background-agents");

const SPLIT_GOAL = "E2E_SPLIT_BACKGROUND_AGENTS move the ledger to cursor pagination";
const PLAIN_GOAL = "settle without background agents";
const DISTANT_GOAL = "E2E_DISTANT_BACKGROUND_AGENTS trace the distant ledger";
const FOLDED_TWIN_GOAL = "E2E_FOLDED_TWIN_BACKGROUND_AGENTS sweep the ledger twice";
const DEEP_GOAL = "E2E_DEEP_BACKGROUND_AGENTS trace the deep ledger";

async function shoot(page: Page, target: Locator, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: a resting pointer portals a tooltip over what is photographed.
  await page.mouse.move(0, 0);
  await target.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/conversation-background-agents/${name}.png`);
}

async function dispatch(page: Page, daemon: DaemonHandle, goal: string): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(goal);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  const row = page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").filter({ hasText: goal });
  await expect(row.locator(".rail-state")).toHaveText("idle", { timeout: 60_000 });
}

/** Select a session in the Console and wait for its conversation to settle. */
async function openSession(page: Page, goal: string): Promise<Locator> {
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").filter({ hasText: goal }).click();
  const detail = page.locator(".console-detail");
  await settled(detail);
  await expect(detail.locator(".transcript")).toBeVisible();
  return detail;
}

function row(tray: Locator, description: string): Locator {
  return tray.getByRole("listitem").filter({ hasText: description });
}

test("a conversation docks its background agents above the reply box, and Jump to launch scrolls to the launch", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon, PLAIN_GOAL);
  await dispatch(dashboard, daemon, SPLIT_GOAL);

  // A session without background agents is exactly what it was: no tray.
  const plain = await openSession(dashboard, PLAIN_GOAL);
  await expect(plain.getByRole("region", { name: "Background agents" })).toHaveCount(0);

  const detail = await openSession(dashboard, SPLIT_GOAL);
  const tray = detail.getByRole("region", { name: "Background agents" });
  await expect(tray).toBeVisible();

  // The third agent finishes about a second after the turn ends, so the header settles here.
  const head = tray.getByRole("button", { name: "Background agents · 2 running · 1 done" });
  await expect(head).toBeVisible();
  await expect(head).toHaveAttribute("aria-expanded", "true");
  const agents = tray.getByRole("listitem");
  await expect(agents).toHaveCount(3);
  const mapRow = row(tray, "Map every offset-pagination call site");
  await expect(mapRow).toContainText("Explore");
  await expect(mapRow).toContainText("18 tools · Grep");
  await expect(row(tray, "Convert billing report queries")).toContainText("general-purpose");
  await expect(row(tray, "Convert billing report queries")).toContainText("6 tools · Edit");

  // A finished agent stays listed, marked done and dimmed, until the next turn.
  const doneRow = row(tray, "Find contract tests for /ledger");
  await expect(doneRow).toContainText("done");
  await expect(doneRow).toHaveCSS("opacity", "0.55");
  await expect(mapRow).toHaveCSS("opacity", "1");

  // Foreground, ambient and non-agent work was on the wire and is not in the tray.
  for (const absent of ["Foreground planning", "Housekeeping", "npm run watch"]) {
    await expect(tray).not.toContainText(absent);
  }

  // Docked between the conversation and the reply box, outside both.
  const reply = detail.getByPlaceholder(/^Reply to this session/);
  const log = detail.locator(".transcript-log");
  const trayBox = await tray.boundingBox();
  const replyBox = await reply.boundingBox();
  const logBox = await log.boundingBox();
  expect(trayBox && replyBox && logBox, "tray, reply box and log are laid out").toBeTruthy();
  expect(trayBox!.y + trayBox!.height, "the tray ends above the reply box").toBeLessThanOrEqual(replyBox!.y + 1);
  expect(trayBox!.y, "the tray starts below the log").toBeGreaterThanOrEqual(logBox!.y + logBox!.height - 1);
  await shoot(dashboard, detail, "01-tray-above-composer");

  // The launches were written one record per call, so they fold into one tool row behind a
  // Read. The conversation opened at its tail, a long turn below them, so the row is out of view.
  const launchRun = log.locator(".turn-toolrun");
  await expect(launchRun).toHaveCount(1);
  await expect(launchRun).not.toBeInViewport();

  // The second agent's launch is the third turn folded into that row: it has no element of
  // its own, and the jump still lands on the row that holds it, and flashes it.
  await row(tray, "Convert billing report queries").getByRole("button", { name: "Jump to launch" }).click();
  await expect(launchRun).toBeInViewport();
  await expect(launchRun).toHaveClass(/is-flashed/);
  // The tray did not move: it is not part of the log that scrolled.
  await expect(tray).toBeInViewport();
  await shoot(dashboard, detail, "02-jumped-to-launch");

  // Back to the tail, then the finished agent's link: it lands on the same row.
  await log.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(launchRun).not.toBeInViewport();
  await doneRow.getByRole("button", { name: "Jump to launch" }).click();
  await expect(launchRun).toBeInViewport();

  // The header folds the list and opens it again.
  await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "false");
  await expect(agents).toHaveCount(0);
  await head.click();
  await expect(agents).toHaveCount(3);

  // The terminal rendering docks the same tray inside its frame, and the jump lands on its
  // tool record.
  const toggle = detail.getByRole("button", { name: "Conversation view" });
  await toggle.click();
  await dashboard.getByRole("menuitemradio", { name: "Terminal" }).click();
  await expect(toggle).toHaveAttribute("aria-label", "Conversation view: Terminal");
  const frame = detail.getByRole("region", { name: "Conversation terminal" });
  await expect(frame.getByRole("region", { name: "Background agents" })).toBeVisible();
  const terminalLog = frame.locator(".transcript-log");
  const terminalRun = terminalLog.locator(".pty-toolrun");
  await expect(terminalRun).toHaveCount(1);
  await terminalLog.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(terminalRun).not.toBeInViewport();
  await row(frame.getByRole("region", { name: "Background agents" }), "Map every offset-pagination call site")
    .getByRole("button", { name: "Jump to launch" })
    .click();
  await expect(terminalRun).toBeInViewport();
  await expect(terminalRun).toHaveClass(/is-flashed/);
  await shoot(dashboard, detail, "03-terminal-view-jumped");
  await toggle.click();
  await dashboard.getByRole("menuitemradio", { name: "Chat" }).click();
  await expect(toggle).toHaveAttribute("aria-label", "Conversation view: Chat");

  // The operator's next turn folds the finished agent into a count.
  await expect(reply).toBeEnabled();
  await reply.fill("fold the finished agent");
  await reply.press("Enter");
  await expect(detail.getByText("Mock reply to: fold the finished agent")).toBeVisible();
  await expect(tray.getByRole("button", { name: "Background agents · 2 running" })).toBeVisible();
  await expect(row(tray, "Find contract tests for /ledger")).toHaveCount(0);
  await expect(tray.getByText("1 finished")).toBeVisible();
  await shoot(dashboard, detail, "04-finished-folded");
});

test("a resident's conversation shows its background agents too", async ({ dashboard, daemon }) => {
  // A resident authored and launched exactly as residents-launch.spec.ts does it.
  await dashboard.goto(`${daemon.baseURL}/#/residents`);
  const rail = dashboard.getByRole("complementary", { name: "Resident profiles" });
  await rail.getByRole("button", { name: "New" }).click();
  const editor = dashboard.getByRole("region", { name: "New resident profile" });
  await editor.getByLabel("Name").fill("Ledger Keeper");
  await editor.getByRole("combobox", { name: "Persona" }).selectOption({ label: "Code Risk Reviewer · built-in" });
  await editor.getByLabel("Default repository").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await editor.getByRole("button", { name: "Save" }).click();
  const profile = dashboard.getByRole("region", { name: "Resident profile Ledger Keeper" });
  await expect(profile).toContainText("Revision 1");
  await profile.getByRole("button", { name: "Launch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog.getByRole("radio", { name: "Resident" })).toHaveAttribute("aria-checked", "true");
  await dialog.getByRole("button", { name: "Cancel" }).focus();
  await dashboard.keyboard.press("Meta+Enter");
  await expect(dialog).toBeHidden({ timeout: 60_000 });

  await expect.poll(async () => {
    const tasks = (await (await fetch(`${daemon.baseURL}/api/tasks`)).json()) as Array<{ kind: string; status: string }>;
    return tasks.find((t) => t.kind === "resident")?.status ?? null;
  }, { timeout: 60_000 }).toBe("running");

  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = dashboard.locator(".console-detail");
  await expect(card.getByText("resident", { exact: true })).toBeVisible();
  await settled(card);
  await expect(card.getByRole("region", { name: "Background agents" })).toHaveCount(0);

  // The resident launches background agents on its next turn.
  const reply = card.getByPlaceholder(/^Reply to this session/);
  await expect(reply).toBeEnabled({ timeout: 60_000 });
  await reply.fill("E2E_BACKGROUND_AGENTS launch three for the resident");
  await reply.press("Enter");

  const tray = card.getByRole("region", { name: "Background agents" });
  await expect(tray.getByRole("button", { name: "Background agents · 2 running · 1 done" })).toBeVisible();
  await expect(tray.getByRole("listitem")).toHaveCount(3);
  await expect(row(tray, "Map every offset-pagination call site")).toContainText("18 tools · Grep");

  // This launch is one record with prose and calls together, so it is a turn of its own.
  await row(tray, "Map every offset-pagination call site").getByRole("button", { name: "Jump to launch" }).click();
  const launchTurn = card.locator(".transcript-log .turn").filter({ hasText: "Launching background agents" });
  await expect(launchTurn).toBeInViewport();
  await expect(launchTurn).toHaveClass(/is-flashed/);
  await shoot(dashboard, card, "05-resident-tray");
});

test("Jump to launch pages older messages in to reach a launch the conversation has not loaded, and says when it cannot", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(120_000);
  await dispatch(dashboard, daemon, DISTANT_GOAL);

  // The launch is followed by about 600 KB of later turns, so the conversation opens without it.
  const open = async (): Promise<{ detail: Locator; tray: Locator; log: Locator; launchRun: Locator }> => {
    const detail = await openSession(dashboard, DISTANT_GOAL);
    const tray = detail.getByRole("region", { name: "Background agents" });
    await expect(tray.getByRole("listitem")).toHaveCount(3);
    const log = detail.locator(".transcript-log");
    await expect(log.getByRole("button", { name: "Load older messages" })).toBeVisible();
    const launchRun = log.locator(".turn-toolrun").filter({ hasText: "Trace the distant ledger writes" });
    await expect(launchRun, "the launch is not in the opening window").toHaveCount(0);
    await expect(log.getByText("Launching distant background agents")).toHaveCount(0);
    return { detail, tray, log, launchRun };
  };

  const first = await open();
  // Every agent has the link, including the two whose start frame named no launching call.
  await expect(first.tray.getByRole("button", { name: "Jump to launch" })).toHaveCount(3);
  await shoot(dashboard, first.detail, "06-distant-launch-not-loaded");

  // Named by its call id: the search pages older turns in until the launch arrives, then lands.
  await row(first.tray, "Trace the distant ledger writes").getByRole("button", { name: "Jump to launch" }).click();
  await expect(first.launchRun).toHaveCount(1, { timeout: 30_000 });
  await expect(first.launchRun).toBeInViewport();
  await expect(first.launchRun).toHaveClass(/is-flashed/);
  await expect(row(first.tray, "Trace the distant ledger writes").getByRole("button", { name: "Jump to launch" })).toBeVisible();
  await shoot(dashboard, first.detail, "07-distant-launch-paged-in");

  // A fresh load, so the second search starts from the opening window too. This agent's start
  // frame named no call; its launch is found by its own id, which the launch's tool result
  // recorded against its Agent call.
  await dashboard.reload();
  const second = await open();
  await row(second.tray, "Rewrite the distant export job").getByRole("button", { name: "Jump to launch" }).click();
  await expect(second.launchRun).toHaveCount(1, { timeout: 30_000 });
  await expect(second.launchRun).toBeInViewport();
  await expect(second.launchRun).toHaveClass(/is-flashed/);

  // No call in this transcript launched the third. Its search reads back to the start, and the
  // link then says so, with the reason in its description.
  const orphan = row(second.tray, "Audit an orphaned migration");
  await orphan.getByRole("button", { name: "Jump to launch" }).click();
  const notFound = orphan.getByRole("button", { name: "Launch not in transcript" });
  await expect(notFound).toBeVisible({ timeout: 30_000 });
  await expect(notFound).toHaveAccessibleDescription(/No call in this conversation's transcript is recorded as launching this agent/);
  await expect(second.log.getByRole("button", { name: "Load older messages" }), "the search reached the start").toHaveCount(0);
  await shoot(dashboard, second.detail, "08-launch-not-in-transcript");
});

test("a failed older-page request leaves the link in its retryable error state, and a retry finds the launch", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(120_000);
  await dispatch(dashboard, daemon, DISTANT_GOAL);
  const detail = await openSession(dashboard, DISTANT_GOAL);
  const tray = detail.getByRole("region", { name: "Background agents" });
  await expect(tray.getByRole("listitem")).toHaveCount(3);
  const log = detail.locator(".transcript-log");
  const launchRun = log.locator(".turn-toolrun").filter({ hasText: "Trace the distant ledger writes" });
  await expect(launchRun, "the launch is not in the opening window").toHaveCount(0);

  // Every older-page request fails, as a daemon that cannot read the file answers it.
  let failed = 0;
  const olderPage = /\/api\/sessions\/[^/]+\/transcript\?before=/;
  await dashboard.route(olderPage, async (route) => {
    failed += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "transcript read failed" }) });
  });

  const link = row(tray, "Trace the distant ledger writes").getByRole("button", { name: "Jump to launch" });
  await link.click();
  // The search stops at the failure instead of retrying on its own, and the row says it can be retried.
  await expect(link).toHaveClass(/is-error/);
  await expect(link).toHaveAccessibleDescription(/Couldn't load older messages .* click to try again/);
  expect(failed, "the search asked for an older page").toBeGreaterThan(0);
  const attempts = failed;
  await dashboard.waitForTimeout(500);
  expect(failed, "a failed search does not keep requesting pages").toBe(attempts);
  await expect(launchRun).toHaveCount(0);
  await shoot(dashboard, detail, "09-older-page-failed");

  // The daemon recovers. Clicking the same link starts a new search, which pages in and lands.
  await dashboard.unroute(olderPage);
  await link.click();
  await expect(launchRun).toHaveCount(1, { timeout: 30_000 });
  await expect(launchRun).toBeInViewport();
  await expect(launchRun).toHaveClass(/is-flashed/);
  await expect(link).toHaveClass(/is-ready/);
  await expect(link).toHaveAccessibleDescription("Scroll the conversation to the turn that launched this agent");
  await shoot(dashboard, detail, "10-retry-found-launch");
});

test("agents named by no call id each jump to their own launch, and one launched by no call here is never handed a folded agent's", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon, FOLDED_TWIN_GOAL);
  const detail = await openSession(dashboard, FOLDED_TWIN_GOAL);
  const tray = detail.getByRole("region", { name: "Background agents" });
  // Three agents with one description and type; the newer launched one finishes after a second.
  await expect(tray.getByRole("button", { name: "Background agents · 2 running · 1 done" })).toBeVisible();
  const twins = tray.getByRole("listitem").filter({ hasText: "Sweep the ledger for offsets" });
  await expect(twins).toHaveCount(3);

  // Each launch is a tool row of its own, both reading the same description.
  const log = detail.locator(".transcript-log");
  const launches = log.locator(".turn-toolrun");
  await expect(launches).toHaveCount(2);
  const [olderLaunch, newerLaunch] = [launches.nth(0), launches.nth(1)];

  // The finished agent is listed last (running first). Its link lands on its own, newer call.
  const finished = twins.nth(2);
  await expect(finished).toContainText("done");
  await finished.getByRole("button", { name: "Jump to launch" }).click();
  await expect(newerLaunch).toBeInViewport();
  await expect(newerLaunch).toHaveClass(/is-flashed/);
  await expect(olderLaunch).not.toHaveClass(/is-flashed/);

  // The operator's next turn folds the finished agent out of the tray. Its call stays.
  const reply = detail.getByPlaceholder(/^Reply to this session/);
  await expect(reply).toBeEnabled();
  await reply.fill("fold the finished twin");
  await reply.press("Enter");
  await expect(detail.getByText("Mock reply to: fold the finished twin")).toBeVisible();
  await expect(tray.getByRole("button", { name: "Background agents · 2 running" })).toBeVisible();
  await expect(tray.getByText("1 finished")).toBeVisible();
  await expect(twins).toHaveCount(2);
  await expect(newerLaunch).not.toHaveClass(/is-flashed/, { timeout: 5_000 });

  // The older running agent lands on its own call, by the id its launch recorded.
  await twins.nth(0).getByRole("button", { name: "Jump to launch" }).click();
  await expect(olderLaunch).toBeInViewport();
  await expect(olderLaunch).toHaveClass(/is-flashed/);
  await expect(newerLaunch).not.toHaveClass(/is-flashed/);

  // The third shares the description, but no call here launched it. The folded agent's call is
  // the only other one in the transcript, and it is not claimed: the link says so instead.
  const orphan = twins.nth(1);
  await orphan.getByRole("button", { name: "Jump to launch" }).click();
  const notFound = orphan.getByRole("button", { name: "Launch not in transcript" });
  await expect(notFound).toBeVisible();
  await expect(notFound).toHaveAccessibleDescription(/No call in this conversation's transcript is recorded as launching this agent/);
  await expect(newerLaunch).not.toHaveClass(/is-flashed/);
  // Drawn muted like every search that ended without a turn, not in the live link colour.
  expect(await notFound.evaluate((el) => getComputedStyle(el).color)).toBe(
    await tray.evaluate((el) => getComputedStyle(el).color),
  );
  await shoot(dashboard, detail, "12-folded-twin-identity");
});

test("an agent named by no call id, launched while its conversation is open, still jumps to its launch", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon, PLAIN_GOAL);
  const detail = await openSession(dashboard, PLAIN_GOAL);

  // With the conversation open, the agent launches: its Agent call streams in at once, and the
  // record naming the agent is written about 4 s later, in a later append of its own.
  const reply = detail.getByPlaceholder(/^Reply to this session/);
  await expect(reply).toBeEnabled();
  await reply.fill("E2E_LIVE_BACKGROUND_AGENTS launch while watching");
  await reply.press("Enter");
  const tray = detail.getByRole("region", { name: "Background agents" });
  const agentRow = tray.getByRole("listitem").filter({ hasText: "Watch the ledger stream" });
  await expect(agentRow).toHaveCount(1);
  const log = detail.locator(".transcript-log");
  const launchRun = log.locator(".turn-toolrun").filter({ hasText: "Watch the ledger stream" });
  await expect(launchRun, "the call streamed in before the record naming its agent").toHaveCount(1);

  // A click before that record is written finds no call recorded for the agent yet, and says
  // so - with the reason, and that a later click looks again.
  const link = agentRow.getByRole("button", { name: "Jump to launch" });
  await link.click();
  const notYet = agentRow.getByRole("button", { name: "Launch not in transcript" });
  await expect(notYet).toBeVisible();
  await expect(notYet).toHaveAccessibleDescription(/may not be recorded yet - click to look again/);

  // The session carrying the agent, by the agent itself rather than by position.
  let sessionId: string | null = null;
  await expect.poll(async () => {
    const all = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as Array<{
      id: string;
      subagents?: { agents: Array<{ id: string; launchTurnId: string | null }> };
    }>;
    const carrying = all.find((s) => s.subagents?.agents.some((a) => a.id === "live-agent-1"));
    sessionId = carrying?.id ?? null;
    // Its source named no launching call: this is the case the file lookup exists for.
    const listed = carrying?.subagents?.agents.find((a) => a.id === "live-agent-1");
    return listed ? listed.launchTurnId : "absent";
  }).toBeNull();

  // The daemon reads the launch from the file once the result is written.
  await expect.poll(async () => {
    const response = await fetch(
      `${daemon.baseURL}/api/sessions/${encodeURIComponent(sessionId!)}/subagents/live-agent-1/launch`,
    );
    return ((await response.json()) as { toolUseId: string | null }).toolUseId;
  }, { timeout: 15_000, message: "the transcript records the call that launched the agent" }).toBe("toolu_live-agent-1");

  // The open conversation never re-read the call with its result, and the link lands anyway.
  await log.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(launchRun).not.toBeInViewport();
  // Clicked again now that it is written, the same link lands on the launch.
  await notYet.click();
  await expect(launchRun).toBeInViewport();
  await expect(launchRun).toHaveClass(/is-flashed/);
  await expect(agentRow.getByRole("button", { name: "Jump to launch" })).toBeVisible();
  await shoot(dashboard, detail, "13-live-launch-found");
});

test("an older page that adds no turn but moves back through the file does not end the search", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(120_000);
  await dispatch(dashboard, daemon, DEEP_GOAL);
  const detail = await openSession(dashboard, DEEP_GOAL);
  const tray = detail.getByRole("region", { name: "Background agents" });
  await expect(tray.getByRole("listitem")).toHaveCount(3);
  const log = detail.locator(".transcript-log");
  const launchRun = log.locator(".turn-toolrun").filter({ hasText: "Trace the distant ledger writes" });
  await expect(launchRun, "the launch is not in the opening window").toHaveCount(0);

  // The first older page arrives with its real byte range and no turns - what a stretch of
  // pure tool output reads as. It moved the cursor back; the launch is on the page after it.
  const olderPage = /\/api\/sessions\/[^/]+\/transcript\?before=/;
  let pages = 0;
  let emptied: { start: number; end: number; atStart: boolean } | null = null;
  await dashboard.route(olderPage, async (route) => {
    pages += 1;
    const response = await route.fetch();
    const page = (await response.json()) as { start: number; end: number; atStart: boolean; messages: unknown[] };
    if (pages === 1) {
      emptied = { start: page.start, end: page.end, atStart: page.atStart };
      await route.fulfill({ response, json: { ...page, messages: [] } });
      return;
    }
    await route.fulfill({ response, json: page });
  });

  const link = row(tray, "Trace the distant ledger writes").getByRole("button", { name: "Jump to launch" });
  await link.click();
  await expect(launchRun).toHaveCount(1, { timeout: 30_000 });
  await expect(launchRun).toBeInViewport();
  await expect(launchRun).toHaveClass(/is-flashed/);
  await expect(link).toHaveClass(/is-ready/);
  // The empty page really was the first one, it moved the cursor, and the search asked past it.
  expect(emptied, "the first older page was served empty").not.toBeNull();
  expect(emptied!.start).toBeLessThan(emptied!.end);
  expect(emptied!.atStart, "the empty page was not the start of the file").toBe(false);
  expect(pages, "the search asked for the page after the empty one").toBeGreaterThanOrEqual(2);
  await dashboard.unroute(olderPage);
});
