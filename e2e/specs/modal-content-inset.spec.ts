import { mkdirSync } from "node:fs";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";

const EVIDENCE = artifactsDir("modal-content-inset");

/**
 * No modal prints its content onto its own border.
 *
 * `.modal` now owns one `--modal-inset` and applies it as `padding-inline`, so content is
 * inset at any depth and only the bands that draw to the border opt back out with
 * `.modal-bleed`. Before that the inset was opt-in per region and re-declared by nine
 * bespoke body classes, so a modal authored without one of those wrappers rendered its text
 * flush against the border - and `.modal-actions`, the class two footers used, had no CSS
 * rule at all.
 *
 * The repaired surfaces are asserted where they already open: the standing-instructions
 * session modal in `settings-standing-instructions.spec.ts`, the worktree action preview in
 * `settings-worktrees.spec.ts`, and the bind dialog in `workflow-bind-chip-returns.spec.ts`.
 * This spec carries the two cases with nowhere else to live - the file picker, whose bands
 * all bleed and whose search box was six pixels out of line with the header above it, and a
 * modal that was already correct, which is what makes the inversion a no-op rather than a
 * reflow.
 *
 * No model tokens are spent: every agent binary is redirected at a fake by
 * `e2e/fixtures/fake-agents.ts`.
 */

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/modal-content-inset/${name}.png`);
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  // The dispatch dialog is itself a `.modal`, and its body is one of the bands that keeps
  // its own padding. Measured here rather than in a case of its own, since it is on the way.
  await expectContentClearsBorder(dialog);
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // The repo combobox portals its listbox over the Task field and reopens on every
  // keystroke; without this the next fill lands on a covered control.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("find a file");
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

test("the file picker holds its content off the panel border and lines its search up with its title", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);

  // Selection first: the picker's shortcut acts on the selected session, and its own header
  // names that session - which is the text this measures.
  await dashboard
    .getByRole("navigation", { name: "Sessions" })
    .locator("button.rail-row")
    .first()
    .click();
  await dashboard.keyboard.press("Shift+O");

  const picker = dashboard.getByRole("dialog", { name: /^Find a file/ });
  await expect(picker).toBeVisible();
  await expectContentClearsBorder(picker);

  // And the alignment the search box's own 12px used to break. The result rows still reach
  // the border - a list's selection band should - so only these two are compared.
  const titleBox = (await picker.getByRole("heading", { level: 2 }).boundingBox())!;
  const searchBox = (await picker.locator("form").boundingBox())!;
  expect(
    Math.abs(searchBox.x - titleBox.x),
    "the search box and the dialog title take the same inset",
  ).toBeLessThanOrEqual(1);

  await shoot(dashboard, "file-picker");
});

test("a modal that already wrapped its content is unchanged by the shell inset", async ({
  dashboard,
}) => {
  // `.feedback-modal` renders through `.modal-body feedback-body`, so it never had the
  // defect. It is here as the control: the shell inset must not double up on a band that
  // already carries one.
  await dashboard
    .getByRole("button", { name: "Report product feedback", exact: true })
    .click();
  const form = dashboard.getByRole("dialog", { name: "Report product feedback" });
  await expect(form).toBeVisible();
  await expectContentClearsBorder(form);

  const panel = (await form.boundingBox())!;
  const body = (await form.locator(".feedback-body").boundingBox())!;
  expect(
    body.x - panel.x,
    "the body still reaches the panel border and supplies the inset itself",
  ).toBeLessThanOrEqual(1);

  await shoot(dashboard, "feedback-modal-control");
});
