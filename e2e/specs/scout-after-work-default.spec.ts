import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";

/**
 * Kind carries the after-work Workflow with it.
 *
 * A scout investigates and reports - it has no delivered change to hand off - so choosing
 * it defaults the after-work Workflow to None instead of leaving the dispatch default
 * armed. Without that, every scout inherits the machine's review Workflow and runs a
 * change-review over a task that never set out to produce a diff.
 *
 * Driven through the browser because the claim is about what the FORM does in response to
 * a selection: the reducer has no opinion here, and neither `renderToStaticMarkup` nor the
 * route tests can see one select move because another one changed.
 *
 * No dispatch is submitted by any test in this file, so nothing here launches an agent
 * binary and nothing spends model tokens - the modal is opened, driven, and closed.
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

  // By accessible name, not by position: both are plain selects in the same dialog, and an
  // index would silently follow whichever field is added next to the Crew row.
  //
  // `getByRole` rather than `getByLabel`, which finds neither: each select is wrapped in a
  // `Tooltip`, and the merged-handler child is not the direct label child that Playwright's
  // implicit-label lookup walks. The accessible name itself is correct either way - which is
  // the property worth pinning, and what a screen reader reads out.
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
 * Read with `evaluate` rather than asserted with `toContainText`, and looked up by id
 * below rather than filtered with `hasText`, for the same reason: Playwright matches text
 * against RENDERED text, and the options of a collapsed `<select>` render none. Both the
 * filter and the assertion see an empty string and fail on options that are plainly there.
 */
function selectedLabel(select: Locator): Promise<string> {
  return select.evaluate(
    (el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent?.trim() ?? "",
  );
}

/** The id of the published Workflow whose option label starts with `prefix`. */
async function workflowOptionId(afterWork: Locator, prefix: string): Promise<string> {
  // Read off the DOM rather than hardcoded, so this does not have to track the built-in's
  // version suffix.
  const id = await afterWork.evaluate(
    (el, want) =>
      [...(el as HTMLSelectElement).options].find((o) => o.textContent?.trim().startsWith(want))
        ?.value ?? null,
    prefix,
  );
  expect(id, `no published Workflow option named ${prefix}`).toBeTruthy();
  return id!;
}

test("choosing scout defaults the after-work Workflow to None", async ({ dashboard }) => {
  const { dialog, kind, afterWork } = await openDispatch(dashboard);

  // Precondition, asserted rather than assumed: a fresh ship dispatch defers to the
  // machine default, which ships armed with the built-in review. If this ever starts out
  // on None the test below would pass without the feature existing.
  await expect(afterWork).toHaveValue("__default");
  await expect(dialog.getByText("Foreman complete")).toBeVisible();

  await kind.selectOption("scout");

  await expect(afterWork).toHaveValue("__none");
  // The option a person actually reads, not just the value behind it.
  expect(await selectedLabel(afterWork)).toContain("finish without a Workflow");
  // And the rail beside the select agrees, so the consequence is legible without
  // opening the dropdown.
  await expect(dialog.getByText("No handoff")).toBeVisible();
  await expect(dialog.getByText("Foreman complete")).toBeHidden();
});

test("switching back to ship restores the dispatch default", async ({ dashboard }) => {
  const { dialog, kind, afterWork } = await openDispatch(dashboard);

  await kind.selectOption("scout");
  await expect(afterWork).toHaveValue("__none");

  await kind.selectOption("ship");

  // Reversible in one gesture. A scout that left the select pinned on None would be a
  // trap: the operator changes their mind about the kind and silently loses the handoff
  // with no field on screen having been touched.
  await expect(afterWork).toHaveValue("__default");
  await expect(dialog.getByText("Foreman complete")).toBeVisible();
});

test("scout only defaults the Workflow, it does not lock it", async ({ dashboard }) => {
  const { dialog, kind, afterWork } = await openDispatch(dashboard);

  await kind.selectOption("scout");
  await expect(afterWork).toHaveValue("__none");

  const builtinId = await workflowOptionId(afterWork, "No-Mistakes Review");
  await afterWork.selectOption(builtinId);

  // A scout CAN still hand off - the kind picks the default, it does not remove the
  // choice - and the pick survives, rather than being snapped back to None.
  await expect(afterWork).toHaveValue(builtinId);
  await expect(kind).toHaveValue("scout");
  await expect(dialog.getByText("Foreman complete")).toBeVisible();
});

test("a hand-picked Workflow is not reverted by a later kind switch", async ({ dashboard }) => {
  const { kind, afterWork } = await openDispatch(dashboard);
  const builtinId = await workflowOptionId(afterWork, "No-Mistakes Review");

  // Scout puts the dispatch default aside, then the operator chooses for themselves.
  await kind.selectOption("scout");
  await afterWork.selectOption(builtinId);

  await kind.selectOption("ship");

  // Their choice stands. Handing back what scout put aside here would revert a selection
  // the operator made after it, underneath them.
  await expect(afterWork).toHaveValue(builtinId);
});

test("an edit keeps its Workflow when kind flips before the config has loaded", async ({
  dashboard,
  daemon,
}) => {
  // The reversal must not depend on a fetch. `workflowConfig` arrives on its own request,
  // and recomputing the machine default to restore it would resolve to None while that
  // request is still out - so a scout-then-ship inside the window would SAVE an explicit
  // "no handoff" over a task that had one. Held open for the whole test, so the window is
  // the entire interaction rather than a race this spec would only sometimes catch.
  const config = (await (
    await fetch(`${daemon.baseURL}/api/workflows/config`)
  ).json()) as { defaultWorkflowId: string };
  expect(config.defaultWorkflowId, "the daemon should ship a default Workflow").toBeTruthy();

  const title = "Audit The Retry Policy";
  const created = (await (
    await fetch(`${daemon.baseURL}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repoRoot: daemon.repo,
        intent: "audit the retry policy",
        title,
        agent: "claude",
        kind: "ship",
        backlog: true,
        workflowId: config.defaultWorkflowId,
      }),
    })
  ).json()) as { id: string; title: string; workflowId: string | null };
  expect(created.workflowId).toBe(config.defaultWorkflowId);
  // Titled explicitly rather than derived, so the row can be found by name without
  // waiting on the async model retitle a dispatch would otherwise apply.
  expect(created.title).toBe(title);

  await dashboard.route("**/api/workflows/config", () => {
    /* never fulfilled: the config request stays out for the whole test */
  });
  await dashboard.reload();

  // Sitrep no longer consumes title-bar space; its direct entry is the Shift+P shortcut.
  await dashboard.keyboard.press("Shift+P");
  await expect(dashboard.getByRole("heading", { name: "Sitrep" })).toBeVisible();
  await dashboard.getByRole("button", { name: title, exact: true }).click();

  const dialog = dashboard.getByRole("dialog", { name: "Edit a backlog task" });
  await expect(dialog).toBeVisible();
  const kind = dialog.getByRole("combobox", { name: "Kind", exact: true });
  const afterWork = dialog.getByRole("combobox", { name: "After work", exact: true });
  await expect(afterWork).toHaveValue(config.defaultWorkflowId);

  await kind.selectOption("scout");
  await expect(afterWork).toHaveValue("__none");
  await kind.selectOption("ship");

  // Handed back from what the scout switch put aside, with no config in sight.
  await expect(afterWork).toHaveValue(config.defaultWorkflowId);

  // And the durable row agrees, which is the failure the whole guard exists to prevent:
  // saving here used to persist None and leave the task finishing with no handoff.
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(async () => {
      const rows = (await (await fetch(`${daemon.baseURL}/api/tasks`)).json()) as {
        id: string;
        workflowId: string | null;
      }[];
      return rows.find((t) => t.id === created.id)?.workflowId ?? "missing";
    })
    .toBe(config.defaultWorkflowId);
});
