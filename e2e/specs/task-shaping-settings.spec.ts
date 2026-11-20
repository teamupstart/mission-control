import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
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
  // The dialog offers the first known repository once the list arrives; wait for it, so typing a
  // path never races that default into the same field.
  await expect(dryRun.getByLabel("Repository")).not.toHaveValue("");
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

/**
 * Counts, inside the page, each shaping write whose reply the app has read in full. A response
 * reaching the browser says nothing about the app having handled it; this ticks one macrotask
 * after the app's own read of the body resolves, once the code awaiting it has run.
 */
async function countReadWrites(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const counter = window as unknown as { shapingWritesRead: number };
    counter.shapingWritesRead = 0;
    const original = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await original(input, init);
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if ((init?.method ?? "GET").toUpperCase() === "PUT" && new URL(url, location.href).pathname === "/api/shaping") {
        const read = response.json.bind(response);
        response.json = async () => {
          try {
            return await read();
          } finally {
            setTimeout(() => { counter.shapingWritesRead += 1; }, 0);
          }
        };
      }
      return response;
    };
  });
  // The dashboard fixture has already loaded the page, and the hash navigation that follows keeps
  // the same document, so the script runs only once the page loads again.
  await page.reload();
}

/** Waits until the app has handled `count` shaping write replies, then for two frames to paint. */
async function writesHandled(page: Page, count: number): Promise<void> {
  await expect.poll(() => page.evaluate(() => (window as unknown as { shapingWritesRead: number }).shapingWritesRead)).toBe(count);
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

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
  // A marker of this run's own, which the fixture ignores, so the process check below finds the
  // shaper this test started and never one another run in the same checkout started.
  const slowMarker = "run-" + randomUUID();
  await putShaping(daemon, { kind: "upsert", shaper: modeShaper("slow-notes", "Slow notes", "slow", "25000", slowMarker) });

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
  // Each bound saves, stores the exact byte count, and reaches the other window, as does a deadline
  // that is not a multiple of 100 and a fractional budget. The last pair puts back the defaults
  // the checks below start from.
  const peerDeadline = panel(peer).getByRole("spinbutton", { name: "Step deadline (ms)" });
  const peerBudget = panel(peer).getByRole("spinbutton", { name: "Context budget (KiB)" });
  const savedPairs = [["100", "1", 1024], ["60000", "64", 65_536], ["101", "1.5", 1536], ["10000", "32", 32_768]] as const;
  for (const [deadlineMs, kib, totalBytes] of savedPairs) {
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
  // 64.0001 KiB rounds to the maximum in bytes, but is above the field's own bound, so it is refused too.
  for (const bad of ["0.5", "65", "", "64.0001"]) {
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

  // A budget stored through the API that is not a whole number of KiB survives a save of another
  // setting: the field shows it rounded, and the stored bytes are kept, not read back from that text.
  await putShaping(daemon, { kind: "settings", limits: { totalBytes: 1025 } });
  await expect(budget).toHaveValue("1.001");
  await identity.fill("precise");
  await save.click();
  await expect.poll(async () => (await shapingConfig(daemon)).caller.user).toBe("precise");
  expect((await shapingConfig(daemon)).limits.totalBytes).toBe(1025);
  await putShaping(daemon, { kind: "settings", limits: { totalBytes: 32_768 } });
  await expect(budget).toHaveValue("32");

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
    await expect(dialog.getByLabel("Repository")).not.toHaveValue("");
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

  // A success reply missing its fields is an error, never drawn as a run that would add nothing.
  await page.route("**/api/shaping/test", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ summary: null }),
  }));
  dialog = await openDryRun("On notes");
  await dialog.getByRole("button", { name: "Run", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("The daemon's dry-run reply was incomplete, so its result cannot be shown.");
  await expect(dialog.getByRole("region", { name: "Dry-run result" })).toHaveCount(0);
  await expect(dialog.getByText("Nothing would be added.")).toHaveCount(0);
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

  // Another window replaces On notes, with the same id and label, while its dry-run dialog is open:
  // the dialog says so and will not run the replacement under the name it opened with.
  dialog = await openDryRun("On notes");
  await putShaping(daemon, { kind: "upsert", shaper: modeShaper("on-notes", "On notes", "degraded") });
  await expect(dialog.getByRole("alert")).toContainText("was replaced in another window since this dialog opened");
  await expect(dialog.getByRole("button", { name: "Run", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Close" }).click();

  // The same for a removal awaiting confirmation: it was opened for the earlier definition, so it
  // closes rather than deleting the replacement.
  await page.getByRole("button", { name: "Remove On notes" }).click();
  await expect(page.getByRole("button", { name: "Confirm removing On notes" })).toBeVisible();
  await putShaping(daemon, { kind: "upsert", shaper: commandShaper("on-notes", "On notes") });
  await expect(page.getByRole("button", { name: "Confirm removing On notes" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove On notes" })).toBeVisible();
  expect((await shapingConfig(daemon)).shapers.map((entry) => entry.id)).toContain("on-notes");

  // Closing the dialog while a dry run is still going cancels its request, and the daemon stops
  // the shaper with it: the process is gone long before the 25 s it would otherwise take.
  dialog = await openDryRun("Slow notes");
  await dialog.getByRole("button", { name: "Run", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("Running Slow notes…");
  await expect.poll(() => slowShaperRunning(slowMarker), { timeout: 15_000 }).toBe(true);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => slowShaperRunning(slowMarker), { timeout: 10_000 }).toBe(false);
});

/** Whether the slow fixture shaper this test registered, named by its marker, is a live process. */
function slowShaperRunning(marker: string): boolean {
  return execFileSync("ps", ["-ax", "-o", "command="], { encoding: "utf8" })
    .split("\n").some((line) => line.includes(`${FAKE_SHAPER} slow 25000 ${marker}`));
}

// The race the settings hook exists for: this window's write commits, but its HTTP answer is held
// while the peer writes something newer. The event stream already said the first write landed, so
// the peer's later write stays authoritative here: the held answer never draws the older state.
test("a peer's newer write wins while this window's own write answer is still held", async ({ dashboard: page, context, daemon }) => {
  await setFlag(daemon, true);
  await putShaping(daemon, { kind: "upsert", shaper: commandShaper("race-notes", "Race notes") });
  await countReadWrites(page);
  await page.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  const peer = await context.newPage();
  await peer.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  await expect(pill(page, "Race notes")).toHaveAccessibleName("Race notes: off");
  await expect(pill(peer, "Race notes")).toHaveAccessibleName("Race notes: off");

  // Let this window's write reach the daemon, and hold its answer until the peer has written.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let committed!: () => void;
  const reachedDaemon = new Promise<void>((resolve) => { committed = resolve; });
  await page.route("**/api/shaping", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    const response = await route.fetch();
    committed();
    await held;
    await route.fulfill({ response });
  });

  await pill(page, "Race notes").click();
  await reachedDaemon;
  await expect.poll(async () => (await shapingConfig(daemon)).overrides["race-notes"]).toBe(true);
  await expect(pill(peer, "Race notes")).toHaveAccessibleName("Race notes: on");
  // The stream's frame already confirmed the write, so this window takes its next edit at once
  // instead of waiting on the held answer.
  await expect(pill(page, "Race notes")).toHaveAccessibleName("Race notes: on");
  await expect(pill(page, "Race notes")).toBeEnabled();

  // The peer writes the newer state while the first answer is still held.
  await pill(peer, "Race notes").click();
  await expect.poll(async () => (await shapingConfig(daemon)).overrides["race-notes"]).toBe(false);
  await expect(pill(peer, "Race notes")).toHaveAccessibleName("Race notes: off");
  // Already shown here before the held answer arrives: the stream's frame beats this window's optimism.
  await expect(pill(page, "Race notes")).toHaveAccessibleName("Race notes: off");

  // The older answer lands, and changes nothing either window shows.
  release();
  // The held answer has been read and handled before anything is checked, so the checks below
  // see what it left behind, not the state from before it arrived.
  await writesHandled(page, 1);
  await expect(pill(page, "Race notes")).toBeEnabled();
  await expect(pill(page, "Race notes")).toHaveAccessibleName("Race notes: off");
  await expect(pill(peer, "Race notes")).toHaveAccessibleName("Race notes: off");
  await expect(row(page, "Race notes").getByRole("alert")).toHaveCount(0);
  expect((await shapingConfig(daemon)).overrides["race-notes"]).toBe(false);
  await page.unroute("**/api/shaping");
});

// A frame can show what this window asked for when a peer wrote it. This window's enable is held
// before it reaches the daemon while a peer replaces the shaper and switches the replacement on:
// the frame shows "on" and frees the controls, then the daemon refuses the held enable because
// the definition it named is gone. The HTTP answer decides the outcome, so the refusal is shown.
test("a refused write is shown even after a peer's frame already showed what it asked for", async ({ dashboard: page, daemon }) => {
  await setFlag(daemon, true);
  await putShaping(daemon, { kind: "upsert", shaper: commandShaper("swap-notes", "Swap notes") });
  await page.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  await expect(pill(page, "Swap notes")).toHaveAccessibleName("Swap notes: off");

  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let sent!: () => void;
  const requested = new Promise<void>((resolve) => { sent = resolve; });
  await page.route("**/api/shaping", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    sent();
    await held;
    await route.continue();
  });
  const answer = page.waitForResponse((response) => response.url().endsWith("/api/shaping") && response.request().method() === "PUT");
  await pill(page, "Swap notes").click();
  await requested;
  // The peer replaces the definition this window showed, then switches the replacement on.
  await putShaping(daemon, { kind: "upsert", shaper: commandShaper("swap-notes", "Swap notes", { timeoutMs: 20_000 }) });
  await putShaping(daemon, { kind: "enable", id: "swap-notes", enabled: true });
  await expect(pill(page, "Swap notes")).toHaveAccessibleName("Swap notes: on");
  await expect(pill(page, "Swap notes")).toBeEnabled();

  release();
  expect((await answer).status()).toBe(409);
  await expect(row(page, "Swap notes").getByRole("alert"))
    .toHaveText("\"swap-notes\" changed in another window since it was shown here, so nothing was done. Review it again first.");
  // The peer's switch stays: the refusal changed nothing the daemon stores.
  await expect(pill(page, "Swap notes")).toHaveAccessibleName("Swap notes: on");
  expect((await shapingConfig(daemon)).overrides["swap-notes"]).toBe(true);
  await page.unroute("**/api/shaping");
});

test("the import dialog offers Save only for a file it has read and reviewed", async ({ dashboard: page, daemon }) => {
  await setFlag(daemon, true);
  await page.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  // Every file read waits until the test finishes it or fails it.
  await page.evaluate(() => {
    const read = Blob.prototype.text;
    const hooks = window as unknown as { finishRead?: (fail: boolean) => void };
    Blob.prototype.text = function (this: Blob) {
      return new Promise<string>((resolve, reject) => {
        hooks.finishRead = (fail) => {
          if (fail) reject(new Error("The disk went away."));
          else read.call(this).then(resolve, reject);
        };
      });
    };
  });
  const finishRead = (fail: boolean) => page.evaluate((value) => {
    (window as unknown as { finishRead: (fail: boolean) => void }).finishRead(value);
  }, fail);
  const file = (id: string, label: string) => ({
    name: id + ".json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(commandShaper(id, label))),
  });

  await panel(page).getByRole("button", { name: "Import manifest…" }).click();
  const dialog = page.getByRole("dialog", { name: "Import a shaper" });
  const manifest = dialog.getByRole("textbox", { name: "Manifest" });
  const save = dialog.getByRole("button", { name: "Save switched off" });
  const chooser = dialog.getByLabel("Choose a manifest file");
  const pasted = JSON.stringify(commandShaper("pasted-notes", "Pasted notes"));
  await manifest.fill(pasted);
  await expect(save).toBeEnabled();

  // While a chosen file is read, what was reviewed before is gone and nothing can be saved.
  await chooser.setInputFiles(file("chosen-notes", "Chosen notes"));
  await expect(dialog.getByRole("status")).toHaveText("Reading chosen-notes.json…");
  await expect(manifest).toHaveValue("");
  await expect(save).toBeDisabled();
  await finishRead(false);
  await expect(dialog.getByRole("status")).toHaveCount(0);
  await expect(manifest).toHaveValue(/"id":"chosen-notes"/);
  await expect(dialog.getByRole("region", { name: "What this shaper runs or calls" })).toContainText("Chosen notes");
  await expect(save).toBeEnabled();

  // A file that fails to read leaves nothing to save, not the file reviewed before it.
  await chooser.setInputFiles(file("lost-notes", "Lost notes"));
  await expect(save).toBeDisabled();
  await finishRead(true);
  await expect(dialog.getByRole("alert")).toHaveText("Could not read lost-notes.json: The disk went away.");
  await expect(manifest).toHaveValue("");
  await expect(save).toBeDisabled();

  // Nor does one too large to read, chosen over a pasted manifest.
  await manifest.fill(pasted);
  await expect(save).toBeEnabled();
  await chooser.setInputFiles({ name: "huge.json", mimeType: "application/json", buffer: Buffer.alloc(70_000, 0x20) });
  await expect(dialog.getByRole("alert")).toContainText("huge.json is 70,000 bytes.");
  await expect(manifest).toHaveValue("");
  await expect(save).toBeDisabled();

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  expect((await shapingConfig(daemon)).shapers).toEqual([]);
});

// The peer's frame frees the row while this window's first enable is held; the operator switches
// the shaper off again, which lands, and then the held enable is refused. That refusal is the
// first click's, so it says so instead of reading as the outcome of the switch just made.
test("a refusal that lands after a newer write on the same row names the earlier action", async ({ dashboard: page, daemon }) => {
  await setFlag(daemon, true);
  await putShaping(daemon, { kind: "upsert", shaper: commandShaper("late-notes", "Late notes") });
  await page.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  await expect(pill(page, "Late notes")).toHaveAccessibleName("Late notes: off");

  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let sent!: () => void;
  const requested = new Promise<void>((resolve) => { sent = resolve; });
  let puts = 0;
  await page.route("**/api/shaping", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    // Only the first write is held; every later one goes straight through.
    if (++puts === 1) { sent(); await held; }
    await route.continue();
  });
  // Each answer is read from its own request: the second write is answered before the first.
  const isPut = (request: { url(): string; method(): string }) => request.url().endsWith("/api/shaping") && request.method() === "PUT";
  const first = page.waitForRequest(isPut);
  await pill(page, "Late notes").click();
  await requested;
  await putShaping(daemon, { kind: "upsert", shaper: commandShaper("late-notes", "Late notes", { timeoutMs: 20_000 }) });
  await putShaping(daemon, { kind: "enable", id: "late-notes", enabled: true });
  await expect(pill(page, "Late notes")).toHaveAccessibleName("Late notes: on");
  await expect(pill(page, "Late notes")).toBeEnabled();

  // The newer write, on the same row, lands first.
  const second = page.waitForRequest(isPut);
  await pill(page, "Late notes").click();
  expect((await (await second).response())?.status()).toBe(200);
  await expect(pill(page, "Late notes")).toHaveAccessibleName("Late notes: off");
  await expect(row(page, "Late notes").getByRole("alert")).toHaveCount(0);

  release();
  expect((await (await first).response())?.status()).toBe(409);
  await expect(row(page, "Late notes").getByRole("alert")).toHaveText(
    "An earlier change, switching late-notes on, was refused: \"late-notes\" changed in another window since it was shown here, so nothing was done. Review it again first.",
  );
  await expect(pill(page, "Late notes")).toHaveAccessibleName("Late notes: off");
  expect((await shapingConfig(daemon)).overrides["late-notes"]).toBe(false);
  await page.unroute("**/api/shaping");
});

// Entries no import can produce, seeded the way a settings restore from another build leaves
// them: a second entry repeating an id, and an id that names an inherited object property.
test("a repeated id is listed without controls, and an id like constructor still sends its revision", async ({ dashboard: page, daemon }) => {
  withDaemonDb(daemon, (db) => {
    db.prepare(`INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run("shaping", JSON.stringify({
        shapers: [
          commandShaper("twin-notes", "Twin notes"),
          commandShaper("twin-notes", "Twin copy", { timeoutMs: 20_000 }),
          commandShaper("constructor", "Constructor notes"),
        ],
      }));
  });
  await setFlag(daemon, true);
  await page.goto(`${daemon.baseURL}/#/settings/task-shaping`);

  const owner = row(page, "Twin notes");
  const copy = panel(page).getByRole("group", { name: "Twin copy (repeated id)" });
  await expect(owner).toContainText("Another stored entry repeats the id twin-notes. Removing this shaper removes it too.");
  await expect(copy).toContainText('Another stored shaper already has the id "twin-notes".');
  await expect(copy).toContainText("It never runs. Removing the shaper that owns the id twin-notes removes this entry too.");
  await expect(copy.getByRole("button")).toHaveCount(0);

  // The constructor row's Remove carries the daemon's own revision for it.
  const removals: Array<{ id?: string; expect?: unknown }> = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().endsWith("/api/shaping")) removals.push(request.postDataJSON() as { id?: string });
  });
  const revisions = async () => {
    const response = await fetch(`${daemon.baseURL}/api/shaping`);
    return ((await response.json()) as { config: { revisions: Record<string, string> } }).config.revisions;
  };
  const constructorRevision = (await revisions()).constructor;
  expect(constructorRevision).toMatch(/^[0-9a-f]{16}$/);
  await page.getByRole("button", { name: "Remove Constructor notes" }).click();
  await page.getByRole("button", { name: "Confirm removing Constructor notes" }).click();
  await expect(row(page, "Constructor notes")).toHaveCount(0);
  expect(removals.find((intent) => intent.id === "constructor")).toEqual({ kind: "remove", id: "constructor", expect: constructorRevision });

  // Removing the owner removes its repeat with it.
  await page.getByRole("button", { name: "Remove Twin notes" }).click();
  await page.getByRole("button", { name: "Confirm removing Twin notes" }).click();
  await expect(owner).toHaveCount(0);
  await expect(copy).toHaveCount(0);
  expect((await shapingConfig(daemon)).shapers).toEqual([]);
});

// A save sends only what this window typed. With an unsaved identity edit open here, the peer
// changes both limits; this window's untouched fields follow the peer at once, and saving the
// identity keeps the peer's newer limits rather than writing back this window's stale copy.
test("saving one setting keeps another window's newer change to the fields left alone", async ({ dashboard: page, context, daemon }) => {
  await setFlag(daemon, true);
  await countReadWrites(page);
  await page.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  const peer = await context.newPage();
  await peer.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  const fields = (window: Page) => {
    const form = window.getByRole("form", { name: "Caller identity and budgets" });
    return {
      identity: form.getByRole("textbox", { name: "Caller identity" }),
      deadline: form.getByRole("spinbutton", { name: "Step deadline (ms)" }),
      budget: form.getByRole("spinbutton", { name: "Context budget (KiB)" }),
      save: form.getByRole("button", { name: "Save", exact: true }),
    };
  };
  const here = fields(page);
  const there = fields(peer);
  await expect(here.deadline).toHaveValue("10000");
  await expect(there.deadline).toHaveValue("10000");

  // An unsaved identity edit here.
  await here.identity.fill("first-window");
  await expect(here.save).toBeEnabled();

  // The peer changes both limits and saves.
  await there.deadline.fill("20000");
  await there.budget.fill("48");
  await there.save.click();
  await expect.poll(async () => (await shapingConfig(daemon)).limits).toMatchObject({ deadlineMs: 20_000, totalBytes: 48 * 1024 });

  // This window shows the peer's limits in the fields it did not touch, and keeps its own draft.
  await expect(here.deadline).toHaveValue("20000");
  await expect(here.budget).toHaveValue("48");
  await expect(here.identity).toHaveValue("first-window");

  // Saving the identity sends the identity alone, so the peer's newer limits stay.
  await here.save.click();
  await expect.poll(async () => (await shapingConfig(daemon)).caller.user).toBe("first-window");
  const saved = await shapingConfig(daemon);
  expect(saved.limits).toMatchObject({ deadlineMs: 20_000, totalBytes: 48 * 1024 });
  for (const window of [here, there]) {
    await expect(window.identity).toHaveValue("first-window");
    await expect(window.deadline).toHaveValue("20000");
    await expect(window.budget).toHaveValue("48");
    await expect(window.save).toBeDisabled();
  }

  // A save whose reply is held after it commits: the stream frees the form first, and an edit
  // typed in that interval survives the late reply instead of being cleared with the saved draft.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/shaping", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  await here.identity.fill("second-window-save");
  await here.save.click();
  await expect.poll(async () => (await shapingConfig(daemon)).caller.user).toBe("second-window-save");
  await expect(here.budget).toBeEnabled();
  await here.budget.fill("40");
  release();
  // The identity save above was this window's first write; the held one is its second.
  await writesHandled(page, 2);
  await expect(here.budget).toHaveValue("40");
  await expect(here.identity).toHaveValue("second-window-save");
  await expect(here.save).toBeEnabled();
  await page.unroute("**/api/shaping");
});

// A move is an intent the daemon applies to the order as stored. A shaper the list does not draw
// keeps its slot between the two it sat between, moves from two windows in different stages both
// stick, and a daemon that never answers a save stops holding the panel after a bounded wait.
test("a move keeps a hidden shaper's slot and composes with another window's move, and a save that is never answered stops waiting", async ({ dashboard: page, context, daemon }) => {
  test.setTimeout(90_000);
  await setFlag(daemon, true);
  for (const [id, label, stage] of [["a-notes", "A notes", "gather"], ["b-notes", "B notes", "gather"], ["s1-notes", "S1 notes", "select"], ["s2-notes", "S2 notes", "select"]] as const) {
    await putShaping(daemon, { kind: "upsert", shaper: commandShaper(id, label, { stage }) });
  }
  // Stored order A, X, B, with X a shaper the list does not draw.
  await putShaping(daemon, { kind: "reorder", order: ["a-notes", "hidden-x", "b-notes"] });
  await page.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  const peer = await context.newPage();
  await peer.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  await expect(gatherRows(page)).toHaveText(["A notes", "B notes"]);
  const selectRows = (window: Page) => panel(window).getByRole("group", { name: "Select" }).locator(".shaping-row strong");
  await expect(selectRows(peer)).toHaveText(["S1 notes", "S2 notes"]);

  // This window moves B up; the peer moves S2 up. Each sends where its shaper goes, not an order.
  await page.getByRole("button", { name: "Move B notes up" }).click();
  await peer.getByRole("button", { name: "Move S2 notes up" }).click();
  for (const window of [page, peer]) {
    await expect(gatherRows(window)).toHaveText(["B notes", "A notes"]);
    await expect(selectRows(window)).toHaveText(["S2 notes", "S1 notes"]);
  }
  // X kept its slot between them, rather than being pushed to run first.
  const order = (await shapingConfig(daemon)).order;
  expect(order.slice(0, 3)).toEqual(["b-notes", "hidden-x", "a-notes"]);
  expect(order).toEqual(expect.arrayContaining(["s2-notes", "s1-notes"]));
  expect(order.indexOf("s2-notes")).toBeLessThan(order.indexOf("s1-notes"));

  // A move the daemon refuses because the order is full draws nothing, and that unchanged view is
  // not taken for done: the refusal's reason reaches the row.
  await putShaping(daemon, { kind: "reorder", order: Array.from({ length: 128 }, (_, n) => `gone-${n}`) });
  await expect(gatherRows(page)).toHaveText(["A notes", "B notes"]);
  await page.route("**/api/shaping", (route) => route.request().method() !== "PUT" ? route.fallback() : route.fulfill({
    status: 400, contentType: "application/json",
    body: JSON.stringify({ error: "order_full", reason: "The stored run order is full: it holds at most 128 shaper ids. This move needs 130." }),
  }));
  await page.getByRole("button", { name: "Move B notes up" }).click();
  await expect(row(page, "B notes").getByRole("alert")).toHaveText("The stored run order is full: it holds at most 128 shaper ids. This move needs 130.");
  await expect(gatherRows(page)).toHaveText(["A notes", "B notes"]);
  await expect(page.getByRole("button", { name: "Move B notes up" })).toBeEnabled();
  await page.unroute("**/api/shaping");

  // A save the daemon never answers, and never receives: after its bounded wait the panel stops
  // waiting, says so, and shows the daemon's settings again.
  await page.route("**/api/shaping", (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    // Held without an answer until the browser gives up on it.
  });
  await pill(page, "A notes").click();
  await expect(pill(page, "A notes")).toHaveAccessibleName("A notes: on");
  await expect(row(page, "A notes").getByRole("alert")).toContainText("did not answer within 15 seconds", { timeout: 25_000 });
  await expect(pill(page, "A notes")).toHaveAccessibleName("A notes: off");
  await expect(pill(page, "A notes")).toBeEnabled();
  expect((await shapingConfig(daemon)).overrides["a-notes"]).toBe(false);
  await page.unroute("**/api/shaping");
});

/** A gate a route handler waits on, opened by the test. */
function gate(): { open: () => void; opened: Promise<void> } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
}

test("an imported row is not offered a dry run until the daemon has answered for it", async ({ dashboard: page, daemon }) => {
  await setFlag(daemon, true);
  await page.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  // The import never reaches the daemon until the test lets it: no frame can bring a revision.
  const reached = gate();
  const answer = gate();
  await page.route("**/api/shaping", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    reached.open();
    await answer.opened;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "save_failed", message: "Held by the test." }) });
  });
  await panel(page).getByRole("button", { name: "Import manifest…" }).click();
  const dialog = page.getByRole("dialog", { name: "Import a shaper" });
  await dialog.getByRole("textbox", { name: "Manifest" }).fill(JSON.stringify(commandShaper("held-notes", "Held notes")));
  await dialog.getByRole("button", { name: "Save switched off" }).click();
  await reached.opened;
  // Drawn at once, but with no revision of the daemon's yet, so nothing can be run against it.
  await expect(row(page, "Held notes")).toBeVisible();
  await expect(page.getByRole("button", { name: "Dry-run Held notes" })).toBeDisabled();
  answer.open();
  await expect(row(page, "Held notes")).toHaveCount(0);
  await page.unroute("**/api/shaping");
});

test("a save that answers late closes only the import dialog that sent it", async ({ dashboard: page, daemon }) => {
  await setFlag(daemon, true);
  await page.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  // The import reaches the daemon at once; only its answer is held, so the frame frees the dialog.
  const answer = gate();
  await page.route("**/api/shaping", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    const response = await route.fetch();
    await answer.opened;
    await route.fulfill({ response });
  });
  await panel(page).getByRole("button", { name: "Import manifest…" }).click();
  const dialog = page.getByRole("dialog", { name: "Import a shaper" });
  const manifest = dialog.getByRole("textbox", { name: "Manifest" });
  await manifest.fill(JSON.stringify(commandShaper("first-notes", "First notes")));
  await dialog.getByRole("button", { name: "Save switched off" }).click();
  await expect(pill(page, "First notes")).toHaveAccessibleName("First notes: off");
  // Freed by the frame: closed, opened again, and a second manifest under review.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await panel(page).getByRole("button", { name: "Import manifest…" }).click();
  const second = JSON.stringify(commandShaper("second-notes", "Second notes"));
  await manifest.fill(second);
  const answered = page.waitForResponse((response) => response.url().endsWith("/api/shaping") && response.request().method() === "PUT");
  answer.open();
  await (await answered).finished();
  await page.evaluate(() => new Promise<void>((done) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => done())), 50)));
  await expect(dialog).toBeVisible();
  await expect(manifest).toHaveValue(second);
  await page.unroute("**/api/shaping");
  await dialog.getByRole("button", { name: "Save switched off" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(pill(page, "Second notes")).toHaveAccessibleName("Second notes: off");
});

test("the import dialog says whether an unsupported entry's id can be replaced, as the daemon decides", async ({ dashboard: page, daemon }) => {
  withDaemonDb(daemon, (db) => {
    db.prepare(`INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run("shaping", JSON.stringify({
        shapers: [
          // A literal token in an argument: stored with it emptied, so it no longer runs as written.
          commandShaper("leaked-notes", "Leaked notes", {
            transport: { type: "command", command: process.execPath, args: [FAKE_SHAPER, "ok", "ghp_" + "a".repeat(36)] },
          }),
          { id: "future-notes", label: "Future notes", stage: "route", transport: { type: "grpc" } },
        ],
      }));
  });
  await setFlag(daemon, true);
  await page.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  await expect(row(page, "Leaked notes")).toContainText("A literal credential was removed");

  await panel(page).getByRole("button", { name: "Import manifest…" }).click();
  const dialog = page.getByRole("dialog", { name: "Import a shaper" });
  const manifest = dialog.getByRole("textbox", { name: "Manifest" });
  await manifest.fill(JSON.stringify(commandShaper("future-notes", "Future replacement")));
  await expect(dialog).toContainText('A shaper this build cannot run already has the id "future-notes". It can only be switched off or removed, so this import will be refused.');
  await manifest.fill(JSON.stringify(commandShaper("leaked-notes", "Leaked notes")));
  await expect(dialog).toContainText('This replaces the registered shaper "Leaked notes" and switches it off.');
  await dialog.getByRole("button", { name: "Save switched off" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row(page, "Leaked notes")).not.toContainText("A literal credential was removed");
  await expect(pill(page, "Leaked notes")).toHaveAccessibleName("Leaked notes: off");
});

test("a save's late answer keeps an edit made after it, even one that types the submitted text again", async ({ dashboard: page, daemon }) => {
  await setFlag(daemon, true);
  await countReadWrites(page);
  await page.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  const form = page.getByRole("form", { name: "Caller identity and budgets" });
  const identity = form.getByRole("textbox", { name: "Caller identity" });
  const answer = gate();
  await page.route("**/api/shaping", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    const response = await route.fetch();
    await answer.opened;
    await route.fulfill({ response });
  });
  await identity.fill("alice");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  // The frame frees the form before the answer: the operator types away and back again.
  await expect.poll(async () => (await shapingConfig(daemon)).caller.user).toBe("alice");
  await expect(identity).toBeEnabled();
  await identity.fill("bob");
  await identity.fill("alice");
  // Another window then changes the identity.
  await putShaping(daemon, { kind: "settings", caller: { user: "carol" } });
  await expect.poll(async () => (await shapingConfig(daemon)).caller.user).toBe("carol");
  answer.open();
  await writesHandled(page, 1);
  await expect(identity).toHaveValue("alice");
  await expect(form.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  await page.unroute("**/api/shaping");
});

test("a later write that succeeds on a row clears the earlier write's refusal shown there", async ({ dashboard: page, daemon }) => {
  await setFlag(daemon, true);
  await putShaping(daemon, { kind: "upsert", shaper: commandShaper("clear-notes", "Clear notes") });
  await page.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  await expect(pill(page, "Clear notes")).toHaveAccessibleName("Clear notes: off");
  // The first write is held before it reaches the daemon; the second reaches it and only its
  // answer is held. So the second lands first and the first is refused, then answered in order.
  const firstGoes = gate();
  const secondAnswers = gate();
  const firstSent = gate();
  let puts = 0;
  await page.route("**/api/shaping", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    if (++puts === 1) {
      firstSent.open();
      await firstGoes.opened;
      return route.continue();
    }
    const response = await route.fetch();
    await secondAnswers.opened;
    await route.fulfill({ response });
  });
  const isPut = (request: { url(): string; method(): string }) => request.url().endsWith("/api/shaping") && request.method() === "PUT";
  const first = page.waitForRequest(isPut);
  await pill(page, "Clear notes").click();
  await firstSent.opened;
  await putShaping(daemon, { kind: "upsert", shaper: commandShaper("clear-notes", "Clear notes", { timeoutMs: 20_000 }) });
  await putShaping(daemon, { kind: "enable", id: "clear-notes", enabled: true });
  await expect(pill(page, "Clear notes")).toHaveAccessibleName("Clear notes: on");
  await expect(pill(page, "Clear notes")).toBeEnabled();
  await pill(page, "Clear notes").click();
  await expect.poll(async () => (await shapingConfig(daemon)).overrides["clear-notes"]).toBe(false);

  firstGoes.open();
  expect((await (await first).response())?.status()).toBe(409);
  const alert = row(page, "Clear notes").getByRole("alert");
  await expect(alert).toContainText("An earlier change, switching clear-notes on, was refused");
  // The second write's success is the row's latest outcome, so the earlier refusal goes.
  secondAnswers.open();
  await expect(alert).toHaveCount(0);
  await expect(pill(page, "Clear notes")).toHaveAccessibleName("Clear notes: off");
  await page.unroute("**/api/shaping");
});

test("a refusal that arrives late never replaces the newer refusal under the same row", async ({ dashboard: page, daemon }) => {
  await setFlag(daemon, true);
  await putShaping(daemon, { kind: "upsert", shaper: commandShaper("both-notes", "Both notes") });
  await page.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  await expect(pill(page, "Both notes")).toHaveAccessibleName("Both notes: off");
  // Both writes are held before they reach the daemon, and each is refused once let through,
  // because a peer replaced the shaper after each was sent. The newer one is answered first.
  const gates = [gate(), gate()];
  const sent = [gate(), gate()];
  let puts = 0;
  await page.route("**/api/shaping", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    const at = puts++;
    sent[at]!.open();
    await gates[at]!.opened;
    await route.continue();
  });
  const isPut = (request: { url(): string; method(): string }) => request.url().endsWith("/api/shaping") && request.method() === "PUT";
  const first = page.waitForRequest(isPut);
  await pill(page, "Both notes").click();
  await sent[0]!.opened;
  // A peer replaces and switches it on: the frame frees the row for the second click.
  await putShaping(daemon, { kind: "upsert", shaper: commandShaper("both-notes", "Both notes", { timeoutMs: 20_000 }) });
  await putShaping(daemon, { kind: "enable", id: "both-notes", enabled: true });
  await expect(pill(page, "Both notes")).toHaveAccessibleName("Both notes: on");
  await expect(pill(page, "Both notes")).toBeEnabled();
  const second = page.waitForRequest((request) => isPut(request) && request.postDataJSON()?.enabled === false);
  await pill(page, "Both notes").click();
  await sent[1]!.opened;
  // The peer replaces it again, so the second click names a definition that is gone too.
  await putShaping(daemon, { kind: "upsert", shaper: commandShaper("both-notes", "Both notes", { timeoutMs: 25_000 }) });
  await expect(pill(page, "Both notes")).toHaveAccessibleName("Both notes: off");

  const changed = "\"both-notes\" changed in another window since it was shown here, so nothing was done. Review it again first.";
  const alert = row(page, "Both notes").getByRole("alert");
  const earlier = row(page, "Both notes").getByRole("list", { name: "Earlier refusals" });
  // A polite live region is already there, empty, before any late refusal arrives in it.
  const live = row(page, "Both notes").locator("[aria-live=polite]");
  await expect(live).toHaveCount(1);
  await expect(live).toBeEmpty();
  gates[1]!.open();
  expect((await (await second).response())?.status()).toBe(409);
  await expect(alert).toHaveText(changed);
  gates[0]!.open();
  expect((await (await first).response())?.status()).toBe(409);
  // The latest action's reason stays the row's refusal; the late one is listed apart from it.
  await expect(earlier).toHaveText(`An earlier change, switching both-notes on, was refused: ${changed}`);
  await expect(live.getByRole("list", { name: "Earlier refusals" })).toHaveCount(1);
  await expect(alert).toHaveText(changed);
  await page.unroute("**/api/shaping");
});

test("a save that answers late keeps a manifest pasted into the same dialog after it", async ({ dashboard: page, daemon }) => {
  await setFlag(daemon, true);
  await countReadWrites(page);
  await page.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  // The import reaches the daemon at once; only its answer is held, so the frame frees the dialog.
  const answer = gate();
  await page.route("**/api/shaping", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    const response = await route.fetch();
    await answer.opened;
    await route.fulfill({ response });
  });
  await panel(page).getByRole("button", { name: "Import manifest…" }).click();
  const dialog = page.getByRole("dialog", { name: "Import a shaper" });
  const manifest = dialog.getByRole("textbox", { name: "Manifest" });
  await manifest.fill(JSON.stringify(commandShaper("saved-notes", "Saved notes")));
  await dialog.getByRole("button", { name: "Save switched off" }).click();
  await expect(pill(page, "Saved notes")).toHaveAccessibleName("Saved notes: off");
  // Freed by the frame, the same dialog takes the next manifest before the answer lands.
  await expect(manifest).toBeEnabled();
  const next = JSON.stringify(commandShaper("next-notes", "Next notes"));
  await manifest.fill(next);
  answer.open();
  await writesHandled(page, 1);
  await expect(dialog).toBeVisible();
  await expect(manifest).toHaveValue(next);
  await expect(dialog.getByRole("region", { name: "What this shaper runs or calls" })).toContainText("Next notes");
  await page.unroute("**/api/shaping");
  // Unchanged since its own save, the dialog closes when that one lands.
  await dialog.getByRole("button", { name: "Save switched off" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(pill(page, "Next notes")).toHaveAccessibleName("Next notes: off");
});

test("a refusal stays under its own row while another control writes", async ({ dashboard: page, daemon }) => {
  await setFlag(daemon, true);
  await putShaping(daemon, { kind: "upsert", shaper: commandShaper("kept-notes", "Kept notes") });
  await page.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  // The switch is refused once, by the test standing in for the daemon.
  await page.route("**/api/shaping", (route) => route.request().method() !== "PUT" ? route.fallback() : route.fulfill({
    status: 409, contentType: "application/json", body: JSON.stringify({ error: "shaper_changed", reason: "Refused for this test." }),
  }));
  await pill(page, "Kept notes").click();
  const alert = row(page, "Kept notes").getByRole("alert");
  await expect(alert).toHaveText("Refused for this test.");
  await page.unroute("**/api/shaping");
  // A save in the settings form neither clears nor replaces it.
  const form = page.getByRole("form", { name: "Caller identity and budgets" });
  await form.getByRole("textbox", { name: "Caller identity" }).fill("other-control");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(async () => (await shapingConfig(daemon)).caller.user).toBe("other-control");
  await expect(form.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect(alert).toHaveText("Refused for this test.");
  // Acting on the row again dismisses it, and the switch goes through.
  await pill(page, "Kept notes").click();
  await expect(alert).toHaveCount(0);
  await expect(pill(page, "Kept notes")).toHaveAccessibleName("Kept notes: on");
});

test("an import whose answer is lost is reported unconfirmed, never refused", async ({ dashboard: page, daemon }) => {
  await setFlag(daemon, true);
  await page.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  const dialog = page.getByRole("dialog", { name: "Import a shaper" });
  const manifest = dialog.getByRole("textbox", { name: "Manifest" });
  const save = dialog.getByRole("button", { name: "Save switched off" });

  // Stored, and shown by the stream, but the answer never arrives: the dialog closes as saved.
  await page.route("**/api/shaping", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    await route.fetch();
    // Only once a frame has brought the stored row: Dry run waits for the daemon's revision.
    await expect(page.getByRole("button", { name: "Dry-run Lost answer" })).toBeEnabled();
    await route.abort("connectionreset");
  });
  await panel(page).getByRole("button", { name: "Import manifest…" }).click();
  await manifest.fill(JSON.stringify(commandShaper("lost-answer", "Lost answer")));
  await save.click();
  await expect(dialog).toHaveCount(0);
  await expect(pill(page, "Lost answer")).toHaveAccessibleName("Lost answer: off");
  await page.unroute("**/api/shaping");

  // Never reaching the daemon, the outcome is unknown: the dialog stays open and says so.
  await page.route("**/api/shaping", (route) => route.request().method() !== "PUT" ? route.fallback() : route.abort("connectionreset"));
  await panel(page).getByRole("button", { name: "Import manifest…" }).click();
  await manifest.fill(JSON.stringify(commandShaper("never-sent", "Never sent")));
  await save.click();
  const outcome = dialog.getByRole("alert");
  await expect(outcome).toHaveText("The daemon's answer did not arrive. Whether this change was stored is unknown: this shows the daemon's current settings, so make the change again if it is missing.");
  await expect(outcome).not.toContainText("refused");
  await expect(dialog).toBeVisible();
  await page.unroute("**/api/shaping");
  expect((await shapingConfig(daemon)).shapers.map((entry) => entry.id)).toEqual(["lost-answer"]);
});
