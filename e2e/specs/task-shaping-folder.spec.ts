import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * A shaper installed by dropping a folder, from the filesystem to what the session received.
 *
 * Only this layer connects the pieces: with the daemon already running, a folder is written into
 * its state home's `shapers/`; the next dispatch from the Dispatch button reads it, runs its `./`
 * program and delivers its context in turn one; the viewer names it as found on disk with the
 * manifest's hash; Settings lists it as Found on disk with its path; and switching it off there
 * stops it at the following dispatch.
 *
 * No model tokens: the agents are the suite's fakes, and the folder's program runs
 * `e2e/fixtures/fake-shaper.mjs`, which answers from a fixed script.
 */

const SHAPER = fileURLToPath(new URL("../fixtures/fake-shaper.mjs", import.meta.url));
const EVIDENCE = artifactsDir("task-shaping-folder");

async function shoot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await (target ?? page).screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/task-shaping-folder/${name}.png`);
}

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

/** A shaper folder in the running daemon's state home, owner-only writable as discovery requires. */
function dropShaperFolder(daemon: DaemonHandle, id: string, label: string, extra: Record<string, unknown> = {}): string {
  const root = join(daemon.home, "shapers");
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  chmodSync(root, 0o755);
  chmodSync(dir, 0o755);
  const program = join(dir, "run");
  writeFileSync(program, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(SHAPER)} ok\n`);
  chmodSync(program, 0o755);
  const manifest = join(dir, "shaper.json");
  writeFileSync(manifest, JSON.stringify({ id, label, stage: "select", timeoutMs: 30_000, transport: { type: "command", command: "./run" }, ...extra }, null, 2));
  chmodSync(manifest, 0o644);
  return realpathSync(dir);
}

async function useLayout(page: Page, daemon: DaemonHandle, layout: "board" | "console"): Promise<void> {
  await api(daemon, "/api/ui/config", { layout }, "PUT");
  await page.reload();
  await expect(page.getByRole("button", { name: "Dispatch" })).toBeVisible();
}

/** Dispatch from the modal, as an operator does, and return the task it filed. */
async function dispatch(page: Page, daemon: DaemonHandle, intent: string, title: string): Promise<{ id: string }> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(intent);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: /^Backlog details/ }).click();
  await dialog.getByPlaceholder("summarized from the task if left blank").fill(title);
  const created = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/tasks");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  const response = await created;
  expect(response.ok(), `dispatching answered ${response.status()}`).toBe(true);
  await expect(dialog).toBeHidden();
  return await response.json() as { id: string };
}

/** Every user turn the fake Claude recorded under this daemon's home. */
function recordedUserTurns(daemon: DaemonHandle): string[] {
  const root = join(daemon.home, ".claude", "projects");
  if (!existsSync(root)) return [];
  const turns: string[] = [];
  for (const project of readdirSync(root)) {
    for (const file of readdirSync(join(root, project)).filter((name) => name.endsWith(".jsonl"))) {
      for (const line of readFileSync(join(root, project, file), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
          if (record.type !== "user") continue;
          const content = record.message?.content;
          turns.push(typeof content === "string" ? content : JSON.stringify(content));
        } catch {
          // A line still being written; the next poll reads it whole.
        }
      }
    }
  }
  return turns;
}

function sessionRail(page: Page, title: string): Locator {
  return page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row", { hasText: title });
}

test("a folder dropped into the running daemon's shapers/ shapes the next dispatch, is listed in Settings, and is stopped there", async ({ dashboard, daemon }) => {
  test.setTimeout(180_000);
  await api(daemon, "/api/feature-flags", { kind: "flag", id: "task-shaping", enabled: true }, "PUT");
  await useLayout(dashboard, daemon, "console");

  // Installed with no click and no restart: the daemon is already running when the folder lands.
  const path = dropShaperFolder(daemon, "folder-notes", "Folder notes");
  const manifestHash = (await api<{ discovered: Array<{ id: string; state: string; sha256: string }> }>(daemon, "/api/shaping"))
    .discovered.find((entry) => entry.id === "folder-notes");
  expect(manifestHash?.state).toBe("ok");

  const title = "Charge each key once";
  const task = await dispatch(dashboard, daemon, "Make the charge endpoint idempotent.", title);
  const turnOne = () => recordedUserTurns(daemon).find((turn) => turn.includes("Make the charge endpoint idempotent.")) ?? "";
  await expect.poll(turnOne, { timeout: 60_000 })
    .toMatch(/Make the charge endpoint idempotent\.[\s\S]*## Task context[\s\S]*### Folder notes: Idempotent charges/);

  // The viewer names the folder shaper, where it came from and exactly which manifest ran.
  await sessionRail(dashboard, title).click();
  const chip = dashboard.locator(".console-detail").getByRole("button", { name: "Context: 2 entries", exact: true });
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await chip.click();
  const viewer = dashboard.getByRole("dialog", { name: "Context this session received" });
  const entry = viewer.getByRole("listitem", { name: "Folder notes: Answered" });
  await expect(entry).toContainText("found on disk");
  await expect(entry).toContainText(`sha256 ${manifestHash!.sha256.slice(0, 12)}`);
  await expectContentClearsBorder(viewer);
  await shoot(dashboard, "viewer-found-on-disk", viewer);
  await viewer.getByRole("button", { name: "Close" }).click();
  await expect(viewer).toBeHidden();
  const read = (await api<Array<{ id: string; shaping?: { shapers: Array<{ id: string; origin: string; sha256: string }> } }>>(daemon, "/api/tasks"))
    .find((candidate) => candidate.id === task.id);
  expect(read?.shaping?.shapers).toEqual([expect.objectContaining({ id: "folder-notes", origin: "discovered", sha256: manifestHash!.sha256 })]);

  // Settings lists it as Found on disk, with its path, switched on with no stored choice.
  await dashboard.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  const panel = dashboard.getByRole("region", { name: "Task shaping" });
  const row = panel.getByRole("group", { name: "Folder notes", exact: true });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row.getByText("Found on disk", { exact: true })).toBeVisible();
  await expect(row.getByText(path, { exact: true })).toBeVisible();
  await expect(row.getByRole("button", { name: "Remove Folder notes" })).toHaveCount(0);
  await expect(panel.getByText(join(daemon.home, "shapers"), { exact: false }).first()).toBeVisible();
  const pill = row.getByRole("button", { name: "Folder notes: on" });
  await expect(pill).toBeVisible();
  await shoot(dashboard, "settings-found-on-disk", panel);

  // Switched off there: the stored choice wins over the manifest, which is left as it is.
  await pill.click();
  await expect(row.getByRole("button", { name: "Folder notes: off" })).toBeVisible();
  await expect.poll(async () => (await api<{ config: { overrides: Record<string, boolean> } }>(daemon, "/api/shaping")).config.overrides["folder-notes"])
    .toBe(false);
  await shoot(dashboard, "settings-switched-off", panel);

  // The following dispatch is not shaped by it.
  await dashboard.goto(daemon.baseURL);
  await expect(dashboard.getByRole("button", { name: "Dispatch" })).toBeVisible();
  const second = await dispatch(dashboard, daemon, "Tidy the ledger export.", "Tidy the ledger export");
  const secondTurn = () => recordedUserTurns(daemon).find((turn) => turn.includes("Tidy the ledger export.")) ?? "";
  await expect.poll(secondTurn, { timeout: 60_000 }).toContain("Tidy the ledger export.");
  expect(secondTurn()).not.toContain("## Task context");
  await expect.poll(async () => (await api<Array<{ id: string; status: string }>>(daemon, "/api/tasks"))
    .find((candidate) => candidate.id === second.id)?.status, { timeout: 60_000 }).toBe("running");
  const secondRead = (await api<Array<{ id: string; shaping?: unknown }>>(daemon, "/api/tasks")).find((candidate) => candidate.id === second.id);
  expect(secondRead && "shaping" in secondRead).toBe(false);
});

test("a registered shaper with the folder shaper's id shadows it: only the registered one runs, and Settings says why", async ({ dashboard, daemon }) => {
  test.setTimeout(120_000);
  await api(daemon, "/api/feature-flags", { kind: "flag", id: "task-shaping", enabled: true }, "PUT");
  await useLayout(dashboard, daemon, "console");
  dropShaperFolder(daemon, "acme-notes", "Folder notes");
  // Registered under the same id, then switched on: registration stores it off.
  await api(daemon, "/api/shaping", {
    kind: "upsert",
    shaper: { id: "acme-notes", label: "Registered notes", stage: "select", timeoutMs: 30_000, transport: { type: "command", command: process.execPath, args: [SHAPER, "ok"] } },
  }, "PUT");
  await api(daemon, "/api/shaping", { kind: "enable", id: "acme-notes", enabled: true }, "PUT");
  const folderEntry = (await api<{ discovered: Array<{ id: string; state: string; problem: string | null }> }>(daemon, "/api/shaping"))
    .discovered.find((entry) => entry.id === "acme-notes");
  expect(folderEntry?.state).toBe("shadowed");

  // A dispatch runs the registered definition, never the folder's.
  const task = await dispatch(dashboard, daemon, "Make refunds idempotent.", "Refund each key once");
  const turnOne = () => recordedUserTurns(daemon).find((turn) => turn.includes("Make refunds idempotent.")) ?? "";
  await expect.poll(turnOne, { timeout: 60_000 }).toMatch(/## Task context[\s\S]*### Registered notes: Idempotent charges/);
  expect(turnOne()).not.toContain("### Folder notes");
  await expect.poll(async () => (await api<Array<{ id: string; shaping?: { shapers: Array<{ id: string; origin: string }> } }>>(daemon, "/api/tasks"))
    .find((candidate) => candidate.id === task.id)?.shaping?.shapers, { timeout: 30_000 })
    .toEqual([expect.objectContaining({ id: "acme-notes", origin: "registered" })]);

  // Settings lists the folder's shaper apart, as Shadowed, with its reason and no switch of its own.
  await dashboard.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  const panel = dashboard.getByRole("region", { name: "Task shaping" });
  const group = panel.getByRole("group", { name: "Found on disk, not run" });
  const row = group.getByRole("group", { name: "Folder notes", exact: true });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row.getByText("Shadowed", { exact: true })).toBeVisible();
  await expect(row).toContainText("A registered shaper has the id \"acme-notes\", so it runs instead and this one does not.");
  await expect(row.getByRole("button", { name: /^Folder notes: (on|off)$/ })).toHaveCount(0);
  // The registered one keeps the id's switch, in its stage.
  await expect(panel.getByRole("group", { name: "Registered notes", exact: true }).getByRole("button", { name: "Registered notes: on" })).toBeVisible();
  await shoot(dashboard, "settings-shadowed", group);
});

test("a refused folder is listed with its reason in Settings and never runs", async ({ dashboard, daemon }) => {
  await api(daemon, "/api/feature-flags", { kind: "flag", id: "task-shaping", enabled: true }, "PUT");
  const dir = dropShaperFolder(daemon, "loose-notes", "Loose notes");
  chmodSync(dir, 0o777);
  await dashboard.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  const panel = dashboard.getByRole("region", { name: "Task shaping" });
  const group = panel.getByRole("group", { name: "Found on disk, not run" });
  // A refused folder is never parsed, so it is listed by its id.
  const row = group.getByRole("group", { name: "loose-notes", exact: true });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row.getByText("Refused", { exact: true })).toBeVisible();
  await expect(row).toContainText("The folder is writable by its group or by other users.");
  await expect(row.getByRole("button", { name: "loose-notes: off" })).toBeDisabled();
  await shoot(dashboard, "settings-refused", group);
});

test("switching a folder shaper on sends the manifest Settings showed, and a click on a replaced manifest is refused", async ({ dashboard, daemon }) => {
  await api(daemon, "/api/feature-flags", { kind: "flag", id: "task-shaping", enabled: true }, "PUT");
  // A manifest that asks to start off, so the first thing the operator does is switch it on.
  dropShaperFolder(daemon, "quiet-notes", "Quiet notes", { enabled: false });
  const hashOf = async (): Promise<string> => (await api<{ discovered: Array<{ id: string; sha256: string }> }>(daemon, "/api/shaping"))
    .discovered.find((entry) => entry.id === "quiet-notes")!.sha256;
  const overrides = async () => (await api<{ config: { overrides: Record<string, boolean> } }>(daemon, "/api/shaping")).config.overrides;
  const isShaping = (url: string) => new URL(url).pathname === "/api/shaping";
  const shown = await hashOf();

  await dashboard.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  const panel = dashboard.getByRole("region", { name: "Task shaping" });
  const row = panel.getByRole("group", { name: "Quiet notes", exact: true });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toContainText("Its manifest asks to start switched off.");

  // Switched on: the click carries the hash of the manifest this row shows.
  const enabling = dashboard.waitForRequest((request) => request.method() === "PUT" && isShaping(request.url()));
  await row.getByRole("button", { name: "Quiet notes: off" }).click();
  expect((await enabling).postDataJSON()).toEqual({ kind: "enable", id: "quiet-notes", enabled: true, manifest: shown });
  await expect(row.getByRole("button", { name: "Quiet notes: on" })).toBeVisible();
  await expect.poll(async () => (await overrides())["quiet-notes"]).toBe(true);

  // Switched off, and the folder read again once that choice is stored.
  const reread = dashboard.waitForResponse((response) => response.request().method() === "GET" && isShaping(response.url()));
  await row.getByRole("button", { name: "Quiet notes: on" }).click();
  await reread;
  await expect(row.getByRole("button", { name: "Quiet notes: off" })).toBeVisible();
  await expect.poll(async () => (await overrides())["quiet-notes"]).toBe(false);

  // The manifest is replaced on disk while this window still shows the one it read.
  dropShaperFolder(daemon, "quiet-notes", "Quiet notes", { enabled: false, timeoutMs: 20_000 });
  expect(await hashOf()).not.toBe(shown);

  // Switching on still names the manifest it showed, which the folder no longer holds: refused.
  const refusal = dashboard.waitForResponse((response) => response.request().method() === "PUT" && isShaping(response.url()));
  // The page's next folder read, which only the refusal's outcome can trigger now.
  const rereadAfterRefusal = dashboard.waitForResponse((response) => response.request().method() === "GET" && isShaping(response.url()));
  await row.getByRole("button", { name: "Quiet notes: off" }).click();
  const answer = await refusal;
  expect(answer.status()).toBe(409);
  expect(answer.request().postDataJSON()).toMatchObject({ kind: "enable", enabled: true, manifest: shown });
  await expect(row.getByRole("alert")).toContainText("changed in the shapers folder since it was shown here, so it was not switched on");
  await expect(row.getByRole("button", { name: "Quiet notes: off" })).toBeVisible();
  // The stored choice is still off, so the replaced manifest does not run.
  expect((await overrides())["quiet-notes"]).toBe(false);
  await shoot(dashboard, "settings-stale-manifest-refused", row);

  // The refusal re-reads the folder, so reviewing it again means clicking again: the next click
  // names the manifest the folder holds now, and is applied.
  const replaced = await hashOf();
  await rereadAfterRefusal;
  const retry = dashboard.waitForRequest((request) => request.method() === "PUT" && isShaping(request.url()));
  await row.getByRole("button", { name: "Quiet notes: off" }).click();
  expect((await retry).postDataJSON()).toEqual({ kind: "enable", id: "quiet-notes", enabled: true, manifest: replaced });
  await expect(row.getByRole("button", { name: "Quiet notes: on" })).toBeVisible();
  await expect.poll(async () => (await overrides())["quiet-notes"]).toBe(true);
});

test("a folder shaper stored on that becomes refused or unreadable can still be switched off in Settings", async ({ dashboard, daemon }) => {
  await api(daemon, "/api/feature-flags", { kind: "flag", id: "task-shaping", enabled: true }, "PUT");
  const loose = dropShaperFolder(daemon, "loose-notes", "Loose notes");
  const broken = dropShaperFolder(daemon, "broken-notes", "Broken notes");
  // Both stored on while they could run.
  for (const id of ["loose-notes", "broken-notes"]) await api(daemon, "/api/shaping", { kind: "enable", id, enabled: true }, "PUT");
  const overrides = async () => (await api<{ config: { overrides: Record<string, boolean> } }>(daemon, "/api/shaping")).config.overrides;
  expect(await overrides()).toMatchObject({ "loose-notes": true, "broken-notes": true });

  // Then one folder is opened to its group, which is refused before its manifest is read, and the
  // other's manifest stops being JSON: neither has a manifest hash Settings could send.
  chmodSync(loose, 0o775);
  writeFileSync(join(broken, "shaper.json"), "{ not json");
  const discovered = (await api<{ discovered: Array<{ id: string; state: string; sha256: string | null }> }>(daemon, "/api/shaping")).discovered;
  expect(discovered.find((entry) => entry.id === "loose-notes")).toMatchObject({ state: "refused", sha256: null });
  expect(discovered.find((entry) => entry.id === "broken-notes")).toMatchObject({ state: "invalid" });

  await dashboard.goto(`${daemon.baseURL}/#/settings/task-shaping`);
  const group = dashboard.getByRole("region", { name: "Task shaping" }).getByRole("group", { name: "Found on disk, not run" });
  for (const id of ["loose-notes", "broken-notes"]) {
    // Neither manifest was parsed, so each row is listed by its id.
    const row = group.getByRole("group", { name: id, exact: true });
    await expect(row).toBeVisible({ timeout: 15_000 });
    const on = row.getByRole("button", { name: `${id}: on` });
    await expect(on).toBeEnabled();
    const sent = dashboard.waitForRequest((request) => request.method() === "PUT" && new URL(request.url()).pathname === "/api/shaping");
    await on.click();
    const body = (await sent).postDataJSON() as Record<string, unknown>;
    expect(body).toMatchObject({ kind: "enable", id, enabled: false });
    // The refused folder was never read, so its switch has no hash to send and is still offered.
    if (id === "loose-notes") expect(body).not.toHaveProperty("manifest");
    await expect(row.getByRole("button", { name: `${id}: off` })).toBeDisabled();
    await expect.poll(async () => (await overrides())[id]).toBe(false);
  }
  await shoot(dashboard, "settings-blocked-switched-off", group);
});
