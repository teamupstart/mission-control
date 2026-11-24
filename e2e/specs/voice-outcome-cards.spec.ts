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

test("cancelling a split shows the executed stop and cancels only the remaining message", async ({ dashboard: page, daemon }) => {
  await setupCards(page, daemon);
  await runningAgent(page, daemon, "Steve");
  await runningAgent(page, daemon, "Will");
  await say(daemon, "Steve, inspect the build, and Will, stop");
  const card = page.getByRole("status").filter({ hasText: "Steve" });
  await card.filter({ hasText: "Who is this for?" }).getByRole("button", { name: /Will/ }).click();
  await expect(card).toContainText("the remaining message");
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
  const session = await runningAgent(page, daemon, "Steve");
  expect((await page.request.post(daemon.baseURL + "/api/tasks/" + session.task!.id + "/complete", { data: { outcome: "Done" } })).ok()).toBe(true);
  await say(daemon, "Steve, check again");
  const done = page.getByRole("status").filter({ hasText: "Steve has finished" });
  await captureCard(done, "finished");
  await done.getByRole("button", { name: "Start a follow-up task" }).click();
  await expectContentClearsBorder(dialog);
  await expect(repo).toHaveValue(daemon.repo);
  await expect(intent).toHaveValue("");
  await intent.fill("Only for the follow-up");
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
