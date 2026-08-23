import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { basicSetup } from "codemirror";
import { Compartment, EditorState, StateEffect, StateField } from "@codemirror/state";
import type { ChangeSet, Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
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
  const lineStarts = exactLineStarts(value);
  const chunks: string[] = [];
  let cursor = 0;
  changes.iterChanges((from, to, _fromNew, _toNew, inserted) => {
    const exactFrom = exactOffset(lineStarts, state, from);
    const exactTo = exactOffset(lineStarts, state, to);
    chunks.push(
      value.slice(cursor, exactFrom),
      inserted.sliceString(0, undefined, insertedLineSeparator),
    );
    cursor = exactTo;
  });
  chunks.push(value.slice(cursor));
  return chunks.join("");
}

// ---- line comments ----
//
// One rule holds this together: **every marker and the open panel are derived from the
// model on each render, and nothing is mapped through a document change.** Three of this
// component's four update paths destroy position-mapped decorations outright - the
// external sync below replaces the whole document, and the mount effect rebuilds the
// `EditorView` from scratch whenever `path`, `readOnly` or `lineSeparator` change - so a
// decoration that remembered where it used to be would be wrong after any of them and
// right only by luck. A decoration recomputed from `startLine` cannot notice.
//
// The workspace above owns the model, the writes and the panel's React tree. What lives
// here is the part only CodeMirror can do: put a control in the gutter beside the right
// line, and open a block under it.

/** One line's marker, as the workspace has already resolved it. */
export interface FileEditorCommentMarker {
  /** 1-based, in the file's source. */
  line: number;
  /** The button's accessible name - it names the line and the thread's state. */
  label: string;
  /** A tone class, so a resolved or stale thread does not read as a live one. */
  tone: string;
}

export interface FileEditorComments {
  markers: readonly FileEditorCommentMarker[];
  /** The line whose panel is open, or null when none is. */
  panelLine: number | null;
  /** Rendered into a block widget under `panelLine`. */
  panel: React.ReactNode;
  /**
   * A click on a line NUMBER, while comment mode is on. Null turns the gutter back into
   * an ordinary one.
   *
   * This is a CodeMirror gutter handler and not the workspace's window chord for a reason
   * worth writing down: the window handler stands down on `isTypingTarget`, which is true
   * for any `contentEditable` element, and CodeMirror's `.cm-content` is exactly that. A
   * bare key or a click routed through that handler never arrives inside the editor.
   */
  onLineSelect: ((line: number) => void) | null;
  /** A click on an existing line's marker. */
  onMarkerSelect: (line: number) => void;
}

/** The live model, swapped in wholesale rather than patched. */
const setCommentModel = StateEffect.define<FileEditorComments | null>();

const commentModel = StateField.define<FileEditorComments | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setCommentModel)) return effect.value;
    }
    return value;
  },
});

/**
 * A line's marker: a real button, with a name that says which comment it is, which line it
 * is on and what state it is in.
 *
 * **In the content, not in the gutter, and that is a deliberate departure from the phase
 * plan.** A gutter marker is the obvious shape and it was written that way first - it
 * renders correctly and it is unreachable. CodeMirror puts `aria-hidden="true"` on both
 * `.cm-gutters` containers (`@codemirror/view`, `GutterView`), which is right for line
 * numbers and fold arrows and fatal for a control: `aria-hidden` is inherited and a
 * descendant cannot opt back in, so the marker was invisible to a screen reader and to
 * every role-based selector, including the browser spec's. The alternatives were to strip
 * that attribute - which would read every line number out to a screen reader - or to put
 * the marker where the reader already is. An inline widget at the end of the anchored line
 * is in the accessibility tree, is reachable by Tab, and sits closer to the text it is
 * about than a gutter dot does.
 */
class CommentMarkerWidget extends WidgetType {
  constructor(
    private readonly marker: FileEditorCommentMarker,
    private readonly onSelect: (line: number) => void,
  ) {
    super();
  }

  override eq(other: CommentMarkerWidget): boolean {
    return other.marker.line === this.marker.line
      && other.marker.label === this.marker.label
      && other.marker.tone === this.marker.tone;
  }

  override toDOM(): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `cm-file-comment-marker ${this.marker.tone}`;
    // The accessible name is the whole content: the glyph is decorative, and a marker that
    // announced itself as "●" would say nothing about which line or what state.
    button.setAttribute("aria-label", this.marker.label);
    button.textContent = "●";
    // The widget is not part of the document being edited. Without this the button sits
    // inside `.cm-content`'s `contenteditable` region, where a browser treats it as text
    // rather than as a control - which is what keeps it out of the tab order.
    button.contentEditable = "false";
    // Two listeners, and the split is the point. `mousedown` only defends the caret: left
    // to the browser, a press here lands in the document behind the widget and moves the
    // insertion point. ACTIVATION is on `click`, which a native button also fires for Enter
    // and for Space - so the marker answers the keyboard as well as the pointer.
    //
    // Acting on `mousedown` alone was the bug: this control was moved out of the gutter
    // precisely because CodeMirror hides gutters from assistive technology, and then it
    // could still only be reached with a mouse.
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onSelect(this.marker.line);
    });
    return button;
  }

  /** The button has its own click; the editor must not claim it. */
  override ignoreEvent(): boolean {
    return true;
  }
}

/**
 * The open panel, hosted in a block widget under its line.
 *
 * `toDOM` hands back an element the component owns and portals React into, so the tree
 * inside it survives everything CodeMirror does to the decoration around it - including
 * the view being destroyed and rebuilt. `eq` compares that host, so an identical model
 * redraw reuses the same DOM and never blows away a half-typed comment.
 */
class CommentPanelWidget extends WidgetType {
  constructor(private readonly host: HTMLElement) {
    super();
  }

  override eq(other: CommentPanelWidget): boolean {
    return other.host === this.host;
  }

  override toDOM(): HTMLElement {
    return this.host;
  }

  /** The panel has its own controls; the editor must not claim their events. */
  override ignoreEvent(): boolean {
    return true;
  }
}

function commentExtension(
  read: () => FileEditorComments | undefined,
  panelHost: () => HTMLElement | null,
): Extension {
  return [
    commentModel,
    // A SECOND `lineNumbers()` beside `basicSetup`'s, which is supported rather than a
    // trick: `lineNumberConfig` merges `domEventHandlers` across every call, and the
    // gutter itself is a module-level extension value, so it dedupes to one gutter. That
    // is what lets a click on the line NUMBER open a composer without this component
    // taking ownership of how line numbers are drawn.
    lineNumbers({
      domEventHandlers: {
        mousedown: (view, block) => {
          const select = read()?.onLineSelect;
          if (!select) return false;
          select(view.state.doc.lineAt(block.from).number);
          return true;
        },
      },
    }),
    // `"doc"` as well as the field: both decorations are positioned from a line number, so
    // they have to be recomputed when the lines move even though the model did not change.
    // Nothing here is ever mapped through a change - see the note at the top of this block.
    EditorView.decorations.compute([commentModel, "doc"], (state): DecorationSet => {
      const model = state.field(commentModel, false);
      if (!model) return Decoration.none;
      /** Clamped, because an external edit can shorten the file under an open marker. */
      const lineAt = (line: number) =>
        state.doc.line(Math.min(Math.max(1, line), state.doc.lines));
      const ranges = model.markers.map((marker) =>
        Decoration.widget({
          widget: new CommentMarkerWidget(marker, (at) => read()?.onMarkerSelect(at)),
          side: 1,
        }).range(lineAt(marker.line).to)
      );
      const host = panelHost();
      if (model.panelLine !== null && host) {
        ranges.push(
          Decoration.widget({ widget: new CommentPanelWidget(host), block: true, side: 2 })
            .range(lineAt(model.panelLine).to),
        );
      }
      // Sorted on the way in: a marker and the panel can share a position, and two markers
      // arrive in model order rather than document order.
      return Decoration.set(ranges, true);
    }),
  ];
}

export function FileEditor({
  path,
  value,
  readOnly,
  wrap = false,
  lineSeparator,
  comments,
  scrollTo = null,
  onChange,
  onBlur,
}: {
  path: string;
  value: string;
  readOnly: boolean;
  /**
   * Wrap long lines instead of scrolling them sideways.
   *
   * Off for the Editor, where a horizontal scroll is the honest rendering of source and
   * wrapping would misrepresent what the file says. On for the source column Comment mode
   * puts beside a preview: it is half as wide, it is read-only, and it exists to be POINTED
   * AT - a marker that has scrolled off the right edge is a marker nobody can click.
   */
  wrap?: boolean;
  /** Preserve a caller's exact newline convention when CodeMirror serializes an edit. */
  lineSeparator?: "\n" | "\r\n" | "\r";
  /** Line-comment markers and the open panel. Absent when nothing has comments to draw. */
  comments?: FileEditorComments;
  /**
   * Bring a 1-based source line into view, once per request.
   *
   * A NONCE beside the line rather than the line alone, because the same line is a legitimate
   * second request - a deep link followed twice, or the walkthrough returning to a comment
   * after the reader scrolled away - and a bare `line` prop would fire only on a change.
   *
   * Fire-once and derived-on-demand, like everything else positional here: the view is
   * destroyed outright on a `path`, `readOnly` or `wrap` change, so this must not remember a
   * position. It reads the line off `state.doc` at the moment it runs.
   */
  scrollTo?: { line: number; nonce: number } | null;
  onChange: (text: string) => void;
  onBlur: () => void;
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const syncing = useRef(false);
  const exactValue = useRef(value);
  const changeRef = useRef(onChange);
  const blurRef = useRef(onBlur);
  const commentsRef = useRef(comments);
  changeRef.current = onChange;
  blurRef.current = onBlur;
  commentsRef.current = comments;

  /**
   * The panel's portal target, created once and never by React.
   *
   * It has to outlive the `EditorView`, which is destroyed and rebuilt on a path or
   * read-only change, and it has to be a node React can portal into before CodeMirror has
   * attached it anywhere. A ref filled on first render is both; `document` is guarded
   * because this module is imported by tests that only render markup.
   */
  const panelHost = useRef<HTMLElement | null>(null);
  if (!panelHost.current && typeof document !== "undefined") {
    panelHost.current = document.createElement("div");
    panelHost.current.className = "file-comment-host";
  }

  /**
   * What the editor has to be told about again.
   *
   * `comments` is a fresh object every render, so depending on it would dispatch into
   * CodeMirror on every keystroke in the file. The markers and the open line are the whole
   * of what the extension reads out of the model - the callbacks are reached through
   * `commentsRef`, which is always current - so this is the honest dependency.
   */
  const commentKey = comments
    ? `${comments.panelLine ?? ""}|${comments.onLineSelect ? "pick" : "-"}|${
      comments.markers.map((marker) => `${marker.line}:${marker.tone}:${marker.label}`).join(",")
    }`
    : "";

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
          commentExtension(() => commentsRef.current, () => panelHost.current),
          keymap.of([indentWithTab]),
          syntaxHighlighting(missionHighlight),
          language.of([]),
          editable.of(EditorView.editable.of(!readOnly)),
          ...(wrap ? [EditorView.lineWrapping] : []),
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
    // The rebuilt view starts with an empty model, so it is seeded from the ref rather
    // than waiting for the next model change - which may never come, since a path or
    // read-only change moves neither the markers nor the open line.
    if (commentsRef.current) {
      editor.dispatch({ effects: setCommentModel.of(commentsRef.current) });
    }
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
  }, [lineSeparator, path, readOnly, wrap]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || exactValue.current === value) return;
    syncing.current = true;
    exactValue.current = value;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    syncing.current = false;
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: setCommentModel.of(commentsRef.current ?? null) });
  }, [commentKey]);

  /*
   * Deep-linking's last mile. `workspaceFileTarget` has always parsed `path:line`, and the
   * line was dropped on the floor between there and here - so "open plan.md line 84" opened
   * plan.md at the top and left the reader to find line 84.
   *
   * Ordered AFTER the mount effect so a view rebuilt by a path change is already there to
   * scroll, and clamped like `lineAt` above, because a request can name a line past the end
   * of a file that has since been shortened. `value` is in the dependency list for the same
   * reason: a deep link arrives before the document does, and scrolling an empty buffer to
   * line 84 lands on line 1.
   */
  useEffect(() => {
    const editor = view.current;
    if (!editor || !scrollTo) return;
    const line = editor.state.doc.line(
      Math.min(Math.max(1, scrollTo.line), editor.state.doc.lines),
    );
    editor.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
  }, [scrollTo, value]);

  const panel = useMemo(
    () =>
      panelHost.current && comments?.panelLine != null
        ? createPortal(comments.panel, panelHost.current)
        : null,
    [comments?.panel, comments?.panelLine],
  );

  return (
    <>
      <div className="file-codemirror" ref={host} />
      {panel}
    </>
  );
}
