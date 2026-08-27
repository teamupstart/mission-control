import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Page, Request } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

const EVIDENCE = artifactsDir("file-default-view");

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/file-default-view/${name}.png`);
}

function observed(what: string): void {
  if (!process.env.MC_E2E_EVIDENCE) return;
  // eslint-disable-next-line no-console
  console.log(`OBSERVED ${what}`);
}

/**
 * Which view a file OPENS in, per type, and that the preview runs no page script.
 *
 * This is the contract the `html-report` skill is written against: a session finishes an
 * investigation by logging `docs/reports/<slug>/report.html`, and the click on that path
 * has to land on the rendered page rather than on its source, or the report is markup in
 * an editor. The same rule sends every ordinary source file the other way, to the editor,
 * with no view toggle offered at all.
 *
 * Only a browser can assert it. `pathDefaultsToPreview` is a pure function a unit test
 * already covers; what it cannot see is the selection reaching the store, the document
 * arriving with a server-assigned kind that could disagree with the extension, and the
 * pane that renders as a result. The no-JavaScript half is browser-only by construction:
 * the preview's CSP admits two hashed bridge scripts and nothing else, so proving a
 * report's own script never runs means running one.
 */

const TASK = "read a generated report in the files tab";

/** A report shaped like the skill's output, plus a script that must not run. */
const REPORT_HTML = `<!doctype html>
<html><body>
  <section style="height: 100vh">
    <h1>SSE reconnect audit</h1>
    <p id="verdict">Reconnects are bounded</p>
    <a href="#verdict">Jump to the reconnect verdict</a>
    <div contenteditable aria-label="Preview scratchpad"></div>
  </section>
  <section style="height: 100vh">
    <h2>Reconnect details</h2>
    <p>The second page stays readable from the keyboard.</p>
  </section>
  <p>End of report</p>
  <script>document.getElementById("verdict").textContent = "SCRIPT RAN";</script>
</body></html>
`;

const NOTES_MD = `# Reconnect notes

The markdown twin still renders.
`;

const SOURCE_TS = `export const reconnectBudgetMs = 30_000;
`;
const AFTER_MD = `# Later report

This file follows the HTML report in the file list.
`;

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

/** Dispatch, seed one report of each kind, and open the session's Files tab. */
async function openFilesTab(page: Page, daemon: DaemonHandle): Promise<void> {
  await dispatch(page, daemon);
  const cwd = await sessionCwd(daemon);

  // Exactly where the skill puts a report: nested, untracked, and NOT ignored, which is
  // what keeps it in `git ls-files --others --exclude-standard` and therefore in the list.
  mkdirSync(join(cwd, "docs", "reports", "sse-reconnect-audit"), { recursive: true });
  writeFileSync(join(cwd, "docs", "reports", "sse-reconnect-audit", "report.html"), REPORT_HTML);
  writeFileSync(join(cwd, "docs", "reports", "sse-reconnect-audit", "notes.md"), NOTES_MD);
  writeFileSync(
    join(cwd, "docs", "reports", "sse-reconnect-audit", "zz-preview.png"),
    readFileSync(join(process.cwd(), "docs", "images", "foreman.png")),
  );
  writeFileSync(join(cwd, "docs", "reports", "sse-reconnect-audit", "z-later.md"), AFTER_MD);
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src", "reconnect.ts"), SOURCE_TS);

  await useConsoleLayout(page, daemon);

  await page
    .getByRole("navigation", { name: "Sessions" })
    .getByRole("button", { name: /Read a Generated Report/i })
    .click();
  await page
    .getByRole("tablist", { name: "Session detail" })
    .getByRole("tab", { name: /Files$/ })
    .click();
  await expect(page.getByRole("listbox", { name: "Session files" })).toBeVisible();
}

const REPORT = "docs/reports/sse-reconnect-audit/report.html";
const NOTES = "docs/reports/sse-reconnect-audit/notes.md";
const IMAGE = "docs/reports/sse-reconnect-audit/zz-preview.png";
const AFTER = "docs/reports/sse-reconnect-audit/z-later.md";
const SOURCE = "src/reconnect.ts";

test("Preview focus returns to the file list with Shift+Tab or Escape", async ({
  dashboard,
  daemon,
}) => {
  await openFilesTab(dashboard, daemon);
  await dispatch(dashboard, daemon, "keep the session rail out of file preview navigation");

  const rail = dashboard.getByRole("navigation", { name: "Sessions" });
  const reportSession = rail.getByRole("button", { name: /Read a Generated Report/i });
  const neighbour = rail.getByRole("button", {
    name: /Keep the Session Rail Out of File Preview Navigation/i,
  });
  await expect(neighbour).toBeVisible();

  // Put real DOM focus back on the session rail while leaving its Files tab open. This is
  // the reported boundary: before the fix, the next arrow selected the neighbouring session.
  await reportSession.click();
  await expect(reportSession).toBeFocused();
  await expect(
    dashboard
      .getByRole("tablist", { name: "Session detail" })
      .getByRole("tab", { name: /Files$/ }),
  ).toHaveAttribute("aria-selected", "true");
  const rows = rail.locator("button.rail-row");
  const selectedIndex = await rows.evaluateAll((elements) =>
    elements.findIndex((element) => element.getAttribute("aria-current") === "true")
  );
  const lastIndex = (await rows.count()) - 1;
  const direction = selectedIndex < lastIndex ? "ArrowDown" : "ArrowUp";

  // A previewable file exists on each side of REPORT, so either rail-safe direction lands
  // on the same HTML target and proves file order rather than session order owns the key.
  const files = dashboard.getByRole("listbox", { name: "Session files" });
  const startPath = direction === "ArrowDown" ? NOTES : AFTER;
  const startFile = files.getByRole("option", { name: startPath });
  await startFile.click();
  await expect(startFile).toHaveAttribute("aria-selected", "true");
  await expect(dashboard.getByLabel(`Preview of ${startPath}`)).toBeVisible();
  await reportSession.click();
  await expect(reportSession).toBeFocused();
  await dashboard.keyboard.press(direction);

  const selectedReport = files.getByRole("option", { name: REPORT });
  await expect(selectedReport).toHaveAttribute("aria-selected", "true");
  await expect(selectedReport).toBeFocused();
  await expect(reportSession).toHaveAttribute("aria-current", "true");
  await expect(neighbour).toHaveAttribute("aria-current", "false");

  // Tab crosses the inner Files split, from its file cursor to the rendered document.
  const frame = dashboard.locator(`iframe[title="Preview of ${REPORT}"]`);
  await expect(frame).toBeVisible();
  await dashboard.keyboard.press("Tab");
  await expect(frame).toBeFocused();
  await shoot(dashboard, "preview-keyboard-focus");

  const report = dashboard.frameLocator(`iframe[title="Preview of ${REPORT}"]`);
  const body = report.locator("body");
  expect(await body.evaluate(() => window.scrollY)).toBe(0);

  // Tab is structural navigation here, not a way to walk links inside an arbitrary report.
  await dashboard.keyboard.press("Tab");
  await expect(frame).toBeFocused();
  expect(await body.evaluate(() => document.activeElement?.tagName)).toBe("BODY");

  // Once entered, the same page keys work inside the sandboxed browsing context.
  await dashboard.keyboard.press("d");
  await expect.poll(() => body.evaluate(() => window.scrollY)).toBeGreaterThan(0);

  await dashboard.keyboard.press("Shift+Tab");
  await expect(selectedReport).toBeFocused();
  await dashboard.keyboard.press("Tab");
  await expect(frame).toBeFocused();
  await dashboard.keyboard.press("u");
  await expect.poll(() => body.evaluate(() => window.scrollY)).toBe(0);

  await dashboard.keyboard.press("Escape");
  await expect(selectedReport).toBeFocused();
  await shoot(dashboard, "preview-keyboard-exit");
  await dashboard.keyboard.press("Tab");
  await expect(frame).toBeFocused();
  await expect(selectedReport).toHaveAttribute("aria-selected", "true");
  await expect(reportSession).toHaveAttribute("aria-current", "true");
});

test("Preview u and d paginate a rendered report by one page", async ({
  dashboard,
  daemon,
}) => {
  await openFilesTab(dashboard, daemon);
  await dashboard
    .getByRole("listbox", { name: "Session files" })
    .getByRole("option", { name: REPORT })
    .click();

  const report = dashboard.frameLocator(`iframe[title="Preview of ${REPORT}"]`);
  const body = report.locator("body");
  await expect(report.getByRole("heading", { name: "SSE reconnect audit" })).toBeVisible();
  const pageTargetError = (startY: number, direction: -1 | 1): Promise<number> =>
    body.evaluate((_body, { startY, direction }) => {
      const pageHeight = window.innerHeight;
      const clientHeight = document.scrollingElement?.clientHeight ?? pageHeight;
      const maxY = Math.max(
        0,
        (document.scrollingElement?.scrollHeight ?? clientHeight) - clientHeight,
      );
      const expectedY = Math.min(maxY, Math.max(0, startY + direction * pageHeight));
      return window.scrollY - expectedY;
    }, { startY, direction });
  const beforeDownY = await body.evaluate(() => window.scrollY);
  expect(beforeDownY).toBe(0);

  // The file row still owns focus after selection. Preview mode itself claims the key, so
  // pagination does not require an extra Tab into the rendered document and bare `d` does
  // not fall through to the dashboard's contextual Delete binding.
  await dashboard.keyboard.press("d");
  // Flex layout can resize the iframe by a couple of CSS pixels after it first becomes
  // visible. Assert against the live page height used at the action boundary, not a stale
  // height captured before that layout settles.
  await expect.poll(() => pageTargetError(beforeDownY, 1)).toBe(0);
  await expect(report.getByRole("heading", { name: "Reconnect details" })).toBeVisible();
  await shoot(dashboard, "preview-page-down");

  const beforeUpY = await body.evaluate(() => window.scrollY);
  await dashboard.keyboard.press("u");
  await expect.poll(() => pageTargetError(beforeUpY, -1)).toBe(0);
  await expect(report.getByRole("heading", { name: "SSE reconnect audit" })).toBeVisible();
  await shoot(dashboard, "preview-page-up");
});

test("Preview page keys stand down in a bare contenteditable field", async ({
  dashboard,
  daemon,
}) => {
  await openFilesTab(dashboard, daemon);
  await dashboard
    .getByRole("listbox", { name: "Session files" })
    .getByRole("option", { name: REPORT })
    .click();

  const report = dashboard.frameLocator(`iframe[title="Preview of ${REPORT}"]`);
  const body = report.locator("body");
  const scratchpad = report.locator('[contenteditable][aria-label="Preview scratchpad"]');
  await scratchpad.focus();
  await expect(scratchpad).toBeFocused();
  await dashboard.keyboard.press("d");

  await expect(scratchpad).toHaveText("d");
  expect(await body.evaluate(() => window.scrollY)).toBe(0);
});

test("an HTML report opens rendered, and its source only on request", async ({
  dashboard,
  daemon,
}) => {
  await openFilesTab(dashboard, daemon);

  await dashboard
    .getByRole("listbox", { name: "Session files" })
    .getByRole("option", { name: REPORT })
    .click();

  // Rendered, with no click on the toggle to get there.
  const report = dashboard.frameLocator(`iframe[title="Preview of ${REPORT}"]`);
  await expect(report.getByRole("heading", { name: "SSE reconnect audit" })).toBeVisible();
  const modes = dashboard.getByRole("group", { name: "File view mode" });
  await expect(modes.getByRole("button", { name: "Preview" })).toHaveAttribute("aria-pressed", "true");
  await expect(modes.getByRole("button", { name: "Editor" })).toHaveAttribute("aria-pressed", "false");
  observed(`${REPORT} opened in Preview without the toggle being touched`);
  await shoot(dashboard, "html-report-opens-rendered");

  // The report's own script did not run - the reason the skill forbids one. A page that
  // assembles itself at runtime is blank in the pane it was written for.
  await expect(report.getByText("Reconnects are bounded")).toBeVisible();
  await expect(report.getByText("SCRIPT RAN")).toHaveCount(0);

  // Preview is the default, not the only view: the source is one click away.
  await modes.getByRole("button", { name: "Editor" }).click();
  await expect(dashboard.getByLabel(`Editor for ${REPORT}`)).toContainText("SSE reconnect audit");
  await expect(modes.getByRole("button", { name: "Editor" })).toHaveAttribute("aria-pressed", "true");
});

test("a narrow Files toolbar keeps both modes and every action visible", async ({
  dashboard,
  daemon,
}) => {
  await openFilesTab(dashboard, daemon);
  await dashboard
    .getByRole("listbox", { name: "Session files" })
    .getByRole("option", { name: REPORT })
    .click();
  const toolbar = dashboard.locator(".file-main > .file-toolbar");
  const modes = toolbar.getByRole("group", { name: "File view mode" });
  const controls = [
    modes.getByRole("button", { name: "Preview" }),
    modes.getByRole("button", { name: "Editor" }),
    toolbar.getByRole("button", { name: "Comment mode" }),
    toolbar.getByRole("button", { name: "Comments" }),
    toolbar.getByRole("button", { name: /^Open in/ }),
    toolbar.getByRole("button", { name: "Extract files window" }),
  ];

  // The reported transition is an already-open Files tab becoming narrower, so resize only
  // after navigation. Check both the reported boundary and the compact layout below it: the
  // filename may keep yielding, but the view toggle may never become the sacrificial flex item.
  const observations = [];
  for (const width of [760, 640]) {
    await dashboard.setViewportSize({ width, height: 800 });
    const toolbarBox = await toolbar.boundingBox();
    expect(toolbarBox).not.toBeNull();
    const modeBox = await modes.boundingBox();
    expect(modeBox).not.toBeNull();
    const edges = [];
    for (const control of controls) {
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      edges.push({
        name: await control.getAttribute("aria-label") ?? await control.innerText(),
        left: Math.round(box!.x),
        right: Math.round(box!.x + box!.width),
      });
      expect(box!.x).toBeGreaterThanOrEqual(toolbarBox!.x);
      expect(box!.x + box!.width).toBeLessThanOrEqual(toolbarBox!.x + toolbarBox!.width);
    }
    const editorBox = await controls[1]!.boundingBox();
    expect(editorBox!.x + editorBox!.width).toBeLessThanOrEqual(modeBox!.x + modeBox!.width);
    observations.push({ width, edges });
  }

  observed(`narrow Files toolbar kept all controls in frame: ${JSON.stringify(observations)}`);
  await shoot(dashboard, "narrow-files-toolbar");
});

test("a PNG opens as a fitted, read-only image preview", async ({ dashboard, daemon }) => {
  await openFilesTab(dashboard, daemon);
  const files = dashboard.getByRole("listbox", { name: "Session files" });

  // Reproduce the cross-file transition: source puts the shared workspace mode in Editor,
  // then the raster load must normalize it because a PNG has no Editor fallback.
  await files.getByRole("option", { name: SOURCE }).click();
  await expect(dashboard.getByLabel(`Editor for ${SOURCE}`)).toContainText("reconnectBudgetMs");
  await files.getByRole("option", { name: IMAGE }).click();

  const preview = dashboard.getByLabel(`Preview of ${IMAGE}`);
  const image = preview.getByRole("img", { name: IMAGE });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  await expect(image).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect.poll(() => image.evaluate((element) => getComputedStyle(element).objectFit))
    .toBe("contain");

  const modes = dashboard.getByRole("group", { name: "File view mode" });
  await expect(modes.getByRole("button", { name: "Preview" })).toHaveAttribute("aria-pressed", "true");
  await expect(modes.getByRole("button", { name: "Editor" })).toBeDisabled();
  await expect(dashboard.getByText("Read only", { exact: true })).toBeVisible();
  await shoot(dashboard, "png-opens-in-preview");
});

test("bare e and p switch modes only in the integrated Files tab", async ({
  dashboard,
  daemon,
}) => {
  await openFilesTab(dashboard, daemon);
  const selectedReport = dashboard
    .getByRole("listbox", { name: "Session files" })
    .getByRole("option", { name: REPORT });
  await selectedReport.click();

  const modes = dashboard.getByRole("group", { name: "File view mode" });
  const orderedModes: (string | null)[] = [];
  await modes.locator('button[aria-label="Preview"][aria-pressed="true"]').waitFor();
  await dashboard.keyboard.press("e");
  const editor = modes.locator('button[aria-label="Editor"][aria-pressed="true"]');
  await editor.waitFor();
  orderedModes.push(await editor.getAttribute("aria-label"));
  let paneFocusRequests = 0;
  const countPaneFocusRequest = (request: Request) => {
    if (/^\/api\/sessions\/[^/]+\/focus$/.test(new URL(request.url()).pathname)) {
      paneFocusRequests += 1;
    }
  };
  dashboard.on("request", countPaneFocusRequest);
  await dashboard.keyboard.press("p");
  const preview = modes.locator('button[aria-label="Preview"][aria-pressed="true"]');
  await preview.waitFor();
  orderedModes.push(await preview.getAttribute("aria-label"));
  dashboard.off("request", countPaneFocusRequest);
  const integratedHints = await modes.locator("kbd.kb-hint").allTextContents();
  await shoot(dashboard, "file-mode-shortcuts");

  await dashboard.getByRole("button", { name: "Extract files window" }).click();
  const extracted = dashboard.getByRole("dialog", { name: /Files for / });
  const extractedModes = extracted.getByRole("group", { name: "File view mode" });
  await extractedModes.locator('button[aria-label="Preview"][aria-pressed="true"]').waitFor();
  await dashboard.keyboard.press("e");
  await dashboard.waitForTimeout(50);
  const extractedMode = await extractedModes.locator('[aria-pressed="true"]').getAttribute("aria-label");

  expect({
    orderedModes,
    integratedHints,
    paneFocusRequests,
    extractedMode,
    extractedShortcuts: await extractedModes.locator("[aria-keyshortcuts]").count(),
    extractedHints: await extractedModes.locator("kbd.kb-hint").count(),
  }).toEqual({
    orderedModes: ["Editor", "Preview"],
    integratedHints: ["p", "e"],
    paneFocusRequests: 0,
    extractedMode: "Preview",
    extractedShortcuts: 0,
    extractedHints: 0,
  });
});

test("bare e and p remain available inside every valid contenteditable host", async ({
  dashboard,
  daemon,
}) => {
  await openFilesTab(dashboard, daemon);
  await dashboard
    .getByRole("listbox", { name: "Session files" })
    .getByRole("option", { name: REPORT })
    .click();

  const modes = dashboard.getByRole("group", { name: "File view mode" });
  await modes.locator('button[aria-label="Preview"][aria-pressed="true"]').waitFor();
  await dashboard.evaluate(() => {
    for (const [label, value] of [
      ["Empty contenteditable host", ""],
      ["Plaintext contenteditable host", "plaintext-only"],
    ]) {
      const host = document.createElement("div");
      host.setAttribute("aria-label", label);
      host.setAttribute("contenteditable", value);
      host.addEventListener("keydown", (event) => {
        host.dataset.receivedKeys = `${host.dataset.receivedKeys ?? ""}${event.key}`;
      });
      document.body.append(host);
    }
  });

  const observations = [];
  for (const label of ["Empty contenteditable host", "Plaintext contenteditable host"]) {
    const host = dashboard.locator(`[aria-label="${label}"]`);
    await host.focus();
    await dashboard.keyboard.press("e");
    const modeAfterE = await modes.locator('[aria-pressed="true"]').getAttribute("aria-label");
    await dashboard.keyboard.press("p");
    observations.push({
      label,
      modeAfterE,
      modeAfterP: await modes.locator('[aria-pressed="true"]').getAttribute("aria-label"),
      receivedKeys: await host.getAttribute("data-received-keys"),
      text: await host.textContent(),
      focused: await host.evaluate((element) => document.activeElement === element),
    });
  }

  expect(observations).toEqual([
    {
      label: "Empty contenteditable host",
      modeAfterE: "Preview",
      modeAfterP: "Preview",
      receivedKeys: "ep",
      text: "ep",
      focused: true,
    },
    {
      label: "Plaintext contenteditable host",
      modeAfterE: "Preview",
      modeAfterP: "Preview",
      receivedKeys: "ep",
      text: "ep",
      focused: true,
    },
  ]);
});

test("an oversized preview does not advertise or act on the unavailable Editor shortcut", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon, "preview a large generated report");
  const cwd = await sessionCwd(daemon);
  const largeReport = "docs/reports/large-generated-report/report.html";
  mkdirSync(join(cwd, "docs", "reports", "large-generated-report"), { recursive: true });
  writeFileSync(
    join(cwd, largeReport),
    `<!doctype html><html><body><h1>Large generated report</h1><!--${"x".repeat(2 * 1024 * 1024)}--></body></html>`
  );

  await useConsoleLayout(dashboard, daemon);
  await dashboard
    .getByRole("navigation", { name: "Sessions" })
    .getByRole("button", { name: /Preview a Large Generated Report/i })
    .click();
  await dashboard
    .getByRole("tablist", { name: "Session detail" })
    .getByRole("tab", { name: /Files$/ })
    .click();
  const files = dashboard.getByRole("listbox", { name: "Session files" });
  await files.waitFor();
  await files.getByRole("option", { name: largeReport }).click();

  const report = dashboard.frameLocator(`iframe[title="Preview of ${largeReport}"]`);
  const heading = report.getByRole("heading", { name: "Large generated report" });
  await heading.waitFor();
  const modes = dashboard.getByRole("group", { name: "File view mode" });
  const preview = modes.getByRole("button", { name: "Preview" });
  const editor = modes.getByRole("button", { name: "Editor" });
  await editor.waitFor();
  await dashboard.keyboard.press("e");
  await dashboard.waitForTimeout(50);

  expect({
    rendered: await heading.isVisible(),
    editorDisabled: await editor.isDisabled(),
    editorShortcut: await editor.getAttribute("aria-keyshortcuts"),
    editorKeycapCount: await editor.locator("kbd.kb-hint").count(),
    activeModeAfterE: await modes.locator('[aria-pressed="true"]').getAttribute("aria-label"),
    previewPressed: await preview.getAttribute("aria-pressed"),
  }).toEqual({
    rendered: true,
    editorDisabled: true,
    editorShortcut: null,
    editorKeycapCount: 0,
    activeModeAfterE: "Preview",
    previewPressed: "true",
  });
});

test("source opens in the editor, with no view to toggle to", async ({ dashboard, daemon }) => {
  await openFilesTab(dashboard, daemon);
  const files = dashboard.getByRole("listbox", { name: "Session files" });
  const modes = dashboard.getByRole("group", { name: "File view mode" });

  // Markdown first, both because it is the other previewable kind and because the toggle
  // has to be PRESENT before its absence below means anything.
  await files.getByRole("option", { name: NOTES }).click();
  await expect(dashboard.getByRole("heading", { name: "Reconnect notes" })).toBeVisible();
  await expect(modes.getByRole("button", { name: "Preview" })).toHaveAttribute("aria-pressed", "true");
  await expect(dashboard.getByTitle(/^Preview of /)).toHaveCount(0);

  await files.getByRole("option", { name: SOURCE }).click();
  await expect(dashboard.getByLabel(`Editor for ${SOURCE}`)).toContainText("reconnectBudgetMs");
  // Nothing to render, so nothing is offered: the toggle that was there a moment ago is
  // gone rather than sitting there disabled or lying about a preview.
  await expect(modes).toHaveCount(0);
  await expect(dashboard.getByTitle(/^Preview of /)).toHaveCount(0);
  observed(`${SOURCE} opened in the editor with no File view mode group`);
});
