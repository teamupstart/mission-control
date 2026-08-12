// What a right-click offers, as a registry rather than an `onContextMenu` per component.
//
// One delegated listener resolves the DOM hit into an ordered TARGET CHAIN and concatenates
// each target's actions, most specific first. A link inside a message inside a card is three
// targets at once, and the request - `Copy` AND `Copy URL` on a URL - is that stacking
// generalized rather than special-cased per element.
//
// Two rules carry the design, and both are enforced here rather than per target:
//
// 1. ACTIONS STACK BY SPECIFICITY, capped at TWO TIERS - the thing under the cursor, then the
//    container it lives in. A menu that grows a section per ancestor is a menu nobody reads.
//    Two tiers holds every menu in the design at `CONTEXT_MENU_ITEM_BUDGET` rows or fewer.
// 2. THE LABEL NAMES ITS PAYLOAD. A bare `Copy` that copies something the reader did not
//    choose is worse than no item, so `Copy` appears only when there is a real selection or a
//    distinct link text behind it; otherwise the row is named for what it writes.
//
// Deliberately free of React, of coordinates and of clipboard access. `ContextMenu.tsx` probes
// the DOM for the two facts a target cannot read off an element (the live selection, and a URL
// sitting under the caret in raw text), hands them over as `ContextInfo`, and performs whatever
// comes back. That split is what makes the interesting half - which target claims a hit, in
// what order, and which duplicate rows collapse - assertable from `test/context-actions.test.ts`
// with no browser.
//
// Phase 2 of docs/plans/context-menus/. Phases 3 and 4 add registry entries - transcript and
// session-card targets - and must not change the resolver: the tier order, the dedupe rule and
// the two-tier cap below are the contract they inherit.

/**
 * How many rows a resolved menu may hold before it stops being readable.
 *
 * A budget the registry is designed against and this module's test pins, NOT a truncation:
 * silently dropping the sixth action would hide it exactly when a target is richest. When a
 * new entry pushes a real menu past this, the answer is to move a row to the other tier - the
 * way `Copy text` sits in tier 1's plain-selection branch precisely so a link menu does not
 * gain a fourth container row.
 */
export const CONTEXT_MENU_ITEM_BUDGET = 6;

/** What performing a row actually does. The host switches on this; the registry only names it. */
export type ContextActionKind =
  /** Write `payload` to the clipboard. */
  | "copy"
  /** Cut `payload` out of `field` and write it to the clipboard. */
  | "cut"
  /** Open `payload` - a URL - outside the dashboard. */
  | "open"
  /** Read the clipboard into `field`. */
  | "paste"
  /** Read the clipboard into `field` as a Markdown quote. */
  | "paste-quote";

/**
 * A text field and the selection it had WHEN THE MENU OPENED.
 *
 * Captured up front because focusing the menu loses it: `window.getSelection()` is empty
 * inside an `<input>` or `<textarea>`, so a field's selection lives only in its own
 * `selectionStart`/`selectionEnd`, and those collapse the moment focus leaves. This is the
 * same two-kinds-of-selection distinction `chordYieldsToSelection` documents in
 * `keybindings.ts`.
 */
export interface ContextFieldTarget {
  element: HTMLInputElement | HTMLTextAreaElement;
  start: number;
  end: number;
}

export interface ContextAction {
  /** Stable within one menu. The React key, and what the tests name. */
  id: string;
  /** The row's visible text, and its whole accessible name. */
  label: string;
  /**
   * A short right-aligned qualifier - "selection", "link text". Decoration for the eye and
   * `aria-hidden` in the menu; `description` is what a screen reader is given, and it says
   * the same thing in full.
   */
  hint?: string;
  /** The row's tooltip: what this will write, open or insert, with the payload in it. */
  description: string;
  kind: ContextActionKind;
  /** What a `copy`/`cut`/`open` acts on. Empty for the two pastes, which read instead. */
  payload: string;
  /** Present only on the text-field actions. */
  field?: ContextFieldTarget;
}

/**
 * The facts about a hit that no element can answer for itself.
 *
 * Probed once per open by the host and passed to every target, so a matcher never reaches for
 * `window` and the whole registry stays testable.
 */
export interface ContextInfo {
  /** `window.getSelection()`, trimmed. Empty when the reader has selected nothing. */
  selection: string;
  /**
   * A URL in the RAW TEXT under the caret, with no `<a>` around it. Empty when there is none.
   *
   * Not redundant with `closest("a[href]")`: `TurnProse` renders raw text with no anchor at
   * all when rich text is off, and again while find is active, so anchor-only detection would
   * make the feature vanish in two of the four states a transcript renders in.
   */
  urlAtPoint: string;
}

export type ContextTier = "item" | "container";

export interface ContextTarget {
  id: string;
  tier: ContextTier;
  /**
   * The nearest ancestor-or-self this target claims, or null.
   *
   * Returns the MATCHED ELEMENT rather than a boolean (which is how `plan.md` sketched it) so
   * `actions` is handed the element the target actually claimed instead of walking back up to
   * find it a second time - and so a target whose subject is an ancestor of the hit cannot
   * disagree with itself about which ancestor that was.
   */
  match: (el: Element, ctx: ContextInfo) => Element | null;
  actions: (matched: Element, ctx: ContextInfo) => ContextAction[];
}

export interface ResolvedContextMenu {
  /** Tier 1 - the thing under the cursor. */
  item: ContextAction[];
  /** Tier 2 - the container it lives in. */
  container: ContextAction[];
}

// ---- text ------------------------------------------------------------------

/** One line of a payload, short enough to read inside a tooltip. */
export function previewPayload(text: string, max = 48): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Text as a Markdown block quote, with the trailing blank line that separates it from whatever
 * the reader types next.
 *
 * Here rather than in the menu because phase 3's `Quote in reply` quotes the same way over a
 * different source - a Range clipped to each turn's body - and two spellings of `> ` would be
 * two answers to "what does a quote from this app look like".
 */
export function quoteMarkdown(text: string): string {
  const body = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");
  return `${body}\n\n`;
}

// Bounded on the right by the characters that end a URL in prose or in markup rather than by
// a whitelist of URL characters, so a query string and a fragment survive.
const URL_SOURCE = String.raw`\bhttps?:\/\/[^\s<>"')\]]+`;

/** Terminal punctuation is far more often the sentence's than the URL's. */
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/**
 * The URL in `text` that CONTAINS `offset`, or "".
 *
 * The offset is the load-bearing half, and it is what a prototype gets wrong first. A turn is
 * frequently one text node holding both prose and a link, so "does this node contain a URL"
 * offers `Copy URL` when the reader right-clicked the word "CI" two sentences away. The match
 * has to contain the caret.
 */
export function urlAtOffset(text: string, offset: number): string {
  const scan = new RegExp(URL_SOURCE, "g");
  for (let match = scan.exec(text); match; match = scan.exec(text)) {
    if (offset < match.index || offset > match.index + match[0].length) continue;
    return match[0].replace(TRAILING_PUNCTUATION, "");
  }
  return "";
}

/**
 * `urlAtOffset` against the caret at a viewport point.
 *
 * `e.target` on a mouse event is always an ELEMENT, never the text node the cursor is over, so
 * a text scan driven from it finds nothing. `caretPositionFromPoint` is the standard route and
 * `caretRangeFromPoint` the WebKit one; a browser with neither simply reports no URL, and the
 * anchor path still covers rich text.
 */
export function caretUrlAtPoint(x: number, y: number, doc: Document): string {
  let node: Node | null = null;
  let offset = 0;
  if (typeof doc.caretPositionFromPoint === "function") {
    const position = doc.caretPositionFromPoint(x, y);
    if (position) {
      node = position.offsetNode;
      offset = position.offset;
    }
  } else if (typeof doc.caretRangeFromPoint === "function") {
    const range = doc.caretRangeFromPoint(x, y);
    if (range) {
      node = range.startContainer;
      offset = range.startOffset;
    }
  }
  if (!node || node.nodeType !== 3) return "";
  return urlAtOffset(node.textContent ?? "", offset);
}

// ---- tier 1 ----------------------------------------------------------------

export const TEXT_FIELD_SELECTOR = "textarea, input";
export const LINK_SELECTOR = "a[href]";

/**
 * The `<input>` types that hold text a reader can meaningfully cut, copy and paste.
 *
 * An allow-list rather than "anything that is not a checkbox": the app's inputs include
 * toggles, colours and ranges, and offering `Paste` on a checkbox is the kind of dead row that
 * makes a whole menu feel guessed at. `password` is left out on purpose - no OS menu offers to
 * copy one either.
 */
const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel"]);

function asTextField(el: Element): HTMLInputElement | HTMLTextAreaElement | null {
  if (el.tagName === "TEXTAREA") return el as HTMLTextAreaElement;
  if (el.tagName !== "INPUT") return null;
  const type = (el.getAttribute("type") ?? "text").toLowerCase();
  return TEXT_INPUT_TYPES.has(type) ? (el as HTMLInputElement) : null;
}

function isExternalHref(href: string | null): href is string {
  return typeof href === "string" && /^https?:\/\//i.test(href);
}

/**
 * Text field - `Cut` · `Copy` · `Paste` · `Paste as quote`.
 *
 * FIRST in tier 1, because a field is never inside another target and its own selection is the
 * only one that exists once the cursor is in it. This is the row set the desktop build has
 * been missing outright: Electron ships no `webContents` context menu, so until now the
 * packaged app had no right-click Paste anywhere.
 */
const textFieldTarget: ContextTarget = {
  id: "text-field",
  tier: "item",
  match: (el) => {
    const field = el.closest(TEXT_FIELD_SELECTOR);
    return field && asTextField(field) ? field : null;
  },
  actions: (matched) => {
    const field = asTextField(matched);
    if (!field) return [];
    const start = field.selectionStart ?? 0;
    const end = field.selectionEnd ?? 0;
    const picked = field.value.slice(Math.min(start, end), Math.max(start, end));
    const target: ContextFieldTarget = { element: field, start, end };
    // A read-only field can still be copied out of; it cannot be cut or pasted into, and a
    // row that silently does nothing is worse than an absent one.
    const writable = !field.readOnly && !field.disabled;
    const out: ContextAction[] = [];
    if (picked) {
      if (writable) {
        out.push({
          id: "cut-field",
          label: "Cut",
          hint: "selection",
          description: `Cut "${previewPayload(picked)}" to the clipboard`,
          kind: "cut",
          payload: picked,
          field: target,
        });
      }
      out.push({
        id: "copy-field",
        label: "Copy",
        hint: "selection",
        description: `Copy "${previewPayload(picked)}"`,
        kind: "copy",
        payload: picked,
        field: target,
      });
    }
    if (writable) {
      out.push({
        id: "paste",
        label: "Paste",
        description: "Paste the clipboard here",
        kind: "paste",
        payload: "",
        field: target,
      });
      // Only where a quote can exist. `> ` is a multi-line Markdown construct, and a
      // single-line `<input>` - the fleet filter, a rename box - cannot hold one, so the row
      // would be a promise the field could not keep.
      if (field.tagName === "TEXTAREA") {
        out.push({
          id: "paste-quote",
          label: "Paste as quote",
          description: "Paste the clipboard here as a Markdown quote",
          kind: "paste-quote",
          payload: "",
          field: target,
        });
      }
    }
    return out;
  },
};

/**
 * External link - `Copy` · `Copy URL` · `Open link`.
 *
 * Matches an anchor OR a bare URL the caret is sitting in, so the same three rows appear with
 * rich text on, with it off, and while find is active - the states in which `TurnProse` renders
 * three different markups for the same turn.
 *
 * `Copy` is offered only when it would write something DIFFERENT from `Copy URL`. On a bare
 * autolinked URL the link text is the href, so the two are one clipboard write and the precise
 * label is the one worth keeping; on a worded link both are real choices and both survive. The
 * dedupe rule below would collapse them anyway, but it keeps whichever came first, so the
 * choice of which row survives belongs here.
 */
const externalLinkTarget: ContextTarget = {
  id: "external-link",
  tier: "item",
  match: (el, ctx) => {
    const anchor = el.closest(LINK_SELECTOR);
    if (anchor && isExternalHref(anchor.getAttribute("href"))) return anchor;
    return ctx.urlAtPoint ? el : null;
  },
  actions: (matched, ctx) => {
    const anchorHref = matched.getAttribute("href");
    const anchored = isExternalHref(anchorHref);
    const href = anchored ? anchorHref : ctx.urlAtPoint;
    if (!href) return [];
    const linkText = anchored ? (matched.textContent ?? "").trim() : href;
    const copied = ctx.selection || linkText;
    const out: ContextAction[] = [];
    if (copied && copied !== href) {
      out.push({
        id: "copy-link-text",
        label: "Copy",
        hint: ctx.selection ? "selection" : "link text",
        description: `Copy "${previewPayload(copied)}"`,
        kind: "copy",
        payload: copied,
      });
    }
    out.push({
      id: "copy-url",
      label: "Copy URL",
      description: `Copy ${previewPayload(href)}`,
      kind: "copy",
      payload: href,
    });
    out.push({
      id: "open-link",
      label: "Open link",
      description: `Open ${previewPayload(href)} in your browser`,
      kind: "open",
      payload: href,
    });
    return out;
  },
};

/**
 * Any live selection - `Copy`.
 *
 * LAST in tier 1: it claims every hit that carries a selection, so anything ahead of it would
 * never be reached. The more specific targets each fold the selection into their own first row
 * instead, which is why a selection inside a link still offers `Copy` alongside `Copy URL`.
 *
 * The payload is exactly what ⌘C would put on the clipboard, chrome and all. Phase 3 adds
 * `Copy text` beside it for the one case where that differs usefully - a selection that crossed
 * a turn boundary - rather than quietly redefining this one.
 */
const selectionTarget: ContextTarget = {
  id: "selection",
  tier: "item",
  match: (el, ctx) => (ctx.selection ? el : null),
  actions: (_matched, ctx) => [
    {
      id: "copy-selection",
      label: "Copy",
      hint: "selection",
      description: `Copy "${previewPayload(ctx.selection)}"`,
      kind: "copy",
      payload: ctx.selection,
    },
  ],
};

/**
 * The registry. TIER 1 IS ORDERED AND FIRST-MATCH-WINS, which is load-bearing rather than
 * incidental - `test/context-actions.test.ts` pins the order.
 *
 * A hit is frequently claimable by several tier-1 targets at once, and the specific one has to
 * be ahead of the general one: a session card's branch renders as `dd.mono.branch` and would be
 * taken by phase 4's path matcher, and a tool chip's detail by phase 3's. Every entry below is
 * ahead of `selection`, which would otherwise swallow the lot.
 *
 * Tier 2 needs no order - a hit is inside exactly one container - and is empty until phase 3
 * adds the message and phase 4 the session card.
 */
export const CONTEXT_TARGETS: readonly ContextTarget[] = [
  textFieldTarget,
  externalLinkTarget,
  selectionTarget,
];

// ---- the resolver ----------------------------------------------------------

/**
 * The actions for one hit: tier 1, then tier 2, with identical payloads collapsed.
 *
 * `targets` is a parameter so the resolver's own rules - tier separation, first-match-wins,
 * dedupe across tiers, the row budget - can be driven from a test registry rather than only
 * through whatever the real one happens to contain today. Every caller in the app takes the
 * default, the same way `copyText` takes its environment.
 */
export function resolveContextActions(
  el: Element,
  ctx: ContextInfo,
  targets: readonly ContextTarget[] = CONTEXT_TARGETS,
): ResolvedContextMenu {
  // Shared across both tiers, and tier 1 runs first, so the more specific row is the one that
  // survives a collision.
  //
  // Keyed on KIND AND PAYLOAD, never payload alone. Two rows that write the same string are
  // one choice wearing two labels and collapse - `Copy` and `Copy URL` on a bare autolinked
  // URL. Two rows that merely SHARE an empty payload do entirely different things and must
  // both stand: `Paste` and `Paste as quote` read the clipboard, they do not write it, so
  // there is no payload to tell them apart.
  const seen = new Set<string>();
  const dedupe = (actions: ContextAction[]): ContextAction[] =>
    actions.filter((action) => {
      const key = `${action.kind}:${action.payload}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const claim = (tier: ContextTier): ContextAction[] => {
    for (const target of targets) {
      if (target.tier !== tier) continue;
      const matched = target.match(el, ctx);
      if (matched) return target.actions(matched, ctx);
    }
    return [];
  };

  return { item: dedupe(claim("item")), container: dedupe(claim("container")) };
}

/** Nothing to show, so the right-click should fall through to whatever the browser offers. */
export function contextMenuIsEmpty(menu: ResolvedContextMenu): boolean {
  return menu.item.length === 0 && menu.container.length === 0;
}

/** Both tiers in render order. */
export function contextMenuActions(menu: ResolvedContextMenu): ContextAction[] {
  return [...menu.item, ...menu.container];
}
