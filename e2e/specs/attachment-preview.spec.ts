import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Double-clicking an attached screenshot opens it at readable size.
 *
 * The chip is 220px wide and its thumbnail is 26 square, which is enough to remember that
 * you attached something and not enough to see WHICH shot it was. Before this there was no
 * way to look: the only control on the chip removed it, so checking meant dropping the
 * image and dropping it again.
 *
 * Only a browser can carry these assertions. The gesture is a real `dblclick` - two clicks
 * the DOM coalesces, which no markup test can perform - and the reason it is a double-click
 * and not a click is a layering fact this layer is the only one that can see: a single-click
 * handler would open the dialog on click one and then hand click two to the backdrop that
 * has just appeared under the cursor, closing it again. `test/imagedrop-render.test.ts`
 * pins the chip's markup and can prove none of that.
 *
 * Both requested surfaces are driven, because they are genuinely different mounts: the
 * dispatch strip renders INSIDE another overlay, and the work queue's renders inside an
 * ordinary panel. The nesting is what the Escape assertion is really about.
 *
 * No dispatch reaches an agent binary here beyond the suite's fakes, and the upload is a
 * 70-byte PNG, so nothing spends model tokens.
 */

/** A real 1x1 PNG, small enough that the assertions are about routing, not upload time. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const SHOT = "Screenshot 2026-09-08 at 4.25.20 PM.png";

/**
 * Drop a browser `File` on one element.
 *
 * The three-event sequence rather than `setInputFiles`: these compose boxes have no file
 * input at all, and the drop handler is the intake this feature hangs off.
 */
async function dropImage(page: Page, target: Locator, name: string): Promise<void> {
  const dataTransfer = await page.evaluateHandle(
    ([encoded, fileName]) => {
      const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], fileName, { type: "image/png" }));
      return transfer;
    },
    [PNG, name] as const,
  );
  await target.dispatchEvent("dragenter", { dataTransfer });
  await target.dispatchEvent("dragover", { dataTransfer });
  await target.dispatchEvent("drop", { dataTransfer });
  await dataTransfer.dispose();
}

/** Open the Dispatch modal with a repository chosen, ready to take a drop. */
async function openDispatch(page: Page, daemon: DaemonHandle): Promise<Locator> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  return dialog;
}

const previewDialog = (page: Page): Locator =>
  page.getByRole("dialog", { name: `Preview of ${SHOT}` });

test("a screenshot on the dispatch modal opens on double-click and closes three ways", async ({
  dashboard: page,
  daemon,
}) => {
  const dispatch = await openDispatch(page, daemon);
  await dropImage(page, dispatch.locator(".drop-zone"), SHOT);

  // The chip landed. Waited on the remove control, which only exists once the drop has been
  // taken into the list, so nothing below races the intake.
  await expect(dispatch.getByRole("button", { name: `Remove ${SHOT}` })).toBeVisible();
  const chip = dispatch.getByRole("button", { name: `Preview ${SHOT}` });
  await expect(chip).toBeVisible();

  // A single click does NOT open it. Asserted first and deliberately: it is the requested
  // behaviour, and it is also what keeps the double-click from opening and closing.
  await chip.click();
  await expect(previewDialog(page)).toHaveCount(0);

  await chip.dblclick();
  const preview = previewDialog(page);
  await expect(preview).toBeVisible();
  // The image is really rendered, at a size worth opening a dialog for - not the 26px chip
  // thumbnail in a bigger box. `naturalWidth` proves the blob actually decoded.
  const image = preview.getByRole("img", { name: SHOT });
  await expect(image).toBeVisible();
  expect(await image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  // The filename is the dialog's heading, so a preview of the wrong file is visible as one.
  await expect(preview.getByText(SHOT, { exact: true })).toBeVisible();
  await expectContentClearsBorder(preview);

  // Close 1: Escape. It closes THIS layer only - the dispatch modal it is stacked over
  // survives, with the attachment still on it. That is the whole reason the preview goes
  // through the overlay registry rather than owning its own key listener.
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  await expect(dispatch).toBeVisible();
  await expect(dispatch.getByRole("button", { name: `Remove ${SHOT}` })).toBeVisible();

  // Close 2: the ✕.
  await chip.dblclick();
  await expect(previewDialog(page)).toBeVisible();
  await previewDialog(page).getByRole("button", { name: "Close" }).click();
  await expect(previewDialog(page)).toHaveCount(0);
  await expect(dispatch).toBeVisible();

  // Close 3: the backdrop, which is the third thing a hand tries and comes free with the
  // shared overlay. Clicked at the top-left corner, well outside the centred panel.
  await chip.dblclick();
  await expect(previewDialog(page)).toBeVisible();
  await page.mouse.click(6, 6);
  await expect(previewDialog(page)).toHaveCount(0);
  await expect(dispatch).toBeVisible();
});

test("the preview is reachable from the keyboard, and gives focus back on close", async ({
  dashboard: page,
  daemon,
}) => {
  const dispatch = await openDispatch(page, daemon);
  const task = dispatch.getByPlaceholder("What should this agent do?");
  await task.fill("Look at the attached shot");
  await dropImage(page, dispatch.locator(".drop-zone"), SHOT);
  const chip = dispatch.getByRole("button", { name: `Preview ${SHOT}` });
  await expect(chip).toBeVisible();

  // A double-click is a pointer gesture, so the control has to answer to a key as well or
  // the feature does not exist for anyone driving by keyboard. Enter on the focused button
  // opens on the FIRST press - there is no second click to strand.
  await chip.focus();
  await page.keyboard.press("Enter");
  await expect(previewDialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(previewDialog(page)).toHaveCount(0);

  // Focus comes back to the chip that opened it, by both routes - the convention every
  // dialog follows, and here the only thing standing between a keyboard user and the top of
  // the document. The dialog takes focus for its close button on the way in; without a
  // hand-back, closing leaves focus on nothing and the half-written task field below is
  // several dozen tab stops away.
  await expect(chip).toBeFocused();

  // The pointer route lands in the same place. A press focuses the button before the
  // gesture completes, so the bookmark is the chip here too - stated because "restore what
  // had focus" and "restore the chip" only look identical while that stays true.
  await task.click();
  await expect(task).toBeFocused();
  await chip.dblclick();
  await expect(previewDialog(page)).toBeVisible();
  await previewDialog(page).getByRole("button", { name: "Close" }).click();
  await expect(chip).toBeFocused();
  // And the draft is untouched by the round trip.
  await expect(task).toHaveValue("Look at the attached shot");
});

test("a screenshot queued as work previews the same way, and closing keeps the draft", async ({
  dashboard: page,
  daemon,
}) => {
  // A session to own a queue. Dispatched through the modal because that is the only way to
  // get one, and the suite's agents are faked.
  const dispatch = await openDispatch(page, daemon);
  await dispatch.getByPlaceholder("What should this agent do?").fill("hold a work queue");
  await dispatch.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dispatch.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dispatch).toBeHidden();

  await page.getByRole("navigation", { name: "Sessions" })
    .getByRole("button", { name: /Hold A Work Queue/i }).click();
  await page.getByRole("tablist", { name: "Session detail" })
    .getByRole("tab", { name: /Work queue/ }).click();

  const queue = page.locator("section.work-queue");
  const box = queue.getByPlaceholder(/Queue work for this session/);
  await expect(box).toBeVisible();
  await box.fill("Reproduce what this screenshot shows");
  await dropImage(page, queue.locator(".wq-add"), SHOT);

  const chip = queue.getByRole("button", { name: `Preview ${SHOT}` });
  await expect(chip).toBeVisible();
  await chip.dblclick();
  const preview = previewDialog(page);
  await expect(preview).toBeVisible();
  await expect(preview.getByRole("img", { name: SHOT })).toBeVisible();
  await expectContentClearsBorder(preview);

  await preview.getByRole("button", { name: "Close" }).click();
  await expect(previewDialog(page)).toHaveCount(0);
  // Nothing about looking at the picture disturbs the item being written. This surface is
  // NOT inside an overlay, unlike the dispatch strip, so it is a different closing path.
  await expect(box).toHaveValue("Reproduce what this screenshot shows");
  await expect(queue.getByRole("button", { name: `Remove ${SHOT}` })).toBeVisible();
});

test("two attachments preview independently, each showing the file it names", async ({
  dashboard: page,
  daemon,
}) => {
  // The chips are near-identical by design - a 26px thumbnail and a truncated filename - so
  // "the preview opened" is not the same claim as "the RIGHT preview opened". With one
  // attachment on the strip both are indistinguishable, and a preview wired to the first
  // chip, or to the whole list, would pass every other case in this file.
  const dispatch = await openDispatch(page, daemon);
  const other = "second-shot.png";
  await dropImage(page, dispatch.locator(".drop-zone"), SHOT);
  await expect(dispatch.getByRole("button", { name: `Remove ${SHOT}` })).toBeVisible();
  await dropImage(page, dispatch.locator(".drop-zone"), other);
  await expect(dispatch.getByRole("button", { name: `Remove ${other}` })).toBeVisible();

  await dispatch.getByRole("button", { name: `Preview ${other}` }).dblclick();
  const second = page.getByRole("dialog", { name: `Preview of ${other}` });
  await expect(second).toBeVisible();
  await expect(second.getByRole("img", { name: other })).toBeVisible();
  // Exactly one dialog, and it is not the other file's.
  await expect(previewDialog(page)).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: /^Preview of / })).toHaveCount(1);

  await page.keyboard.press("Escape");
  await expect(second).toHaveCount(0);

  await dispatch.getByRole("button", { name: `Preview ${SHOT}` }).dblclick();
  await expect(previewDialog(page)).toBeVisible();
  await expect(page.getByRole("dialog", { name: `Preview of ${other}` })).toHaveCount(0);
});
