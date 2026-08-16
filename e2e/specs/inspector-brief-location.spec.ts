import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

/**
 * The GitHub Inspector settings panel tells an operator where their brief has to live.
 *
 * Why this is a spec and not a comment. The brief resolves against the REVIEWED repository,
 * and a repo with no brief at either name is not an error - it is reviewed against a generic
 * default and the comments keep arriving, just held to general engineering judgement instead
 * of the project's own rules. So the panel is the only place an operator learns which
 * filenames the Inspector will look for, and a panel naming a location the loader does not
 * check is a silent misconfiguration: they write the file, nothing complains, and the reviews
 * are quietly weaker than they think.
 *
 * `personas/INSPECTOR.md` is preferred and a root `INSPECTOR.md` is the fallback, so the copy
 * has to name BOTH. Naming only the new one would read as a deprecation to every repo already
 * carrying the root file, which still works.
 *
 * What only this layer can prove: that the sentence is reachable and legible on the page an
 * operator actually opens. `inspector-panel.test.ts` renders this component to a string and
 * would pass on copy inside a collapsed section, behind a tab, or clipped out of the panel.
 *
 * No model tokens: nothing here dispatches an agent.
 */

const EVIDENCE = artifactsDir("inspector-brief-location");

/**
 * Photograph the paragraph this spec has just asserted on.
 *
 * Behind `MC_E2E_EVIDENCE`, like the settings ledger's and the palette's: an ordinary run
 * would rewrite the binaries for no added signal. Inside the regression test rather than in a
 * staged capture spec, because the point of the picture is that the assertions around it
 * passed on the same run.
 *
 * Both frames, not just the fixed one. A screenshot of correct text is a weak artifact - a
 * reviewer cannot tell it apart from the state before the change without holding the two side
 * by side. So the defect frame is reproduced HERE, by putting the old `word-break: break-all`
 * back on the chips as an inline style and shooting the same clip, rather than kept as a
 * one-off photograph of a reverted build that no command can regenerate. The declaration is
 * removed again immediately, so the assertions above still describe what shipped.
 */
async function shoot(page: Page, lede: Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control, pointer AND focus: `Tooltip` shows on either, and a stray bubble over
  // the panel would be the one thing in the frame that is not what this spec is about.
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  // The sentence at reading scale, which is the frame the request is actually about.
  await lede.screenshot({ path: `${EVIDENCE}${name}-lede.png` });
  // And the same sentence where an operator meets it, so the crop above is placeable.
  await page.screenshot({ path: `${EVIDENCE}${name}-panel.png` });

  // The defect, regenerated: `break-all` breaks between any two characters, so the path
  // renders as `personas/INSPE` + `CTOR.md`.
  const chips = lede.locator("code");
  await chips.evaluateAll((els) => {
    for (const el of els) (el as HTMLElement).style.wordBreak = "break-all";
  });
  await lede.screenshot({ path: `${EVIDENCE}${name}-lede-before-word-break-all.png` });
  await chips.evaluateAll((els) => {
    for (const el of els) (el as HTMLElement).style.wordBreak = "";
  });
}

test("the GitHub Inspector panel names both places a repo may keep its brief", async ({ page, daemon }) => {
  await page.goto(`${daemon.baseURL}/#/settings/inspector`);

  // The lede, found by the words a reader would scan for rather than by its class: this
  // asserts the sentence an operator reads, so it should fail if the sentence moves into
  // some other element and keep passing if only its styling changes.
  const lede = page.getByText(/Reviews the pull requests Mission Control opened/);
  await expect(lede).toBeVisible();

  // Both locations, in the order the loader consults them. Asserted through the rendered
  // text so `<code>personas/INSPECTOR.md</code>` counts, and asserted as one string so a
  // panel that named the preferred path twice could not pass.
  await expect(lede).toHaveText(/personas\/INSPECTOR\.md.*or its root.*INSPECTOR\.md/s);

  // And it is on screen without hunting: the panel's first paragraph, above the switch that
  // turns GitHub Inspector on, so the operator reads where the brief goes before deciding to
  // enable anything.
  await expect(page.getByRole("checkbox", { name: "Run GitHub Inspector" })).toBeVisible();

  // Each filename renders WHOLE, on one line.
  //
  // This is not a style opinion, and it is the assertion no other layer can make. Settings
  // blurbs styled inline code with `word-break: break-all`, which breaks between any two
  // characters, so this panel rendered the path as `personas/INSPE` + `CTOR.md` - a filename
  // chopped mid-word in the one sentence whose whole job is telling an operator which file to
  // go and create. A markup test cannot see it: the DOM is identical either way and the
  // defect exists only once the text is laid out. Counting client rects is how a browser says
  // "this inline box was not split across lines", and it holds at whatever width the suite
  // runs, without pinning a pixel position that legitimate copy edits would move.
  for (const name of ["personas/INSPECTOR.md", "INSPECTOR.md"]) {
    const chip = lede.locator("code", { hasText: new RegExp(`^${name.replace("/", "\\/")}$`) });
    await expect(chip).toHaveCount(1);
    const boxes = await chip.evaluate((el) => el.getClientRects().length);
    assertOneLine(name, boxes);
  }

  await shoot(page, lede, "inspector-settings");
});

test("Shipping and Trust name the remote reviewer as GitHub Inspector", async ({ page, daemon }) => {
  await page.goto(`${daemon.baseURL}/#/settings/shipping`);
  await expect(page.getByText(/once GitHub Inspector has reviewed the current push/)).toBeVisible();

  // Arm YOLO only far enough to expose its unmet remote-review prerequisite. This is the
  // sentence that must keep Shipping coupled to the unchanged GitHub reviewer rather than
  // accidentally reading as though the local Code Quality Judge can authorize a merge.
  const yolo = page.getByRole("checkbox", {
    name: "YOLO mode - merge our pull requests when they come out clean",
  });
  await expect(yolo).toBeEnabled();
  await yolo.locator("..").click();
  await expect(yolo).toBeChecked();
  await expect(page.getByText(/GitHub Inspector is switched off/)).toBeVisible();
  await shootWholePage(page, "shipping-github-inspector-prerequisite");

  await page.goto(`${daemon.baseURL}/#/settings/trust`);
  const matrix = page.getByRole("table", { name: "Repository trust grants" });
  await expect(matrix).toBeVisible();
  await expect(matrix.getByText("GitHub Inspector posts reviews", { exact: true })).toBeVisible();
  await shootWholePage(page, "trust-github-inspector-grant");
});

async function shootWholePage(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
}

/** Fails with the filename in the message, since "expected 1, got 2" would not name it. */
function assertOneLine(name: string, boxes: number): void {
  expect(boxes, `${name} is split across ${boxes} lines - it should wrap whole`).toBe(1);
}
