import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { basicSetup } from "codemirror";
import { Compartment, EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
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

// ---- find in this document ----
//
// The Editor's half of the Files workspace's find. It follows the comment model's rule
// above without exception: **the workspace owns the model, a `StateEffect` carries it, and
// every decoration is recomputed from it.** Nothing is mapped through a document change,
// because three of this component's four update paths destroy mapped decorations outright.
//
// It also takes CodeMirror's find away, and that is the point rather than a side effect.
// `basicSetup` carries `@codemirror/search`, whose panel has different chrome, a different
// count and no idea the Preview beside it exists. Every binding of that keymap which can
// OPEN the panel is claimed at the highest precedence - not only Mod-f, because its
// find-next and find-previous commands open the panel too when no query is set, and
// go-to-line opens one of its own. Find-next and find-previous are repurposed to step the
// shared ring rather than deadened, so F3 and Mod-g keep meaning what a reader expects.
//
// **All of it is installed only when a caller supplies a find owner.** `FileEditor` has
// four hosts and three of them - the Persona, Session action and Foreman profile editors -
// have no find session. Claiming the chord there would suppress CodeMirror's panel and
// answer with nothing, leaving those three with no find at all where they have a working
// one today. A chord is only taken by a surface that can answer it.

/** One match, as offsets into the buffer text this editor was handed. */
export interface FileEditorFindHit {
  start: number;
  end: number;
}

/** What a claimed chord asks the owner to do. */
export type FileEditorFindAction = "open" | "next" | "previous";

export interface FileEditorFind {
  /** In document order. Empty while find is closed, which is the ordinary state. */
  hits: readonly FileEditorFindHit[];
  /** Index into `hits`, or -1. */
  currentIndex: number;
  /**
   * Bumped when the current hit should be brought into view.
   *
   * A nonce for `scrollTo`'s reason, and the same discipline: hits are recomputed on every
   * keystroke in the file, so scrolling whenever the model moved would yank a reader who
   * is typing back to the match. Only deliberate find navigation bumps this.
   */
  scrollNonce: number;
  onChord: (action: FileEditorFindAction) => void;
}

const setFindModel = StateEffect.define<FileEditorFind | null>();

const findModel = StateField.define<FileEditorFind | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setFindModel)) return effect.value;
    }
    return value;
  },
});

/**
 * The hits, painted.
 *
 * CodeMirror's OWN class names, so the theme rules this component already carries
 * (`.cm-searchMatch`, `.cm-searchMatch.cm-searchMatch-selected`) keep applying and the
 * replacement looks like the thing it replaced. Exported so the ranges are assertable
 * without a browser.
 *
 * Clamped to `docLength`, because a document change and the model that follows it are two
 * dispatches: for the moment between them the offsets describe text that has already
 * moved, and a range past the end of the document is an exception rather than a stale
 * highlight.
 */
export function findDecorations(
  find: FileEditorFind | null,
  docLength: number,
): DecorationSet {
  if (!find || find.hits.length === 0) return Decoration.none;
  const hit = Decoration.mark({ class: "cm-searchMatch" });
  const current = Decoration.mark({ class: "cm-searchMatch cm-searchMatch-selected" });
  const ranges = [];
  for (const [at, { start, end }] of find.hits.entries()) {
    const from = Math.max(0, Math.min(start, docLength));
    const to = Math.max(0, Math.min(end, docLength));
    if (from >= to) continue;
    ranges.push((at === find.currentIndex ? current : hit).range(from, to));
  }
  return Decoration.set(ranges, true);
}

/**
 * Which claimed chord an event is, decided from the event itself.
 *
 * A `keydown` handler rather than a `keymap`, and that is a correctness fix rather than a
 * style choice. A CodeMirror binding spells its shifted pair with a `shift` property, and
 * that property resolves differently for a LETTER than for a named key: under Shift the
 * `g` key reports `event.key` as `"G"`, which is a character carrying its own shift, so the
 * lookup and the `shift` fallback do not agree the way they do for `F3`. The observable
 * consequence was platform-split - Shift+⌘G stepped backwards on macOS while Shift+Ctrl+G
 * stepped FORWARDS on Linux, which a CI shard caught and a local run never could.
 *
 * Deciding here from `shiftKey` directly is the same lesson the comment bridge already
 * learned about lists: state the rule rather than depend on a resolution you did not write.
 * `null` means "not ours", and the caller leaves the event alone.
 */
export function editorFindChord(event: KeyboardEvent): FileEditorFindAction | "inert" | null {
  // ⌘ on macOS, Ctrl elsewhere - the same "Mod" CodeMirror's own bindings mean.
  const mod = event.metaKey || event.ctrlKey;
  const key = event.key;
  if (key === "F3") return event.shiftKey ? "previous" : "next";
  if (!mod) return null;
  const letter = key.length === 1 ? key.toLowerCase() : key;
  // Go-to-line: claimed and inert, because it belongs to a panel this surface no longer
  // has and leaving it unclaimed would open that panel by the back door.
  if (letter === "g" && event.altKey) return "inert";
  if (letter === "g") return event.shiftKey ? "previous" : "next";
  // Alt+⌘F is not find; only the bare modifier pair opens the bar.
  if (letter === "f" && !event.altKey) return "open";
  return null;
}

function findExtension(read: () => FileEditorFind | undefined): Extension {
  return [
    findModel,
    // `Prec.highest` is load-bearing: `basicSetup` is first in the extension array, so a
    // plain handler after it would lose to `searchKeymap` on every one of these. Returning
    // true is what stops the event, so `searchKeymap` never sees any chord that can open
    // its panel.
    Prec.highest(
      EditorView.domEventHandlers({
        keydown: (event) => {
          const chord = editorFindChord(event);
          if (chord === null) return false;
          event.preventDefault();
          if (chord !== "inert") read()?.onChord(chord);
          return true;
        },
      }),
    ),
    // `"doc"` as well as the field, so the clamp above is recomputed when the document
    // length changes under a model that has not caught up yet.
    EditorView.decorations.compute([findModel, "doc"], (state): DecorationSet =>
      findDecorations(state.field(findModel, false) ?? null, state.doc.length)),
  ];
}

export function FileEditor({
  path,
  value,
  readOnly,
  lineSeparator,
  comments,
  find,
  scrollTo = null,
  onChange,
  onBlur,
}: {
  path: string;
  value: string;
  readOnly: boolean;
  /** Preserve a caller's exact newline convention when CodeMirror serializes an edit. */
  lineSeparator?: "\n" | "\r\n" | "\r";
  /** Line-comment markers and the open panel. Absent when nothing has comments to draw. */
  comments?: FileEditorComments;
  /**
   * A find owner: the matches to paint, and where a claimed chord goes.
   *
   * ABSENT is the signal, exactly as `comments` and `Markdown`'s `blockAnchor` are. Without
   * it this editor keeps `searchKeymap` whole, panel and all - see the block comment above
   * `FileEditorFind`. Its presence must not change over one mount: it is read by the mount
   * effect, which is keyed on it for that reason.
   */
  find?: FileEditorFind;
  /**
   * Bring a 1-based source line into view, once per request.
   *
   * A NONCE beside the line rather than the line alone, because the same line is a legitimate
   * second request - a deep link followed twice, or the walkthrough returning to a comment
   * after the reader scrolled away - and a bare `line` prop would fire only on a change.
   *
   * Fire-once and derived-on-demand, like everything else positional here: the view is
   * destroyed outright on a `path` or `readOnly` change, so this must not remember a
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
  const findRef = useRef(find);
  changeRef.current = onChange;
  blurRef.current = onBlur;
  commentsRef.current = comments;
  // Refreshed during render for `commentsRef`'s reason: the keymap reaches the owner through
  // it, so the very first chord after a state change already calls the current closure.
  findRef.current = find;
  const findOwned = find !== undefined;

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
          findOwned ? findExtension(() => findRef.current) : [],
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
    /*
     * The panel host is sized from the SCROLLPORT, not from its containing block: it is a
     * block widget inside `.cm-content`, whose width in a non-wrapping editor is the longest
     * line in the file, so inheriting it left the composer wider than the pane.
     *
     * One gutter reference, measured and observed, so the two cannot drift apart. The view
     * owns that element for its whole life, and this effect is keyed on the view.
     */
    const gutters = editor.scrollDOM.querySelector<HTMLElement>(".cm-gutters");
    const fitPanelHost = (): void => {
      const host = panelHost.current;
      if (!host) return;
      const inset = gutters?.offsetWidth ?? 0;
      const width = editor.scrollDOM.clientWidth - inset;
      host.style.width = width > 0 ? `${width}px` : "";
      host.style.left = `${inset}px`;
    };
    fitPanelHost();
    // The gutters are observed as well as the scrollport: a file that grows past a digit
    // boundary widens them without the pane changing size at all.
    const fitting = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fitPanelHost);
    fitting?.observe(editor.scrollDOM);
    if (gutters) fitting?.observe(gutters);
    // The rebuilt view starts with an empty model, so it is seeded from the ref rather
    // than waiting for the next model change - which may never come, since a path or
    // read-only change moves neither the markers nor the open line.
    if (commentsRef.current) {
      editor.dispatch({ effects: setCommentModel.of(commentsRef.current) });
    }
    // Seeded for the same reason: a rebuilt view starts with an empty model, and a path or
    // read-only change moves neither the query nor its hits, so the next model change may
    // never come.
    if (findRef.current) {
      editor.dispatch({ effects: setFindModel.of(findRef.current) });
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
      fitting?.disconnect();
      editor.destroy();
      view.current = null;
    };
  }, [findOwned, lineSeparator, path, readOnly]);

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

  /**
   * What the editor has to be told about find again - `commentKey`'s shape, for its reason.
   *
   * The offsets and the current index are the whole of what the extension reads out of the
   * model; `onChord` is reached through `findRef`, which is always current. Depending on the
   * object itself would dispatch into CodeMirror on every render of the workspace above.
   */
  const findKey = find
    ? `${find.currentIndex}|${find.hits.map((hit) => `${hit.start}:${hit.end}`).join(",")}`
    : "";
  useEffect(() => {
    view.current?.dispatch({ effects: setFindModel.of(findRef.current ?? null) });
  }, [findKey]);

  /*
   * Bring the current match into view, once per request.
   *
   * Through the find model's own nonce rather than `scrollTo`: that prop belongs to the two
   * things that ask for a LINE - a deep link and the comment walkthrough - and find knows the
   * character, which is a better answer for a long line and one `scrollTo` cannot carry.
   * The nonce discipline is identical, and it is what stops a reader who is typing in a file
   * with find open from being dragged back to the match on every keystroke.
   */
  const scrolledFindNonce = useRef<number | null>(null);
  useEffect(() => {
    const editor = view.current;
    if (!editor || !find || find.scrollNonce === scrolledFindNonce.current) return;
    const hit = find.hits[find.currentIndex];
    if (!hit) return;
    scrolledFindNonce.current = find.scrollNonce;
    const at = Math.max(0, Math.min(hit.start, editor.state.doc.length));
    editor.dispatch({ effects: EditorView.scrollIntoView(at, { y: "center" }) });
  }, [find]);

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
   *
   * ONCE PER REQUEST, tracked by nonce, and the nonce is what makes that possible - `scrollTo`
   * is a fresh object on most renders, so identity cannot say whether this is a new request or
   * the same one seen again. Depending on `value` without the guard turned every later
   * keystroke into another scroll: a reader who followed a link to line 84, scrolled somewhere
   * else and started typing was yanked back to line 84 on each character, and an agent editing
   * the file underneath them did the same thing. A scroll request is a one-shot instruction to
   * go somewhere, never a position to hold the reader at.
   */
  const scrolledNonce = useRef<number | null>(null);
  useEffect(() => {
    const editor = view.current;
    if (!editor || !scrollTo || scrolledNonce.current === scrollTo.nonce) return;
    // Still deferred until the document arrives - an unanswered request stays unanswered, so
    // the first render that HAS content is the one that spends it.
    if (!value) return;
    scrolledNonce.current = scrollTo.nonce;
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
