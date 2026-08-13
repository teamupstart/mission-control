import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTEXT_TARGETS,
  resolveContextActions,
  urlAtPoint,
  type ContextAction,
  type ContextActionEnvironment,
  type ContextInfo,
  type ContextTarget,
} from "../src/web/lib/context-actions.ts";

const EMPTY: ContextInfo = { selectionText: "", pointUrl: null };

interface FakeElementOptions {
  tagName?: string;
  text?: string;
  href?: string;
  field?: {
    value: string;
    start: number | null;
    end: number | null;
    readOnly?: boolean;
    disabled?: boolean;
  };
  closest?: Record<string, Element | null>;
}

function fakeElement(options: FakeElementOptions = {}): Element {
  const self = {
    tagName: options.tagName ?? "DIV",
    textContent: options.text ?? "",
    value: options.field?.value ?? "",
    selectionStart: options.field?.start ?? null,
    selectionEnd: options.field?.end ?? null,
    readOnly: options.field?.readOnly ?? false,
    disabled: options.field?.disabled ?? false,
    isConnected: true,
    ownerDocument: { defaultView: null },
    focus(): void {},
    setRangeText(replacement: string, start: number, end: number): void {
      self.value = `${self.value.slice(0, start)}${replacement}${self.value.slice(end)}`;
      self.selectionStart = start + replacement.length;
      self.selectionEnd = self.selectionStart;
    },
    dispatchEvent(): boolean {
      return true;
    },
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

test("readonly and disabled fields expose copying but no mutating actions", () => {
  const locked = (state: "readOnly" | "disabled", start: number, end: number): Element =>
    fakeElement({
      tagName: "INPUT",
      field: { value: "locked words", start, end, [state]: true },
    });

  assert.deepEqual(labels(locked("readOnly", 0, 6)), ["Copy"]);
  assert.deepEqual(labels(locked("disabled", 0, 6)), ["Copy"]);
  assert.deepEqual(labels(locked("readOnly", 2, 2)), []);
  assert.deepEqual(labels(locked("disabled", 2, 2)), []);
});

function actionEnvironment(
  overrides: Partial<ContextActionEnvironment> = {},
): ContextActionEnvironment {
  return {
    copy: async () => true,
    readClipboard: async () => "clipboard",
    openExternal: async () => {},
    status: () => {},
    ...overrides,
  };
}

test("async field mutations stop when the captured value or selection changes", async () => {
  const field = fakeElement({
    tagName: "TEXTAREA",
    field: { value: "captured draft", start: 0, end: 8 },
  }) as HTMLTextAreaElement;
  const actions = resolveContextActions(field, EMPTY);
  const cut = actions.find((item) => item.id === "field-cut");
  const paste = actions.find((item) => item.id === "field-paste");
  assert.ok(cut);
  assert.ok(paste);

  let finishCopy!: (copied: boolean) => void;
  const copy = new Promise<boolean>((resolve) => { finishCopy = resolve; });
  const statuses: string[] = [];
  const cutRun = cut.run(actionEnvironment({
    copy: async () => copy,
    status: (message) => { statuses.push(message); },
  }));
  field.value = "newer draft";
  finishCopy(true);
  await cutRun;
  assert.equal(field.value, "newer draft");
  assert.deepEqual(statuses, ["Field changed before cut"]);

  field.value = "captured draft";
  field.selectionStart = 0;
  field.selectionEnd = 8;
  let finishRead!: (text: string) => void;
  const read = new Promise<string>((resolve) => { finishRead = resolve; });
  const pasteStatuses: string[] = [];
  const pasteRun = paste.run(actionEnvironment({
    readClipboard: async () => read,
    status: (message) => { pasteStatuses.push(message); },
  }));
  field.selectionStart = field.selectionEnd = field.value.length;
  finishRead("stale clipboard");
  await pasteRun;
  assert.equal(field.value, "captured draft");
  assert.deepEqual(pasteStatuses, ["Field changed before paste"]);
});

test("paste confirmation never repeats the clipboard payload", async () => {
  const secret = "not-for-a-status-toast";
  const field = fakeElement({
    tagName: "INPUT",
    field: { value: "", start: 0, end: 0 },
  }) as HTMLInputElement;
  const paste = resolveContextActions(field, EMPTY).find((item) => item.id === "field-paste");
  assert.ok(paste);
  const statuses: Array<{ message: string; detail: string | undefined }> = [];
  await paste.run(actionEnvironment({
    readClipboard: async () => secret,
    status: (message, detail) => { statuses.push({ message, detail }); },
  }));
  assert.equal(field.value, secret);
  assert.deepEqual(statuses, [{ message: "Pasted", detail: undefined }]);
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

test("raw URL detection leaves sentence punctuation outside the candidate", () => {
  const url = "https://example.com/run/42?view=full";
  for (const suffix of [".", ", then retry", "!", "; next"]) {
    const text = `Inspect ${url}${suffix}`;
    const textNode = { nodeType: 3, textContent: text } as unknown as Node;
    const documentAt = (offset: number): Document => ({
      caretPositionFromPoint: () => ({ offsetNode: textNode, offset }),
    }) as unknown as Document;
    assert.equal(urlAtPoint(documentAt(text.indexOf("example.com")), { x: 4, y: 8 }), url);
  }
});
