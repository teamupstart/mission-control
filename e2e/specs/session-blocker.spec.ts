import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { settled } from "../fixtures/settle.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

const EVIDENCE = artifactsDir("session-blocker");

const BLOCKER = {
  kind: "question",
  reason: "Need the retention window for audit logs",
  waitingOn: "Dana (platform)",
  resumeWhen: "A platform owner answers with a retention window",
  referenceUrl: "https://example.com/threads/8812",
  details: [
    "Two options are viable: **30 days** or **400 days**.",
    ...Array.from({ length: 40 }, (_, i) => `- Consideration ${i + 1}: storage cost, audit scope and the retention rules each option implies.`),
  ].join("\n"),
};

interface LiveSession {
  id: string;
  state: string;
  cwd: string | null;
  blocker: { reason: string; reply: unknown } | null;
}

async function sessions(daemon: DaemonHandle): Promise<LiveSession[]> {
  return (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as LiveSession[];
}

async function dispatchIdleAgent(page: Page, daemon: DaemonHandle, goal: string): Promise<LiveSession> {
  const before = new Set((await sessions(daemon)).map((s) => s.id));
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(goal);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  let fresh: LiveSession | undefined;
  await expect.poll(async () => {
    fresh = (await sessions(daemon)).find((s) => !before.has(s.id) && s.state !== "exited");
    return fresh?.cwd ? fresh.state : "";
  }, { timeout: 60_000, message: "the dispatch settled idle with a checkout" }).toBe("idle");
  return fresh!;
}

async function reportBlocker(
  daemon: DaemonHandle,
  sessionId: string,
  blocker: Partial<typeof BLOCKER> = {},
): Promise<void> {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const res = await fetch(`${daemon.baseURL}/mcp/blocker`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({ env: {}, sessionId, ...BLOCKER, ...blocker }),
  });
  expect(res.status, `the blocker route accepted the report: ${await res.clone().text()}`).toBe(200);
}

async function useBoardLayout(page: Page, daemon: DaemonHandle): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "board" }),
  });
  expect(response.ok).toBe(true);
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();
}

/** `inner` is laid out wholly inside `outer`'s border box, so nothing of it is clipped. */
async function expectInside(outer: Locator, inner: Locator, what: string): Promise<void> {
  await expect(inner).toBeVisible();
  const [o, i] = await Promise.all([outer.boundingBox(), inner.boundingBox()]);
  expect(i!.height, `${what} has no height`).toBeGreaterThan(0);
  expect(i!.y, `${what} starts above the band`).toBeGreaterThanOrEqual(o!.y - 0.5);
  expect(i!.y + i!.height, `${what} is cut off by the bottom of the band`).toBeLessThanOrEqual(o!.y + o!.height + 0.5);
}

async function shoot(target: Page | Locator, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  // A hovered control's tooltip would cover what the shot is for.
  await ("mouse" in target ? target : target.page()).mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/session-blocker/${name}.png`);
}

/**
 * A durable session blocker, end to end: a dispatched session reports it through the same
 * `/mcp/blocker` route the `report_blocker` tool posts, and the dashboard draws a red card in
 * Idle with its fields, honours a hidden card item, opens the detail band, flags a reply
 * without raising anything, keeps the blocker across a daemon restart, and clears it.
 *
 * Phase 1 deliberately leaves a blocked idle session in the Idle column; the placement setting
 * that moves it is Phase 2's.
 */
test("a reported blocker draws a red Idle card, a detail band, survives a restart, and clears", async ({
  dashboard,
  daemon,
}) => {
  // A long goal gives the session a transcript far taller than the pane. That is the shape
  // that once squeezed the band to its header row: both children could shrink, and flexbox
  // shares shrinkage by natural height, so a long transcript took nearly all of the band's.
  const goal = Array.from({ length: 60 }, (_, i) =>
    `Paragraph ${i}: wait on the platform team, and keep the blocker readable while the conversation grows.`).join("\n\n");
  const session = await dispatchIdleAgent(dashboard, daemon, goal);
  await useBoardLayout(dashboard, daemon);
  await reportBlocker(daemon, session.id);

  // The card stays in Idle (Phase 1), turns red, and says what it waits on and for how long.
  const idle = dashboard.locator("main.board section.board-col.tone-idle");
  const needsYou = dashboard.locator("main.board section.board-col.tone-attention");
  const tile = idle.locator(".tile.is-blocked");
  await expect(tile).toHaveCount(1);
  await expect(tile.locator(".tf-blocked")).toHaveText(/^Blocked · \d+[smhd]$/);
  await expect(tile).toContainText("Question");
  await expect(tile).toContainText(BLOCKER.reason);
  await expect(tile).toContainText(`waiting on ${BLOCKER.waitingOn}`);
  await expect(tile.getByRole("link", { name: "Open blocker link" })).toHaveAttribute("href", BLOCKER.referenceUrl);
  await expect(needsYou.locator(".tile")).toHaveCount(0);
  await shoot(dashboard, "01-blocked-card");

  // Hide one card item: its fact leaves the card, the state does not.
  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  const waitingOn = dashboard.getByRole("checkbox", { name: "Waiting on", exact: true });
  await expect(waitingOn).toBeChecked();
  await waitingOn.uncheck();
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await expect(tile).toHaveCount(1);
  await expect(tile).not.toContainText(`waiting on ${BLOCKER.waitingOn}`);
  await expect(tile).toContainText(BLOCKER.reason);
  await expect(tile.locator(".tf-blocked")).toBeVisible();

  // The detail band opens as one row: kind, reason, age and the two controls. The other
  // fields wait behind the row's toggle.
  await tile.locator(".tile-name").click();
  const band = dashboard.getByRole("region", { name: "Session blocker" });
  await expect(band).toBeVisible();
  const toggle = band.getByRole("button", { name: `Blocked Question ${BLOCKER.reason}` });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(band.getByText(/^\d+[smhd]$/)).toBeVisible();
  await expect(band.getByText(BLOCKER.waitingOn, { exact: true })).toBeHidden();
  await expect(band.getByText(BLOCKER.resumeWhen, { exact: true })).toBeHidden();
  // Collapsed, the band is one complete row beside a long transcript: the reason and both
  // controls lie inside the band's own box, and nothing is hidden in a scrollport.
  const conversationLog = dashboard.locator(".detail-conv > .transcript .transcript-log");
  expect(await conversationLog.evaluate((el) => el.scrollHeight > el.clientHeight * 2),
    "the transcript is long enough to squeeze the band").toBe(true);
  await expectInside(band, toggle.getByText(BLOCKER.reason, { exact: true }), "the reason");
  await expectInside(band, band.getByRole("button", { name: "Flag reply" }), "Flag reply");
  await expectInside(band, band.getByRole("button", { name: "Clear blocker" }), "Clear blocker");
  expect(await band.evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
    "the collapsed band hid part of itself in a scroll box").toBe(true);
  await shoot(band, "02a-collapsed-band");

  // Expanded: every field and the collapsible details, with the controls still in the row.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(band.getByRole("definition").filter({ hasText: BLOCKER.reason })).toBeVisible();
  await expect(band.getByText(BLOCKER.waitingOn, { exact: true })).toBeVisible();
  await expect(band.getByText(BLOCKER.resumeWhen, { exact: true })).toBeVisible();
  await expect(band.getByRole("link", { name: BLOCKER.referenceUrl })).toBeVisible();
  await band.getByText("Details", { exact: true }).click();
  await expect(band.locator("strong", { hasText: "400 days" })).toBeVisible();
  // Long details stay inside the band: it is capped and scrolls, so the transcript keeps its
  // share of the pane instead of being pushed out of the console.
  const conversation = dashboard.locator(".detail-conv");
  const transcript = conversation.locator("> .transcript");
  const [paneBox, bandBox, transcriptBox] = await Promise.all([
    conversation.boundingBox(), band.boundingBox(), transcript.boundingBox(),
  ]);
  expect(bandBox!.height, "the expanded band took most of the pane").toBeLessThanOrEqual(paneBox!.height * 0.45);
  expect(transcriptBox!.height, "the transcript was squeezed out by the band").toBeGreaterThanOrEqual(100);
  expect(await band.evaluate((el) => el.scrollHeight > el.clientHeight), "long details did not scroll inside the band").toBe(true);
  // Scrolled to the end of long details, the row and its controls are still in view.
  await band.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expectInside(band, band.getByRole("button", { name: "Clear blocker" }), "Clear blocker after scrolling");
  await shoot(band, "02-detail-band");

  // Collapsing hides the facts again, and the band goes back to one row.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(band.getByText(BLOCKER.waitingOn, { exact: true })).toBeHidden();
  expect(await band.evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
    "the re-collapsed band still scrolls").toBe(true);

  // Flag a reply: a pill, the blocker stays, and nothing asks for you.
  await band.getByRole("button", { name: "Flag reply" }).click();
  await band.getByPlaceholder("Dana answered at 14:02").fill("Dana answered in the thread");
  await shoot(band, "02b0-flag-form");
  await band.getByRole("button", { name: "Flag", exact: true }).click();
  await expect(band.getByRole("status")).toContainText("Reply flagged");
  await expect(band.getByRole("status")).toContainText("Dana answered in the thread");
  await expect(band.getByRole("button", { name: "Clear blocker" })).toBeVisible();
  // The flagged reply prints under the collapsed row, without expanding it.
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expectInside(band, band.getByRole("status"), "the flagged reply");
  await shoot(band, "02b-reply-flagged-band");
  await shoot(dashboard, "02c-reply-flagged-pane");
  const flagged = (await sessions(daemon)).find((s) => s.id === session.id);
  expect(flagged?.blocker?.reply, "the flag recorded a reply").toBeTruthy();
  expect(flagged?.state).toBe("idle");
  await dashboard.keyboard.press("Escape");
  await expect(tile.locator(".tile-blocker-reply")).toHaveText("Reply flagged");
  await expect(needsYou.locator(".tile")).toHaveCount(0);
  await shoot(dashboard, "03-reply-flagged");

  // A daemon restart brings the blocker back with its flag.
  await daemon.crash();
  await daemon.restart();
  await expect.poll(async () => (await sessions(daemon)).find((s) => s.blocker)?.blocker?.reason ?? "", {
    timeout: 60_000,
    message: "the blocked session came back after the restart",
  }).toBe(BLOCKER.reason);
  await dashboard.reload();
  await expect(idle.locator(".tile.is-blocked")).toHaveCount(1);
  await expect(idle.locator(".tile.is-blocked .tile-blocker-reply")).toHaveText("Reply flagged");

  // Clear it: the band goes, and the card is an ordinary idle card again.
  await idle.locator(".tile.is-blocked .tile-name").click();
  const restored = dashboard.getByRole("region", { name: "Session blocker" });
  // A request that never reaches the daemon reports why and leaves the controls usable.
  await dashboard.route("**/api/sessions/*/blocker/clear", (route) => route.abort("connectionreset"), { times: 1 });
  await restored.getByRole("button", { name: "Clear blocker" }).click();
  await expect(restored.getByRole("alert")).toBeVisible();
  await expect(restored.getByRole("button", { name: "Clear blocker" })).toBeEnabled();
  await expect(restored.getByRole("button", { name: "Flag reply" })).toBeEnabled();
  await restored.getByRole("button", { name: "Clear blocker" }).click();
  await expect(dashboard.getByRole("region", { name: "Session blocker" })).toHaveCount(0);
  await dashboard.keyboard.press("Escape");
  await expect(idle.locator(".tile.is-blocked")).toHaveCount(0);
  await expect(idle.locator(".tile")).toHaveCount(1);
  expect((await sessions(daemon)).some((s) => s.blocker)).toBe(false);
  await shoot(dashboard, "04-cleared");
});

/**
 * The other end of the row's layout: a reason at the 200-character limit, in a Conversation
 * pane narrow enough that the controls wrap under the toggle. The reason truncates instead of
 * pushing the controls out, both controls stay inside the band and the window and can be
 * clicked, and expanding prints the whole reason as a fact while the row stays one line - a
 * reason allowed to wrap in the sticky row could outgrow the band's height cap and take the
 * controls out of its scrollport.
 */
test("a long blocker reason in a narrow pane keeps both controls reachable and expands to the full reason", async ({
  dashboard,
  daemon,
}) => {
  const reason = "Need the retention window for audit logs, the archive tier for anything older than that, "
    + "and a named owner for the export job before the migration can move any of the history at all";
  expect(reason.length, "the reason sits at the schema's limit").toBeLessThanOrEqual(200);
  expect(reason.length).toBeGreaterThan(180);
  await dashboard.setViewportSize({ width: 900, height: 640 });
  const session = await dispatchIdleAgent(dashboard, daemon, "wait on the platform team");
  await useBoardLayout(dashboard, daemon);
  await reportBlocker(daemon, session.id, { reason });

  await dashboard.locator("main.board .tile.is-blocked .tile-name").click();
  const band = dashboard.getByRole("region", { name: "Session blocker" });
  await expect(band).toBeVisible();
  // The Board's reader slides in from the right. The band must come to rest inside the
  // window - a band that never does fails here on timeout - and is measured where it rests,
  // not on a frame of the slide.
  const viewport = dashboard.viewportSize()!;
  await expect.poll(async () => {
    const box = await band.boundingBox();
    return box ? box.x + box.width : Number.POSITIVE_INFINITY;
  }, { message: "the band runs off the window", intervals: [100] }).toBeLessThanOrEqual(viewport.width + 0.5);
  await settled(band);
  const bandBox = (await band.boundingBox())!;
  expect(bandBox.width, "the Conversation pane is narrow enough to wrap the row").toBeLessThan(560);
  expect(bandBox.x + bandBox.width, "the band runs off the window").toBeLessThanOrEqual(viewport.width + 0.5);

  const toggle = band.getByRole("button", { name: `Blocked Question ${reason}` });
  const rowReason = toggle.getByText(reason, { exact: true });
  const flag = band.getByRole("button", { name: "Flag reply" });
  const clear = band.getByRole("button", { name: "Clear blocker" });

  // Collapsed: the controls have wrapped under the toggle, the reason is cut short rather
  // than wrapped, and both controls fit band and window.
  const [toggleBox, clearAt] = [(await toggle.boundingBox())!, (await clear.boundingBox())!];
  expect(clearAt.y, "the controls did not wrap under the toggle in a narrow pane")
    .toBeGreaterThanOrEqual(toggleBox.y + toggleBox.height - 0.5);
  expect(bandBox.x + bandBox.width - (clearAt.x + clearAt.width), "the wrapped controls left the right edge")
    .toBeLessThan(24);
  expect(await rowReason.evaluate((el) => el.scrollWidth > el.clientWidth), "the long reason was not truncated").toBe(true);
  expect((await rowReason.boundingBox())!.width, "the reason was cut to a word or two").toBeGreaterThan(150);
  const oneLine = (await rowReason.boundingBox())!.height;
  for (const [control, what] of [[flag, "Flag reply"], [clear, "Clear blocker"]] as const) {
    await expectInside(band, control, what);
    const box = (await control.boundingBox())!;
    expect(box.x + box.width, `${what} runs off the window`).toBeLessThanOrEqual(viewport.width + 0.5);
    await control.click({ trial: true });
  }
  expect(await band.evaluate((el) => el.scrollHeight <= el.clientHeight + 1), "the collapsed band scrolls").toBe(true);
  await shoot(band, "05-long-reason-narrow");

  // Expanded: the whole reason is a visible fact, and the row is still one line of reason, so
  // the controls stay where they were.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const fullReason = band.getByRole("definition").filter({ hasText: reason });
  await expect(fullReason).toBeVisible();
  await expect(fullReason).toHaveText(reason);
  expect((await rowReason.boundingBox())!.height, "the expanded row wrapped the reason").toBeLessThanOrEqual(oneLine + 0.5);
  await expectInside(band, clear, "Clear blocker after expanding");
  await expectInside(band, flag, "Flag reply after expanding");
  await shoot(band, "06a-long-reason-expanded-top");
  await band.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expectInside(band, clear, "Clear blocker after scrolling the expanded band");
  await shoot(band, "06-long-reason-expanded");

  // The control is genuinely reachable: it clears the blocker from this layout.
  await clear.click();
  await expect(dashboard.getByRole("region", { name: "Session blocker" })).toHaveCount(0);
  await expect.poll(async () => (await sessions(daemon)).some((s) => s.blocker)).toBe(false);
});
