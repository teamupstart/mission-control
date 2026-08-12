import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * "Copy local", in the one notice it appears in, actually confirming.
 *
 * This control had no feedback of any kind: it called `navigator.clipboard.writeText` behind a
 * `void` and rendered nothing either way, so the reader could not tell a successful copy from a
 * refused one. That matters more here than anywhere else in the app, because the notice it sits
 * in is the moment before the two destructive buttons beside it - the file changed under you,
 * and the next click either discards your edits or overwrites someone else's. A copy you cannot
 * confirm is a poor thing to stake that on.
 *
 * It has to be a browser test twice over. The control is unreachable except through a real
 * revision conflict, which needs a live session with a checkout, a document loaded at one
 * revision and the file changed underneath it - none of which exists in a `renderToStaticMarkup`
 * tree. And the fix is that the write now goes through `copyText`, which is a fact about the
 * clipboard rather than about the markup.
 *
 * The conflict is deterministic rather than raced: the save carries the `expectedRevision`
 * captured when the document loaded, and the daemon compares hashes, so rewriting the file after
 * it is on screen guarantees the 409 whenever the autosave lands.
 */

const TASK = "hold a file open while it changes underneath";
const SOURCE = "src/reconnect.ts";
/** A second, unconflicted file, purely to select away to and back. */
const OTHER = "src/budget.ts";
const ON_DISK_FIRST = "export const reconnectBudgetMs = 30_000;\n";
const CHANGED_ON_DISK = "export const reconnectBudgetMs = 45_000; // someone else got here first\n";
/** Typed into the editor, so the local version is distinguishable from both disk versions. */
const TYPED = "// mine\n";

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();

  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // The repo combobox portals its listbox over the Task field and reopens on every keystroke;
  // without this the next fill lands on a covered control. See file-default-view.spec.ts.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(TASK);
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");

  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

/** The Files TAB lives in the Console layout. See diff-open-in-files.spec.ts. */
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

/**
 * Drive a real revision conflict and return the notice it raises.
 *
 * Order matters: the document has to be ON SCREEN before the file is rewritten, because the
 * revision the save will be checked against is the one captured when it loaded.
 */
async function conflictNotice(page: Page, daemon: DaemonHandle) {
  await dispatch(page, daemon);
  const cwd = await sessionCwd(daemon);
  // Untracked and not ignored, which is what keeps them in the Files list.
  mkdirSync(join(cwd, dirname(SOURCE)), { recursive: true });
  writeFileSync(join(cwd, SOURCE), ON_DISK_FIRST);
  writeFileSync(join(cwd, OTHER), "export const unrelated = true;\n");

  await useConsoleLayout(page, daemon);
  await page
    .getByRole("navigation", { name: "Sessions" })
    .getByRole("button", { name: /Hold A File Open/i })
    .click();
  await page
    .getByRole("tablist", { name: "Session detail" })
    .getByRole("tab", { name: /Files$/ })
    .click();
  await page
    .getByRole("listbox", { name: "Session files" })
    .getByRole("option", { name: SOURCE })
    .click();

  const editor = page.getByLabel(`Editor for ${SOURCE}`);
  await expect(editor).toContainText("reconnectBudgetMs");

  // Now it goes stale under the open document.
  writeFileSync(join(cwd, SOURCE), CHANGED_ON_DISK);

  await editor.click();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.type(TYPED);

  const notice = page.locator(".file-notice.is-conflict");
  await expect(notice).toBeVisible();
  return notice;
}

test("Copy local confirms, and puts the local version on the clipboard", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const notice = await conflictNotice(dashboard, daemon);

  const copy = notice.getByRole("button", { name: "Copy local" });
  await expect(copy).toBeVisible();
  await copy.click();

  // The whole point of the change: it says something. The same word every other copy control in
  // the app says.
  await expect(notice.getByRole("button", { name: "Copied" })).toBeVisible();

  // And what it copied is the reader's own text - not the version on disk that is about to
  // replace it, which is the only reason to reach for this button.
  const copied = await dashboard.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain(TYPED.trim());
  expect(copied).not.toContain("someone else got here first");

  // Then the control comes back, so a second copy reads as available rather than spent.
  await expect(copy).toBeVisible({ timeout: 4000 });
});

test("a Copy local the renderer refuses says so beside the button", async ({
  dashboard,
  daemon,
}) => {
  // Neither clipboard route available: no async Clipboard API to write with, and `execCommand`
  // reporting a refusal. This is the state the old control was completely silent in.
  await dashboard.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    document.execCommand = () => false;
  });
  const notice = await conflictNotice(dashboard, daemon);

  await notice.getByRole("button", { name: "Copy local" }).click();

  await expect(notice.getByRole("alert")).toHaveText("The browser refused the clipboard copy");
  // And it did not claim otherwise.
  await expect(notice.getByRole("button", { name: "Copy local" })).toBeVisible();
  await expect(notice.getByRole("button", { name: "Copied" })).toHaveCount(0);

  /*
   * The sentence belongs to the file it was raised on, and this component does not remount
   * between files - so without `useCopyFeedback`'s `resetOn` it would have no lifetime at all.
   * A refusal arms no hold to expire, so the red line would outlive its own conflict and
   * reappear on the next file, beside the buttons that discard or overwrite, describing a copy
   * of something else that was never attempted.
   *
   * Deterministic rather than racing the 1600ms hold, which is the whole reason this asserts on
   * the error rather than on the `Copied` label.
   */
  const files = dashboard.getByRole("listbox", { name: "Session files" });
  await files.getByRole("option", { name: OTHER }).click();
  await expect(notice).toBeHidden();
  await files.getByRole("option", { name: SOURCE }).click();
  await expect(notice).toBeVisible();
  await expect(notice.getByRole("alert")).toHaveCount(0);
});
