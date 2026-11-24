import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../fixtures/test.ts";
import { captureCard, expectCardGeometry, runningAgent, setupCards } from "../fixtures/voice-cards.ts";
import { say, voiceToken } from "../fixtures/voice.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import type { Session } from "../../src/shared/types.ts";

test("resolve roster rows by click and speech, cancel a split and identify a mention", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  for (const name of ["Steve", "Will"]) await runningAgent(page, daemon, name);
  const unsure = page.getByRole("status").filter({ hasText: "Who is this for?" });
  for (const pick of ["click", "speech"]) {
    await say(daemon, "Steven ask Will about the deployment");
    await expect(unsure.getByRole("button", { name: /Steve/ })).toContainText("Steve on builds");
    await expect(unsure.getByRole("button", { name: /Will/ })).toBeVisible();
    await expect(unsure.getByRole("button", { name: /Will/ })).toHaveAccessibleDescription("Choose Will for this message");
    await expect(unsure.getByRole("button", { name: "Cancel" })).toHaveAccessibleDescription("Cancel pending voice delivery");
    await expectCardGeometry(unsure, "routing-exceptions", "#b .is-unsure");
    await captureCard(unsure, "unsure");
    if (pick === "click") await unsure.getByRole("button", { name: /Steve/ }).click();
    else await say(daemon, "Will");
    const card = page.getByRole("status").filter({ hasText: pick === "click" ? "Will is mentioned" : "Two messages" });
    await expect(card).toBeVisible();
    await expect(card).toContainText("about the deployment");
    await captureCard(card, pick === "click" ? "mention" : "split");
    await card.getByRole("button", { name: "Cancel" }).click();
    await expect(card).toHaveCount(0);
  }
});

test("a queued message gets a fresh visible interval when its receipt changes to Sent", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  const steve = await runningAgent(page, daemon, "Steve");
  const session = daemon.baseURL + "/api/sessions/" + encodeURIComponent(steve.id);
  expect((await page.request.post(session + "/send", { data: { text: "E2E_HOLD_TURN_UNTIL_RELEASED", submit: true, origin: "human" } })).ok()).toBe(true);
  await say(daemon, "Steve, check the receipt");
  const card = page.getByRole("status").filter({ hasText: "Steve" });
  await card.getByRole("button", { name: "Send now" }).click();
  await expect(card).toContainText("Queued behind Steve");
  // Use the browser's real animation clock. The old queued interval must end during the new reading interval.
  await page.waitForTimeout(4000);
  writeFileSync(join(daemon.recordDir, "e2e-release-held-turn"), "");
  await expect(card).toContainText("Sent to Steve");
  await page.waitForTimeout(5500);
  await expect(card).toHaveCSS("opacity", "1", { timeout: 1000 });
  await captureCard(card, "sent-after-queue");
  await expect(card).toHaveCount(0, { timeout: 4000 });
});

test("Send now releases both split messages or only the addressed message for a mention", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  for (const name of ["Steve", "Will"]) await runningAgent(page, daemon, name);
  for (const split of [false, true]) {
    const id = split ? "early-split" : "early-mention";
    await say(daemon, "Steven ask Will about the deployment", { id });
    const unsure = page.getByRole("status").filter({ hasText: "Who is this for?" });
    await unsure.getByRole("button", { name: split ? /Will/ : /Steve/ }).click();
    const card = page.getByRole("status").filter({ hasText: split ? "Two messages" : "Will is mentioned" });
    const send = card.getByRole("button", { name: split ? "Send both now" : "Send to Steve now" });
    await expect(send).toBeVisible({ timeout: 3000 });
    await captureCard(card, id);
    const released = page.waitForResponse(response => response.url() === daemon.baseURL + "/api/voice/cards/" + id + "/send-now");
    await send.click();
    expect((await released).ok()).toBe(true);
    const outcome = page.getByRole("status").filter({ hasText: "Sent to Steve" });
    if (split) await expect(outcome.filter({ hasText: "Sent to Will" })).toBeVisible();
    else {
      await expect(outcome).toBeVisible();
      await expect(outcome).not.toContainText("Will");
    }
  }
});

test("cancelling a split shows the executed stop and cancels only the remaining message", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  await runningAgent(page, daemon, "Steve");
  await runningAgent(page, daemon, "Will");
  await say(daemon, "Steve, inspect the build, and Will, stop");
  const card = page.getByRole("status").filter({ hasText: "Steve" });
  await card.filter({ hasText: "Who is this for?" }).getByRole("button", { name: /Will/ }).click();
  await expect(card).toContainText("the remaining message");
  await expect(card).toContainText("stop sent", { timeout: 3000 });
  await expect(card.getByRole("button", { name: "Send to Steve now" })).toBeVisible();
  await card.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(card).toContainText("Steve · Cancelled");
  await expect(card).toContainText("Stop sent to Will");
  await captureCard(card, "split-stop-cancelled");
});

test("a mixed split shows both delivery outcomes and recalls only the held part", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  await runningAgent(page, daemon, "Steve");
  const will = await runningAgent(page, daemon, "Will");
  const title = "Which deployment should I review?";
  const ask = await page.request.post(daemon.baseURL + "/mcp/reviews", {
    headers: { "x-harness-token": voiceToken(daemon) }, data: { env: {}, cwd: will.cwd, kind: "input", title, body: title },
  });
  expect(ask.ok(), await ask.text()).toBe(true);
  expect((await page.request.put(daemon.baseURL + "/api/voice/config", { data: { cancelWindow: { enabled: false } } })).ok()).toBe(true);
  const pendingWords = async () => {
    const sessions: Session[] = await (await page.request.get(daemon.baseURL + "/api/sessions")).json();
    return sessions.find(s => s.id === will.id)?.pendingTurns.map(turn => [turn.id, turn.spokenWords]);
  };
  await say(daemon, "Will, keep the earlier message", { id: "earlier" });
  const earlier = ["voice:earlier", "keep the earlier message"];
  await expect.poll(pendingWords).toEqual([earlier]);
  await say(daemon, "Steven ask Will about the deployment", { id: "split" });
  await page.getByRole("status").filter({ hasText: "Who is this for?" }).getByRole("button", { name: /Will/ }).click();
  const mixed = page.getByRole("status").filter({ hasText: "Sent to Steve" });
  await expect(mixed).toContainText("Held for Will");
  await page.reload();
  await expect(mixed).toContainText(title);
  await expect.poll(pendingWords).toEqual([earlier, ["voice:split#2", "about the deployment"]]);
  await captureCard(mixed, "mixed-split-held");
  const recall = page.waitForResponse(response => response.request().method() === "POST" &&
    response.url() === daemon.baseURL + "/api/sessions/" + encodeURIComponent(will.id) + "/pending-turns/voice%3Asplit%232/recall");
  await mixed.getByRole("button", { name: "Cancel message" }).click();
  expect(await (await recall).json()).toEqual({ ok: true, text: "about the deployment" });
  await expect(mixed).toContainText("Will · Cancelled");
  await expect.poll(pendingWords).toEqual([earlier]);
  await captureCard(mixed, "mixed-split-recalled");
});

test("without randomUUID a pending card can cancel and a stopped resident can relaunch", async ({ dashboard: page, daemon }) => {
  // Plain HTTP on a LAN exposes getRandomValues but omits the secure-context UUID method.
  await page.addInitScript(() => { Reflect.deleteProperty(Crypto.prototype, "randomUUID"); });
  await page.reload();
  await setupCards(page, daemon);
  const launches: string[] = [];
  await page.route("**/api/residents/profiles/*/launch", async route => {
    launches.push(route.request().postDataJSON().requestId);
    if (launches.length === 1) await route.fulfill({ status: 503, json: { error: "Try the launch again" } });
    else await route.continue();
  });
  const resident = await page.request.post(daemon.baseURL + "/api/residents/profiles", { data: { settings: {
    identity: { name: "Marlowe", description: "Reviews builds" }, persona: { personaId: "builtin:code-risk-reviewer" },
  } } });
  expect(resident.ok(), await resident.text()).toBe(true);
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe("undefined");
  await say(daemon, "Marlowe, cancel this one");
  await page.getByRole("status").filter({ hasText: "To Marlowe" }).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Cancelled" })).toBeVisible();
  await page.request.put(daemon.baseURL + "/api/voice/config", { data: { cancelWindow: { enabled: false } } });
  await say(daemon, "Marlowe, check the build");
  const card = page.getByRole("status").filter({ hasText: "Marlowe isn't running" });
  await expect(card).toContainText("Nothing was sent");
  await captureCard(card, "resident");
  await card.getByRole("button", { name: "Relaunch Marlowe" }).click();
  await expect(card).toContainText("Try the launch again");
  await card.getByRole("button", { name: "Relaunch Marlowe" }).click();
  await expect.poll(async () => ((await (await page.request.get(daemon.baseURL + "/api/sessions")).json()) as Session[]).some(s => s.task?.kind === "resident")).toBe(true);
  expect(launches).toHaveLength(2);
  expect(launches[0]).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
  expect(launches[1]).toBe(launches[0]);
});

test("a stopped resident stays visible through keyboard focus, reconnect and a slow relaunch", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  await page.request.put(daemon.baseURL + "/api/voice/config", { data: { cancelWindow: { enabled: false } } });
  expect((await page.request.post(daemon.baseURL + "/api/residents/profiles", { data: { settings: {
    identity: { name: "Marlowe", description: "Reviews builds" }, persona: { personaId: "builtin:code-risk-reviewer" },
  } } })).ok()).toBe(true);
  const release = Promise.withResolvers<void>();
  await page.route("**/api/residents/profiles/*/launch", async route => {
    await release.promise;
    await route.fulfill({ status: 503, json: { error: "Try the launch again" } });
  });
  await page.clock.install();
  await say(daemon, "Marlowe, check the build");
  const card = page.getByRole("status").filter({ hasText: "Marlowe isn't running" });
  const launch = card.getByRole("button", { name: "Relaunch Marlowe" });
  await launch.focus();
  await page.clock.fastForward(9000);
  await expect(launch).toBeFocused({ timeout: 3000 });
  await expect(card).toHaveCSS("opacity", "1");
  await launch.press("Enter");
  await expect(launch).toBeDisabled();
  await page.getByRole("button", { name: "Dispatch", exact: true }).focus();
  await page.clock.fastForward(9000);
  try {
    await page.request.put(daemon.baseURL + "/api/voice/config", { data: { cancelWindow: { enabled: true, seconds: 30 } } });
    await say(daemon, "Marlowe, restart the build");
    const pending = page.getByRole("status").filter({ hasText: "restart the build" });
    await expect(pending.getByRole("button", { name: "Cancel" })).toBeVisible();
    await daemon.crash();
    await expect(page.locator(".pulse")).toHaveClass(/is-down/);
    await daemon.restart();
    // A fresh daemon snapshot has neither the pending delivery nor the local relaunch result.
    await expect(pending).toHaveCount(0);
    await expect(launch).toBeDisabled({ timeout: 3000 });
    await expect(launch).toBeVisible();
    await expect(card).toHaveCSS("opacity", "1");
    await captureCard(card, "reconnected-relaunch-in-progress");
  } finally {
    release.resolve();
  }
  await expect(card).toContainText("Try the launch again");
  await expect(launch).toBeEnabled();
  await page.clock.fastForward(6000);
  await expect(card).toContainText("Try the launch again");
  await captureCard(card, "reconnected-relaunch-retry");
  await page.clock.fastForward(3000);
  await expect(card).toHaveCount(0);
});

test("a finished task opens a separate follow-up draft and preserves the regular dispatch", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  await page.request.put(daemon.baseURL + "/api/voice/config", { data: { cancelWindow: { enabled: false } } });
  const openDispatch = page.getByRole("button", { name: "Dispatch" });
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  const repo = dialog.getByPlaceholder("search repos or type a path…");
  const intent = dialog.getByPlaceholder("What should this agent do?");
  const regularRepo = daemon.repo + "-other";
  await openDispatch.click();
  await repo.fill(regularRepo);
  await intent.fill("Keep this unrelated dispatch");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  for (const name of ["Steve", "Will"]) {
    const session = await runningAgent(page, daemon, name);
    expect((await page.request.post(daemon.baseURL + "/api/tasks/" + session.task!.id + "/complete", { data: { outcome: "Done" } })).ok()).toBe(true);
  }
  await page.clock.install();
  await say(daemon, "Steve, check again");
  const done = page.getByRole("status").filter({ hasText: "Steve has finished" });
  await captureCard(done, "finished");
  const followUp = done.getByRole("button", { name: "Start a follow-up task" });
  await followUp.focus();
  await page.clock.fastForward(9000);
  await expect(followUp).toBeFocused({ timeout: 3000 });
  await expect(done).toHaveCSS("opacity", "1");
  await followUp.press("Enter");
  await expectContentClearsBorder(dialog);
  await expect(repo).toHaveValue(daemon.repo);
  await expect(intent).toHaveValue("");
  await intent.fill("Only for the follow-up");
  const transfer = await page.evaluateHandle(() => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), c => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([png], "first-follow-up.png", { type: "image/png" }));
    return data;
  });
  await dialog.locator(".drop-zone").dispatchEvent("drop", { dataTransfer: transfer });
  await transfer.dispose();
  const attachment = dialog.getByRole("button", { name: "Remove first-follow-up.png" });
  await expect(attachment).toBeVisible();
  await say(daemon, "Will, check again");
  await page.getByRole("status").filter({ hasText: "Will has finished" }).getByRole("button", { name: "Start a follow-up task" }).click();
  await expectContentClearsBorder(dialog);
  await expect(repo).toHaveValue(daemon.repo);
  await expect(intent).toHaveValue("", { timeout: 2000 });
  await expect(attachment).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await openDispatch.click();
  await expect(repo).toHaveValue(regularRepo);
  await expect(intent).toHaveValue("Keep this unrelated dispatch");
});
test("a held card identifies the blocking question and recalls the queued words", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  const session = await runningAgent(page, daemon, "Steve");
  const title = "SQLite or Postgres for the cache?";
  const ask = await page.request.post(daemon.baseURL + "/mcp/reviews", {
    headers: { "x-harness-token": voiceToken(daemon) }, data: { env: {}, cwd: session.cwd, kind: "input", title, body: title },
  });
  expect(ask.ok(), await ask.text()).toBe(true);
  await say(daemon, "Steve, use Postgres");
  await page.getByRole("button", { name: "Send now" }).click();
  const held = page.getByRole("status").filter({ hasText: "Held for Steve" });
  await expect(held).toContainText(title);
  await page.reload();
  await expect(held).toContainText(title);
  await captureCard(held, "held");
  await held.getByRole("button", { name: "Open question" }).click();
  await expect(page.getByRole("dialog").filter({ hasText: title })).toBeVisible();
  await page.keyboard.press("Escape");
  await held.getByRole("button", { name: "Cancel message" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Cancelled" })).toBeVisible();
  await expect.poll(async () => ((await (await page.request.get(daemon.baseURL + "/api/sessions")).json()) as Session[]).find(s => s.id === session.id)?.pendingTurns.length).toBe(0);
});
