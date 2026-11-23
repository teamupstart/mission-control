import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Locator } from "@playwright/test";
import { test, expect } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { recordsIn } from "../fixtures/records.ts";

test.use({ daemonEnv: { SHELL: fileURLToPath(new URL("../fixtures/agent-environment-shell.sh", import.meta.url)) } });

test("named login-shell variables reach both SDK processes and a missing name warns on the session", async ({ daemon, dashboard: page }) => {
  test.setTimeout(150_000);
  const endpoint = daemon.baseURL + "/api/agent-environment";
  expect((await page.request.get(endpoint)).status()).toBe(404);
  await page.goto(daemon.baseURL + "/#/settings/feature-flags");
  await page.getByRole("button", { name: "Agent environment: off" }).click();
  await page.goto(daemon.baseURL + "/#/settings/harnesses");
  const panel = page.getByRole("region", { name: "Agent environment" });
  await panel.getByRole("textbox").fill("E2E_LISTED_TOKEN\nE2E_ABSENT_TOKEN");
  const save = panel.getByRole("button", { name: "Save variable names" });
  await expect(save).toHaveAccessibleDescription("Apply these names to future agent launches");
  await save.click();
  await expect(panel.getByText("Present (login shell)", { exact: false })).toBeVisible();
  await page.reload();
  await expect(panel.getByRole("listitem")).toHaveText([
    "E2E_LISTED_TOKEN Present (login shell)", "E2E_ABSENT_TOKEN Absent",
  ]);
  expect(await (await page.request.get(endpoint)).json()).toEqual({ variables: [
    { name: "E2E_LISTED_TOKEN", present: true, source: "loginShell" },
    { name: "E2E_ABSENT_TOKEN", present: false, source: null },
  ] });
  await save.hover();
  await expect(page.locator(".tooltip").filter({ hasText: "Apply these names to future agent launches" })).toBeVisible();
  const evidence = artifactsDir("agent-environment");
  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, "settings.png") });
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
  const savedStatus = savedName + " Present (login shell)";
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
      const dir = artifactsDir("agent-environment");
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
    await expect(panel.getByRole("button", { name: "Save variable names" })).toBeDisabled();
    await expect(panel.getByRole("listitem")).toHaveCount(0);
    await page.reload();
    await expect(panel.getByRole("textbox")).toBeEnabled();
    await expect(panel.getByRole("textbox")).toHaveValue(savedName);
    await expect(panel.getByRole("listitem")).toHaveText([savedStatus]);
  });

  for (const scenario of [
    { title: "an invalid draft", draft: "AN_ASSIGNMENT=invalid", sendsPut: false,
      error: "Enter up to 32 unique variable names. Assignments and reserved names are unavailable.", image: "invalid-draft.png" },
    { title: "a failed save", draft: "E2E_REPLACEMENT_NAME", sendsPut: true,
      error: "Could not save agent environment settings.", image: "failed-save.png" },
  ]) {
    test(`${scenario.title} shows its error and preserves the previously saved list`, async ({ daemon, dashboard: page }) => {
      await page.goto(daemon.baseURL + "/#/settings/harnesses");
      const panel = page.getByRole("region", { name: "Agent environment" });
      const names = panel.getByRole("textbox");
      await expect(names).toHaveValue(savedName);
      const writes: unknown[] = [];
      await page.route(daemon.baseURL + "/api/agent-environment", (route) => {
        if (route.request().method() !== "PUT") return route.continue();
        writes.push(route.request().postDataJSON());
        return route.fulfill({ status: 503, json: {} });
      });
      await names.fill(scenario.draft);
      await panel.getByRole("button", { name: "Save variable names" }).click();
      await expectError(panel, scenario.error, scenario.image);
      expect(writes).toEqual(scenario.sendsPut ? [{ names: [scenario.draft] }] : []);
      await expect(names).toHaveValue(scenario.draft);
      await expect(panel.getByRole("listitem")).toHaveText([savedStatus]);
      await page.reload();
      await expect(names).toHaveValue(savedName);
      await expect(panel.getByRole("listitem")).toHaveText([savedStatus]);
    });
  }

  test("the API rejects an unknown field on a valid names list without echoing its value", async ({ daemon, request }) => {
    const endpoint = daemon.baseURL + "/api/agent-environment";
    const valid = { names: ["E2E_REPLACEMENT_NAME"] };
    const extraValue = "rejected-input";
    const invalid = await request.put(endpoint, { data: { ...valid, value: extraValue } });
    expect(invalid.status()).toBe(400);
    expect(await invalid.text()).not.toContain(extraValue);
    expect(await (await request.get(endpoint)).json()).toEqual({ variables: [{ name: savedName, present: true, source: "loginShell" }] });
    await expect(await request.put(endpoint, { data: valid })).toBeOK();
    expect((await request.put(endpoint, { data: { names: ["MISSION_API_TOKEN"] } })).status()).toBe(400);
  });
});
