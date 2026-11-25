import { EditorView } from "@codemirror/view";
import type { ServerEvent } from "@shared/types.ts";

const textTypes = new Set(["text", "search", "url", "tel", "email", "password", "number"]);
type Dictation = Extract<ServerEvent, { type: "voice_dictation" }>;

export function focusedDictationField(): HTMLElement | null {
  if (!document.hasFocus() || document.hidden) return null;
  const field = document.activeElement;
  if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) {
    if (field.readOnly || field.matches(":disabled")) return null;
    return field instanceof HTMLTextAreaElement || textTypes.has(field.type) ? field : null;
  }
  return field instanceof HTMLElement && field.isContentEditable ? field : null;
}

function isControl(field: HTMLElement): field is HTMLInputElement | HTMLTextAreaElement {
  return field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement;
}

function valueOf(field: HTMLElement, view: EditorView | null): string {
  if (view) return view.state.doc.toString();
  return isControl(field) ? field.value : field.textContent ?? "";
}

// DOM Range offsets are local to a node. Use text offsets within the editing host
// so syntax highlighting can split or replace those nodes between transcripts.
function caret(field: HTMLElement, view: EditorView | null): number | null {
  if (view) {
    const selection = view.state.selection.main;
    return selection.empty ? selection.head : null;
  }
  if (isControl(field) && field.selectionStart !== null) {
    return field.selectionStart === field.selectionEnd ? field.selectionStart : null;
  }
  const selection = document.getSelection();
  if (!selection || !selection.isCollapsed) return null;
  if (isControl(field)) {
    // Email and number expose their native selection to Selection.modify only.
    // Measure the prefix, then collapse back to the original end of the selection.
    selection.modify("extend", "backward", "lineboundary");
    const prefix = selection.toString();
    if (prefix) selection.modify("move", "forward", "character");
    return prefix.length;
  }
  if (!selection.focusNode || !field.contains(selection.focusNode)) return null;
  const range = document.createRange();
  range.selectNodeContents(field);
  range.setEnd(selection.focusNode, selection.focusOffset);
  return range.toString().length;
}

function selectOffsets(field: HTMLElement, start: number, end: number): boolean {
  if (isControl(field) && field.selectionStart !== null) {
    field.setSelectionRange(start, end);
    return true;
  }
  const selection = document.getSelection();
  if (!selection) return false;
  if (isControl(field)) {
    selection.modify("move", "backward", "lineboundary");
    const segments = new Intl.Segmenter();
    for (const _ of segments.segment(field.value.slice(0, start))) selection.modify("move", "forward", "character");
    for (const _ of segments.segment(field.value.slice(start, end))) selection.modify("extend", "forward", "character");
    return selection.toString() === field.value.slice(start, end);
  }
  const nodes = document.createTreeWalker(field, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0;
  let foundStart = false;
  for (let node = nodes.nextNode(); node; node = nodes.nextNode()) {
    const next = offset + (node as Text).length;
    // At a boundary, a nonempty replacement starts in the following text node.
    if (!foundStart && (start < next || (start === end && start === next))) {
      range.setStart(node, start - offset);
      foundStart = true;
    }
    if (end <= next) {
      range.setEnd(node, end - offset);
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    }
    offset = next;
  }
  return false;
}

type Span = { start: number; end: number; space: string; text: string; target: string };

export class DictationEditor {
  // A final decode can arrive after another capture has already inserted its preview.
  // A null entry protects a manually edited phrase until its final arrives.
  private readonly spans = new Map<string, Span | null>();
  private value = "";
  private cursor: number | null = null;

  interrupt(): void {
    for (const capture of this.spans.keys()) this.spans.set(capture, null);
  }

  insert(field: HTMLElement, message: Dictation): void {
    const previous = this.spans.get(message.capture);
    if (!message.interim) this.spans.delete(message.capture);
    if (previous === null) return;
    const owner = isControl(field) ? null : EditorView.findFromDOM(field);
    const view = owner?.contentDOM === field ? owner : null;
    const value = valueOf(field, view);
    const cursor = caret(field, view);
    // When returning to an unmodified field, an explicit selection is the new insertion range.
    const newSelection = previous && previous.target !== message.target && cursor === null;
    if (value !== this.value || (cursor !== this.cursor && !newSelection)) {
      this.interrupt();
      if (previous) return;
    }
    const replacing = newSelection ? undefined : previous;
    if (replacing?.text === message.text) return;
    if (!view && replacing && !selectOffsets(field, replacing.start, replacing.end)) return;

    const startOffset = replacing?.start ?? (isControl(field) ? field.selectionStart : view?.state.selection.main.from ?? cursor) ?? 0;
    const before = value.slice(0, startOffset);
    const space = replacing?.space ?? (/[\p{L}\p{N}.!?]$/u.test(before) && /^[\p{L}\p{N}]/u.test(message.text) ? " " : "");
    const inserted = space + message.text;
    if (view) {
      // File positions include newlines and offscreen content. Apply the edit in
      // the same coordinates as the saved span, through the file's update listener.
      const selection = view.state.selection.main;
      const insert = view.state.toText(inserted);
      view.dispatch({ changes: { from: startOffset, to: replacing?.end ?? selection.to, insert },
        selection: { anchor: startOffset + insert.length }, userEvent: "input.type" });
    } else if (!document.execCommand("insertText", false, inserted)) return;
    const updated = valueOf(field, view);
    const end = caret(field, view);
    if (end === null || !updated.slice(0, end).endsWith(inserted)) {
      this.interrupt();
      if (message.interim) this.spans.set(message.capture, null);
      return;
    }
    const start = end - inserted.length;
    const delta = updated.length - value.length;
    const oldEnd = end - delta;
    for (const [id, span] of this.spans) {
      if (!span || id === message.capture) continue;
      if (span.start >= oldEnd) {
        span.start += delta;
        span.end += delta;
      } else if (span.end > start) this.spans.set(id, null);
    }
    this.cursor = end;
    if (replacing && cursor !== null && cursor !== replacing.end) {
      const restore = cursor < start ? cursor : cursor + delta;
      if (view) {
        view.dispatch({ selection: { anchor: restore } });
        this.cursor = restore;
      } else if (selectOffsets(field, restore, restore)) this.cursor = restore;
    }
    this.value = updated;
    if (message.interim) {
      this.spans.set(message.capture, { start, end, space, text: message.text, target: message.target });
      // A switched-away field may never receive the final for its old capture.
      if (this.spans.size > 100) this.spans.delete(this.spans.keys().next().value!);
    }
  }
}
