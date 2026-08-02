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

test("the topbar segment moves between the two homes, and the chord does the same", async ({
  dashboard,
}) => {
  const pages = dashboard.getByRole("navigation", { name: "Pages" });
  await expect(pages.getByRole("button", { name: /Fleet/ })).toHaveAttribute("aria-current", "page");

  await pages.getByRole("button", { name: /Library/ }).click();
  await expect(dashboard.getByRole("heading", { name: "Library" })).toBeVisible();
  await expect(pages.getByRole("button", { name: /Library/ })).toHaveAttribute("aria-current", "page");
  // `aria-current` moves rather than being carried by both: only one of them is where you are.
  await expect(pages.getByRole("button", { name: /Fleet/ })).not.toHaveAttribute("aria-current", "page");
  expect(await dashboard.evaluate(() => location.hash)).toBe("#/library");

  await pages.getByRole("button", { name: /Fleet/ }).click();
  // The same barrier the keyboard half below explains, and it is needed here for the same
  // reason: the press that follows is synthetic and can land inside the render that trails
  // this navigation, where the handler React armed for the Library answers it and does
  // nothing. Waiting on the hash alone waits for something the click already made true, so
  // the first `w` was silently swallowed and `aria-current` never reached the Library.
  await expect(pages.getByRole("button", { name: /Fleet/ }))
    .toHaveAttribute("aria-current", "page");
  expect(await dashboard.evaluate(() => location.hash)).toBe("#/fleet");

  // The same swing on the keyboard. It is the one chord that fires OFF the fleet too, which
  // is what lets the single key return.
  //
  // Each press waits for the SEGMENT to move, not for the hash. `navigate` sets
  // `location.hash` synchronously, so the hash is the new page one line after the keypress -
  // while the key handler is still the one React armed for the page you just left, because
  // it re-subscribes on the render that trails the `hashchange`. Polling the hash therefore
  // waits for something that is already true and lets a second synthetic press land inside
  // that window, where it is answered by the stale handler and does nothing. `aria-current`
  // only moves on that render, so waiting for it is both the honest user-visible assertion
  // and the correct barrier. (A person cannot type inside one frame; Playwright can.)
  await dashboard.keyboard.press("w");
  await expect(pages.getByRole("button", { name: /Library/ }))
    .toHaveAttribute("aria-current", "page");
  expect(await dashboard.evaluate(() => location.hash)).toBe("#/library");

  await dashboard.keyboard.press("w");
  await expect(pages.getByRole("button", { name: /Fleet/ }))
    .toHaveAttribute("aria-current", "page");
  expect(await dashboard.evaluate(() => location.hash)).toBe("#/fleet");

  // And it stands down while a text field has focus, so `w` types instead of navigating.
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

test("the Workflows page keeps its two execution tabs and no authoring", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/workflows/runs`);

  // Exhaustive, not membership: an authoring tab surviving here is a second home for the
  // thing the Library now owns, and the two would drift apart quietly.
  await expect(dashboard.getByRole("tab")).toHaveText(["Runs", "Ensembles"]);
  // Exact, or the empty state's "No workflow runs yet" matches this too.
  await expect(dashboard.getByRole("heading", { name: "Workflow runs", exact: true }))
    .toBeVisible();

  // The surviving tab still works, and still routes.
  await dashboard.getByRole("tab", { name: /Ensembles/ }).click();
  await expect.poll(async () => dashboard.evaluate(() => location.hash))
    .toBe("#/workflows/ensembles");
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
