import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { FrameLocator, Page } from "@playwright/test";

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
    <p id="second">The budget is bounded here too.</p>
    <p>paired alpha</p><p>paired beta</p>
  </section>
</body></html>
`;

/*
 * The counting fixture, and the count IS the claim.
 *
 * `smuggled` appears exactly THREE times where a reader can see it, and eight times where they
 * cannot. Every one of the invisible eight is an ordinary text node or an attribute value, so
 * a naive text-node walk would report eleven - which is the defect this document exists to
 * catch. An attribute-only case cannot expose it, because an attribute value is not a text node
 * and a naive walk already reports zero for one.
 *
 * The THIRD visible one is the case that catches the opposite defect, and it is the reason the
 * `visibility: hidden` div has two children. `visibility` inherits, so a descendant may set
 * `visibility: visible` and be on screen inside a hidden subtree - which means a walk that
 * treats a hidden element as terminal cannot find it however carefully it asks about the
 * element it did reach. `#reasserted` is that paragraph; the sibling above it is the hidden
 * text that must still not be counted. Both live in the same subtree on purpose: only a gate
 * asked at every level gets both answers right.
 *
 * The three run cases are separate words so a count for one cannot be read off another:
 *
 * - `joinme` split by inline markup, which a reader sees as ONE word;
 * - `gapme` split by a `visibility: hidden` span, which leaves a visible gap on screen, so it
 *   must NOT join - and the hidden span's own text is not countable either;
 * - `brme` split by a `br`, a line break with no text node of its own.
 *
 * The `style` element sits in the BODY on purpose: that is where `inlinePreviewStyles` puts an
 * inlined checkout stylesheet, so a head-only skip list would miss it.
 */
const COUNTED_HTML = `<!doctype html>
<html>
<head>
  <title>smuggled in the title</title>
</head>
<body>
  <p id="visible-one" data-note="smuggled in an attribute">First visible smuggled word.</p>
  <style>/* smuggled in a body stylesheet */ .smuggled-rule { color: red }</style>
  <script>const smuggled = "smuggled in a script";</script>
  <template><p>smuggled in a template</p></template>
  <noscript>smuggled in a noscript</noscript>
  <div style="display: none"><p>smuggled while display none</p></div>
  <div style="visibility: hidden">
    <p>smuggled while visibility hidden</p>
    <p id="reasserted" style="visibility: visible">Third visible smuggled word.</p>
  </div>
  <p id="visible-two">Second visible smuggled word.</p>
  <p id="joined">joi<strong>nme</strong> together</p>
  <p id="gapped">gap<span style="visibility: hidden">gapme hidden</span>me apart</p>
  <p id="broken">br<br>me apart</p>
</body></html>
`;

const PLAN = "docs/plans/reconnect/plan.md";
const REPORT = "docs/reports/reconnect/report.html";
const COUNTED = "docs/reports/reconnect/counted.html";

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
  writeFileSync(join(cwd, COUNTED), COUNTED_HTML);

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

/*
 * ---- find INSIDE the sandboxed HTML preview ----
 *
 * The preview is a separate browsing context this origin cannot read, so everything below is
 * asserted through the frame's own scripting surface: `CSS.highlights` for what was painted,
 * and `Range.toString()` for which words. That is the only place the claim can be checked -
 * the parent has no access to the document, and a unit test has no layout, so
 * `checkVisibility` and `getClientRects` have nothing to answer.
 */

/** What the frame has actually highlighted, read out of its own highlight registry. */
async function highlighted(frame: FrameLocator): Promise<{
  count: number;
  current: string[];
  rest: string[];
}> {
  return frame.locator("body").evaluate(() => {
    const registry = (CSS as unknown as {
      highlights?: Map<string, Iterable<Range>>;
    }).highlights;
    const read = (name: string): string[] => {
      const found = registry?.get(name);
      return found ? [...found].map((range) => range.toString()) : [];
    };
    const current = read("mission-find-current");
    const rest = read("mission-find");
    return { count: current.length + rest.length, current, rest };
  });
}

async function openReport(page: Page, path: string, heading: RegExp): Promise<FrameLocator> {
  await page
    .getByRole("listbox", { name: "Session files" })
    .getByRole("option", { name: path })
    .click();
  const frame = page.frameLocator(`iframe[title="Preview of ${path}"]`);
  await expect(frame.locator("body")).toBeVisible();
  await expect(frame.locator("body")).toHaveText(heading);
  return frame;
}

test("find in an HTML preview marks the words a reader can see, and counts only those", async ({
  dashboard,
  daemon,
}) => {
  /*
   * The whole promise of the in-frame bridge, on a document built to break a naive one - in
   * both directions.
   *
   * `smuggled` sits in the title, an attribute, a BODY stylesheet, a script, a template, a
   * noscript, a `display: none` subtree and a `visibility: hidden` paragraph - eight places a
   * reader cannot see it, and all but the attribute are ordinary text nodes. Three occurrences
   * are visible, and one of those three is a paragraph that re-asserts `visibility: visible`
   * INSIDE the hidden subtree. A text-node walk reports eleven; a walk that stops at the hidden
   * div reports two. Only a rendered-text walk asked at every level reports three, and the
   * number the bar shows must equal the number of things highlighted.
   */
  await openFilesTab(dashboard, daemon);
  const frame = await openReport(dashboard, COUNTED, /First visible smuggled word/);

  await dashboard.keyboard.press("Meta+f");
  await searchbox(dashboard).fill("smuggled");
  await expect(readout(dashboard)).toHaveText("1 / 3");
  // The bar no longer caveats an HTML count, because the count is no longer taken over source.
  await expect(dashboard.locator(".file-content .find-bar .find-note")).toHaveCount(0);

  await expect.poll(async () => (await highlighted(frame)).count).toBe(3);
  const first = await highlighted(frame);
  // Exactly one current hit, and the other two are the plain weight.
  expect(first.current).toEqual(["smuggled"]);
  expect(first.rest).toEqual(["smuggled", "smuggled"]);
  /*
   * WHICH occurrences, proved by where the highlights sit rather than by their text.
   *
   * All three are the same eight characters, so comparing strings cannot tell them apart or
   * tell the ring apart. The frame reports the paragraph each range starts in, which can - and
   * that is also the only way to state the negative: the hidden sibling of `#reasserted` is
   * absent from this list, and it would be present in a walk without the visibility gate.
   */
  const holderOf = async (): Promise<string | null> => frame.locator("body").evaluate(() => {
    const registry = (CSS as unknown as {
      highlights?: Map<string, Iterable<Range>>;
    }).highlights;
    const found = registry?.get("mission-find-current");
    const range = found ? [...found][0] : undefined;
    return range?.startContainer.parentElement?.closest("p")?.id ?? null;
  });
  const ring: (string | null)[] = [];
  for (let step = 0; step !== 3; step++) {
    await expect(readout(dashboard)).toHaveText(`${step + 1} / 3`);
    ring.push(await holderOf());
    expect((await highlighted(frame)).current).toHaveLength(1);
    if (step === 1) await shoot(dashboard, "html-in-frame-highlight");
    await dashboard.keyboard.press("Enter");
  }
  /*
   * Document order, and every id names a paragraph a reader can see.
   *
   * `#reasserted` between them is the assertion that a hidden subtree is DESCENDED into rather
   * than skipped; its unnamed hidden sibling never appears, which is the assertion that
   * descending did not cost the gate.
   */
  expect(ring).toEqual(["visible-one", "reasserted", "visible-two"]);
  // The ring wrapped to the top on the last press of that loop.
  await expect(readout(dashboard)).toHaveText("1 / 3");
  await expect.poll(holderOf).toBe("visible-one");

  /*
   * The document's own script still never runs.
   *
   * `allow-scripts` runs the four hashed bridges and nothing else, and adding a fourth hash
   * must not have widened that. The fixture's script would have declared `smuggled` as a
   * global if the hash allowlist had let it.
   */
  const ranAnything = await frame.locator("body").evaluate(
    () => "smuggled" in (globalThis as unknown as Record<string, unknown>),
  );
  expect(ranAnything, "the previewed document's own script executed").toBe(false);

  // Closing find clears the highlight outright - which the block reveal's outline could not do.
  await dashboard.keyboard.press("Escape");
  await expect(searchbox(dashboard)).toHaveCount(0);
  await expect.poll(async () => (await highlighted(frame)).count).toBe(0);
});

test("a run is joined across inline markup and broken at every visible separation", async ({
  dashboard,
  daemon,
}) => {
  /*
   * Two failures with the same shape and opposite signs, and only a browser can tell them
   * apart. Matching node by node misses `joi<strong>nme</strong>`, which a reader sees as one
   * word. Joining by block over-reaches the other way: a `visibility: hidden` span leaves a
   * visible gap and a `br` is a rendered line break, so neither may be read across.
   */
  await openFilesTab(dashboard, daemon);
  const frame = await openReport(dashboard, COUNTED, /together/);

  await dashboard.keyboard.press("Meta+f");
  await searchbox(dashboard).fill("joinme");
  await expect(readout(dashboard)).toHaveText("1 / 1");
  // ONE hit, and it is highlighted WHOLE - a Range spans the element boundary natively, so the
  // count is logical hits rather than the fragments the API paints.
  await expect.poll(async () => (await highlighted(frame)).count).toBe(1);
  expect((await highlighted(frame)).current).toEqual(["joinme"]);

  // A visible gap is not a join, and the hidden span's own copy is not countable either.
  await searchbox(dashboard).fill("gapme");
  await expect(readout(dashboard)).toHaveText("No results");
  await expect.poll(async () => (await highlighted(frame)).count).toBe(0);

  // A rendered line break separates as firmly as a paragraph does, and it has no text node of
  // its own for a walk to notice.
  await searchbox(dashboard).fill("brme");
  await expect(readout(dashboard)).toHaveText("No results");
  await expect.poll(async () => (await highlighted(frame)).count).toBe(0);
});

test("Cmd+F works with focus inside the preview, which cannot reach the parent as a keystroke", async ({
  dashboard,
  daemon,
}) => {
  /*
   * Finding 4 of the phase, end to end. A sandbox is a separate browsing context, so its
   * keydown never bubbles to the dashboard - and the scroll bridge forwards only Tab and
   * Escape. The find bridge cancels the chord and posts it, and the workspace validates the
   * sender before opening a UI surface with it.
   */
  await openFilesTab(dashboard, daemon);
  const frame = await openReport(dashboard, REPORT, /SSE reconnect audit/);

  // Focus really is inside the frame: the click lands on the frame's own document.
  await frame.locator("h1").click();
  expect(await frame.locator("body").evaluate(
    () => document.hasFocus(),
  )).toBe(true);
  await expect(searchbox(dashboard)).toHaveCount(0);

  await dashboard.keyboard.press("ControlOrMeta+f");
  await expect(searchbox(dashboard)).toBeFocused();
  await searchbox(dashboard).fill("budget is bounded");
  await expect(readout(dashboard)).toHaveText("1 / 2");
  await expect.poll(async () => (await highlighted(frame)).count).toBe(2);
  await shoot(dashboard, "html-chord-from-inside-frame");

  // Escape from inside the frame closes find rather than handing focus to the file list, which
  // is what the keyboard bridge's exit means while find is the innermost thing open.
  await frame.locator("h1").click();
  await dashboard.keyboard.press("Escape");
  await expect(searchbox(dashboard)).toHaveCount(0);
});

test("a find chord posted by any other frame is ignored", async ({ dashboard, daemon }) => {
  /*
   * The `event.source` check, proved by mutation rather than by reading the code.
   *
   * This message OPENS a UI surface, so an arbitrary sender must not be able to fire it. The
   * baseline is read first - the bar is closed - and the same message is then shown to work
   * from the real frame, so a handler that had simply stopped listening would fail here too.
   */
  await openFilesTab(dashboard, daemon);
  const frame = await openReport(dashboard, REPORT, /SSE reconnect audit/);
  await expect(searchbox(dashboard)).toHaveCount(0);

  // An unrelated frame in the dashboard document, posting the exact message.
  await dashboard.evaluate(() => {
    const other = document.createElement("iframe");
    other.id = "impostor";
    other.srcdoc = "<p>not the preview</p>";
    document.body.append(other);
  });
  await dashboard.waitForFunction(
    () => (document.querySelector("#impostor") as HTMLIFrameElement | null)?.contentWindow != null,
  );
  await dashboard.evaluate(() => {
    (document.querySelector("#impostor") as HTMLIFrameElement).contentWindow!.eval(
      'parent.postMessage({type:"mission:file-preview-find-chord"},"*")',
    );
  });
  // Given a moment to be wrong in.
  await dashboard.waitForTimeout(250);
  await expect(searchbox(dashboard)).toHaveCount(0);

  // And the same message from the preview frame does open it, so the refusal above is the
  // source check and not a listener that never ran.
  await frame.locator("h1").click();
  await dashboard.keyboard.press("ControlOrMeta+f");
  await expect(searchbox(dashboard)).toBeFocused();
});

test("a query typed before the preview loaded highlights by itself, and survives an edit", async ({
  dashboard,
  daemon,
}) => {
  /*
   * The handshake, which is the part with no second chance: the parent cannot know when a
   * `srcdoc` document has finished running its scripts, so a find message posted early reaches
   * a window with no find listener and is lost. The bridge announces its OWN readiness - not
   * the comment bridge's, which is posted by a script that runs before it - and the parent
   * answers with the current state.
   *
   * The same exchange covers the `srcDoc` reload that follows every debounced edit, which
   * destroys the highlight along with the document.
   */
  await openFilesTab(dashboard, daemon);
  // Find open, with a query, on a markdown document - then select the HTML one. The preview
  // has not loaded when the query already exists, which is the ordering that used to lose it.
  await openPlan(dashboard);
  await dashboard.keyboard.press("Meta+f");
  await searchbox(dashboard).fill("budget is bounded");
  await expect(readout(dashboard)).toHaveText("1 / 1");

  const frame = await openReport(dashboard, REPORT, /SSE reconnect audit/);
  // The bar reopens empty for a new document by design, so the query is retyped here; what is
  // being asserted is that the FRAME picks it up without a second keystroke once it is loaded.
  await dashboard.keyboard.press("Meta+f");
  await searchbox(dashboard).fill("budget is bounded");
  await expect(readout(dashboard)).toHaveText("1 / 2");
  await expect.poll(async () => (await highlighted(frame)).count).toBe(2);

  // Step onto the SECOND hit before the reload, so the assertion after it is about the
  // reader's place and not only about the count coming back.
  await dashboard.keyboard.press("Enter");
  await expect(readout(dashboard)).toHaveText("2 / 2");

  /*
   * Now reload the document under the highlight, by editing the file through the Editor.
   *
   * `previewText` is debounced and the `srcDoc` is rebuilt from it, so this really is a fresh
   * document with a fresh bridge that was never told anything. Nothing but the ready handshake
   * brings the highlight back.
   */
  const modes = dashboard.getByRole("group", { name: "File view mode" });
  await modes.getByRole("button", { name: "Editor" }).click();
  const editor = dashboard.getByLabel(`Editor for ${REPORT}`);
  await expect(editor).toBeVisible();
  await editor.click();
  await dashboard.keyboard.press("ControlOrMeta+End");
  await dashboard.keyboard.type("\n<!-- edited -->\n");
  await modes.getByRole("button", { name: "Preview" }).click();

  const reloaded = dashboard.frameLocator(`iframe[title="Preview of ${REPORT}"]`);
  await expect
    .poll(async () => (await highlighted(reloaded)).count, {
      message: "the highlight never came back after the srcDoc reload",
    })
    .toBe(2);
  /*
   * And the reader is still on the hit they had selected.
   *
   * Worth being exact about what this does and does not prove. Leaving Preview for the Editor
   * unmounts the frame, which drops the bridge report and puts the workspace in the
   * source-derived fallback for the round trip - so this asserts the position survives the
   * whole Editor-edit-Preview journey, and it passes with or without `frameFindIndex`'s rule
   * about an unknown count. That rule is pinned in `test/document-find.test.ts`, where the
   * mutation actually fails; its reachable path is a change to the file on disk while Preview
   * stays on screen.
   */
  await expect(readout(dashboard)).toHaveText("2 / 2");
});

test("a frame that cannot highlight keeps the block reveal, its note and its own count", async ({
  dashboard,
  daemon,
}) => {
  /*
   * The one path where Phase 1's behaviour is the finished behaviour rather than a stopgap.
   *
   * Readiness carries CAPABILITY, not a result, and this is why: a frame that cannot register
   * highlights must not answer a matching query with a count of zero, because that leaves the
   * reader no highlight, no block reveal, and a number saying there is nothing to find. The
   * incapacity is declared here by having the frame re-announce itself with `highlight: false`,
   * which is the same message a browser without the API would send - and far more reachable
   * than finding such a browser.
   */
  await openFilesTab(dashboard, daemon);
  const frame = await openReport(dashboard, REPORT, /SSE reconnect audit/);

  await dashboard.keyboard.press("Meta+f");
  await searchbox(dashboard).fill("budget is bounded");
  // In-frame first, so the downgrade below is a change and not the initial state.
  await expect(dashboard.locator(".file-content .find-bar .find-note")).toHaveCount(0);
  await expect.poll(async () => (await highlighted(frame)).count).toBe(2);

  await frame.locator("body").evaluate(() => {
    // A nonce as well as the flag, because a real frame always mints and reports one: the
    // parent refuses a readiness message it cannot attribute to a document, so a fixture
    // without one would be testing the guard rather than the fallback.
    parent.postMessage({
      type: "mission:file-preview-find-ready",
      highlight: false,
      nonce: "cannot-highlight-fixture",
    }, "*");
  });

  // The note is back, the count is the source-derived by-block one, and stepping reveals the
  // block again - all three together, because they are one decision.
  await expect(dashboard.locator(".file-content .find-bar .find-note")).toHaveText("by block");
  await expect(readout(dashboard)).toHaveText("1 / 2");
  const verdict = frame.locator("#verdict");
  await expect(verdict).toHaveClass(/mission-comment-target/);
  await searchbox(dashboard).focus();
  await dashboard.keyboard.press("Enter");
  await expect(readout(dashboard)).toHaveText("2 / 2");
  await expect(frame.locator("#second")).toHaveClass(/mission-comment-target/);
  await expect(verdict).not.toHaveClass(/mission-comment-target/);
  await shoot(dashboard, "html-capability-false-fallback");
});

test("an HTML comment still anchors while a find highlight is active", async ({
  dashboard,
  daemon,
}) => {
  /*
   * The constraint that decided the implementation, asserted rather than trusted.
   *
   * The comment bridge addresses a block by indexing element children from `document.body`,
   * and the daemon resolves that same path against a parse5 tree of the SOURCE. Wrapping
   * matches in `mark` elements would have shifted those indices, so a comment anchored after a
   * highlight would resolve to a neighbour - silently. The Custom Highlight API inserts
   * nothing, and this is what proves the tree the daemon sees is still the tree the frame has.
   */
  await openFilesTab(dashboard, daemon);
  const frame = await openReport(dashboard, COUNTED, /Second visible smuggled word/);

  await dashboard.keyboard.press("Meta+f");
  await searchbox(dashboard).fill("smuggled");
  await expect.poll(async () => (await highlighted(frame)).count).toBe(3);

  // Comment on the paragraph AFTER the first highlight, which is exactly the anchor an
  // inserted element would have shifted.
  await dashboard.getByRole("button", { name: /Comment/i }).first().click();
  await frame.locator("#visible-two").click();
  const composer = dashboard.getByRole("textbox", { name: /comment/i }).first();
  await expect(composer).toBeVisible();
  // The daemon resolved the path against the source and sliced the quote out of it, so the
  // quote proves which element the index landed on.
  await expect(dashboard.locator(".file-comment-dock")).toContainText("Second visible smuggled");
  // And the highlight is still there, unmoved, with comment mode on over it.
  await expect.poll(async () => (await highlighted(frame)).count).toBe(3);
  await shoot(dashboard, "html-comment-with-highlight");
});
