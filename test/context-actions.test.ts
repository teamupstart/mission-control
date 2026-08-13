import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveContextActions,
  urlAtPoint,
  type ContextAction,
  type ContextInfo,
  type ContextTarget,
} from "../src/web/lib/context-actions.ts";

function info(selection = ""): ContextInfo {
  return {
    selection,
    copy: async () => true,
    readClipboard: async () => "clipboard",
    openExternal: async () => {},
    announce: () => {},
  };
}

function fakeElement(matches: Record<string, unknown>, ownerDocument?: Document): Element {
  return {
    ownerDocument,
    closest: (selector: string) => matches[selector] ?? null,
  } as unknown as Element;
}

function fakeField(value: string, start: number, end: number): HTMLTextAreaElement {
  return {
    value,
    selectionStart: start,
    selectionEnd: end,
    disabled: false,
    readOnly: false,
    isConnected: true,
    focus: () => {},
    setSelectionRange(
      this: { selectionStart: number; selectionEnd: number },
      nextStart: number,
      nextEnd: number,
    ): void {
      this.selectionStart = nextStart;
      this.selectionEnd = nextEnd;
    },
    dispatchEvent: () => true,
  } as unknown as HTMLTextAreaElement;
}

function fakeAnchor(href: string, text: string): HTMLAnchorElement {
  return {
    textContent: text,
    getAttribute: (name: string) => name === "href" ? href : null,
    classList: { contains: () => false },
  } as unknown as HTMLAnchorElement;
}

function labels(actions: ContextAction[]): string[] {
  return actions.map((action) => action.label);
}

test("a selected text field offers edit actions and keeps both paste operations", () => {
  const field = fakeField("one two three", 4, 7);
  const el = fakeElement({ "textarea, input": field });

  const actions = resolveContextActions(el, info());

  assert.deepEqual(labels(actions), ["Cut", "Copy", "Paste", "Paste as quote"]);
  assert.deepEqual(actions.map((action) => action.payload), ["two", "two", "", ""]);
  assert.deepEqual(
    actions.map((action) => action.managesFocus ?? false),
    [true, false, true, true],
    "only actions that restore or move the field focus should suppress host restoration",
  );
  assert.notEqual(actions[2]?.kind, actions[3]?.kind, "paste variants were deduped by payload alone");
});

test("a field without a selection still offers both paste actions", () => {
  const field = fakeField("draft", 5, 5);
  const el = fakeElement({ "textarea, input": field });
  assert.deepEqual(labels(resolveContextActions(el, info())), ["Paste", "Paste as quote"]);
});

test("readonly and disabled fields expose copying but no mutating actions", () => {
  for (const state of ["readOnly", "disabled"] as const) {
    const field = fakeField("locked value", 0, 6);
    field[state] = true;
    const el = fakeElement({ "textarea, input": field });
    assert.deepEqual(labels(resolveContextActions(el, info())), ["Copy"]);

    field.selectionStart = field.selectionEnd = 6;
    assert.deepEqual(resolveContextActions(el, info()), []);
  }
});

test("async field mutations stop when the captured value or selection changes", async () => {
  const field = fakeField("captured draft", 0, 8);
  const el = fakeElement({ "textarea, input": field });

  let finishCopy!: (copied: boolean) => void;
  const copy = new Promise<boolean>((resolve) => { finishCopy = resolve; });
  const cutMessages: string[] = [];
  const cutInfo = info();
  cutInfo.copy = async () => copy;
  cutInfo.announce = (message) => { cutMessages.push(message); };
  const cut = resolveContextActions(el, cutInfo).find((action) => action.id === "field.cut");
  assert.ok(cut);
  const cutRun = cut.run();
  field.value = "newer draft";
  finishCopy(true);
  await cutRun;
  assert.equal(field.value, "newer draft");
  assert.deepEqual(cutMessages, ["Field changed before cut. Nothing was removed."]);

  field.value = "captured draft";
  field.selectionStart = 0;
  field.selectionEnd = 8;
  let finishRead!: (text: string) => void;
  const read = new Promise<string>((resolve) => { finishRead = resolve; });
  const pasteMessages: string[] = [];
  const pasteInfo = info();
  pasteInfo.readClipboard = async () => read;
  pasteInfo.announce = (message) => { pasteMessages.push(message); };
  const paste = resolveContextActions(el, pasteInfo).find((action) => action.id === "field.paste");
  assert.ok(paste);
  const pasteRun = paste.run();
  field.selectionStart = field.selectionEnd = field.value.length;
  finishRead("stale clipboard");
  await pasteRun;
  assert.equal(field.value, "captured draft");
  assert.deepEqual(pasteMessages, ["Field changed before paste. Nothing was pasted."]);
});

test("paste confirmation never repeats the clipboard payload", async () => {
  const secret = "not-for-a-status-toast";
  const field = fakeField("", 0, 0);
  const el = fakeElement({ "textarea, input": field });
  const announcements: Array<[string, "ok" | "error" | undefined]> = [];
  const ctx = info();
  ctx.readClipboard = async () => secret;
  ctx.announce = (message, tone) => { announcements.push([message, tone]); };
  const paste = resolveContextActions(el, ctx).find((action) => action.id === "field.paste");
  assert.ok(paste);
  await paste.run();

  assert.equal(field.value, secret);
  assert.deepEqual(announcements, [["Pasted", "ok"]]);
  assert.equal(JSON.stringify(announcements).includes(secret), false);
});

test("a worded external link offers link text, URL and open as separate choices", () => {
  const anchor = fakeAnchor("https://example.com/docs", "the docs");
  const el = fakeElement({ "a[href]": anchor });
  const actions = resolveContextActions(el, info());

  assert.deepEqual(labels(actions), ["Copy", "Copy URL", "Open link"]);
  assert.deepEqual(actions.map((action) => action.payload), [
    "the docs",
    "https://example.com/docs",
    "https://example.com/docs",
  ]);
});

test("a bare autolink keeps the precise Copy URL label instead of a duplicate Copy", () => {
  const href = "https://example.com/docs";
  const anchor = fakeAnchor(href, href);
  const el = fakeElement({ "a[href]": anchor });
  assert.deepEqual(labels(resolveContextActions(el, info())), ["Copy URL", "Open link"]);
});

test("link actions use the target-scoped selection supplied by the host", () => {
  const anchor = fakeAnchor("https://example.com/docs", "the docs");
  const el = fakeElement({ "a[href]": anchor });
  const actions = resolveContextActions(el, info("selected link words"));

  assert.deepEqual(labels(actions), ["Copy", "Copy URL", "Open link"]);
  assert.deepEqual(actions.map((action) => action.payload), [
    "selected link words",
    "https://example.com/docs",
    "https://example.com/docs",
  ]);
});

test("a live selection is a container target and whitespace alone is not", () => {
  const el = fakeElement({});
  assert.deepEqual(labels(resolveContextActions(el, info("selected words"))), ["Copy"]);
  assert.deepEqual(resolveContextActions(el, info(" \n\t ")), []);
});

test("URL text detection requires the caret offset to land inside the URL", () => {
  const url = "https://example.com/checks";
  const text = `CI is green: ${url}, today`;
  const node = { nodeType: 3, textContent: text } as Node;
  let offset = 1;
  const document = {
    caretPositionFromPoint: () => ({ offsetNode: node, offset }),
  } as unknown as Document;

  assert.equal(urlAtPoint(document, { x: 1, y: 1 }), null);
  offset = text.indexOf("example.com") + 2;
  assert.equal(urlAtPoint(document, { x: 1, y: 1 }), url);
  offset = text.indexOf(url) + url.length;
  assert.equal(urlAtPoint(document, { x: 1, y: 1 }), null, "the comma boundary is outside the URL");
});

test("URL text detection excludes sentence punctuation but keeps balanced URL punctuation", () => {
  const cases = [
    ["See https://example.com/docs, then continue", "https://example.com/docs"],
    ["See https://example.com/docs. Then continue", "https://example.com/docs"],
    ["(https://example.com/docs)", "https://example.com/docs"],
    ["See https://example.com/docs_(draft).", "https://example.com/docs_(draft)"],
    ["See https://example.com/search/[draft],", "https://example.com/search/[draft]"],
    ["See https://example.com/object/{id}!", "https://example.com/object/{id}"],
    ["See https://example.com/docs_(draft)).", "https://example.com/docs_(draft)"],
    ["See https://example.com/run/42.]", "https://example.com/run/42"],
    ["See https://example.com/a,b today", "https://example.com/a,b"],
    ["See https://example.com/search?q=yes now", "https://example.com/search?q=yes"],
  ] as const;

  for (const [text, expected] of cases) {
    const node = { nodeType: 3, textContent: text } as Node;
    const document = {
      caretPositionFromPoint: () => ({
        offsetNode: node,
        offset: text.indexOf("example.com") + 2,
      }),
    } as unknown as Document;
    assert.equal(urlAtPoint(document, { x: 1, y: 1 }), expected, text);
  }
});

function action(id: string, kind = "copy", payload = id): ContextAction {
  return { id, label: id, kind, payload, run: () => {} };
}

test("the resolver takes the first match in each of two tiers and caps the result at six", () => {
  const reached: string[] = [];
  const target = (
    id: string,
    tier: "item" | "container",
    matches: boolean,
    actions: ContextAction[],
  ): ContextTarget => ({
    id,
    tier,
    match: (el) => {
      reached.push(id);
      return matches ? { element: el } : null;
    },
    actions: () => actions,
  });
  const registry = [
    target("item-miss", "item", false, []),
    target("item-first", "item", true, [action("i1"), action("i2"), action("i3"), action("i4")]),
    target("item-never", "item", true, [action("wrong-item")]),
    target("container-first", "container", true, [action("c1"), action("c2"), action("c3")]),
    target("container-never", "container", true, [action("wrong-container")]),
  ] satisfies ContextTarget[];

  const actions = resolveContextActions(fakeElement({}), info(), registry);

  assert.deepEqual(labels(actions), ["i1", "i2", "i3", "i4", "c1", "c2"]);
  assert.deepEqual(reached, ["item-miss", "item-first", "container-first"]);
  assert.deepEqual(actions.map((candidate) => candidate.tier), [
    "item", "item", "item", "item", "container", "container",
  ]);
});

test("dedupe compares operation kind and payload, not payload alone", () => {
  const registry: ContextTarget[] = [
    {
      id: "item",
      tier: "item",
      match: (el) => ({ element: el }),
      actions: () => [
        action("Copy", "copy", "same"),
        action("Paste", "paste", ""),
        action("Paste as quote", "paste-quote", ""),
      ],
    },
    {
      id: "container",
      tier: "container",
      match: (el) => ({ element: el }),
      actions: () => [
        action("Copy URL", "copy", "same"),
        action("Copy message", "copy", "different"),
      ],
    },
  ];

  assert.deepEqual(
    labels(resolveContextActions(fakeElement({}), info(), registry)),
    ["Copy", "Paste", "Paste as quote", "Copy message"],
  );
});
