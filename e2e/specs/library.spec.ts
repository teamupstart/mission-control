import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The Library, driven the way an operator drives it: the topbar segment, the shelves, and the
 * editors one level under them.
 *
 * This is the layer the split actually needs. The route codec is a pure function `test/` can
 * check in a millisecond, and the shelf markup is a `renderToStaticMarkup` shape - but neither
 * can tell you whether clicking a card reaches the builder it names, whether a legacy bookmark
 * lands anywhere, or whether the address bar still describes the page after the editor has
 * moved on to another asset. Every assertion below is a click, a hash, and what came back.
 *
 * No agent is launched here and none needs to be: the Library authors, it does not run. The
 * one place this spec touches an executing surface is the Dispatch modal, and it stops at the
 * form - `dispatch-and-converse.spec.ts` owns launching.
 */

const EVIDENCE = fileURLToPath(new URL("../../docs/evidence/library-cross-link/", import.meta.url));

/**
 * Photograph a state this spec has already asserted on.
 *
 * Inside the regression test rather than in a staged capture spec, for the reason
 * `line-drawers.spec.ts` gives: the point of the picture is that the assertions around it
 * passed on the same run, so the image and the measurement cannot drift apart.
 *
 * Both widths, because the shelf has two layouts. 1440 is the one an operator sees; 720 is
 * under the 760px rung where the heading and the longest label stop sharing a line and the
 * pill drops to its own - a capture at one width would leave half the change unphotographed.
 *
 * Behind `MC_E2E_EVIDENCE` like every other capture in this suite: an ordinary
 * `npm run test:e2e` would rewrite the binaries for no added signal.
 */
async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  const original = page.viewportSize() ?? { width: 1280, height: 720 };
  // Off every control first: `Tooltip` portals a bubble under a resting pointer, and the
  // pill being photographed is exactly what the pointer was last measuring.
  await page.mouse.move(0, 0);
  for (const [suffix, width] of [["wide", 1440], ["narrow", 720]] as const) {
    await page.setViewportSize({ width, height: 900 });
    // One frame for the grid to settle after the resize; the shelf re-places its tracks.
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${EVIDENCE}${name}-${suffix}.png` });
    // eslint-disable-next-line no-console
    console.log(`CAPTURED docs/evidence/library-cross-link/${name}-${suffix}.png`);
  }
  await page.setViewportSize(original);
  await page.waitForTimeout(150);
}

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

/** One authored asset of each kind, so every shelf has something of the operator's on it. */
async function seedAssets(daemon: DaemonHandle): Promise<{ workflowId: string; personaId: string }> {
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: "Shelf reviewer",
    description: "Reads the diff and says whether it holds.",
    guidanceMarkdown: "# Shelf reviewer\n\nJudge the change.",
  });
  await api(daemon, "/api/session-actions", {
    name: "Shelf action",
    description: "Runs the migration and pastes the output.",
    promptMarkdown: "# Shelf action\n\nRun it.",
    completion: { kind: "session_turn" },
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "Shelf workflow",
    description: "One reviewer, for the shelf spec.",
  });
  return { workflowId: workflow.workflow.id, personaId: persona.id };
}

test("the Library shelves answer a question each, and name nothing that is running", async ({
  dashboard,
  daemon,
}) => {
  await seedAssets(daemon);
  await dashboard.goto(`${daemon.baseURL}/#/library`);

  // The five questions ARE the headings. That inversion - question up, system noun demoted to
  // an eyebrow - is the whole feature: before this page, nothing in the product said what a
  // workflow or a Persona was for.
  for (const question of [
    "What counts as done?",
    "Who does the reviewing?",
    "What can a run tell the session to do?",
    "Not sure of the best approach?",
    "Where does work come from?",
  ]) {
    await expect(dashboard.getByRole("heading", { name: question })).toBeVisible();
  }

  // The assets are on their shelves, each carrying a durable fact rather than a live one.
  await expect(dashboard.getByRole("button", { name: /Shelf workflow/ })).toBeVisible();
  await expect(dashboard.getByRole("button", { name: /Shelf reviewer/ })).toBeVisible();
  await expect(dashboard.getByRole("button", { name: /Shelf action/ })).toBeVisible();
  // The card says what the DRAFT is, which is the authoring fact - a freshly created
  // workflow has no nodes yet, so what an operator needs to see is the work left to do
  // rather than a version number it does not have.
  await expect(dashboard.getByRole("button", { name: /Shelf workflow/ }))
    .toContainText("validation error");
  await expect(dashboard.getByRole("button", { name: /Shelf workflow/ })).toContainText("draft");
  // The shipped built-in is published, and says so with its version and reviewer count.
  await expect(dashboard.getByRole("button", { name: /No-Mistakes Review/ }))
    .toContainText("reviewers");

  // And the page states its own contract, which is what every later phase has to keep.
  await expect(dashboard.getByRole("main"))
    .toContainText("Nothing here runs - live state stays on the runs and ensembles pages");
});

test("each shelf's cross-link sits beside its question rather than in the page's corner", async ({
  dashboard,
  daemon,
}) => {
  // Seeded so the capture below photographs a populated Library rather than five empty
  // shelves - the assertions themselves do not need any of it.
  await seedAssets(daemon);
  await dashboard.goto(`${daemon.baseURL}/#/library`);

  const shelf = dashboard.getByRole("region", { name: "What counts as done?" });
  const heading = shelf.getByRole("heading", { name: "What counts as done?" });
  // Three shelves point at the runs page, so the link is reached through its own shelf.
  const link = shelf.getByRole("button", { name: "runs →" });
  await expect(link).toBeVisible();

  const headingBox = (await heading.boundingBox())!;
  const linkBox = (await link.boundingBox())!;

  // On the heading's own line: the pill's centre falls inside the heading's band.
  const centre = linkBox.y + linkBox.height / 2;
  expect(centre).toBeGreaterThan(headingBox.y);
  expect(centre).toBeLessThan(headingBox.y + headingBox.height);

  // And immediately after it. This is the regression worth holding: the link used to be the
  // last flex item of the shelf's top row, and `margin-left: auto` parked it against the
  // right edge of the window - on a wide one, roughly a thousand pixels from the heading it
  // belongs to, in the smallest type on the page. Measured as a gap rather than an absolute
  // x so it reads the same at any viewport.
  const gap = linkBox.x - (headingBox.x + headingBox.width);
  expect(gap).toBeGreaterThan(0);
  expect(gap).toBeLessThan(40);

  // The status dot is what separates a live readout from the ＋ New cards beside it.
  const dot = await link.evaluate((el) => {
    const style = getComputedStyle(el, "::before");
    return { width: parseFloat(style.width), background: style.backgroundColor };
  });
  expect(dot.width).toBeGreaterThan(0);
  expect(dot.background).not.toBe("rgba(0, 0, 0, 0)");

  // The measurements above say where the pill is; this says what it looks like. Taken here,
  // between the geometry and the navigation, so the picture is of the state just asserted.
  await shoot(dashboard, "shelves");

  // Still the bridge to the live half of the product, and still per-shelf: the Ensembles
  // shelf keeps its own destination after the re-layout.
  await link.click();
  await expect.poll(async () => dashboard.evaluate(() => location.hash)).toBe("#/runs");

  await dashboard.goto(`${daemon.baseURL}/#/library`);
  await dashboard.getByRole("region", { name: "Not sure of the best approach?" })
    .getByRole("button", { name: "ensembles →" })
    .click();
  await expect.poll(async () => dashboard.evaluate(() => location.hash)).toBe("#/ensembles");
});

test("the topbar segment directly opens Fleet, Library and Runs, while Shift+P opens Sitrep", async ({
  dashboard,
}) => {
  const pages = dashboard.getByRole("navigation", { name: "Pages" });
  const fleet = pages.getByRole("button", { name: /Fleet/ });
  const library = pages.getByRole("button", { name: /Library/ });
  const runs = pages.getByRole("button", { name: /Runs/ });
  await expect(pages.getByRole("button")).toHaveCount(3);
  await expect(fleet).toHaveAttribute("aria-current", "page");
  await expect(fleet.locator("kbd")).toHaveText("f");
  await expect(library.locator("kbd")).toHaveText("w");
  await expect(runs.locator("kbd")).toHaveText("r");
  // Sitrep left the title bar to make room for the third page segment.
  await expect(dashboard.locator("header.topbar").getByRole("button", { name: "Sitrep" }))
    .toHaveCount(0);

  await library.click();
  await expect(dashboard.getByRole("heading", { name: "Library" })).toBeVisible();
  await expect(library).toHaveAttribute("aria-current", "page");
  // `aria-current` moves rather than being carried by both: only one of them is where you are.
  await expect(fleet).not.toHaveAttribute("aria-current", "page");
  expect(await dashboard.evaluate(() => location.hash)).toBe("#/library");

  // Library is direct, not a toggle: pressing its chord while already there leaves it there.
  await dashboard.keyboard.press("w");
  await expect(library).toHaveAttribute("aria-current", "page");
  expect(await dashboard.evaluate(() => location.hash)).toBe("#/library");

  await dashboard.keyboard.press("f");
  await expect(fleet).toHaveAttribute("aria-current", "page");
  expect(await dashboard.evaluate(() => location.hash)).toBe("#/fleet");

  await dashboard.keyboard.press("r");
  await expect(runs).toHaveAttribute("aria-current", "page");
  await expect(dashboard.getByRole("heading", { name: "Workflow runs", level: 2 })).toBeVisible();
  expect(await dashboard.evaluate(() => location.hash)).toBe("#/runs");

  // `r` no longer opens Sitrep. Its new Shift+P binding remains fleet-scoped like the panel.
  await dashboard.keyboard.press("f");
  await expect(fleet).toHaveAttribute("aria-current", "page");
  await dashboard.keyboard.press("Shift+P");
  await expect(dashboard.getByRole("heading", { name: "Sitrep" })).toBeVisible();
  await dashboard.keyboard.press("Escape");

  // Page chords stand down while a text field has focus, so `w` types instead of navigating.
  // Focused through the app's own `/` chord rather than by clicking: the topbar's container
  // ladder collapses the filter to its glyph on narrower windows, and this spec should not
  // depend on which rung the test viewport happens to land on.
  await dashboard.keyboard.press("/");
  await dashboard.keyboard.press("w");
  expect(await dashboard.evaluate(() => location.hash)).toBe("#/fleet");
  await expect(dashboard.getByPlaceholder("Filter (/)")).toHaveValue("w");
});

test("a card on each shelf opens the editor that owns it, and the hash names what is open", async ({
  dashboard,
  daemon,
}) => {
  const { workflowId, personaId } = await seedAssets(daemon);
  await dashboard.goto(`${daemon.baseURL}/#/library`);

  // Workflows -> the builder, on the workflow the card named. The address bar follows the
  // selection, so this link is shareable rather than merely reachable.
  await dashboard.getByRole("button", { name: /Shelf workflow/ }).click();
  await expect(dashboard.getByRole("complementary", { name: "Workflow library and node palette" }))
    .toBeVisible();
  await expect.poll(async () => dashboard.evaluate(() => location.hash))
    .toBe(`#/library/workflows/${workflowId}`);

  // Personas -> the Persona editor, with that Persona's guidance loaded.
  await dashboard.goto(`${daemon.baseURL}/#/library`);
  await dashboard.getByRole("button", { name: /Shelf reviewer/ }).click();
  await expect(dashboard.getByRole("complementary", { name: "Persona library" })).toBeVisible();
  await expect(dashboard.locator("section.persona-fields").getByLabel("Name"))
    .toHaveValue("Shelf reviewer");
  await expect.poll(async () => dashboard.evaluate(() => location.hash))
    .toBe(`#/library/personas/${personaId}`);

  // Actions -> the Action editor, same shape.
  await dashboard.goto(`${daemon.baseURL}/#/library`);
  await dashboard.getByRole("button", { name: /Shelf action/ }).click();
  await expect(dashboard.getByRole("complementary", { name: "Session action library" }))
    .toBeVisible();
  await expect(dashboard.locator("section.wf-action-fields").getByLabel("Name"))
    .toHaveValue("Shelf action");
});

test("the built-in workflow graph fills the full builder canvas", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.setViewportSize({ width: 1682, height: 1100 });
  await dashboard.goto(`${daemon.baseURL}/#/library`);
  await dashboard.getByRole("button", { name: /No-Mistakes Review/ }).click();
  await dashboard.getByRole("button", { name: "Graph", exact: true }).click();

  const canvas = dashboard.getByLabel("Published workflow graph");
  await expect(canvas).toBeVisible();
  await expect(canvas.locator(".react-flow__node").first()).toBeVisible();
  await expect(canvas.getByRole("button", { name: "Fit the graph to view" })).toBeVisible();
  const geometry = await canvas.evaluate((element) => {
    const flow = element.querySelector<HTMLElement>(":scope > .react-flow");
    if (!flow) throw new Error("React Flow root is missing from the workflow canvas");
    const canvasRect = element.getBoundingClientRect();
    const flowRect = flow.getBoundingClientRect();
    return {
      canvasHeight: canvasRect.height,
      flowHeight: flowRect.height,
      bottomGap: Math.abs(canvasRect.bottom - flowRect.bottom),
    };
  });

  // A built-in is read-only, but this is the full builder rather than the compact version
  // preview in the properties rail. The interaction state must not collapse the graph to
  // that preview's 250px height and leave the rest of the working surface blank.
  expect(geometry.canvasHeight).toBeGreaterThan(500);
  expect(geometry.flowHeight).toBe(geometry.canvasHeight);
  expect(geometry.bottomGap).toBeLessThanOrEqual(1);

  if (process.env.MC_E2E_EVIDENCE) {
    await dashboard.mouse.move(0, 0);
    await dashboard.screenshot({
      path: fileURLToPath(new URL("../evidence/workflow-graph-full-canvas.png", import.meta.url)),
      fullPage: true,
    });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/evidence/workflow-graph-full-canvas.png");
  }
});

test("the hash follows the editor to a second asset, without stacking history", async ({
  dashboard,
  daemon,
}) => {
  await seedAssets(daemon);
  await dashboard.goto(`${daemon.baseURL}/#/library`);
  await dashboard.getByRole("button", { name: /Shelf reviewer/ }).click();
  await expect(dashboard.locator("section.persona-fields").getByLabel("Name"))
    .toHaveValue("Shelf reviewer");

  // Selecting another Persona in the sidebar is not a page change, so it must not build a
  // history entry - otherwise Back stops meaning "the page I came from" after five clicks.
  await dashboard.getByRole("button", { name: /Documentation Steward/ }).click();
  await expect(dashboard.locator("section.persona-fields").getByLabel("Name"))
    .toHaveValue("Documentation Steward");
  await expect.poll(async () => dashboard.evaluate(() => location.hash))
    .toContain("/library/personas/");

  await dashboard.goBack();
  // One step back reaches the shelves, not the previously selected Persona.
  await expect(dashboard.getByRole("heading", { name: "Who does the reviewing?" })).toBeVisible();
});

test("the ＋ New cards open a blank draft, and creating a workflow lands on the new one", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/library`);

  // A Persona draft is client-side until it is saved, so this creates nothing durable.
  await dashboard.getByRole("button", { name: /New Persona/ }).click();
  await expect(dashboard.locator("section.persona-fields").getByLabel("Name")).toHaveValue("");
  expect(await dashboard.evaluate(() => location.hash)).toBe("#/library/personas/new");

  // A workflow draft IS a durable row, so the card goes through the builder's own create -
  // and the hash moves off `/new` onto the created id, which is what stops a reload from
  // making a second Untitled workflow.
  await dashboard.goto(`${daemon.baseURL}/#/library`);
  await dashboard.getByRole("button", { name: /New workflow/ }).click();
  await expect(dashboard.getByRole("complementary", { name: "Workflow library and node palette" }))
    .toBeVisible();
  await expect.poll(async () => dashboard.evaluate(() => location.hash))
    .toMatch(/^#\/library\/workflows\/(?!new$).+/);
  await expect
    .poll(async () => (await api<Array<{ name: string }>>(daemon, "/api/workflows"))
      .filter((row) => row.name.startsWith("Untitled workflow")).length)
    .toBe(1);
});

test("an ensemble strategy card opens Dispatch already in Ensemble mode on that strategy", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/library`);
  await dashboard.getByRole("button", { name: /Panel vote/ }).click();

  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  // Ensemble, chosen for the operator rather than left for them to find.
  await expect(dialog.getByRole("radio", { name: "Ensemble" })).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByRole("radio", { name: "Panel vote" })).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByRole("radio", { name: "Best of N" })).toHaveAttribute("aria-checked", "false");

  // Closing and opening Dispatch the ordinary way is an ORDINARY dispatch: the launcher's
  // intent must not stick to the button in the topbar.
  await dashboard.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  await expect(dialog.getByRole("radio", { name: "Single agent" }))
    .toHaveAttribute("aria-checked", "true");
});

test("every legacy authoring link lands in the Library, and the address bar says so", async ({
  dashboard,
  daemon,
}) => {
  await seedAssets(daemon);

  // These three hashes were the only way to reach these surfaces for the app's whole life
  // before the split, so they are in bookmarks, in notes, and in other people's messages.
  await dashboard.goto(`${daemon.baseURL}/#/workflows/personas`);
  await expect(dashboard.getByRole("complementary", { name: "Persona library" })).toBeVisible();
  await expect.poll(async () => dashboard.evaluate(() => location.hash))
    .toContain("#/library/personas");

  await dashboard.goto(`${daemon.baseURL}/#/workflows/actions`);
  await expect(dashboard.getByRole("complementary", { name: "Session action library" }))
    .toBeVisible();
  await expect.poll(async () => dashboard.evaluate(() => location.hash))
    .toContain("#/library/actions");

  // `#/workflows` was the builder tab; it is the Library's front door now.
  await dashboard.goto(`${daemon.baseURL}/#/workflows`);
  await expect(dashboard.getByRole("heading", { name: "What counts as done?" })).toBeVisible();
  await expect.poll(async () => dashboard.evaluate(() => location.hash)).toBe("#/library");
});

// The Workflows page kept two execution tabs for exactly one release while the Library took
// the authoring ones. Both of those tabs are top-level pages hung off the Line now, and the
// page they shared is deleted - so what this case checks is that the split is COMPLETE:
// nothing is left behind a tablist, and the Library still owns every authoring surface.
// The redirect table itself lives in `line-drawers.spec.ts`.
test("the Workflows page is gone, and neither half of it came back as a tab", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/runs`);
  // Exact, or the empty state's "No workflow runs yet" matches this too.
  await expect(dashboard.getByRole("heading", { name: "Workflow runs", exact: true }))
    .toBeVisible();
  await expect(dashboard.getByRole("tab")).toHaveCount(0);

  await dashboard.goto(`${daemon.baseURL}/#/ensembles`);
  await expect(dashboard.getByRole("heading", { name: "Ensembles", exact: true })).toBeVisible();
  await expect(dashboard.getByRole("tab")).toHaveCount(0);

  // And the Library is still the only home for what it took: its shelves are here, and no
  // execution surface reappeared among them.
  await dashboard.goto(`${daemon.baseURL}/#/library`);
  await expect(dashboard.getByRole("heading", { name: "What counts as done?" })).toBeVisible();
  await expect(dashboard.getByRole("heading", { name: "Workflow runs", exact: true }))
    .toHaveCount(0);
});

test("an unsaved draft still holds a navigation away from the editor", async ({
  dashboard,
  daemon,
}) => {
  // The dirty-draft gate lives in the router, and the editors it guards moved out from under
  // it in this change. Asserted through the browser because that is the only layer where
  // "typed, then clicked away" is a real sequence.
  await seedAssets(daemon);
  await dashboard.goto(`${daemon.baseURL}/#/library/personas`);
  await dashboard.getByRole("button", { name: /Shelf reviewer/ }).click();
  const name = dashboard.locator("section.persona-fields").getByLabel("Name");
  await expect(name).toHaveValue("Shelf reviewer");
  await name.fill("Shelf reviewer, edited");

  // Leaving for the other home is a page change, so the gate asks rather than dropping it.
  await dashboard.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: /Fleet/ })
    .click();
  const gate = dashboard.getByRole("dialog", { name: "Leave with unsaved changes" });
  await expect(gate).toBeVisible();

  // Staying keeps both the page and the typing.
  await gate.getByRole("button", { name: "Cancel" }).click();
  await expect(name).toHaveValue("Shelf reviewer, edited");
  expect(await dashboard.evaluate(() => location.hash)).toContain("/library/personas");
});
