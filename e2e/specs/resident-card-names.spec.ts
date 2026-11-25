import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { beListener, enableVoice } from "../fixtures/voice.ts";
import { expect, test } from "../fixtures/test.ts";
import type { ResidentProfile } from "../../src/shared/residents.ts";

const EVIDENCE = artifactsDir("resident-card-names");
const PERSONA_ID = "builtin:code-risk-reviewer";
const PROFILE = "Release Captain";
const CALL_SIGN = "Marlowe";

async function shoot(target: Locator, name: string, hover = false): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  const page = target.page();
  if (!hover) await page.mouse.move(0, 0);
  await target.screenshot({ path: join(EVIDENCE, `${name}.png`), animations: "disabled" });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/resident-card-names/${name}.png`);
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

const setFlag = (daemon: DaemonHandle, enabled: boolean) =>
  api(daemon, "/api/feature-flags", { kind: "flag", id: "resident-card-names", enabled }, "PUT");

/** Navigate inside the open document, the way the app's own links do: a hash, never a load. */
async function go(page: Page, hash: string): Promise<void> {
  await page.evaluate((next) => {
    window.location.hash = next;
  }, hash);
}

function displayPanel(page: Page): Locator {
  return page.locator('[data-anchor="display/board-card"]');
}

function picker(page: Page): Locator {
  return displayPanel(page).getByRole("group", { name: "Board card: Resident name with call sign" });
}

async function setStyle(page: Page, label: "Subtitle" | "Expanding chip", on: boolean): Promise<void> {
  await go(page, "#/settings/display");
  const group = picker(page);
  await group.scrollIntoViewIfNeeded();
  const box = group.getByRole("checkbox", { name: label, exact: true });
  await box.setChecked(on);
  await expect(box).toBeChecked({ checked: on });
}

async function residentTile(page: Page): Promise<Locator> {
  await go(page, "#/");
  await expect(page.locator("main.board")).toBeVisible();
  const tile = page.locator("main.board .tile.is-resident");
  await expect(tile).toHaveCount(1);
  return tile;
}

test("a resident's card keeps its call sign as the title and adds its profile name as a subtitle, an expanding chip, or both", async ({
  dashboard: page,
  daemon,
}) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await enableVoice(daemon);
  const profile = await api<ResidentProfile>(daemon, "/api/residents/profiles", { settings: {
    identity: { name: PROFILE, description: "Cuts the weekly release", referenceName: CALL_SIGN },
    persona: { personaId: PERSONA_ID },
    board: { colorId: "violet", label: "CAP" },
  } });
  await api(daemon, `/api/residents/profiles/${profile.id}/launch`, { repoRoot: daemon.repo, requestId: profile.id });
  await expect.poll(async () => {
    const sessions = await api<{ state: string; task?: { kind?: string } }[]>(daemon, "/api/sessions");
    return sessions.find((session) => session.task?.kind === "resident")?.state ?? null;
  }, { timeout: 60_000, message: "the resident settled idle" }).toBe("idle");
  const listener = await beListener(daemon);
  try {
    await api(daemon, "/api/ui/config", { layout: "board" }, "PUT");
    await page.reload();

    const tile = await residentTile(page);
    const title = tile.locator(".tile-name");
    await expect(title).toHaveText(`"${CALL_SIGN}"`);
    await expect(tile.getByText(PROFILE, { exact: true })).toHaveCount(0);
    await go(page, "#/settings/display");
    await expect(displayPanel(page).getByRole("radiogroup", { name: "Board card: Background sub-agents" })).toBeVisible();
    await expect(picker(page)).toHaveCount(0);

    await setFlag(daemon, true);
    await expect(picker(page)).toBeVisible();
    await expect(picker(page).getByRole("checkbox")).toHaveCount(2);
    await expect(picker(page).getByRole("radio")).toHaveCount(0);
    for (const label of ["Subtitle", "Expanding chip"]) {
      await expect(picker(page).getByRole("checkbox", { name: label, exact: true })).not.toBeChecked();
    }
    const preview = displayPanel(page).locator(".board-card-preview-stage").first();
    await expect(preview.locator(".tile-name")).toHaveText('"Scout"');
    await expect(preview.getByText("Triage Bot", { exact: true })).toHaveCount(0);

    await setStyle(page, "Subtitle", true);
    await expect(preview.getByText("Triage Bot", { exact: true })).toBeVisible();
    await shoot(displayPanel(page).locator(".board-card-customizer").first(), "01-settings-subtitle");
    const subtitled = await residentTile(page);
    const sub = subtitled.getByText(PROFILE, { exact: true });
    await expect(sub).toBeVisible();
    await expect(subtitled.locator(".tile-name")).toHaveText(`"${CALL_SIGN}"`);
    const [titleBox, subBox] = [await subtitled.locator(".tile-name").boundingBox(), await sub.boundingBox()];
    expect(titleBox && subBox, "both names are laid out").toBeTruthy();
    expect(subBox!.y, "the profile name sits under the call sign").toBeGreaterThanOrEqual(titleBox!.y + titleBox!.height - 1);
    expect(Math.abs(subBox!.x - titleBox!.x), "the two names share a left edge").toBeLessThanOrEqual(1);
    const chipBox = await subtitled.locator(".resident-chip").boundingBox();
    expect(Math.abs((chipBox!.y + chipBox!.height / 2) - (titleBox!.y + titleBox!.height / 2))).toBeLessThanOrEqual(2);
    await shoot(subtitled, "02-board-subtitle");

    await setStyle(page, "Subtitle", false);
    await setStyle(page, "Expanding chip", true);
    await expect(preview.locator(".resident-chip").getByText("Triage Bot")).toBeVisible();
    const chipped = await residentTile(page);
    await page.mouse.move(0, 0);
    const chipName = chipped.locator(".resident-chip").getByText(PROFILE);
    await expect(chipped.locator(".tile-name-sub")).toHaveCount(0);
    await expect(chipName).toBeHidden();
    await shoot(chipped, "03-board-chip-rest");
    await chipped.locator(".tile-goal, .tile-activity").first().hover();
    await expect(chipName).toBeVisible();
    await expect(chipped.locator(".tile-name")).toHaveText(`"${CALL_SIGN}"`);
    await expect(chipped.locator(".tile-name")).toBeVisible();
    const expanded = await chipped.locator(".tile-name").boundingBox();
    expect(expanded!.width, "the call sign was squeezed out").toBeGreaterThan(30);
    await shoot(chipped, "04-board-chip-hover", true);
    await page.mouse.move(0, 0);
    await expect(chipName).toBeHidden();

    await setStyle(page, "Subtitle", true);
    await expect(picker(page).getByRole("checkbox", { name: "Expanding chip", exact: true })).toBeChecked();
    await shoot(displayPanel(page).locator(".board-card-customizer").first(), "07-settings-both-checked");
    const both = await residentTile(page);
    await page.mouse.move(0, 0);
    await expect(both.locator(".tile-name-sub")).toHaveText(PROFILE);
    await expect(both.locator(".resident-chip").getByText(PROFILE)).toBeHidden();
    await both.locator(".tile-goal, .tile-activity").first().hover();
    await expect(both.locator(".resident-chip").getByText(PROFILE)).toBeVisible();
    await expect(both.locator(".tile-name-sub")).toBeVisible();
    await expect(both.locator(".tile-name")).toHaveText(`"${CALL_SIGN}"`);
    await shoot(both, "08-board-both-hover", true);
    await page.mouse.move(0, 0);

    await setFlag(daemon, false);
    await expect(both.locator(".resident-chip").getByText(PROFILE)).toHaveCount(0);
    await expect(both.locator(".tile-name-sub")).toHaveCount(0);
    await expect(both.locator(".tile-name")).toHaveText(`"${CALL_SIGN}"`);
    const stored = await api<{ config: { residentCardNameStyles: string[] } }>(daemon, "/api/ui/config");
    expect(stored.config.residentCardNameStyles).toEqual(["subtitle", "chip"]);
    await go(page, "#/settings/display");
    await expect(displayPanel(page).getByRole("radiogroup", { name: "Board card: Background sub-agents" })).toBeVisible();
    await expect(picker(page)).toHaveCount(0);
  } finally {
    listener.stop();
  }
});

test("Expanding chip opens on keyboard focus, cuts a long profile name off inside the chip, and adds nothing when the marker is hidden", async ({
  dashboard: page,
  daemon,
}) => {
  test.setTimeout(150_000);
  // A narrow window, so the chip's cap is narrower than this name and has to cut it off.
  await page.setViewportSize({ width: 760, height: 900 });
  await enableVoice(daemon);
  const longName = "Release Train Conductor for the Mobile, Desktop and Web Platforms";
  const callSign = "Nightingale";
  const profile = await api<ResidentProfile>(daemon, "/api/residents/profiles", { settings: {
    identity: { name: longName, description: "Runs the release train", referenceName: callSign },
    persona: { personaId: PERSONA_ID },
    board: { colorId: "amber", label: "RTC" },
  } });
  await api(daemon, `/api/residents/profiles/${profile.id}/launch`, { repoRoot: daemon.repo, requestId: profile.id });
  await expect.poll(async () => {
    const sessions = await api<{ state: string; task?: { kind?: string } }[]>(daemon, "/api/sessions");
    return sessions.find((session) => session.task?.kind === "resident")?.state ?? null;
  }, { timeout: 60_000, message: "the resident settled idle" }).toBe("idle");
  await setFlag(daemon, true);
  await api(daemon, "/api/ui/config", { layout: "board", residentCardNameStyles: ["chip"] }, "PUT");
  const listener = await beListener(daemon);
  try {
    await page.reload();
    const tile = await residentTile(page);
    const title = tile.locator(".tile-name");
    const chipName = tile.locator(".resident-chip-name");
    await expect(title).toHaveText(`"${callSign}"`);
    await page.mouse.move(0, 0);
    await expect(chipName).toBeHidden();

    const open = tile.getByRole("button", { name: `Open "${callSign}"` });
    await open.focus();
    await expect(open).toBeFocused();
    await expect(chipName).toBeVisible();
    await expect(chipName).toContainText(longName);

    await expect.poll(
      () => chipName.evaluate((el) => el.scrollWidth - el.clientWidth),
      { message: "the long profile name is truncated inside the chip" },
    ).toBeGreaterThan(0);
    const [chipBox, titleBox, tileBox] = await Promise.all([
      tile.locator(".resident-chip").boundingBox(),
      title.boundingBox(),
      tile.boundingBox(),
    ]);
    expect(chipBox!.x + chipBox!.width, "the chip stops before the call sign").toBeLessThanOrEqual(titleBox!.x + 0.5);
    expect(titleBox!.x + titleBox!.width, "the call sign stays inside the card").toBeLessThanOrEqual(tileBox!.x + tileBox!.width);
    expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth), "the call sign is not cut off").toBe(true);
    await shoot(tile, "05-board-chip-focus-long-name", true);

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(chipName).toBeHidden();

    const { config } = await api<{ config: { hiddenDisplayItems: string[] } }>(daemon, "/api/ui/config");
    await api(daemon, "/api/ui/config", { hiddenDisplayItems: [...config.hiddenDisplayItems, "residentMarker"] }, "PUT");
    await page.reload();
    await go(page, "#/");
    const plain = page.locator("main.board .tile").filter({ hasText: `"${callSign}"` });
    await expect(plain).toHaveCount(1);
    await expect(plain).not.toHaveClass(/\bis-resident\b/);
    await expect(plain.locator(".resident-chip")).toHaveCount(0);
    await plain.locator(".tile-goal, .tile-activity").first().hover();
    await expect(plain.getByText(longName)).toHaveCount(0);
    await plain.getByRole("button", { name: `Open "${callSign}"` }).focus();
    await expect(plain.getByText(longName)).toHaveCount(0);
    await expect(plain.locator(".tile-name")).toHaveText(`"${callSign}"`);
    await shoot(plain, "06-board-chip-marker-off", true);
  } finally {
    listener.stop();
  }
});

test("a resident with no call sign, or one whose call sign is its profile name, keeps a single name with both styles on", async ({
  dashboard: page,
  daemon,
}) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await enableVoice(daemon);
  const uncalled = await api<ResidentProfile>(daemon, "/api/residents/profiles", { settings: {
    identity: { name: "Harbor Watch", description: "Watches the harbor" },
    persona: { personaId: PERSONA_ID },
    board: { colorId: "teal", label: "HBW" },
  } });
  const same = await api<ResidentProfile>(daemon, "/api/residents/profiles", { settings: {
    identity: { name: "Sage", description: "Keeps the notes", referenceName: "sage" },
    persona: { personaId: PERSONA_ID },
    board: { colorId: "rose", label: "SGE" },
  } });
  for (const profile of [uncalled, same]) {
    await api(daemon, `/api/residents/profiles/${profile.id}/launch`, { repoRoot: daemon.repo, requestId: profile.id });
  }
  await expect.poll(async () => {
    const sessions = await api<{ state: string; task?: { kind?: string } }[]>(daemon, "/api/sessions");
    return sessions.filter((session) => session.task?.kind === "resident" && session.state === "idle").length;
  }, { timeout: 60_000, message: "both residents settled idle" }).toBe(2);
  await setFlag(daemon, true);
  await api(daemon, "/api/ui/config", { layout: "board", residentCardNameStyles: ["subtitle", "chip"] }, "PUT");
  const listener = await beListener(daemon);
  try {
    await page.reload();
    await go(page, "#/");
    await expect(page.locator("main.board")).toBeVisible();
    const tiles = page.locator("main.board .tile.is-resident");
    await expect(tiles).toHaveCount(2);

    const cases = [
      { tile: tiles.filter({ hasText: "Harbor Watch" }), title: "Harbor Watch", name: "Harbor Watch", shot: "09-board-single-name-no-call-sign" },
      { tile: tiles.filter({ hasText: '"sage"' }), title: '"sage"', name: "Sage", shot: "10-board-single-name-matching-call-sign" },
    ];
    for (const { tile, title, name, shot } of cases) {
      await expect(tile).toHaveCount(1);
      await expect(tile.locator(".tile-name")).toHaveText(title);
      await expect(tile.locator(".tile-name-sub")).toHaveCount(0);
      await expect(tile.locator(".tile-head")).not.toHaveClass(/\bhas-name-sub\b/);
      await tile.locator(".tile-goal, .tile-activity").first().hover();
      await expect(tile.locator(".resident-chip-name")).toHaveCount(0);
      await tile.getByRole("button", { name: `Open ${title}` }).focus();
      await expect(tile.locator(".resident-chip-name")).toHaveCount(0);
      const printed = await tile.locator(".tile-name").evaluate((el) => el.closest(".tile-head")!.textContent ?? "");
      expect(printed.toLowerCase().split(name.toLowerCase()).length - 1, `${name} printed more than once`).toBe(1);
      await shoot(tile, shot, true);
      await page.mouse.move(0, 0);
    }
  } finally {
    listener.stop();
  }
});
