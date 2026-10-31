import { mkdirSync } from "node:fs";

import type { Locator } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { settled } from "../fixtures/settle.ts";

// No model tokens are spent: every agent binary is the fake from `fixtures/fake-agents.ts`.

const PROFILE = "Solo Watch";
const PROFILE_BRIEF = "Summarize blockers on the release branch before anything else.";
const EVIDENCE = artifactsDir("residents-no-persona");

async function capture(target: Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
}

async function api<T>(daemon: DaemonHandle, path: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`);
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

test("a resident without a Persona saves and launches on its profile instructions alone", async ({
  dashboard: page,
  daemon,
}) => {
  await page.goto(`${daemon.baseURL}/#/residents/new`);
  const editor = page.getByRole("region", { name: "New resident profile" });
  await editor.getByLabel("Name").fill(PROFILE);
  await editor.getByLabel("Default repository").fill(daemon.repo);
  await page.keyboard.press("Escape");

  const persona = editor.getByRole("combobox", { name: "Persona" });
  await expect(persona.locator("option:checked")).toHaveText("No Persona");
  await expect(editor).toContainText("choose a Persona or write profile instructions");
  await expect(editor.getByRole("button", { name: "Save" })).toBeDisabled();

  await editor.getByLabel("Profile instructions").fill(PROFILE_BRIEF);
  await expect(editor).not.toContainText("choose a Persona or write profile instructions");
  await capture(page.locator("main.residents-page"), "profile-without-persona");
  await editor.getByRole("button", { name: "Save" }).click();

  const saved = page.getByRole("region", { name: `Resident profile ${PROFILE}` });
  await expect(saved).toContainText("Revision 1");
  const rail = page.getByRole("complementary", { name: "Resident profiles" });
  await expect(rail.getByRole("button", { name: new RegExp(PROFILE) })).toContainText("no Persona");

  await saved.getByRole("button", { name: "Launch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog.getByLabel("Repository")).toHaveValue(daemon.repo);
  await expect(dialog).toContainText("no persona · profile instructions");
  await expect(dialog).not.toContainText("persona missing");
  await capture(dialog, "dispatch-without-persona");
  await dialog.getByRole("button", { name: "Launch resident" }).click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });

  let task: { id: string; kind: string; status: string } | null = null;
  await expect.poll(async () => {
    task = (await api<NonNullable<typeof task>[]>(daemon, "/api/tasks")).find((t) => t.kind === "resident") ?? null;
    return task?.status ?? null;
  }, { timeout: 60_000 }).toBe("running");

  await page.goto(`${daemon.baseURL}/#/fleet`);
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = page.locator(".console-detail");
  await expect(card).toBeVisible();
  await expect(page.getByRole("group", { name: `Resident ${PROFILE}` })).toContainText("revision 1");

  await card.getByRole("button", { name: "See standing instructions" }).click();
  const received = page.getByRole("dialog", { name: "Standing instructions this session received" });
  await expect(received).toContainText(`Resident role: ${PROFILE}`);
  await expect(received).toContainText(PROFILE_BRIEF);
  await capture(received, "standing-instructions-without-persona");
  await received.getByRole("button", { name: "Close" }).click();
  await expect(received).toBeHidden();

  const complete = card.getByRole("button", { name: "Complete" });
  await settled(complete);
  await complete.click();
  const completeDialog = page.getByRole("dialog", { name: "Complete task and close session" });
  await completeDialog.getByRole("button", { name: "Complete & close" }).click();
  await expect(completeDialog).toBeHidden();
  await expect.poll(async () =>
    (await api<Array<{ id: string; status: string }>>(daemon, "/api/tasks"))
      .find((t) => t.id === task!.id)?.status ?? null,
  ).toBe("done");
});
