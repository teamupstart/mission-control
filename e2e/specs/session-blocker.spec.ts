import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
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

async function reportBlocker(daemon: DaemonHandle, sessionId: string): Promise<void> {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const res = await fetch(`${daemon.baseURL}/mcp/blocker`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({ env: {}, sessionId, ...BLOCKER }),
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

async function shoot(target: Page | Locator, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  if ("mouse" in target) await target.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/session-blocker/${name}.png`);
}

/**
 * A durable session blocker, end to end: a dispatched session reports it through the same
 * `/mcp/blocker` route the `report_blocker` tool posts, and the dashboard draws a red card in
 * the default placement - the Blocked lane under Needs you - with its fields, honours a hidden
 * card item, opens the detail band, flags a reply without raising anything, keeps the blocker
 * across a daemon restart, and clears it back into Idle.
 *
 * The other two placements are walked by `board-blocked-placement.spec.ts`.
 */
test("a reported blocker draws a red card in the Blocked lane, a detail band, survives a restart, and clears", async ({
  dashboard,
  daemon,
}) => {
  const session = await dispatchIdleAgent(dashboard, daemon, "wait on the platform team");
  await useBoardLayout(dashboard, daemon);
  await reportBlocker(daemon, session.id);

  // Nothing else is in Needs you: a blocker is not a question for you.
  const idle = dashboard.locator("main.board section.board-col.tone-idle");
  const needsYou = dashboard.locator("main.board section.board-col.tone-attention");
  const lane = needsYou.getByRole("region", { name: "Blocked" });
  const tile = lane.locator(".tile.is-blocked");
  await expect(tile).toHaveCount(1);
  await expect(tile.locator(".tf-blocked")).toHaveText(/^Blocked · \d+[smhd]$/);
  await expect(tile).toContainText("Question");
  await expect(tile).toContainText(BLOCKER.reason);
  await expect(tile).toContainText(`waiting on ${BLOCKER.waitingOn}`);
  await expect(tile.getByRole("link", { name: "Open blocker link" })).toHaveAttribute("href", BLOCKER.referenceUrl);
  await expect(needsYou.locator(".tile:not(.is-blocked)")).toHaveCount(0);
  await expect(idle).toHaveCount(0);
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

  // The detail band: every field, collapsible details, and the two controls.
  await tile.locator(".tile-name").click();
  const band = dashboard.getByRole("region", { name: "Session blocker" });
  await expect(band).toBeVisible();
  await expect(band).toContainText(BLOCKER.reason);
  await expect(band).toContainText(BLOCKER.waitingOn);
  await expect(band).toContainText(BLOCKER.resumeWhen);
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
  await shoot(band, "02-detail-band");

  // Flag a reply: a pill, the blocker stays, and nothing asks for you.
  await band.getByRole("button", { name: "Flag reply" }).click();
  await band.getByPlaceholder("Dana answered at 14:02").fill("Dana answered in the thread");
  await band.getByRole("button", { name: "Flag", exact: true }).click();
  await expect(band.getByRole("status")).toContainText("Reply flagged");
  await expect(band.getByRole("status")).toContainText("Dana answered in the thread");
  await expect(band.getByRole("button", { name: "Clear blocker" })).toBeVisible();
  const flagged = (await sessions(daemon)).find((s) => s.id === session.id);
  expect(flagged?.blocker?.reply, "the flag recorded a reply").toBeTruthy();
  expect(flagged?.state).toBe("idle");
  await dashboard.keyboard.press("Escape");
  await expect(tile.locator(".tile-blocker-reply")).toHaveText("Reply flagged");
  await expect(needsYou.locator(".tile:not(.is-blocked)")).toHaveCount(0);
  await shoot(dashboard, "03-reply-flagged");

  // A daemon restart brings the blocker back with its flag.
  await daemon.crash();
  await daemon.restart();
  await expect.poll(async () => (await sessions(daemon)).find((s) => s.blocker)?.blocker?.reason ?? "", {
    timeout: 60_000,
    message: "the blocked session came back after the restart",
  }).toBe(BLOCKER.reason);
  await dashboard.reload();
  await expect(tile).toHaveCount(1);
  await expect(tile.locator(".tile-blocker-reply")).toHaveText("Reply flagged");

  // Clear it: the band goes, and the card is an ordinary idle card again.
  await tile.locator(".tile-name").click();
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
  await expect(dashboard.locator(".tile.is-blocked")).toHaveCount(0);
  await expect(needsYou).toHaveCount(0);
  await expect(idle.locator(".tile")).toHaveCount(1);
  expect((await sessions(daemon)).some((s) => s.blocker)).toBe(false);
  await shoot(dashboard, "04-cleared");
});
