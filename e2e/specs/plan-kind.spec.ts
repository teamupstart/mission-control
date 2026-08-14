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
async function shoot(
  page: Page,
  name: string,
  target?: Locator,
  viewport: { width: number; height: number } = { width: 1280, height: 1100 },
): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // The backlog column is taller than the 720px default viewport and the COLUMN is what
  // scrolls, so an element screenshot at that size crops the last card away - and the last
  // card is the one these frames exist to show. Grown for the capture and put straight
  // back, so the assertions around it keep running at the size every other spec uses.
  //
  // Sized per frame rather than one size for all: a frame is read at whatever width it was
  // taken, so dead space around the subject is not neutral - it shrinks the subject when
  // the frame is scaled to fit a page, which is how a legible dialog becomes an unreadable
  // one. Each caller passes the box its subject actually occupies.
  const restore = page.viewportSize();
  await page.setViewportSize(viewport);
  // Off every control first: `Tooltip` portals a bubble under a resting pointer.
  await page.mouse.move(0, 0);
  // `animations: "disabled"` finishes any transition in flight and freezes it at its end
  // state. Without it a popover caught mid-fade is captured SEMI-TRANSPARENT, and the form
  // behind it reads straight through the options - which looks like a rendering bug in the
  // product rather than in the frame, and is exactly the wrong thing for a picture whose
  // whole job is to show that the control draws correctly.
  await (target ?? page).screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
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

/**
 * The hue angle of an sRGB triple, so two marks can be compared by the thing a reader
 * actually confuses - their place on the wheel - rather than by an exact string. Two
 * purples, one of them mixed toward `--fg`, are different values and the same colour.
 */
function hueOf([r0, g0, b0]: number[]): number {
  const [r, g, b] = [r0 / 255, g0 / 255, b0 / 255];
  const max = Math.max(r, g, b);
  const span = max - Math.min(r, g, b);
  if (span === 0) return 0;
  const sixth =
    max === r ? (g - b) / span : max === g ? (b - r) / span + 2 : (r - g) / span + 4;
  return ((sixth * 60) % 360 + 360) % 360;
}

/**
 * A rendered element's colour as an sRGB triple, RASTERIZED rather than parsed.
 *
 * `getComputedStyle().color` does not resolve to `rgb()` for every author value: a
 * `color-mix(in oklab, …)` - which is what `.bl-next` and half this stylesheet use - comes
 * back as a literal `oklab(0.744 0.063 -0.122)` string. Parsing three numbers out of that
 * and treating them as r/g/b silently produces a nonsense hue, which is exactly the wrong
 * answer to get from a test whose whole job is comparing two colours. Painting the value
 * into a 1x1 canvas makes the browser do the conversion it already knows how to do.
 */
function rgbOf(scope: Locator, selector: string): Promise<number[]> {
  return scope.evaluate((el, sel) => {
    const node = el.querySelector(sel);
    if (!node) throw new Error(`the card should draw ${sel}`);
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.fillStyle = getComputedStyle(node).color;
    ctx.fillRect(0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
  }, selector);
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

test("the guided pass offers plan as a listed option, with its blurb", async ({ dashboard }) => {
  // The `<select>` test above proves the values; this proves what a person actually READS
  // when choosing. The guided pass renders the kinds as a listbox with each option's blurb
  // beside it, so it is the one surface where `plan`'s copy - the half that says a plan
  // schedules the work it describes - is on screen rather than behind a collapsed control.
  const { dialog, kind } = await openDispatch(dashboard);
  await dialog.getByRole("switch", { name: "Guided" }).click();
  await expect(dialog.getByRole("navigation", { name: "Guided dispatch" })).toBeVisible();
  // Repo is the first question and takes the highlighted row on Enter.
  await dashboard.keyboard.press("Enter");

  const picker = dialog.getByRole("listbox", { name: "What kind of run is this?" });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("option")).toHaveCount(3);
  const planOption = picker.getByRole("option", { name: /^plan/ });
  await expect(planOption).toBeVisible();
  // The blurb, not just the word - this is the copy `TASK_KIND_INFO` exists to carry, and
  // the thing that tells a person what choosing `plan` will get them.
  await expect(planOption).toContainText("Produce a reviewed plan");
  await expect(planOption).toContainText("no after-work");
  // And its mnemonic, which is the letter the pass prints and a keyboard user presses.
  await expect(planOption).toContainText("l");

  // The whole viewport, not the dialog element: this picker is a portaled popover that
  // overflows the dialog's own box, so an element-scoped frame clips the third option -
  // which is the one the frame exists to show. Sized just past what the dialog and its
  // popover occupy, so the subject fills the frame instead of floating in dead space.
  await shoot(dashboard, "03-guided-kind-picker", undefined, { width: 1000, height: 800 });

  // Pressing it commits, so the frame above is of a live control rather than a decoration.
  await dashboard.keyboard.press("l");
  await expect(kind).toHaveValue("plan");
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
  // The plan task is seeded FIRST so it is the one `nextUpTaskId` picks, which puts the
  // "next up" chip on the same card as the kind chip. That is the busiest a plan card
  // gets, and it is the case worth driving rather than the quiet one - see the note on
  // the shared purple at the end of this test.
  await seedBacklogTask(daemon, "plan", "Plan the retry policy rewrite");
  await seedBacklogTask(daemon, "ship", "Rebuild the retry policy");
  await seedBacklogTask(daemon, "scout", "Audit the retry policy");
  await useBoardLayout(dashboard, daemon);

  const card = dashboard.locator(".bl-card", { hasText: "Plan the retry policy rewrite" });
  await expect(card).toBeVisible();
  // The word a person reads, in the chip slot rather than anywhere on the card.
  await expect(card.getByText("plan", { exact: true })).toBeVisible();

  // The three cards together, which is the only frame that shows the claim below as a
  // person meets it: three kinds, three colours, side by side in one column.
  await shoot(dashboard, "02-three-kind-chips", dashboard.locator("section.board-backlog"));

  /** One card's kind chip and its agent chip, which has no colour rule and inherits. */
  const chips = async (title: string): Promise<{ kind: number[]; inherited: number[] }> => {
    const row = dashboard.locator(".bl-card", { hasText: title });
    return {
      kind: await rgbOf(row, ".bl-kind"),
      inherited: await rgbOf(row, ".bl-agent"),
    };
  };

  const plan = await chips("Plan the retry policy rewrite");
  // The exact defect `.bl-kind-plan` exists to prevent: there is no fallback rule in this
  // family, so a kind added without one is the only chip on the card that is not coloured.
  expect(plan.kind, "the plan chip should be coloured, not inherited body text").not.toEqual(
    plan.inherited,
  );

  // And it is its OWN colour. Two kinds sharing one is a chip that has to be read rather
  // than recognised, which is the entire reason this family colours them at all.
  const ship = await chips("Rebuild the retry policy");
  const scout = await chips("Audit the retry policy");
  expect(
    new Set([plan.kind, ship.kind, scout.kind].map((c) => c.join(","))).size,
    "three kinds, three colours",
  ).toBe(3);

  // The known crowding, pinned as it currently STANDS rather than as it ought to be, so the
  // day somebody fixes it this line fails and points at the reasoning rather than letting
  // the fix land with no record that it was ever a considered trade. `.bl-next` is
  // `--pr-merged` mixed toward `--fg` and `--pr-merged` IS `--purple`, so this card wears
  // two purple-toned marks a line apart for two unrelated facts. The threshold is measured
  // rather than guessed: 262 degrees against 259, which is the same colour to a reader.
  // See the comment on `.bl-kind-plan` for why it is accepted here.
  await expect(
    card.locator(".bl-next"),
    "the plan card should be the one Foreman would pick up next",
  ).toBeVisible();
  const planHue = hueOf(plan.kind);
  const nextHue = hueOf(await rgbOf(card, ".bl-next"));
  expect(
    Math.abs(planHue - nextHue),
    `plan (${Math.round(planHue)}deg) and next up (${Math.round(nextHue)}deg) share a hue today - if this now differs, the family-wide colour pass landed and the note on .bl-kind-plan is stale`,
  ).toBeLessThan(20);
});
