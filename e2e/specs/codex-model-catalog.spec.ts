import { join } from "node:path";

import type { Page } from "@playwright/test";

import { writeCodexCatalogMode } from "../fixtures/fake-agents.ts";
import { recordsIn } from "../fixtures/records.ts";
import { expect, test } from "../fixtures/test.ts";

const CODEX_DEFAULT = "Default model for dispatched Codex sessions";
/**
 * A model a live Codex offers and `MODEL_CATALOG.codex` does not.
 *
 * The whole spec turns on this id: finding it in the picker proves the rows came from the
 * probe, and losing it when the probe fails proves the shipped fallback is what replaced
 * them. A shipped id could not tell those two states apart.
 */
const DISCOVERED_ONLY = "gpt-5.4";
/** Shipped rows, which must still be selectable when discovery fails. */
const SHIPPED = "gpt-5.6-sol";

interface CodexProbeRecord {
  argv: string[];
  cwd: string;
  params: Record<string, unknown> | null;
}

async function openHarnesses(page: Page, baseURL: string): Promise<void> {
  await page.goto(`${baseURL}/#/settings`);
  await page.getByRole("tab", { name: /Harnesses/ }).click();
}

test("Codex pickers show its discovered catalog and retain selection through discovery failure", async ({
  dashboard,
  daemon,
}) => {
  await openHarnesses(dashboard, daemon.baseURL);
  const settingsModel = dashboard.getByRole("combobox", { name: CODEX_DEFAULT });
  await expect(settingsModel).toBeEnabled();

  // Live discovery, not the shipped table: this id exists only in what the probe answered.
  await expect
    .poll(() => settingsModel.locator(`option[value="${DISCOVERED_ONLY}"]`).count())
    .toBe(1);
  // The label comes off the wire - Codex's own display name - which no shipped row for
  // this id could supply. The harness card prints the label alone; Codex's descriptions
  // are full sentences and overflowed the 250px select, so the hint moves to the roomier
  // Dispatch picker asserted below.
  await expect(settingsModel.locator(`option[value="${DISCOVERED_ONLY}"]`)).toHaveText("GPT-5.4");
  await expect(settingsModel.locator('option[value="gpt-5.4-mini"]')).toHaveText("GPT-5.4-Mini");

  // A row Codex hides from its own picker stays hidden here.
  await expect(settingsModel.locator('option[value="gpt-5.6-e2e-hidden"]')).toHaveCount(0);
  // Codex reports no per-row provider, so its rows render flat rather than grouped.
  await expect(settingsModel.locator("optgroup")).toHaveCount(0);

  await settingsModel.selectOption(DISCOVERED_ONLY);
  await expect
    .poll(async () => {
      const response = await dashboard.request.get(`${daemon.baseURL}/api/harnesses/config`);
      return ((await response.json()) as { defaultModel: { codex: string | null } }).defaultModel
        .codex;
    })
    .toBe(DISCOVERED_ONLY);

  await dashboard.getByRole("button", { name: "← Fleet" }).click();
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByLabel("Agent").selectOption("codex");
  const dispatchModel = dialog.getByLabel("Model");
  await expect(dispatchModel).toBeEnabled();
  await expect(dispatchModel).toHaveValue("");
  await expect(dispatchModel).toContainText("Default - GPT-5.4");
  // Same wire row, with the description the harness card had no room for.
  await expect(dispatchModel.locator(`option[value="${DISCOVERED_ONLY}"]`)).toHaveText(
    "GPT-5.4 - Strong model for everyday coding.",
  );
  await dashboard.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // A fresh daemon has no in-memory success to serve stale, so the failed probe exercises
  // the shipped fallback while the durable Settings selection remains exact.
  writeCodexCatalogMode(daemon.home, "failure");
  await daemon.crash();
  await daemon.restart();
  await dashboard.reload();
  await openHarnesses(dashboard, daemon.baseURL);

  const retained = dashboard.getByRole("combobox", { name: CODEX_DEFAULT });
  await expect(retained).toBeEnabled();
  await expect(retained).toHaveValue(DISCOVERED_ONLY);
  await expect(retained.locator(`option[value="${DISCOVERED_ONLY}"]`)).toHaveText(
    "GPT-5.4 - not currently reported",
  );
  await expect(dashboard.getByText(/Showing built-in Codex models/)).toBeVisible();
  // Falling back is a catalog-quality state, never a dispatch outage: the shipped rows are
  // still there to pick.
  await expect(retained.locator(`option[value="${SHIPPED}"]`)).toHaveCount(1);

  await dashboard.getByRole("button", { name: "Retry Codex models" }).click();
  const recordDir = join(daemon.recordDir, "codex-models");
  await expect
    .poll(() => recordsIn<CodexProbeRecord>(recordDir).length, {
      message: "initial, post-restart, and forced-refresh Codex probes should all be recorded",
    })
    .toBe(3);
  await expect(retained).toBeEnabled();
  await expect(retained).toHaveValue(DISCOVERED_ONLY);
  await expect(dashboard.getByRole("button", { name: "Retry Codex models" })).toBeEnabled();

  for (const record of recordsIn<CodexProbeRecord>(recordDir)) {
    // `app-server` and nothing else: no `-c` overrides, and above all no session or turn
    // argv. A probe that could launch a session is a probe that could spend a token.
    expect(record.argv).toEqual(["app-server"]);
    // The catalog belongs to the installation, not to whoever asked, so the probe must not
    // be reading the repository it was triggered from.
    expect(record.cwd).not.toBe(daemon.repo);
    // First page asks for no cursor at all rather than a null one.
    expect(record.params).toEqual({});
  }
});
