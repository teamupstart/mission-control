import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationFind } from "../src/web/components/ConversationFind.tsx";
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

function find(over: Partial<Parameters<typeof ConversationFind>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(ConversationFind, {
      query: "pane",
      onQuery: () => {},
      caseSensitive: false,
      onCaseSensitive: () => {},
      scope: "all",
      onScope: () => {},
      hits: [hit()],
      index: 0,
      onStep: () => {},
      onJump: () => {},
      onClose: () => {},
      loadedOnly: false,
      onLoadOlder: () => {},
      ...over,
    }),
  );
}

test("find always renders its rail - there is no prop that suppresses it", () => {
  // Every combination a caller can reach. If any of these can produce a bar without a
  // rail, the invariant has a hole in it.
  const cases = [
    {},
    { query: "" },
    { hits: [], index: -1 },
    { query: "", hits: [], index: -1 },
    { scope: "user" as const, hits: [], index: -1 },
    { caseSensitive: true },
    { loadedOnly: true },
  ];
  for (const over of cases) {
    const html = find(over);
    assert.ok(html.includes('class="find-rail"'), `rail missing for ${JSON.stringify(over)}`);
    assert.ok(html.includes('class="find-bar"'), `bar missing for ${JSON.stringify(over)}`);
  }
});

test("the transcript mounts find in exactly one place, behind the find state", () => {
  // The structural half. The rail leaves by the panel UNMOUNTING find, so a second
  // mount site - or one not guarded by `find &&` - is how a rail outlives its session
  // or appears without one.
  const src = readFileSync("src/web/components/TranscriptPanel.tsx", "utf8");
  const mounts = src.match(/<ConversationFind/g) ?? [];
  assert.equal(mounts.length, 1, "find should be mounted once");
  assert.match(
    src,
    /\{find && \(\s*<ConversationFind/,
    "find must be mounted behind the find state, so closing it unmounts the rail",
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
  assert.ok(find({ hits: [hit(), hit({ key: "k2" })], index: 0 }).includes("1 / 2"));
  assert.ok(find({ hits: [hit(), hit({ key: "k2" })], index: 1 }).includes("2 / 2"));
  assert.ok(find({ hits: [], index: -1 }).includes("No results"));
  // An empty query is not a failed search, so it reports neither.
  const blank = find({ query: "", hits: [], index: -1 });
  assert.ok(!blank.includes("No results"));
});

test("the current hit is the only one marked current in the rail", () => {
  const html = find({
    hits: [hit(), hit({ key: "k2" }), hit({ key: "k3" })],
    index: 1,
  });
  assert.equal((html.match(/find-result[^"]*is-current/g) ?? []).length, 1);
});

test("a rail row names who said it and shows the match in context", () => {
  const html = find({
    hits: [hit({ who: "claude", pre: "…reads the ", hit: "registry", post: " here…" })],
  });
  assert.ok(html.includes("claude"));
  assert.ok(html.includes("<b>registry</b>"), "the matched span is emphasised in the snippet");
  assert.ok(html.includes("reads the"), "surrounding context is carried");
});

test("the windowed-log caveat appears only when there are older turns and a query", () => {
  assert.ok(find({ loadedOnly: true }).includes("Searching loaded turns only"));
  assert.ok(!find({ loadedOnly: false }).includes("Searching loaded turns only"));
  assert.ok(
    !find({ loadedOnly: true, query: "" }).includes("Searching loaded turns only"),
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
