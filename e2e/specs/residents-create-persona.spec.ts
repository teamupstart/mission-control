import { mkdirSync } from "node:fs";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

const CREATE = "＋ Create a new Persona…";
const PERSONA = "Code Risk Reviewer";
const AUTHORED = "Release Triage Lead";
const EVIDENCE = artifactsDir("residents-create-persona");

async function expectBlankPersonaEditor(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/library/personas/new");
  await expect(page.locator("section.persona-fields").getByLabel("Name")).toHaveValue("");
}

test("the Persona picker offers Create a new Persona, gated while the profile has unsaved edits", async ({
  dashboard: page,
  daemon,
}) => {
  await page.goto(`${daemon.baseURL}/#/residents/new`);
  const editor = page.getByRole("region", { name: "New resident profile" });
  await editor.getByLabel("Name").fill("Unsaved resident");
  const persona = editor.getByRole("combobox", { name: "Persona" });
  await persona.selectOption({ label: `${PERSONA} · built-in` });

  const labels = await persona.locator("option").allTextContents();
  expect(labels.at(-1)).toBe(CREATE);
  expect(labels).toContain(`${PERSONA} · built-in`);

  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    await page.setViewportSize({ width: 1280, height: 1100 });
    await persona.click();
    await expect(persona.getByRole("option", { name: CREATE })).toBeVisible();
    await persona.getByRole("option", { name: CREATE }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${EVIDENCE}picker-open.png` });
    await page.keyboard.press("Escape");
  }

  // Choosing the option never writes it into the draft, so Cancel leaves the old Persona shown.
  await persona.selectOption({ label: CREATE });
  const gate = page.getByRole("dialog", { name: "Leave with unsaved changes" });
  await expect(gate).toBeVisible();
  await gate.getByRole("button", { name: "Cancel" }).click();
  await expect(gate).toBeHidden();
  await expect(page).toHaveURL(/#\/residents\/new$/);
  await expect(editor.getByLabel("Name", { exact: true })).toHaveValue("Unsaved resident");
  await expect(persona.locator("option:checked")).toHaveText(`${PERSONA} · built-in`);

  await persona.selectOption({ label: CREATE });
  await gate.getByRole("button", { name: "Discard and leave" }).click();
  await expectBlankPersonaEditor(page);
  if (process.env.MC_E2E_EVIDENCE) await page.screenshot({ path: `${EVIDENCE}persona-editor.png` });
});

test("a Persona created from a saved profile's picker can be linked to that profile", async ({
  dashboard: page,
  daemon,
}) => {
  await page.goto(`${daemon.baseURL}/#/residents/new`);
  const editor = page.getByRole("region", { name: "New resident profile" });
  await editor.getByLabel("Name").fill("Saved resident");
  await editor.getByRole("combobox", { name: "Persona" }).selectOption({ label: `${PERSONA} · built-in` });
  await editor.getByLabel("Default repository").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await editor.getByRole("button", { name: "Save" }).click();

  const saved = page.getByRole("region", { name: "Resident profile Saved resident" });
  await expect(saved).toContainText("Revision 1");
  const profileUrl = page.url();
  await saved.getByRole("combobox", { name: "Persona" }).selectOption({ label: CREATE });
  await expect(page.getByRole("dialog", { name: "Leave with unsaved changes" })).toHaveCount(0);
  await expectBlankPersonaEditor(page);

  await page.locator("section.persona-fields").getByLabel("Name").fill(AUTHORED);
  const guidance = page.locator(".persona-editor-host .cm-content");
  await guidance.click();
  await guidance.pressSequentially("Triage release blockers first.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#\/library\/personas\/(?!new$).+/);

  await page.goto(profileUrl);
  const reopened = page.getByRole("region", { name: "Resident profile Saved resident" });
  const persona = reopened.getByRole("combobox", { name: "Persona" });
  await persona.selectOption({ label: AUTHORED });
  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    await page.screenshot({ path: `${EVIDENCE}authored-persona-selected.png` });
  }
  await reopened.getByRole("button", { name: "Save" }).click();
  await expect(reopened).toContainText("Revision 2");
  await page.reload();
  await expect(page.getByRole("region", { name: "Resident profile Saved resident" })
    .getByRole("combobox", { name: "Persona" }).locator("option:checked")).toHaveText(AUTHORED);
  await expect(page.getByRole("complementary", { name: "Resident profiles" })
    .getByRole("button", { name: /Saved resident/ })).toContainText(AUTHORED);
});
