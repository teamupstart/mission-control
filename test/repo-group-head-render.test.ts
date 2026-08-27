import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RepoGroupHead } from "../src/web/components/session-bits.tsx";

/**
 * The repository group header's MARKUP, which is the half of the restyle a browser cannot pin
 * cheaply: that the disclosure caret is drawn rather than set as the `⌄` character, and that one
 * component still renders one header for both the board frame and the console rail.
 *
 * The look itself - the frame's two coloured edges, the neutral body, the head band - is asserted
 * in `e2e/specs/board-repo-groups.spec.ts`, against computed style in a real browser, because
 * that is the only layer that can see whether a stylesheet rule reached the element. What lives
 * here is the shape the stylesheet is hung on: drop the `brh-chevron` class and the rotation rule
 * stops firing, drop the swatch from the rail and a rail row loses the only colour it has, and
 * neither failure is visible in a markup diff.
 *
 * createElement, not JSX, because the runner's glob only matches `.test.ts`.
 */

const ROOT = "/Users/you/code/mission-control";

function head(over: { expanded?: boolean; variant?: "board" | "rail" } = {}): string {
  return renderToStaticMarkup(
    createElement(RepoGroupHead, {
      repoRoot: ROOT,
      here: 2,
      total: 7,
      variant: over.variant ?? "board",
      expanded: over.expanded ?? true,
      onToggle: () => {},
    }),
  );
}

test("the disclosure caret is drawn, not the ⌄ character it used to set", () => {
  for (const variant of ["board", "rail"] as const) {
    const html = head({ variant });
    // The glyph sat on its own font baseline and never lined up with the row it was in.
    assert.doesNotMatch(html, /⌄/, `the ${variant} header still sets the text glyph`);
    assert.match(html, /<svg class="brh-chevron"/, `the ${variant} header draws no caret`);
    // `currentcolor`, so one colour rule serves the caret in both registers.
    assert.match(html, /stroke="currentColor"/);
    // The class is what `[aria-expanded="false"] .brh-chevron` rotates. Renaming it silently
    // leaves a caret that points one way while the control announces the other.
    assert.match(html, /class="brh-chevron"/);
    assert.match(html, /aria-hidden="true"[^>]*focusable="false"|focusable="false"/);
  }
});

test("both surfaces render the swatch, and only the stylesheet decides who shows it", () => {
  // The board hides it (`.board-repo-head .brh-swatch { display: none }`) because the frame's
  // own edges carry the colour; the rail has no frame, so the dot is all it has. One markup,
  // one rule - not a branch in the component.
  assert.match(head({ variant: "board" }), /class="brh-swatch"/);
  assert.match(head({ variant: "rail" }), /class="brh-swatch"/);
});

test("the header still says what it is and which way it points", () => {
  const open = head({ expanded: true });
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /aria-label="Collapse mission-control - /);
  // The leaf, not the path: the accessible name carries the whole root, the visible title
  // carries the directory name.
  assert.match(open, /class="bch-title">mission-control</);
  assert.match(open, /class="bch-meta">2 of 7</);

  const folded = head({ expanded: false });
  assert.match(folded, /aria-expanded="false"/);
  assert.match(folded, /aria-label="Expand mission-control - /);
  // Still the same count when folded - the number is about the frame, not about what is drawn.
  assert.match(folded, /class="bch-meta">2 of 7</);
});

test("the rail keeps its own cells rather than borrowing the board's", () => {
  const html = head({ variant: "rail" });
  assert.match(html, /class="rail-ensemble-group rail-repo-group"/);
  assert.match(html, /class="reg-title">mission-control</);
  assert.match(html, /class="reg-stage">2 of 7</);
  assert.doesNotMatch(html, /bch-title/);
});
