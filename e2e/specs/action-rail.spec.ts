import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The Action detail screen, rebuilt on the Rail direction.
 *
 * An Action is the only Library asset carrying a MACHINE-CHECKED contract: the bound session
 * has to have a named skill, and something observable has to happen before a stage may call
 * it done. That contract was two unlabelled selects sitting third and fourth in a row of four
 * fields, so the screen never said what it would actually check.
 *
 * Four things here are browser facts rather than markup shapes:
 *
 * - the rail's sub-label is the contract, so the two shipped actions are told apart by the
 *   thing that differs. `test/session-action-library-render.test.ts` pins the string; only a
 *   browser proves the row it names OPENS;
 * - a completion chip has to open, change the condition, and have the change survive a save
 *   and a reload. A chip that only redrew its own state would pass every markup assertion and
 *   have written nothing;
 * - the contract line has to follow that change, because a sentence that agreed with the
 *   chips once and not afterwards is worse than no sentence;
 * - the overflow menu is a dismissible surface over Phase 1's Escape ladder. Whether one
 *   press closes the menu WITHOUT also leaving the page is a question about two listeners and
 *   one keystroke, and no other layer can answer it.
 *
 * No agent is launched and none is needed: the Library authors, it does not run.
 */

const EVIDENCE = artifactsDir("action-rail");

interface ActionRow {
  id: string;
  name: string;
  revision: number;
  builtin: boolean;
  requiredSkillId: string | null;
  completion: { kind: string };
  archivedAt: number | null;
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

/** One action of the operator's, beside the two this build ships. */
async function seedAction(daemon: DaemonHandle): Promise<string> {
  const action = await api<ActionRow>(daemon, "/api/session-actions", {
    name: "Rail action",
    description: "Tidy the workspace and say so.",
    promptMarkdown: "# Rail action\n\nRemove the stray scratch file and say so.\n",
    requiredSkillId: "retro",
    completion: { kind: "session_turn" },
  });
  return action.id;
}

const hash = (page: Page) => page.evaluate(() => location.hash);
const sidebar = (page: Page) => page.getByRole("complementary", { name: "Session action library" });
const nameField = (page: Page) => page.locator("section.wf-action-fields").getByLabel("Name");
const menuButton = (page: Page) => page.getByRole("button", { name: "More session action options" });
const contract = (page: Page) => page.locator("p.wf-action-contract");
/** An interactive property chip, by the property it carries. Its value is its own text. */
const chip = (page: Page, property: string): Locator =>
  page.getByRole("button", { name: new RegExp(`^${property}\\b`) });

/**
 * Photograph a state this spec has already asserted on, inside the test that asserted it, so
 * the picture and the measurement cannot drift apart. Behind `MC_E2E_EVIDENCE`, like every
 * other capture in this suite.
 */
async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Tooltip portals a bubble under a resting pointer that outlives the move by its own fade.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/action-rail/${name}.png`);
}

test("the rail groups what ships apart from what you wrote, and names each row by its contract", async ({
  dashboard,
  daemon,
}) => {
  await seedAction(daemon);
  const actions = await api<ActionRow[]>(daemon, "/api/session-actions");
  const shipped = actions.filter((action) => action.builtin);
  expect(shipped.length, "this build ships no built-in actions to group").toBeGreaterThan(1);

  await dashboard.goto(`${daemon.baseURL}/#/library/actions`);
  const rail = sidebar(dashboard);
  await expect(rail).toBeVisible();

  // Each head counts the rows drawn beneath it. `Yours 1` is the one an operator reads to
  // learn that the others were never theirs.
  await expect(rail.getByRole("heading", { name: new RegExp(`^Built-in\\s+${shipped.length}$`) }))
    .toBeVisible();
  await expect(rail.getByRole("heading", { name: /^Yours\s+1$/ })).toBeVisible();

  /*
   * The reason this sub-label changed. Pull Request and Retro have descriptions that restate
   * their titles, so the line that was meant to tell them apart told you nothing; their
   * CONTRACTS differ in both halves.
   */
  const pullRequest = rail.getByRole("button", { name: /Pull Request/ });
  const retro = rail.getByRole("button", { name: /^Retro/ });
  await expect(pullRequest).toContainText("Skill · pull-request · Pull request is opened and verified");
  await expect(retro).toContainText("Skill · retro · A commit lands in the checkout");
  await expect(pullRequest).not.toContainText("Prepare the reviewed work");
  await shoot(dashboard, "01-rail-groups");

  // A row opens from either group, which is the whole reason the grouping is allowed to
  // reorder the list at all.
  await pullRequest.click();
  await expect(nameField(dashboard)).toHaveValue("Pull Request");
  await rail.getByRole("button", { name: /Rail action/ }).click();
  await expect(nameField(dashboard)).toHaveValue("Rail action");

  // The archived filter moved below the list rather than away, and it carries its count - so
  // "is there anything in there?" is answered without pressing it.
  const archived = rail.getByRole("button", { name: /^Archived/ });
  await expect(archived).toBeVisible();
  await expect(archived).toHaveText(/Archived\s*0/);
});

test("the contract line states what will be checked, and follows the chip that decides it", async ({
  dashboard,
  daemon,
}) => {
  const actionId = await seedAction(daemon);
  await dashboard.goto(`${daemon.baseURL}/#/library/actions/${actionId}`);
  await expect(nameField(dashboard)).toHaveValue("Rail action");

  // Shut, the two chips answer their own question - which is what the four-field row they
  // replaced could not do without opening a `select`.
  await expect(chip(dashboard, "requires skill")).toContainText("retro");
  await expect(chip(dashboard, "completes when")).toContainText("Session turn finishes");

  // And the sentence they form is on the screen, in the words the daemon's own capability
  // table uses. Both halves: what the session must have, and what Mission Control observes.
  await expect(contract(dashboard)).toContainText("The stage sends this instruction to the bound session");
  await expect(contract(dashboard)).toContainText("must be able to invoke the retro skill");
  await expect(contract(dashboard)).toContainText("Session turn finishes");
  await shoot(dashboard, "02-contract-line");

  await chip(dashboard, "completes when").click();
  const popover = dashboard.getByRole("group", { name: "Completes when" });
  await expect(popover).toBeVisible();
  await shoot(dashboard, "03-completion-chip-open");

  // The control is the one that was in the field row, not a reimplementation of it - the same
  // options, offered only for what this daemon reports it can prove.
  const picker = popover.getByRole("combobox", { name: "Completes when" });
  await expect(picker.locator("option")).toHaveText([
    "Session turn finishes",
    "Pull request is opened and verified",
    "A commit lands in the checkout",
  ]);
  await picker.selectOption({ label: "A commit lands in the checkout" });
  await dashboard.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);

  // Read straight off the shut chip, and off the sentence beneath it. The line following the
  // chip is the assertion: a contract that agreed once and not afterwards is worse than none.
  await expect(chip(dashboard, "completes when")).toContainText("A commit lands in the checkout");
  await expect(contract(dashboard)).toContainText("A commit lands in the checkout");
  await expect(contract(dashboard)).not.toContainText("Session turn finishes");

  await dashboard.getByRole("button", { name: "Save" }).click();
  await expect(dashboard.locator("article.wf-action-editor p.workflow-eyebrow"))
    .toHaveText("Revision 2");

  // The round trip is what makes it a save rather than a redraw.
  const saved = await api<ActionRow>(daemon, `/api/session-actions/${actionId}`);
  expect(saved.completion.kind).toBe("repo_commit");
  await dashboard.reload();
  await expect(nameField(dashboard)).toHaveValue("Rail action");
  await expect(chip(dashboard, "completes when")).toContainText("A commit lands in the checkout");
  await expect(contract(dashboard)).toContainText("A commit lands in the checkout");
  await shoot(dashboard, "04-completion-changed");

  /*
   * And the chip stops claiming Escape the moment it is shut. Closing returns focus TO the
   * chip, so a popover that answered the key whenever focus was inside it would leave the
   * PAGE's Escape dead for as long as that chip kept focus - Phase 1's contract, undone by a
   * dismissible surface. Two presses: one for the popover, one for the page.
   */
  await chip(dashboard, "completes when").click();
  await dashboard.keyboard.press("Escape");
  await expect(dashboard.getByRole("group", { name: "Completes when" })).toHaveCount(0);
  await dashboard.keyboard.press("Escape");
  await expect.poll(() => hash(dashboard)).toBe("#/library");
});

test("a completion this build cannot prove stays visible and marked, not hidden in a dropdown", async ({
  dashboard,
  daemon,
}) => {
  // The stored kind is kept whatever this daemon says, or the next save would quietly rewrite
  // the proof contract the action was authored with. What the Rail direction adds is that the
  // refusal is READABLE while the control is shut: it used to be a disabled `<option>` inside
  // a `<select>` nobody had opened.
  const action = await api<ActionRow>(daemon, "/api/session-actions", {
    name: "Ships it",
    promptMarkdown: "# Ships it\n\nOpen the pull request.\n",
    completion: { kind: "pull_request" },
  });
  await dashboard.route("**/api/session-actions/capabilities", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      completions: [
        { kind: "session_turn", available: true, label: "Session turn finishes", unavailableReason: null },
        {
          kind: "pull_request",
          available: false,
          label: "Pull request is opened and verified",
          unavailableReason: "This build cannot verify a pull request yet.",
        },
      ],
    }),
  }));

  await dashboard.goto(`${daemon.baseURL}/#/library/actions/${action.id}`);
  await expect(nameField(dashboard)).toHaveValue("Ships it");

  // Marked on the chip's face, explained beside it, and still stated by the contract line -
  // the action's own guarantee is not this build's to quietly edit.
  await expect(dashboard.locator(".lib-chip.is-attention"))
    .toContainText("Pull request is opened and verified");
  await expect(dashboard.locator("p.lib-props-note"))
    .toHaveText("This build cannot verify a pull request yet.");
  await expect(contract(dashboard)).toContainText("Pull request is opened and verified");
  await shoot(dashboard, "05-unprovable-completion");

  // And it cannot be chosen: the option is there to be read, disabled. Asserted as the
  // attribute rather than through `toBeDisabled`, which reports an `<option>` inside an
  // enabled `<select>` as enabled.
  await chip(dashboard, "completes when").click();
  const retained = dashboard.getByRole("group", { name: "Completes when" })
    .getByRole("option", { name: "Pull request is opened and verified" });
  await expect(retained).toHaveAttribute("disabled", "");
});

test("while the capability answer is in flight, the chip claims nothing", async ({
  dashboard,
  daemon,
}) => {
  /*
   * The inverse of the test above, and the reason it needs a browser: the mark is correct only
   * once there is an ANSWER to be marked by. Every editor opens before the capabilities request
   * lands - `useSessionActionCapabilities` starts empty and loading - and the retained arm is
   * "selected, and not among what has been offered", which is true of every action for that
   * whole window. Reading it ungated drew the chip amber and stated "This build cannot prove
   * the completion this action names" about actions this daemon proves perfectly well.
   *
   * The window is HELD open rather than raced against, so the two states are asserted on one
   * page with one variable between them: the answer arrived.
   */
  const action = await api<ActionRow>(daemon, "/api/session-actions", {
    name: "Ships it later",
    promptMarkdown: "# Ships it later\n\nOpen the pull request.\n",
    completion: { kind: "pull_request" },
  });

  let answer = (): void => {};
  const held = new Promise<void>((resolve) => { answer = resolve; });
  await dashboard.route("**/api/session-actions/capabilities", async (route) => {
    await held;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        completions: [
          { kind: "session_turn", available: true, label: "Session turn finishes", unavailableReason: null },
          {
            kind: "pull_request",
            available: false,
            label: "Pull request is opened and verified",
            unavailableReason: "This build cannot verify a pull request yet.",
          },
        ],
      }),
    });
  });

  await dashboard.goto(`${daemon.baseURL}/#/library/actions/${action.id}`);
  await expect(nameField(dashboard)).toHaveValue("Ships it later");

  // Present first, so the absences beneath it are facts about the state and not about a chip
  // that had not drawn yet. The value is the stored completion, in the shared words - the one
  // string this screen owns, which needs no daemon to print.
  await expect(chip(dashboard, "completes when")).toContainText("Pull request is opened and verified");
  await expect(dashboard.locator(".lib-chip.is-attention")).toHaveCount(0);
  await expect(dashboard.locator("p.lib-props-note")).toHaveCount(0);
  // Its description is the ordinary one - what the field IS, rather than a verdict on it. The
  // positive half is what stops the negative from passing on a page with no tooltips at all.
  await expect(dashboard.locator("span.tt-desc", {
    hasText: "What Mission Control must observe before the stages after this action run",
  })).toHaveCount(1);
  await expect(dashboard.locator("span.tt-desc", {
    hasText: "This build cannot prove the completion this action names",
  })).toHaveCount(0);
  // And the sentence beneath states the action's own contract throughout, unqualified.
  await expect(contract(dashboard)).toContainText("Pull request is opened and verified");
  await shoot(dashboard, "08-capabilities-in-flight");

  answer();

  // The answer lands, and it is a real no: now the chip marks and says whose refusal it is.
  await expect(dashboard.locator(".lib-chip.is-attention"))
    .toContainText("Pull request is opened and verified");
  await expect(dashboard.locator("p.lib-props-note"))
    .toHaveText("This build cannot verify a pull request yet.");
});

test("the overflow menu holds Archive, and Escape closes it without leaving the page", async ({
  dashboard,
  daemon,
}) => {
  const actionId = await seedAction(daemon);
  await dashboard.goto(`${daemon.baseURL}/#/library/actions/${actionId}`);
  await expect(nameField(dashboard)).toHaveValue("Rail action");

  // Shut, the menu's rows are not on the page at all - which is the point, and also why the
  // absence below is worth asserting: it is made present first, three lines down.
  const menu = dashboard.getByRole("menu", { name: "More session action options" });
  await expect(menu).toHaveCount(0);

  await menuButton(dashboard).click();
  await expect(menu).toBeVisible();
  for (const label of ["Duplicate", "Archive"]) {
    await expect(menu.getByRole("menuitem", { name: label })).toBeVisible();
  }
  await shoot(dashboard, "06-overflow-menu");

  /*
   * The keystroke this phase could most easily have broken. Two things want Escape here: the
   * menu, and Phase 1's page ladder. The menu answers it in React and marks the press
   * handled, so the ladder stands down - one press closes the menu and the page stays put.
   */
  await dashboard.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect.poll(() => hash(dashboard)).toBe(`#/library/actions/${actionId}`);

  // And the ladder is still live underneath it, rather than having been spent.
  await dashboard.keyboard.press("Escape");
  await expect.poll(() => hash(dashboard)).toBe("#/library");

  // Archive is reached through the menu and does what it says, with the one dialog that
  // states what survives it.
  await dashboard.goto(`${daemon.baseURL}/#/library/actions/${actionId}`);
  await menuButton(dashboard).click();
  await menu.getByRole("menuitem", { name: "Archive" }).click();
  const dialog = dashboard.getByRole("dialog", { name: /Archive Rail action/ });
  await expect(dialog).toContainText("Every published version keeps the snapshot it was published with");
  await dialog.getByRole("button", { name: "Archive session action" }).click();
  await expect
    .poll(async () => (await api<ActionRow>(daemon, `/api/session-actions/${actionId}`)).archivedAt)
    .not.toBe(null);
});

test("a built-in promotes Duplicate, offers no Save, and has no menu to open", async ({
  dashboard,
  daemon,
}) => {
  const actionId = await seedAction(daemon);

  // Present first, so both absences below are facts about built-ins rather than about the
  // selectors.
  await dashboard.goto(`${daemon.baseURL}/#/library/actions/${actionId}`);
  await expect(nameField(dashboard)).toHaveValue("Rail action");
  await expect(dashboard.getByRole("button", { name: "Save" })).toBeVisible();
  await expect(menuButton(dashboard)).toBeVisible();

  // Reached through the rail rather than the address bar, which is both the real path and the
  // only one that works: the route seeds the selection as this surface MOUNTS.
  await sidebar(dashboard).getByRole("button", { name: /Pull Request/ }).click();
  await expect(nameField(dashboard)).toHaveValue("Pull Request");

  /*
   * Save sat first in this header permanently disabled on both shipped actions, which reads as
   * "the thing you want, unavailable" when the thing you want is one control to its right. And
   * the menu is not an empty `⋯`: Duplicate is promoted and Archive is a write a built-in
   * cannot take, so there is nothing behind it to open.
   */
  await expect(dashboard.getByRole("button", { name: "Save" })).toHaveCount(0);
  await expect(menuButton(dashboard)).toHaveCount(0);
  const duplicate = dashboard.getByRole("button", { name: "Duplicate to edit" });
  await expect(duplicate).toBeVisible();
  await expect(nameField(dashboard)).toHaveAttribute("readonly", "");
  await shoot(dashboard, "07-builtin-promotes-duplicate");

  // And it does what it says: an editable copy carrying the contract it was duplicated FOR,
  // which is the whole reason a copy of a shipped action is allowed to keep an adapter a new
  // draft would have to prove.
  await duplicate.click();
  await expect(nameField(dashboard)).toHaveValue("Pull Request copy");
  await expect(nameField(dashboard)).not.toHaveAttribute("readonly", "");
  await expect(chip(dashboard, "completes when")).toContainText("Pull request is opened and verified");
  await expect(chip(dashboard, "requires skill")).toContainText("pull-request");
  await expect(dashboard.getByRole("button", { name: "Save" })).toBeEnabled();
});
