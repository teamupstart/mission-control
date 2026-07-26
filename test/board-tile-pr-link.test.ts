import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "../src/shared/types.ts";
import { isDragSelection, SessionTile } from "../src/web/components/layouts/SessionTile.tsx";
import { PrTileFlag } from "../src/web/components/session-bits.tsx";
import { Tooltip } from "../src/web/components/Tooltip.tsx";
import { mkSession } from "./helpers/session-fixture.ts";

/**
 * The board tile's PR flag has to be a real link, and the tile is not allowed to be a
 * button around it. That combination is the whole fix: while the tile was a <button>,
 * the flag could only be a <span>, so clicking a PR opened the console and you had to
 * find the chip in there and click it a second time.
 *
 * Asserted on markup because the failure is structural rather than visual - a tile
 * that wraps its content in a button still looks exactly right in a screenshot, and
 * the regression is one refactor away at any time.
 *
 * Rendered rather than driven through a browser: the dashboard's SSE stream holds the
 * connection open, which hangs headless automation.
 */

function render(over: Partial<Session> = {}): string {
  return renderToStaticMarkup(
    createElement(SessionTile, {
      session: mkSession(over),
      gateNeedsYou: false,
      onOpen: () => {},
      draggingRepo: null,
      onDropped: () => {},
      onDropError: () => {},
      onDropConfirm: () => {},
    }),
  );
}

/**
 * Every anchor that sits between a <button> and its matching </button>. A regex can't
 * answer this - it has no notion of the closing tag - and getting it wrong is how the
 * first draft of this test passed against markup that was still nested.
 */
function anchorsInsideButtons(html: string): string[] {
  const found: string[] = [];
  let depth = 0;
  for (const m of html.matchAll(/<(\/?)(button|a)\b[^>]*>/g)) {
    const [tag, closing, name] = m;
    if (name === "button") depth += closing ? -1 : 1;
    else if (!closing && depth > 0) found.push(tag);
  }
  return found;
}

const withPr = { prUrl: "https://github.com/o/r/pull/7", prNumber: 7, prState: "open" } as const;

test("the PR flag is a link straight to GitHub, not a label you have to drill in for", () => {
  const html = render(withPr);
  assert.match(html, /<a[^>]+href="https:\/\/github\.com\/o\/r\/pull\/7"/);
  assert.match(html, /<a[^>]+target="_blank"/);
  // noreferrer, or the opened tab keeps a handle on this one.
  assert.match(html, /<a[^>]+rel="noreferrer"/);
});

test("the tile does not wrap its content in a button, which a link cannot live inside", () => {
  const html = render(withPr);
  // The open affordance is a stretched sibling of the content, so the anchor is not
  // nested inside it - invalid markup that browsers resolve by dropping the link.
  assert.match(html, /^<div class="tile /);
  const openBtn = html.match(/<button[^>]*class="tile-open"[^>]*>(.*?)<\/button>/s)?.[1];
  assert.ok(openBtn != null, "expected a stretched tile-open button");
  assert.equal(openBtn, "", "the open button must be empty, not a wrapper");
  assert.deepEqual(anchorsInsideButtons(html), []);
});

test("the open affordance is still reachable, and says which session it opens", () => {
  const html = render({ ...withPr, name: "auth-refactor" });
  assert.match(html, /<button[^>]+aria-label="Open auth-refactor"/);
});

test("the stretched open button does not eat the pointer, so tile tooltips survive", () => {
  // The tile's own `title` attributes - model, effort, context meter, gate diamonds -
  // sit on plain in-flow spans, which an absolutely positioned sibling hit-tests over
  // even at z-index 0. The button stays for the keyboard; the mouse falls through it to
  // the content and on to the root's onClick. Asserted against the stylesheet because
  // that is where the contract lives - the markup cannot show it.
  const css = readFileSync(fileURLToPath(new URL("../src/web/styles.css", import.meta.url)), "utf8");
  const rule = css.match(/\.tile-open \{([^}]*)\}/)?.[1];
  assert.ok(rule != null, "expected a .tile-open rule");
  assert.match(rule, /pointer-events:\s*none/);
});

test("a click that only ends a drag-select does not open the session", () => {
  // The tile root opens the console on click, so the mouseup ending a drag-select over
  // a branch name would too. Asserted on the predicate rather than through a click,
  // because that is the whole decision - the handler around it just supplies the
  // browser's selection.
  assert.equal(isDragSelection({ isCollapsed: false }), true, "a live selection is not a click");
  assert.equal(isDragSelection({ isCollapsed: true }), false, "an ordinary click still opens");
  assert.equal(isDragSelection(null), false, "no selection at all still opens");
});

test("a PR number with no URL is not a PR at all", () => {
  // This used to render a plain unlinked `.tile-flag`, an escape hatch for a state the
  // server cannot produce: `prNumber` is only ever written as `prNumberFromUrl(prUrl)`
  // beside the URL itself. Being reachable only from a hand-built fixture, it was dead code
  // that read like a live contract - and the `prNumber` gate it existed for is what made the
  // tile disagree with the card about whether a session HAS a pull request. The tile now
  // takes the shared `prChipView` gate with the other three drawings; see
  // `pr-chip-parity.test.ts`, which pins all four together.
  const html = render({ prNumber: 7, prState: "open", prUrl: null });
  assert.ok(!/tile-flag/.test(html), "no url, so there is no PR to draw");
  assert.ok(!/<a /.test(html), "nothing to link to, so nothing should look clickable");
});

test("a PR whose url carries no parsable number still draws, as a bare PR flag", () => {
  // The other side of that gate, and the bug it caused: gating on `prNumber` meant the tile
  // silently drew nothing for a pull request the card was already showing.
  const html = render({ prNumber: null, prState: "open", prUrl: "https://github.com/o/r/pulls/x" });
  assert.match(html, /<a[^>]+class="tile-flag tile-flag-link pr-open"/);
  assert.match(html, />PR</);
});

test("a failing check still rides along on the link rather than needing its own click", () => {
  const html = render({ ...withPr, prChecks: "failing" });
  const anchor = html.match(/<a [^>]*class="tile-flag tile-flag-link[^"]*"[^>]*>([^<]*)<\/a>/)?.[1];
  assert.ok(anchor != null, "expected the PR anchor");
  assert.match(anchor, /⚠/);
});

// The flag's tooltip is delivered by the shared `Tooltip` component rather than a native
// `title` - `Tooltip` renders no DOM node or attribute until hovered, so the wording can
// only be asserted against the un-rendered element tree, not the rendered markup. See
// `session-leaf-parity.test.ts` for why a rendered-markup assertion here couldn't catch a
// regression back to a native `title`.
test("the failing-check tooltip explains itself, not just the healthy case", () => {
  const session = mkSession({ ...withPr, prChecks: "failing" });
  const flagEl = PrTileFlag({ session });
  assert.equal(flagEl?.type, Tooltip, "expected the PR flag to be wrapped in the shared Tooltip");
  assert.equal(
    (flagEl?.props as { label: string }).label,
    "A CI check failed on this pull request - open on GitHub",
  );
});
