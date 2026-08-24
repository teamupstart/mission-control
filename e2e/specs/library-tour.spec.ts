import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Author what runs, as a browser sees it.
 *
 * The unit suite already decides everything about this tour that is data - fifteen stops,
 * nineteen beats, which route each stop asks for, and which run qualifies. What only a browser
 * can answer is whether those routes actually mount the surfaces the stops point at, whether
 * the spotlight lands on the element the copy is about, and whether a tour that walks the
 * whole Library really leaves every asset exactly as it found it.
 *
 * NO MODEL TOKENS. The one live artifact this spec needs is a finished run of the built-in
 * workflow, and it is produced by binding the shipped version to a fake-backed session,
 * submitting once, and cancelling - which is terminal, is over in a moment, and never asks a
 * reviewer anything.
 */

const EVIDENCE = artifactsDir("library-tour");
const TOUR_COMMAND = /Start Author what runs tour, command/;
const NO_MISTAKES = "builtin-workflow:no-mistakes-review";
/** The same id as the address bar spells it: `missionRouteHash` percent-encodes an asset id. */
const NO_MISTAKES_HASH = `#/library/workflows/${encodeURIComponent(NO_MISTAKES)}`;

/** Every stop title, in order. The rail counts these; Driver counts the beats under them. */
const TITLES = [
  "The Library",
  "The Persona library",
  "What a Persona is, and what configures it",
  "Editing one",
  "The Action library",
  "The contract, and the instruction",
  "A Command slot",
  "Overrides, and saving one",
  "The builder",
  "Draft and published",
  "No-Mistakes Review",
  "Binding it",
  "A run, moving",
  "Where a run is watched",
  "That is the authoring half",
] as const;

/** How many spotlights each stop has. Two-beat stops read as one step on the rail. */
const BEATS: Record<string, number> = {
  "The Library": 1,
  "The Persona library": 1,
  "What a Persona is, and what configures it": 2,
  "Editing one": 1,
  "The Action library": 1,
  "The contract, and the instruction": 2,
  "A Command slot": 1,
  "Overrides, and saving one": 2,
  "The builder": 1,
  "Draft and published": 2,
  "No-Mistakes Review": 1,
  "Binding it": 1,
  "A run, moving": 2,
  "Where a run is watched": 1,
  "That is the authoring half": 1,
};

test.describe.configure({ timeout: 180_000 });

async function api<T>(
  daemon: DaemonHandle,
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

function step(page: Page, title: string): Locator {
  return page.getByRole("dialog", { name: title }).or(page.getByRole("status", { name: title }));
}

/**
 * Click Next and require the NEXT stop to land well under Driver's own element-wait.
 *
 * A stop whose target the runtime already knows does not exist - no qualifying run, or a
 * centered stop with no target at all - must not make Driver poll the document for one
 * anyway: that wait is `TARGET_WAIT_MS` (2s) per screen, spent inside Driver's own
 * transition rather than inside Playwright's `click()`, so the click resolves instantly and
 * only the NEXT popover's arrival shows the stall. 1200ms is comfortably above ordinary
 * transition cost (tens of milliseconds, even under CI contention) and comfortably below the
 * 2s floor a regression here reintroduces, so this fails on the stall without chasing CI's
 * own jitter.
 */
async function clickNextWithin(page: Page, dialog: Locator, nextTitle: string, budgetMs: number): Promise<Locator> {
  const start = Date.now();
  await dialog.getByRole("button", { name: "Next" }).click();
  const next = step(page, nextTitle);
  await expect(next).toBeVisible();
  const elapsed = Date.now() - start;
  expect(elapsed, "Next stalled waiting for a target the runtime already knew was absent")
    .toBeLessThan(budgetMs);
  return next;
}

const hash = (page: Page): Promise<string> => page.evaluate(() => location.hash);

async function startFromSettings(page: Page, daemon: DaemonHandle, category = "display"): Promise<void> {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${daemon.baseURL}/#/settings/${category}`);
  await page.getByRole("button", { name: "Start Author what runs tour" }).click();
}

async function startFromPalette(page: Page): Promise<void> {
  const palette = page.getByRole("dialog", { name: "Search everything" });
  await page.keyboard.press("Meta+k");
  await expect(palette).toBeVisible();
  await palette.getByRole("combobox", { name: "Search everything" }).fill("Author what runs");
  await palette.getByRole("option", { name: TOUR_COMMAND }).click();
}

/** Press Next until the named stop is showing, walking beats as well as stops. */
async function advanceTo(page: Page, from: string, to: string): Promise<Locator> {
  let current = from;
  for (let guard = 0; guard < 30 && current !== to; guard++) {
    const index = TITLES.indexOf(current as (typeof TITLES)[number]);
    const dialog = step(page, current);
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    for (let beat = 0; beat < (BEATS[current] ?? 1); beat++) {
      await dialog.getByRole("button", { name: "Next" }).click();
    }
    current = TITLES[index + 1] ?? to;
  }
  const dialog = step(page, to);
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  return dialog;
}

/** Everything the tour walks past, as the daemon holds it. Compared before and after. */
async function assetSnapshot(daemon: DaemonHandle): Promise<string> {
  const [personas, actions, commands, workflows] = await Promise.all([
    api<unknown>(daemon, "/api/personas"),
    api<unknown>(daemon, "/api/session-actions"),
    api<unknown>(daemon, "/api/workflow-commands"),
    api<unknown>(daemon, "/api/workflows"),
  ]);
  return JSON.stringify({ personas, actions, commands, workflows });
}

async function dispatchSession(page: Page, daemon: DaemonHandle, brief: string): Promise<string> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(brief);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let sessionId = "";
  await expect.poll(async () => {
    const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
    const session = sessions.find((candidate) => candidate.state !== "exited");
    sessionId = session?.id ?? "";
    return session?.state ?? "";
  }, { timeout: 60_000 }).toBe("idle");
  return sessionId;
}

/**
 * A FINISHED run of the given published version against a live session.
 *
 * Submitted and then cancelled: `cancelled` is one of the three terminal statuses, so the run
 * qualifies exactly as a completed one does, and the whole thing costs one fake process rather
 * than five reviewer turns and a pull request.
 */
async function seedTerminalRun(
  daemon: DaemonHandle,
  workflowVersionId: string,
  sessionId: string,
  requestId: string,
): Promise<string> {
  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId,
    sessionId,
    deliveryMode: "preview",
  });
  const submitted = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId },
  );
  await api(daemon, `/api/workflow-runs/${submitted.run.id}/cancel`, {
    requestId: `${requestId}-cancel`,
  });
  await expect.poll(async () => (
    await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${submitted.run.id}`)
  ).run.status, { timeout: 60_000 }).toBe("cancelled");
  return submitted.run.id;
}

async function builtinVersionId(daemon: DaemonHandle): Promise<string> {
  const workflows = await api<Array<{ id: string; currentVersionId: string | null }>>(
    daemon,
    "/api/workflows",
  );
  const builtin = workflows.find((workflow) => workflow.id === NO_MISTAKES);
  expect(builtin?.currentVersionId, "this build ships no published No-Mistakes Review").toBeTruthy();
  return builtin!.currentVersionId!;
}

async function shoot(target: Page | Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/library-tour/${name}.png`);
}

/** The tour never dims the surface it is asking you to read. */
async function expectNoOverlap(coachmark: Locator, surface: Locator): Promise<void> {
  const [tour, target] = await Promise.all([coachmark.boundingBox(), surface.boundingBox()]);
  if (!tour || !target) throw new Error("a tour stop did not finish laying out");
  const overlaps = !(
    tour.x + tour.width <= target.x
    || target.x + target.width <= tour.x
    || tour.y + tour.height <= target.y
    || target.y + target.height <= tour.y
  );
  expect(overlaps, "the coachmark covers the surface it describes").toBe(false);
}

async function expectInViewport(page: Page, coachmark: Locator): Promise<void> {
  const box = await coachmark.boundingBox();
  const viewport = page.viewportSize();
  if (!box || !viewport) throw new Error("a tour stop did not finish laying out");
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
}

/**
 * Every shelf term clears its own description.
 *
 * The term column used to be a flat 48px, which fits a short word and silently runs a longer
 * one straight through the text beside it - "Missions - Sources" wrapped to three lines inside
 * the track while its description stayed on the first. Markup assertions cannot see that: the
 * words are all present and correctly ordered in the DOM while being drawn on top of each
 * other, so this measures boxes.
 */
async function expectDetailRowsReadable(dialog: Locator): Promise<void> {
  const rows = dialog.locator(".mc-tour-kind-list > div");
  const count = await rows.count();
  expect(count, "the shelves index drew no rows").toBeGreaterThan(0);
  for (let index = 0; index < count; index++) {
    const row = rows.nth(index);
    const [term, description] = await Promise.all([
      row.locator("dt").boundingBox(),
      row.locator("dd").boundingBox(),
    ]);
    if (!term || !description) throw new Error("a shelf row did not finish laying out");
    const label = await row.locator("dt").innerText();
    expect(
      term.x + term.width,
      `the shelf term "${label}" overlaps the question beside it`,
    ).toBeLessThanOrEqual(description.x + 1);
  }
}

test("the palette starts the tour, and it walks the Library's four authoring surfaces", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.emulateMedia({ reducedMotion: "reduce" });
  await dashboard.setViewportSize({ width: 1440, height: 900 });
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  const before = await assetSnapshot(daemon);
  await startFromPalette(dashboard);

  // 1. The shelves index, and the page itself under the spotlight.
  let dialog = step(dashboard, "The Library");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Step 1 of 15");
  await expect(dialog.getByText("Author what runs", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("progressbar", { name: "Author what runs tour progress" }))
    .toHaveAttribute("aria-valuenow", "1");
  // The six shelf labels and questions are authored with this stage in tours/library.md.
  await expect(dialog).toContainText("Who does the reviewing?");
  await expect(dialog).toContainText("What counts as done?");
  // And they are readable, not merely present: the longest shelf name is two words and a
  // separator, which a fixed-width term column draws straight through its own question.
  await expectDetailRowsReadable(dialog);
  await expect.poll(() => hash(dashboard)).toBe("#/library");
  await expect(dashboard.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
  await shoot(dashboard, "01-library");
  await dialog.getByRole("button", { name: "Next" }).click();

  // 2-4. Personas, on a shipped built-in.
  dialog = step(dashboard, "The Persona library");
  await expect(dialog).toContainText("Step 2 of 15");
  await expect.poll(() => hash(dashboard)).toMatch(/^#\/library\/personas\/builtin(:|%3A)/);
  const personaRail = dashboard.getByRole("complementary", { name: "Persona library" });
  await expect(personaRail).toBeVisible();
  await expect(personaRail).toHaveCSS("outline-width", "2px");
  await expectNoOverlap(dialog, personaRail);
  await dialog.getByRole("button", { name: "Next" }).click();

  // Two beats, one step: the rail number does not move between the chips and the guidance.
  dialog = step(dashboard, "What a Persona is, and what configures it");
  await expect(dialog).toContainText("Step 3 of 15");
  const chips = dashboard.locator(".persona-editor .lib-props");
  await expect(chips).toHaveCSS("outline-width", "2px");
  await dialog.getByRole("button", { name: "Next" }).click();
  dialog = step(dashboard, "What a Persona is, and what configures it");
  await expect(dialog).toContainText("Step 3 of 15");
  const guidance = dashboard.getByRole("region", { name: "Persona guidance" });
  await expect(guidance).toHaveCSS("outline-width", "2px");
  await expect(chips).not.toHaveCSS("outline-width", "2px");
  await shoot(dashboard, "02-persona-guidance");
  await dialog.getByRole("button", { name: "Next" }).click();

  dialog = step(dashboard, "Editing one");
  await expect(dialog).toContainText("Step 4 of 15");
  // The promoted verb on a built-in is Duplicate to edit - the read-only one, which is what
  // makes it safe to spotlight, and the whole ownership lesson.
  const duplicate = dashboard.getByRole("button", { name: "Duplicate to edit" });
  await expect(duplicate).toBeVisible();
  await expect(duplicate).toHaveCSS("outline-width", "2px");
  await dialog.getByRole("button", { name: "Next" }).click();

  // 5-6. Actions, and the contract region the chips and the sentence now share.
  dialog = step(dashboard, "The Action library");
  await expect.poll(() => hash(dashboard)).toMatch(/^#\/library\/actions\/builtin(:|%3A)/);
  await expect(dashboard.getByRole("complementary", { name: "Session action library" }))
    .toHaveCSS("outline-width", "2px");
  await dialog.getByRole("button", { name: "Next" }).click();

  dialog = step(dashboard, "The contract, and the instruction");
  await expect(dialog).toContainText("Step 6 of 15");
  const contract = dashboard.getByRole("region", { name: "Session action contract" });
  await expect(contract).toHaveCSS("outline-width", "2px");
  await expect(contract).toContainText("requires skill");
  await expect(contract).toContainText("completes when");
  await expect(contract).toContainText("never because the session said so");
  await shoot(dashboard, "03-action-contract");
  await dialog.getByRole("button", { name: "Next" }).click();
  dialog = step(dashboard, "The contract, and the instruction");
  await expect(dashboard.getByRole("region", { name: "Session action instruction" }))
    .toHaveCSS("outline-width", "2px");
  await dialog.getByRole("button", { name: "Next" }).click();

  // 7-8. One Command slot, its overrides, and the Save that runs nothing.
  dialog = step(dashboard, "A Command slot");
  await expect.poll(() => hash(dashboard)).toBe("#/library/commands/test");
  await expect(dashboard.locator("tr.wf-command-rule.is-default")).toHaveCSS("outline-width", "2px");
  await dialog.getByRole("button", { name: "Next" }).click();
  dialog = step(dashboard, "Overrides, and saving one");
  await expect(dialog).toContainText("Step 8 of 15");
  await expect(dashboard.locator("tr.wf-command-rule.is-add")).toHaveCSS("outline-width", "2px");
  await dialog.getByRole("button", { name: "Next" }).click();
  dialog = step(dashboard, "Overrides, and saving one");
  const save = dashboard.getByRole("button", { name: "Save Command" });
  await expect(save).toBeDisabled();
  await expect(save).toHaveCSS("outline-width", "2px");
  await dialog.getByRole("button", { name: "Next" }).click();

  // 9-12. The builder, on the built-in No-Mistakes Review.
  dialog = step(dashboard, "The builder");
  await expect.poll(() => hash(dashboard)).toBe(NO_MISTAKES_HASH);
  await expect(dashboard.getByRole("complementary", { name: "Workflow library and node palette" }))
    .toHaveCSS("outline-width", "2px");
  await dialog.getByRole("button", { name: "Next" }).click();

  dialog = step(dashboard, "Draft and published");
  await expect(dialog).toContainText("Step 10 of 15");
  await expect(dashboard.getByRole("group", { name: "Editing surface" }))
    .toHaveCSS("outline-width", "2px");
  await dialog.getByRole("button", { name: "Next" }).click();
  dialog = step(dashboard, "Draft and published");
  const publish = dashboard.getByRole("button", { name: "Publish" });
  // The point of the beat: it is DISABLED, and the tour spends a beat on why.
  await expect(publish).toBeDisabled();
  await expect(publish).toHaveCSS("outline-width", "2px");
  await dialog.getByRole("button", { name: "Next" }).click();

  dialog = step(dashboard, "No-Mistakes Review");
  await expect(dialog).toContainText("Step 11 of 15");
  const authoredStrip = dashboard.getByRole("group", { name: "Workflow pipeline editor" });
  await expect(authoredStrip).toHaveCSS("outline-width", "2px");
  await expect(authoredStrip.locator("section.wf-pipeline-stage")).toHaveCount(5);
  await shoot(dashboard, "04-no-mistakes");
  await dialog.getByRole("button", { name: "Next" }).click();

  dialog = step(dashboard, "Binding it");
  await expect(dashboard.getByRole("button", { name: "Bind to a session…" }))
    .toHaveCSS("outline-width", "2px");
  // The exact click reported slow: no qualifying run exists yet, so the next stop's beats
  // resolve to nothing, and Driver must not poll the document for either of them.
  dialog = await clickNextWithin(dashboard, dialog, "A run, moving", 1200);

  // 13-14. No qualifying run on this fleet, so both stops fall back in place.
  await expect(dialog).toContainText("no finished No-Mistakes Review run");
  // The rendered consequence of the fix: this is the stop the previously-slow click landed
  // on, drawn immediately rather than after a multi-second stall.
  await shoot(dashboard, "11-run-moving-fallback");
  // Two beats even in the fallback: a stop keeps its shape when its surface is absent, so
  // Next walks the second look before it walks to the next stop.
  await dialog.getByRole("button", { name: "Next" }).click();
  dialog = step(dashboard, "A run, moving");
  await expect(dialog).toContainText("Step 13 of 15");
  await dialog.getByRole("button", { name: "Next" }).click();
  dialog = step(dashboard, "Where a run is watched");
  await expect(dialog).toContainText("no stage ladder to open");
  // The centered close: no target at all, so this is every tour's own last click, not just
  // the no-run path above - Driver must not poll the document for a target that was never
  // declared.
  dialog = await clickNextWithin(dashboard, dialog, "That is the authoring half", 1200);

  // 15. The centered close, offering the other tour without starting it.
  await expect(dialog).toContainText("Step 15 of 15");
  await expect(dialog).toContainText("See the work");
  await expect(dashboard.locator(".driver-popover")).toHaveCount(1);
  await shoot(dashboard, "05-close");
  await dialog.getByRole("button", { name: "Finish tour" }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });

  // The whole point of a read-only tour: nothing it walked past moved.
  expect(await assetSnapshot(daemon)).toBe(before);
  await expect.poll(() => hash(dashboard)).toBe("#/fleet");
});

test("a finished tour starts again from stop one, carrying nothing over from the last run", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.emulateMedia({ reducedMotion: "reduce" });
  // Begin somewhere specific rather than on the tour's own entry route, so the second run has
  // an origin it could get wrong by reusing the first run's snapshot.
  await dashboard.goto(`${daemon.baseURL}/#/library/commands/lint`);
  await expect(dashboard.getByRole("complementary", { name: "Command library" })).toBeVisible();
  const before = await assetSnapshot(daemon);

  // Run it once, all the way through the close stop. FINISHED, not exited: the two leave by
  // different buttons, and only this one proves the tour survives its own completion.
  await startFromPalette(dashboard);
  let dialog = await advanceTo(dashboard, "The Library", "That is the authoring half");
  await expect(dialog).toContainText("Step 15 of 15");
  await dialog.getByRole("button", { name: "Finish tour" }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect.poll(() => hash(dashboard)).toBe("#/library/commands/lint");

  // Start it again with NO reload in between. A reload would clear the controller's state for
  // free and prove nothing; this is the same page, the same App, the same registry.
  await startFromPalette(dashboard);

  dialog = step(dashboard, "The Library");
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog).toContainText("Step 1 of 15");
  await expect(dialog.getByText("Author what runs", { exact: true })).toBeVisible();
  await expect.poll(() => hash(dashboard)).toBe("#/library");
  // One coachmark, not two: the finished run left none parked in the DOM behind this one.
  await expect(dashboard.locator(".driver-popover")).toHaveCount(1);
  // Pixels for the rerun state, since "no stale UI left behind" is a claim about what is drawn.
  // Measured before it is captured, so the screenshot cannot quietly become proof of a defect.
  await expectDetailRowsReadable(dialog);
  await shoot(dashboard, "10-rerun-stop-one");

  // Genuinely at the beginning rather than resumed near the end: one Next reaches stop two,
  // which a cursor still sitting on the close stop could not do.
  await dialog.getByRole("button", { name: "Next" }).click();
  dialog = step(dashboard, "The Persona library");
  await expect(dialog).toContainText("Step 2 of 15");

  // The second run took its own origin snapshot, so Exit returns to where THIS one started.
  await dialog.getByRole("button", { name: "Exit tour" }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect.poll(() => hash(dashboard)).toBe("#/library/commands/lint");
  await expect(dashboard.getByRole("complementary", { name: "Command library" })).toBeVisible();

  // Two full passes over every authoring surface still moved nothing.
  expect(await assetSnapshot(daemon)).toBe(before);

  // And the entry point is not spent: the palette still offers the row a third time.
  await dashboard.keyboard.press("Meta+k");
  const palette = dashboard.getByRole("dialog", { name: "Search everything" });
  await palette.getByRole("combobox", { name: "Search everything" }).fill("Author what runs");
  await expect(palette.getByRole("option", { name: TOUR_COMMAND })).toBeVisible();
});

test("Settings starts it, Exit restores the exact category, and focus returns", async ({
  dashboard,
  daemon,
}) => {
  await startFromSettings(dashboard, daemon, "keyboard");
  const first = step(dashboard, "The Library");
  await expect(first).toBeVisible();
  await expect.poll(() => hash(dashboard)).toBe("#/library");

  const dialog = await advanceTo(dashboard, "The Library", "A Command slot");
  await expect.poll(() => hash(dashboard)).toBe("#/library/commands/test");
  await dialog.getByRole("button", { name: "Exit tour" }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });

  // The route is the snapshot, so the settings CATEGORY comes back rather than "some
  // settings page", and the invoking control takes focus again.
  await expect.poll(() => hash(dashboard)).toBe("#/settings/keyboard");
  await expect(dashboard.getByRole("tab", { name: /Keyboard/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(dashboard.getByRole("button", { name: "Start Author what runs tour" }))
    .toBeFocused();
});

test("Exit from the middle restores the Library asset the operator had open", async ({
  dashboard,
  daemon,
}) => {
  const personas = await api<Array<{ id: string; builtin: boolean; archivedAt: number | null }>>(
    daemon,
    "/api/personas",
  );
  const builtin = personas.filter((persona) => persona.builtin && persona.archivedAt === null)
    .map((persona) => persona.id)
    .sort()[0];
  expect(builtin, "this build ships no built-in Persona").toBeTruthy();

  await dashboard.emulateMedia({ reducedMotion: "reduce" });
  // Start from a Library surface with an asset open. The route carries the shelf and the
  // asset, so restoring one value restores both.
  await dashboard.goto(`${daemon.baseURL}/#/library/commands/lint`);
  await expect(dashboard.getByRole("complementary", { name: "Command library" })).toBeVisible();
  await startFromPalette(dashboard);

  const dialog = await advanceTo(dashboard, "The Library", "The builder");
  await expect.poll(() => hash(dashboard)).toBe(NO_MISTAKES_HASH);
  await dialog.getByRole("button", { name: "Exit tour" }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect.poll(() => hash(dashboard)).toBe("#/library/commands/lint");
  await expect(dashboard.getByRole("complementary", { name: "Command library" })).toBeVisible();
});

test("a dirty draft refuses the start, and no tour mounts behind the leave dialog", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.emulateMedia({ reducedMotion: "reduce" });
  await dashboard.goto(`${daemon.baseURL}/#/library/personas/new`);
  const name = dashboard.getByRole("textbox", { name: "Name" });
  await expect(name).toBeVisible();
  await name.fill("Half-written reviewer");

  await startFromPalette(dashboard);

  // The existing gate owns the answer, and the tour did not half-start under it.
  const leave = dashboard.getByRole("dialog", { name: /unsaved changes/i });
  await expect(leave).toBeVisible();
  await expect(dashboard.locator(".driver-popover")).toHaveCount(0);
  await expect(step(dashboard, "The Library")).toBeHidden();
  await shoot(dashboard, "06-dirty-draft-refusal");

  // Staying keeps the draft, and still no tour.
  await leave.getByRole("button", { name: /stay|cancel|keep/i }).first().click();
  await expect(leave).toBeHidden();
  await expect(dashboard.locator(".driver-popover")).toHaveCount(0);
  await expect(name).toHaveValue("Half-written reviewer");
});

test("a finished built-in run is walked in Runs and then in its session's Workflows tab", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.emulateMedia({ reducedMotion: "reduce" });
  await dashboard.setViewportSize({ width: 1440, height: 900 });
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  const sessionId = await dispatchSession(dashboard, daemon, "hold a session for the Library tour");
  const runId = await seedTerminalRun(
    daemon,
    await builtinVersionId(daemon),
    sessionId,
    "library-tour-run",
  );

  await startFromPalette(dashboard);
  let dialog = await advanceTo(dashboard, "The Library", "A run, moving");
  await expect.poll(() => hash(dashboard)).toBe(`#/runs/${runId}`);
  const runStrip = dashboard.getByRole("group", { name: "Workflow run pipeline" });
  await expect(runStrip).toBeVisible({ timeout: 30_000 });
  await expect(runStrip).toHaveCSS("outline-width", "2px");
  await expect(dialog).not.toContainText("no finished No-Mistakes Review run");
  await shoot(dashboard, "07-run-pipeline");
  await dialog.getByRole("button", { name: "Next" }).click();

  dialog = step(dashboard, "A run, moving");
  const worklist = dashboard.getByRole("region", { name: "Review worklist" });
  await expect(worklist).toBeVisible();
  await expect(worklist).toHaveCSS("outline-width", "2px");
  await dialog.getByRole("button", { name: "Next" }).click();

  dialog = step(dashboard, "Where a run is watched");
  await expect.poll(() => hash(dashboard)).toBe("#/fleet");
  const ladder = dashboard.getByRole("region", { name: /workflow stages$/ });
  await expect(ladder).toBeVisible({ timeout: 30_000 });
  await expect(ladder).toHaveCSS("outline-width", "2px");
  await expect(dialog).not.toContainText("no longer live");
  await shoot(dashboard, "08-session-ladder");
  await dialog.getByRole("button", { name: "Next" }).click();
  await expect(step(dashboard, "That is the authoring half")).toBeVisible();
});

test("a terminal run of another workflow never qualifies, and both run stops fall back", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.emulateMedia({ reducedMotion: "reduce" });
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  const sessionId = await dispatchSession(dashboard, daemon, "hold a session for the fallback spec");

  // A published workflow of the operator's own, finished. It is not No-Mistakes Review, so the
  // stop that names five specific stages must not point at it.
  const action = await api<{ id: string }>(daemon, "/api/session-actions", {
    name: "Fallback spec action",
    promptMarkdown: "# Hold\n\nHold here for the fallback spec.\n",
    completion: { kind: "session_turn" },
  });
  const created = await api<{ workflow: { id: string; draftRevision: number } }>(
    daemon,
    "/api/workflows",
    {
      name: "Not No-Mistakes",
      draft: {
        nodes: [
          { id: "session", kind: "session", position: { x: 0, y: 0 } },
          {
            id: "action",
            kind: "session_action",
            sessionActionId: action.id,
            position: { x: 240, y: 0 },
          },
          { id: "end", kind: "end", outcome: "Complete", position: { x: 480, y: 0 } },
        ],
        edges: [
          {
            id: "start",
            source: "session",
            sourcePort: "submitted",
            target: "action",
            targetPort: "activate",
          },
          { id: "done", source: "action", sourcePort: "complete", target: "end", targetPort: "terminal" },
        ],
      },
    },
  );
  const published = await api<{ version: { id: string } }>(
    daemon,
    `/api/workflows/${created.workflow.id}/publish`,
    { expectedDraftRevision: created.workflow.draftRevision },
  );
  await seedTerminalRun(daemon, published.version.id, sessionId, "library-tour-other");

  await startFromPalette(dashboard);
  let dialog = await advanceTo(dashboard, "The Library", "A run, moving");
  // Still on the built-in graph: the tour did not open somebody else's run.
  await expect.poll(() => hash(dashboard)).toBe(NO_MISTAKES_HASH);
  await expect(dialog).toContainText("no finished No-Mistakes Review run");
  await expect(dialog.getByRole("button", { name: "Next" })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "Back" })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "Exit tour" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Next" }).click();
  await step(dashboard, "A run, moving").getByRole("button", { name: "Next" }).click();

  dialog = step(dashboard, "Where a run is watched");
  await expect(dialog).toContainText("no stage ladder to open");
  await expect.poll(() => hash(dashboard)).toBe(NO_MISTAKES_HASH);
  await dialog.getByRole("button", { name: "Exit tour" }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
});

test("a session evicted mid-tour leaves the last stop naming the run's durable name", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.emulateMedia({ reducedMotion: "reduce" });
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  const sessionId = await dispatchSession(dashboard, daemon, "hold a session that will be evicted");
  const runId = await seedTerminalRun(
    daemon,
    await builtinVersionId(daemon),
    sessionId,
    "library-tour-evicted",
  );

  await startFromPalette(dashboard);
  const moving = await advanceTo(dashboard, "The Library", "A run, moving");
  await expect.poll(() => hash(dashboard)).toBe(`#/runs/${runId}`);
  await expect(dashboard.getByRole("group", { name: "Workflow run pipeline" }))
    .toBeVisible({ timeout: 30_000 });

  // The session goes between the two run stops, which is the case the second clause of the
  // selection rule exists for - and the run outlives it, carrying the name.
  await api(daemon, `/api/sessions/${sessionId}/kill`, {});
  await expect.poll(async () => (
    await api<Array<{ id: string }>>(daemon, "/api/sessions")
  ).some((session) => session.id === sessionId), { timeout: 60_000 }).toBe(false);

  await moving.getByRole("button", { name: "Next" }).click();
  await step(dashboard, "A run, moving").getByRole("button", { name: "Next" }).click();
  const watched = step(dashboard, "Where a run is watched");
  await expect(watched).toContainText("no longer live", { timeout: 30_000 });
  await expect(watched.getByRole("button", { name: "Next" })).toBeEnabled();
  await shoot(dashboard, "09-evicted-session-fallback");
  await watched.getByRole("button", { name: "Exit tour" }).click();
  await expect(watched).toBeHidden({ timeout: 30_000 });
});

test("every stop stays inside a narrow viewport and never covers what it describes", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.emulateMedia({ reducedMotion: "reduce" });
  await dashboard.setViewportSize({ width: 900, height: 700 });
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await startFromPalette(dashboard);

  for (const title of TITLES) {
    const dialog = step(dashboard, title);
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    for (let beat = 0; beat < (BEATS[title] ?? 1); beat++) {
      const current = step(dashboard, title);
      await expectInViewport(dashboard, current);
      const next = current.getByRole("button", { name: "Next" })
        .or(current.getByRole("button", { name: "Finish tour" }));
      await next.first().click();

    }
  }
  await expect(step(dashboard, "That is the authoring half")).toBeHidden({ timeout: 30_000 });
});
