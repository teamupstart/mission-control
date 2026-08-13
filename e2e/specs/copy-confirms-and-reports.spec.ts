import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

const EVIDENCE = artifactsDir("copy-confirms-and-reports");

/**
 * Photograph a state this spec has already asserted on.
 *
 * Inside the regression test rather than in a staged capture, for the reason
 * `line-drawers.spec.ts` gives: the point of the picture is that the assertions around it
 * passed on the same run, so the image and the measurement cannot drift apart.
 */
async function shoot(target: Locator, page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer, and the
  // button being photographed is what the pointer was last over.
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/copy-confirms-and-reports/${name}.png`);
}

/**
 * Every copy control writes through `copyText`, confirms with the same word, and says so when
 * it fails.
 *
 * Three of the four defects this phase fixes are only visible from a browser, and two of them
 * are invisible even here unless the browser is made to behave like the packaged app.
 *
 * `PersonaEditor` and `ReportPanel` called `navigator.clipboard.writeText` directly, so they
 * never reached the selected-textarea fallback that `src/web/lib/clipboard.ts` exists for. In
 * the Electron renderer the async Clipboard API can be permission-blocked even after a direct
 * click, so both copied nothing and said nothing - in the build the whole context-menu plan is
 * about. A unit test cannot see that: the bug is not in a function, it is in which function was
 * called. The tests below stub `navigator.clipboard.writeText` into rejecting, exactly as
 * `workflow-run-audit.spec.ts` already does for the run id, and then prove the text really
 * landed by reading it from a SECOND page in the same context - this page's clipboard object is
 * the rejecting stub and cannot be asked.
 *
 * `ReportPanel` additionally swallowed every error into an empty `catch`, so a daemon answering
 * 500 for `/api/report.md` and a blocked clipboard were indistinguishable and neither produced
 * anything at all. The failure is now a sentence, and only a rendered page can show that.
 *
 * `FileWorkspace`'s "Copy local" is the fourth defect and is covered by
 * `file-conflict-copy-local.spec.ts`, which needs a dispatched session to reach the notice it
 * lives in. `workflow-run-audit.spec.ts` remains the reference for the run-id copy and is
 * deliberately untouched by this phase.
 */

const GUIDANCE = "# Shelf reviewer\n\nJudge the change, and say whether it holds.";

/** What the Electron renderer does when the async Clipboard API is permission-blocked. */
async function refuseTheAsyncClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("Write permission denied.")) },
    });
  });
}

/**
 * Prove the stub above actually installed, after navigating.
 *
 * An init script only runs on a real document load, and `goto` between two hashes of the same
 * origin is a same-document navigation. Get that wrong and the copy simply succeeds through
 * the real clipboard - so the test still passes, while proving nothing about the fallback it
 * exists to cover. Asserted rather than assumed, because a silently vacuous regression test is
 * worse than none.
 */
async function expectTheClipboardToRefuse(page: Page): Promise<void> {
  const refuses = await page.evaluate(async () => {
    try {
      await navigator.clipboard.writeText("probe");
      return false;
    } catch {
      return true;
    }
  });
  expect(refuses, "the rejecting clipboard stub did not install").toBe(true);
}

/**
 * Read the real clipboard from a page that is not the one under test.
 *
 * The page under test may be holding the rejecting stub above, so it cannot read its own
 * clipboard. A second page in the same browser context shares the clipboard and not the stub.
 */
async function clipboardFromASecondPage(page: Page, daemon: DaemonHandle): Promise<string> {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const reader = await page.context().newPage();
  await reader.goto(`${daemon.baseURL}/#/fleet`);
  const text = await reader.evaluate(() => navigator.clipboard.readText());
  await reader.close();
  return text;
}

/**
 * Assert this text is the sitrep digest, without pinning the digest byte for byte.
 *
 * `renderReportMarkdown` stamps a minute-resolution timestamp into its first line, so comparing
 * a clipboard read against a second `fetch` of the same route is a test that fails whenever the
 * two straddle a minute boundary. The seeded task title is what makes this specific: it proves
 * the real report was fetched and copied rather than any fixed string.
 */
function expectTheSitrepDigest(text: string): void {
  expect(text).toContain("# Mission bearings - ");
  expect(text).toContain("Needs you (");
  expect(text).toContain("Recent outcomes (");
  expect(text).toContain(BACKLOG_TITLE);
}

const BACKLOG_TITLE = "audit the reconnect budget";

/** One backlog task, so the digest has something of the operator's in it to recognise. */
async function seedBacklogTask(daemon: DaemonHandle): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // The title is given explicitly so the titler does not rename it out from under the
    // assertion. See backlog-task-delete.spec.ts.
    body: JSON.stringify({
      repoRoot: daemon.repo,
      title: BACKLOG_TITLE,
      intent: BACKLOG_TITLE,
      backlog: true,
    }),
  });
  expect(response.ok, `seeding a backlog task answered ${response.status}`).toBe(true);
}

async function seedPersona(daemon: DaemonHandle): Promise<string> {
  const response = await fetch(`${daemon.baseURL}/api/personas`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Shelf reviewer",
      description: "Reads the diff and says whether it holds.",
      guidanceMarkdown: GUIDANCE,
    }),
  });
  expect(response.ok, `seeding a Persona answered ${response.status}`).toBe(true);
  return ((await response.json()) as { id: string }).id;
}

async function openPersonaEditor(page: Page, daemon: DaemonHandle): Promise<void> {
  const personaId = await seedPersona(daemon);
  await page.goto(`${daemon.baseURL}/#/library/personas/${personaId}`);
  // A real document load, so any init script this test registered installs. See
  // `expectTheClipboardToRefuse`.
  await page.reload();
  await expect(page.locator("section.persona-fields").getByLabel("Name"))
    .toHaveValue("Shelf reviewer");
}

async function openSitrep(page: Page): Promise<void> {
  // The chord is fleet-scoped and only bound once the app has mounted, so a press sent into a
  // page that is still loading is simply dropped.
  await expect(page.getByRole("button", { name: "Dispatch" })).toBeVisible();
  await page.keyboard.press("Shift+P");
  await expect(page.getByRole("heading", { name: "Sitrep" })).toBeVisible();
}

test("the sitrep copy puts the markdown on the clipboard and confirms it", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await seedBacklogTask(daemon);
  await openSitrep(dashboard);

  const panel = dashboard.getByRole("dialog", { name: "Sitrep" });
  const copy = panel.getByRole("button", { name: "Copy as markdown" });
  await copy.click();

  // "Copied", not "Copied ✓". One confirmation word across the app, so the context menu Phase 2
  // adds has one to match rather than a fifth spelling to pick from. The second assertion needs
  // the first: `getByRole` matches an accessible name by substring, so "Copied" alone would be
  // satisfied by the decorated label this phase removed.
  await expect(panel.getByRole("button", { name: "Copied" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Copied ✓" })).toHaveCount(0);
  await shoot(panel.locator("header.report-head"), dashboard, "01-sitrep-copied");

  expectTheSitrepDigest(await dashboard.evaluate(() => navigator.clipboard.readText()));

  // And it comes back, so a second copy reads as available rather than spent.
  await expect(copy).toBeVisible({ timeout: 4000 });
});

test("the sitrep copy survives a renderer whose Clipboard API refuses", async ({
  dashboard,
  daemon,
}) => {
  await refuseTheAsyncClipboard(dashboard);
  await seedBacklogTask(daemon);
  await dashboard.reload();
  await expectTheClipboardToRefuse(dashboard);
  await openSitrep(dashboard);

  const panel = dashboard.getByRole("dialog", { name: "Sitrep" });
  await panel.getByRole("button", { name: "Copy as markdown" }).click();

  // The synchronous selection fallback carried it, so the label flips and no failure is raised.
  // Before this phase the direct `writeText` had no fallback to fall back TO, and the empty
  // `catch` around it meant the reader saw the resting label and no explanation.
  await expect(panel.getByRole("button", { name: "Copied" })).toBeVisible();
  await expect(panel.getByRole("alert")).toHaveCount(0);

  // A flipped label only proves the promise resolved. This proves something was written.
  expectTheSitrepDigest(await clipboardFromASecondPage(dashboard, daemon));
});

test("a sitrep copy that cannot read the report says so instead of nothing", async ({
  dashboard,
}) => {
  await dashboard.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  // The half of this copy that is not a clipboard call. `fetch` RESOLVES for a 500, so the old
  // code would have copied the error body; the empty `catch` meant a network failure produced
  // nothing on screen either way.
  await dashboard.route("**/api/report.md", (route) => route.fulfill({
    status: 500,
    body: "the report could not be built",
  }));
  await openSitrep(dashboard);

  const panel = dashboard.getByRole("dialog", { name: "Sitrep" });
  await panel.getByRole("button", { name: "Copy as markdown" }).click();

  await expect(panel.getByRole("alert"))
    .toHaveText("The sitrep markdown could not be read (500).");
  // And it did not claim to have copied anything.
  await expect(panel.getByRole("button", { name: "Copy as markdown" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Copied" })).toHaveCount(0);
  await shoot(panel, dashboard, "02-sitrep-copy-failed");
});

test("the Persona markdown copy confirms, and survives a refusing Clipboard API", async ({
  dashboard,
  daemon,
}) => {
  await refuseTheAsyncClipboard(dashboard);
  await openPersonaEditor(dashboard, daemon);
  await expectTheClipboardToRefuse(dashboard);

  const copy = dashboard.getByRole("button", { name: "Copy Markdown" });
  await copy.click();

  await expect(dashboard.getByRole("button", { name: "Copied" })).toBeVisible();
  await expect(dashboard.getByRole("button", { name: "Copied ✓" })).toHaveCount(0);
  // The editor's own error banner stayed away, because nothing failed.
  await expect(dashboard.getByText("Clipboard access was blocked")).toHaveCount(0);
  await shoot(dashboard.locator("header.persona-editor-head"), dashboard, "03-persona-copied");

  // The guidance really is on the clipboard, written by the fallback this control could not
  // reach before. This is the assertion that would have failed in the packaged app.
  expect(await clipboardFromASecondPage(dashboard, daemon)).toBe(GUIDANCE);

  await expect(copy).toBeVisible({ timeout: 4000 });
});

test("a Persona copy that works clears the refusal an earlier one left", async ({
  dashboard,
  daemon,
}) => {
  /*
   * The editor keeps ONE error line that saving, reloading and copying all write to, and this
   * copy wrote to it on failure only - so a refusal stood underneath a later `Copied`, a
   * confirmation and a contradiction for the same button.
   *
   * Both clipboard routes are blocked and then unblocked together, so the failure and the
   * later success come from one page and one document.
   */
  await dashboard.addInitScript(() => {
    const state = { blocked: true };
    Reflect.set(window, "__missionCopyState", state);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () => (state.blocked
          ? Promise.reject(new Error("Write permission denied."))
          : Promise.resolve()),
      },
    });
    document.execCommand = () => !state.blocked;
  });
  await openPersonaEditor(dashboard, daemon);
  await expectTheClipboardToRefuse(dashboard);

  const copy = dashboard.getByRole("button", { name: "Copy Markdown" });
  await copy.click();

  const banner = dashboard.getByText("Clipboard access was blocked");
  await expect(banner).toBeVisible();
  await expect(dashboard.getByRole("button", { name: "Copied" })).toHaveCount(0);

  await dashboard.evaluate(() => {
    const state = Reflect.get(window, "__missionCopyState") as { blocked: boolean };
    state.blocked = false;
  });

  await copy.click();
  await expect(dashboard.getByRole("button", { name: "Copied" })).toBeVisible();
  await expect(banner).toHaveCount(0);
});
