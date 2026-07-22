import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";

export function FileEditor({
  path,
  value,
  readOnly,
  onChange,
  onBlur,
}: {
  path: string;
  value: string;
  readOnly: boolean;
  onChange: (text: string) => void;
  onBlur: () => void;
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const syncing = useRef(false);
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
          language.of([]),
          editable.of(EditorView.editable.of(!readOnly)),
          EditorView.contentAttributes.of({ spellcheck: "false", "aria-label": `Editor for ${path}` }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !syncing.current) changeRef.current(update.state.doc.toString());
            if (update.focusChanged && !update.view.hasFocus) blurRef.current();
          }),
          EditorView.theme({
            "&": { height: "100%", backgroundColor: "var(--surface, #111820)", color: "var(--text, #dce6ee)" },
            ".cm-scroller": { fontFamily: "var(--mono, ui-monospace, monospace)", fontSize: "12px" },
            ".cm-gutters": { backgroundColor: "var(--surface-2, #17212b)", color: "var(--dim, #778899)", border: "0" },
            ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "color-mix(in srgb, var(--accent, #5fc4ff) 8%, transparent)" },
            ".cm-content": { caretColor: "var(--accent, #5fc4ff)" },
            ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "rgba(71, 151, 210, .32) !important" },
          }),
        ],
      }),
    });
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
  }, [path, readOnly]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === value) return;
    syncing.current = true;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    syncing.current = false;
  }, [value]);

  return <div className="file-codemirror" ref={host} />;
}
