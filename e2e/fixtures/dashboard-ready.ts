import { expect, type Page } from "@playwright/test";

/** Navigation completion is not application readiness: the bootstrap imports React asynchronously. */
export async function expectDashboardReady(page: Page, options?: { timeout: number }): Promise<void> {
  // A known Keep awake state is delivered by the initial SSE snapshot, after mount effects
  // have installed shortcuts and shell listeners. This also avoids editing placeholder state.
  await expect(page.getByRole("button", {
    name: /^Keep awake - (?!Mission Control is reconnecting|state unknown)/,
  })).toBeVisible(options);
}
