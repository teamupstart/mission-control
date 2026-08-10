import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationFindBar, ConversationFindRail } from "../src/web/components/ConversationFind.tsx";
import { ACTIONS, chordHasCommandModifier } from "../src/web/lib/keybindings.ts";
import type { FindHit } from "../src/web/lib/find.ts";

/**
 * What find DRAWS, and the one rule it must never break.
 *
 * **The rail is visible exactly when find is open.** Two earlier iterations of this
 * feature broke that and both were caught in review: one added a button that
 * collapsed the rail while find stayed open, the other dropped the rail entirely
 * below a width threshold. Each produced an open-find state with no visible rail,
 * which makes "find is open" stop meaning anything about what is on screen.
 *
 * So the invariant is pinned twice here - structurally (the component has no way to
 * render without a rail) and at the mount site (the panel has exactly one, behind the
 * find state) - because it is a rule about a state that cannot exist rather than
 * about markup, and markup assertions alone would not catch its return.
 */

function hit(over: Partial<FindHit> = {}): FindHit {
  return {
    key: "k1",
    rowId: "a",
    toolIndex: null,
    start: 0,
    end: 4,
    scope: "user",
    who: "you",
    pre: "…before ",
    hit: "pane",
    post: " after…",
    ...over,
  };
}

/**
 * The bar and the rail are separate components because they render into different
 * parents - the bar floats inside the log wrapper, the rail is a sibling of it so the
 * flex row can give it a column. That split is exactly what makes the "no open find
 * without a rail" invariant worth testing structurally: it is now two mount sites that
 * have to agree, rather than one fragment that could not disagree.
 */
function bar(over: Partial<Parameters<typeof ConversationFindBar>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(ConversationFindBar, {
      query: "pane",
      onQuery: () => {},
      caseSensitive: false,
      onCaseSensitive: () => {},
      hits: [hit()],
      index: 0,
      onStep: () => {},
      onClose: () => {},
      ...over,
    }),
  );
}

function rail(over: Partial<Parameters<typeof ConversationFindRail>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(ConversationFindRail, {
      query: "pane",
      scope: "all",
      onScope: () => {},
      hits: [hit()],
      index: 0,
      onJump: () => {},
      loadedOnly: false,
      onLoadOlder: () => {},
      ...over,
    }),
  );
}

test("the rail renders for every prop combination - none of them suppresses it", () => {
  // Every combination a caller can reach. If any of these can produce nothing, the
  // invariant has a hole in it.
  const cases = [
    {},
    { query: "" },
    { hits: [], index: -1 },
    { query: "", hits: [], index: -1 },
    { scope: "user" as const, hits: [], index: -1 },
    { loadedOnly: true },
  ];
  for (const over of cases) {
    const html = rail(over);
    assert.ok(html.includes('class="find-rail"'), `rail missing for ${JSON.stringify(over)}`);
  }
  for (const over of [{}, { query: "" }, { hits: [], index: -1 }, { caseSensitive: true }]) {
    assert.ok(bar(over).includes('class="find-bar"'), `bar missing for ${JSON.stringify(over)}`);
  }
});

test("the transcript mounts the bar and the rail on the same find state", () => {
  // The structural half. The rail leaves by the panel UNMOUNTING it, so a mount site
  // not guarded by the find state - or a rail guarded by something the bar is not - is
  // how an open find ends up with no results list beside it.
  const src = readFileSync("src/web/components/TranscriptPanel.tsx", "utf8");
  for (const tag of ["ConversationFindBar", "ConversationFindRail", "ConversationActivity"]) {
    const mounts = src.match(new RegExp(`<${tag}`, "g")) ?? [];
    assert.equal(mounts.length, 1, `${tag} should be mounted exactly once`);
  }
  assert.match(
    src,
    /\{find && \(\s*<ConversationFindBar/,
    "the bar must be mounted behind the find state, so closing find unmounts it",
  );
  // The rail slot has exactly one owner at a time: find while open, Observed activity
  // otherwise. A ternary is the shape that makes the exclusivity structural - the two
  // can never render together, and closing find is what restores activity.
  assert.match(
    src,
    /\{find \? \(\s*<ConversationFindRail[\s\S]*?\) : \(\s*<ConversationActivity/,
    "the find rail and Observed activity must share the secondary slot exclusively",
  );
});

test("rows are highlighted from the scoped hits, so the count describes what is lit", () => {
  // `hits` is scope-filtered; `allHits` is not. Feeding rows the unscoped list makes
  // picking "You" report a count over user turns while the agent's turns stay
  // highlighted - the number on the bar then describes a different search than the one
  // on screen, and neither the reader nor the rail can tell.
  const src = readFileSync("src/web/components/TranscriptPanel.tsx", "utf8");
  // Call sites only - the declaration names its own parameter and is not a call.
  const args = [...src.matchAll(/findFor\(\s*([A-Za-z]+),\s*row\.id/g)].map((m) => m[1]);
  assert.ok(args.length >= 2, "both row kinds should derive their highlights from findFor");
  for (const arg of args) {
    assert.equal(arg, "hits", "findFor must be fed the scoped hit list, never allHits");
  }
});

test("a tool call's two spans are derived by clipping, so a match across them survives", () => {
  // The model half of this lives in conversation-find-model. This is the half that
  // pins the RENDERER to it: a call is searched as "<name> <target>" but drawn as two
  // spans, and deriving each by containment (`h.end <= name.length`) silently drops a
  // hit spanning the two - counted in the rail, marked nowhere on screen.
  //
  // `targetHits` rather than `detailHits` since the terminal rendering landed: the
  // second span holds the capped detail in a chat chip and the literal input in a
  // terminal line, and the window arithmetic is the same either way - which is the
  // point. Both are searched over the string they actually draw.
  const src = readFileSync("src/web/components/TranscriptPanel.tsx", "utf8");
  for (const which of ["nameHits", "targetHits"]) {
    assert.match(
      src,
      new RegExp(`const ${which} = hitsInWindow\\(chipHits,`),
      `${which} must be clipped into its span's window, not filtered by containment`,
    );
  }
  assert.doesNotMatch(
    src,
    /chipHits\s*\n?\s*\.filter\(/,
    "a containment filter over chipHits is the dropped-boundary-match bug returning",
  );
});

test("no CSS rule can hide the rail while find is open", () => {
  // The stylesheet half of the same invariant. A `display: none` on `.find-rail` keyed
  // on anything other than find being closed would reintroduce exactly the state
  // review rejected - the narrow mount RELOCATES the rail, it does not drop it.
  const css = readFileSync("src/web/styles.css", "utf8");
  const hidingRules = [...css.matchAll(/([^{}]*\.find-rail[^{}]*)\{([^}]*)\}/g)].filter((m) =>
    /display:\s*none/.test(m[2] ?? ""),
  );
  for (const rule of hidingRules) {
    const selector = (rule[1] ?? "").trim();
    assert.ok(
      selector.includes(".find-rail-head"),
      `only the rail's head may be hidden, never the rail itself - found: ${selector}`,
    );
  }
});

test("the count reads as a browser's find does, and says so when nothing matches", () => {
  assert.ok(bar({ hits: [hit(), hit({ key: "k2" })], index: 0 }).includes("1 / 2"));
  assert.ok(bar({ hits: [hit(), hit({ key: "k2" })], index: 1 }).includes("2 / 2"));
  assert.ok(bar({ hits: [], index: -1 }).includes("No results"));
  // An empty query is not a failed search, so it reports neither.
  const blank = bar({ query: "", hits: [], index: -1 });
  assert.ok(!blank.includes("No results"));
});

test("the current hit is the only one marked current in the rail", () => {
  const html = rail({
    hits: [hit(), hit({ key: "k2" }), hit({ key: "k3" })],
    index: 1,
  });
  assert.equal((html.match(/find-result[^"]*is-current/g) ?? []).length, 1);
});

test("a rail row names who said it and shows the match in context", () => {
  const html = rail({
    hits: [hit({ who: "claude", pre: "…reads the ", hit: "registry", post: " here…" })],
  });
  assert.ok(html.includes("claude"));
  assert.ok(html.includes("<b>registry</b>"), "the matched span is emphasised in the snippet");
  assert.ok(html.includes("reads the"), "surrounding context is carried");
});

test("the windowed-log caveat appears only when there are older turns and a query", () => {
  assert.ok(rail({ loadedOnly: true }).includes("Searching loaded turns only"));
  assert.ok(!rail({ loadedOnly: false }).includes("Searching loaded turns only"));
  assert.ok(
    !rail({ loadedOnly: true, query: "" }).includes("Searching loaded turns only"),
    "with no query there is no count to qualify",
  );
});

test("the find chord carries a command modifier, so it works from the reply box", () => {
  // App's typing guard lets a chord through from inside a text field only when it
  // carries cmd/ctrl. A bare-letter default here would silently never fire while the
  // cursor was in a half-written reply - which is exactly when find is wanted.
  const action = ACTIONS.find((a) => a.id === "findInConversation");
  assert.ok(action, "findInConversation must be a registered action");
  assert.equal(action.defaultBinding, "cmd+f");
  assert.ok(chordHasCommandModifier(action.defaultBinding));
});

test("the find chord does not collide with another action's default", () => {
  const defaults = ACTIONS.map((a) => a.defaultBinding);
  assert.equal(
    defaults.filter((d) => d === "cmd+f").length,
    1,
    "cmd+f must be claimed once",
  );
});
