import { WORKSPACE_PATH_CLASS } from "./rehypeWorkspacePaths.ts";

export type ContextTier = "item" | "container";

export interface ContextPoint {
  x: number;
  y: number;
}

export interface ContextAction {
  /** Stable inside one target. The resolver may return the same id from two tiers. */
  id: string;
  label: string;
  hint?: string;
  /** Two actions dedupe only when both this discriminant and `payload` agree. */
  kind: string;
  payload: string;
  tier?: ContextTier;
  run: () => void | Promise<void>;
}

export interface ContextTargetMatch {
  element: Element;
  value?: unknown;
}

/**
 * One entry in the global target registry.
 *
 * Registry order is significant inside a tier: only the first matching item target and the
 * first matching container target contribute actions. New surfaces extend this registry rather
 * than installing their own `contextmenu` listeners.
 */
export interface ContextTarget {
  id: string;
  tier: ContextTier;
  match: (el: Element, ctx: ContextInfo) => ContextTargetMatch | null;
  actions: (match: ContextTargetMatch, ctx: ContextInfo) => ContextAction[];
}

export interface ContextInfo {
  /** The exact live document selection, or an empty string. */
  selection: string;
  /** Present for pointer invocation. Keyboard invocation has no caret point to inspect. */
  point?: ContextPoint;
  /** Copy through the app-wide feedback controller. False means the write was refused. */
  copy: (text: string) => Promise<boolean>;
  readClipboard: () => Promise<string>;
  openExternal: (href: string) => Promise<void>;
  announce: (message: string, tone?: "ok" | "error") => void;
}

interface TextFieldSnapshot {
  field: HTMLInputElement | HTMLTextAreaElement;
  start: number;
  end: number;
  selected: string;
}

interface LinkSnapshot {
  href: string;
  text: string;
}

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/g;
const MAX_ACTIONS = 6;

function textFieldAt(el: Element): TextFieldSnapshot | null {
  const field = el.closest<HTMLInputElement | HTMLTextAreaElement>("textarea, input");
  if (!field) return null;
  // Checkbox, radio, button and other non-text inputs expose null selection offsets. They are
  // controls, but not text fields, and offering Paste against them would be a lie.
  if (typeof field.selectionStart !== "number" || typeof field.selectionEnd !== "number") {
    return null;
  }
  const start = Math.min(field.selectionStart, field.selectionEnd);
  const end = Math.max(field.selectionStart, field.selectionEnd);
  return { field, start, end, selected: field.value.slice(start, end) };
}

type LegacyCaretDocument = Document & {
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

/** A URL-shaped run in the text node under a pointer, and only when the caret is inside it. */
export function urlAtPoint(document: Document, point: ContextPoint): string | null {
  let node: Node | null = null;
  let offset = 0;
  const position = document.caretPositionFromPoint?.(point.x, point.y);
  if (position) {
    node = position.offsetNode;
    offset = position.offset;
  } else {
    const range = (document as LegacyCaretDocument).caretRangeFromPoint?.(point.x, point.y);
    if (range) {
      node = range.startContainer;
      offset = range.startOffset;
    }
  }
  if (!node || node.nodeType !== 3) return null;
  const text = node.textContent ?? "";
  URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_RE.exec(text))) {
    const start = match.index;
    const end = start + match[0].length;
    if (offset >= start && offset <= end) return match[0];
  }
  return null;
}

function linkAt(el: Element, ctx: ContextInfo): LinkSnapshot | null {
  const anchor = el.closest<HTMLAnchorElement>("a[href]");
  if (anchor && !anchor.classList.contains(WORKSPACE_PATH_CLASS)) {
    const href = anchor.getAttribute("href")?.trim() ?? "";
    if (/^https?:\/\//i.test(href)) {
      return { href, text: (anchor.textContent ?? "").trim() };
    }
  }
  const document = el.ownerDocument;
  const href = document && ctx.point ? urlAtPoint(document, ctx.point) : null;
  return href ? { href, text: href } : null;
}

function quoteBlock(text: string): string {
  return `${text.split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
}

function setFieldSelection(snapshot: TextFieldSnapshot): void {
  snapshot.field.focus({ preventScroll: true });
  snapshot.field.setSelectionRange(snapshot.start, snapshot.end);
}

/**
 * Replace the captured field range in a way React's controlled inputs observe.
 *
 * Calling the prototype setter leaves React's value tracker holding the old value, so the
 * bubbling input event is a real change rather than an event React discards as already seen.
 */
function replaceFieldRange(snapshot: TextFieldSnapshot, replacement: string): void {
  const field = snapshot.field;
  const next = field.value.slice(0, snapshot.start) + replacement + field.value.slice(snapshot.end);
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value");
  if (descriptor?.set) descriptor.set.call(field, next);
  else field.value = next;
  const caret = snapshot.start + replacement.length;
  field.focus({ preventScroll: true });
  field.setSelectionRange(caret, caret);
  field.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    data: replacement,
    inputType: replacement ? "insertText" : "deleteByCut",
  }));
}

function copyAction(
  id: string,
  label: string,
  payload: string,
  ctx: ContextInfo,
  hint?: string,
): ContextAction {
  return {
    id,
    label,
    ...(hint ? { hint } : {}),
    kind: "copy",
    payload,
    run: async () => { await ctx.copy(payload); },
  };
}

function textFieldActions(snapshot: TextFieldSnapshot, ctx: ContextInfo): ContextAction[] {
  const actions: ContextAction[] = [];
  if (snapshot.selected.trim()) {
    if (!snapshot.field.disabled && !snapshot.field.readOnly) {
      actions.push({
        id: "field.cut",
        label: "Cut",
        hint: "selection",
        kind: "cut",
        payload: snapshot.selected,
        run: async () => {
          if (await ctx.copy(snapshot.selected)) replaceFieldRange(snapshot, "");
          else setFieldSelection(snapshot);
        },
      });
    }
    actions.push(copyAction("field.copy", "Copy", snapshot.selected, ctx, "selection"));
  }
  if (snapshot.field.disabled || snapshot.field.readOnly) return actions;

  const paste = (asQuote: boolean): ContextAction => ({
    id: asQuote ? "field.paste-quote" : "field.paste",
    label: asQuote ? "Paste as quote" : "Paste",
    hint: asQuote ? "> text" : "⌘V",
    kind: asQuote ? "paste-quote" : "paste",
    payload: "",
    run: async () => {
      try {
        const text = await ctx.readClipboard();
        if (!text) {
          setFieldSelection(snapshot);
          ctx.announce("Clipboard is empty");
          return;
        }
        replaceFieldRange(snapshot, asQuote ? quoteBlock(text) : text);
        ctx.announce(asQuote ? "Pasted as quote" : "Pasted", "ok");
      } catch {
        setFieldSelection(snapshot);
        ctx.announce("Paste needs clipboard permission. Press ⌘V instead.", "error");
      }
    },
  });
  actions.push(paste(false), paste(true));
  return actions;
}

function linkActions(link: LinkSnapshot, ctx: ContextInfo): ContextAction[] {
  const copyPayload = ctx.selection || link.text;
  const actions: ContextAction[] = [];
  // The precise Copy URL label wins when a bare autolink would otherwise produce two
  // byte-identical writes. A worded link still offers both real choices.
  if (copyPayload.trim() && copyPayload !== link.href) {
    actions.push(copyAction(
      "link.copy",
      "Copy",
      copyPayload,
      ctx,
      ctx.selection ? "selection" : "link text",
    ));
  }
  actions.push(copyAction("link.copy-url", "Copy URL", link.href, ctx));
  actions.push({
    id: "link.open",
    label: "Open link",
    hint: "↗",
    kind: "open",
    payload: link.href,
    run: async () => { await ctx.openExternal(link.href); },
  });
  return actions;
}

export const CONTEXT_TARGETS: readonly ContextTarget[] = [
  {
    id: "text-field",
    tier: "item",
    match: (el) => {
      const value = textFieldAt(el);
      return value ? { element: value.field, value } : null;
    },
    actions: (match, ctx) => textFieldActions(match.value as TextFieldSnapshot, ctx),
  },
  {
    id: "external-link",
    tier: "item",
    match: (el, ctx) => {
      const value = linkAt(el, ctx);
      return value ? { element: el, value } : null;
    },
    actions: (match, ctx) => linkActions(match.value as LinkSnapshot, ctx),
  },
  {
    id: "selection",
    tier: "container",
    match: (el, ctx) => ctx.selection.trim() ? { element: el } : null,
    actions: (_match, ctx) => [
      copyAction("selection.copy", "Copy", ctx.selection, ctx, "selection"),
    ],
  },
];

/**
 * Resolve at most one target per tier, item before container, then collapse byte-identical
 * operations. The cap is applied last so registry order remains the menu's priority order.
 */
export function resolveContextActions(
  el: Element,
  ctx: ContextInfo,
  registry: readonly ContextTarget[] = CONTEXT_TARGETS,
): ContextAction[] {
  const candidates: ContextAction[] = [];
  for (const tier of ["item", "container"] as const) {
    for (const target of registry) {
      if (target.tier !== tier) continue;
      const match = target.match(el, ctx);
      if (!match) continue;
      candidates.push(...target.actions(match, ctx).map((action) => ({ ...action, tier })));
      break;
    }
  }

  const seen = new Set<string>();
  return candidates.filter((action) => {
    const key = `${action.kind}\u0000${action.payload}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_ACTIONS);
}
