import { test, expect } from "../fixtures/test.ts";
import { enableVoice, say } from "../fixtures/voice.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

test("Recently heard explains routed, unaddressed and cancelled speech and clears the history", async ({ dashboard: page, daemon }) => {
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
    await expect(row(phrase)).toContainText("Routed to Will");
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
  if (process.env.MC_E2E_EVIDENCE) await table.screenshot({ path: artifactsDir("voice-window") + "recently-heard.png" });
  await table.getByRole("button", { name: "Clear" }).click();
  await expect(table).toContainText("Nothing heard yet.");
  await expect(table.getByRole("button", { name: "Clear" })).toBeDisabled();
  await expect(table).toContainText("Kept in memory, cleared when Mission Control quits. Audio is not stored.");
  if (process.env.MC_E2E_EVIDENCE) await table.screenshot({ path: artifactsDir("voice-window") + "empty.png" });
});
