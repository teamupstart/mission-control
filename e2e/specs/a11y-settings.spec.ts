import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { enableVoice } from "../fixtures/voice.ts";
import { openVoiceTab } from "../fixtures/voice-settings.ts";

/**
 * Settings, as a keyboard and a screen reader meet it.
 *
 * The `settings-toggle` and layout rows wrap a label AND a paragraph of description in one
 * `<label>`, so each control used to be named by the whole paragraph. They now carry the
 * printed label as their name and the paragraph as their description, which is what the
 * exact-name lookups below hold. The settings rail and the Storage tabs moved their arrow-key
 * handling from the tablist onto the tabs themselves, and the Voice "On screen" rows gained
 * explicit label associations. Nothing here dispatches an agent, so no model tokens are spent.
 */

const rail = (page: Page) => page.getByRole("tablist", { name: "Settings categories" });

test("settings toggles are named by their label and described by their paragraph", async ({ dashboard, daemon }) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  const format = dashboard.getByRole("checkbox", { name: "Format messages", exact: true });
  await expect(format).toBeVisible();
  await expect(format).toHaveAccessibleDescription(/headings, lists, tables, and code blocks/);

  const layouts = dashboard.getByRole("radiogroup", { name: "Dashboard layout" });
  const board = layouts.getByRole("radio", { name: "Board", exact: true });
  await expect(board).toBeVisible();
  await expect(layouts.getByRole("radio", { name: "Console", exact: true })).toBeVisible();

  await dashboard.goto(`${daemon.baseURL}/#/settings/keyboard`);
  const hints = dashboard.getByRole("checkbox", { name: "Show keybindings on buttons", exact: true });
  await expect(hints).toBeVisible();
  await expect(hints).toHaveAccessibleDescription(/carry its key on their face/);

  await dashboard.goto(`${daemon.baseURL}/#/settings/dispatch`);
  const guided = dashboard.getByRole("checkbox", { name: "Guided dispatch", exact: true });
  await expect(guided).toBeVisible();
  await expect(guided).toHaveAccessibleDescription(/asks three questions first/);
});

test("arrow keys on a settings rail tab move to the next category", async ({ dashboard, daemon }) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/keyboard`);
  const keyboard = rail(dashboard).getByRole("tab", { name: "Keyboard" });
  await expect(keyboard).toHaveAttribute("aria-selected", "true");
  await keyboard.focus();

  await dashboard.keyboard.press("ArrowDown");
  const dispatch = rail(dashboard).getByRole("tab", { name: "Dispatch" });
  await expect(dispatch).toHaveAttribute("aria-selected", "true");
  await expect(dispatch).toBeFocused();
  await expect(dashboard).toHaveURL(/#\/settings\/dispatch$/);

  await dashboard.keyboard.press("ArrowUp");
  await expect(keyboard).toHaveAttribute("aria-selected", "true");
  await expect(keyboard).toBeFocused();
});

test("arrow keys on a Storage tab move to the next view", async ({ dashboard, daemon }) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/storage`);
  const views = dashboard.getByRole("tablist", { name: "Storage views" });
  const overview = views.getByRole("tab", { name: "Overview" });
  await expect(overview).toHaveAttribute("aria-selected", "true");
  await overview.focus();

  await dashboard.keyboard.press("ArrowRight");
  const backups = views.getByRole("tab", { name: "Backups" });
  await expect(backups).toHaveAttribute("aria-selected", "true");
  await expect(backups).toBeFocused();

  await dashboard.keyboard.press("ArrowLeft");
  await expect(overview).toHaveAttribute("aria-selected", "true");
  await expect(overview).toBeFocused();
});

test("the Voice On screen rows are reachable by their printed labels", async ({ dashboard, daemon }) => {
  await enableVoice(daemon);
  await openVoiceTab(dashboard, "On screen", daemon.baseURL);
  const transcript = dashboard.getByRole("group", { name: "Live transcript" });
  await expect(transcript.getByRole("checkbox", { name: "Show live transcript" })).toBeVisible();
  await expect(transcript.getByRole("combobox", { name: "Transcript style" })).toBeVisible();
  await expect(transcript.getByRole("spinbutton", { name: "Maximum transcript words" })).toBeVisible();
  await expect(transcript.getByRole("combobox", { name: "Corner card placement" })).toBeVisible();
});

test("a settings grid names its row-heading column for a screen reader", async ({ dashboard, daemon }) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/models`);
  const jobs = dashboard.getByRole("table", { name: "Background jobs, and what each one runs on" });
  await expect(jobs).toBeVisible();
  await expect(jobs.getByRole("columnheader", { name: "Setting", exact: true })).toHaveCount(1);
});
