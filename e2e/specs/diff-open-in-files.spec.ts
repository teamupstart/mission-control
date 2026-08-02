import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The Diff tab's route into the Files tab.
 *
 * This is the seam nothing else in the repository can assert. The unit tests prove the
 * path resolver in isolation and the markup tests prove the button is in the markup, but
 * only a browser can show that clicking it changes which tab is selected AND which file
 * the Files tab has open - two pieces of state owned by two different components, joined
 * by a callback that goes up to `App` and back down.
 *
 * The session is a real dispatch into a real git worktree, so the diff under test is one
 * git actually produced rather than a fixture patch.
 */

const TASK = "open a changed file in the files tab";

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();

  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // The repo combobox portals its listbox over the Task field and reopens on every
  // keystroke; without this the next fill lands on a covered control.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(TASK);
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");

  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

/**
 * Put the dashboard in the Console layout, which is where the Diff and Files TABS live.
 *
 * Written to the daemon rather than to `localStorage`, because the web store hydrates
 * from `GET /api/ui/config` at boot and overwrites the local cache with the daemon's
 * copy. The reload is what makes it take: the `dashboard` fixture has already loaded the
 * page by the time a test body runs, and a `goto` to the same hash is a same-document
 * navigation that never re-hydrates.
 *
 * Call this AFTER dispatching. An empty fleet renders "No agent sessions detected" in
 * place of the layout view, so on a fleet of zero there is no rail to wait for.
 */
async function useConsoleLayout(page: Page, daemon: DaemonHandle): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "console" }),
  });
  const body = (await response.json()) as { config?: { layout?: string } };
  expect(body.config?.layout, "the daemon accepted the Console layout").toBe("console");
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Sessions" })).toBeVisible();
}

/**
 * The worktree the dispatch cut, which is what the Diff and Files tabs both read.
 *
 * Polled: the modal closes as soon as the daemon accepts the dispatch, and the worktree
 * and its session row land a beat later.
 */
async function sessionCwd(daemon: DaemonHandle): Promise<string> {
  await expect
    .poll(async () => {
      const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as {
        cwd: string | null;
      }[];
      return sessions[0]?.cwd ?? null;
    }, { message: "the dispatched session never reported a working directory" })
    .not.toBeNull();

  const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as {
    cwd: string | null;
  }[];
  return sessions[0]!.cwd!;
}

test("a changed file in the Diff tab opens in the Files tab", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon);
  const cwd = await sessionCwd(daemon);

  // Two changed files, so the spec can prove the button acts on the file being READ
  // rather than on the first file in the list.
  writeFileSync(join(cwd, "alpha.txt"), "first change\n");
  writeFileSync(join(cwd, "beta.txt"), "second change\n");
  // A name ending in `:<digits>`, which the transcript's href parser would read as a
  // line number and truncate to `notes`. A diff path is exact; see the third case.
  writeFileSync(join(cwd, "notes:12"), "colon named\n");

  await useConsoleLayout(dashboard, daemon);

  await dashboard
    .getByRole("navigation", { name: "Sessions" })
    .getByRole("button", { name: /Open a Changed File/i })
    .click();

  const tabs = dashboard.getByRole("tablist", { name: "Session detail" });
  await tabs.getByRole("tab", { name: /Diff$/ }).click();
  await expect(dashboard.getByRole("region", { name: "Session diff" })).toBeVisible();

  // Read the second file, not the one the diff opens on.
  const changed = dashboard.getByRole("navigation", { name: "Changed files" });
  await changed.getByRole("button", { name: /beta\.txt/ }).click();

  const jump = dashboard.getByRole("button", { name: "Open in Files" });
  await expect(jump).toBeVisible();
  await expect(jump).toHaveAttribute("aria-disabled", "false");
  await jump.click();

  // The tab actually moved...
  await expect(tabs.getByRole("tab", { name: /Files$/ })).toHaveAttribute("aria-selected", "true");
  // ...and it moved to the file that was on screen in the diff, not to a default.
  const files = dashboard.getByRole("listbox", { name: "Session files" });
  await expect(files.getByRole("option", { name: "beta.txt" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // The file's contents are what the diff was showing, so this is the same file and not
  // just a matching name in the list.
  await expect(dashboard.getByText("second change")).toBeVisible();
});

test("a changed file whose name ends in a line-number suffix opens as itself", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  const cwd = await sessionCwd(daemon);
  writeFileSync(join(cwd, "notes:12"), "colon named\n");
  await useConsoleLayout(dashboard, daemon);

  await dashboard
    .getByRole("navigation", { name: "Sessions" })
    .getByRole("button", { name: /Open a Changed File/i })
    .click();

  const tabs = dashboard.getByRole("tablist", { name: "Session detail" });
  await tabs.getByRole("tab", { name: /Diff$/ }).click();
  await dashboard
    .getByRole("navigation", { name: "Changed files" })
    .getByRole("button", { name: /notes:12/ })
    .click();

  await dashboard.getByRole("button", { name: "Open in Files" }).click();

  // `notes`, not `notes:12`, is what the prose href parser would have selected - and
  // there is no such file, so the pane would have shown an error instead of the diff's
  // subject.
  const files = dashboard.getByRole("listbox", { name: "Session files" });
  await expect(files.getByRole("option", { name: "notes:12" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(dashboard.getByText("colon named")).toBeVisible();
});

test("a deleted file offers the jump but disables it, and says why", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  const cwd = await sessionCwd(daemon);

  // `README.md` is the one file `seedRepo` commits, so deleting it is a real tracked
  // deletion rather than an untracked file disappearing.
  rmSync(join(cwd, "README.md"));

  await useConsoleLayout(dashboard, daemon);

  await dashboard
    .getByRole("navigation", { name: "Sessions" })
    .getByRole("button", { name: /Open a Changed File/i })
    .click();

  const tabs = dashboard.getByRole("tablist", { name: "Session detail" });
  await tabs.getByRole("tab", { name: /Diff$/ }).click();

  const changed = dashboard.getByRole("navigation", { name: "Changed files" });
  await changed.getByRole("button", { name: /README\.md/ }).click();

  // Present on this file too - a control that disappeared would teach that the diff
  // sometimes has no route to Files at all.
  const jump = dashboard.getByRole("button", { name: "Open in Files" });
  await expect(jump).toBeVisible();
  await expect(jump).toHaveAttribute("aria-disabled", "true");
  // Playwright's own actionability check reads `aria-disabled`, so this is the same
  // answer a screen reader and a pointer both get: the control is off.
  await expect(jump).toBeDisabled();

  // The reason is in the accessibility tree, not only in a hover bubble.
  await expect(
    dashboard.getByText("This file was deleted, so there is nothing to open."),
  ).toBeAttached();

  // Forced past the actionability check, because "a disabled-looking button whose handler
  // still fires" is exactly the bug worth pinning. Nothing happens: the Diff tab holds.
  await jump.click({ force: true });
  await expect(tabs.getByRole("tab", { name: /Diff$/ })).toHaveAttribute("aria-selected", "true");
  await expect(tabs.getByRole("tab", { name: /Files$/ })).toHaveAttribute("aria-selected", "false");
});
