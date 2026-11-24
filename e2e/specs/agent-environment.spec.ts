import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Locator } from "@playwright/test";
import { test, expect } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { recordsIn } from "../fixtures/records.ts";

test.use({ daemonEnv: { E2E_NEWER_NAME: "fixture", SHELL: fileURLToPath(new URL("../fixtures/agent-environment-shell.sh", import.meta.url)) } });

async function expectVariables(panel: Locator, rows: [string, string][]) {
  const items = panel.getByRole("listitem");
  await expect(items.locator("code")).toHaveText(rows.map(([name]) => name));
  await expect(items.locator(":scope > span").filter({ hasText: /^(Absent|Present)/ })).toHaveText(rows.map(([, status]) => status));
  for (const [name] of rows) await expect(panel.getByRole("button", { name: `Delete ${name}`, exact: true })).toBeVisible();
}

test("named login-shell variables reach both SDK processes and a missing name warns on the session", async ({ daemon, dashboard: page }) => {
  test.setTimeout(150_000);
  const endpoint = daemon.baseURL + "/api/agent-environment";
  expect((await page.request.get(endpoint)).status()).toBe(404);
  await page.goto(daemon.baseURL + "/#/settings/feature-flags");
  await page.getByRole("button", { name: "Agent environment: off" }).click();
  await page.goto(daemon.baseURL + "/#/settings/harnesses");
  const panel = page.getByRole("region", { name: "Agent environment" });
  const cards = page.locator(".harness-cards");
  expect(await cards.evaluate((element) => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(
    await panel.evaluate((element) => element.getBoundingClientRect().top));
  const name = panel.getByRole("textbox", { name: "Variable name" });
  const add = panel.getByRole("button", { name: "Add variable" });
  await expect(panel.getByText("No variables configured.")).toBeVisible();
  await name.fill(" E2E_LISTED_TOKEN ");
  await name.press("Enter");
  await expectVariables(panel, [["E2E_LISTED_TOKEN", "Present (login shell)"]]);
  await expect(name).toBeEmpty();
  await name.fill("E2E_ABSENT_TOKEN");
  await add.click();
  await expectVariables(panel, [["E2E_LISTED_TOKEN", "Present (login shell)"], ["E2E_ABSENT_TOKEN", "Absent"]]);
  await page.reload();
  await expectVariables(panel, [["E2E_LISTED_TOKEN", "Present (login shell)"], ["E2E_ABSENT_TOKEN", "Absent"]]);
  expect(await (await page.request.get(endpoint)).json()).toEqual({ names: ["E2E_LISTED_TOKEN", "E2E_ABSENT_TOKEN"], revision: expect.any(String), variables: [
    { name: "E2E_LISTED_TOKEN", present: true, source: "loginShell" },
    { name: "E2E_ABSENT_TOKEN", present: false, source: null },
  ] });
  const evidence = artifactsDir("agent-environment-list");
  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(evidence, { recursive: true });
    await panel.screenshot({ path: join(evidence, "settings.png") });
  }

  for (const agent of ["claude", "codex"]) {
    const title = `Read the ${agent} environment`;
    const dispatched = await page.request.post(daemon.baseURL + "/api/tasks", {
      data: { agent, runtime: "sdk", repoRoot: daemon.repo, title, intent: title, kind: "ship", workflowId: null },
    });
    expect(dispatched.ok()).toBe(true);
    await expect.poll(() => recordsIn<{ listedEnvironmentMatches: boolean; unlistedEnvironmentAbsent: boolean; cwd: string }>(
      join(daemon.recordDir, agent), (file) => file.startsWith("invocation-"),
    ).some((record) => record.cwd.includes("worktree-pools") && record.listedEnvironmentMatches && record.unlistedEnvironmentAbsent),
    { timeout: 60_000 }).toBe(true);
    await page.goto(daemon.baseURL);
    await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").filter({ hasText: title }).first().click();
    const warning = page.getByText("Missing agent environment variables at launch: E2E_ABSENT_TOKEN");
    await expect(warning).toBeVisible();
    const task = await dispatched.json() as { id: string };
    const sessions = await (await page.request.get(daemon.baseURL + "/api/sessions")).json() as
      Array<{ id: string; task?: { id: string } }>;
    const session = sessions.find((item) => item.task?.id === task.id)!;
    await expect.poll(async () => {
      const response = await page.request.get(daemon.baseURL + "/api/sessions/" + encodeURIComponent(session.id) + "/transcript");
      const transcript = await response.json() as { messages: unknown[] };
      expect(JSON.stringify(transcript).includes("synthetic-profile-credential")).toBe(false);
      return transcript.messages.length;
    }).toBeGreaterThan(0);
    if (process.env.MC_E2E_EVIDENCE && agent === "codex") {
      await page.locator(".console-detail").screenshot({ path: join(evidence, "session.png") });
    }
  }
  expect(daemon.readLog().includes("synthetic-profile-credential")).toBe(false);
  expect((await (await page.request.get(daemon.baseURL + "/api/sessions")).text()).includes("synthetic-profile-credential")).toBe(false);
});

test.describe("Agent environment Settings failures", () => {
  const savedName = "E2E_LISTED_TOKEN";
  const savedRow: [string, string] = [savedName, "Present (login shell)"];
  test.beforeEach(async ({ daemon, request }) => {
    await expect(await request.put(daemon.baseURL + "/api/feature-flags", {
      data: { kind: "flag", id: "agent-environment", enabled: true },
    })).toBeOK();
    await expect(await request.put(daemon.baseURL + "/api/agent-environment", { data: { names: [savedName] } })).toBeOK();
  });

  async function expectError(panel: Locator, message: string, image: string) {
    const alert = panel.getByRole("alert");
    await expect(alert).toHaveText(message);
    await expect(alert).toBeVisible();
    if (process.env.MC_E2E_EVIDENCE) {
      const dir = artifactsDir("agent-environment-list");
      mkdirSync(dir, { recursive: true });
      await alert.hover();
      await panel.screenshot({ path: join(dir, image) });
    }
  }

  test("a failed settings read shows an error and disables editing until the saved names load", async ({ daemon, dashboard: page }) => {
    await page.route(daemon.baseURL + "/api/agent-environment", (route) => route.fulfill({ status: 503, json: {} }), { times: 1 });
    await page.goto(daemon.baseURL + "/#/settings/harnesses");
    const panel = page.getByRole("region", { name: "Agent environment" });
    await expectError(panel, "Could not read agent environment settings.", "failed-read.png");
    await expect(panel.getByRole("textbox")).toBeDisabled();
    await expect(panel.getByRole("button", { name: "Add variable" })).toBeDisabled();
    await expect(panel.getByRole("listitem")).toHaveCount(0);
    await page.reload();
    await expect(panel.getByRole("textbox")).toBeEnabled();
    await expect(panel.getByRole("textbox")).toBeEmpty();
    await expectVariables(panel, [savedRow]);
  });

  test("opening Settings retries a superseded read and enables the editor with the winning names", async ({ daemon, dashboard: page }) => {
    const endpoint = daemon.baseURL + "/api/agent-environment";
    // Save the delayed name with its gate open, then hold the panel's initial real GET.
    const release = join(daemon.recordDir, "probe-release");
    const marker = join(daemon.recordDir, "probe-started");
    writeFileSync(release, "");
    await expect(await page.request.put(endpoint, { data: { names: ["E2E_DELAYED_NAME"] } })).toBeOK();
    unlinkSync(marker);
    unlinkSync(release);
    const first = page.waitForResponse((res) => res.url() === endpoint && res.request().method() === "GET");
    await page.goto(daemon.baseURL + "/#/settings/harnesses");
    await expect.poll(() => existsSync(marker)).toBe(true);
    await expect(await page.request.put(endpoint, { data: { names: ["E2E_NEWER_NAME"] } })).toBeOK();
    writeFileSync(release, "");
    expect((await first).status()).toBe(409);
    const panel = page.getByRole("region", { name: "Agent environment" });
    await expect(panel.getByRole("textbox")).toBeEmpty();
    await expect(panel.getByRole("textbox")).toBeEditable();
    await expectVariables(panel, [["E2E_NEWER_NAME", "Present (daemon)"]]);
    await expect(panel.getByRole("alert")).toHaveCount(0);
    if (process.env.MC_E2E_EVIDENCE) {
      const dir = artifactsDir("agent-environment-list");
      mkdirSync(dir, { recursive: true });
      await panel.screenshot({ path: join(dir, "retried-read.png") });
    }
  });

  test("repeated read conflicts stop after one automatic retry and can be retried in the panel", async ({ daemon, dashboard: page }) => {
    let reads = 0;
    await page.route(daemon.baseURL + "/api/agent-environment", async (route) => {
      reads++;
      return reads <= 2 ? route.fulfill({ status: 409, json: { variables: null } }) : route.continue();
    });
    await page.goto(daemon.baseURL + "/#/settings/harnesses");
    const panel = page.getByRole("region", { name: "Agent environment" });
    await expectError(panel, "Could not read agent environment settings.", "read-retry-exhausted.png");
    expect(reads).toBe(2);
    await expect(panel.getByRole("textbox")).toBeDisabled();
    await panel.getByRole("button", { name: "Retry loading variable names" }).click();
    await expect(panel.getByRole("textbox")).toBeEmpty();
    await expect(panel.getByRole("textbox")).toBeEditable();
    expect(reads).toBe(3);
  });

  for (const scenario of [
    { title: "an invalid draft", draft: "AN_ASSIGNMENT=invalid", sendsPut: false,
      error: "Enter one valid variable name. Assignments and reserved names are unavailable.", image: "invalid-draft.png" },
    { title: "two names on one line", draft: "VALID_NAME ANNOTATION", sendsPut: false,
      error: "Enter one valid variable name. Assignments and reserved names are unavailable.", image: "one-per-line.png" },
    { title: "a duplicate name", draft: savedName, sendsPut: false,
      error: "This variable is already in the list.", image: "duplicate-name.png" },
    { title: "a failed save", draft: "E2E_REPLACEMENT_NAME", sendsPut: true,
      error: "Could not save agent environment settings.", image: "failed-save.png" },
  ]) {
    test(`${scenario.title} shows its error and preserves the previously saved list`, async ({ daemon, dashboard: page }) => {
      await page.goto(daemon.baseURL + "/#/settings/harnesses");
      const panel = page.getByRole("region", { name: "Agent environment" });
      const names = panel.getByRole("textbox");
      await expectVariables(panel, [savedRow]);
      const writes: unknown[] = [];
      await page.route(daemon.baseURL + "/api/agent-environment", (route) => {
        if (route.request().method() !== "PUT") return route.continue();
        writes.push(route.request().postDataJSON());
        return route.fulfill({ status: 503, json: {} });
      });
      await names.fill(scenario.draft);
      await panel.getByRole("button", { name: "Add variable" }).click();
      await expectError(panel, scenario.error, scenario.image);
      expect(writes).toEqual(scenario.sendsPut ? [{ names: [savedName, scenario.draft], expectedRevision: expect.stringMatching(/^[a-f0-9]{64}$/) }] : []);
      await expect(names).toHaveValue(scenario.draft);
      await expectVariables(panel, [savedRow]);
      await page.reload();
      await expect(names).toBeEmpty();
      await expectVariables(panel, [savedRow]);
    });
  }

  test("a multiline paste is rejected without changing the draft or saved list", async ({ daemon, dashboard: page }) => {
    await page.goto(daemon.baseURL + "/#/settings/harnesses");
    const panel = page.getByRole("region", { name: "Agent environment" });
    const input = panel.getByRole("textbox", { name: "Variable name" });
    await expectVariables(panel, [savedRow]);
    await input.fill("E2E_DRAFT");
    await page.context().grantPermissions(["clipboard-write"], { origin: daemon.baseURL });
    await page.evaluate(() => navigator.clipboard.writeText("E2E_FIRST\nE2E_SECOND"));
    await input.press("ControlOrMeta+v");

    await expectError(panel, "Add one variable name at a time.", "multiline-paste.png");
    await expect(input).toHaveValue("E2E_DRAFT");
    await expectVariables(panel, [savedRow]);
    await page.reload();
    await expectVariables(panel, [savedRow]);
  });

  test("a form with 32 saved names rejects a 33rd and preserves the full list", async ({ daemon, dashboard: page }) => {
    const savedNames = Array.from({ length: 32 }, (_, i) => `E2E_LIMIT_${i + 1}`);
    await expect(await page.request.put(daemon.baseURL + "/api/agent-environment", { data: { names: savedNames } })).toBeOK();
    if (process.env.MC_E2E_EVIDENCE) await page.setViewportSize({ width: 1280, height: 1800 });
    await page.goto(daemon.baseURL + "/#/settings/harnesses");
    const panel = page.getByRole("region", { name: "Agent environment" });
    const names = panel.getByRole("listitem").locator("code");
    const input = panel.getByRole("textbox", { name: "Variable name" });
    await expect(names).toHaveText(savedNames);
    await input.fill("E2E_LIMIT_33");
    await panel.getByRole("button", { name: "Add variable" }).click();

    await expectError(panel, "You can add up to 32 variable names.", "name-limit.png");
    await expect(input).toHaveValue("E2E_LIMIT_33");
    await expect(names).toHaveText(savedNames);
    await page.reload();
    await expect(names).toHaveText(savedNames);
  });

  test("an older tab cannot overwrite a completed save and can edit again after reloading the winner", async ({ daemon, dashboard: page }) => {
    const endpoint = daemon.baseURL + "/api/agent-environment";
    const other = await page.context().newPage();
    const stale = page.getByRole("region", { name: "Agent environment" });
    const newer = other.getByRole("region", { name: "Agent environment" });
    for (const tab of [page, other]) await tab.goto(daemon.baseURL + "/#/settings/harnesses");
    for (const panel of [stale, newer]) await expectVariables(panel, [savedRow]);
    await stale.getByRole("textbox").fill("E2E_STALE_NAME");
    await newer.getByRole("textbox").fill("E2E_NEWER_NAME");
    await newer.getByRole("button", { name: "Add variable" }).click();
    await expectVariables(newer, [savedRow, ["E2E_NEWER_NAME", "Present (daemon)"]]);
    const rejected = page.waitForResponse((r) => r.url() === endpoint && r.request().method() === "PUT");
    await stale.getByRole("button", { name: "Add variable" }).click();
    expect((await rejected).status()).toBe(409);
    await expect(stale.getByRole("textbox")).toHaveValue("E2E_STALE_NAME");
    await expectError(stale, "Another save changed the variable names. Showing the current settings.", "round16-stale-tab.png");
    expect((await (await page.request.get(endpoint)).json()).names).toEqual([savedName, "E2E_NEWER_NAME"]);
    await expectVariables(stale, [savedRow, ["E2E_NEWER_NAME", "Present (daemon)"]]);
    await stale.getByRole("button", { name: "Delete E2E_NEWER_NAME" }).click();
    await expectVariables(stale, [savedRow]);
    await page.reload();
    await expectVariables(stale, [savedRow]);
    await stale.getByRole("button", { name: `Delete ${savedName}` }).click();
    await expect(stale.getByText("No variables configured.")).toBeVisible();
    await page.reload();
    await expect(stale.getByText("No variables configured.")).toBeVisible();
  });

  test("a later save supersedes an in-flight status probe and the first tab shows the committed names", async ({ daemon, dashboard: page }) => {
    const endpoint = daemon.baseURL + "/api/agent-environment";
    await page.goto(daemon.baseURL + "/#/settings/harnesses");
    const panel = page.getByRole("region", { name: "Agent environment" });
    const names = panel.getByRole("textbox");
    await expectVariables(panel, [savedRow]);
    await names.fill("E2E_DELAYED_NAME");
    const first = page.waitForResponse((res) => res.url() === endpoint && res.request().method() === "PUT");
    await panel.getByRole("button", { name: "Add variable" }).click();
    await expect.poll(() => existsSync(join(daemon.recordDir, "probe-started"))).toBe(true);
    const newer = await page.request.put(endpoint, { data: { names: ["E2E_NEWER_NAME"] } });
    await expect(newer).toBeOK();
    const committed = await newer.json();
    writeFileSync(join(daemon.recordDir, "probe-release"), "");
    const superseded = await first;
    expect(superseded.status()).toBe(409);
    expect(await superseded.json()).toEqual({ names: ["E2E_NEWER_NAME"], revision: committed.revision, variables: null });
    await expect(names).toHaveValue("E2E_DELAYED_NAME");
    await expectVariables(panel, [["E2E_NEWER_NAME", "Present (daemon)"]]);
    await expectError(panel, "Another save changed the variable names. Showing the current settings.", "superseded-save.png");
  });

  test("the API rejects an unknown field on a valid names list without echoing its value", async ({ daemon, request }) => {
    const endpoint = daemon.baseURL + "/api/agent-environment";
    const valid = { names: ["E2E_REPLACEMENT_NAME"] };
    const extraValue = "rejected-input";
    const invalid = await request.put(endpoint, { data: { ...valid, value: extraValue } });
    expect(invalid.status()).toBe(400);
    expect(await invalid.text()).not.toContain(extraValue);
    expect(await (await request.get(endpoint)).json()).toEqual({ names: [savedName], revision: expect.any(String), variables: [{ name: savedName, present: true, source: "loginShell" }] });
    await expect(await request.put(endpoint, { data: valid })).toBeOK();
    for (const reserved of ["MISSION_API_TOKEN", "CODEX_HOME"]) {
      expect((await request.put(endpoint, { data: { names: [reserved] } })).status()).toBe(400);
    }
  });
});
