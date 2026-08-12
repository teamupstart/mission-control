/**
 * What is at stake: the two rules that keep a right-click menu honest.
 *
 * 1. ACTIONS STACK BY SPECIFICITY, and tier 1 is ORDERED AND FIRST-MATCH-WINS. That ordering is
 *    load-bearing rather than incidental: a session card's branch renders as `dd.mono.branch`
 *    and a tool chip's detail is a bare string, so a path matcher placed ahead of either claims
 *    it and offers `Copy absolute path` on a shell command. Phases 3 and 4 insert entries into
 *    this list, and this file is where the order they inherit is written down.
 * 2. THE LABEL NAMES ITS PAYLOAD, which is what the dedupe rule enforces. Two rows that WRITE
 *    THE SAME STRING are one choice wearing two labels and collapse; two rows that merely share
 *    an empty payload do different things and must both stand. Keying on payload alone would
 *    silently eat `Paste as quote`.
 *
 * The registry is pure, so every case here costs microseconds. What it cannot answer is whether
 * the selectors match the app's real markup - that is `e2e/specs/context-menu.spec.ts`, which
 * drives the built dashboard in a real browser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CONTEXT_MENU_ITEM_BUDGET,
  CONTEXT_TARGETS,
  contextMenuActions,
  contextMenuIsEmpty,
  previewPayload,
  quoteMarkdown,
  resolveContextActions,
  urlAtOffset,
  type ContextAction,
  type ContextInfo,
  type ContextTarget,
} from "../src/web/lib/context-actions.ts";
import { asElement, elementStub, type ElementStub } from "./helpers/element-stub.ts";

const NOTHING: ContextInfo = { selection: "", urlAtPoint: "" };

function withSelection(selection: string): ContextInfo {
  return { ...NOTHING, selection };
}

/** The whole menu as `label` strings, in render order, tier 1 first. */
function labels(el: ElementStub, ctx: ContextInfo = NOTHING): string[] {
  return contextMenuActions(resolveContextActions(asElement(el), ctx)).map((a) => a.label);
}

function actions(el: ElementStub, ctx: ContextInfo = NOTHING): ContextAction[] {
  return contextMenuActions(resolveContextActions(asElement(el), ctx));
}

function payloadOf(list: ContextAction[], label: string): string | undefined {
  return list.find((a) => a.label === label)?.payload;
}

// ---- the registry's shape --------------------------------------------------

test("tier 1 is an ordered list, and this is the order phases 3 and 4 insert into", () => {
  assert.deepEqual(
    CONTEXT_TARGETS.filter((t) => t.tier === "item").map((t) => t.id),
    ["text-field", "external-link", "selection"],
    "tier 1 is first-match-wins, so its order is behaviour: a field is never inside another "
      + "target and goes first, and `selection` claims every hit that carries one so it goes last",
  );
});

test("tier 2 is empty until the transcript and the session card arrive", () => {
  // Phase 2 ships the resolver's second tier with nothing in it on purpose: phase 3 adds the
  // message and phase 4 the session card. The tier itself is exercised below with a test
  // registry, so the concatenation and the cross-tier dedupe are not waiting on them.
  assert.deepEqual(CONTEXT_TARGETS.filter((t) => t.tier === "container"), []);
});

test("nothing under the cursor resolves to nothing, so the browser keeps the gesture", () => {
  assert.equal(contextMenuIsEmpty(resolveContextActions(asElement(elementStub()), NOTHING)), true);
});

// ---- text field ------------------------------------------------------------

function textarea(spec: { value: string; start?: number; end?: number; readOnly?: boolean }) {
  return elementStub({
    tagName: "TEXTAREA",
    value: spec.value,
    selectionStart: spec.start ?? 0,
    selectionEnd: spec.end ?? 0,
    readOnly: spec.readOnly ?? false,
  }).claims("textarea, input");
}

test("a composer with a selection offers cut, copy and both pastes", () => {
  const field = textarea({ value: "ship the fix", start: 5, end: 8 });
  assert.deepEqual(labels(field), ["Cut", "Copy", "Paste", "Paste as quote"]);
  // The field's selection is its OWN. `window.getSelection()` is empty inside a textarea, so
  // this payload can only come from selectionStart/selectionEnd - and it has to be read before
  // the menu takes focus, or it is gone.
  assert.equal(payloadOf(actions(field), "Copy"), "the");
  assert.equal(payloadOf(actions(field), "Cut"), "the");
});

test("a composer with no selection offers only the pastes, never a bare Copy", () => {
  // The rule that makes this menu trustworthy: `Copy` appears only when there is something the
  // reader actually pointed at. With an empty selection there is no honest payload for it.
  assert.deepEqual(labels(textarea({ value: "ship the fix" })), ["Paste", "Paste as quote"]);
});

test("a single-line input cannot hold a quote, so it is not offered one", () => {
  const input = elementStub({
    tagName: "INPUT",
    attributes: { type: "text" },
    value: "main",
    selectionStart: 0,
    selectionEnd: 4,
  }).claims("textarea, input");
  assert.deepEqual(labels(input), ["Cut", "Copy", "Paste"]);
});

test("a read-only field can be copied out of but not cut or pasted into", () => {
  // A row that silently does nothing is worse than an absent one.
  const field = textarea({ value: "read me", start: 0, end: 4, readOnly: true });
  assert.deepEqual(labels(field), ["Copy"]);
});

test("a checkbox is not a text field, so the hit falls through to the next target", () => {
  // The allow-list of input types is what keeps `Paste` off a toggle. Falling through rather
  // than claiming-and-offering-nothing is the whole point of putting the type test in `match`.
  const box = elementStub({ tagName: "INPUT", attributes: { type: "checkbox" } })
    .claims("textarea, input");
  assert.deepEqual(labels(box), []);
  assert.deepEqual(labels(box, withSelection("chosen")), ["Copy"]);
});

test("a field wins over every other tier-1 target, because it is never inside one", () => {
  // The first-match-wins rule doing real work: this hit is claimable by the field target AND
  // the link target at once, and a menu that offered `Copy URL` instead of `Paste` inside a
  // composer would be reading the wrong half of the DOM.
  const link = elementStub({ tagName: "A", attributes: { href: "https://ci.example/run/9" } });
  const field = textarea({ value: "see https://ci.example/run/9", start: 0, end: 3 })
    .inside("a[href]", link);
  assert.deepEqual(labels(field), ["Cut", "Copy", "Paste", "Paste as quote"]);
});

// ---- external link ---------------------------------------------------------

function link(href: string, text: string) {
  return elementStub({ tagName: "A", attributes: { href }, text }).claims("a[href]");
}

test("a worded link offers its text and its URL, because both are real choices", () => {
  const docs = link("https://example.test/docs", "the docs");
  assert.deepEqual(labels(docs), ["Copy", "Copy URL", "Open link"]);
  assert.equal(payloadOf(actions(docs), "Copy"), "the docs");
  assert.equal(payloadOf(actions(docs), "Copy URL"), "https://example.test/docs");
});

test("a bare autolinked URL collapses to one copy, and it is the precise label", () => {
  // Link text equal to the href means `Copy` and `Copy URL` are one clipboard write. The label
  // that survives has to be the one that says what it writes.
  const bare = link("https://example.test/x", "https://example.test/x");
  assert.deepEqual(labels(bare), ["Copy URL", "Open link"]);
});

test("a selection inside a link is copyable alongside the URL", () => {
  const docs = link("https://example.test/docs", "the docs");
  const list = actions(docs, withSelection("docs"));
  assert.deepEqual(list.map((a) => a.label), ["Copy", "Copy URL", "Open link"]);
  assert.equal(payloadOf(list, "Copy"), "docs");
  assert.equal(list[0]?.hint, "selection", "the label has to say WHICH copy this is");
});

test("a non-http anchor is not an external link", () => {
  // Phase 3's workspace paths render as `<a class=workspace-path href=src/web/App.tsx>`. Left
  // to this target they would offer `Open link` on a file, which is not what it does.
  const path = link("src/web/App.tsx", "src/web/App.tsx");
  assert.deepEqual(labels(path), []);
});

test("a URL with no anchor around it is still a link", () => {
  // `TurnProse` renders raw text with no `<a>` at all when rich text is off, and again while
  // find is active. Anchor-only detection makes the feature vanish in two of the four states a
  // transcript renders in, so the caret scan is not an extra - it is the path that keeps them.
  const prose = elementStub({ tagName: "SPAN" });
  const ctx: ContextInfo = { selection: "", urlAtPoint: "https://example.test/run/12" };
  assert.deepEqual(labels(prose, ctx), ["Copy URL", "Open link"]);
});

// ---- the caret, not the event target ---------------------------------------

test("a URL is only offered when the caret is actually inside it", () => {
  // The failure this exists to stop: a turn is frequently ONE text node holding both prose and
  // a link, so "does this node contain a URL" offers `Copy URL` when the reader right-clicked
  // a word two sentences away. `e.target` on a mouse event is always an element, never the
  // text node, which is why the resolver needs the caret's offset and not just its node.
  const line = "CI went red on https://ci.example/run/9 again";
  assert.equal(urlAtOffset(line, 1), "", "the caret is on the word CI");
  assert.equal(urlAtOffset(line, 20), "https://ci.example/run/9");
  assert.equal(urlAtOffset(line, 44), "", "the caret is on the trailing word");
});

test("a URL at the end of a sentence does not swallow the full stop", () => {
  assert.equal(urlAtOffset("see https://example.test/docs.", 10), "https://example.test/docs");
});

test("text with no URL in it reports none", () => {
  assert.equal(urlAtOffset("nothing here, not even a path", 4), "");
});

// ---- the plain selection ---------------------------------------------------

test("a selection anywhere else is copyable, and the payload is exactly the selection", () => {
  const prose = elementStub({ tagName: "P" });
  const list = actions(prose, withSelection("the turn said this"));
  assert.deepEqual(list.map((a) => a.label), ["Copy"]);
  assert.equal(list[0]?.payload, "the turn said this");
});

// ---- the resolver's own rules ----------------------------------------------

function fixedTarget(
  id: string,
  tier: "item" | "container",
  claim: boolean,
  rows: Array<Pick<ContextAction, "id" | "label" | "kind" | "payload">>,
): ContextTarget {
  return {
    id,
    tier,
    match: (el) => (claim ? el : null),
    actions: () => rows.map((row) => ({ ...row, description: row.label })),
  };
}

test("both tiers concatenate, most specific first, with a boundary between them", () => {
  const menu = resolveContextActions(asElement(elementStub()), NOTHING, [
    fixedTarget("item", "item", true, [
      { id: "a", label: "Copy code", kind: "copy", payload: "npm test" },
    ]),
    fixedTarget("container", "container", true, [
      { id: "b", label: "Copy message", kind: "copy", payload: "the whole turn" },
    ]),
  ]);
  assert.deepEqual(menu.item.map((a) => a.label), ["Copy code"]);
  assert.deepEqual(menu.container.map((a) => a.label), ["Copy message"]);
});

test("only the first claimant in each tier contributes, so the chain stops at two", () => {
  // A link inside a message inside a card is three targets at once. Two tiers is the cap, and
  // within a tier the more specific entry - the one earlier in the registry - takes the hit
  // outright rather than stacking with the general one behind it.
  const menu = resolveContextActions(asElement(elementStub()), NOTHING, [
    fixedTarget("specific", "item", true, [
      { id: "a", label: "Copy code", kind: "copy", payload: "one" },
    ]),
    fixedTarget("general", "item", true, [
      { id: "b", label: "Copy", kind: "copy", payload: "two" },
    ]),
    fixedTarget("card", "container", true, [
      { id: "c", label: "Copy branch", kind: "copy", payload: "main" },
    ]),
    fixedTarget("page", "container", true, [
      { id: "d", label: "Copy page", kind: "copy", payload: "all" },
    ]),
  ]);
  assert.deepEqual(contextMenuActions(menu).map((a) => a.label), ["Copy code", "Copy branch"]);
});

test("a target that does not claim the hit is skipped, not merged", () => {
  const menu = resolveContextActions(asElement(elementStub()), NOTHING, [
    fixedTarget("absent", "item", false, [
      { id: "a", label: "Copy path", kind: "copy", payload: "never" },
    ]),
    fixedTarget("present", "item", true, [
      { id: "b", label: "Copy", kind: "copy", payload: "chosen" },
    ]),
  ]);
  assert.deepEqual(contextMenuActions(menu).map((a) => a.label), ["Copy"]);
});

test("two rows that write the same string collapse, and tier 1 keeps its own", () => {
  const menu = resolveContextActions(asElement(elementStub()), NOTHING, [
    fixedTarget("item", "item", true, [
      { id: "a", label: "Copy URL", kind: "copy", payload: "https://example.test/x" },
    ]),
    fixedTarget("container", "container", true, [
      { id: "b", label: "Copy link", kind: "copy", payload: "https://example.test/x" },
    ]),
  ]);
  assert.deepEqual(contextMenuActions(menu).map((a) => a.label), ["Copy URL"]);
});

test("two rows that merely share an empty payload both survive", () => {
  // The reason the key is kind AND payload. `Paste` and `Paste as quote` both write nothing -
  // they READ the clipboard - so payload alone would collapse them and lose the quote.
  const list = actions(textarea({ value: "anything" }));
  assert.deepEqual(list.map((a) => a.label), ["Paste", "Paste as quote"]);
  assert.deepEqual(list.map((a) => a.payload), ["", ""]);
  assert.deepEqual(list.map((a) => a.kind), ["paste", "paste-quote"]);
});

test("a different kind on the same payload is a different choice", () => {
  const menu = resolveContextActions(asElement(elementStub()), NOTHING, [
    fixedTarget("item", "item", true, [
      { id: "a", label: "Copy URL", kind: "copy", payload: "https://example.test/x" },
      { id: "b", label: "Open link", kind: "open", payload: "https://example.test/x" },
    ]),
  ]);
  assert.deepEqual(contextMenuActions(menu).map((a) => a.label), ["Copy URL", "Open link"]);
});

test("every menu this phase can produce fits the row budget", () => {
  // Six is what the two-tier cap exists to hold. Phase 3 adds `Copy text` to tier 1's
  // plain-selection branch specifically so a link menu does not gain a fourth container row,
  // and this is the assertion that notices when the budget is spent.
  const richest: Array<[string, ElementStub, ContextInfo]> = [
    ["a link with a selection", link("https://example.test/docs", "the docs"), withSelection("docs")],
    ["a composer with a selection", textarea({ value: "ship it", start: 0, end: 4 }), NOTHING],
  ];
  for (const [what, el, ctx] of richest) {
    const rows = actions(el, ctx).length;
    assert.ok(rows <= CONTEXT_MENU_ITEM_BUDGET, `${what} resolved to ${rows} rows`);
  }
});

test("every action names itself, its payload and how to describe it", () => {
  // The contract phases 3 and 4 fill in. A row with no description is a row with no tooltip,
  // which `test/tooltip-coverage.test.ts` would reject on sight in the component.
  const list = [
    ...actions(link("https://example.test/docs", "the docs"), withSelection("docs")),
    ...actions(textarea({ value: "ship it", start: 0, end: 4 })),
  ];
  const ids = new Set<string>();
  for (const action of list) {
    assert.ok(action.id, "every action needs a stable id");
    assert.ok(action.label, `${action.id} has no label`);
    assert.ok(action.description, `${action.id} has no description to put in its tooltip`);
    ids.add(action.id);
  }
  assert.equal(ids.size, list.length, "ids are the React keys, so they cannot repeat");
});

// ---- payload shaping -------------------------------------------------------

test("a preview is one line and short enough to sit in a tooltip", () => {
  assert.equal(previewPayload("  two   words\nover lines  "), "two words over lines");
  assert.equal(previewPayload("abcdefghij", 5), "abcd…");
  assert.equal(previewPayload("abcde", 5), "abcde");
});

test("a quote is a Markdown block quote with room after it", () => {
  assert.equal(quoteMarkdown("one\ntwo"), "> one\n> two\n\n");
  // A blank line inside a quote is `>` alone - `> ` with a trailing space is what a Markdown
  // formatter strips back out, and the difference shows up in a diff nobody meant to make.
  assert.equal(quoteMarkdown("one\n\ntwo"), "> one\n>\n> two\n\n");
  assert.equal(quoteMarkdown("crlf\r\nlines"), "> crlf\n> lines\n\n");
});
