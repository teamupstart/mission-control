import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { Route } from "@playwright/test";
import { test, expect } from "../fixtures/test.ts";
import { enableVoice, say } from "../fixtures/voice.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

test("Recently heard explains routed, unaddressed and cancelled speech and clears the history", async ({ dashboard: page, daemon }) => {
  let capture: string | undefined;
  if (process.env.MC_E2E_EVIDENCE) {
    const root = artifactsDir("voice-window");
    mkdirSync(root, { recursive: true });
    capture = mkdtempSync(join(root, "heard-"));
  }
  await enableVoice(daemon);
  const task = await page.request.post(daemon.baseURL + "/api/tasks", { data: {
    repoRoot: daemon.repo, intent: "Report the build state", title: "Voice fixture", kind: "ship", agent: "claude", runtime: "sdk", workflowId: null, callSign: "Will",
  } });
  expect(task.ok(), await task.text()).toBe(true);
  await page.goto(daemon.baseURL + "/#/settings/voice");
  await expect(page.getByRole("table", { name: "Agents that answer to a spoken name" }).getByRole("row").filter({ hasText: "Will" })).toContainText("Running");
  const table = page.getByRole("region", { name: "Recently heard" });
  const row = (text: string) => table.getByRole("row").filter({ has: page.getByRole("cell", { name: text, exact: true }) });
  const config = (enabled: boolean) => page.request.put(daemon.baseURL + "/api/voice/config", { data: { cancelWindow: { enabled, seconds: 30 } } });
  expect((await config(false)).ok()).toBe(true);
  for (const phrase of ["Will, check the build", "Will check the tests"]) {
    const pause = phrase.startsWith("Will,") ? 300 : 0;
    const words = phrase.split(" ").map((text, i) => {
      const startMs = i * 100 + (i > 0 ? pause : 0);
      return { text, startMs, endMs: startMs + 100 };
    });
    expect(await (await say(daemon, phrase, { words })).json()).toEqual({ accepted: true });
    await expect(row(phrase).getByRole("cell", { name: "Will, exactly" })).toBeVisible();
    await expect(row(phrase).getByRole("cell", { name: "Queued", exact: true })).toBeVisible();
    await expect(row(phrase)).toContainText("exact first word");
    await expect(row(phrase).locator("mark")).toHaveText("Will");
  }
  await say(daemon, "Please ask Will");
  await expect(row("Please ask Will")).toContainText("no opening name");
  await expect(row("Please ask Will")).toContainText("Not routed");
  expect((await config(true)).ok()).toBe(true);
  await say(daemon, "Will, merge it");
  await say(daemon, "cancel");
  await expect(row("Will, merge it")).toContainText("Cancelled");
  await expect(row("cancel")).toContainText("spoken cancel");
  await expect(table.getByRole("columnheader")).toHaveText(["Ago", "Heard", "Matched", "Decided by", "Outcome"]);
  if (capture) await table.screenshot({ path: join(capture, "recently-heard.png") });
  const clear = table.getByRole("button", { name: "Clear" });
  await test.step("A failed Clear stays visible after a successful poll updates the table", async () => {
    await page.route("**/api/voice/heard", route => route.request().method() === "DELETE"
      ? route.fulfill({ status: 503, json: { error: "History could not be cleared." } })
      : route.continue());
    await clear.click();
    await say(daemon, "Another diagnostic");
    await expect(row("Another diagnostic")).toBeVisible();
    await expect(row("Please ask Will")).toBeVisible();
    await expect(table.getByRole("alert")).toHaveText("History could not be cleared.");
    if (capture) await table.screenshot({ path: join(capture, "clear-failure.png") });
    await page.unroute("**/api/voice/heard");
  });
  await clear.click();
  await expect(table).toContainText("Nothing heard yet.");
  await expect(table.getByRole("alert")).toHaveCount(0);
  await expect(clear).toBeEnabled();
  await expect(table).toContainText("Kept in memory, cleared when Mission Control quits. Audio is not stored.");
  if (capture) await table.screenshot({ path: join(capture, "empty.png") });
});

test("a failed history read shows an alert and retains entries until a successful poll refreshes them", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  expect((await say(daemon, "Before the read failure")).ok).toBe(true);
  await page.goto(daemon.baseURL + "/#/settings/voice");
  const history = page.getByRole("region", { name: "Recently heard" });
  const original = history.getByRole("cell", { name: "Before the read failure", exact: true });
  await expect(original).toBeVisible();

  await page.route("**/api/voice/heard", route => route.request().method() === "GET"
    ? route.fulfill({ status: 503, json: { error: "History unavailable." } })
    : route.continue());
  const error = history.getByRole("alert");
  await expect(error).toHaveText("Could not read recent utterances.");
  await expect(error).toBeVisible();
  await expect(original).toBeVisible();

  expect((await say(daemon, "During the read failure")).ok).toBe(true);
  await page.unroute("**/api/voice/heard");
  await expect(history.getByRole("cell", { name: "During the read failure", exact: true })).toBeVisible();
  await expect(original).toBeVisible();
  await expect(error).toHaveCount(0);
});

for (const previouslyEmpty of [false, true]) {
  const failure = previouslyEmpty ? "after an empty read" : "on the initial read";
  test(`Clear deletes retained speech when history is unavailable ${failure} and polling recovers`, async ({ dashboard: page, daemon }) => {
    await enableVoice(daemon);
    const endpoint = daemon.baseURL + "/api/voice/heard";
    const history = page.getByRole("region", { name: "Recently heard" });
    const clear = history.getByRole("button", { name: "Clear" });
    if (previouslyEmpty) {
      await page.goto(daemon.baseURL + "/#/settings/voice");
      await expect(history).toContainText("Nothing heard yet.");
      await expect(clear).toBeEnabled();
    }
    await page.route("**/api/voice/heard", route => route.request().method() === "GET"
      ? route.fulfill({ status: 503 })
      : route.continue());
    expect((await say(daemon, "Speech retained during the outage")).ok).toBe(true);
    if (!previouslyEmpty) await page.goto(daemon.baseURL + "/#/settings/voice");

    await expect(history.getByRole("alert")).toHaveText("Could not read recent utterances.");
    await expect(history.getByRole("cell", { name: "History unavailable." })).toBeVisible();
    await expect(clear).toBeEnabled();
    if (process.env.MC_E2E_EVIDENCE && !previouslyEmpty) {
      const root = artifactsDir("voice-window");
      mkdirSync(root, { recursive: true });
      await history.screenshot({ path: join(mkdtempSync(join(root, "unread-clear-")), "unavailable.png") });
    }

    const entries = async () => (await (await page.request.get(endpoint)).json()).entries;
    expect(await entries()).toEqual([expect.objectContaining({ text: "Speech retained during the outage" })]);
    const deletion = page.waitForResponse(response => response.url() === endpoint && response.request().method() === "DELETE");
    await clear.click();
    expect((await deletion).ok()).toBe(true);
    expect(await entries()).toEqual([]);

    expect((await say(daemon, "History is readable again")).ok).toBe(true);
    await page.unroute("**/api/voice/heard");
    await expect(history.getByRole("cell", { name: "History is readable again" })).toBeVisible();
    await expect(history.getByRole("cell", { name: "Speech retained during the outage" })).toHaveCount(0);
    await expect(history.getByRole("alert")).toHaveCount(0);
  });
}

test("Clear deletes retained speech while the next history poll is stalled after an empty read", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  const endpoint = daemon.baseURL + "/api/voice/heard";
  const history = page.getByRole("region", { name: "Recently heard" });
  const clear = history.getByRole("button", { name: "Clear" });
  await page.goto(daemon.baseURL + "/#/settings/voice");
  await expect(history).toContainText("Nothing heard yet.");

  const stalled = Promise.withResolvers<Route>();
  await page.route(endpoint, route => stalled.resolve(route), { times: 1 });
  const read = await stalled.promise;
  expect(read.request().method()).toBe("GET");
  expect((await say(daemon, "Speech heard during the stalled poll")).ok).toBe(true);
  const staleResponse = await read.fetch();
  expect((await staleResponse.json()).entries).toEqual([expect.objectContaining({ text: "Speech heard during the stalled poll" })]);
  try {
    await expect(clear).toBeEnabled();
    if (process.env.MC_E2E_EVIDENCE) {
      const root = artifactsDir("voice-window");
      mkdirSync(root, { recursive: true });
      await history.screenshot({ path: join(mkdtempSync(join(root, "stalled-read-")), "clear.png") });
    }
    const deleted = page.waitForResponse(response => response.url() === endpoint && response.request().method() === "DELETE");
    await clear.click();
    expect((await deleted).ok()).toBe(true);
    expect((await (await page.request.get(endpoint)).json()).entries).toEqual([]);
  } finally {
    await read.fulfill({ response: staleResponse });
  }
  expect((await say(daemon, "After the deletion")).ok).toBe(true);
  await expect(history.getByRole("cell", { name: "After the deletion" })).toBeVisible();
  await expect(history.getByRole("cell", { name: "Speech heard during the stalled poll" })).toHaveCount(0);
});

test("a stalled history read reports a failure and retries without losing the last known rows", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  expect((await say(daemon, "Last confirmed row")).ok).toBe(true);
  await page.goto(daemon.baseURL + "/#/settings/voice");
  const history = page.getByRole("region", { name: "Recently heard" });
  const original = history.getByRole("cell", { name: "Last confirmed row" });
  await expect(original).toBeVisible();
  const stalled = Promise.withResolvers<Route>();
  await page.route(daemon.baseURL + "/api/voice/heard", route => stalled.resolve(route), { times: 1 });
  const read = await stalled.promise;
  try {
    expect((await say(daemon, "Speech during the stalled read")).ok).toBe(true);
    await expect(history.getByRole("alert")).toHaveText("Could not read recent utterances.");
    await expect(original).toBeVisible();
    if (process.env.MC_E2E_EVIDENCE) {
      const root = artifactsDir("voice-window");
      mkdirSync(root, { recursive: true });
      await history.screenshot({ path: join(mkdtempSync(join(root, "deadline-")), "retained.png") });
    }
    await expect(history.getByRole("cell", { name: "Speech during the stalled read" })).toBeVisible();
    await expect(history.getByRole("alert")).toHaveCount(0);
  } finally {
    await read.abort();
  }
});
