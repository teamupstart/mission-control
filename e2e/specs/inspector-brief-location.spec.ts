import { expect, test } from "../fixtures/test.ts";

/**
 * The Inspector settings panel tells an operator where their brief has to live.
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
test("the Inspector panel names both places a repo may keep its brief", async ({ page, daemon }) => {
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
  // turns the Inspector on, so the operator reads where the brief goes before deciding to
  // enable anything.
  await expect(page.getByRole("checkbox", { name: "Run the Inspector" })).toBeVisible();

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
});

/** Fails with the filename in the message, since "expected 1, got 2" would not name it. */
function assertOneLine(name: string, boxes: number): void {
  expect(boxes, `${name} is split across ${boxes} lines - it should wrap whole`).toBe(1);
}
