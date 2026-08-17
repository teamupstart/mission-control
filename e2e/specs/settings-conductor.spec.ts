import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { FAKE_CONDUCTOR_VERSION, readConductorInvocations } from "../fixtures/conductor.ts";
import { recordsIn } from "../fixtures/records.ts";

// The installed-engine Phase 1 vertical slice. The fake CLI records argv and owns its project
// registry, while the browser drives the separate Mission Control consent write. No agent binary
// or installer runs, and no model token can be spent.

test.use({ daemonEnv: { MISSION_PIPELINE_TICK_MS: "1000" } });

const EVIDENCE = artifactsDir("settings-conductor");

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage: true });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/settings-conductor/${name}.png`);
}

async function openConductor(page: Page, baseURL: string): Promise<void> {
  await page.goto(`${baseURL}/#/settings/conductor`);
  await expect(page.getByRole("tab", { name: /Conductor/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
}

function installerTerminals(recordDir: string): { argv: string[] }[] {
  return recordsIn<{ argv: string[] }>(recordDir, (file) => file.startsWith("cmux-"));
}

test("an installed engine registers a workspace and observes it through one honest flow", async ({
  page,
  daemon,
}) => {
  test.setTimeout(60_000);
  await openConductor(page, daemon.baseURL);
  await expect(page.getByText(/Installed at .*conduct-ts/)).toBeVisible();
  await expect(page.getByText(new RegExp(`version ${FAKE_CONDUCTOR_VERSION}`))).toBeVisible();

  const search = page.getByPlaceholder("Search workspace repositories");
  await search.fill("demo-repo");
  const row = page.locator("li.conductor-repo").filter({ hasText: daemon.repo });
  await expect(row).toContainText("Not registered");
  await expect(row).toContainText("Not observed");
  await expect(row).toContainText("Dispatch not ready");
  await expect(row.getByRole("button", { name: "Register and observe" })).toBeEnabled();
  await shoot(page, "01-ready-to-register");

  await page.setViewportSize({ width: 680, height: 900 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "the commissioning line and repository actions must not create horizontal clipping",
  ).toBe(true);
  await search.focus();
  await page.keyboard.press("Tab");
  await expect(row.getByRole("button", { name: "Register and observe" })).toBeFocused();

  const registrationResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/pipelines/register") && response.request().method() === "POST",
  );
  const observationResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/pipelines/config") && response.request().method() === "PUT",
  );
  await row.getByRole("button", { name: "Register and observe" }).click();
  expect((await (await registrationResponse).json()).registration.ok).toBe(true);
  await expect(row).toContainText("Registered", { timeout: 20_000 });
  expect((await observationResponse).ok()).toBe(true);
  await expect(row).toContainText("Observed", { timeout: 15_000 });
  await expect(row).toContainText("Dispatch ready", { timeout: 15_000 });
  await expect(row.getByText("Ready", { exact: true })).toBeVisible();
  await expect(page.getByText(/Registered and observed/)).toBeVisible();

  const calls = readConductorInvocations(daemon.home);
  expect(calls.filter((call) => call.argv[0] === "register")).toEqual([
    { argv: ["register", daemon.repo], cwd: daemon.repo },
  ]);
  const config = await page.request.get(`${daemon.baseURL}/api/pipelines/config`);
  expect((await config.json()).config).toMatchObject({
    enabled: true,
    repos: [{ provider: "ai-conductor", repoRoot: daemon.repo, enabled: true }],
  });

  await expect(row.getByText("Ready", { exact: true })).toBeVisible();

  await page.goto(`${daemon.baseURL}/#/fleet`);
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  const repo = dialog.getByPlaceholder("search repos or type a path…");
  const kind = dialog.getByRole("combobox", { name: "Kind", exact: true });
  await repo.fill(daemon.repo);
  await page.keyboard.press("Escape");
  await expect(kind.locator('option[value="pipeline"]')).toHaveCount(1);
  await kind.selectOption("pipeline");
  await expect(kind).toHaveValue("pipeline");
  await shoot(page, "02-dispatch-ready");

  await kind.selectOption("ship");
  await repo.fill(daemon.secondRepo);
  await page.keyboard.press("Escape");
  await expect(kind.locator('option[value="pipeline"]')).toHaveCount(0);
});

test("Engineer host defaults to SDK and persists an explicit Terminal choice", async ({
  page,
  daemon,
}) => {
  await openConductor(page, daemon.baseURL);
  const sdk = page.getByRole("radio", { name: /Claude Agent SDK/ });
  const terminal = page.getByRole("radio", { name: /Terminal/ });

  await expect(sdk).toBeChecked();
  await expect(terminal).not.toBeChecked();
  await expect(page.getByText(/shipped default, with no terminal fallback/)).toBeVisible();

  const selectTerminal = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/pipelines/config") && response.request().method() === "PUT",
  );
  await terminal.check();
  expect((await selectTerminal).ok()).toBe(true);
  await page.reload();
  await expect(terminal).toBeChecked();
  await expect(page.getByText(/explicit compatibility host/)).toBeVisible();

  const selectSdk = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/pipelines/config") && response.request().method() === "PUT",
  );
  await sdk.check();
  expect((await selectSdk).ok()).toBe(true);
  await expect(sdk).toBeChecked();
  await expect(
    page.getByText(/background build daemon keeps its own tmux supervision/),
  ).toBeVisible();
  await expect(page.getByText(/Installed at .*conduct-ts/)).toBeVisible();
  await shoot(page, "04-sdk-runtime-selected");
});

test("an open Dispatch modal changes only after exact observation succeeds", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  const repo = dialog.getByPlaceholder("search repos or type a path…");
  const kind = dialog.getByRole("combobox", { name: "Kind", exact: true });
  await repo.fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await expect(kind.locator('option[value="pipeline"]')).toHaveCount(0);

  const registration = await dashboard.request.post(`${daemon.baseURL}/api/pipelines/register`, {
    data: { provider: "ai-conductor", repoRoot: daemon.repo },
  });
  expect((await registration.json()).registration.ok).toBe(true);
  await expect(kind.locator('option[value="pipeline"]')).toHaveCount(0);

  const consent = await dashboard.request.put(`${daemon.baseURL}/api/pipelines/config`, {
    data: {
      enabled: true,
      foremanMechanicalTriage: false,
      repos: [{ provider: "ai-conductor", repoRoot: daemon.repo, enabled: true }],
    },
  });
  expect(consent.ok()).toBe(true);
  await expect(kind.locator('option[value="pipeline"]')).toHaveCount(1);

  await repo.fill(daemon.secondRepo);
  await dashboard.keyboard.press("Escape");
  await expect(kind.locator('option[value="pipeline"]')).toHaveCount(0);

  const replacement = await dashboard.request.put(`${daemon.baseURL}/api/pipelines/config`, {
    data: {
      enabled: true,
      foremanMechanicalTriage: false,
      repos: [{ provider: "ai-conductor", repoRoot: daemon.secondRepo, enabled: true }],
    },
  });
  expect(replacement.ok()).toBe(true);
  await expect(kind.locator('option[value="pipeline"]')).toHaveCount(1);

  await repo.fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await expect(kind.locator('option[value="pipeline"]')).toHaveCount(0);
});

test("a stale consent response never replaces or restores a newer repository edit", async ({
  page,
  daemon,
}) => {
  for (const repoRoot of [daemon.repo, daemon.secondRepo]) {
    const registration = await page.request.post(`${daemon.baseURL}/api/pipelines/register`, {
      data: { provider: "ai-conductor", repoRoot },
    });
    expect((await registration.json()).registration.ok).toBe(true);
  }
  const seeded = await page.request.put(`${daemon.baseURL}/api/pipelines/config`, {
    data: {
      enabled: true,
      foremanMechanicalTriage: false,
      repos: [
        { provider: "ai-conductor", repoRoot: daemon.repo, enabled: false },
        { provider: "ai-conductor", repoRoot: daemon.secondRepo, enabled: false },
      ],
    },
  });
  expect(seeded.ok()).toBe(true);

  let writes = 0;
  await page.route("**/api/pipelines/config", async (route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }
    writes += 1;
    if (writes === 1) {
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 400));
      await route.fulfill({ response });
      return;
    }
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "forced second consent refusal" }),
    });
  });

  await openConductor(page, daemon.baseURL);
  const first = page.getByRole("checkbox", { name: "Observe pipelines in demo-repo" });
  const second = page.getByRole("checkbox", { name: "Observe pipelines in second-repo" });
  await expect(first).toBeEnabled();
  await expect(second).toBeEnabled();
  await first.click();
  await second.click();

  await expect(page.getByText(/forced second consent refusal/)).toBeVisible();
  await expect(first).toBeChecked();
  await expect(second).not.toBeChecked();
  const config = await page.request.get(`${daemon.baseURL}/api/pipelines/config`);
  expect((await config.json()).config.repos).toEqual([
    { provider: "ai-conductor", repoRoot: daemon.secondRepo, enabled: false },
    { provider: "ai-conductor", repoRoot: daemon.repo, enabled: true },
  ]);
});

test.describe("when the provider does not confirm registration", () => {
  test.use({ daemonEnv: { MC_E2E_CONDUCTOR_REGISTER_MODE: "unconfirmed" } });

  test("observation is never granted", async ({ page, daemon }) => {
    await openConductor(page, daemon.baseURL);
    await page.getByPlaceholder("Search workspace repositories").fill("demo-repo");
    const row = page.locator("li.conductor-repo").filter({ hasText: daemon.repo });
    await row.getByRole("button", { name: "Register and observe" }).click();

    await expect(page.getByText(/without confirming this exact repository/)).toBeVisible();
    await expect(row).toContainText("Not registered");
    await expect(row).toContainText("Not observed");
    const config = await page.request.get(`${daemon.baseURL}/api/pipelines/config`);
    expect((await config.json()).config).toMatchObject({ enabled: false, repos: [] });
  });
});

test("partial success stays registered and recovers without a second registration", async ({
  page,
  daemon,
}) => {
  test.setTimeout(60_000);
  let refused = false;
  await page.route("**/api/pipelines/config", async (route) => {
    if (route.request().method() === "PUT" && !refused) {
      refused = true;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "forced observation refusal" }),
      });
      return;
    }
    await route.continue();
  });

  await openConductor(page, daemon.baseURL);
  await page.getByPlaceholder("Search workspace repositories").fill("demo-repo");
  const row = page.locator("li.conductor-repo").filter({ hasText: daemon.repo });
  await row.getByRole("button", { name: "Register and observe" }).click();

  await expect(page.getByText(/Registered with Conductor; Mission Control observation/)).toBeVisible();
  await expect(row).toContainText("Registered");
  await expect(row).toContainText("Not observed");
  await expect(row.getByRole("button", { name: "Enable observation" })).toBeVisible();
  await shoot(page, "03-partial-success");

  await page.unroute("**/api/pipelines/config");
  await row.getByRole("button", { name: "Enable observation" }).click();
  await expect(row).toContainText("Dispatch ready", { timeout: 15_000 });
  expect(
    readConductorInvocations(daemon.home).filter((call) => call.argv[0] === "register"),
  ).toHaveLength(1);
});

test.describe("with no engine or verified source checkout", () => {
  test.use({
    daemonEnv: {
      MISSION_PIPELINE_TICK_MS: "1000",
      MC_E2E_CONDUCTOR_STARTS_MISSING: "1",
    },
  });

  test("Conductor stays discoverable and falls back to copyable upstream instructions", async ({
    page,
    daemon,
  }) => {
    const pipelineReads: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/pipelines/")) pipelineReads.push(request.url());
    });
    await page.goto(`${daemon.baseURL}/#/settings/display`);
    await expect(page.getByRole("tab", { name: /Display/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.waitForTimeout(4_250);
    expect(pipelineReads, "unrelated Settings destinations must not probe Conductor").toEqual([]);

    await openConductor(page, daemon.baseURL);
    await expect.poll(() => pipelineReads.length).toBeGreaterThan(0);
    await expect(page.getByText(/Setup needed .*conduct-ts is not on this daemon/)).toBeVisible();
    await expect(page.getByRole("button", { name: "I installed it, check again" })).toBeVisible();
    await expect(page.getByText("git clone https://github.com/mancej/ai-conductor.git")).toBeVisible();
    await expect(page.getByText("cd ai-conductor && ./bin/install")).toBeVisible();
    await expect(page.getByRole("button", { name: "Review installer" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Open installer/i })).toHaveCount(0);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByRole("button", { name: "Copy clone" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "git clone https://github.com/mancej/ai-conductor.git",
    );
    await shoot(page, "04-missing-engine");

    await page.keyboard.press("Meta+k");
    const palette = page.getByRole("dialog", { name: "Search everything" });
    await palette.getByRole("combobox", { name: "Search everything" }).fill("conductor");
    await expect(palette.getByRole("option", { name: /Conductor settings/ })).toBeVisible();
  });
});

test.describe("with a verified local Conductor checkout", () => {
  test.use({
    daemonEnv: {
      MISSION_PIPELINE_TICK_MS: "1000",
      MC_E2E_CONDUCTOR_STARTS_MISSING: "1",
      MC_E2E_CONDUCTOR_CHECKOUT: "1",
    },
  });

  test("reviews scope, opens the exact installer in a hosted terminal, then rechecks honestly", async ({
    page,
    daemon,
  }) => {
    test.setTimeout(75_000);
    expect(daemon.conductorCheckout).not.toBeNull();
    const checkout = daemon.conductorCheckout!;
    await openConductor(page, daemon.baseURL);

    await expect(page.getByText(checkout, { exact: true })).toBeVisible();
    await expect(page.getByText("github.com/mancej/ai-conductor", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open installer" })).toHaveCount(0);
    await page.getByRole("button", { name: "Review installer" }).click();

    const confirmation = page.getByRole("region", { name: "Confirm Conductor installer" });
    await expect(confirmation).toContainText("Confirm machine-wide installation");
    await expect(confirmation).toContainText(checkout);
    await expect(confirmation).toContainText(`${checkout}/bin/install`);
    await expect(confirmation).toContainText("Link conduct-ts under your local bin directory");
    await expect(confirmation).toContainText("Link Conductor skills for supported agents");
    await expect(confirmation).toContainText("Update Claude user settings and hooks");
    await expect(confirmation).toContainText("Create or update ~/.ai-conductor configuration");
    await expect(confirmation).toContainText("Optionally install global Puppeteer");
    await confirmation.getByLabel("Installer terminal backend").selectOption("cmux");
    await shoot(page, "05-installer-confirmation");

    await page.setViewportSize({ width: 680, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      "guided installation must not create horizontal clipping",
    ).toBe(true);
    await shoot(page, "07-installer-narrow");
    await page.setViewportSize({ width: 1280, height: 720 });

    await confirmation.getByRole("button", { name: "Open installer" }).click();
    await expect(page.getByRole("status")).toContainText("Installer terminal opened");
    await expect(page.getByText(/Setup needed .*conduct-ts is not on this daemon/)).toBeVisible();
    await expect.poll(() => installerTerminals(daemon.recordDir).length).toBe(1);
    const argv = installerTerminals(daemon.recordDir)[0]?.argv ?? [];
    expect(argv[0]).toBe("new-workspace");
    expect(argv[argv.indexOf("--cwd") + 1]).toBe(checkout);
    expect(argv[argv.indexOf("--name") + 1]).toMatch(/^ai-conductor installer-[a-z0-9]+$/);
    const command = argv[argv.indexOf("--command") + 1] ?? "";
    expect(command).toContain(`${checkout}/bin/install`);
    expect(command).toContain("read -r _");
    await shoot(page, "06-installer-opened");

    daemon.installFakeConductor();
    await page.getByRole("button", { name: "I installed it, check again" }).click();
    await expect(page.getByText(/Installed at .*conduct-ts/)).toBeVisible();
    await expect(page.getByText(new RegExp(`version ${FAKE_CONDUCTOR_VERSION}`))).toBeVisible();
    await expect(page.getByRole("button", { name: "Review installer" })).toHaveCount(0);

    await page.getByPlaceholder("Search workspace repositories").fill("demo-repo");
    const row = page.locator("li.conductor-repo").filter({ hasText: daemon.repo });
    await row.getByRole("button", { name: "Register and observe" }).click();
    await expect(row).toContainText("Dispatch ready", { timeout: 15_000 });

    await page.goto(`${daemon.baseURL}/#/fleet`);
    await page.getByRole("button", { name: "Dispatch" }).click();
    const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
    const repo = dialog.getByPlaceholder("search repos or type a path…");
    const kind = dialog.getByRole("combobox", { name: "Kind", exact: true });
    await repo.fill(daemon.repo);
    await page.keyboard.press("Escape");
    await expect(kind.locator('option[value="pipeline"]')).toHaveCount(1);
    await repo.fill(daemon.secondRepo);
    await page.keyboard.press("Escape");
    await expect(kind.locator('option[value="pipeline"]')).toHaveCount(0);
  });

  test("rejects a candidate whose provenance changes after the confirmation is shown", async ({
    page,
    daemon,
  }) => {
    expect(daemon.conductorCheckout).not.toBeNull();
    await openConductor(page, daemon.baseURL);
    await page.getByRole("button", { name: "Review installer" }).click();
    execFileSync(
      "git",
      [
        "-C",
        daemon.conductorCheckout!,
        "remote",
        "set-url",
        "origin",
        "https://github.com/mancej/ai-conductor-lookalike.git",
      ],
      { stdio: "pipe" },
    );
    await page.getByRole("button", { name: "Open installer" }).click();
    await expect(page.getByRole("status")).toContainText("no longer a verified installer");
    expect(installerTerminals(daemon.recordDir)).toEqual([]);
  });

  test("keeps launch disabled and shows manual commands when no terminal can be hosted", async ({
    page,
    daemon,
  }) => {
    await page.route("**/api/terminal-targets", async (route) => {
      const response = await route.fetch();
      const payload = (await response.json()) as {
        targets: { unavailable: string | null }[];
      };
      await route.fulfill({
        response,
        json: {
          targets: payload.targets.map((target) => ({
            ...target,
            unavailable: "Unavailable in this browser test.",
          })),
        },
      });
    });
    await openConductor(page, daemon.baseURL);
    await page.getByRole("button", { name: "Review installer" }).click();
    await expect(page.getByRole("button", { name: "Open installer" })).toBeDisabled();
    await expect(page.getByLabel("Unavailable terminal reasons")).toContainText(
      "Unavailable in this browser test.",
    );
    await expect(page.getByRole("button", { name: "Copy clone" })).toBeVisible();
  });

  test("ignores an old candidate response after a newer engine probe succeeds", async ({
    page,
    daemon,
  }) => {
    let releaseCandidate!: () => void;
    let sawCandidate!: () => void;
    const held = new Promise<void>((resolve) => (releaseCandidate = resolve));
    const requested = new Promise<void>((resolve) => (sawCandidate = resolve));
    await page.route("**/api/pipelines/installers?**", async (route) => {
      sawCandidate();
      await held;
      await route.continue();
    });
    await openConductor(page, daemon.baseURL);
    await requested;
    daemon.installFakeConductor();
    await page.getByRole("button", { name: "I installed it, check again" }).click();
    await expect(page.getByText(/Installed at .*conduct-ts/)).toBeVisible();
    releaseCandidate();
    await page.waitForTimeout(250);
    await expect(page.getByRole("button", { name: "Review installer" })).toHaveCount(0);
  });
});

test.describe("with a verified checkout and an unresponsive hosted terminal", () => {
  test.use({
    daemonEnv: {
      MISSION_PIPELINE_TICK_MS: "1000",
      MC_E2E_CONDUCTOR_STARTS_MISSING: "1",
      MC_E2E_CONDUCTOR_CHECKOUT: "1",
      MC_E2E_CMUX_MODE: "unknown",
    },
  });

  test("reports only that the installer terminal may still be opening", async ({ page, daemon }) => {
    test.setTimeout(35_000);
    await openConductor(page, daemon.baseURL);
    await page.getByRole("button", { name: "Review installer" }).click();
    await page.getByLabel("Installer terminal backend").selectOption("cmux");
    await page.getByRole("button", { name: "Open installer" }).click();
    await expect(page.getByRole("status")).toContainText(/may still be opening|did not report back/i, {
      timeout: 20_000,
    });
    await expect(page.getByRole("status")).not.toContainText("Installer terminal opened");
  });
});
