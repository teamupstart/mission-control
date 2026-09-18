import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * One Escape closes the topmost overlay and reaches nothing behind it.
 *
 * App stands down on `overlaysRef.current.anyOpen`, which is correct only while the overlay
 * is still registered - and both listeners sit on `window`, so they run in registration
 * order. App's effect re-subscribes whenever its deps move, and `visible` and `selected` are
 * among them, so one `session_upsert` arriving while a dialog is open puts App's listener
 * BEHIND the overlay's. The overlay then closes, React flushes that synchronously for a
 * discrete event, and App wakes to an empty registry and peels back a layer of its own.
 *
 * What that cost was the session: Escape dismissed the dialog AND deselected the detail
 * behind it, leaving "No session selected" where the operator had been reading. It reproduced
 * only when a session event happened to land while the dialog was up, so it failed on CI and
 * passed on every developer's machine - `foreman-guide.spec.ts` caught it that way, by luck.
 * The upsert is forced here so the ordering is not left to chance.
 *
 * Driven through the Foreman drawer's guide because that is the layering the defect was found
 * in: a dialog over a drawer over a selected session, where App's peel had two things behind
 * it to take. A plain confirm over the detail does NOT reproduce it - App peels a different
 * layer there and the session survives even with the bug - which is worth knowing before
 * anyone simplifies this setup.
 */

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("exercise overlay escape ownership");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

/** Rename the only session: the cheapest `session_upsert` this suite can force on demand. */
async function forceSessionUpsert(page: Page, daemon: DaemonHandle, name: string): Promise<void> {
  const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as Array<{ id: string }>;
  const renamed = await fetch(
    `${daemon.baseURL}/api/sessions/${encodeURIComponent(sessions[0]!.id)}/rename`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    },
  );
  expect(renamed.ok, "the daemon should accept the rename that forces the upsert").toBe(true);
  // Rendered, so App has certainly re-run the effect that re-subscribes its key handler.
  await expect(page.getByText(name).first()).toBeVisible();
}

test("Escape closes the topmost overlay without deselecting the session behind it", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  await dashboard
    .getByRole("navigation", { name: "Sessions" })
    .locator("button.rail-row")
    .first()
    .click();
  const detail = dashboard.locator(".console-detail");
  await expect(detail).toBeVisible();

  await dashboard.getByRole("button", { name: "Foreman intent", exact: true }).click();
  const drawer = dashboard.locator(".foreman-drawer");
  await expect(drawer).toBeVisible();

  await drawer.getByRole("button", { name: "About Foreman", exact: true }).click();
  const guide = dashboard.getByRole("dialog", { name: "About Foreman", exact: true });
  await expect(guide).toBeVisible();

  await forceSessionUpsert(dashboard, daemon, "Upsert while a dialog is open");

  await dashboard.keyboard.press("Escape");

  // The dialog goes, which is the half that always worked.
  await expect(guide).toHaveCount(0);
  // Nothing behind it moves: not the drawer the dialog was opened from, and not the
  // selection. App must not act on a keystroke the topmost overlay already answered.
  await expect(drawer).toBeVisible();
  await expect(detail).toBeVisible();
  await expect(dashboard.getByText("No session selected")).toHaveCount(0);
});
