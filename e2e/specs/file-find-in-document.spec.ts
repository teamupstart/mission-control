import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

const EVIDENCE = artifactsDir("file-find-in-document");

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/file-find-in-document/${name}.png`);
}

/**
 * Cmd+F over a document in the Files workspace.
 *
 * Only a browser can assert any of this. The count, the ring and the marks are model work a
 * unit test already covers; what it cannot see is the keystroke reaching this workspace
 * instead of App's `findInConversation` - which today switches the detail to the Conversation
 * tab, because the Files tab mounts no transcript - nor the two surfaces agreeing on a query
 * while counting the strings they each actually show, nor the CodeMirror search panel being
 * absent, which is a negative about the DOM and nothing else can state it.
 */

const TASK = "read the reconnect plan in the files tab";

/*
 * The fixture, and its line numbers are the point.
 *
 * 1  heading           "Reconnect"        - rendered and in source
 * 3  paragraph         "reconnect"        - rendered and in source
 * 5  paragraph         "reconnect"        - rendered and in source
 * 7  link DESTINATION  "onlyhere"         - in source only; it renders to nothing
 * 9  link DESTINATION  "hidden"           - in source only, and BEFORE the visible one
 * 11 paragraph         "hidden"           - the only one Preview can reach
 *
 * Lines 9 and 11 are the pair that catches the toggle taking the wrong hit: Preview has one
 * `hidden` and the Editor has two, so a toggle that reused the ordinal would land on line 9.
 */
const PLAN_MD = `# Reconnect notes

The reconnect budget is bounded.

The reconnect loop retries.

See [the audit](docs/onlyhere-audit.md) for details.

See [the notes](docs/hidden-notes.md) too.

The hidden paragraph is the one Preview can reach.
`;

const REPORT_HTML = `<!doctype html>
<html><body>
  <section style="height: 100vh">
    <h1>SSE reconnect audit</h1>
    <p>The first page says nothing about the budget.</p>
  </section>
  <section style="height: 100vh">
    <h2>Reconnect details</h2>
    <p id="verdict">The reconnect budget is bounded.</p>
    <p>paired alpha</p><p>paired beta</p>
  </section>
</body></html>
`;

const PLAN = "docs/plans/reconnect/plan.md";
const REPORT = "docs/reports/reconnect/report.html";

async function dispatch(page: Page, daemon: DaemonHandle, task = TASK): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // The repo combobox portals its listbox over the Task field and reopens on every
  // keystroke; without this the next fill lands on a covered control.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(task);
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

/** See diff-open-in-files.spec.ts - the Files TAB lives in the Console layout. */
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

async function openFilesTab(page: Page, daemon: DaemonHandle): Promise<void> {
  await dispatch(page, daemon);
  const cwd = await sessionCwd(daemon);
  mkdirSync(join(cwd, "docs", "plans", "reconnect"), { recursive: true });
  writeFileSync(join(cwd, PLAN), PLAN_MD);
  mkdirSync(join(cwd, "docs", "reports", "reconnect"), { recursive: true });
  writeFileSync(join(cwd, REPORT), REPORT_HTML);

  await useConsoleLayout(page, daemon);
  await page
    .getByRole("navigation", { name: "Sessions" })
    .getByRole("button", { name: /Read the Reconnect Plan/i })
    .click();
  await page
    .getByRole("tablist", { name: "Session detail" })
    .getByRole("tab", { name: /Files$/ })
    .click();
  await expect(page.getByRole("listbox", { name: "Session files" })).toBeVisible();
}

const searchbox = (page: Page) => page.getByRole("searchbox", { name: "Find in this document" });
const readout = (page: Page) => page.locator(".file-content .find-bar .find-count");
const marks = (page: Page) => page.locator(".file-markdown-preview mark.find-hit");
const currentMark = (page: Page) => page.locator(".file-markdown-preview mark.find-hit.is-current");
const decorations = (page: Page) => page.locator(".file-content .cm-searchMatch");
const currentDecoration = (page: Page) =>
  page.locator(".file-content .cm-searchMatch.cm-searchMatch-selected");

async function openPlan(page: Page): Promise<void> {
  await page
    .getByRole("listbox", { name: "Session files" })
    .getByRole("option", { name: PLAN })
    .click();
  await expect(page.getByRole("heading", { name: "Reconnect notes" })).toBeVisible();
}

test("Cmd+F searches the document rather than opening the conversation", async ({
  dashboard,
  daemon,
}) => {
  await openFilesTab(dashboard, daemon);
  await openPlan(dashboard);

  const tabs = dashboard.getByRole("tablist", { name: "Session detail" });
  const filesTab = tabs.getByRole("tab", { name: /Files$/ });
  const conversationTab = tabs.getByRole("tab", { name: /Conversation/ });
  await expect(filesTab).toHaveAttribute("aria-selected", "true");

  await dashboard.keyboard.press("Meta+f");
  await expect(searchbox(dashboard)).toBeFocused();
  // The whole first thing this feature had to fix: the chord used to fall through to App,
  // which revealed the conversation and left the document behind.
  await expect(filesTab).toHaveAttribute("aria-selected", "true");
  await expect(conversationTab).toHaveAttribute("aria-selected", "false");
  await expect(dashboard.getByRole("searchbox", { name: "Find in conversation" })).toHaveCount(0);

  await searchbox(dashboard).fill("reconnect");
  // Three in the rendered text: the heading and two paragraphs. The link's own line holds no
  // occurrence of this query - the surfaces are separated by `onlyhere` further down.
  await expect(marks(dashboard)).toHaveCount(3);
  await expect(readout(dashboard)).toHaveText("1 / 3");
  await expect(currentMark(dashboard)).toHaveCount(1);
  await expect(currentMark(dashboard)).toHaveText(/Reconnect/i);
  await shoot(dashboard, "preview-find-open");

  // Enter steps the ring, and the current mark moves with it.
  await dashboard.keyboard.press("Enter");
  await expect(readout(dashboard)).toHaveText("2 / 3");
  await expect(currentMark(dashboard)).toHaveCount(1);
  const second = await currentMark(dashboard).evaluate(
    (mark) => mark.closest("p")?.textContent ?? "",
  );
  expect(second).toContain("budget is bounded");

  // Shift+Enter steps back, and the ring wraps at both ends.
  await dashboard.keyboard.press("Shift+Enter");
  await expect(readout(dashboard)).toHaveText("1 / 3");
  await dashboard.keyboard.press("Shift+Enter");
  await expect(readout(dashboard)).toHaveText("3 / 3");
  await dashboard.keyboard.press("Enter");
  await expect(readout(dashboard)).toHaveText("1 / 3");

  // Escape closes find and stops there: the Files tab is still the one on screen.
  await dashboard.keyboard.press("Escape");
  await expect(searchbox(dashboard)).toHaveCount(0);
  await expect(marks(dashboard)).toHaveCount(0);
  await expect(filesTab).toHaveAttribute("aria-selected", "true");

  // Reopening keeps the last query, selected, so typing replaces it.
  await dashboard.keyboard.press("Control+f");
  await expect(searchbox(dashboard)).toHaveValue("reconnect");
  await expect(searchbox(dashboard)).toBeFocused();
  await expect(marks(dashboard)).toHaveCount(3);
});

test("find-next and find-previous step the ring from Preview, where no editor exists", async ({
  dashboard,
  daemon,
}) => {
  /*
   * Only `FileEditor` claims F3 and Mod-G, so with find open over a rendered document - which
   * mounts no CodeMirror at all - those keys fell through to the browser while the docs said
   * they step this document's ring. The workspace listener claims them too now, and Preview is
   * the surface that proves it: there is nothing else here that could have answered.
   */
  await openFilesTab(dashboard, daemon);
  await openPlan(dashboard);
  await dashboard.keyboard.press("Meta+f");
  await searchbox(dashboard).fill("reconnect");
  await expect(readout(dashboard)).toHaveText("1 / 3");
  await expect(marks(dashboard)).toHaveCount(3);
  // No editor on this surface, so no CodeMirror handler can be the thing that responds.
  await expect(dashboard.locator(".file-content .cm-content")).toHaveCount(0);

  // Away from the query box, so the bar's own Enter handler is not what steps the ring.
  await dashboard.locator(".file-markdown-preview").click({ position: { x: 5, y: 5 } });
  await dashboard.keyboard.press("F3");
  await expect(readout(dashboard)).toHaveText("2 / 3");
  await dashboard.keyboard.press("ControlOrMeta+g");
  await expect(readout(dashboard)).toHaveText("3 / 3");
  await dashboard.keyboard.press("Shift+F3");
  await expect(readout(dashboard)).toHaveText("2 / 3");
  await dashboard.keyboard.press("Shift+ControlOrMeta+g");
  await expect(readout(dashboard)).toHaveText("1 / 3");
  // The current mark moved with the readout rather than the count drifting on its own.
  await expect(currentMark(dashboard)).toHaveCount(1);
  await expect(currentMark(dashboard)).toHaveText(/Reconnect/i);

  // Photographed mid-ring rather than at rest: the current hit is the SECOND one here, so the
  // frame shows the two weights apart - the solid current mark against the tinted others.
  await dashboard.keyboard.press("F3");
  await expect(readout(dashboard)).toHaveText("2 / 3");
  await shoot(dashboard, "preview-stepped-current-match");
});

test("one find session crosses the Preview/Editor toggle, each surface counting what it shows", async ({
  dashboard,
  daemon,
}) => {
  await openFilesTab(dashboard, daemon);
  await openPlan(dashboard);
  const modes = dashboard.getByRole("group", { name: "File view mode" });

  await dashboard.keyboard.press("Meta+f");
  await searchbox(dashboard).fill("reconnect");
  await dashboard.getByRole("button", { name: "Aa" }).click();
  await expect(dashboard.getByRole("button", { name: "Aa" })).toHaveAttribute("aria-pressed", "true");
  // Case-sensitive: the heading's capitalised "Reconnect" drops out, the two paragraphs stay.
  await expect(marks(dashboard)).toHaveCount(2);
  await dashboard.getByRole("button", { name: "Aa" }).click();
  await expect(marks(dashboard)).toHaveCount(3);

  // Land on the second hit, then cross the toggle.
  await searchbox(dashboard).focus();
  await dashboard.keyboard.press("Enter");
  await expect(readout(dashboard)).toHaveText("2 / 3");

  await modes.getByRole("button", { name: "Editor" }).click();
  await expect(dashboard.getByLabel(`Editor for ${PLAN}`)).toBeVisible();
  // The query and the case flag survived, and the count is re-derived over SOURCE.
  await expect(searchbox(dashboard)).toHaveValue("reconnect");
  await expect(dashboard.getByRole("button", { name: "Aa" })).toHaveAttribute("aria-pressed", "false");
  await expect(decorations(dashboard)).toHaveCount(3);
  await expect(currentDecoration(dashboard)).toHaveCount(1);
  // Position crossed by source line - the same neighbourhood, so the same ordinal here.
  await expect(readout(dashboard)).toHaveText("2 / 3");
  await shoot(dashboard, "editor-find-open");

  await modes.getByRole("button", { name: "Preview" }).click();
  await expect(marks(dashboard)).toHaveCount(3);
  await expect(readout(dashboard)).toHaveText("2 / 3");

  /*
   * The toggle lands on the hit the reader had SELECTED, not on the source hit that happens
   * to share its ordinal.
   *
   * `hidden` occurs once in a link destination on line 7 - invisible in Preview - and once in
   * the prose on line 9. Preview therefore shows one hit (line 9) while the Editor has two
   * (lines 7 and 9). Selecting Preview's only hit and switching must land on line 9's, which
   * is Editor hit 2 of 2; landing on 1 of 2 would be the hidden destination, chosen because it
   * carried the old ordinal.
   */
  await searchbox(dashboard).fill("hidden");
  await expect(marks(dashboard)).toHaveCount(1);
  await expect(readout(dashboard)).toHaveText("1 / 1");
  await modes.getByRole("button", { name: "Editor" }).click();
  await expect(decorations(dashboard)).toHaveCount(2);
  await expect(readout(dashboard)).toHaveText("2 / 2");
  await modes.getByRole("button", { name: "Preview" }).click();
  await expect(readout(dashboard)).toHaveText("1 / 1");

  /*
   * The two surfaces do NOT agree on a count, and must not: `onlyhere` occurs once in the
   * source, inside a link destination, and nowhere in the rendered page. A Preview reporting
   * 1 would offer a match nothing can highlight or step to.
   */
  await searchbox(dashboard).fill("onlyhere");
  await expect(marks(dashboard)).toHaveCount(0);
  await expect(readout(dashboard)).toHaveText("No results");
  await modes.getByRole("button", { name: "Editor" }).click();
  await expect(decorations(dashboard)).toHaveCount(1);
  await expect(readout(dashboard)).toHaveText("1 / 1");
  await shoot(dashboard, "link-destination-counts");
});

test("no CodeMirror search panel can open from a Files document, by any of its bindings", async ({
  dashboard,
  daemon,
}) => {
  await openFilesTab(dashboard, daemon);
  await openPlan(dashboard);
  await dashboard.getByRole("group", { name: "File view mode" })
    .getByRole("button", { name: "Editor" })
    .click();
  // The label is on `.cm-content` itself - `FileEditor` publishes it through
  // `EditorView.contentAttributes` - so this locator IS the editable surface to click.
  const editor = dashboard.getByLabel(`Editor for ${PLAN}`);
  await expect(editor).toBeVisible();
  const panels = dashboard.locator(".file-content .cm-panels");

  // The guarantee is asserted over the DOM rather than over a list of chords, because a list
  // is what this repository has already learned not to trust. A binding missed by the claim
  // fails HERE rather than quietly restoring the old panel.
  await editor.click();
  for (const chord of [
    "ControlOrMeta+f",
    "F3",
    "Shift+F3",
    "ControlOrMeta+g",
    "Shift+ControlOrMeta+g",
    "ControlOrMeta+Alt+g",
  ]) {
    await dashboard.keyboard.press(chord);
    await expect(panels, `${chord} opened a CodeMirror panel`).toHaveCount(0);
  }
  // Our bar is what answered instead.
  await expect(searchbox(dashboard)).toBeVisible();

  /*
   * F3 and Mod-g are repurposed rather than deadened: find-next and find-previous step the
   * shared ring, so they keep meaning what a reader expects.
   *
   * `ControlOrMeta` is this platform's own modifier, so a macOS run exercises ⌘ and a Linux
   * CI shard exercises Ctrl - which is how the original defect was caught, because
   * Shift+⌘G stepped backwards while Shift+Ctrl+G stepped forwards. The rule that both
   * modifiers and both key kinds agree is pinned without a browser in
   * `test/file-editor-find.test.ts` (`editorFindChord`); this asserts it end to end on
   * whichever platform is running.
   */
  await searchbox(dashboard).fill("reconnect");
  await expect(readout(dashboard)).toHaveText("1 / 3");
  await editor.click();
  await dashboard.keyboard.press("F3");
  await expect(readout(dashboard)).toHaveText("2 / 3");
  await dashboard.keyboard.press("ControlOrMeta+g");
  await expect(readout(dashboard)).toHaveText("3 / 3");
  await dashboard.keyboard.press("Shift+F3");
  await expect(readout(dashboard)).toHaveText("2 / 3");
  await dashboard.keyboard.press("Shift+ControlOrMeta+g");
  await expect(readout(dashboard)).toHaveText("1 / 3");
  await expect(panels).toHaveCount(0);
  await shoot(dashboard, "no-codemirror-panel");
});

test("the Persona editor keeps CodeMirror's own find, because it has no find owner", async ({
  dashboard,
  daemon,
}) => {
  /*
   * The other half of the claim above, and the reason it is conditional. `FileEditor` has
   * four hosts and three of them have no find session; claiming the chord there would
   * suppress CodeMirror's panel and answer with nothing, leaving them with no find at all
   * where they have a working one today.
   */
  const created = await fetch(`${daemon.baseURL}/api/personas`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Find reviewer",
      description: "Reads the diff and says whether it holds.",
      guidanceMarkdown: "# Find reviewer\n\nThe reconnect budget is bounded.\n",
    }),
  });
  const persona = (await created.json()) as { id: string };
  await dashboard.goto(`${daemon.baseURL}/#/library/personas/${persona.id}`);
  await dashboard.getByRole("group", { name: "Persona guidance view" })
    .getByRole("button", { name: "Editor" })
    .click();
  const host = dashboard.locator(".persona-guidance-content");
  await expect(host.locator(".cm-content")).toBeVisible();
  await host.locator(".cm-content").click();

  await dashboard.keyboard.press("ControlOrMeta+f");
  // CodeMirror's own panel, unchanged - and none of this app's find bar.
  await expect(host.locator(".cm-panels")).toHaveCount(1);
  await expect(dashboard.getByRole("searchbox", { name: "Find in this document" })).toHaveCount(0);
  await shoot(dashboard, "persona-editor-unchanged");
});

test("find works in the extracted Files window", async ({ dashboard, daemon }) => {
  await openFilesTab(dashboard, daemon);
  await openPlan(dashboard);
  await dashboard.getByRole("button", { name: "Extract files window" }).click();
  const extracted = dashboard.getByRole("dialog", { name: /Files for / });
  await expect(extracted).toBeVisible();

  /*
   * The workspace owns the chord for exactly this: App stands every session chord down while
   * an overlay is open, and this window is an overlay. The bare `p`/`e` chords stand down here
   * too, which is why find could not be one of them.
   */
  await dashboard.keyboard.press("Meta+f");
  const box = extracted.getByRole("searchbox", { name: "Find in this document" });
  await expect(box).toBeFocused();
  await box.fill("reconnect");
  await expect(extracted.locator(".file-markdown-preview mark.find-hit")).toHaveCount(3);
  await expect(extracted.locator(".find-bar .find-count")).toHaveText("1 / 3");
  await shoot(dashboard, "extracted-window-find");
});

test("an HTML preview reveals the block holding the current match, and says so", async ({
  dashboard,
  daemon,
}) => {
  await openFilesTab(dashboard, daemon);
  await dashboard
    .getByRole("listbox", { name: "Session files" })
    .getByRole("option", { name: REPORT })
    .click();
  const report = dashboard.frameLocator(`iframe[title="Preview of ${REPORT}"]`);
  await expect(report.getByRole("heading", { name: "SSE reconnect audit" })).toBeVisible();

  await dashboard.keyboard.press("Meta+f");
  await searchbox(dashboard).fill("budget is bounded");
  // The count is taken over SOURCE here, because the sandbox is opaque to this origin - so
  // the bar says what the number means rather than implying character accuracy it lacks.
  await expect(dashboard.locator(".file-content .find-bar .find-note")).toHaveText("by block");
  await expect(readout(dashboard)).toHaveText("1 / 1");

  // The block containing the match is revealed and outlined, through the daemon's existing
  // block resolver and the target message the comment jump already uses.
  const verdict = report.locator("#verdict");
  await expect(verdict).toHaveClass(/mission-comment-target/);
  await expect
    .poll(() => report.locator("body").evaluate(() => window.scrollY))
    .toBeGreaterThan(0);
  /*
   * And it is actually ON SCREEN.
   *
   * The two assertions above are both true the instant the reveal begins: the class is set
   * before the scroll, and `scrollY > 0` holds from the first frame of a `behavior: "smooth"`
   * animation. Neither says the reader can see the block, which is the whole claim - and a
   * screenshot taken between them caught the top of the report instead of the reveal.
   */
  await expect
    .poll(() => verdict.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return box.top >= 0 && box.bottom <= window.innerHeight ? "in view" : "off screen";
    }), { message: "the revealed block never settled inside the frame's viewport" })
    .toBe("in view");
  await shoot(dashboard, "html-block-reveal");

  /*
   * Two occurrences on ONE source line, in two different blocks, are one ring entry.
   *
   * This surface is told a LINE, so both would produce byte-identical resolve requests and the
   * same answer: offering two entries promised a step that cannot happen, and the reveal could
   * land on the block belonging to the other occurrence. The ring is therefore over the
   * locations this surface can actually reach, which is what "by block" means. Phase 2's
   * in-frame bridge reports character positions and retires both the grouping and the note.
   */
  await searchbox(dashboard).fill("paired");
  await expect(readout(dashboard)).toHaveText("1 / 1");
  // Stepping cannot stall on an entry it could not distinguish, because there is only one.
  await dashboard.keyboard.press("Enter");
  await expect(readout(dashboard)).toHaveText("1 / 1");
  // The Editor, which shows source, still counts both occurrences - each surface counts what
  // it shows, and here that difference is the honest one.
  await dashboard.getByRole("group", { name: "File view mode" })
    .getByRole("button", { name: "Editor" })
    .click();
  await expect(decorations(dashboard)).toHaveCount(2);
  await expect(readout(dashboard)).toHaveText("1 / 2");
});
