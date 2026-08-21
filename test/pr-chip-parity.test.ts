import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "../src/shared/types.ts";
import {
  PrChip,
  PrRailMark,
  PrTileFlag,
  prChipView,
} from "../src/web/components/session-bits.tsx";
import { mkSession } from "./helpers/session-fixture.ts";

/**
 * What is at stake: the four session drawings agreeing about whether a session HAS a pull
 * request.
 *
 * They used to disagree. `PrChip` (Console) gated on `prUrl`; `PrTileFlag` (Board)
 * and the rail's inlined markup gated on `prNumber`. Those coincide only because the server
 * writes `prNumber` exclusively as `prNumberFromUrl(prUrl)` beside the URL itself - so a
 * pull request whose URL did not parse to a number drew a chip on two surfaces and nothing
 * on the other two, and the rail's copy could drift further with nothing to catch it.
 *
 * Rendered rather than driven through a browser: the dashboard's SSE stream holds the
 * connection open, which hangs headless automation.
 */

const DRAWINGS = [
  { name: "PrChip (console detail)", component: PrChip },
  { name: "PrTileFlag (board tile)", component: PrTileFlag },
  { name: "PrRailMark (console rail, board drill-in)", component: PrRailMark },
] as const;

function render(component: (p: { session: Session }) => unknown, over: Partial<Session>): string {
  return renderToStaticMarkup(
    createElement(component as never, { session: mkSession(over) }),
  );
}

test("every drawing gates on prUrl, so a PR with an unparsable number still shows", () => {
  // The exact divergence: a URL is present, a number is not.
  const over = { prUrl: "https://github.com/o/r/pulls/oddball", prNumber: null } as const;
  for (const { name, component } of DRAWINGS) {
    const html = render(component, over);
    assert.notEqual(html, "", `${name} drew nothing for a session that has a PR`);
    assert.ok(html.includes("PR"), `${name} should fall back to a bare "PR" label`);
  }
});

test("every drawing renders the number when there is one", () => {
  const over = { prUrl: "https://github.com/o/r/pull/264", prNumber: 264 } as const;
  for (const { name, component } of DRAWINGS) {
    const html = render(component, over);
    assert.ok(html.includes("#264"), `${name} should show #264`);
    assert.ok(
      html.includes("https://github.com/o/r/pull/264") || name.startsWith("PrRailMark"),
      `${name} should link to the PR`,
    );
  }
});

test("every drawing renders nothing without a PR url", () => {
  for (const { name, component } of DRAWINGS) {
    assert.equal(render(component, { prUrl: null, prNumber: null }), "", `${name} drew a PR`);
  }
});

test("prNumber alone is not a PR, on any surface", () => {
  // Unreachable from the server today (`prNumber` is only ever written beside `prUrl`),
  // which is exactly why the tile's old "number but no URL" branch was dead code. Pinned so
  // the gate cannot quietly go back to being spelled two ways.
  for (const { name, component } of DRAWINGS) {
    const html = render(component, { prUrl: null, prNumber: 264 });
    assert.equal(html, "", `${name} drew a PR from a number with no url`);
  }
});

test("the shared view is the single decision, and carries merged state and failing checks", () => {
  assert.equal(prChipView(mkSession({ prUrl: null })), null);

  const merged = prChipView(mkSession({ prUrl: "https://x/pull/9", prNumber: 9, prState: "merged" }));
  assert.equal(merged?.tone, "pr-merged");
  assert.equal(merged?.label, "#9");
  assert.ok(merged?.title.includes("merged"));

  const failing = prChipView(
    mkSession({ prUrl: "https://x/pull/9", prNumber: 9, prChecks: "failing" }),
  );
  assert.equal(failing?.failing, true);
  // Defaults to open when the poller has not said otherwise, on every surface at once.
  assert.equal(failing?.tone, "pr-open");
});

test("failing checks are surfaced on all three, each in its own vocabulary", () => {
  const over = {
    prUrl: "https://github.com/o/r/pull/264",
    prNumber: 264,
    prChecks: "failing",
  } as const;
  // The card has room for a separate alert affordance; the tile and the rail fold it into
  // the flag itself. Different renderings, one decision - what must not happen is a surface
  // silently dropping the signal.
  assert.ok(render(PrChip, over).includes("pr-checks-alert"));
  assert.ok(render(PrTileFlag, over).includes("⚠"));
  assert.ok(render(PrRailMark, over).includes("⚠"));
});
