import { mkdirSync } from "node:fs";

import type { Locator } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { settled } from "../fixtures/settle.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";

// The built-in Agent Shepherd: installed by the daemon on a fresh home, opened read-only,
// customized through Duplicate to edit, and launchable as shipped. No model tokens are spent:
// every agent binary is the fake from `fixtures/fake-agents.ts`.

const BUILTIN = "Agent Shepherd";
const COPY = `${BUILTIN} copy`;
const EVIDENCE = artifactsDir("residents-builtin");

async function capture(target: Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
}

async function api<T>(daemon: DaemonHandle, path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const response = await fetch(`${daemon.baseURL}${path}`, init);
  return { status: response.status, body: await response.json() as T };
}

test("Agent Shepherd ships read-only, duplicates into an editable profile, and launches as shipped", async ({
  dashboard: page,
  daemon,
}) => {
  await page.goto(`${daemon.baseURL}/#/residents`);
  const rail = page.getByRole("complementary", { name: "Resident profiles" });
  // The tag, not the name: the copy saved below starts with the same words.
  const builtinRow = rail.getByRole("button").filter({ hasText: BUILTIN }).filter({ hasText: "built-in" });
  await expect(builtinRow).toHaveCount(1);
  await expect(builtinRow).toContainText("no Persona · Claude Code · claude-sonnet-5-5");
  await expect(rail).toContainText("No profiles of your own yet. Duplicate a built-in, or choose New to author one.");

  await builtinRow.click();
  const shipped = page.getByRole("region", { name: `Resident profile ${BUILTIN}` });
  await expect(shipped).toContainText("Built-in · revision 1. Updated with Mission Control.");
  await expect(shipped).toContainText(`${BUILTIN} ships with Mission Control and is read-only.`);
  await expect(shipped.getByRole("button", { name: "Save" })).toHaveCount(0);
  await expect(shipped.getByRole("button", { name: "Archive" })).toHaveCount(0);
  await expect(shipped.getByLabel("Name")).toBeDisabled();
  const instructions = shipped.getByLabel("Profile instructions");
  await expect(instructions).toBeDisabled();
  await expect(instructions).toHaveValue(/## Unblock stuck work/);
  await expect(shipped.getByRole("checkbox", { name: /Control other sessions/ })).toBeChecked();
  await expect(shipped.getByLabel("Spend per 24 hours (USD)", { exact: true })).toHaveValue("40");
  await capture(shipped.getByRole("region", { name: "Loop and guardrails", exact: true }), "10-shepherd-spend-cap");
  await capture(page.locator("main.residents-page"), "01-builtin-read-only");

  // The daemon refuses the write the editor does not offer.
  const id = encodeURIComponent("builtin:agent-shepherd");
  const refused = await api<{ error: string }>(daemon, `/api/residents/profiles/${id}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: 1 }),
  });
  expect(refused.status).toBe(409);
  expect(refused.body.error).toContain("ships with Mission Control and cannot be archived");

  await shipped.getByRole("button", { name: "Duplicate to edit" }).click();
  const draft = page.getByRole("region", { name: "New resident profile" });
  await expect(draft.getByLabel("Name")).toHaveValue(COPY);
  await expect(draft.getByLabel("Name")).toBeEnabled();
  await expect(draft.getByLabel("Spend per 24 hours (USD)", { exact: true })).toHaveValue("40");
  await expect(draft.getByLabel("Profile instructions")).toHaveValue(/## Unblock stuck work/);
  await draft.getByLabel("Profile instructions").fill("Watch only the release branch.");
  await capture(page.locator("main.residents-page"), "02-duplicate-draft");
  await draft.getByRole("button", { name: "Save" }).click();

  const copy = page.getByRole("region", { name: `Resident profile ${COPY}` });
  await expect(copy).toContainText("Revision 1");
  await expect(copy.getByRole("button", { name: "Archive" })).toBeVisible();
  const copyRow = rail.getByRole("button").filter({ hasText: COPY });
  await expect(copyRow).toContainText("no Persona");
  await expect(copyRow).not.toContainText("built-in");
  await expect(builtinRow).toHaveCount(1);
  await capture(page.locator("main.residents-page"), "03-copy-saved");

  // The edit persisted: stored by the daemon, and still there after a reload reopens the copy.
  const stored = (await api<Array<{ name: string; builtin?: true; settings: { instructions: { markdown: string } } }>>(
    daemon, "/api/residents/profiles",
  )).body.find((profile) => profile.name === COPY);
  expect(stored?.builtin).toBeUndefined();
  expect(stored?.settings.instructions.markdown).toBe("Watch only the release branch.");
  await page.reload();
  await rail.getByRole("button").filter({ hasText: COPY }).click();
  const reopened = page.getByRole("region", { name: `Resident profile ${COPY}` });
  const savedInstructions = reopened.getByLabel("Profile instructions");
  await expect(savedInstructions).toHaveValue("Watch only the release branch.");
  await expect(savedInstructions).toBeEnabled();
  await expect(reopened).toContainText("Revision 1");
  // The page after the reload: the copy's name, its saved revision and its persisted instructions.
  await capture(page.locator("main.residents-page"), "03b-copy-instructions-after-reload");

  // The built-in is unchanged by its copy, and launches exactly as shipped.
  await builtinRow.click();
  await expect(shipped.getByLabel("Profile instructions")).toHaveValue(/## Unblock stuck work/);
  await shipped.getByRole("button", { name: "Launch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog.getByRole("radio").filter({ hasText: BUILTIN }).filter({ hasNotText: COPY }))
    .toHaveAttribute("aria-checked", "true");
  await dialog.getByLabel("Repository").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await capture(dialog, "04-dispatch-builtin");
  await dialog.getByRole("button", { name: "Launch resident" }).click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });

  let task: { id: string; kind: string; status: string } | null = null;
  await expect.poll(async () => {
    task = (await api<NonNullable<typeof task>[]>(daemon, "/api/tasks")).body.find((t) => t.kind === "resident") ?? null;
    return task?.status ?? null;
  }, { timeout: 60_000 }).toBe("running");

  await page.goto(`${daemon.baseURL}/#/fleet`);
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = page.locator(".console-detail");
  await expect(page.getByRole("group", { name: `Resident ${BUILTIN}` })).toContainText("revision 1");
  const complete = card.getByRole("button", { name: "Complete" });
  await settled(complete);
  await complete.click();
  const completeDialog = page.getByRole("dialog", { name: "Complete task and close session" });
  await completeDialog.getByRole("button", { name: "Complete & close" }).click();
  await expect(completeDialog).toBeHidden();
  await expect.poll(async () =>
    (await api<Array<{ id: string; status: string }>>(daemon, "/api/tasks")).body
      .find((t) => t.id === task!.id)?.status ?? null,
  ).toBe("done");
});

test("an unsaved duplicate survives New, and leaving it means the next New starts blank", async ({
  dashboard: page,
  daemon,
}) => {
  await page.goto(`${daemon.baseURL}/#/residents`);
  const rail = page.getByRole("complementary", { name: "Resident profiles" });
  const builtinRow = rail.getByRole("button").filter({ hasText: BUILTIN }).filter({ hasText: "built-in" });
  await builtinRow.click();
  await page.getByRole("region", { name: `Resident profile ${BUILTIN}` })
    .getByRole("button", { name: "Duplicate to edit" }).click();

  const draft = page.getByRole("region", { name: "New resident profile" });
  const instructions = draft.getByLabel("Profile instructions");
  await instructions.fill("An unsaved edit to the copy.");

  // New on a new-profile draft is the same route: the copy and its edit stay.
  await rail.getByRole("button", { name: "New" }).click();
  await expect(page.getByRole("dialog", { name: "Leave with unsaved changes" })).toHaveCount(0);
  await expect(draft.getByLabel("Name")).toHaveValue(COPY);
  await expect(instructions).toHaveValue("An unsaved edit to the copy.");
  await capture(page.locator("main.residents-page"), "05-duplicate-survives-new");

  // Leaving the draft asks first, and discarding it drops the copied settings.
  await builtinRow.click();
  const gate = page.getByRole("dialog", { name: "Leave with unsaved changes" });
  await gate.getByRole("button", { name: "Discard and leave" }).click();
  await expect(page.getByRole("region", { name: `Resident profile ${BUILTIN}` })).toBeVisible();

  await rail.getByRole("button", { name: "New" }).click();
  const blank = page.getByRole("region", { name: "New resident profile" });
  await expect(blank.getByLabel("Name")).toHaveValue("");
  await expect(blank.getByLabel("Description")).toHaveValue("");
  await expect(blank.getByLabel("Profile instructions")).toHaveValue("");
  await expect(blank.getByRole("checkbox", { name: /Control other sessions/ })).not.toBeChecked();
  await capture(page.locator("main.residents-page"), "06-new-after-leaving-is-blank");
});

test("an Agent Shepherd profile that predates the built-in keeps its data, and both are listed and launchable", async ({
  dashboard: page,
  daemon,
}) => {
  const json = { "content-type": "application/json" };
  // An operator profile authored under the name before it shipped built-in. The API now refuses
  // that name, so it is created under another and renamed behind the daemon's back, exactly the
  // state an upgraded machine holds. Saving it under its own name is not a rename, so the store
  // accepts it, and that save is what puts it in the live catalog.
  const created = await api<{ id: string; settings: Record<string, unknown> & { identity: Record<string, unknown> } }>(
    daemon, "/api/residents/profiles", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ settings: { identity: { name: "Legacy Shepherd" }, instructions: { markdown: "My own shepherd brief." } } }),
    },
  );
  expect(created.status).toBe(201);
  withDaemonDb(daemon, (db) => {
    db.prepare("UPDATE resident_profiles SET name = ?, normalized_name = ? WHERE id = ?")
      .run(BUILTIN, BUILTIN.toLowerCase(), created.body.id);
  });
  const resaved = await api<{ name: string }>(daemon, `/api/residents/profiles/${created.body.id}`, {
    method: "PATCH",
    headers: json,
    body: JSON.stringify({
      expectedRevision: 1,
      settings: { ...created.body.settings, identity: { ...created.body.settings.identity, name: BUILTIN } },
    }),
  });
  expect(resaved.status).toBe(200);

  await page.goto(`${daemon.baseURL}/#/residents`);
  const rail = page.getByRole("complementary", { name: "Resident profiles" });
  const rows = rail.getByRole("button").filter({ hasText: BUILTIN });
  await expect(rows).toHaveCount(2);
  const builtinRow = rows.filter({ hasText: "built-in" });
  const ownRow = rows.filter({ hasNotText: "built-in" });
  await expect(builtinRow).toHaveCount(1);
  await expect(ownRow).toHaveCount(1);
  await expect(rail).toContainText("2 live");

  // The operator's profile keeps its data and stays editable.
  await ownRow.click();
  const own = page.getByRole("region", { name: `Resident profile ${BUILTIN}` });
  await expect(own.getByLabel("Profile instructions")).toHaveValue("My own shepherd brief.");
  await expect(own.getByLabel("Profile instructions")).toBeEnabled();
  await expect(own.getByRole("button", { name: "Archive" })).toBeVisible();

  // The built-in is reachable beside it, read-only.
  await builtinRow.click();
  const shipped = page.getByRole("region", { name: `Resident profile ${BUILTIN}` });
  await expect(shipped).toContainText("Built-in · revision 1. Updated with Mission Control.");
  await expect(shipped.getByLabel("Profile instructions")).toHaveValue(/## Unblock stuck work/);
  await capture(page.locator("main.residents-page"), "07-both-listed-rail");

  // The dock offers both, telling the built-in apart.
  await page.locator("header.topbar").getByRole("button", { name: /^Residents - / }).click();
  const dock = page.getByRole("dialog", { name: "Residents" });
  await expect(dock.getByRole("button", { name: `Launch ${BUILTIN}`, exact: true })).toHaveCount(1);
  await expect(dock.getByRole("button", { name: `Launch ${BUILTIN} (built-in)`, exact: true })).toHaveCount(1);
  // The tag is laid out whole inside its name cell: the name, not the tag, is what truncates.
  const tagFits = await dock.locator(".residents-pop-name").filter({ hasText: "built-in" }).evaluate((cell) => {
    const tag = cell.querySelector(".resident-builtin-tag")!.getBoundingClientRect();
    const box = cell.getBoundingClientRect();
    return tag.width > 0 && tag.left >= box.left - 0.5 && tag.right <= box.right + 0.5;
  });
  expect(tagFits).toBe(true);
  await capture(dock, "08-both-listed-dock");
  await page.keyboard.press("Escape");

  // Dispatch offers both, and the built-in card is tagged.
  await shipped.getByRole("button", { name: "Launch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  const cards = dialog.getByRole("radiogroup", { name: "Profile" }).getByRole("radio");
  await expect(cards).toHaveCount(2);
  await expect(cards.filter({ hasText: "built-in" })).toHaveAttribute("aria-checked", "true");
  await expect(dialog).toContainText("revision 1");
  await capture(dialog, "09-both-listed-dispatch");
});
