import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { SCREENSHOTS } from "../scripts/docs-screenshots.mjs";

/**
 * `docs/setup-guide.html`'s own references, which nothing else checks.
 *
 * `scripts/check-doc-links.mjs` walks MARKDOWN. It confirms that README.md, docs/README.md and
 * docs/setup.md link successfully TO this guide, and it never opens the guide to look at what
 * the guide itself points at. So a typo in an in-page anchor, a renamed sibling document, or a
 * figure renamed in the `SCREENSHOTS` registry would all ship with CI green.
 *
 * Deliberately not solved by widening `check-doc-links.mjs` to walk `.html`: that script gates
 * 609 files on every run and has no exports or entrypoint guard, so importing or changing it
 * inside this repair would put the whole documentation gate at risk to cover one file. These
 * assertions are cheap, need no browser, and fail on the exact document they are about.
 */

const GUIDE = fileURLToPath(new URL("../docs/setup-guide.html", import.meta.url));
const DOCS = dirname(GUIDE);
const html = readFileSync(GUIDE, "utf8");

/** Every capture group in these patterns is mandatory, so a match always carries it. */
const captured = (pattern: RegExp): string[] =>
  [...html.matchAll(pattern)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));

const hrefs = captured(/\shref="([^"]+)"/g);
const ids = new Set(captured(/\sid="([^"]+)"/g));

/**
 * GitHub's heading slug, for the one link that targets a heading inside a sibling document.
 *
 * A deliberate copy of the rule in `scripts/check-doc-links.mjs`, which cannot be imported
 * without executing it. Kept to the same shape so the two cannot disagree about the anchors
 * this repository actually publishes.
 */
const slug = (heading: string): string =>
  heading
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[`*~]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "");

test("every in-page anchor resolves to an element in the guide", () => {
  const internal = hrefs.filter((href) => href.startsWith("#"));
  assert.ok(internal.length > 0, "the guide has no in-page navigation at all");

  for (const href of internal) {
    assert.ok(
      ids.has(href.slice(1)),
      `dead in-page anchor ${href} - the section rail would scroll nowhere`,
    );
  }
});

test("every section the rail offers actually exists, and every section is reachable", () => {
  // Both directions. A rail entry with no section is a dead link; a section with no rail entry
  // is a page a reader cannot navigate to, which is the failure that does not announce itself.
  const railTargets = new Set(
    hrefs.filter((href) => href.startsWith("#")).map((href) => href.slice(1)),
  );
  const sectionIds = captured(/<section\s+id="([^"]+)"/g);

  assert.ok(sectionIds.length > 0, "the guide has no sections");
  for (const id of sectionIds) {
    assert.ok(railTargets.has(id), `section #${id} is not reachable from the guide's navigation`);
  }
});

test("every sibling document the guide links to exists", () => {
  const relative = hrefs.filter(
    (href) => !href.startsWith("#") && !/^(https?:|mailto:|data:)/.test(href),
  );
  assert.ok(relative.length > 0, "the guide links to no sibling documentation");

  for (const href of relative) {
    const hash = href.indexOf("#");
    const path = hash === -1 ? href : href.slice(0, hash);
    const fragment = hash === -1 ? "" : href.slice(hash + 1);
    const target = resolve(DOCS, path);
    assert.ok(existsSync(target), `${href} points at a file that does not exist`);

    // A fragment into a Markdown sibling has to name a heading that document really publishes,
    // or the link lands at the top of the page and silently loses its point.
    if (!fragment || extname(target) !== ".md") continue;
    const headings = new Set(
      [...readFileSync(target, "utf8").matchAll(/^#{1,6}\s+(.+)$/gm)]
        .flatMap((match) => (match[1] === undefined ? [] : [slug(match[1])])),
    );
    assert.ok(headings.has(fragment), `${href} names a heading ${path} does not publish`);
  }
});

test("every figure the guide embeds is still produced by the capture registry", () => {
  // The tie the other suites leave open. `docs-screenshots.test.ts` proves each registered shot
  // has a PNG, and `setup-guide-embedding.test.ts` proves each embedded figure matches the PNG
  // it names - but between them a shot could be renamed in the registry while the guide kept
  // embedding the old file. Both suites would stay green while the guide's figure quietly
  // stopped being regenerated and drifted from the dashboard forever.
  const names = new Set(SCREENSHOTS.map((shot) => shot.name));
  const embedded = captured(/\sdata-embed="images\/([^".]+)\.png"/g);

  assert.ok(embedded.length > 0, "the guide embeds no figures");
  for (const name of embedded) {
    assert.ok(
      names.has(name),
      `the guide embeds images/${name}.png, which no shot in SCREENSHOTS produces - `
        + "rename it in the guide too, or the figure will never be regenerated again",
    );
  }
});
