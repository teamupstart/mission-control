import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { writePiCatalogMode } from "../fixtures/fake-agents.ts";
import { recordsIn } from "../fixtures/records.ts";
import { expect, test } from "../fixtures/test.ts";

const PI_DEFAULT = "Default model for dispatched Pi sessions";
const SAVED_MODEL = "anthropic/claude-sonnet-5";
const EXPECTED_ARGS = [
  "--mode",
  "rpc",
  "--no-session",
  "--offline",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  "--no-tools",
  "--no-approve",
] as const;
const EVIDENCE = artifactsDir("pi-model-catalog");

interface PiProbeRecord {
  argv: string[];
  cwd: string;
  request: { id: string; type: string };
}

async function openHarnesses(page: Page, baseURL: string): Promise<void> {
  await page.goto(`${baseURL}/#/settings`);
  await page.getByRole("tab", { name: /Harnesses/ }).click();
}

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator('[data-anchor="harnesses/pi"]').screenshot({
    path: `${EVIDENCE}${name}.png`,
    animations: "disabled",
  });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/pi-model-catalog/${name}.png`);
}

test("Pi pickers share its provider catalog and retain selection through discovery failure", async ({
  dashboard,
  daemon,
}) => {
  await openHarnesses(dashboard, daemon.baseURL);
  const settingsModel = dashboard.getByRole("combobox", { name: PI_DEFAULT });
  await expect(settingsModel).toBeEnabled();
  await expect(settingsModel.locator("optgroup")).toHaveCount(3);
  await expect
    .poll(() =>
      settingsModel
        .locator("optgroup")
        .evaluateAll((groups) => groups.map((group) => group.getAttribute("label"))),
    )
    .toEqual(["openai", "anthropic", "openrouter"]);
  await expect(settingsModel.locator(`option[value="${SAVED_MODEL}"]`)).toHaveText(
    "Claude Sonnet 5",
  );
  await expect(
    settingsModel.locator('option[value="openrouter/meta-llama/llama-4-maverick"]'),
  ).toHaveText("Llama 4 Maverick");

  await settingsModel.selectOption(SAVED_MODEL);
  await expect
    .poll(async () => {
      const response = await dashboard.request.get(`${daemon.baseURL}/api/harnesses/config`);
      return ((await response.json()) as { defaultModel: { pi: string | null } }).defaultModel.pi;
    })
    .toBe(SAVED_MODEL);

  await dashboard.getByRole("button", { name: "← Fleet" }).click();
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByLabel("Agent").selectOption("pi");
  const dispatchModel = dialog.getByLabel("Model");
  await expect(dispatchModel).toBeEnabled();
  await expect(dispatchModel).toHaveValue("");
  await expect(dispatchModel).toContainText("Default - Claude Sonnet 5");
  await expect(dispatchModel.locator(`option[value="${SAVED_MODEL}"]`)).toHaveCount(1);
  await dashboard.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // A fresh daemon has no in-memory success to serve stale, so the failed probe exercises
  // the shipped fallback while the durable Settings selection remains exact.
  writePiCatalogMode(daemon.home, "failure");
  await daemon.crash();
  await daemon.restart();
  await dashboard.reload();
  await openHarnesses(dashboard, daemon.baseURL);

  const retained = dashboard.getByRole("combobox", { name: PI_DEFAULT });
  await expect(retained).toBeEnabled();
  await expect(retained).toHaveValue(SAVED_MODEL);
  await expect(retained.locator(`option[value="${SAVED_MODEL}"]`)).toHaveText(
    "Sonnet 5 - not currently reported",
  );
  await expect(dashboard.getByText(/Showing built-in Pi models/)).toBeVisible();
  await shoot(dashboard, "fallback-retains-selection");

  await dashboard.getByRole("button", { name: "Retry Pi models" }).click();
  const recordDir = join(daemon.recordDir, "pi");
  await expect
    .poll(() => recordsIn<PiProbeRecord>(recordDir).length, {
      message: "initial, post-restart, and forced-refresh Pi probes should all be recorded",
    })
    .toBe(3);
  await expect(retained).toBeEnabled();
  await expect(retained).toHaveValue(SAVED_MODEL);
  await expect(dashboard.getByRole("button", { name: "Retry Pi models" })).toBeEnabled();

  for (const record of recordsIn<PiProbeRecord>(recordDir)) {
    expect(record.argv).toEqual(EXPECTED_ARGS);
    expect(record.cwd).not.toBe(daemon.repo);
    expect(Object.keys(record.request).sort()).toEqual(["id", "type"]);
    expect(record.request.type).toBe("get_available_models");
    expect(record.request.id).toBeTruthy();
  }
});

test("a signed-out Pi is named as signed out and told how to sign in", async ({
  dashboard,
  daemon,
}) => {
  // The reported defect: a Pi with no provider credentials answers `get_available_models`
  // successfully with an empty list, the notice said only that no models were reported,
  // and the single offered action was a retry that cannot succeed until someone signs in.
  writePiCatalogMode(daemon.home, "signed-out");
  await daemon.crash();
  await daemon.restart();
  await dashboard.reload();
  await openHarnesses(dashboard, daemon.baseURL);

  const notice = dashboard
    .getByRole("status")
    .filter({ hasText: /Pi reported no available models/ })
    .first();
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("not signed in to a model provider");
  await expect(notice).toContainText("/login");
  await expect(notice).toContainText("Anthropic or Claude account");
  await shoot(dashboard, "signed-out-sign-in-guidance");

  // The picker stays usable while signed out: the guidance is advice, never a block.
  const settingsModel = dashboard.getByRole("combobox", { name: PI_DEFAULT });
  await expect(settingsModel).toBeEnabled();

  const recordDir = join(daemon.recordDir, "pi");
  const probesBefore = recordsIn<PiProbeRecord>(recordDir).length;
  const retry = dashboard.getByRole("button", { name: "Retry Pi models" });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect
    .poll(() => recordsIn<PiProbeRecord>(recordDir).length, {
      message: "the forced refresh should reach Pi once more",
    })
    .toBe(probesBefore + 1);
  // Still signed out, so the same guidance stands rather than degrading to a bare failure.
  await expect(notice).toContainText("Anthropic or Claude account");
  await expect(retry).toBeEnabled();
});

test.describe("login-shell Pi installation", () => {
  test.use({
    setupReminder: true,
    daemonEnv: { MC_E2E_PI_LOGIN_SHELL_ONLY: "1" },
  });

  test("model discovery resolves Pi through the refreshed login-shell PATH", async ({
    page,
    daemon,
  }) => {
    await openHarnesses(page, daemon.baseURL);

    const settingsModel = page.getByRole("combobox", { name: PI_DEFAULT });
    await expect(settingsModel).toBeEnabled();
    await expect
      .poll(() =>
        settingsModel
          .locator("optgroup")
          .evaluateAll((groups) => groups.map((group) => group.getAttribute("label"))),
      )
      .toEqual(["openai", "anthropic", "openrouter"]);
    await expect(page.getByText(/Showing built-in Pi models/)).not.toBeVisible();

    const records = recordsIn<PiProbeRecord>(join(daemon.recordDir, "pi"));
    expect(records).toHaveLength(1);
    expect(records[0]!.request.type).toBe("get_available_models");
    await settingsModel.selectOption("openrouter/meta-llama/llama-4-maverick");
    await expect(settingsModel).toHaveValue("openrouter/meta-llama/llama-4-maverick");
    await shoot(page, "login-shell-catalog");
  });
});

test.describe("version-manager Pi installation", () => {
  test.use({
    setupReminder: true,
    daemonEnv: { MC_E2E_PI_VERSION_MANAGER_SHIM_ONLY: "1" },
  });

  test("model discovery survives an unavailable login shell through a configured mise shim", async ({
    page,
    daemon,
  }) => {
    await openHarnesses(page, daemon.baseURL);

    const settingsModel = page.getByRole("combobox", { name: PI_DEFAULT });
    await expect(settingsModel).toBeEnabled();
    await expect
      .poll(() =>
        settingsModel
          .locator("optgroup")
          .evaluateAll((groups) => groups.map((group) => group.getAttribute("label"))),
      )
      .toEqual(["openai", "anthropic", "openrouter"]);
    await expect(page.getByText(/Showing built-in Pi models/)).not.toBeVisible();

    const records = recordsIn<PiProbeRecord>(join(daemon.recordDir, "pi"));
    expect(records).toHaveLength(1);
    expect(records[0]!.request.type).toBe("get_available_models");
    await settingsModel.selectOption("openrouter/meta-llama/llama-4-maverick");
    await expect(settingsModel).toHaveValue("openrouter/meta-llama/llama-4-maverick");
    await shoot(page, "version-manager-shim-catalog");
  });
});
