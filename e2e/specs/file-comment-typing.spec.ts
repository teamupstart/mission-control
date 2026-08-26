// Typing a comment. With keys.
//
// The rest of the file-comment specs put text in a composer with `fill()`, which is the right
// tool for a spec whose subject is somewhere else: it is fast and it cannot mistype. What it
// cannot do is fail the way a person does. `fill()` focuses an element and assigns its value,
// so it never asks whether the box would have taken a keystroke, and - because the value it
// assigns is read back by the code under test through the DOM - it can leave a composer whose
// React state never advanced holding exactly the text the spec wanted.
//
// That combination hid a total failure of this feature: the composer's draft hook armed its
// liveness flag only as an initial value and cleared it from a cleanup, so `StrictMode`'s
// double-invoked mount effect - development builds only - left the flag false from the first
// render and every keystroke was dropped on the floor before it reached React state. Both
// surfaces, preview and editor, were untypable in `make start`. Every spec stayed green.
//
// So this spec is deliberately the awkward one: real keystrokes, on the DEV dashboard, on both
// surfaces. See `e2e/fixtures/dev-dashboard.ts` for why that build needs covering at all.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { startDevDashboard, type DevDashboardHandle } from "../fixtures/dev-dashboard.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";

const EVIDENCE = artifactsDir("file-comment-typing");

/** A frame of the composer holding typed text, for review. Off unless asked for. */
async function shoot(target: Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/file-comment-typing/${name}.png`);
}

const TASK = "type a comment by hand";
const SOURCE = "docs/plans/retry.md";
const SOURCE_TEXT = [
  "# Retry policy",                       // 1
  "",                                     // 2
  "The retry budget is thirty seconds.",  // 3
  "",                                     // 4
  "Three retries fit inside it.",         // 5
].join("\n");
const TYPED = "Thirty seconds contradicts the table below.";
const EDITOR_TYPED = "And this line is the one that says it.";

/** Dispatch one session, the way every other file spec does. */
async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // The repo combobox portals its listbox over the Task field and reopens on every keystroke,
  // so the fill below can land on a covered control. See file-default-view.spec.ts.
  await page.keyboard.press("Escape");
  const task = dialog.getByPlaceholder("What should this agent do?");
  await expect.poll(async () => {
    await task.fill(TASK);
    return task.inputValue();
  }, { message: "the Task field never took the text" }).toBe(TASK);
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

async function sessionCwd(daemon: DaemonHandle): Promise<string> {
  const read = async (): Promise<string | null> => {
    const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as {
      cwd: string | null;
    }[];
    return sessions[0]?.cwd ?? null;
  };
  await expect
    .poll(read, { message: "the dispatched session never reported a working directory" })
    .not.toBeNull();
  return (await read())!;
}

/** Every comment the daemon holds, with the body it holds for it. */
function storedComments(daemon: DaemonHandle): { start_line: number; body: string }[] {
  return withDaemonDb(daemon, (db) =>
    db
      .prepare(
        `SELECT t.start_line, m.body
           FROM file_comment_threads t
           JOIN file_comment_messages m ON m.thread_id = t.id
          ORDER BY t.created_at, m.created_at`,
      )
      .all() as never);
}

test.describe("typing a comment with real keystrokes", () => {
  let dev: DevDashboardHandle | null = null;

  test.afterEach(() => {
    dev?.stop();
    dev = null;
  });

  test("both composers take keystrokes on the development dashboard", async ({ page, daemon }) => {
    dev = await startDevDashboard(daemon);

    // The `dashboard` fixture's pins, applied to this origin instead. Both halves matter for
    // its reasons: the PUT is what `hydrateUiConfig()` adopts, and the cache write is what the
    // first paint reads. Console, because the Files tab lives in that layout.
    const pinned = await fetch(`${daemon.baseURL}/api/ui/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        guidedDispatch: false,
        guidedTour: false,
        conversationView: "chat",
        layout: "console",
      }),
    });
    expect(pinned.ok, "the daemon should accept the dashboard preference pins").toBe(true);
    await page.goto(`${dev.origin}/#/fleet`);
    await page.evaluate(() => window.localStorage.clear());
    await page.evaluate(() =>
      window.localStorage.setItem(
        "mission-control.ui",
        JSON.stringify({
          guidedDispatch: false,
          guidedTour: false,
          conversationView: "chat",
          layout: "console",
        }),
      ),
    );
    await page.reload();

    // Proof that this page is the DEVELOPMENT build, which is the entire subject of this
    // spec. Without it, a fixture that quietly served `dist/` would leave a green spec
    // asserting nothing about the build it is named for.
    expect(
      await page.evaluate(() => document.querySelector('script[src*="main.tsx"]') !== null),
      "the dev dashboard should be serving the unbundled entry module",
    ).toBe(true);

    await dispatch(page, daemon);
    const cwd = await sessionCwd(daemon);
    mkdirSync(join(cwd, dirname(SOURCE)), { recursive: true });
    writeFileSync(join(cwd, SOURCE), SOURCE_TEXT);

    await page
      .getByRole("navigation", { name: "Sessions" })
      .getByRole("button", { name: /Type A Comment By Hand/i })
      .click();
    await page
      .getByRole("tablist", { name: "Session detail" })
      .getByRole("tab", { name: /Files$/ })
      .click();
    const files = page.getByRole("listbox", { name: "Session files" });
    await expect(files).toBeVisible();
    await files.getByRole("option", { name: SOURCE }).click();
    const preview = page.getByLabel(`Preview of ${SOURCE}`);
    await expect(preview).toBeVisible();

    // ---- the rendered document ----
    const toggle = page.getByRole("button", { name: "Comment mode" });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await preview.getByText("The retry budget is thirty seconds.").hover();
    await preview.getByRole("button", { name: "Comment on line 3" }).click();

    const box = page.getByRole("textbox", { name: "Comment on line 3" });
    await expect(box).toBeVisible();
    // The composer is opened by a click on the document, so the caret has to arrive without a
    // second one - and if it did not, the keystrokes below would go to App's global shortcuts.
    await expect(box, "the composer should take the caret when it opens").toBeFocused();
    await page.keyboard.type(TYPED);
    await expect(box, "the composer draws what was typed into it").toHaveValue(TYPED);

    const submit = page.getByRole("button", { name: "Comment", exact: true });
    // The button reads the same state the box does, so a dropped keystroke disables it - which
    // is what a reader saw: an empty box they could not submit, over a comment being saved.
    await expect(submit, "typed text arms the submit button").toBeEnabled();
    await shoot(page.locator(".file-content"), "typed-in-preview");
    await submit.click();
    await expect(box).toBeHidden();
    await expect
      .poll(() => storedComments(daemon).map((row) => [row.start_line, row.body]), {
        message: "the typed comment never reached the daemon",
      })
      .toEqual([[3, TYPED]]);

    // ---- the editor's gutter, the other door to the same composer ----
    await page.getByRole("button", { name: "Editor" }).click();
    await page
      .locator(".cm-lineNumbers .cm-gutterElement")
      .filter({ hasText: /^5$/ })
      .click();
    const editorBox = page.getByRole("textbox", { name: "Comment on line 5" });
    await expect(editorBox).toBeVisible();
    await expect(editorBox, "the gutter composer should take the caret too").toBeFocused();
    await page.keyboard.type(EDITOR_TYPED);
    await expect(editorBox, "the gutter composer draws what was typed into it")
      .toHaveValue(EDITOR_TYPED);
    await shoot(page.locator(".file-content"), "typed-in-editor");
    await expect
      .poll(() => storedComments(daemon).map((row) => [row.start_line, row.body]), {
        message: "the editor draft never reached the daemon",
      })
      .toEqual([[3, TYPED], [5, EDITOR_TYPED]]);
  });
});
