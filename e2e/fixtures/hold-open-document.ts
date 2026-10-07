import type { Page } from "@playwright/test";

/**
 * Keep the Files tab's open document at the revision it loaded, however the file changes.
 *
 * The open document re-checks the file on disk every couple of seconds, so an agent's edit
 * re-renders where the reader is looking. A spec whose subject is the moment BEFORE that -
 * a save that conflicts with a newer file, a click on a render the file has moved under - would
 * otherwise race the re-check: it writes the file and acts, and whether the view caught up
 * first depends on where the interval happened to be.
 *
 * Only the re-check is answered, and it is answered "unchanged". An ordinary read carries no
 * `known`, so a load, a selection and the Refresh button still go to the daemon, which is what
 * lets a spec that holds the document still drive the remedy for it.
 */
export async function holdOpenDocument(page: Page): Promise<void> {
  await page.route(/\/api\/sessions\/[^/]+\/file\?(?:.*&)?known=/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ unchanged: true }),
    }));
}
