import type { ConsoleMessage, Page } from "@playwright/test";

/** Arm before touching source, then await completed before interacting with refreshed UI. */
export async function observeReactRefresh(page: Page): Promise<{ completed: Promise<ConsoleMessage> }> {
  await page.evaluate(() => {
    const register = (window as Window & {
      __registerBeforePerformReactRefresh?: (callback: () => void) => void;
    }).__registerBeforePerformReactRefresh;
    if (!register) throw new Error("Vite React refresh hook is unavailable");
    // Vite's hot-updated log precedes its debounced React refresh. A timer scheduled
    // by this hook runs after performReactRefresh, so the next click uses the new handler.
    register(() => { setTimeout(() => console.info("report-test: React refresh completed"), 0); });
  });
  return {
    completed: page.waitForEvent("console", {
      predicate: (message) => message.text() === "report-test: React refresh completed",
    }),
  };
}
