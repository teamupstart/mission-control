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

/** Capture the caret and the field after an interim edit. A user edit or caret
 * move cancels replacement for the rest of that phrase. */
function replacement(field: HTMLElement, inserted: string): () => boolean {
  if (isControl(field) && field.selectionStart !== null) {
    const end = field.selectionStart;
    const value = field.value;
    const start = end - inserted.length;
    return () => {
      if (field.value !== value || start < 0 || value.slice(start, end) !== inserted ||
          field.selectionStart !== end || field.selectionEnd !== end) return false;
      field.setSelectionRange(start, end);
      return true;
    };
  }
  if (isControl(field)) {
    const value = field.value;
    // Chromium supports native selection movement in email and number fields
    // even though their HTML selectionStart and setSelectionRange APIs are unavailable.
    return () => {
      const selection = document.getSelection();
      if (!selection || field.value !== value || selection.toString()) return false;
      const characters = new Intl.Segmenter().segment(inserted);
      for (const _ of characters) selection.modify("extend", "backward", "character");
      if (selection.toString() === inserted) return true;
      selection.modify("move", "forward", "character");
      return false;
    };
  }
  const selection = document.getSelection();
  const node = selection?.focusNode;
  const end = selection?.focusOffset ?? 0;
  return () => {
    if (!selection || !node || node.nodeType !== Node.TEXT_NODE || !field.contains(node) ||
        !selection.isCollapsed || selection.focusNode !== node || selection.focusOffset !== end ||
        end < inserted.length || node.textContent?.slice(end - inserted.length, end) !== inserted) return false;
    selection.setBaseAndExtent(node, end - inserted.length, node, end);
    return true;
  };
}

export class DictationEditor {
  private pending?: { capture: string; target: string; select: () => boolean; text: string; space: string };

  insert(field: HTMLElement, message: Dictation): void {
    const prior = this.pending?.capture === message.capture ? this.pending : undefined;
    const sameFocus = prior?.target === message.target;
    if (sameFocus && message.text === prior?.text) {
      if (!message.interim) this.pending = undefined;
      return;
    }
    const replacing = prior?.select() ? prior : undefined;
    if (sameFocus && !replacing) return;
    const selection = document.getSelection();
    const before = isControl(field) ? field.value.slice(0, field.selectionStart ?? 0)
      : selection?.anchorNode?.textContent?.slice(0, selection.anchorOffset) ?? "";
    const space = replacing?.space ?? (/[\p{L}\p{N}.!?]$/u.test(before) && /^[\p{L}\p{N}]/u.test(message.text) ? " " : "");
    const inserted = space + message.text;
    // The native edit fires input for React and CodeMirror, and participates in Undo.
    if (!document.execCommand("insertText", false, inserted)) return;
    this.pending = message.interim ? { capture: message.capture, target: message.target, text: message.text, space, select: replacement(field, inserted) } : undefined;
  }
}
