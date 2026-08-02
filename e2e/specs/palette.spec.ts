import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import type { Page } from "@playwright/test";

/**
 * The everything-palette, driven the way an operator drives it: one chord, a few letters, and
 * whatever came back.
 *
 * This is the only layer that can see any of it. `test/palette-index.test.ts` proves the
 * provider registry builds the right rows from a store, and `test/palette-render.test.ts`
 * proves the dialog's markup - and neither can tell you whether ⌘K reaches the handler through
 * App's key ladder, whether a row's Enter arrives at a page that renders, or whether the live
 * run in the row is the run the daemon actually has. A spec that only rendered the palette
 * would pass on a build whose chord was wired to nothing.
 *
 * No model tokens. The one dispatched session runs against the fake agent, and the run it
 * holds is failed deterministically by the `E2E_FAIL_VERDICT` marker the fake answers - the
 * same seeding `line-drawers.spec.ts` and `workflow-run-disable.spec.ts` use.
 */

const EVIDENCE = fileURLToPath(new URL("../../docs/evidence/palette/", import.meta.url));

/**
 * Photograph a state this spec has already asserted on.
 *
 * Behind `MC_E2E_EVIDENCE`, like the Line's captures, because an ordinary run would rewrite
 * the binaries for no added signal. Inside the regression tests rather than in a staged
 * capture spec, because the point of the picture is that the assertions around it passed on
 * the same run.
 */
async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer, and this
  // panel is a stack of adjacent buttons.
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED docs/evidence/palette/${name}.png`);
}

/**
 * Say what just held, after it held.
 *
 * Printed only once the assertion above it has already succeeded, so the committed
 * transcript cannot narrate a step that did not happen.
 */
function observed(line: string): void {
  if (!process.env.MC_E2E_EVIDENCE) return;
  // eslint-disable-next-line no-console
  console.log(`OBSERVED ${line}`);
}

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

/**
 * `Meta+k`, not `ControlOrMeta+k`.
 *
 * `chordFromEvent` spells the Command modifier `cmd` and derives it from `e.metaKey` ALONE, so
 * on Linux - where Playwright maps `ControlOrMeta` to Control - that chord would arrive as
 * "ctrl+k" and match nothing. Playwright sets `metaKey` from `Meta` on every platform, so this
 * is the one spelling that presses the operator's ⌘K on the machine this suite happens to run
 * on.
 */
const CHORD = "Meta+k";

const palette = (page: Page) => page.getByRole("dialog", { name: "Search everything" });
const field = (page: Page) => page.getByRole("combobox", { name: "Search everything" });

async function open(page: Page): Promise<void> {
  await page.keyboard.press(CHORD);
  await expect(palette(page)).toBeVisible();
}

/** Type a query and wait for the row that should answer it. */
async function search(page: Page, query: string, row: RegExp): Promise<void> {
  await field(page).fill(query);
  await expect(page.getByRole("option", { name: row })).toBeVisible();
}

/** One authored asset of each kind, so a query can cross the Library's shelves. */
async function seedAssets(daemon: DaemonHandle): Promise<{ workflowId: string; personaId: string }> {
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: "Zephyr reviewer",
    description: "Reads the diff and says whether it holds.",
    guidanceMarkdown: "# Zephyr reviewer\n\nJudge the change.",
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "Zephyr workflow",
    description: "One reviewer, for the palette spec.",
  });
  return { workflowId: workflow.workflow.id, personaId: persona.id };
}

test("⌘K opens the palette on every page, and esc closes it without going anywhere", async ({
  dashboard,
  daemon,
}) => {
  // The fleet. Nothing is open, and the chord opens the palette where you already are - it no
  // longer navigates to Settings first, which is the whole difference from the search it grew
  // out of.
  await open(dashboard);
  expect(await dashboard.evaluate(() => location.hash)).toBe("#/fleet");

  // Escape closes it and leaves the page exactly as it found it. This is the assertion that
  // makes the palette safe to open by reflex: a dismissed palette is a no-op, never a jump.
  await dashboard.keyboard.press("Escape");
  await expect(palette(dashboard)).toBeHidden();
  expect(await dashboard.evaluate(() => location.hash)).toBe("#/fleet");

  // The same chord toggles it shut, which is what makes ⌘K reversible with itself.
  await open(dashboard);
  await dashboard.keyboard.press(CHORD);
  await expect(palette(dashboard)).toBeHidden();

  // And it is genuinely app-wide: the other home and an execution page answer it too.
  for (const hash of ["#/library", "#/runs", "#/ensembles", "#/settings/shipping"]) {
    await dashboard.goto(`${daemon.baseURL}/${hash}`);
    await open(dashboard);
    await dashboard.keyboard.press("Escape");
    await expect(palette(dashboard)).toBeHidden();
    expect(await dashboard.evaluate(() => location.hash)).toBe(hash);
  }

  observed("⌘K opens on the fleet, the Library, #/runs, #/ensembles and Settings, and esc "
    + "closed it on each without moving the page");

  // The Settings rail's box is the other doorway, and it opens the SAME palette - the page
  // that used to own a search of its own does not own a second one.
  await dashboard.getByRole("button", { name: "Search everything" }).click();
  await expect(palette(dashboard)).toBeVisible();
  await expect(dashboard.getByRole("group", { name: "Do" })).toBeVisible();
  observed("the Settings rail's search box opens the same app-wide palette");
  await dashboard.keyboard.press("Escape");
  await expect(palette(dashboard)).toBeHidden();
});

test("one query crosses the Library, the commands and the settings, each row wearing its kind", async ({
  dashboard,
  daemon,
}) => {
  await seedAssets(daemon);
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await open(dashboard);

  // Before a letter is typed: what needs you, then everything you can start. No settings.
  await expect(dashboard.getByRole("group", { name: "Do" })).toBeVisible();
  await expect(dashboard.getByRole("group", { name: "Settings" })).toHaveCount(0);
  observed("the unprompted palette offers the Do rows and no settings");
  await shoot(dashboard, "palette-empty");

  // "zephyr" is only in the two seeded assets' names, so this is a cross-shelf hit that no
  // single page could have answered: a workflow and a Persona, side by side.
  await search(dashboard, "zephyr", /Zephyr workflow/);
  await expect(dashboard.getByRole("option", { name: /Zephyr reviewer/ })).toBeVisible();

  // The kind is on the row, which is what lets an operator tell two same-named things apart.
  await expect(dashboard.getByRole("option", { name: /^Zephyr workflow, workflow$/ })).toBeVisible();
  await expect(dashboard.getByRole("option", { name: /^Zephyr reviewer, persona$/ })).toBeVisible();
  observed("one query reached a workflow and a Persona on two different shelves, each chipped "
    + "with its kind");

  // A broader word reaches all three groups at once - assets to jump to, a verb to perform,
  // and the settings behind them. The groups are the palette's whole organising idea, so they
  // are asserted as the labelled boxes a screen reader announces, not as styling.
  await field(dashboard).fill("review");
  for (const group of ["Jump to", "Do", "Settings"]) {
    await expect(dashboard.getByRole("group", { name: group })).toBeVisible();
  }
  await expect(dashboard.getByRole("option", { name: /Bind a workflow to a session…, command/ }))
    .toBeVisible();
  observed('"review" reached all three groups at once: Jump to, Do and Settings');
  await shoot(dashboard, "palette-search");
});

test("enter on a shelf asset lands on its Library card", async ({ dashboard, daemon }) => {
  const { workflowId, personaId } = await seedAssets(daemon);
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);

  // Typed, then Enter - no mouse. The first result is the selected one, so a full query plus
  // Enter is the fastest path through the product, and it has to work.
  await open(dashboard);
  await search(dashboard, "Zephyr workflow", /Zephyr workflow, workflow/);
  await dashboard.keyboard.press("Enter");
  await expect(palette(dashboard)).toBeHidden();
  await expect.poll(async () => dashboard.evaluate(() => location.hash))
    .toBe(`#/library/workflows/${workflowId}`);
  await expect(dashboard.getByRole("complementary", { name: "Workflow library and node palette" }))
    .toBeVisible();

  // And from the page it just landed on, straight to another kind - the palette is the
  // connective tissue, so it has to work from where it put you.
  await open(dashboard);
  await search(dashboard, "Zephyr reviewer", /Zephyr reviewer, persona/);
  await dashboard.getByRole("option", { name: /Zephyr reviewer, persona/ }).click();
  await expect.poll(async () => dashboard.evaluate(() => location.hash))
    .toBe(`#/library/personas/${personaId}`);
  await expect(dashboard.locator("section.persona-fields").getByLabel("Name"))
    .toHaveValue("Zephyr reviewer");
});

test("a setting row lands on its panel with the control lit up", async ({ dashboard, daemon }) => {
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await open(dashboard);

  // The settings half still works exactly as the ⌘K it replaced: half-remember the control,
  // land on it. What is new is that you can do it from the fleet without a detour.
  await search(dashboard, "soak", /Soak time, setting/);
  await dashboard.keyboard.press("Enter");
  await expect(palette(dashboard)).toBeHidden();
  await expect.poll(async () => dashboard.evaluate(() => location.hash)).toBe("#/settings/shipping");

  // Landing on the CATEGORY is not the promise - landing on the CONTROL is. The anchor is
  // handed to the page and flashed there, which is the one thing a category-only route cannot
  // do on its own.
  const anchor = dashboard.locator('[data-anchor="shipping/soak"]');
  await expect(anchor).toBeVisible();
  await expect(anchor).toHaveClass(/settings-flash/);
  observed('"soak" from the fleet landed on #/settings/shipping with the Soak time control '
    + "scrolled to and flashing");
});

test("tab filters by kind, and the arrows walk the results", async ({ dashboard, daemon }) => {
  await seedAssets(daemon);
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await open(dashboard);
  await search(dashboard, "zephyr", /Zephyr workflow, workflow/);

  // Down moves the selection off the first row, and `aria-activedescendant` follows it - the
  // caret never leaves the input, so that attribute is the only thing announcing where the
  // keyboard is.
  const first = dashboard.getByRole("option", { name: /Zephyr workflow, workflow/ });
  await expect(first).toHaveAttribute("aria-selected", "true");
  await dashboard.keyboard.press("ArrowDown");
  await expect(first).toHaveAttribute("aria-selected", "false");
  await expect(dashboard.getByRole("option", { name: /Zephyr reviewer, persona/ }))
    .toHaveAttribute("aria-selected", "true");
  await dashboard.keyboard.press("ArrowUp");
  await expect(first).toHaveAttribute("aria-selected", "true");

  // Tab narrows to one kind, and says which - a filter you cannot see reads as lost results.
  await dashboard.keyboard.press("Tab");
  await expect(palette(dashboard)).toContainText("workflow only");
  await expect(first).toBeVisible();
  await expect(dashboard.getByRole("option", { name: /Zephyr reviewer, persona/ })).toHaveCount(0);
  await shoot(dashboard, "palette-kind-filter");

  // And the same key cycles out again, so the filter is escapable without learning a second
  // one. Two presses from here: persona, then back to everything.
  await dashboard.keyboard.press("Tab");
  await expect(palette(dashboard)).toContainText("persona only");
  await dashboard.keyboard.press("Tab");
  await expect(palette(dashboard)).not.toContainText("only");
  await expect(first).toBeVisible();
  await expect(dashboard.getByRole("option", { name: /Zephyr reviewer, persona/ })).toBeVisible();
  observed("the arrows walked the results, and tab cycled workflow -> persona -> everything");
});

test("a Do row opens the affordance it names, rather than navigating", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await open(dashboard);

  // The palette is a second doorway onto shipped affordances - so this lands on the SAME
  // dispatch modal the topbar button opens, already in Ensemble mode on the strategy named,
  // exactly as the Library's launcher card does.
  await search(dashboard, "Panel vote", /Launch a Panel vote ensemble…, strategy/);
  await dashboard.keyboard.press("Enter");
  await expect(palette(dashboard)).toBeHidden();

  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "Ensemble" })).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByRole("radio", { name: "Panel vote" })).toHaveAttribute("aria-checked", "true");
  // It opened a modal rather than moving the page: the hash is where it started.
  expect(await dashboard.evaluate(() => location.hash)).toBe("#/fleet");
  observed("a Do row opened the Dispatch modal already in Ensemble mode on Panel vote, "
    + "without moving the page");

  // The palette stands down while another overlay owns the screen, so ⌘K cannot strand the
  // dispatch dialog behind a palette whose Escape would close the wrong layer.
  await dashboard.keyboard.press(CHORD);
  await expect(palette(dashboard)).toBeHidden();
  await expect(dialog).toBeVisible();
  await dashboard.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // And the intent does not stick: an ordinary Dispatch afterwards is an ordinary Dispatch.
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  await expect(dialog.getByRole("radio", { name: "Single agent" }))
    .toHaveAttribute("aria-checked", "true");
  await dashboard.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(daemon.baseURL.length).toBeGreaterThan(0);
});

test("a live run is findable by its workflow's name, states what it is waiting for, and opens", async ({
  dashboard,
  daemon,
}) => {
  // A real run, held in `waiting_for_session` by a Persona with a known opinion. Nothing about
  // this row is invented by the browser: the status sentence is the daemon's summary, read
  // through the same helper the Runs page reads it with.
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dispatch = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dispatch.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dispatch.getByPlaceholder("What should this agent do?").fill("hold a session for the palette");
  await dispatch.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dispatch.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dispatch).toBeHidden();

  let sessionId = "";
  await expect.poll(async () => {
    const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
    const live = sessions.find((session) => session.state !== "exited");
    sessionId = live?.id ?? "";
    return live?.state ?? "";
  }).toBe("idle");

  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: "Palette strict reviewer",
    guidanceMarkdown: "# Palette strict reviewer\n\nE2E_FAIL_VERDICT",
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "Palette gate",
    draft: {
      nodes: [
        { id: "session", kind: "session", position: { x: 0, y: 0 } },
        { id: "reviewer", kind: "persona", personaId: persona.id, position: { x: 220, y: 0 } },
        { id: "end", kind: "end", outcome: "Approved", position: { x: 440, y: 0 } },
      ],
      edges: [
        { id: "submit", source: "session", sourcePort: "submitted", target: "reviewer", targetPort: "activate" },
        { id: "pass", source: "reviewer", sourcePort: "pass", target: "end", targetPort: "terminal" },
        { id: "fail", source: "reviewer", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
      ],
    },
  });
  const published = await api<{ version: { id: string } }>(
    daemon,
    `/api/workflows/${workflow.workflow.id}/publish`,
    { expectedDraftRevision: 1 },
  );
  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId: published.version.id,
    sessionId,
    deliveryMode: "preview",
  });
  const submitted = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId: "e2e-palette-run" },
  );
  const runId = submitted.run.id;
  await expect.poll(async () =>
    (await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${runId}`)).run.status,
  { timeout: 30_000 }).toBe("waiting_for_session");

  // Read the name the card carries now, rather than guessing it: the titler renames a fresh
  // session moments after dispatch and has long since settled by the time the run is waiting.
  const sessions = await api<Array<{ id: string; name: string }>>(daemon, "/api/sessions");
  const sessionName = sessions.find((session) => session.id === sessionId)!.name;

  await open(dashboard);
  await search(dashboard, "Palette gate", /Palette gate, run/);

  // Two rows for one name, and the chips are what separate them: the authored workflow you
  // would edit, and the run of it that is waiting on somebody right now.
  await expect(dashboard.getByRole("option", { name: /^Palette gate, workflow$/ })).toBeVisible();
  const runRow = dashboard.getByRole("option", { name: /^Palette gate, run$/ });
  await expect(runRow).toBeVisible();
  // The live state is IN the row, which is the reason to index runs at all - search doubles
  // as a status check. The session is there too, so four runs of one workflow are four
  // distinguishable rows rather than four copies of a name.
  await expect(runRow).toContainText("Waiting for the session");
  await expect(runRow).toContainText(sessionName);

  // And that session name is a way IN, not just a label: the run is findable by the thing
  // being reviewed, which is how an operator actually remembers it.
  await search(dashboard, sessionName, /^Palette gate, run$/);

  observed(`a live run carried its state into the row: "Waiting for the session" on ${sessionName}`);

  await runRow.click();
  await expect(palette(dashboard)).toBeHidden();
  await expect(dashboard).toHaveURL(new RegExp(`#/runs/${runId}$`));
  await expect(dashboard.locator(".wf-run-reader")).toContainText("Palette gate");
  observed("the run row opened that run's own #/runs/:id, and the reader names Palette gate");
});
