import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { delimiter, join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { FAKE_CONDUCTOR_VERSION, readConductorInvocations } from "../fixtures/conductor.ts";
import {
  conductorDetail as detail,
  conductorDirectoryEmpty as empty,
  conductorFact,
  conductorRepoRow as repoRow,
  conductorRows as rows,
  conductorTile as tile,
  toggleConductorObservation,
} from "../fixtures/conductor-panel.ts";
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

/**
 * Workspace checkouts, in bulk, so a spec can ask what the panel does with 60 of them.
 *
 * A directory holding a `.git` entry IS a repository to the workspace scan
 * (`src/server/repos.ts`), and nothing in this panel runs git against one - it lists them.
 * So this is a `mkdir`, not sixty `git init`s, and the spec stays a few hundred
 * milliseconds rather than a minute.
 */
function seedBulkRepos(workspace: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => {
    const name = `bulk-${String(i).padStart(3, "0")}`;
    mkdirSync(join(workspace, name, ".git"), { recursive: true });
    return join(workspace, name);
  });
}

function installerTerminals(recordDir: string): { argv: string[] }[] {
  return recordsIn<{ argv: string[] }>(recordDir, (file) => file.startsWith("cmux-"));
}

test.describe("with a stale published Conductor bundle", () => {
  test.use({
    daemonEnv: {
      MISSION_PIPELINE_TICK_MS: "1000",
      MC_E2E_CONDUCTOR_STALE_BUNDLE: "1",
    },
  });

  test("shows the executable version and the exact installer repair", async ({ page, daemon }) => {
    await openConductor(page, daemon.baseURL);

    await expect(page.getByText(/Installed at .*conduct-ts.*version 0\.103\.0/)).toBeVisible();
    await expect(
      page.getByText(/bundle is 0\.103\.0, but its checkout is 0\.104\.0/),
    ).toBeVisible();
    await expect(
      page.getByText(`${daemon.conductor.root}/bin/install`, { exact: false }),
    ).toBeVisible();
    await shoot(page, "08-stale-bundle");
    if (process.env.MC_E2E_EVIDENCE) {
      await page.locator('[data-anchor="conductor/detection"]').screenshot({
        path: `${EVIDENCE}09-stale-bundle-warning.png`,
      });
      // oxlint-disable-next-line no-console
      console.log("CAPTURED e2e/.artifacts/settings-conductor/09-stale-bundle-warning.png");
    }
  });
});

test("an installed engine registers a workspace and observes it through one honest flow", async ({
  page,
  daemon,
}) => {
  test.setTimeout(60_000);
  await openConductor(page, daemon.baseURL);
  await expect(page.getByText(/Installed at .*conduct-ts/)).toBeVisible();
  await expect(page.getByText(new RegExp(`version ${FAKE_CONDUCTOR_VERSION}`))).toBeVisible();

  // The directory opens on what Conductor MANAGES, which on a fresh daemon is nothing at
  // all - so the workspace catalogue is one tile away rather than the first thing drawn.
  await expect(empty(page)).toContainText("Conductor manages nothing here yet");
  await tile(page, "All").click();
  const search = page.getByPlaceholder("Search workspace repositories");
  await search.fill("demo-repo");
  await repoRow(page, daemon.repo).click();

  await expect(conductorFact(page, "Registered with Conductor")).toContainText("No");
  await expect(conductorFact(page, "Dispatch ready")).toContainText("No");
  await expect(detail(page)).toContainText("Conductor does not manage this repository yet");
  const register = detail(page).getByRole("button", { name: "Register and observe" });
  await expect(register).toBeEnabled();
  await shoot(page, "01-ready-to-register");

  await page.setViewportSize({ width: 680, height: 900 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "the commissioning line, directory and detail pane must not create horizontal clipping",
  ).toBe(true);
  await expect(register).toBeVisible();

  const registrationResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/pipelines/register") && response.request().method() === "POST",
  );
  const observationResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/pipelines/config") && response.request().method() === "PUT",
  );
  await register.click();
  expect((await (await registrationResponse).json()).registration.ok).toBe(true);
  await expect(conductorFact(page, "Registered with Conductor")).toContainText("Yes", { timeout: 20_000 });
  expect((await observationResponse).ok()).toBe(true);
  await expect(conductorFact(page, "Dispatch ready")).toContainText("Yes", { timeout: 15_000 });
  await expect(detail(page).getByText("Ready", { exact: true })).toBeVisible();
  await expect(page.getByText(/Registered and observed/)).toBeVisible();
  // The repository the pane is showing is the one that was picked, and registering it
  // moved it into Managed without moving the pane off it.
  await expect(detail(page).getByRole("heading", { name: "demo-repo" })).toBeVisible();
  await expect(tile(page, "Managed")).toHaveAccessibleName("1 Managed");

  const calls = readConductorInvocations(daemon.home);
  expect(calls.filter((call) => call.argv[0] === "register")).toEqual([
    { argv: ["register", daemon.repo], cwd: daemon.repo },
  ]);
  const config = await page.request.get(`${daemon.baseURL}/api/pipelines/config`);
  expect((await config.json()).config).toMatchObject({
    enabled: true,
    repos: [{ provider: "ai-conductor", repoRoot: daemon.repo, enabled: true }],
  });

  await expect(detail(page).getByText("Ready", { exact: true })).toBeVisible();

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

test("Engineer host migrates the legacy SDK value and persists an explicit Terminal choice", async ({
  page,
  daemon,
}) => {
  const migration = await page.request.put(`${daemon.baseURL}/api/pipelines/config`, {
    data: {
      enabled: false,
      foremanMechanicalTriage: false,
      launchRuntime: "claude-sdk",
      repos: [],
    },
  });
  expect((await migration.json()).config.launchRuntime).toBe("agent-sdk");
  await openConductor(page, daemon.baseURL);
  const sdk = page.getByRole("radio", { name: /Managed Agent SDK/ });
  const terminal = page.getByRole("radio", { name: /Terminal/ });

  await expect(sdk).toBeChecked();
  await expect(terminal).not.toBeChecked();
  await expect(page.getByText(/shipped default, with no Terminal fallback/)).toBeVisible();

  const selectTerminal = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/pipelines/config") && response.request().method() === "PUT",
  );
  await terminal.check();
  expect((await selectTerminal).ok()).toBe(true);
  await page.reload();
  await expect(terminal).toBeChecked();
  await expect(
    page.getByText(/retained for legacy uncommissioned work; new commissioned dispatches require Managed Agent SDK/),
  ).toBeVisible();

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
  // Both are registered, so both are in the default Managed list; the pane shows one at a
  // time, so the second write is made by selecting the other row - which is what makes the
  // two writes overlap here exactly as two fast clicks used to.
  await repoRow(page, daemon.repo).click();
  const first = detail(page).getByRole("checkbox", { name: "Observe pipelines in demo-repo" });
  await expect(first).toBeEnabled();
  await toggleConductorObservation(page);
  await repoRow(page, daemon.secondRepo).click();
  const second = detail(page).getByRole("checkbox", { name: "Observe pipelines in second-repo" });
  await expect(second).toBeEnabled();
  await toggleConductorObservation(page);

  await expect(page.getByText(/forced second consent refusal/)).toBeVisible();
  await expect(second).not.toBeChecked();
  await repoRow(page, daemon.repo).click();
  await expect(
    detail(page).getByRole("checkbox", { name: "Observe pipelines in demo-repo" }),
  ).toBeChecked();
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
    await tile(page, "All").click();
    await page.getByPlaceholder("Search workspace repositories").fill("demo-repo");
    await repoRow(page, daemon.repo).click();
    await detail(page).getByRole("button", { name: "Register and observe" }).click();

    await expect(page.getByText(/without confirming this exact repository/)).toBeVisible();
    await expect(conductorFact(page, "Registered with Conductor")).toContainText("No");
    await expect(conductorFact(page, "Dispatch ready")).toContainText("No");
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
  await tile(page, "All").click();
  await page.getByPlaceholder("Search workspace repositories").fill("demo-repo");
  await repoRow(page, daemon.repo).click();
  await detail(page).getByRole("button", { name: "Register and observe" }).click();

  await expect(page.getByText(/Registered with Conductor; Mission Control observation/)).toBeVisible();
  await expect(conductorFact(page, "Registered with Conductor")).toContainText("Yes");
  await expect(conductorFact(page, "Dispatch ready")).toContainText("No");
  await expect(detail(page).getByRole("button", { name: "Enable observation" })).toBeVisible();
  await shoot(page, "03-partial-success");

  await page.unroute("**/api/pipelines/config");
  await detail(page).getByRole("button", { name: "Enable observation" }).click();
  await expect(conductorFact(page, "Dispatch ready")).toContainText("Yes", { timeout: 15_000 });
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
      MC_E2E_CONDUCTOR_NODE_VERSION: "26.7.0",
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

    await expect(page.getByText(/Installer runtime ready - Node\.js 26\.7\.0/)).toBeVisible();
    await expect(page.getByText(checkout, { exact: true })).toBeVisible();
    await expect(page.getByText("github.com/mancej/ai-conductor", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open installer" })).toHaveCount(0);
    await page.getByRole("button", { name: "Review installer" }).click();

    const confirmation = page.getByRole("region", { name: "Confirm Conductor installer" });
    await expect(confirmation).toContainText("Confirm machine-wide installation");
    await expect(confirmation).toContainText(checkout);
    await expect(confirmation).toContainText(`${checkout}/bin/install`);
    await expect(confirmation).toContainText("Node.js 26.7.0 (requires >=26.0.0)");
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
    await expect(page.getByRole("status")).toContainText(
      "Installer terminal opened. Setup is not complete until Mission Control detects conduct-ts",
    );
    await expect(page.getByText(/Setup needed .*conduct-ts is not on this daemon/)).toBeVisible();
    await expect.poll(() => installerTerminals(daemon.recordDir).length).toBe(1);
    const argv = installerTerminals(daemon.recordDir)[0]?.argv ?? [];
    expect(argv[0]).toBe("new-workspace");
    expect(argv[argv.indexOf("--cwd") + 1]).toBe(checkout);
    expect(argv[argv.indexOf("--name") + 1]).toMatch(/^ai-conductor installer-[a-z0-9]+$/);
    const command = argv[argv.indexOf("--command") + 1] ?? "";
    expect(command).toContain("'/usr/bin/env'");
    expect(command).toContain(`'PATH=${join(daemon.home, "bin")}${delimiter}`);
    expect(command).toContain(`${checkout}/bin/install`);
    expect(command).toContain("read -r _");
    await page.getByRole("status").scrollIntoViewIfNeeded();
    await shoot(page, "06-installer-opened");

    daemon.installFakeConductor();
    await page.getByRole("button", { name: "I installed it, check again" }).click();
    await expect(page.getByText(/Installed at .*conduct-ts/)).toBeVisible();
    await expect(page.getByText(new RegExp(`version ${FAKE_CONDUCTOR_VERSION}`))).toBeVisible();
    await expect(page.getByRole("button", { name: "Review installer" })).toHaveCount(0);

    await tile(page, "All").click();
    await page.getByPlaceholder("Search workspace repositories").fill("demo-repo");
    await repoRow(page, daemon.repo).click();
    await detail(page).getByRole("button", { name: "Register and observe" }).click();
    await expect(conductorFact(page, "Dispatch ready")).toContainText("Yes", { timeout: 15_000 });

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

test.describe("with a verified checkout under unsupported Node 24", () => {
  test.use({
    daemonEnv: {
      MISSION_PIPELINE_TICK_MS: "1000",
      MC_E2E_CONDUCTOR_STARTS_MISSING: "1",
      MC_E2E_CONDUCTOR_CHECKOUT: "1",
      MC_E2E_CONDUCTOR_NODE_VERSION: "24.19.0",
    },
  });

  test("surfaces the runtime and refuses installation before a terminal or consent change", async ({
    page,
    daemon,
  }) => {
    expect(daemon.conductorCheckout).not.toBeNull();
    await openConductor(page, daemon.baseURL);

    const warning = page.getByRole("alert");
    await expect(warning).toContainText("Unsupported installer runtime");
    await expect(warning).toContainText("requires Node.js 26 or newer");
    await expect(warning).toContainText("would use Node.js 24.19.0");
    await expect(warning).toContainText(
      "Restart Mission Control with Node.js 26+ active, then check again",
    );
    const review = page.getByRole("button", { name: "Review installer" });
    await expect(review).toBeDisabled();
    const reviewBox = await review.boundingBox();
    expect(reviewBox?.width, "the disabled review control must remain button-sized").toBeLessThan(
      180,
    );
    await expect(page.getByRole("button", { name: "Open installer" })).toHaveCount(0);
    await warning.scrollIntoViewIfNeeded();
    await shoot(page, "11-unsupported-node-runtime");

    const refused = await page.request.post(`${daemon.baseURL}/api/pipelines/install`, {
      data: {
        provider: "ai-conductor",
        checkout: daemon.conductorCheckout!,
        backend: "cmux",
      },
    });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).detail).toContain("requires Node.js 26 or newer");
    expect(installerTerminals(daemon.recordDir)).toEqual([]);
    const config = await page.request.get(`${daemon.baseURL}/api/pipelines/config`);
    expect((await config.json()).config).toMatchObject({ enabled: false, repos: [] });
  });
});

test.describe("with a verified checkout and an unresponsive hosted terminal", () => {
  test.use({
    daemonEnv: {
      MISSION_PIPELINE_TICK_MS: "1000",
      MC_E2E_CONDUCTOR_STARTS_MISSING: "1",
      MC_E2E_CONDUCTOR_CHECKOUT: "1",
      MC_E2E_CONDUCTOR_NODE_VERSION: "26.7.0",
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

// ---- the bound: what the page does with a workspace it does not manage ----
//
// `GET /api/repos` walks the workspace roots and returns every checkout with no cap. On the
// machine this change was written against that is 202, of which ONE was registered, and the
// panel rendered the whole union as one flat list. These are the specs that fail against
// that panel, and the reason the directory exists.
test.describe("with a workspace full of unmanaged checkouts", () => {
  // The repo scan is cached for 30s by default, and these specs create their checkouts after
  // the daemon is already up.
  test.use({ daemonEnv: { MISSION_PIPELINE_TICK_MS: "1000", MISSION_REPOS_CACHE_MS: "0" } });

  /**
 * How many of the bulk checkouts the page has actually drawn.
 *
 * Deliberately shape-agnostic - it reads the pane's text rather than a row selector - so
 * the assertion is about the DEFECT and not about this change's markup: the panel this
 * replaced put all sixty on screen, and would fail this line rather than fail to have a
 * selector. A bounded scroller would pass a height check and fail this one.
 */
async function bulkRowsDrawn(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const text = document.querySelector(".settings-pane")?.textContent ?? "";
    // Distinct names, because one drawn repository contributes its name, its path and its
    // hover copy - what is being counted is repositories on screen, not mentions.
    return new Set(text.match(/bulk-\d{3}/g) ?? []).size;
  });
}

/** Register and observe one repository the way the panel's own two writes do. */
  async function manage(page: Page, baseURL: string, repoRoot: string): Promise<void> {
    const registration = await page.request.post(`${baseURL}/api/pipelines/register`, {
      data: { provider: "ai-conductor", repoRoot },
    });
    expect((await registration.json()).registration.ok).toBe(true);
    const consent = await page.request.put(`${baseURL}/api/pipelines/config`, {
      data: {
        enabled: true,
        foremanMechanicalTriage: false,
        repos: [{ provider: "ai-conductor", repoRoot, enabled: true }],
      },
    });
    expect(consent.ok()).toBe(true);
  }

  test("the directory opens on the managed repositories, and no tile draws more than a page", async ({
    page,
    daemon,
  }) => {
    seedBulkRepos(daemon.workspace, 60);
    await manage(page, daemon.baseURL, daemon.repo);
    const workspaceScan = page.waitForResponse((response) => response.url().includes("/api/repos"));
    await openConductor(page, daemon.baseURL);
    // The scan has landed and the page has drawn what it intends to draw, so a count of
    // zero below means "not drawn" rather than "not fetched yet".
    await workspaceScan;
    await expect(page.getByText(daemon.repo).first()).toBeVisible();

    // The whole point, said first and without reference to this panel's own markup.
    expect(await bulkRowsDrawn(page), "the workspace scan must not be printed").toBe(0);

    // The workspace really is large - the tile says so - and the page still draws one row.
    const workspaceCount = Number((await tile(page, "All").innerText()).split(/\s+/)[0]);
    expect(workspaceCount).toBeGreaterThanOrEqual(61);
    await expect(rows(page)).toHaveCount(1);
    await expect(repoRow(page, daemon.repo)).toHaveAttribute("aria-current", "true");
    await shoot(page, "08-directory-managed-default");

    // The load-bearing half: asserting only the managed default would pass against a
    // directory that still emits a row per checkout the moment All is picked.
    await tile(page, "All").click();
    await expect(rows(page)).toHaveCount(25);
    expect(await bulkRowsDrawn(page), "one page of rows, on every tile").toBeLessThanOrEqual(25);
    await expect(page.getByText(new RegExp(`1-25 of ${workspaceCount} in All`))).toBeVisible();

    // And paging keeps the repository the operator picked in the pane beside the list.
    const picked = await rows(page).first().innerText();
    await rows(page).first().click();
    const heading = await detail(page).getByRole("heading").first().innerText();
    expect(picked).toContain(heading);
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByText(new RegExp(`26-50 of ${workspaceCount} in All`))).toBeVisible();
    await expect(rows(page)).toHaveCount(25);
    await expect(detail(page).getByRole("heading").first()).toHaveText(heading);
    await shoot(page, "09-directory-paged");
  });

  test("a selection survives the four-second poll rather than jumping", async ({ page, daemon }) => {
    seedBulkRepos(daemon.workspace, 30);
    await manage(page, daemon.baseURL, daemon.repo);
    await openConductor(page, daemon.baseURL);
    await tile(page, "All").click();
    await page.getByPlaceholder("Search workspace repositories").fill("second-repo");
    await repoRow(page, daemon.secondRepo).click();
    const heading = detail(page).getByRole("heading").first();
    await expect(heading).toHaveText("second-repo");
    // Longer than `useConductor`'s POLL_MS, so at least one whole view replacement lands
    // underneath the selection. Keyed by `pipelineRepoKey`, an index would have moved.
    await page.waitForTimeout(6_000);
    await expect(heading).toHaveText("second-repo");
    await expect(repoRow(page, daemon.secondRepo)).toHaveAttribute("aria-current", "true");
  });

  test("a repository picked under All keeps its pane under Managed, and says where its row went", async ({
    page,
    daemon,
  }) => {
    seedBulkRepos(daemon.workspace, 10);
    await manage(page, daemon.baseURL, daemon.repo);
    await openConductor(page, daemon.baseURL);

    await tile(page, "All").click();
    await repoRow(page, daemon.secondRepo).click();
    await expect(detail(page).getByRole("heading").first()).toHaveText("second-repo");

    // Back to the narrow default. The key is still perfectly valid, so nothing clears it -
    // and the pane says the repository is not in the list beside it rather than showing a
    // row that is not there, or silently swapping to a repository nobody chose.
    await tile(page, "Managed").click();
    await expect(detail(page).getByRole("heading").first()).toHaveText("second-repo");
    await expect(detail(page)).toContainText("is not in the Managed list beside this pane");
    // The Managed list is not empty - it holds the repository that IS managed - it simply
    // does not hold the one the pane is showing.
    await expect(repoRow(page, daemon.repo)).toBeVisible();
    await expect(repoRow(page, daemon.secondRepo)).toHaveCount(0);
    await shoot(page, "10-off-filter-selection");

    await detail(page).getByRole("button", { name: "Show it in All" }).click();
    await expect(repoRow(page, daemon.secondRepo)).toHaveAttribute("aria-current", "true");
    await expect(detail(page).getByRole("heading").first()).toHaveText("second-repo");
    await expect(detail(page)).not.toContainText("is not in the Managed list");
  });

  test("search narrows the active tile rather than escaping it, and says so when that finds nothing", async ({
    page,
    daemon,
  }) => {
    seedBulkRepos(daemon.workspace, 10);
    await manage(page, daemon.baseURL, daemon.repo);
    await openConductor(page, daemon.baseURL);

    // Managed is active and holds one repository. A query matching only an unmanaged one
    // finds nothing - that is the conjunction working - so the empty state has to name the
    // tile that would find it rather than leave an operator at a bare empty list.
    await expect(tile(page, "Managed")).toHaveAccessibleName("1 Managed");
    await page.getByPlaceholder("Search workspace repositories").fill("second-repo");
    await expect(rows(page)).toHaveCount(0);
    await expect(empty(page)).toContainText("No Managed repository matches that search");
    // The count describes the population the tile names, not the rows a query leaves on
    // screen - which is the half of the rule the empty state cannot show.
    await expect(tile(page, "Managed")).toHaveAccessibleName("1 Managed");

    await empty(page).getByRole("button", { name: /Show 1 under All/ }).click();
    await expect(repoRow(page, daemon.secondRepo)).toBeVisible();
    await expect(rows(page)).toHaveCount(1);
  });
});
