import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

const EVIDENCE = artifactsDir("plan-kind");

/**
 * A frame of the state the assertion beside it just proved, behind `MC_E2E_EVIDENCE` so an
 * ordinary run does not rewrite a binary for no added signal. What a picture adds here is
 * the half the DOM cannot carry: that the new option reads as a peer of the two beside it
 * rather than as something bolted on, and that the chip is coloured rather than merely
 * present.
 */
async function shoot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // The backlog column is taller than the 720px default viewport and the COLUMN is what
  // scrolls, so an element screenshot at that size crops the last card away - and the last
  // card is the one these frames exist to show. Grown for the capture and put straight
  // back, so the assertions around it keep running at the size every other spec uses.
  const restore = page.viewportSize();
  await page.setViewportSize({ width: 1280, height: 1100 });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer.
  await page.mouse.move(0, 0);
  await (target ?? page).screenshot({ path: `${EVIDENCE}${name}.png` });
  if (restore) await page.setViewportSize(restore);
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/plan-kind/${name}.png`);
}

/**
 * `plan`, the third task Kind, through the surfaces a person actually meets it on.
 *
 * Everything here is about a kind being OFFERED and DRAWN, which is exactly the class of
 * failure the layers below this one cannot see. `plan` was added to a tuple that two
 * registries are typed over, so those two could not compile without it - and every other
 * surface degraded silently instead. A `<select>` that hand-writes its options compiles
 * cleanly while quietly offering two of three; a chip whose colour rule was never written
 * renders in body text and looks like a bug in the card. Both are green in `test/` and
 * wrong on screen, so they are pinned in a browser or they are not pinned.
 *
 * The after-work rule gets the most room because it is the one thing here with STATE. It
 * is not "plan means None" - it is a stash-and-restore that has to survive the operator
 * changing their mind, including through the case that only exists now that there are two
 * diffless kinds: ship to scout to plan and back, where the naive implementation puts the
 * `null` scout just set into the stash and hands that back as an explicit "no handoff"
 * over a task that had one.
 *
 * No dispatch is submitted and no task is dispatched by any test in this file - the modal
 * is opened, driven and closed, and the seeded tasks stay in the backlog. Nothing here
 * launches an agent binary, faked or otherwise, and nothing spends model tokens.
 */

/** Open the dispatch modal and hand back its dialog plus the two selects in play. */
async function openDispatch(page: Page): Promise<{
  dialog: Locator;
  kind: Locator;
  afterWork: Locator;
}> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();

  // By accessible name, not by position. `getByRole` rather than `getByLabel`, which finds
  // neither: each select is wrapped in a `Tooltip`, and the merged-handler child is not the
  // direct label child that Playwright's implicit-label lookup walks.
  const kind = dialog.getByRole("combobox", { name: "Kind", exact: true });
  const afterWork = dialog.getByRole("combobox", { name: "After work", exact: true });

  // The machine's Workflow config arrives over its own fetch, and until it lands the
  // default option renders as "loading…". Gating on that copy disappearing means the
  // assertions below read a settled control rather than racing the fetch.
  await expect
    .poll(() => selectedLabel(afterWork), {
      message: "the Workflow config fetch should settle the after-work default option",
    })
    .not.toContain("loading");

  return { dialog, kind, afterWork };
}

/**
 * The text of a `<select>`'s chosen option.
 *
 * Read with `evaluate` rather than asserted with `toContainText`: Playwright matches text
 * against RENDERED text, and the options of a collapsed `<select>` render none.
 */
function selectedLabel(select: Locator): Promise<string> {
  return select.evaluate(
    (el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent?.trim() ?? "",
  );
}

/** Every option a `<select>` offers, as `[value, text]`, in document order. */
function optionPairs(select: Locator): Promise<[string, string][]> {
  return select.evaluate((el) =>
    [...(el as HTMLSelectElement).options].map(
      (o) => [o.value, o.textContent?.trim() ?? ""] as [string, string],
    ),
  );
}

/** The id of the published Workflow whose option label starts with `prefix`. */
async function workflowOptionId(afterWork: Locator, prefix: string): Promise<string> {
  const id = await afterWork.evaluate(
    (el, want) =>
      [...(el as HTMLSelectElement).options].find((o) => o.textContent?.trim().startsWith(want))
        ?.value ?? null,
    prefix,
  );
  expect(id, `no published Workflow option named ${prefix}`).toBeTruthy();
  return id!;
}

/** Seed a task of `kind` into the backlog, titled so its card can be found by name. */
async function seedBacklogTask(
  daemon: DaemonHandle,
  kind: string,
  title: string,
): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repoRoot: daemon.repo,
      title,
      intent: `work of kind ${kind}`,
      kind,
      agent: "claude",
      backlog: true,
    }),
  });
  expect(response.ok, `seeding a ${kind} task answered ${response.status}`).toBe(true);
}

/** The Board, which is the only layout that draws the backlog as a column of cards. */
async function useBoardLayout(page: Page, daemon: DaemonHandle): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "board" }),
  });
  const body = (await response.json()) as { config?: { layout?: string } };
  expect(body.config?.layout, "the daemon accepted the Board layout").toBe("board");
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();
}

test("the Kind picker offers plan, after ship and scout", async ({ dashboard }) => {
  const { kind } = await openDispatch(dashboard);

  // Values AND text AND order, in one assertion, because each is a separate contract:
  // the value is what the route validates, the text is what a person reads, and the order
  // is the tuple's - `ship` leads because it is the default, and `plan` was appended
  // rather than inserted so nothing that indexes the tuple moved.
  expect(await optionPairs(kind)).toEqual([
    ["ship", "ship"],
    ["scout", "scout"],
    ["plan", "plan"],
  ]);
  await expect(kind).toHaveValue("ship");
});

test("choosing plan defaults the after-work Workflow to None", async ({ dashboard }) => {
  const { dialog, kind, afterWork } = await openDispatch(dashboard);

  // Precondition, asserted rather than assumed: a fresh ship dispatch defers to the
  // machine default, which ships armed with the built-in review. If this ever started out
  // on None the test below would pass without the feature existing.
  await expect(afterWork).toHaveValue("__default");
  await expect(dialog.getByText("Foreman complete")).toBeVisible();

  await kind.selectOption("plan");

  await expect(afterWork).toHaveValue("__none");
  // The option a person actually reads, not just the value behind it.
  expect(await selectedLabel(afterWork)).toContain("finish without a Workflow");
  // And the rail beside the select agrees, so the consequence is legible without opening
  // the dropdown.
  await expect(dialog.getByText("No handoff")).toBeVisible();
  await expect(dialog.getByText("Foreman complete")).toBeHidden();

  await shoot(dashboard, "01-plan-clears-after-work", dialog);
});

test("switching back to ship hands the plan switch's stash back", async ({ dashboard }) => {
  const { dialog, kind, afterWork } = await openDispatch(dashboard);

  await kind.selectOption("plan");
  await expect(afterWork).toHaveValue("__none");

  await kind.selectOption("ship");

  // Reversible in one gesture. A plan that left the select pinned on None would be a trap:
  // the operator changes their mind about the kind and silently loses the handoff, with no
  // field on screen having been touched.
  await expect(afterWork).toHaveValue("__default");
  await expect(dialog.getByText("Foreman complete")).toBeVisible();
});

test("plan only defaults the Workflow, it does not lock it", async ({ dashboard }) => {
  const { dialog, kind, afterWork } = await openDispatch(dashboard);

  await kind.selectOption("plan");
  await expect(afterWork).toHaveValue("__none");

  const builtinId = await workflowOptionId(afterWork, "No-Mistakes Review");
  await afterWork.selectOption(builtinId);

  // A plan CAN still hand off - the kind picks the default, it does not remove the choice -
  // and the pick survives rather than being snapped back to None.
  await expect(afterWork).toHaveValue(builtinId);
  await expect(kind).toHaveValue("plan");
  await expect(dialog.getByText("Foreman complete")).toBeVisible();
});

test("a Workflow picked by hand after choosing plan is not reverted by a later kind switch", async ({
  dashboard,
}) => {
  const { kind, afterWork } = await openDispatch(dashboard);
  const builtinId = await workflowOptionId(afterWork, "No-Mistakes Review");

  // Plan puts the dispatch default aside, then the operator chooses for themselves.
  await kind.selectOption("plan");
  await afterWork.selectOption(builtinId);

  await kind.selectOption("ship");

  // Their choice stands. Handing back what plan put aside here would revert a selection the
  // operator made after it, underneath them.
  await expect(afterWork).toHaveValue(builtinId);
});

test("a trip through both diffless kinds still returns the original selection", async ({
  dashboard,
}) => {
  const { dialog, kind, afterWork } = await openDispatch(dashboard);
  await expect(afterWork).toHaveValue("__default");

  // The case that only exists because there are now TWO kinds with no diff. Both sides of
  // the scout-to-plan switch want None, and an implementation that stashes on every entry
  // to a diffless kind stashes the `null` scout just set - overwriting the real selection,
  // and then handing that `null` back on the way out as an explicit "no handoff" saved over
  // a task that had one. Nothing is decided between two diffless kinds, so nothing moves.
  await kind.selectOption("scout");
  await expect(afterWork).toHaveValue("__none");
  await kind.selectOption("plan");
  await expect(afterWork).toHaveValue("__none");

  await kind.selectOption("ship");

  await expect(afterWork).toHaveValue("__default");
  await expect(dialog.getByText("Foreman complete")).toBeVisible();
});

test("a plan task draws its own kind chip on the backlog card", async ({ dashboard, daemon }) => {
  // All three, because the claim is not "plan renders" - a chip with no colour rule renders
  // perfectly well, in body text, and looks like a card that failed to style itself. The
  // claim is that plan is drawn AS A KIND, the way its two siblings are.
  await seedBacklogTask(daemon, "ship", "Rebuild the retry policy");
  await seedBacklogTask(daemon, "scout", "Audit the retry policy");
  await seedBacklogTask(daemon, "plan", "Plan the retry policy rewrite");
  await useBoardLayout(dashboard, daemon);

  const card = dashboard.locator(".bl-card", { hasText: "Plan the retry policy rewrite" });
  await expect(card).toBeVisible();
  // The word a person reads, in the chip slot rather than anywhere on the card.
  await expect(card.getByText("plan", { exact: true })).toBeVisible();

  // The three cards together, which is the only frame that shows the claim below as a
  // person meets it: three kinds, three colours, side by side in one column.
  await shoot(dashboard, "02-three-kind-chips", dashboard.locator("section.board-backlog"));

  /** The chip colour beside the agent chip's, which has no colour rule and inherits. */
  const colours = async (title: string): Promise<{ kind: string; inherited: string }> =>
    dashboard.locator(".bl-card", { hasText: title }).evaluate((el) => {
      const kind = el.querySelector(".bl-kind");
      const agent = el.querySelector(".bl-agent");
      if (!kind || !agent) throw new Error("the card should draw a kind chip and an agent chip");
      return {
        kind: getComputedStyle(kind).color,
        inherited: getComputedStyle(agent).color,
      };
    });

  const plan = await colours("Plan the retry policy rewrite");
  // The exact defect `.bl-kind-plan` exists to prevent: there is no fallback rule in this
  // family, so a kind added without one is the only chip on the card that is not coloured.
  expect(plan.kind, "the plan chip should be coloured, not inherited body text").not.toBe(
    plan.inherited,
  );

  // And it is its OWN colour. Two kinds sharing one is a chip that has to be read rather
  // than recognised, which is the entire reason this family colours them at all.
  const ship = await colours("Rebuild the retry policy");
  const scout = await colours("Audit the retry policy");
  expect(new Set([plan.kind, ship.kind, scout.kind]).size, "three kinds, three colours").toBe(3);
});
