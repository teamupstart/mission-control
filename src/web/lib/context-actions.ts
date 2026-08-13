/**
 * Context-menu targets and actions.
 *
 * Targets are ordered registries rather than component-owned handlers. For each tier the
 * first matcher wins, then the item and container actions are concatenated and deduplicated.
 * That keeps "what did the reader point at?" in one place while later phases add transcript
 * and session containers without changing the resolver.
 */

export type ContextTier = "item" | "container";

export interface ContextPoint {
  x: number;
  y: number;
}

export interface ContextInfo {
  /** Raw browser selection. Whitespace-only selections are normalized to an empty string. */
  selectionText: string;
  /** URL under the pointer when rich text has not rendered an anchor. */
  pointUrl: string | null;
}

export interface ContextActionEnvironment {
  /** Write through the shared clipboard helper and publish the supplied success label. */
  copy: (text: string, successLabel?: string) => Promise<boolean>;
  readClipboard: () => Promise<string>;
  openExternal: (url: string) => Promise<void>;
  status: (message: string, detail?: string, error?: boolean) => void;
}

export interface ContextAction {
  id: string;
  label: string;
  hint?: string;
  /** Hover/focus explanation used by the dashboard's shared tooltip contract. */
  description?: string;
  /** Dedupe identity. Clipboard writes intentionally share `copy`, regardless of label. */
  kind: string;
  /** What the action acts on. Empty is legitimate for distinct paste actions. */
  payload: string;
  run: (environment: ContextActionEnvironment) => void | Promise<void>;
}

export interface ResolvedContextAction extends ContextAction {
  tier: ContextTier;
}

export interface ContextTarget {
  id: string;
  tier: ContextTier;
  /** Return the claimed element, or null when this target does not match. */
  match: (element: Element, context: ContextInfo) => Element | null;
  actions: (target: Element, context: ContextInfo) => ContextAction[];
}

function clipboardAction(
  id: string,
  label: string,
  payload: string,
  hint?: string,
): ContextAction {
  return {
    id,
    label,
    ...(hint ? { hint } : {}),
    description: hint === "selection"
      ? "Copy the selected text to the clipboard"
      : hint === "link text"
        ? "Copy the link text to the clipboard"
        : label === "Copy URL"
          ? "Copy this URL to the clipboard"
          : "Copy text to the clipboard",
    kind: "copy",
    payload,
    run: async (environment) => { await environment.copy(payload, "Copied"); },
  };
}

function normalizedSelection(selection: string): string {
  return selection.trim() === "" ? "" : selection;
}

const TEXT_INPUT_TYPES = new Set(["", "text", "search", "url", "tel", "email", "password"]);

function textFieldFrom(element: Element): HTMLInputElement | HTMLTextAreaElement | null {
  const candidate = element.closest("textarea, input");
  if (!candidate) return null;
  if (candidate.tagName.toLowerCase() === "textarea") {
    return candidate as HTMLTextAreaElement;
  }
  const input = candidate as HTMLInputElement;
  return TEXT_INPUT_TYPES.has(input.getAttribute("type")?.toLowerCase() ?? "text") ? input : null;
}

function dispatchFieldInput(
  field: HTMLInputElement | HTMLTextAreaElement,
  inputType: "deleteByCut" | "insertFromPaste",
  data: string | null,
): void {
  const view = field.ownerDocument.defaultView;
  const InputEventCtor = view?.InputEvent;
  const event = InputEventCtor
    ? new InputEventCtor("input", { bubbles: true, composed: true, inputType, data })
    : new Event("input", { bubbles: true, composed: true });
  field.dispatchEvent(event);
}

function replaceFieldRange(
  field: HTMLInputElement | HTMLTextAreaElement,
  start: number,
  end: number,
  replacement: string,
  inputType: "deleteByCut" | "insertFromPaste",
): void {
  field.focus({ preventScroll: true });
  field.setRangeText(replacement, start, end, "end");
  dispatchFieldInput(field, inputType, replacement === "" ? null : replacement);
}

function quoteClipboardText(text: string): string {
  return `${text.split(/\r?\n/).map((line) => `> ${line}`.trimEnd()).join("\n")}\n\n`;
}

interface FieldMutationSnapshot {
  value: string;
  start: number;
  end: number;
}

function fieldMutationIsCurrent(
  field: HTMLInputElement | HTMLTextAreaElement,
  snapshot: FieldMutationSnapshot,
): boolean {
  return field.isConnected &&
    !field.readOnly &&
    !field.disabled &&
    field.value === snapshot.value &&
    field.selectionStart === snapshot.start &&
    field.selectionEnd === snapshot.end;
}

function reportStaleFieldMutation(
  environment: ContextActionEnvironment,
  operation: "cut" | "paste",
): void {
  environment.status(
    `Field changed before ${operation}`,
    operation === "cut" ? "Nothing was removed." : "Nothing was pasted.",
    true,
  );
}

function fieldActions(target: Element): ContextAction[] {
  const field = target as HTMLInputElement | HTMLTextAreaElement;
  const start = field.selectionStart ?? 0;
  const end = field.selectionEnd ?? start;
  const snapshot = { value: field.value, start, end } satisfies FieldMutationSnapshot;
  const picked = end > start ? snapshot.value.slice(start, end) : "";
  const mutable = !field.readOnly && !field.disabled;
  const actions: ContextAction[] = [];

  if (picked !== "") {
    if (mutable) {
      actions.push({
        id: "field-cut",
        label: "Cut",
        hint: "selection",
        description: "Cut the selected text to the clipboard",
        kind: "cut",
        payload: picked,
        run: async (environment) => {
          if (await environment.copy(picked, "Cut")) {
            if (!fieldMutationIsCurrent(field, snapshot)) {
              reportStaleFieldMutation(environment, "cut");
              return;
            }
            replaceFieldRange(field, start, end, "", "deleteByCut");
          }
        },
      });
    }
    actions.push(clipboardAction("field-copy", "Copy", picked, "selection"));
  }

  if (mutable) {
    const paste = (asQuote: boolean): ContextAction => ({
      id: asQuote ? "field-paste-quote" : "field-paste",
      label: asQuote ? "Paste as quote" : "Paste",
      hint: "⌘V",
      description: asQuote
        ? "Paste clipboard text as a Markdown quote"
        : "Paste clipboard text",
      kind: asQuote ? "paste-quote" : "paste",
      payload: "",
      run: async (environment) => {
        try {
          const text = await environment.readClipboard();
          if (!fieldMutationIsCurrent(field, snapshot)) {
            reportStaleFieldMutation(environment, "paste");
            return;
          }
          if (text === "") {
            field.focus({ preventScroll: true });
            environment.status("Clipboard is empty");
            return;
          }
          replaceFieldRange(
            field,
            start,
            end,
            asQuote ? quoteClipboardText(text) : text,
            "insertFromPaste",
          );
          environment.status(asQuote ? "Pasted as quote" : "Pasted");
        } catch {
          field.focus({ preventScroll: true });
          environment.status(
            "Paste needs clipboard permission",
            "Press ⌘V instead. It always works.",
            true,
          );
        }
      },
    });

    actions.push(paste(false), paste(true));
  }
  return actions;
}

function externalLinkActions(target: Element, context: ContextInfo): ContextAction[] {
  const anchor = target.matches("a[href]") ? target : null;
  const href = anchor?.getAttribute("href") ?? context.pointUrl ?? "";
  if (!/^https?:\/\//i.test(href)) return [];

  const selection = normalizedSelection(context.selectionText);
  const linkText = anchor?.textContent?.trim() ?? href;
  const actions: ContextAction[] = [];
  if (selection !== "" || linkText !== href) {
    actions.push(
      clipboardAction(
        "link-copy",
        "Copy",
        selection || linkText,
        selection ? "selection" : "link text",
      ),
    );
  }
  actions.push(clipboardAction("link-copy-url", "Copy URL", href));
  actions.push({
    id: "link-open",
    label: "Open link",
    description: "Open this link outside Mission Control",
    kind: "open-link",
    payload: href,
    run: (environment) => environment.openExternal(href),
  });
  return actions;
}

export const CONTEXT_TARGETS: readonly ContextTarget[] = [
  {
    id: "text-field",
    tier: "item",
    match: (element) => textFieldFrom(element),
    actions: (target) => fieldActions(target),
  },
  {
    id: "external-link",
    tier: "item",
    match: (element, context) => {
      const anchor = element.closest("a[href]");
      if (anchor && /^https?:\/\//i.test(anchor.getAttribute("href") ?? "")) return anchor;
      return context.pointUrl ? element : null;
    },
    actions: externalLinkActions,
  },
  {
    id: "selection",
    tier: "item",
    match: (element, context) => normalizedSelection(context.selectionText) ? element : null,
    actions: (_target, context) => [
      clipboardAction("selection-copy", "Copy", context.selectionText, "selection"),
    ],
  },
];

/**
 * Resolve at most one item and one container target, then collapse exact duplicate effects.
 *
 * Dedupe is deliberately kind AND payload. `Copy` and `Copy URL` both write the same bare URL
 * and collapse; `Paste` and `Paste as quote` both carry an empty payload but remain distinct.
 */
export function resolveContextActions(
  element: Element,
  context: ContextInfo,
  registry: readonly ContextTarget[] = CONTEXT_TARGETS,
): ResolvedContextAction[] {
  const candidates: ResolvedContextAction[] = [];
  for (const tier of ["item", "container"] as const) {
    for (const target of registry) {
      if (target.tier !== tier) continue;
      const claimed = target.match(element, context);
      if (!claimed) continue;
      candidates.push(...target.actions(claimed, context).map((action) => ({ ...action, tier })));
      break;
    }
  }

  const seen = new Set<string>();
  return candidates.filter((action) => {
    const key = `${action.kind}:${action.payload}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/g;
const RAW_URL_TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?"]);
const RAW_URL_DELIMITERS = [["(", ")"], ["[", "]"], ["{", "}"]] as const;

function rawUrlCandidate(text: string): string {
  const delimiters = RAW_URL_DELIMITERS.map(([opening, closing]) => ({
    opening,
    closing,
    openingCount: 0,
    closingCount: 0,
  }));
  for (const character of text) {
    for (const delimiter of delimiters) {
      if (character === delimiter.opening) delimiter.openingCount += 1;
      if (character === delimiter.closing) delimiter.closingCount += 1;
    }
  }

  let end = text.length;
  while (end > 0) {
    const character = text.charAt(end - 1);
    if (RAW_URL_TRAILING_PUNCTUATION.has(character)) {
      end -= 1;
      continue;
    }
    const delimiter = delimiters.find((item) => item.closing === character);
    if (delimiter && delimiter.closingCount > delimiter.openingCount) {
      delimiter.closingCount -= 1;
      end -= 1;
      continue;
    }
    break;
  }
  return text.slice(0, end);
}

/** Find the URL whose text range contains the caret at a viewport point. */
export function urlAtPoint(document: Document, point: ContextPoint): string | null {
  let node: Node | null = null;
  let offset = 0;
  if (typeof document.caretPositionFromPoint === "function") {
    const caret = document.caretPositionFromPoint(point.x, point.y);
    node = caret?.offsetNode ?? null;
    offset = caret?.offset ?? 0;
  } else if (typeof document.caretRangeFromPoint === "function") {
    const range = document.caretRangeFromPoint(point.x, point.y);
    node = range?.startContainer ?? null;
    offset = range?.startOffset ?? 0;
  }
  if (!node || node.nodeType !== 3) return null;

  const text = node.textContent ?? "";
  URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_RE.exec(text))) {
    const candidate = rawUrlCandidate(match[0]);
    if (
      candidate !== "" &&
      offset >= match.index &&
      offset <= match.index + candidate.length
    ) return candidate;
  }
  return null;
}
