import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTEXT_TARGETS,
  resolveContextActions,
  urlAtPoint,
  type ContextAction,
  type ContextInfo,
  type ContextTarget,
} from "../src/web/lib/context-actions.ts";

const EMPTY: ContextInfo = { selectionText: "", pointUrl: null };

interface FakeElementOptions {
  tagName?: string;
  text?: string;
  href?: string;
  field?: { value: string; start: number | null; end: number | null };
  closest?: Record<string, Element | null>;
}

function fakeElement(options: FakeElementOptions = {}): Element {
  const self = {
    tagName: options.tagName ?? "DIV",
    textContent: options.text ?? "",
    value: options.field?.value ?? "",
    selectionStart: options.field?.start ?? null,
    selectionEnd: options.field?.end ?? null,
    closest(selector: string): Element | null {
      if (options.closest && selector in options.closest) return options.closest[selector] ?? null;
      if (selector === "a[href]" && options.href) return self as unknown as Element;
      if (selector === "textarea, input" && options.field) return self as unknown as Element;
      return null;
    },
    matches(selector: string): boolean {
      return selector === "a[href]" && Boolean(options.href);
    },
    getAttribute(name: string): string | null {
      if (name === "href") return options.href ?? null;
      if (name === "type") return options.field ? "text" : null;
      return null;
    },
  };
  return self as unknown as Element;
}

function labels(element: Element, context: ContextInfo = EMPTY): string[] {
  return resolveContextActions(element, context).map((action) => action.label);
}

test("the phase-two registry resolves text fields, links and live selections", () => {
  assert.deepEqual(
    labels(fakeElement({ tagName: "TEXTAREA", field: { value: "alpha beta", start: 0, end: 5 } })),
    ["Cut", "Copy", "Paste", "Paste as quote"],
  );
  assert.deepEqual(
    labels(fakeElement({ tagName: "INPUT", field: { value: "alpha", start: 2, end: 2 } })),
    ["Paste", "Paste as quote"],
  );
  assert.deepEqual(
    labels(fakeElement({ tagName: "A", text: "the docs", href: "https://example.com/docs" })),
    ["Copy", "Copy URL", "Open link"],
  );
  assert.deepEqual(
    labels(fakeElement({ tagName: "A", text: "https://example.com", href: "https://example.com" })),
    ["Copy URL", "Open link"],
  );
  assert.deepEqual(
    labels(fakeElement(), { selectionText: "chosen words", pointUrl: null }),
    ["Copy"],
  );
  assert.deepEqual(labels(fakeElement(), { selectionText: "  \n", pointUrl: null }), []);
});

test("text fields win the ordered item tier even when another matcher could claim them", () => {
  let laterMatcherRan = false;
  const field = fakeElement({ tagName: "INPUT", field: { value: "draft", start: 0, end: 0 } });
  const registry: readonly ContextTarget[] = [
    CONTEXT_TARGETS[0]!,
    {
      id: "later-item",
      tier: "item",
      match: (element) => {
        laterMatcherRan = true;
        return element;
      },
      actions: () => [action("later", "Later", "later")],
    },
  ];
  assert.deepEqual(resolveContextActions(field, EMPTY, registry).map((item) => item.label), [
    "Paste",
    "Paste as quote",
  ]);
  assert.equal(laterMatcherRan, false);
});

function action(id: string, label: string, payload: string, kind = "copy"): ContextAction {
  return { id, label, payload, kind, run: () => {} };
}

test("the resolver takes only the first match from each of its two tiers", () => {
  const hit = fakeElement();
  const registry: readonly ContextTarget[] = [
    { id: "item-a", tier: "item", match: (el) => el, actions: () => [action("a", "A", "a")] },
    { id: "item-b", tier: "item", match: (el) => el, actions: () => [action("b", "B", "b")] },
    {
      id: "container-a",
      tier: "container",
      match: (el) => el,
      actions: () => [action("c", "C", "c")],
    },
    {
      id: "container-b",
      tier: "container",
      match: (el) => el,
      actions: () => [action("d", "D", "d")],
    },
  ];
  const resolved = resolveContextActions(hit, EMPTY, registry);
  assert.deepEqual(resolved.map((item) => item.label), ["A", "C"]);
  assert.deepEqual(resolved.map((item) => item.tier), ["item", "container"]);
});

test("dedupe uses kind and payload, not payload alone", () => {
  const url = "https://example.com";
  const registry: readonly ContextTarget[] = [
    {
      id: "item",
      tier: "item",
      match: (el) => el,
      actions: () => [
        action("copy", "Copy", url),
        action("paste", "Paste", "", "paste"),
        action("paste-quote", "Paste as quote", "", "paste-quote"),
      ],
    },
    {
      id: "container",
      tier: "container",
      match: (el) => el,
      actions: () => [
        action("copy-url", "Copy URL", url),
        action("copy-name", "Copy name", "example"),
      ],
    },
  ];
  assert.deepEqual(resolveContextActions(fakeElement(), EMPTY, registry).map((item) => item.label), [
    "Copy",
    "Paste",
    "Paste as quote",
    "Copy name",
  ]);
});

test("raw URL detection requires the caret offset to fall inside the match", () => {
  const text = "CI is red; inspect https://example.com/run/42 before retrying";
  const textNode = { nodeType: 3, textContent: text } as unknown as Node;
  const documentAt = (offset: number): Document => ({
    caretPositionFromPoint: () => ({ offsetNode: textNode, offset }),
  }) as unknown as Document;
  const inside = text.indexOf("example.com") + 3;
  assert.equal(urlAtPoint(documentAt(inside), { x: 10, y: 10 }), "https://example.com/run/42");
  assert.equal(urlAtPoint(documentAt(2), { x: 10, y: 10 }), null);
});
