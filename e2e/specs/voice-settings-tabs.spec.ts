import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { enableVoice } from "../fixtures/voice.ts";
import { openVoiceTab } from "../fixtures/voice-settings.ts";

// Settings > Voice, organised as the operator-selected "Tabs by job" design: the mode line stays
// above five tabs (Listening, Names & routing, Spoken replies, On screen, Recently heard), each
// holding the controls for one job. A search result opens the tab that holds its control before
// the page flashes it, arrow keys move between tabs, and Push-to-talk still disables the
// controls that only Always-on uses.

const EVIDENCE = process.env.MC_E2E_EVIDENCE ? artifactsDir("voice-settings-tabs") : null;

async function capture(page: Page, name: string): Promise<void> {
  if (!EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // A tab's hint tooltip follows the pointer and focus; clear both so the capture shows the panel.
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(page.locator(".tooltip")).toHaveCount(0);
  await page.locator(".voice-settings").screenshot({ path: join(EVIDENCE, `${name}.png`) });
}

const tabs = (page: Page) => page.getByRole("tablist", { name: "Voice settings" });
const tab = (page: Page, name: string) => tabs(page).getByRole("tab", { name, exact: true });
const panel = (page: Page, name: string) => page.getByRole("tabpanel", { name, exact: true });

async function savedConfig(baseURL: string): Promise<{ planFormsByVoice: boolean; listeningMode: string }> {
  const response = await fetch(`${baseURL}/api/voice/config`);
  return ((await response.json()) as { config: { planFormsByVoice: boolean; listeningMode: string } }).config;
}

test("each Voice tab holds one job's controls, below a status line every tab shares", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  // Tall enough that every tab, the longest being On screen, fits the settings pane for the captures.
  await page.setViewportSize({ width: 1280, height: 1700 });
  await page.goto(daemon.baseURL + "/#/settings/voice");

  await expect(tabs(page).getByRole("tab")).toHaveText(["Listening", "Names & routing", "Spoken replies", "On screen", "Recently heard"]);
  await expect(tab(page, "Listening")).toHaveAttribute("aria-selected", "true");
  const mode = page.getByRole("status", { name: "Voice mode" });
  await expect(mode).toBeVisible();

  const listening = panel(page, "Listening");
  await expect(listening.getByRole("group", { name: "Microphone" })).toBeVisible();
  const ending = listening.getByRole("group", { name: "Ending a message" });
  await expect(ending.locator(".kb-row-label")).toHaveText(["End-of-speech delay", "Separator word", "Cancel window"]);
  await expect(ending.getByRole("textbox", { name: "Separator word" })).toHaveValue("bagel");
  for (const name of ["Listening mode", "Input device", "End-of-speech delay", "Cancel window"]) {
    await expect(listening.getByRole("combobox", { name })).toBeVisible();
  }
  await expect(listening.getByRole("button", { name: "Mute hotkey" }).or(listening.getByText("Needs the desktop app"))).toBeVisible();
  await expect(listening.getByRole("checkbox", { name: "Auto-mute on calls" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Plan forms by voice" })).toHaveCount(0);
  await capture(page, "listening");

  await openVoiceTab(page, "Names & routing");
  const routing = panel(page, "Names & routing");
  await expect(routing.locator('[data-anchor="voice/roster"]')).toContainText("Who you can address");
  await expect(routing.getByRole("group", { name: "When a sentence is unclear" })).toBeVisible();
  await expect(routing.getByRole("radiogroup", { name: "When routing is unsure" })).toBeVisible();
  await expect(routing.getByRole("combobox", { name: "Decision model provider" })).toBeVisible();
  await expect(routing.getByRole("textbox", { name: "OpenAI Decisions key" })).toBeVisible();
  await expect(routing.getByRole("textbox", { name: "Jev key" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Listening mode" })).toHaveCount(0);
  await expect(mode).toBeVisible();
  await capture(page, "names-and-routing");

  await openVoiceTab(page, "Spoken replies");
  const replies = panel(page, "Spoken replies");
  await expect(replies.getByRole("region", { name: "Spoken replies" }).getByRole("combobox", { name: "Voice" })).toBeVisible();
  const planForms = replies.getByRole("checkbox", { name: "Plan forms by voice" });
  await expect(planForms).toBeChecked();
  await planForms.uncheck();
  await expect.poll(async () => (await savedConfig(daemon.baseURL)).planFormsByVoice).toBe(false);
  await capture(page, "spoken-replies");

  await openVoiceTab(page, "On screen");
  const screen = panel(page, "On screen");
  await expect(screen.getByRole("group", { name: "Live transcript" })).toBeVisible();
  await expect(screen.getByRole("group", { name: "Confirmation card" })).toBeVisible();
  await expect(screen.getByRole("group", { name: "In the window" })).toBeVisible();
  await capture(page, "on-screen");

  await openVoiceTab(page, "Recently heard");
  await expect(panel(page, "Recently heard").getByRole("table", { name: "Recently heard utterances" })).toBeVisible();
  await capture(page, "recently-heard");

  // A change made on one tab is still there after visiting the others.
  await openVoiceTab(page, "Spoken replies");
  await expect(page.getByRole("checkbox", { name: "Plan forms by voice" })).not.toBeChecked();
});

test("arrow keys move between Voice tabs and wrap at the ends", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  await page.goto(daemon.baseURL + "/#/settings/voice");
  const listening = tab(page, "Listening");
  await listening.focus();
  await listening.press("ArrowRight");
  await expect(tab(page, "Names & routing")).toBeFocused();
  await expect(tab(page, "Names & routing")).toHaveAttribute("aria-selected", "true");
  await expect(panel(page, "Names & routing")).toBeVisible();
  await tab(page, "Names & routing").press("ArrowLeft");
  await tab(page, "Listening").press("ArrowLeft");
  await expect(tab(page, "Recently heard")).toBeFocused();
  await expect(tab(page, "Recently heard")).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, "Listening")).toHaveAttribute("tabindex", "-1");
  await tab(page, "Recently heard").press("ArrowRight");
  await expect(tab(page, "Listening")).toBeFocused();
  await expect(tab(page, "Listening")).toHaveAttribute("aria-selected", "true");
  await expect(panel(page, "Listening")).toBeVisible();
});

test("a settings search result opens the Voice tab that holds its control and flashes it", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  await page.goto(daemon.baseURL + "/#/settings/voice");
  await expect(tab(page, "Listening")).toHaveAttribute("aria-selected", "true");

  const search = async (query: string, option: RegExp) => {
    await page.keyboard.press("Meta+k");
    await page.getByRole("combobox", { name: "Search everything" }).fill(query);
    await page.getByRole("option", { name: option }).click();
  };

  await search("Plan forms by voice", /^Plan forms by voice, setting/);
  await expect(tab(page, "Spoken replies")).toHaveAttribute("aria-selected", "true");
  const planForms = page.locator('[data-anchor="voice/plan-forms"]');
  await expect(planForms).toBeVisible();
  await expect(planForms).toHaveClass(/settings-flash/);

  // From another category, and to a control on a different tab.
  await page.goto(daemon.baseURL + "/#/fleet");
  await search("Recently heard", /^Recently heard, setting/);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/settings/voice");
  await expect(tab(page, "Recently heard")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-anchor="voice/heard"]')).toHaveClass(/settings-flash/);

  await search("When voice routing is unsure", /^When voice routing is unsure, setting/);
  await expect(tab(page, "Names & routing")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-anchor="voice/when-unsure"]')).toHaveClass(/settings-flash/);

  // The status line is above the tabs, so its result keeps the tab that is open.
  await search("Voice mode", /^Voice mode, setting/);
  await expect(page.locator('[data-anchor="voice/mode"]')).toHaveClass(/settings-flash/);
  await expect(tab(page, "Names & routing")).toHaveAttribute("aria-selected", "true");
});

test("Push-to-talk disables the Listening controls only Always-on uses, and says why", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  await page.goto(daemon.baseURL + "/#/settings/voice");
  const listening = panel(page, "Listening");
  await listening.getByRole("combobox", { name: "Listening mode" }).selectOption("push-to-talk");
  await expect.poll(async () => (await savedConfig(daemon.baseURL)).listeningMode).toBe("push-to-talk");
  const ending = listening.getByRole("group", { name: "Ending a message" });
  await expect(ending.getByRole("combobox", { name: "End-of-speech delay" })).toBeDisabled();
  await expect(ending.locator('[data-anchor="voice/end-of-speech"]')).toContainText("Push-to-talk ends on key release.");
  await expect(ending.getByRole("combobox", { name: "Cancel window" })).toBeEnabled();
  await expect(ending.getByRole("textbox", { name: "Separator word" })).toBeDisabled();
  await expect(ending.locator('[data-anchor="voice/separator"]')).toContainText("Push-to-talk ends on key release.");
  await expect(listening.getByRole("checkbox", { name: "Auto-mute on calls" })).toBeDisabled();
  await expect(listening.locator('[data-anchor="voice/auto-mute"]')).toContainText("Applies to Always-on listening.");
  await expect(listening.locator('[data-anchor="voice/hotkey"]')).toContainText("Push-to-talk hotkey");
  await capture(page, "listening-push-to-talk");

  await openVoiceTab(page, "Names & routing");
  const ask = panel(page, "Names & routing").getByRole("radio", { name: "Ask aloud" });
  await expect(ask).toBeDisabled();
  await expect(page.locator('[data-anchor="voice/when-unsure"]')).toContainText("Ask aloud requires Always-on listening.");
});

test("the separator word sits beside End-of-speech delay with its default, validation and Push-to-talk states", async ({ dashboard: page, daemon }) => {
  await enableVoice(daemon);
  await page.goto(daemon.baseURL + "/#/settings/voice");
  const ending = panel(page, "Listening").getByRole("group", { name: "Ending a message" });
  await expect(ending.locator(".kb-row-label")).toHaveText(["End-of-speech delay", "Separator word", "Cancel window"]);
  const row = ending.locator('[data-anchor="voice/separator"]');
  const word = ending.getByRole("textbox", { name: "Separator word" });
  await expect(word).toHaveValue("bagel");
  await expect(word).toBeEnabled();
  await expect(row).toContainText("Say it between two messages to send both without pausing.");
  await capture(page, "separator-default");

  await word.fill("two words");
  await word.press("Enter");
  await expect(row.getByRole("alert")).toHaveText("Use one word of letters, numbers, apostrophes or hyphens.");
  await expect(word).toHaveValue("bagel");
  await capture(page, "separator-validation");

  await panel(page, "Listening").getByRole("combobox", { name: "Listening mode" }).selectOption("push-to-talk");
  await expect(word).toBeDisabled();
  await expect(row).toContainText("Push-to-talk ends on key release.");
  await expect(row.getByRole("alert"), "the Always-on edit's message does not outlive the switch").toHaveCount(0);
  await capture(page, "separator-push-to-talk");

  // From another tab, a search for the word opens Listening and flashes the row.
  await openVoiceTab(page, "Recently heard");
  await page.keyboard.press("Meta+k");
  await page.getByRole("combobox", { name: "Search everything" }).fill("bagel");
  await page.getByRole("option", { name: /^Separator word, setting/ }).click();
  await expect(tab(page, "Listening")).toHaveAttribute("aria-selected", "true");
  await expect(row).toHaveClass(/settings-flash/);
});
