import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Comment mode where a person actually reads a spec: on the RENDERED document.
 *
 * Hover a paragraph in Markdown Preview, or any block in HTML Preview, and leave a comment
 * anchored to its exact source lines. This is the only layer that can say whether that
 * works. `renderToStaticMarkup` proves the anchor host carries a line range but never mounts
 * an iframe, never delivers a `postMessage`, and never runs the bridge whose whole job is to
 * report where a click landed inside an opaque sandbox. The route tests parse HTML without a
 * browser, which is exactly the parity the parse5 resolver exists to guarantee and cannot
 * itself demonstrate.
 *
 * The claim under test is one sentence: **a comment made in Preview lands on the same source
 * line the Editor shows.** So every case here ends the same way - flip to the Editor and read
 * the marker off the gutter.
 *
 * No model tokens. Every agent binary is redirected at a fake by `fake-agents.ts`, and this
 * spec never asks an agent for anything.
 */

const EVIDENCE = artifactsDir("file-comment-preview-surfaces");

/** Photograph a state this spec has already asserted on. See file-line-comments.spec.ts. */
async function shoot(target: Locator, page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/file-comment-preview-surfaces/${name}.png`);
}

const TASK = "review the rendered spec";

const MARKDOWN = "docs/plans/spec.md";
const MARKDOWN_SOURCE = [
  "# The spec",                                  // 1
  "",                                            // 2
  "The retry budget is thirty seconds.",         // 3
  "",                                            // 4
  "## Limits",                                   // 5
  "",                                            // 6
  "| Retries | Window |",                        // 7
  "| --- | --- |",                               // 8
  "| 3 | 30s |",                                 // 9
  "",                                            // 10
].join("\n");

const HTML = "docs/plans/mockup.html";
/**
 * Every case a text-matching resolver would have failed, in one document.
 *
 * - line 4: nested inline markup, whose DOM text appears nowhere in the source.
 * - line 5: a character entity, which renders as something the file does not contain.
 * - lines 6 and 7: two blocks with identical text.
 * - line 10: a row inside a table written with no `<tbody>`, which the browser inserts and a
 *   tag walk over the source does not.
 */
const HTML_SOURCE = [
  "<html>",                                                    // 1
  "<head><title>Mockup</title></head>",                        // 2
  "<body>",                                                    // 3
  "<p>Read <strong>this</strong> carefully.</p>",              // 4
  "<p>Fish &amp; chips, twice.</p>",                            // 5
  "<p>The budget is thirty seconds.</p>",                       // 6
  "<p>The budget is thirty seconds.</p>",                       // 7
  "<table>",                                                    // 8
  "<tr><th>Retries</th><th>Window</th></tr>",                   // 9
  "<tr><td>3</td><td>30s</td></tr>",                            // 10
  "</table>",                                                   // 11
  "<hr>",                                                       // 12
  '<div id="multi-block" style="padding: 10px">'               // 13
    + "<style>.unseen { color: red; }</style>"
    + "<p>First paragraph.</p>"
    + "<script>window.unseen = true;</script>"
    + "<span hidden>Hidden attribute.</span>"
    + '<span style="display: none">Display none.</span>'
    + '<span style="visibility: hidden">Visibility hidden.</span>'
    + "<p>Second paragraph.</p></div>",
  '<select id="frequency"><option>Daily</option>'               // 14
    + "<option>Weekly</option></select>",
  '<div id="only-hidden" style="padding: 10px">'               // 15
    + "<script>window.hiddenOnly = true;</script>"
    + "<span hidden>Hidden only.</span></div>",
  '<p id="inline-block" style="padding: 10px">'                // 16
    + '<span style="display: inline-block">first</span>second</p>',
  '<div id="only-comment" style="padding: 10px">'              // 17
    + "<!-- internal implementation note --></div>",
  '<input id="search-query" type="text" value="Search term">', // 18
  "</body>",                                                    // 19
  "</html>",                                                    // 20
].join("\n");

const HTML_HISTORY = "docs/plans/comment-history.html";
const HTML_HISTORY_FILLER_COUNT = 72;
const HTML_HISTORY_BOTTOM_LINE = 5 + HTML_HISTORY_FILLER_COUNT;
const HTML_HISTORY_SOURCE = [
  "<html>",
  "<head><title>Comment history</title></head>",
  "<body>",
  "<p>Top reliability question.</p>",
  ...Array.from(
    { length: HTML_HISTORY_FILLER_COUNT },
    (_, index) => `<p>Background paragraph ${index + 1}.</p>`,
  ),
  "<p>Bottom reliability question.</p>",
  "</body>",
  "</html>",
].join("\n");

const HTML_COMPACT = "docs/plans/compact-comment.html";
const HTML_COMPACT_SOURCE =
  "<html><body><p>Read <strong>this</strong> carefully.</p><p>Sibling.</p></body></html>";

const HTML_BLOCKS = "docs/plans/blocks.html";
/**
 * Blocks a tag allowlist did not name, which is the point of this document.
 *
 * `form`, `fieldset` and `address` are ordinary blocks that the selector this bridge used to
 * carry simply had not thought of, and the last one here is the case no list could ever
 * cover: a `span` the document itself styles into a block. What decides is the layout the
 * browser produced, so all of them are hoverable and all of them anchor.
 *
 * A closed `dialog` is deliberately present too. It computes to `display:none`, so it is NOT
 * a block anybody can point at, and nothing may anchor to it.
 */
const HTML_BLOCKS_SOURCE = [
  "<html>",                                                                 // 1
  "<head><title>Blocks</title><style>.card{display:block}</style></head>",  // 2
  "<body>",                                                                 // 3
  "<address>Written by the platform team.</address>",                       // 4
  "<form>",                                                                 // 5
  "<fieldset>Retry budget, in seconds.</fieldset>",                         // 6
  "</form>",                                                                // 7
  "<span class=\"card\">Styled into a block by the document itself.</span>", // 8
  "<dialog>Never shown, never commentable.</dialog>",                       // 9
  "</body>",                                                                // 10
  "</html>",                                                                // 11
].join("\n");

const HTML_DIALOG = "docs/plans/dialog.html";
/**
 * An open `dialog`, alone in its own document, and the reason it is not in the one above.
 *
 * A non-modal `dialog[open]` is `position:absolute` in the UA stylesheet, so it lays itself
 * over whatever precedes it and intercepts their pointer events. That is real browser
 * behavior rather than anything this feature does, and the honest way to cover the element
 * is to give it a document where it covers nothing - not to restyle it until the test is
 * comfortable.
 */
const HTML_DIALOG_SOURCE = [
  "<html>",                                                // 1
  "<head><title>Dialog</title></head>",                    // 2
  "<body>",                                                // 3
  "<dialog open>The deploy is still running.</dialog>",     // 4
  "</body>",                                               // 5
  "</html>",                                               // 6
].join("\n");

const HTML_LONG = "docs/reports/report.html";
/**
 * The shape of a real generated report, which is the shape that broke this.
 *
 * A hand-written fixture is a dozen lines long, so every block it has anchors inside the
 * first screen of anything. A generated report carries its stylesheet inline, so the first
 * thing a reader SEES rendered is a couple of hundred lines into the file - and the panel is
 * drawn at the anchored line. While that panel lived in a CodeMirror column, this document
 * opened it outside the rendered viewport, where it was never attached to the page at all:
 * the click resolved correctly, and nothing appeared and nothing said why.
 *
 * The `<h1>` is on line 210. Nothing else about this document is unusual, which is the point.
 */
const HTML_LONG_SOURCE = [
  "<!doctype html>",                                                         // 1
  '<html lang="en">',                                                        // 2
  "<head>",                                                                  // 3
  '<meta charset="utf-8">',                                                  // 4
  "<title>Report</title>",                                                   // 5
  "<style>",                                                                 // 6
  ...Array.from(                                                             // 7-206
    { length: 200 },
    (_, i) => `  .filler-${i} { color: #${i % 10}${i % 10}${i % 10}; }`,
  ),
  "</style>",                                                                // 207
  "</head>",                                                                 // 208
  "<body>",                                                                  // 209
  "<h1>Pi is a capable terminal harness</h1>",                               // 210
  "<p>The budget is thirty seconds.</p>",                                    // 211
  "</body>",                                                                 // 212
  "</html>",                                                                 // 213
].join("\n");

const MARKDOWN_COMMENT = "Thirty seconds contradicts the table below.";
const TABLE_COMMENT = "This table is missing a units column.";
const HTML_COMMENT = "This paragraph says the opposite of the heading.";
const ROW_COMMENT = "Three retries in thirty seconds is not achievable.";
const TOP_HISTORY_COMMENT = "Clarify the top reliability question.";
const BOTTOM_HISTORY_COMMENT = "Close the bottom reliability question.";
const COMPACT_HISTORY_COMMENT = "Keep this thread on the paragraph, not its inline child.";
const COMPACT_SIBLING_COMMENT = "Keep this second same-line paragraph as its own thread.";
const LONG_COMMENT = "This heading overstates what the report goes on to say.";
const DRAFT_COMMENT = "Half a thought about this paragraph,";

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // The repo combobox portals its listbox over the Task field and reopens on every keystroke,
  // so the fill below can land on a covered control. See file-default-view.spec.ts. Escape
  // closes it; the assertion is what makes a fill that still missed a loud failure here
  // rather than a session dispatched with an empty task and an unfindable name later.
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

function write(cwd: string, path: string, contents: string): void {
  mkdirSync(join(cwd, dirname(path)), { recursive: true });
  writeFileSync(join(cwd, path), contents);
}

async function openFiles(page: Page): Promise<void> {
  await page
    .getByRole("navigation", { name: "Sessions" })
    .getByRole("button", { name: /Review The Rendered Spec/i })
    .click();
  await page
    .getByRole("tablist", { name: "Session detail" })
    .getByRole("tab", { name: /Files$/ })
    .click();
  await expect(page.getByRole("listbox", { name: "Session files" })).toBeVisible();
}

/**
 * Open a file and wait for its rendered view.
 *
 * The two previews name themselves differently and that is not an oversight: a Markdown
 * preview is an `<article>` with an `aria-label`, and an HTML preview is an `<iframe>`, whose
 * accessible name comes from `title`. Both say `Preview of <path>`.
 */
async function choose(page: Page, path: string): Promise<void> {
  await page.getByRole("listbox", { name: "Session files" }).getByRole("option", { name: path }).click();
  await expect(
    path.endsWith(".html")
      ? page.getByTitle(`Preview of ${path}`)
      : page.getByLabel(`Preview of ${path}`),
  ).toBeVisible();
}

/** Turn comment mode on, and prove the control says so. */
async function startCommenting(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: "Comment mode" });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
}

/** Write and submit a comment into whichever composer is open. */
async function writeComment(page: Page, lines: string, body: string): Promise<void> {
  const box = page.getByRole("textbox", { name: `Comment on ${lines}` });
  await expect(box).toBeVisible();
  await box.fill(body);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(box).toBeHidden();
}

/** Every thread the daemon holds, as the anchor it settled on. */
function storedThreads(daemon: DaemonHandle): {
  path: string;
  start_line: number;
  end_line: number;
  quote: string;
  surface: string;
  body: string;
}[] {
  return withDaemonDb(daemon, (db) =>
    db
      .prepare(
        `SELECT t.path, t.start_line, t.end_line, t.quote, t.surface, m.body
           FROM file_comment_threads t
           JOIN file_comment_messages m ON m.thread_id = t.id
          ORDER BY t.created_at, m.created_at`,
      )
      .all() as never);
}

/** Flip to the Editor and read a marker straight off the gutter. */
async function expectMarkerOnLine(page: Page, line: number): Promise<void> {
  await page.getByRole("button", { name: "Editor" }).click();
  await expect(
    page.getByRole("button", { name: new RegExp(`on line ${line},`) }),
  ).toBeVisible();
}

test.describe("commenting on a rendered document", () => {
  test("a comment on a Markdown block lands on the source line the Editor shows", async ({
    dashboard: page,
    daemon,
  }) => {
    await dispatch(page, daemon);
    const cwd = await sessionCwd(daemon);
    write(cwd, MARKDOWN, MARKDOWN_SOURCE);
    await useConsoleLayout(page, daemon);
    await openFiles(page);
    await choose(page, MARKDOWN);

    const preview = page.getByLabel(`Preview of ${MARKDOWN}`);
    // Nothing to click before comment mode is on: reading a document is the default, and the
    // controls stay out of it.
    await expect(preview.getByRole("button", { name: /^Comment on lines? / })).toHaveCount(0);

    await startCommenting(page);

    // ---- a paragraph ----
    const paragraph = preview.getByText("The retry budget is thirty seconds.");
    await paragraph.hover();
    await expect(preview.getByRole("button", { name: "Comment on line 3" })).toBeVisible();
    await shoot(page.locator(".file-content"), page, "markdown-hover");
    await preview.getByRole("button", { name: "Comment on line 3" }).click();
    // The quote the composer shows is the SOURCE line, which is what the agent will be sent
    // and what a later re-anchor searches the file for.
    const composer = page.getByRole("region", { name: "New comment on line 3" });
    await expect(composer).toBeVisible();
    await expect(composer.getByText("The retry budget is thirty seconds.")).toBeVisible();
    await page.getByRole("textbox", { name: "Comment on line 3" }).fill(MARKDOWN_COMMENT);
    await shoot(page.locator(".file-content"), page, "markdown-composer");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Comment on line 3" })).toBeHidden();

    // ---- a table, which spans three lines ----
    await preview.getByRole("table").hover();
    await preview.getByRole("button", { name: "Comment on lines 7 to 9" }).click();
    await writeComment(page, "lines 7-9", TABLE_COMMENT);

    await expect
      .poll(() => storedThreads(daemon).length, { message: "both comments reached the daemon" })
      .toBe(2);
    const stored = storedThreads(daemon);
    expect(stored.map((row) => [row.path, row.start_line, row.end_line, row.surface])).toEqual([
      [MARKDOWN, 3, 3, "markdown"],
      [MARKDOWN, 7, 9, "markdown"],
    ]);
    expect(stored[0]!.quote).toBe("The retry budget is thirty seconds.");
    expect(stored[0]!.body).toBe(MARKDOWN_COMMENT);
    // A block anchor quotes the WHOLE block, which is the property that makes a preview
    // comment survive an edit anywhere else in the file.
    expect(stored[1]!.quote).toBe("| Retries | Window |\n| --- | --- |\n| 3 | 30s |");
    expect(stored[1]!.body).toBe(TABLE_COMMENT);

    // ---- the claim ----
    await expectMarkerOnLine(page, 3);
    await expect(page.getByRole("button", { name: /on line 7,/ })).toBeVisible();
  });

  test("a rendered block is reachable without a pointer", async ({ dashboard: page, daemon }) => {
    // The control is hidden by OPACITY rather than `display: none`, which is what keeps it
    // focusable. Hidden the other way it would be mouse-only, and "hover any paragraph" would
    // be the whole feature for people who do not hover.
    await dispatch(page, daemon);
    const cwd = await sessionCwd(daemon);
    write(cwd, MARKDOWN, MARKDOWN_SOURCE);
    await useConsoleLayout(page, daemon);
    await openFiles(page);
    await choose(page, MARKDOWN);
    await startCommenting(page);

    const control = page
      .getByLabel(`Preview of ${MARKDOWN}`)
      .getByRole("button", { name: "Comment on line 3" });
    await control.focus();
    await expect(control).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(page.getByRole("textbox", { name: "Comment on line 3" })).toBeVisible();
    await writeComment(page, "line 3", MARKDOWN_COMMENT);
    await expect.poll(() => storedThreads(daemon).length).toBe(1);
    expect(storedThreads(daemon)[0]!.start_line).toBe(3);
    await expectMarkerOnLine(page, 3);
  });

  test("a comment on an HTML block lands on the right line, through nesting and entities", async ({
    dashboard: page,
    daemon,
  }) => {
    await dispatch(page, daemon);
    const cwd = await sessionCwd(daemon);
    write(cwd, HTML, HTML_SOURCE);
    await useConsoleLayout(page, daemon);
    await openFiles(page);
    await choose(page, HTML);

    const frame = page.frameLocator("iframe.html-preview");
    await startCommenting(page);

    // A paragraph whose DOM text - `Read this carefully.` - appears nowhere in the source.
    // Text search could not have found this, which is why the bridge reports a path instead.
    await frame.getByText("Read this carefully.").hover();
    await shoot(page.locator(".file-content"), page, "html-hover");
    await frame.getByText("Read this carefully.").click();
    // The exact source element remains the durable anchor, but the reader sees the text the
    // preview rendered rather than markup that only the re-anchor machinery needs.
    const composer = page.getByRole("region", { name: "New comment on line 4" });
    await expect(composer.getByText("Read this carefully.", { exact: true })).toBeVisible();
    await expect(composer).not.toContainText("<strong>");
    await page.getByRole("textbox", { name: "Comment on line 4" }).fill(HTML_COMMENT);
    await shoot(page.locator(".file-content"), page, "html-composer");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Comment on line 4" })).toBeHidden();

    // The same projection is used when the durable thread is reopened, not only while the
    // composer still owns the freshly resolved block.
    await frame.getByText("Read this carefully.").click();
    const thread = page.getByRole("region", { name: /^Comment MC-\w+ on line 4$/ });
    await expect(thread.getByText("Read this carefully.", { exact: true })).toBeVisible();
    await expect(thread).not.toContainText("<strong>");

    // A row inside a table written with no `<tbody>`. The browser inserts one; a source tag
    // walk does not, and would land an element off.
    await frame.getByRole("cell", { name: "30s" }).click();
    await writeComment(page, "line 10", ROW_COMMENT);

    await expect
      .poll(() => storedThreads(daemon).length, { message: "both comments reached the daemon" })
      .toBe(2);
    const stored = storedThreads(daemon);
    expect(stored.map((row) => [row.path, row.start_line, row.surface])).toEqual([
      [HTML, 4, "html"],
      [HTML, 10, "html"],
    ]);
    // Source, not rendered text, so a later `reanchor()` can find it in the file again.
    expect(stored[0]!.quote).toBe("<p>Read <strong>this</strong> carefully.</p>");
    expect(stored[1]!.quote).toBe("<tr><td>3</td><td>30s</td></tr>");

    // An element with no text cannot produce a useful prose quote, so its exact markup is
    // the intentional exception rather than a blank comment header.
    await frame.locator("hr").click();
    const elementComposer = page.getByRole("region", { name: "New comment on line 12" });
    await expect(elementComposer.getByText("<hr>", { exact: true })).toBeVisible();
    await elementComposer.getByRole("button", { name: "Cancel" }).click();

    // A container can itself be the clicked block when its padding is the pointer target.
    // Its descendant blocks remain separate sentences in the human-readable projection,
    // while non-rendered descendants contribute nothing to what the person reads.
    await frame.locator("#multi-block").click({ position: { x: 3, y: 3 } });
    const containerComposer = page.getByRole("region", { name: "New comment on line 13" });
    await expect(
      containerComposer.getByText("First paragraph. Second paragraph.", { exact: true }),
    ).toBeVisible();
    await expect(containerComposer).not.toContainText("First paragraph.Second paragraph.");
    await containerComposer.getByRole("button", { name: "Cancel" }).click();

    await expectMarkerOnLine(page, 4);
    await expect(page.getByRole("button", { name: /on line 10,/ })).toBeVisible();
  });

  test("an HTML block whose quote moved opens its existing thread after reload", async ({
    dashboard: page,
    daemon,
  }) => {
    await dispatch(page, daemon);
    const cwd = await sessionCwd(daemon);
    write(cwd, HTML, HTML_SOURCE);
    await useConsoleLayout(page, daemon);
    await openFiles(page);
    await choose(page, HTML);
    await startCommenting(page);

    await page.frameLocator("iframe.html-preview").getByText("Read this carefully.").click();
    await writeComment(page, "line 4", HTML_COMMENT);

    write(
      cwd,
      HTML,
      HTML_SOURCE.replace(
        "<p>Read <strong>this</strong> carefully.</p>",
        "\n\n<p>Read <strong>this</strong> carefully.</p>",
      ),
    );
    await page.reload();
    await openFiles(page);
    await choose(page, HTML);
    await startCommenting(page);

    await page.frameLocator("iframe.html-preview").getByText("Read this carefully.").click();
    const existingThread = page.getByRole("region", { name: /^Comment MC-\w+ on line / });
    await expect(existingThread.getByPlaceholder("Reply…")).toBeVisible();
    await shoot(page.locator(".file-content"), page, "moved-html-thread-open");
  });

  test("a single-select HTML quote names only the option the control renders", async ({
    dashboard: page,
    daemon,
  }) => {
    await dispatch(page, daemon);
    const cwd = await sessionCwd(daemon);
    write(cwd, HTML, HTML_SOURCE);
    await useConsoleLayout(page, daemon);
    await openFiles(page);
    await choose(page, HTML);
    await startCommenting(page);

    await page.frameLocator("iframe.html-preview").locator("#frequency").click();
    const composer = page.getByRole("region", { name: "New comment on line 14" });
    await expect(composer.getByText("Daily", { exact: true })).toBeVisible();
    await expect(composer).not.toContainText("Weekly");
  });

  test("an all-hidden HTML container never restores its filtered descendants", async ({
    dashboard: page,
    daemon,
  }) => {
    await dispatch(page, daemon);
    const cwd = await sessionCwd(daemon);
    write(cwd, HTML, HTML_SOURCE);
    await useConsoleLayout(page, daemon);
    await openFiles(page);
    await choose(page, HTML);
    await startCommenting(page);

    await page.frameLocator("iframe.html-preview").locator("#only-hidden").click({
      position: { x: 3, y: 3 },
    });
    const composer = page.getByRole("region", { name: "New comment on line 15" });
    await expect(
      composer.getByText('<div id="only-hidden" style="padding: 10px"></div>', { exact: true }),
    ).toBeVisible();
    await expect(composer).not.toContainText("window.hiddenOnly");
    await expect(composer).not.toContainText("Hidden only.");
  });

  test("an inline-block descendant does not invent whitespace in the quote", async ({
    dashboard: page,
    daemon,
  }) => {
    await dispatch(page, daemon);
    const cwd = await sessionCwd(daemon);
    write(cwd, HTML, HTML_SOURCE);
    await useConsoleLayout(page, daemon);
    await openFiles(page);
    await choose(page, HTML);
    await startCommenting(page);

    await page.frameLocator("iframe.html-preview").locator("#inline-block").click({
      position: { x: 3, y: 3 },
    });
    const composer = page.getByRole("region", { name: "New comment on line 16" });
    await expect(composer.getByText("firstsecond", { exact: true })).toBeVisible();
    await expect(composer).not.toContainText("first second");
  });

  test("an HTML comment-only container does not expose its source comment", async ({
    dashboard: page,
    daemon,
  }) => {
    await dispatch(page, daemon);
    const cwd = await sessionCwd(daemon);
    write(cwd, HTML, HTML_SOURCE);
    await useConsoleLayout(page, daemon);
    await openFiles(page);
    await choose(page, HTML);
    await startCommenting(page);

    await page.frameLocator("iframe.html-preview").locator("#only-comment").click({
      position: { x: 3, y: 3 },
    });
    const composer = page.getByRole("region", { name: "New comment on line 17" });
    await expect(
      composer.getByText('<div id="only-comment" style="padding: 10px"></div>', { exact: true }),
    ).toBeVisible();
    await expect(composer).not.toContainText("internal implementation note");
  });

  test("a text input HTML quote shows the value rendered by the control", async ({
    dashboard: page,
    daemon,
  }) => {
    await dispatch(page, daemon);
    const cwd = await sessionCwd(daemon);
    write(cwd, HTML, HTML_SOURCE);
    await useConsoleLayout(page, daemon);
    await openFiles(page);
    await choose(page, HTML);
    await startCommenting(page);

    await page.frameLocator("iframe.html-preview").locator("#search-query").click();
    const composer = page.getByRole("region", { name: "New comment on line 18" });
    await expect(composer.getByText("Search term", { exact: true })).toBeVisible();
    await expect(composer).not.toContainText("input");
  });

  test("the comments rail follows compact HTML after earlier lines are inserted", async ({
    dashboard: page,
    daemon,
  }) => {
    await dispatch(page, daemon);
    const cwd = await sessionCwd(daemon);
    write(cwd, HTML_COMPACT, HTML_COMPACT_SOURCE);
    await useConsoleLayout(page, daemon);
    await openFiles(page);
    await choose(page, HTML_COMPACT);
    await startCommenting(page);

    const frame = page.frameLocator("iframe.html-preview");
    const paragraph = frame.locator("p").filter({ hasText: "Read this carefully." });
    await paragraph.click();
    await writeComment(page, "line 1", COMPACT_HISTORY_COMMENT);

    write(
      cwd,
      HTML_COMPACT,
      [
        "<html>",
        "<body>",
        "<aside>New context.</aside>",
        "<p>Read <strong>this</strong> carefully.</p>",
        "<p>Sibling.</p>",
        "</body>",
        "</html>",
      ].join("\n"),
    );
    await page.reload();
    await openFiles(page);
    await choose(page, HTML_COMPACT);
    await startCommenting(page);

    await page.getByRole("button", { name: "Comments", exact: true }).click();
    const rail = page.getByRole("complementary", { name: `Comments on ${HTML_COMPACT}` });
    await rail.getByRole("button", { name: new RegExp(COMPACT_HISTORY_COMMENT) }).click();
    await expect(paragraph).toHaveClass(/mission-comment-target/);
    await shoot(page.locator(".file-main"), page, "moved-compact-html-history-target");
  });

  test("the comments rail lists resolved threads and jumps Preview and Editor to them", async ({
    dashboard: page,
    daemon,
  }) => {
    await dispatch(page, daemon);
    const cwd = await sessionCwd(daemon);
    write(cwd, HTML_HISTORY, HTML_HISTORY_SOURCE);
    await useConsoleLayout(page, daemon);
    await openFiles(page);
    await choose(page, HTML_HISTORY);
    await startCommenting(page);

    const frame = page.frameLocator("iframe.html-preview");
    const top = frame.getByText("Top reliability question.");
    const bottom = frame.getByText("Bottom reliability question.");

    await top.click();
    await writeComment(page, "line 4", TOP_HISTORY_COMMENT);
    await bottom.scrollIntoViewIfNeeded();
    await bottom.click();
    await writeComment(page, `line ${HTML_HISTORY_BOTTOM_LINE}`, BOTTOM_HISTORY_COMMENT);

    await bottom.click();
    const bottomThread = page.getByRole("region", {
      name: new RegExp(`^Comment MC-\\w+ on line ${HTML_HISTORY_BOTTOM_LINE}$`),
    });
    await bottomThread.getByRole("button", { name: "Resolve" }).click();
    await expect(bottomThread).toBeHidden();

    const commentsToggle = page.getByRole("button", { name: "Comments", exact: true });
    await expect(commentsToggle).toContainText("2");
    await commentsToggle.click();
    await expect(commentsToggle).toHaveAttribute("aria-expanded", "true");

    const rail = page.getByRole("complementary", { name: `Comments on ${HTML_HISTORY}` });
    await expect(rail).toBeVisible();
    await expect(rail.getByRole("list").getByRole("button")).toHaveCount(2);
    await expect(rail.getByText("resolved", { exact: true })).toBeVisible();

    await frame.locator("body").evaluate((body) => body.scrollTo({ top: body.scrollHeight }));
    await rail.getByRole("button", { name: new RegExp(TOP_HISTORY_COMMENT) }).click();
    await expect(top).toBeInViewport();
    const topThread = page.getByRole("region", { name: /^Comment MC-\w+ on line 4$/ });
    await expect(topThread.getByPlaceholder("Reply…")).toBeVisible();
    await shoot(page.locator(".file-main"), page, "comment-history-preview-jump");

    await page.getByRole("button", { name: "Editor" }).click();
    const sourceScroller = page.locator(".file-codemirror .cm-scroller");
    await sourceScroller.evaluate((element) => { element.scrollTop = 0; });
    await rail.getByRole("button", { name: new RegExp(BOTTOM_HISTORY_COMMENT) }).click();
    const resolvedThread = page.getByRole("region", {
      name: new RegExp(`^Comment MC-\\w+ on line ${HTML_HISTORY_BOTTOM_LINE}$`),
    });
    await expect(resolvedThread.getByRole("button", { name: "Reopen" })).toBeVisible();
    await expect.poll(() => sourceScroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
    await shoot(page.locator(".file-main"), page, "comment-history-rail");
  });

  test("the comments rail returns compact HTML to the originally commented block", async ({
    dashboard: page,
    daemon,
  }) => {
    await dispatch(page, daemon);
    const cwd = await sessionCwd(daemon);
    write(cwd, HTML_COMPACT, HTML_COMPACT_SOURCE);
    await useConsoleLayout(page, daemon);
    await openFiles(page);
    await choose(page, HTML_COMPACT);
    await startCommenting(page);

    const frame = page.frameLocator("iframe.html-preview");
    const paragraph = frame.locator("p").filter({ hasText: "Read this carefully." });
    const inline = paragraph.locator("strong");
    await inline.click();
    await writeComment(page, "line 1", COMPACT_HISTORY_COMMENT);

    await page.getByRole("button", { name: "Comments", exact: true }).click();
    const rail = page.getByRole("complementary", { name: `Comments on ${HTML_COMPACT}` });
    await rail.getByRole("button", { name: new RegExp(COMPACT_HISTORY_COMMENT) }).click();

    await expect(paragraph).toHaveClass(/mission-comment-target/);
    await expect(inline).not.toHaveClass(/mission-comment-target/);
    await shoot(page.locator(".file-main"), page, "compact-html-comment-target");
  });

  test("compact HTML blocks on one line open their own threads", async ({
    dashboard: page,
    daemon,
  }) => {
    await dispatch(page, daemon);
    const cwd = await sessionCwd(daemon);
    write(cwd, HTML_COMPACT, HTML_COMPACT_SOURCE);
    await useConsoleLayout(page, daemon);
    await openFiles(page);
    await choose(page, HTML_COMPACT);
    await startCommenting(page);

    const paragraphs = page.frameLocator("iframe.html-preview").locator("p");
    await paragraphs.nth(0).click();
    await writeComment(page, "line 1", COMPACT_HISTORY_COMMENT);

    await paragraphs.nth(1).click();
    await writeComment(page, "line 1", COMPACT_SIBLING_COMMENT);

    await paragraphs.nth(0).click();
    const thread = page.getByRole("region", { name: /^Comment MC-\w+ on line 1$/ });
    await expect(thread).toContainText(COMPACT_HISTORY_COMMENT);
    await paragraphs.nth(1).click();
    await expect(thread).toContainText(COMPACT_SIBLING_COMMENT);
    await shoot(page.locator(".file-main"), page, "compact-html-thread-selection");
  });

  test("a block is whatever the browser laid out as one, not whatever a list named", async ({
    dashboard: page,
    daemon,
  }) => {
    await dispatch(page, daemon);
    const cwd = await sessionCwd(daemon);
    write(cwd, HTML_BLOCKS, HTML_BLOCKS_SOURCE);
    write(cwd, HTML_DIALOG, HTML_DIALOG_SOURCE);
    await useConsoleLayout(page, daemon);
    await openFiles(page);
    await choose(page, HTML_BLOCKS);

    const frame = page.frameLocator("iframe.html-preview");
    await startCommenting(page);

    // Three elements a tag allowlist had not thought of, and one the document styled into a
    // block, which no list can see at all.
    const blocks: [string, number, string][] = [
      ["Written by the platform team.", 4, "An address is a block."],
      ["Retry budget, in seconds.", 6, "A fieldset is a block."],
      ["Styled into a block by the document itself.", 8, "A styled span is a block."],
    ];
    for (const [text, line, body] of blocks) {
      const target = frame.getByText(text);
      // Hover first: the affordance and the click have to agree about which element this is,
      // which they now do by construction - the bridge marks the element it would resolve.
      await target.hover();
      await target.click();
      await writeComment(page, `line ${line}`, body);
    }

    // A `dialog` with no `open` computes to `display:none`. It is in the source and in the
    // tree, and it is not a block anybody can see, so it is not a target.
    await expect(frame.getByText("Never shown, never commentable.")).toBeHidden();

    // An OPEN dialog is a block, in its own document for the reason recorded on the fixture.
    await choose(page, HTML_DIALOG);
    const dialogFrame = page.frameLocator("iframe.html-preview");
    await dialogFrame.getByText("The deploy is still running.").click();
    await writeComment(page, "line 4", "An open dialog is a block.");

    await expect
      .poll(() => storedThreads(daemon).length, { message: "every block anchored" })
      .toBe(4);
    const stored = storedThreads(daemon);
    expect(stored.map((row) => [row.path, row.start_line, row.surface])).toEqual([
      [HTML_BLOCKS, 4, "html"],
      [HTML_BLOCKS, 6, "html"],
      [HTML_BLOCKS, 8, "html"],
      [HTML_DIALOG, 4, "html"],
    ]);
    // Each quote is the SOURCE line, which is what a later re-anchor searches for.
    expect(stored[0]!.quote).toBe("<address>Written by the platform team.</address>");
    expect(stored[2]!.quote).toBe(
      '<span class="card">Styled into a block by the document itself.</span>',
    );
    expect(stored[3]!.quote).toBe("<dialog open>The deploy is still running.</dialog>");
  });

  test("two blocks with identical text take their own lines, and an entity survives", async ({
    dashboard: page,
    daemon,
  }) => {
    await dispatch(page, daemon);
    const cwd = await sessionCwd(daemon);
    write(cwd, HTML, HTML_SOURCE);
    await useConsoleLayout(page, daemon);
    await openFiles(page);
    await choose(page, HTML);

    const frame = page.frameLocator("iframe.html-preview");
    await startCommenting(page);

    // `Fish & chips, twice.` on screen; `Fish &amp; chips, twice.` in the file.
    await frame.getByText("Fish & chips, twice.").click();
    const entityComposer = page.getByRole("region", { name: "New comment on line 5" });
    await expect(entityComposer.getByText("Fish & chips, twice.", { exact: true })).toBeVisible();
    await expect(entityComposer).not.toContainText("&amp;");
    await writeComment(page, "line 5", "Entities are not the point of this sentence.");

    // The SECOND of two paragraphs that read identically. Position is what tells them apart -
    // there is nothing about the words that could.
    await frame.getByText("The budget is thirty seconds.").nth(1).click();
    await writeComment(page, "line 7", "This one, not the one above it.");

    await expect.poll(() => storedThreads(daemon).length).toBe(2);
    const stored = storedThreads(daemon);
    expect(stored.map((row) => row.start_line)).toEqual([5, 7]);
    expect(stored[0]!.quote).toBe("<p>Fish &amp; chips, twice.</p>");
    expect(stored[1]!.quote).toBe("<p>The budget is thirty seconds.</p>");

    await expectMarkerOnLine(page, 7);
  });

  test("a stale block warning refreshes the file in place", async ({
    dashboard: page,
    daemon,
  }) => {
    await dispatch(page, daemon);
    const cwd = await sessionCwd(daemon);
    write(cwd, HTML, HTML_SOURCE);
    await useConsoleLayout(page, daemon);
    await openFiles(page);
    await choose(page, HTML);

    const frame = page.frameLocator("iframe.html-preview");
    await startCommenting(page);
    await expect(frame.getByText("Read this carefully.")).toBeVisible();

    // The agent rewrites the file underneath the render still on screen. The reported path
    // now names a different element, and there is exactly one honest thing to say about that.
    write(cwd, HTML, ["<body>", "<h1>Rewritten entirely.</h1>", "</body>"].join("\n"));
    await frame.getByText("Read this carefully.").click();

    await expect(page.getByText(/showing an older version of the file/)).toBeVisible();
    await expect(page.getByText(/Reload the preview and try again/)).toBeVisible();
    await shoot(page.locator(".file-main"), page, "html-stale-refusal");
    // Refused, not guessed at: no thread was written on a line nobody pointed to.
    expect(storedThreads(daemon)).toEqual([]);

    // The remedy is next to the warning. It re-reads both the file list and the selected
    // file, rather than making the reader find the toolbar's icon or reopen the tab.
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByText(/showing an older version of the file/)).toBeHidden();
    await expect(frame.getByRole("heading", { name: "Rewritten entirely." })).toBeVisible();
  });

  test("the preview takes no comments while comment mode is off", async ({
    dashboard: page,
    daemon,
  }) => {
    await dispatch(page, daemon);
    const cwd = await sessionCwd(daemon);
    write(cwd, HTML, HTML_SOURCE);
    await useConsoleLayout(page, daemon);
    await openFiles(page);
    await choose(page, HTML);

    // The bridge is inert until the parent arms it, so this click is an ordinary click on a
    // paragraph: nothing opens, and nothing is written.
    const frame = page.frameLocator("iframe.html-preview");
    await frame.getByText("Read this carefully.").click();
    await expect(page.getByRole("textbox", { name: /^Comment on line/ })).toHaveCount(0);
    expect(storedThreads(daemon)).toEqual([]);
  });

  test("the panel docks over the preview instead of opening a source column", async ({
    dashboard: page,
    daemon,
  }) => {
    // The whole pane stays the rendered document. Comment mode used to take 48% of it for a
    // read-only source column to hold the composer, which was showing a second copy of the
    // range and quote the composer prints in its own header.
    await dispatch(page, daemon);
    const cwd = await sessionCwd(daemon);
    write(cwd, HTML, HTML_SOURCE);
    await useConsoleLayout(page, daemon);
    await openFiles(page);
    await choose(page, HTML);

    await startCommenting(page);
    await expect(page.getByLabel(`Editor for ${HTML}`)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Preview", exact: true }))
      .toHaveAttribute("aria-pressed", "true");

    const frame = page.frameLocator("iframe.html-preview");
    await frame.getByText("Read this carefully.").click();
    await expect(page.getByRole("region", { name: "New comment on line 4" })).toBeVisible();
    // Still no editor: the panel is docked over the preview, not hosted in a column.
    await expect(page.getByLabel(`Editor for ${HTML}`)).toHaveCount(0);
    // The dock carries the anchor itself, which is the job the source column was doing.
    await expect(
      page.getByRole("region", { name: "New comment on line 4" })
        .getByText("Read this carefully.", { exact: true }),
    ).toBeVisible();
    // The whole pane, so the photograph carries what the assertions above just proved: the
    // toolbar with Preview pressed, the rendered document at full width, no source column,
    // and the composer docked over it.
    await shoot(page.locator(".file-main"), page, "html-new-comment-dock");

    // Typed into, because an empty box is not proof that it takes a comment.
    await page.getByRole("textbox", { name: "Comment on line 4" }).fill(HTML_COMMENT);
    await shoot(page.locator(".file-main"), page, "html-new-comment-dock-typed");
  });

  test("a block far below the source's first screen still opens a composer on screen", async ({
    dashboard: page,
    daemon,
  }) => {
    /*
     * The reported bug, as a document rather than as a mechanism.
     *
     * Clicking the first thing you can see in a generated report anchors to line 210. Every
     * other spec in this file uses a fixture short enough that the anchored line is on screen
     * whatever happens, so none of them could ever have caught this.
     */
    await dispatch(page, daemon);
    const cwd = await sessionCwd(daemon);
    write(cwd, HTML_LONG, HTML_LONG_SOURCE);
    await useConsoleLayout(page, daemon);
    await openFiles(page);
    await choose(page, HTML_LONG);

    const frame = page.frameLocator("iframe.html-preview");
    await startCommenting(page);
    await frame.getByText("Pi is a capable terminal harness").click();

    // VISIBLE, not merely present. The failure this covers is a composer that opened
    // correctly, on the correct line, somewhere nobody could see it.
    const box = page.getByRole("textbox", { name: "Comment on line 210" });
    await expect(box).toBeVisible();
    await shoot(page.locator(".file-content"), page, "html-long-composer");
    await box.fill(LONG_COMMENT);
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(box).toBeHidden();

    await expect.poll(() => storedThreads(daemon).length).toBe(1);
    const stored = storedThreads(daemon)[0]!;
    expect([stored.path, stored.start_line, stored.surface]).toEqual([HTML_LONG, 210, "html"]);
    expect(stored.quote).toBe("<h1>Pi is a capable terminal harness</h1>");

    /*
     * Read back through the Review queue to keep its cross-file navigation covered. The
     * Comments rail and repeated block click are the file-local routes. `expectMarkerOnLine`
     * would assert nothing useful here: the marker is an inline widget at line 210, the Editor
     * opens at line 1, and CodeMirror builds DOM only for its rendered viewport.
     */
    await page.getByRole("button", { name: "Review queue" }).click();
    await page
      .getByRole("region", { name: "Review queue" })
      .getByRole("button", { name: new RegExp(`^Open comment MC-\\w+ on ${HTML_LONG} line 210$`) })
      .click();
    await expect(page.getByRole("region", { name: /^Comment MC-\w+ on line 210$/ }))
      .toContainText(LONG_COMMENT);
  });

  test("a block holding an unsubmitted draft reopens it with its text intact", async ({
    dashboard: page,
    daemon,
  }) => {
    /* A draft uses the same direct reopen path as a submitted thread, and must keep the
       half-written text that was persisted before the reader moved to another block. */
    await dispatch(page, daemon);
    const cwd = await sessionCwd(daemon);
    write(cwd, HTML, HTML_SOURCE);
    await useConsoleLayout(page, daemon);
    await openFiles(page);
    await choose(page, HTML);

    const frame = page.frameLocator("iframe.html-preview");
    await startCommenting(page);

    // Start one and leave it unsubmitted: it is a durable row from the first keystroke.
    await frame.getByText("Read this carefully.").click();
    await page.getByRole("textbox", { name: "Comment on line 4" }).fill(DRAFT_COMMENT);
    await expect.poll(() => storedThreads(daemon).length, {
      message: "the draft was never written",
    }).toBe(1);
    expect(storedThreads(daemon)[0]!.body).toBe(DRAFT_COMMENT);

    // Point somewhere else, which settles the draft and opens a composer on the new block.
    await frame.getByText("Fish & chips, twice.").click();
    await expect(page.getByRole("textbox", { name: "Comment on line 5" })).toBeVisible();

    // Back to the first block: reopened directly, with what was typed still in it.
    await frame.getByText("Read this carefully.").click();
    const reopened = page.getByRole("textbox", { name: "Comment on line 4" });
    await expect(reopened).toBeVisible();
    await expect(reopened).toHaveValue(DRAFT_COMMENT);
    expect(storedThreads(daemon)).toHaveLength(1);

    // And it can still be finished, which is the whole point of it staying reachable.
    await reopened.fill(HTML_COMMENT);
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(reopened).toBeHidden();
    await expect
      .poll(() => storedThreads(daemon).find((row) => row.start_line === 4)?.body)
      .toBe(HTML_COMMENT);
  });

  test("a commented block in HTML Preview reopens its thread without duplicating it", async ({
    dashboard: page,
    daemon,
  }) => {
    /* The Comments rail supplies the visible index an opaque HTML Preview cannot draw into.
       Pointing at a block already in that index opens its thread in the dock for follow-up. */
    await dispatch(page, daemon);
    const cwd = await sessionCwd(daemon);
    write(cwd, HTML, HTML_SOURCE);
    await useConsoleLayout(page, daemon);
    await openFiles(page);
    await choose(page, HTML);

    const frame = page.frameLocator("iframe.html-preview");
    await startCommenting(page);
    await frame.getByText("Read this carefully.").click();
    await writeComment(page, "line 4", HTML_COMMENT);
    await expect.poll(() => storedThreads(daemon).length).toBe(1);

    // The same block again opens the existing thread, never a second composer.
    await frame.getByText("Read this carefully.").click();
    const existing = page.getByRole("region", { name: /^Comment MC-\w+ on line 4$/ });
    await expect(existing).toContainText(HTML_COMMENT);
    await expect(existing.getByPlaceholder("Reply…")).toBeVisible();
    await expect(page.getByRole("region", { name: "New comment on line 4" })).toHaveCount(0);
    await shoot(page.locator(".file-main"), page, "html-existing-comment-thread");
    expect(storedThreads(daemon)).toHaveLength(1);
  });
});
