import { expect, test } from "../fixtures/test.ts";

/**
 * Accessibility contracts of the dispatch form's repo picker and Agent field.
 *
 * The picker is a combobox over a portalled listbox, so the only thing tying the two together
 * for assistive technology is `aria-controls`; the list's options are not tab stops, because
 * focus stays in the field while the arrow keys move the highlight. The Agent label wraps its
 * select through a Tooltip, and names it by `for` as well, so the field keeps its label however
 * the wrapper renders. Static markup cannot see any of this: the list only exists once the field
 * has focus, and it renders through a body-level portal.
 *
 * No model tokens: nothing here dispatches.
 */

test("the repo picker's combobox controls its listbox and picks from the keyboard", async ({
  page,
  daemon,
}) => {
  await page.goto(daemon.baseURL);
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();

  const field = dialog.getByPlaceholder("search repos or type a path…");
  await expect(field).toHaveAttribute("role", "combobox");
  await field.click();
  const list = page.getByRole("listbox");
  await expect(list).toBeVisible();
  await expect(field).toHaveAttribute("aria-expanded", "true");

  const listId = await list.getAttribute("id");
  expect(listId, "the listbox carries an id the combobox can point at").toBeTruthy();
  await expect(field).toHaveAttribute("aria-controls", listId!);

  // Options are reachable through the field, never as tab stops of their own.
  const options = list.getByRole("option");
  expect(await options.count()).toBeGreaterThan(1);
  for (const option of await options.all()) {
    await expect(option).toHaveAttribute("tabindex", "-1");
  }

  // Narrow to one repo and take it with Enter, from the field the arrow keys never left. The
  // pick answers guided dispatch's repo question, so the pass moves on to the next one.
  await field.fill("second-repo");
  await expect(list.getByRole("option")).toHaveCount(1);
  await expect(list.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await expect(field).toBeFocused();
  await field.press("Enter");
  await expect(field).toHaveValue(daemon.secondRepo);
  // By id: the guided pass's next question is a listbox of its own.
  await expect(page.locator(`[id="${listId}"]`)).toHaveCount(0);
  await expect(field).toHaveAttribute("aria-expanded", "false");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("What kind of run is this?")).toBeVisible();
});

test("the Agent select is named by its label", async ({ page, daemon }) => {
  await page.goto(daemon.baseURL);
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();

  const agent = dialog.getByLabel("Agent");
  await expect(agent).toHaveJSProperty("tagName", "SELECT");
  const labels = await agent.evaluate((el) =>
    Array.from((el as HTMLSelectElement).labels ?? []).map((label) => ({
      text: label.querySelector(".field-label")?.textContent ?? "",
      forId: label.htmlFor,
    })),
  );
  const id = await agent.getAttribute("id");
  expect(labels).toEqual([{ text: "Agent", forId: id }]);

  await agent.focus();
  await expect(agent).toBeFocused();
});
