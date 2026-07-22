import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { Compartment, EditorState } from "@codemirror/state";
import type { ChangeSet } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { tags } from "@lezer/highlight";

// The source editor is part of Mission Control, not a light CodeMirror island. Every
// token uses the application's semantic palette: blue for callable/navigation symbols,
// green for string data, orange for literals, purple for control flow, and the existing
// terracotta type accent. All of them inherit the active app theme through CSS variables.
const missionHighlight = HighlightStyle.define([
  { tag: [tags.comment, tags.meta], color: "var(--dim)", fontStyle: "italic" },
  { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.modifier], color: "var(--purple)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.url], color: "var(--idle)" },
  { tag: [tags.number, tags.bool, tags.atom, tags.null], color: "var(--attention)" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "var(--syntax-type)" },
  { tag: [tags.function(tags.variableName), tags.labelName, tags.tagName], color: "var(--working)" },
  { tag: [tags.propertyName, tags.attributeName], color: "var(--attention)" },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: "var(--muted)" },
  { tag: [tags.heading, tags.strong], color: "var(--fg)", fontWeight: "700" },
  { tag: [tags.emphasis], color: "var(--fg)", fontStyle: "italic" },
  { tag: [tags.link], color: "var(--working)", textDecoration: "underline" },
  { tag: [tags.invalid], color: "var(--danger)", textDecoration: "underline wavy" },
]);

function exactLineStarts(value: string): number[] {
  const starts = [0];
  const breaks = /\r\n|\r|\n/g;
  for (let match = breaks.exec(value); match; match = breaks.exec(value)) {
    starts.push(match.index + match[0].length);
  }
  return starts;
}

function exactOffset(lineStarts: readonly number[], state: EditorState, position: number): number {
  const line = state.doc.lineAt(position);
  const start = lineStarts[line.number - 1];
  if (start === undefined) throw new Error("editor source and document line counts diverged");
  return start + position - line.from;
}

/** Apply abstract CodeMirror positions without rewriting untouched source line endings. */
export function applyExactEditorChanges(
  value: string,
  state: EditorState,
  changes: ChangeSet,
  insertedLineSeparator = "\n",
): string {
  const edits: Array<{ from: number; to: number; insert: string }> = [];
  const lineStarts = exactLineStarts(value);
  changes.iterChanges((from, to, _fromNew, _toNew, inserted) => {
    edits.push({
      from: exactOffset(lineStarts, state, from),
      to: exactOffset(lineStarts, state, to),
      insert: inserted.sliceString(0, undefined, insertedLineSeparator),
    });
  });
  let next = value;
  for (let index = edits.length - 1; index >= 0; index -= 1) {
    const edit = edits[index]!;
    next = next.slice(0, edit.from) + edit.insert + next.slice(edit.to);
  }
  return next;
}

export function FileEditor({
  path,
  value,
  readOnly,
  lineSeparator,
  onChange,
  onBlur,
}: {
  path: string;
  value: string;
  readOnly: boolean;
  /** Preserve a caller's exact newline convention when CodeMirror serializes an edit. */
  lineSeparator?: "\n" | "\r\n" | "\r";
  onChange: (text: string) => void;
  onBlur: () => void;
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const syncing = useRef(false);
  const exactValue = useRef(value);
  const changeRef = useRef(onChange);
  const blurRef = useRef(onBlur);
  changeRef.current = onChange;
  blurRef.current = onBlur;

  useEffect(() => {
    if (!host.current) return;
    const language = new Compartment();
    const editable = new Compartment();
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          keymap.of([indentWithTab]),
          syntaxHighlighting(missionHighlight),
          language.of([]),
          editable.of(EditorView.editable.of(!readOnly)),
          EditorView.contentAttributes.of({ spellcheck: "false", "aria-label": `Editor for ${path}` }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !syncing.current) {
              exactValue.current = applyExactEditorChanges(
                exactValue.current,
                update.startState,
                update.changes,
                lineSeparator,
              );
              changeRef.current(exactValue.current);
            }
            if (update.focusChanged && !update.view.hasFocus) blurRef.current();
          }),
          EditorView.theme({
            "&": { height: "100%", backgroundColor: "var(--bg-2)", color: "var(--fg)" },
            ".cm-scroller": { fontFamily: "var(--mono)", fontSize: "13px", lineHeight: "1.55" },
            ".cm-content": { caretColor: "var(--working)", padding: "8px 0" },
            ".cm-line": { padding: "0 10px" },
            ".cm-gutters": { backgroundColor: "var(--panel)", color: "var(--dim)", borderRight: "1px solid var(--border)" },
            ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "color-mix(in oklab, var(--working) 10%, transparent)" },
            ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "color-mix(in oklab, var(--working) 28%, transparent) !important" },
            ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--working)" },
            ".cm-panels": { backgroundColor: "var(--panel)", color: "var(--fg)" },
            ".cm-panels input": { backgroundColor: "var(--bg-2)", color: "var(--fg)", border: "1px solid var(--border)" },
            ".cm-tooltip": { backgroundColor: "var(--panel-2)", color: "var(--fg)", border: "1px solid var(--border)" },
            ".cm-searchMatch": { backgroundColor: "color-mix(in oklab, var(--attention) 28%, transparent)" },
            ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in oklab, var(--working) 34%, transparent)" },
          }, { dark: true }),
        ],
      }),
    });
    exactValue.current = value;
    view.current = editor;
    let alive = true;
    const description = LanguageDescription.matchFilename(languages, path);
    if (description) {
      void description.load().then((support) => {
        if (alive) editor.dispatch({ effects: language.reconfigure(support) });
      });
    }
    return () => {
      alive = false;
      editor.destroy();
      view.current = null;
    };
  }, [lineSeparator, path, readOnly]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || exactValue.current === value) return;
    syncing.current = true;
    exactValue.current = value;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    syncing.current = false;
  }, [value]);

  return <div className="file-codemirror" ref={host} />;
}
