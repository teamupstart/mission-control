import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Getting back OUT of a Library detail screen.
 *
 * The bug: opening a Persona, an Action or a Command was a dead end. Escape did nothing, no
 * screen drew a back control, and the only thing on the page that navigated to `#/library`
 * was the topbar's Library segment - already painted `aria-current`, so it reads as the page
 * you are on rather than the way out of it.
 *
 * This is the layer that can prove the fix, and the only one. The ladder's decision order is
 * a pure function `test/` pins in a millisecond, and the back row is a markup shape a render
 * test walks - but neither can tell you whether Escape inside CodeMirror leaves the EDITOR
 * rather than the page, whether the second press then lands on `#/library`, or whether a
 * dirty draft raises the leave-with-unsaved-changes dialog instead of being discarded. Those
 * are browser facts: a real focus, a real `contenteditable`, a real keydown reaching `window`.
 *
 * No agent is launched and none is needed - the Library authors, it does not run. Every asset
 * below is seeded over HTTP, which is also what makes the dirty cases honest: the draft is
 * dirty because something was typed into the running screen, not because a fixture said so.
 */

const EVIDENCE = artifactsDir("library-exit");

/** The three detail screens, by the rail landmark each one draws. */
const RAILS = {
  personas: "Persona library",
  actions: "Session action library",
  commands: "Command library",
} as const;

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

/** One Persona and one Action, so two of the three screens have an operator's asset open. */
async function seedAssets(daemon: DaemonHandle): Promise<{ personaId: string; actionId: string }> {
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: "Exit reviewer",
    description: "Reads the diff and says whether it holds.",
    guidanceMarkdown: "# Exit reviewer\n\nJudge the change.",
  });
  const action = await api<{ id: string }>(daemon, "/api/session-actions", {
    name: "Exit action",
    description: "Runs the migration and pastes the output.",
    promptMarkdown: "# Exit action\n\nRun it.",
    completion: { kind: "session_turn" },
  });
  return { personaId: persona.id, actionId: action.id };
}

const backRow = (page: Page) => page.getByRole("button", { name: "Back to Library" });
const gate = (page: Page) => page.getByRole("dialog", { name: "Leave with unsaved changes" });

const hash = (page: Page) => page.evaluate(() => location.hash);

/**
 * Photograph a state this spec has already asserted on, inside the test that asserted it -
 * the convention `library.spec.ts` and `line-drawers.spec.ts` both follow, so the picture and
 * the measurement cannot drift apart. Behind `MC_E2E_EVIDENCE`, like every other capture here.
 */
async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Tooltip portals a bubble under a resting pointer, and it outlives the move by its own
  // fade - so this waits for the bubble to go rather than only for the pointer to leave.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  console.log(`CAPTURED e2e/.artifacts/library-exit/${name}.png`);
}

test("every detail screen draws a way out, and it lands on the Library", async ({
  dashboard,
  daemon,
}) => {
  const { personaId, actionId } = await seedAssets(daemon);
  const routes = {
    personas: `#/library/personas/${personaId}`,
    actions: `#/library/actions/${actionId}`,
    commands: "#/library/commands/test",
  };

  for (const surface of ["personas", "actions", "commands"] as const) {
    await dashboard.goto(`${daemon.baseURL}/${routes[surface]}`);
    await expect(dashboard.getByRole("complementary", { name: RAILS[surface] })).toBeVisible();

    // Visible without hunting, and it says where it goes rather than only drawing an arrow.
    await expect(backRow(dashboard)).toBeVisible();
    await shoot(dashboard, `back-row-${surface}`);

    await backRow(dashboard).click();
    await expect.poll(() => hash(dashboard)).toBe("#/library");
    // The shelves, not a blank pane - the row leaves for the index it came from.
    await expect(dashboard.getByRole("heading", { name: "Who does the reviewing?" }))
      .toBeVisible();
  }
});

test("Escape leaves every detail screen for the Library", async ({ dashboard, daemon }) => {
  const { personaId, actionId } = await seedAssets(daemon);
  const routes = {
    personas: `#/library/personas/${personaId}`,
    actions: `#/library/actions/${actionId}`,
    commands: "#/library/commands/test",
  };

  for (const surface of ["personas", "actions", "commands"] as const) {
    await dashboard.goto(`${daemon.baseURL}/${routes[surface]}`);
    await expect(dashboard.getByRole("complementary", { name: RAILS[surface] })).toBeVisible();

    // Nothing focused, so the press is the page's to answer. This is the exact keystroke
    // that did nothing at all before: `App.tsx` returns for any page that is not the fleet
    // above its whole Escape ladder, and no Library surface registered one.
    await dashboard.keyboard.press("Escape");
    await expect.poll(() => hash(dashboard)).toBe("#/library");
  }
});

test("Escape inside the guidance editor leaves the editor, and the next one leaves the page", async ({
  dashboard,
  daemon,
}) => {
  const { personaId } = await seedAssets(daemon);
  await dashboard.goto(`${daemon.baseURL}/#/library/personas/${personaId}`);

  // The pane that fills the screen, and the reason a copied `SettingsPage` handler would
  // have been dead here: CodeMirror's content host is `contenteditable`, which that handler
  // bails on. Focus it the way an operator does.
  const guidance = dashboard.locator(".persona-editor-host .cm-content");
  await guidance.click();
  await expect(guidance).toBeFocused();

  // One press, one layer. With a collapsed cursor CodeMirror takes none of its three Escape
  // bindings, so the press bubbles unanswered and the ladder spends it on the editor.
  await dashboard.keyboard.press("Escape");
  await expect(guidance).not.toBeFocused();
  // And it did NOT also leave: the route is exactly where it was.
  expect(await hash(dashboard)).toBe(`#/library/personas/${personaId}`);
  await expect(dashboard.getByRole("complementary", { name: "Persona library" })).toBeVisible();

  // The keyboard is out of the editor, so the second press is the page's.
  await dashboard.keyboard.press("Escape");
  await expect.poll(() => hash(dashboard)).toBe("#/library");
});

test("with a selection live, CodeMirror takes the first press and the ladder takes the rest", async ({
  dashboard,
  daemon,
}) => {
  // Recorded as INTENDED, not tolerated. `basicSetup` binds Escape to `simplifySelection`,
  // and CodeMirror calls `preventDefault()` exactly when a bound command takes the press - so
  // a live selection makes this three presses rather than two, and each one is a layer the
  // operator can see go. A later reader who counts presses and "fixes" it to two would be
  // taking the selection-collapse away from the editor, or navigating over it.
  const { personaId } = await seedAssets(daemon);
  await dashboard.goto(`${daemon.baseURL}/#/library/personas/${personaId}`);
  const guidance = dashboard.locator(".persona-editor-host .cm-content");
  await guidance.click();
  await dashboard.keyboard.press("ControlOrMeta+a");
  await expect(dashboard.locator(".persona-editor-host .cm-selectionBackground")).not.toHaveCount(0);

  // One: the selection collapses. The editor keeps focus and the page does not move.
  await dashboard.keyboard.press("Escape");
  await expect(dashboard.locator(".persona-editor-host .cm-selectionBackground")).toHaveCount(0);
  await expect(guidance).toBeFocused();
  expect(await hash(dashboard)).toBe(`#/library/personas/${personaId}`);

  // Two: the editor. Three: the page.
  await dashboard.keyboard.press("Escape");
  await expect(guidance).not.toBeFocused();
  expect(await hash(dashboard)).toBe(`#/library/personas/${personaId}`);
  await dashboard.keyboard.press("Escape");
  await expect.poll(() => hash(dashboard)).toBe("#/library");
});

test("Escape in a plain field leaves the field first, so a half-typed name is not a back button", async ({
  dashboard,
  daemon,
}) => {
  const { actionId } = await seedAssets(daemon);
  await dashboard.goto(`${daemon.baseURL}/#/library/actions/${actionId}`);

  // The same rung the CodeMirror case takes, and the reason it is one rule rather than a
  // special case: leaving the page out from under a half-typed field is not a back button,
  // which is the contract `SettingsPage` states for its own Escape.
  const name = dashboard.locator("section.wf-action-fields").getByLabel("Name");
  await name.click();
  await expect(name).toBeFocused();

  await dashboard.keyboard.press("Escape");
  await expect(name).not.toBeFocused();
  expect(await hash(dashboard)).toBe(`#/library/actions/${actionId}`);

  await dashboard.keyboard.press("Escape");
  await expect.poll(() => hash(dashboard)).toBe("#/library");
});

test("a dirty draft holds both exits, and cancelling keeps the page and the typing", async ({
  dashboard,
  daemon,
}) => {
  const { personaId } = await seedAssets(daemon);
  await dashboard.goto(`${daemon.baseURL}/#/library/personas/${personaId}`);
  const name = dashboard.locator("section.persona-fields").getByLabel("Name");
  await expect(name).toHaveValue("Exit reviewer");
  await name.fill("Exit reviewer, edited");

  // The back row first. Both exits route through the router's `navigate`, so the gate that
  // already guards a topbar click guards these too - there is no second navigation path.
  await backRow(dashboard).click();
  await expect(gate(dashboard)).toBeVisible();
  await shoot(dashboard, "dirty-gate");

  // While the dialog is up, Escape belongs to IT. One press closes the dialog and the page
  // stays - if the ladder answered over the overlay, this press would both cancel the gate
  // and immediately re-ask it, or worse, leave.
  await dashboard.keyboard.press("Escape");
  await expect(gate(dashboard)).toHaveCount(0);
  expect(await hash(dashboard)).toBe(`#/library/personas/${personaId}`);
  await expect(name).toHaveValue("Exit reviewer, edited");

  // Now Escape. The keyboard is in the name field after the fill, so the first press leaves
  // the field and the second asks the page - which is the gate, not a discard.
  await name.click();
  await dashboard.keyboard.press("Escape");
  await dashboard.keyboard.press("Escape");
  await expect(gate(dashboard)).toBeVisible();

  // Staying keeps the route and the draft.
  await gate(dashboard).getByRole("button", { name: "Cancel" }).click();
  expect(await hash(dashboard)).toBe(`#/library/personas/${personaId}`);
  await expect(name).toHaveValue("Exit reviewer, edited");

  // And leaving anyway does leave, once, with no second dialog behind it.
  await dashboard.keyboard.press("Escape");
  await expect(gate(dashboard)).toBeVisible();
  await gate(dashboard).getByRole("button", { name: "Discard and leave" }).click();
  await expect.poll(() => hash(dashboard)).toBe("#/library");
  await expect(dashboard.getByRole("dialog")).toHaveCount(0);
});

test("a dirty Command holds Escape too, and its draft survives the question", async ({
  dashboard,
  daemon,
}) => {
  // Commands is the surface that never received `isOverlayOpen`, so it is the one where a
  // ladder that forgot to stand down would answer over its own dialog. It also has no
  // document editor, which makes it the cleanest check that the gate is reached from a
  // plain field.
  await dashboard.goto(`${daemon.baseURL}/#/library/commands/test`);
  const command = dashboard.getByLabel("Default command");
  await command.fill("npm test");

  // Field first, then the page.
  await dashboard.keyboard.press("Escape");
  await expect(command).not.toBeFocused();
  await dashboard.keyboard.press("Escape");
  await expect(gate(dashboard)).toBeVisible();

  await gate(dashboard).getByRole("button", { name: "Cancel" }).click();
  await expect.poll(() => hash(dashboard)).toBe("#/library/commands/test");
  await expect(command).toHaveValue("npm test");
});

test("the builder rail carries the same exit, so the four surfaces do not disagree", async ({
  dashboard,
  daemon,
}) => {
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "Exit workflow",
    description: "One reviewer, for the exit spec.",
  });
  await dashboard.goto(`${daemon.baseURL}/#/library/workflows/${workflow.workflow.id}`);
  await expect(dashboard.getByRole("complementary", { name: "Workflow library and node palette" }))
    .toBeVisible();

  await expect(backRow(dashboard)).toBeVisible();
  await shoot(dashboard, "back-row-workflows");
  await dashboard.keyboard.press("Escape");
  await expect.poll(() => hash(dashboard)).toBe("#/library");
});
