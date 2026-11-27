import { expect, type Page } from "@playwright/test";

/** The tabs of Settings > Voice, by the names an operator reads. */
export type VoiceSettingsTab = "Listening" | "Names & routing" | "Spoken replies" | "On screen" | "Recently heard";

/**
 * Settings > Voice shows one tab at a time. Open the page when a base URL is given, then
 * select a tab by its visible name and wait until the tab says it is selected.
 */
export async function openVoiceTab(page: Page, name: VoiceSettingsTab, baseURL?: string): Promise<void> {
  if (baseURL) await page.goto(baseURL + "/#/settings/voice");
  const tab = page.getByRole("tablist", { name: "Voice settings" }).getByRole("tab", { name, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}
