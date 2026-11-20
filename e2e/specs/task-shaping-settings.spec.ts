import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

// Settings > Task shaping, end to end against the shipped registry: the category follows its
// flag in every open window with no reload, an import is reviewed and saved switched off, and
// every control writes at once and reaches a second window. The shaper is the unit suite's own
// `command` fixture, run by this Node, so nothing here spends model tokens or reaches a network.

const FAKE_SHAPER = fileURLToPath(new URL("../../test/fixtures/fake-shaper.mjs", import.meta.url));
const EVIDENCE = process.env.MC_E2E_EVIDENCE ? artifactsDir("task-shaping-settings") : null;

function commandShaper(id: string, label: string, extra: Record<string, unknown> = {}) {
  return {
    id, label, stage: "gather",
    transport: { type: "command", command: process.execPath, args: [FAKE_SHAPER, "ok"] },
    timeoutMs: 30_000, ...extra,
  };
}

async function setFlag(daemon: DaemonHandle, enabled: boolean): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/feature-flags`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "flag", id: "task-shaping", enabled }),
  });
  expect(response.ok).toBe(true);
}

async function shapingConfig(daemon: DaemonHandle): Promise<{
  caller: { user: string };
  limits: { deadlineMs: number; totalBytes: number };
  shapers: Array<{ id: string }>;
  overrides: Record<string, boolean>;
  order: string[];
}> {
  const response = await fetch(`${daemon.baseURL}/api/shaping`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { config: Awaited<ReturnType<typeof shapingConfig>> }).config;
}

const rail = (window: Page) => window.getByRole("tablist", { name: "Settings categories" });
const panel = (window: Page) => window.getByRole("region", { name: "Task shaping" });
const row = (window: Page, label: string) => panel(window).getByRole("group", { name: label, exact: true });
const pill = (window: Page, label: string) => window.getByRole("button", { name: new RegExp(`^${label}: (on|off)$`) });
const gatherRows = (window: Page): Locator => panel(window).getByRole("group", { name: "Gather" }).locator(".shaping-row strong");

async function capture(window: Page, name: string): Promise<void> {
  if (!EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await window.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage: true });
}

test("Settings > Task shaping follows its flag live and drives every shaping intent", async ({ dashboard: page, context, daemon }) => {
  test.setTimeout(120_000);
  // A shaper stored while the flag was on, then the flag switched off again: a window opened now
  // must not see it until the flag returns.
  await setFlag(daemon, true);
  const seeded = await fetch(`${daemon.baseURL}/api/shaping`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "upsert", shaper: commandShaper("seeded-notes", "Seeded notes") }),
  });
  expect(seeded.status).toBe(200);
  await setFlag(daemon, false);

  await page.goto(`${daemon.baseURL}/#/settings/feature-flags`);
  const peer = await context.newPage();
  await peer.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  let peerNavigations = 0;
  peer.on("framenavigated", (frame) => { if (frame === peer.mainFrame()) peerNavigations++; });

  // Off: absent from the rail, the page and search, in both windows.
  await expect(rail(peer).getByRole("tab", { name: "Feature flags" })).toBeVisible();
  await expect(rail(peer).getByRole("tab", { name: "Task shaping" })).toHaveCount(0);
  await expect(peer.getByRole("tab", { name: "Display", selected: true })).toBeVisible();
  await expect(panel(peer)).toHaveCount(0);
  await page.keyboard.press("Meta+k");
  await page.getByRole("combobox", { name: "Search everything" }).fill("shaper");
  await expect(page.getByRole("option", { name: "Task shaping settings, panel" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // On, from the other window: the peer's link now opens the panel, filled with what is stored.
  await page.getByRole("button", { name: /^Task shaping:/ }).click();
  await expect(rail(peer).getByRole("tab", { name: "Task shaping" })).toBeVisible();
  await expect(peer.getByRole("tab", { name: "Task shaping", selected: true })).toBeVisible();
  await expect(row(peer, "Seeded notes")).toBeVisible();
  await expect(pill(peer, "Seeded notes")).toHaveAccessibleName("Seeded notes: off");
  await expect(row(peer, "Seeded notes")).toContainText(`Runs: ${process.execPath} ${FAKE_SHAPER} ok`);
  await expect(rail(page).getByRole("tab", { name: "Task shaping" })).toBeVisible();

  // Search finds it now, and lands on it.
  await page.keyboard.press("Meta+k");
  await page.getByRole("combobox", { name: "Search everything" }).fill("shaper");
  await page.getByRole("option", { name: "Task shaping settings, panel" }).click();
  await expect(page.getByRole("tab", { name: "Task shaping", selected: true })).toBeVisible();
  await expect(row(page, "Seeded notes")).toBeVisible();

  // Import: a manifest that breaks the credential rule is refused with its reason, and nothing is saved.
  await panel(page).getByRole("button", { name: "Import manifest…" }).click();
  const dialog = page.getByRole("dialog", { name: "Import a shaper" });
  await expect(dialog).toBeVisible();
  const manifest = dialog.getByRole("textbox", { name: "Manifest" });
  await manifest.fill(JSON.stringify({
    id: "leaky", label: "Leaky", stage: "select",
    transport: { type: "http", url: "https://context.example/shape", headers: { authorization: "Bearer sk-live-literal" } },
  }));
  await expect(dialog.getByRole("alert")).toContainText("must be a reference such as {env:NAME}");
  await expect(dialog.getByRole("button", { name: "Save switched off" })).toBeDisabled();

  // A valid manifest asks to start on; the review shows exactly what it runs and says it is saved off.
  await manifest.fill(JSON.stringify({ ...commandShaper("repo-notes", "Repository notes", { transport: {
    type: "command", command: process.execPath, args: [FAKE_SHAPER, "ok"], env: ["REPO_NOTES_TOKEN"],
  } }), enabled: true }, null, 2));
  const review = dialog.getByRole("region", { name: "What this shaper runs or calls" });
  await expect(review).toContainText(`${process.execPath} ${FAKE_SHAPER} ok`);
  await expect(review).toContainText("REPO_NOTES_TOKEN");
  await expect(review).toContainText("Runs on this machine as you");
  await expect(dialog).toContainText("an imported shaper is saved switched off");
  await expectContentClearsBorder(dialog);
  await capture(page, "import-review");
  await dialog.getByRole("button", { name: "Save switched off" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(pill(page, "Repository notes")).toHaveAccessibleName("Repository notes: off");
  await expect(pill(peer, "Repository notes")).toHaveAccessibleName("Repository notes: off");
  expect((await shapingConfig(daemon)).overrides["repo-notes"]).toBe(false);

  // Enable: at once here, and in the other window.
  await pill(page, "Repository notes").click();
  await expect(pill(page, "Repository notes")).toHaveAccessibleName("Repository notes: on");
  await expect(pill(peer, "Repository notes")).toHaveAccessibleName("Repository notes: on");
  await expect.poll(async () => (await shapingConfig(daemon)).overrides["repo-notes"]).toBe(true);

  // Reorder within the stage, mirrored in the other window.
  await expect(gatherRows(page)).toHaveText(["Seeded notes", "Repository notes"]);
  await page.getByRole("button", { name: "Move Repository notes up" }).click();
  await expect(gatherRows(page)).toHaveText(["Repository notes", "Seeded notes"]);
  await expect(gatherRows(peer)).toHaveText(["Repository notes", "Seeded notes"]);
  await expect(page.getByRole("button", { name: "Move Repository notes up" })).toBeDisabled();
  expect((await shapingConfig(daemon)).order).toEqual(["repo-notes", "seeded-notes"]);

  // Dry run against a repository Mission Control knows.
  await page.getByRole("button", { name: "Dry-run Repository notes" }).click();
  const dryRun = page.getByRole("dialog", { name: "Dry-run Repository notes" });
  await expect(dryRun).toBeVisible();
  await dryRun.getByLabel("Repository").fill(daemon.repo);
  await dryRun.getByLabel("Prompt (optional)").click();
  await dryRun.getByRole("button", { name: "Run", exact: true }).click();
  const result = dryRun.getByRole("region", { name: "Dry-run result" });
  await expect(result).toContainText("OK", { timeout: 45_000 });
  await expect(result).toContainText(/\d[\d,]* ms/);
  await expect(result).toContainText("1 entry would be added");
  await expect(result.getByRole("article", { name: "One" })).toContainText("first entry for");
  await expectContentClearsBorder(dryRun);
  await capture(page, "dry-run");
  await dryRun.getByRole("button", { name: "Close" }).click();
  await expect(dryRun).toHaveCount(0);

  // Caller identity and the two budgets.
  await panel(page).getByRole("textbox", { name: "Caller identity" }).fill("  operator@example.test ");
  await panel(page).getByRole("spinbutton", { name: "Step deadline (ms)" }).fill("20000");
  await panel(page).getByRole("spinbutton", { name: "Context budget (KiB)" }).fill("48");
  await panel(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(panel(peer).getByRole("textbox", { name: "Caller identity" })).toHaveValue("operator@example.test");
  await expect(panel(peer).getByRole("spinbutton", { name: "Step deadline (ms)" })).toHaveValue("20000");
  await expect(panel(peer).getByRole("spinbutton", { name: "Context budget (KiB)" })).toHaveValue("48");
  const saved = await shapingConfig(daemon);
  expect(saved.caller.user).toBe("operator@example.test");
  expect(saved.limits).toMatchObject({ deadlineMs: 20_000, totalBytes: 48 * 1024 });
  await expect(panel(page).getByRole("button", { name: "Save", exact: true })).toBeDisabled();

  // A refused write rolls back and says why. The daemon is made to refuse this one write.
  await page.route("**/api/shaping", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "invalid_shaper", reason: "Refused for this test." }) });
  });
  await pill(page, "Seeded notes").click();
  await expect(row(page, "Seeded notes").getByRole("alert")).toHaveText("Refused for this test.");
  await expect(pill(page, "Seeded notes")).toHaveAccessibleName("Seeded notes: off");
  await expect(pill(peer, "Seeded notes")).toHaveAccessibleName("Seeded notes: off");
  expect((await shapingConfig(daemon)).overrides["seeded-notes"]).toBe(false);
  // An import the daemon refuses keeps the dialog open with the reason, and adds no row.
  await panel(page).getByRole("button", { name: "Import manifest…" }).click();
  const refusedImport = page.getByRole("dialog", { name: "Import a shaper" });
  await expect(refusedImport.getByRole("alert")).toHaveCount(0);
  await refusedImport.getByRole("textbox", { name: "Manifest" }).fill(JSON.stringify(commandShaper("refused-notes", "Refused notes")));
  await refusedImport.getByRole("button", { name: "Save switched off" }).click();
  await expect(refusedImport.getByRole("alert")).toHaveText("Refused for this test.");
  await refusedImport.getByRole("button", { name: "Cancel" }).click();
  await expect(refusedImport).toHaveCount(0);
  await expect(row(page, "Refused notes")).toHaveCount(0);
  await page.unroute("**/api/shaping");

  // Remove asks once more, then goes from both windows.
  await page.getByRole("button", { name: "Remove Seeded notes" }).click();
  await page.getByRole("button", { name: "Confirm removing Seeded notes" }).click();
  await expect(row(page, "Seeded notes")).toHaveCount(0);
  await expect(row(peer, "Seeded notes")).toHaveCount(0);
  await expect(gatherRows(page)).toHaveText(["Repository notes"]);
  expect((await shapingConfig(daemon)).shapers.map((entry) => entry.id)).toEqual(["repo-notes"]);
  await capture(peer, "panel");

  // Off again from the first window: the category leaves the peer's rail, its page and search.
  await page.getByRole("tab", { name: "Feature flags" }).click();
  await page.getByRole("button", { name: /^Task shaping:/ }).click();
  await expect(rail(peer).getByRole("tab", { name: "Task shaping" })).toHaveCount(0);
  await expect(panel(peer)).toHaveCount(0);
  await expect(peer.getByRole("tab", { name: "Display", selected: true })).toBeVisible();
  expect(peerNavigations, "the second window changed without navigating").toBe(0);
});

async function putShaping(daemon: DaemonHandle, intent: unknown): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/shaping`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(intent),
  });
  expect(response.status).toBe(200);
}

/** A fixture shaper running one mode of the unit suite's fake shaper, with its extra arguments. */
function modeShaper(id: string, label: string, mode: string, ...args: string[]) {
  return commandShaper(id, label, { transport: { type: "command", command: process.execPath, args: [FAKE_SHAPER, mode, ...args] } });
}

test("the panel's other paths: switching off, keeping a shaper, a file import, the identity and budget bounds, Reset, a refused save, and dry runs that fail or are closed", async ({ dashboard: page, context, daemon }) => {
  test.setTimeout(120_000);
  await setFlag(daemon, true);
  await putShaping(daemon, { kind: "upsert", shaper: commandShaper("on-notes", "On notes") });
  await putShaping(daemon, { kind: "enable", id: "on-notes", enabled: true });
  await putShaping(daemon, { kind: "upsert", shaper: modeShaper("broken-notes", "Broken notes", "fail") });
  // Slow enough that the dialog is closed long before it answers, inside its own 30 s timeout.
  await putShaping(daemon, { kind: "upsert", shaper: modeShaper("slow-notes", "Slow notes", "slow", "25000") });

  await page.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  const peer = await context.newPage();
  await peer.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  await expect(row(page, "On notes")).toBeVisible();
  await expect(row(peer, "On notes")).toBeVisible();

  // Switching an on shaper off, at once in both windows.
  await expect(pill(page, "On notes")).toHaveAccessibleName("On notes: on");
  await pill(page, "On notes").click();
  await expect(pill(page, "On notes")).toHaveAccessibleName("On notes: off");
  await expect(pill(peer, "On notes")).toHaveAccessibleName("On notes: off");
  await expect.poll(async () => (await shapingConfig(daemon)).overrides["on-notes"]).toBe(false);

  // Keep, at the removal prompt, removes nothing.
  await page.getByRole("button", { name: "Remove On notes" }).click();
  await expect(page.getByRole("button", { name: "Confirm removing On notes" })).toBeVisible();
  await row(page, "On notes").getByRole("button", { name: "Keep" }).click();
  await expect(page.getByRole("button", { name: "Confirm removing On notes" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove On notes" })).toBeVisible();
  await expect(row(page, "On notes")).toBeVisible();
  await expect(row(peer, "On notes")).toBeVisible();
  expect((await shapingConfig(daemon)).shapers.map((entry) => entry.id)).toContain("on-notes");

  // Import through the file chooser: the chosen file fills the manifest, is reviewed, and is saved off.
  await panel(page).getByRole("button", { name: "Import manifest…" }).click();
  const fromFile = page.getByRole("dialog", { name: "Import a shaper" });
  await fromFile.getByLabel("Choose a manifest file").setInputFiles({
    name: "file-notes.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(modeShaper("file-notes", "File notes", "ok"), null, 2)),
  });
  await expect(fromFile.getByRole("textbox", { name: "Manifest" })).toHaveValue(/"id": "file-notes"/);
  const fileReview = fromFile.getByRole("region", { name: "What this shaper runs or calls" });
  await expect(fileReview).toContainText("File notes");
  await expect(fileReview).toContainText(`${process.execPath} ${FAKE_SHAPER} ok`);
  await fromFile.getByRole("button", { name: "Save switched off" }).click();
  await expect(fromFile).toHaveCount(0);
  await expect(pill(page, "File notes")).toHaveAccessibleName("File notes: off");
  await expect(pill(peer, "File notes")).toHaveAccessibleName("File notes: off");
  expect((await shapingConfig(daemon)).overrides["file-notes"]).toBe(false);

  // The budgets: inside and at both bounds Save is offered; just outside, empty, or not a whole
  // number of milliseconds, it is not, and the field says why.
  const form = page.getByRole("form", { name: "Caller identity and budgets" });
  const deadline = form.getByRole("spinbutton", { name: "Step deadline (ms)" });
  const budget = form.getByRole("spinbutton", { name: "Context budget (KiB)" });
  const save = form.getByRole("button", { name: "Save", exact: true });
  const reset = form.getByRole("button", { name: "Reset" });
  const deadlineProblem = form.getByText("A whole number of milliseconds from 100 to 60,000.");
  const budgetProblem = form.getByText("From 1 to 64 KiB.");
  await expect(deadline).toHaveValue("10000");
  await expect(budget).toHaveValue("32");
  await expect(save).toBeDisabled();
  // Each bound saves, stores the exact byte count, and reaches the other window. The last pair
  // puts back the defaults the checks below start from.
  const peerDeadline = panel(peer).getByRole("spinbutton", { name: "Step deadline (ms)" });
  const peerBudget = panel(peer).getByRole("spinbutton", { name: "Context budget (KiB)" });
  for (const [deadlineMs, kib, totalBytes] of [["100", "1", 1024], ["60000", "64", 65_536], ["10000", "32", 32_768]] as const) {
    await deadline.fill(deadlineMs);
    await budget.fill(kib);
    await expect(deadlineProblem).toHaveCount(0);
    await expect(budgetProblem).toHaveCount(0);
    await expect(save).toBeEnabled();
    await save.click();
    await expect.poll(async () => (await shapingConfig(daemon)).limits)
      .toMatchObject({ deadlineMs: Number(deadlineMs), totalBytes });
    await expect(peerDeadline).toHaveValue(deadlineMs);
    await expect(peerBudget).toHaveValue(kib);
    await expect(deadline).toHaveValue(deadlineMs);
    await expect(budget).toHaveValue(kib);
    await expect(save).toBeDisabled();
  }
  for (const bad of ["99", "60001", "", "150.5"]) {
    await deadline.fill(bad);
    await expect(deadlineProblem).toBeVisible();
    await expect(save).toBeDisabled();
  }
  await deadline.fill("20000");
  for (const bad of ["0.5", "65", ""]) {
    await budget.fill(bad);
    await expect(budgetProblem).toBeVisible();
    await expect(save).toBeDisabled();
  }
  // Reset puts back the confirmed values.
  await reset.click();
  await expect(deadline).toHaveValue("10000");
  await expect(budget).toHaveValue("32");
  await expect(deadlineProblem).toHaveCount(0);
  await expect(budgetProblem).toHaveCount(0);
  await expect(save).toBeDisabled();
  await expect(reset).toBeDisabled();

  // The caller identity is at most 256 characters: 257 is refused before it is sent, 256 saves.
  const identity = form.getByRole("textbox", { name: "Caller identity" });
  const identityProblem = form.getByText("At most 256 characters.");
  await identity.fill("a".repeat(257));
  await expect(identityProblem).toBeVisible();
  await expect(save).toBeDisabled();
  await identity.fill("a".repeat(256));
  await expect(identityProblem).toHaveCount(0);
  await expect(save).toBeEnabled();
  await save.click();
  await expect.poll(async () => (await shapingConfig(daemon)).caller.user).toBe("a".repeat(256));
  await expect(panel(peer).getByRole("textbox", { name: "Caller identity" })).toHaveValue("a".repeat(256));
  await expect(save).toBeDisabled();

  // A refused settings save shows the daemon's reason and the fields go back to the stored values.
  await page.route("**/api/shaping", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "invalid_shaper", reason: "Settings refused for this test." }) });
  });
  await deadline.fill("20000");
  await budget.fill("48");
  await save.click();
  await expect(form.getByRole("alert")).toHaveText("Settings refused for this test.");
  await expect(deadline).toHaveValue("10000");
  await expect(budget).toHaveValue("32");
  await page.unroute("**/api/shaping");
  expect((await shapingConfig(daemon)).limits).toMatchObject({ deadlineMs: 10_000, totalBytes: 32 * 1024 });
  await expect(panel(peer).getByRole("spinbutton", { name: "Step deadline (ms)" })).toHaveValue("10000");

  // A dry-run request that fails shows its reason and no result.
  const openDryRun = async (label: string) => {
    await page.getByRole("button", { name: `Dry-run ${label}` }).click();
    const dialog = page.getByRole("dialog", { name: `Dry-run ${label}` });
    await dialog.getByLabel("Repository").fill(daemon.repo);
    await dialog.getByLabel("Prompt (optional)").click();
    return dialog;
  };
  await page.route("**/api/shaping/test", (route) => route.fulfill({
    status: 400, contentType: "application/json", body: JSON.stringify({ error: "unknown_repository", reason: "Dry run refused for this test." }),
  }));
  let dialog = await openDryRun("On notes");
  await dialog.getByRole("button", { name: "Run", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Dry run refused for this test.");
  await expect(dialog.getByRole("region", { name: "Dry-run result" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.unroute("**/api/shaping/test");

  // A shaper that fails is an outcome in a successful reply, not a request error.
  dialog = await openDryRun("Broken notes");
  await dialog.getByRole("button", { name: "Run", exact: true }).click();
  const result = dialog.getByRole("region", { name: "Dry-run result" });
  await expect(result.locator(".shaping-outcome strong")).toHaveText("Failed", { timeout: 45_000 });
  await expect(result).toContainText("the shaper broke");
  await expect(result).toContainText("Nothing would be added.");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await capture(page, "dry-run-failed");
  await dialog.getByRole("button", { name: "Close" }).click();

  // Closing the dialog while a dry run is still going cancels its request, and the daemon stops
  // the shaper with it: the process is gone long before the 25 s it would otherwise take.
  dialog = await openDryRun("Slow notes");
  await dialog.getByRole("button", { name: "Run", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("Running Slow notes…");
  await expect.poll(slowShaperRunning, { timeout: 15_000 }).toBe(true);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(slowShaperRunning, { timeout: 10_000 }).toBe(false);
});

/** Whether this worktree's slow fixture shaper, the one `slow-notes` runs, is a live process. */
function slowShaperRunning(): boolean {
  return execFileSync("ps", ["-ax", "-o", "command="], { encoding: "utf8" })
    .split("\n").some((line) => line.includes(`${FAKE_SHAPER} slow 25000`));
}
