import { mkdirSync } from "node:fs";

import type { Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectOptionsFitSelect } from "../fixtures/select-fit.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * The accessible name every harness card gives its Model picker, and the only thing this
 * spec uses to find them - so a harness added later is measured without editing this file.
 */
const MODEL_PICKER = /^Default model for dispatched .+ sessions$/;
/** A row only live Codex discovery supplies, so its presence proves the real catalog loaded. */
const CODEX_DISCOVERED = "gpt-5.4";
const EVIDENCE = artifactsDir("harness-model-select-fit");

/** Reviewer evidence, off by default: the assertions above are what gates the change. */
async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator(".harness-cards").screenshot({
    path: `${EVIDENCE}${name}.png`,
    animations: "disabled",
  });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/harness-model-select-fit/${name}.png`);
}

test("every harness card's Model picker can show its whole catalog", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings`);
  await dashboard.getByRole("tab", { name: /Harnesses/ }).click();

  const pickers = dashboard.getByRole("combobox", { name: MODEL_PICKER });
  await expect(pickers.first()).toBeEnabled();
  // Measure the discovered catalog, not the shipped placeholder it starts on: Codex's
  // reported descriptions are the free text that overflowed, and the fallback table is not
  // what a running dashboard shows.
  const codex = dashboard.getByRole("combobox", {
    name: "Default model for dispatched Codex sessions",
  });
  await expect.poll(() => codex.locator(`option[value="${CODEX_DISCOVERED}"]`).count()).toBe(1);

  const count = await pickers.count();
  expect(count, "the Harnesses tab rendered no harness cards").toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const picker = pickers.nth(index);
    const name = await picker.getAttribute("aria-label");
    await test.step(name ?? `model picker ${index}`, () => expectOptionsFitSelect(picker));
  }

  await codex.selectOption("gpt-5.6-sol");
  await shoot(dashboard, "harness-cards");
});

/**
 * Codex rows chosen for the widest and narrowest labels the discovered catalog offers,
 * plus the empty option. Swapping between these is the strongest width swing a person can
 * produce from this card, so a layout that survives them survives the catalog.
 */
const WIDTH_SWING = ["", "gpt-5.4-mini", "gpt-5.5", "gpt-5.6-terra", ""] as const;

test("selecting a model never jogs a harness card's width or its row layout", async ({
  dashboard,
  daemon,
}) => {
  // The other half of the fix. Dropping the hints was chosen over widening the 250px cap
  // precisely because the cap is what holds the cards to one width - a select that grows
  // to its content would push the Codex card past the Claude Code card beside it, and
  // relaying out the row on every selection. That is invisible to markup: the JSX is
  // identical either way and only resolved geometry says which one shipped.
  await dashboard.goto(`${daemon.baseURL}/#/settings`);
  await dashboard.getByRole("tab", { name: /Harnesses/ }).click();

  const codex = dashboard.getByRole("combobox", {
    name: "Default model for dispatched Codex sessions",
  });
  await expect.poll(() => codex.locator(`option[value="${CODEX_DISCOVERED}"]`).count()).toBe(1);

  const cards = dashboard.locator(".harness-card");
  const pickers = dashboard.getByRole("combobox", { name: MODEL_PICKER });
  // Every card's border box and every Model picker's border box, in one read, so a shift
  // in any card is attributed to the selection that preceded it.
  const geometry = async (): Promise<{ cards: number[]; pickers: number[] }> => ({
    cards: await cards.evaluateAll((nodes) =>
      nodes.map((node) => Math.round(node.getBoundingClientRect().width)),
    ),
    pickers: await pickers.evaluateAll((nodes) =>
      nodes.map((node) => Math.round(node.getBoundingClientRect().width)),
    ),
  });

  const baseline = await geometry();
  expect(baseline.cards.length, "the Harnesses tab rendered no harness cards").toBeGreaterThan(0);
  // The cards share one width rather than each sizing to its own contents. This is the
  // property the reported bug was one stylesheet edit away from destroying.
  expect(new Set(baseline.cards).size, `harness cards differ in width: ${baseline.cards}`).toBe(1);
  expect(new Set(baseline.pickers).size, `Model pickers differ in width: ${baseline.pickers}`).toBe(
    1,
  );

  for (const model of WIDTH_SWING) {
    await codex.selectOption(model);
    await expect(codex).toHaveValue(model);
    expect(
      await geometry(),
      `selecting "${model || "Harness default"}" relaid out the harness cards`,
    ).toEqual(baseline);
  }
});
