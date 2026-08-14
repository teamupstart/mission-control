import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Importing an externally-authored Markdown role by path, and adopting it again after the file
 * upstream changes.
 *
 * This is the layer the other three cannot reach. `test/persona-import.test.ts` proves the route
 * reads the exact bytes and reports drift, and `persona-editor-render.test.ts` proves the badge's
 * markup - but neither can tell you whether typing a path into the sidebar reaches that route,
 * whether the tag an operator is supposed to notice actually appears on the row they are looking
 * at, or whether clicking **Re-import** puts the new text in the editor they are reading. Every
 * assertion below is a click, a file on disk, and what came back.
 *
 * The role file is written into the daemon's own isolated `MISSION_HOME`, which is what makes
 * "a path on the daemon's machine" true in a test: the fixture daemon's machine IS this one, and
 * that directory is deleted with the rest of the temp tree when the daemon stops.
 *
 * No agent is launched and none needs to be. Importing a reviewer authors it; running one is the
 * workflow specs' business.
 */

/** A role file shaped like the ones this feature was built for: heading, summary, DO/DON'T. */
const ROLE_V1 = [
  "# Claw Reviewer",
  "",
  "Reads the diff and reports the risk it introduces.",
  "",
  "## DO",
  "",
  "- Name the specific line a risk lives on.",
  "",
].join("\n");

const ROLE_V2 = `${ROLE_V1}\n## DON'T\n\n- Comment on formatting.\n`;

const EVIDENCE = artifactsDir("persona-import-provenance");

/**
 * Photograph a state this spec has already asserted on.
 *
 * Inside the regression rather than in a staged capture spec, for the reason `line-drawers.spec.ts`
 * gives: the point of the picture is that the assertions around it passed on the same run, so the
 * image and the measurement cannot drift apart. Behind `MC_E2E_EVIDENCE` so an ordinary
 * `npm run test:e2e` does not rewrite the binaries for no added signal.
 */
async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer, and the row
  // being photographed is exactly what the pointer last clicked.
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/persona-import-provenance/${name}.png`);
}

function writeRole(daemon: DaemonHandle, text: string): string {
  const dir = join(daemon.home, "claw", "plugins", "agent-team", "references", "roles");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "reviewer.md");
  writeFileSync(path, text, "utf8");
  return path;
}

test("a Markdown role imported by path records where it came from, badges upstream changes, and re-imports", async ({
  dashboard,
  daemon,
}) => {
  const path = writeRole(daemon, ROLE_V1);
  // Fixed for the captures below, so PR-attached evidence is reviewable at the width an
  // operator actually uses rather than at whatever the runner's default happens to be.
  await dashboard.setViewportSize({ width: 1440, height: 900 });
  await dashboard.goto(`${daemon.baseURL}/#/library/personas`);

  const sidebar = dashboard.getByRole("complementary", { name: "Persona library" });
  await expect(sidebar).toBeVisible();

  // Import by path: the daemon reads the file, which is the whole difference from the browser's
  // Import .md button beside this field.
  await sidebar.getByLabel("Absolute path of a Markdown file on this machine").fill(path);
  await sidebar.getByRole("button", { name: "Import from path" }).click();

  // The editor opens on what was imported: the name from the first heading, the description from
  // the paragraph under it, and the exact document in the guidance preview.
  const fields = dashboard.locator("section.persona-fields");
  await expect(fields.getByLabel("Name")).toHaveValue("Claw Reviewer");
  await expect(fields.getByLabel("Description"))
    .toHaveValue("Reads the diff and reports the risk it introduces.");
  // Provenance, in the header, naming the file a re-import will re-read.
  await expect(dashboard.locator("p.persona-source")).toContainText(path);

  await dashboard.getByRole("button", { name: "Preview" }).click();
  const preview = dashboard.locator("article.persona-markdown");
  await expect(preview).toContainText("Name the specific line a risk lives on.");
  await expect(preview).not.toContainText("Comment on formatting.");

  // Nothing has changed on disk, so nothing claims otherwise.
  const row = sidebar.getByRole("button", { name: /Claw Reviewer/ });
  await expect(row).not.toContainText("upstream changed");
  await shoot(dashboard, "imported");

  // Now the upstream moves on, exactly as a plugin upgrade or a `git pull` would move it.
  writeRole(daemon, ROLE_V2);
  await sidebar.getByRole("button", { name: "Check upstream" }).click();
  await expect(row).toContainText("upstream changed");
  // The stored guidance is untouched by the drift - the badge is a report, not a write.
  await expect(preview).not.toContainText("Comment on formatting.");
  // And the editor says so, in the terms that make adopting it safe.
  await expect(dashboard.locator("p.persona-source")).toContainText(path);
  await expect(dashboard.getByText("The source file has changed since this Persona was imported"))
    .toBeVisible();
  await shoot(dashboard, "upstream-changed");

  // Adopting it is a deliberate act with a confirmation that states the invariant. Still
  // exactly ONE button - the status line above names the action rather than duplicating it -
  // and it now sits in the header's overflow menu, where the Rail rebuild put every verb it
  // does not promote. Same accessible name and same behaviour, one click further in, and a
  // `menuitem` rather than a `button` because that is what it now is.
  await dashboard.getByRole("button", { name: "More Persona actions" }).click();
  await expect(dashboard.getByRole("menuitem", { name: "Re-import from source" })).toHaveCount(1);
  await dashboard.getByRole("menuitem", { name: "Re-import from source" }).click();
  const confirm = dashboard.getByRole("dialog", { name: "Re-import Claw Reviewer" });
  await expect(confirm).toContainText("keeps the guidance it was published with");
  await confirm.getByRole("button", { name: "Re-import guidance" }).click();

  // The revision advanced, so what the editor holds is a new revision rather than an edit to the
  // one that was published-safe a moment ago.
  await expect(dashboard.locator("article.persona-editor p.workflow-eyebrow"))
    .toHaveText("Revision 2");
  // And the new text is what it holds. Re-read through Preview because adopting a revision
  // remounts the editor on its default mode, which is the source editor.
  await dashboard.getByRole("button", { name: "Preview" }).click();
  await expect(dashboard.locator("article.persona-markdown"))
    .toContainText("Comment on formatting.");
  // The badge is gone: this Persona and its source file agree again.
  await expect(row).not.toContainText("upstream changed");
  await expect(dashboard.getByText("The source file has changed since this Persona was imported"))
    .toHaveCount(0);

  // The reviewer shelf tells the same story about the same Persona, one level up.
  await dashboard.goto(`${daemon.baseURL}/#/library`);
  const card = dashboard.getByRole("button", { name: /Claw Reviewer/ });
  await expect(card).toBeVisible();
  await expect(card).not.toContainText("upstream changed");

  // And it badges the card when the source moves again, which is the same fact on the shelf a
  // person lands on rather than in the editor they have to open first.
  writeRole(daemon, `${ROLE_V2}\n- Rewrite the change yourself.\n`);
  await dashboard.goto(`${daemon.baseURL}/#/library/personas`);
  await sidebar.getByRole("button", { name: "Check upstream" }).click();
  await expect(row).toContainText("upstream changed");
  await dashboard.goto(`${daemon.baseURL}/#/library`);
  await expect(card).toContainText("upstream changed");
  await shoot(dashboard, "library-shelf");
});

/**
 * Arriving at the Library is itself a request for a fresh answer.
 *
 * The drift hook is owned by the application root, which mounts once per page load - so the
 * check used to run at STARTUP and never again. An operator who leaves the dashboard open,
 * upgrades a plugin and then opens the Library would be shown the verdict from whenever the tab
 * was first loaded, with nothing on screen admitting it was that old.
 *
 * Only a browser can tell this apart: the route assertion is identical either way, and the badge
 * markup is identical either way. What differs is whether navigating away and back re-asks, and
 * that is a sequence of two clicks.
 */
test("navigating back to the Library re-checks the source without pressing Check upstream", async ({
  dashboard,
  daemon,
}) => {
  const path = writeRole(daemon, ROLE_V1);
  await dashboard.goto(`${daemon.baseURL}/#/library/personas`);
  const sidebar = dashboard.getByRole("complementary", { name: "Persona library" });
  await sidebar.getByLabel("Absolute path of a Markdown file on this machine").fill(path);
  await sidebar.getByRole("button", { name: "Import from path" }).click();
  const row = sidebar.getByRole("button", { name: /Claw Reviewer/ });
  await expect(row).toBeVisible();
  await expect(row).not.toContainText("upstream changed");

  // The upstream moves on while the dashboard stays open, and the operator is somewhere else.
  writeRole(daemon, ROLE_V2);
  await dashboard.getByRole("navigation", { name: "Pages" })
    .getByRole("button", { name: /Fleet/ }).click();
  await expect(dashboard.getByRole("complementary", { name: "Persona library" })).toHaveCount(0);

  // Coming back is the request. No Check upstream, no reload - the badge is simply current.
  await dashboard.getByRole("navigation", { name: "Pages" })
    .getByRole("button", { name: /Library/ }).click();
  await expect(dashboard.getByRole("button", { name: /Claw Reviewer/ }))
    .toContainText("upstream changed");
  await dashboard.goto(`${daemon.baseURL}/#/library/personas`);
  await expect(row).toContainText("upstream changed");
});

/**
 * Opening a Persona FROM the shelf is an arrival too, even though the route never leaves the
 * Library.
 *
 * This is the sequence a person actually performs: look at the shelf, notice nothing, click into
 * the reviewer to read it. The shelf and the editor share `#/library`, so a check keyed on "am I
 * on the Library" stayed satisfied across that click and the editor opened with no warning on it -
 * on precisely the Persona the operator had just chosen to look at.
 */
test("opening a Persona from the shelf re-checks its source, without leaving the Library", async ({
  dashboard,
  daemon,
}) => {
  const path = writeRole(daemon, ROLE_V1);
  await dashboard.goto(`${daemon.baseURL}/#/library/personas`);
  const sidebar = dashboard.getByRole("complementary", { name: "Persona library" });
  await sidebar.getByLabel("Absolute path of a Markdown file on this machine").fill(path);
  await sidebar.getByRole("button", { name: "Import from path" }).click();
  await expect(dashboard.locator("p.persona-source")).toContainText(path);

  // Back to the shelf, where the card is current, and the file moves while it is on screen.
  await dashboard.goto(`${daemon.baseURL}/#/library`);
  const card = dashboard.getByRole("button", { name: /Claw Reviewer/ });
  await expect(card).toBeVisible();
  await expect(card).not.toContainText("upstream changed");
  writeRole(daemon, ROLE_V2);

  // One click, no route change beyond the shelf-to-editor step, no Check upstream, no reload.
  await card.click();
  await expect(dashboard.getByRole("complementary", { name: "Persona library" })).toBeVisible();
  await expect(dashboard.getByText("The source file has changed since this Persona was imported"))
    .toBeVisible();
  await expect(sidebar.getByRole("button", { name: /Claw Reviewer/ }))
    .toContainText("upstream changed");
});

test("a path the daemon cannot read is refused by name, and authors nothing", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/library/personas`);
  const sidebar = dashboard.getByRole("complementary", { name: "Persona library" });

  // A relative path is the mistake this affordance invites: the operator is naming a file on the
  // daemon's machine, and "the directory my browser is in" is not a thing the daemon can know.
  await sidebar.getByLabel("Absolute path of a Markdown file on this machine").fill("roles/reviewer.md");
  await sidebar.getByRole("button", { name: "Import from path" }).click();
  await expect(dashboard.getByRole("alert")).toContainText("absolute");

  await sidebar.getByLabel("Absolute path of a Markdown file on this machine")
    .fill(join(daemon.home, "claw", "not-here.md"));
  await sidebar.getByRole("button", { name: "Import from path" }).click();
  // The reason names the path, so the operator can see the typo rather than guess at it.
  await expect(dashboard.getByRole("alert")).toContainText("no file at");

  // No half-made Persona was left behind by either refusal.
  await expect(sidebar.getByRole("button", { name: /reviewer/ })).toHaveCount(0);
});
