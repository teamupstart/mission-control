import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The registry reads the daemon-backed UI store, so stand up its two browser seams before
// importing anything that touches it - the same preamble `terminal-composer-prompt.test.ts`
// documents. The PUT response is uneventful on purpose: `updateUiConfig` applies the patch
// optimistically, which is the value the next render observes.
const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
});
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }),
});

const {
  composerEditorRequested,
  composerEditorStages,
  composerExpandHint,
  composerKeysHint,
} = await import("../src/web/lib/composer-editor.ts");
const {
  ACTIONS,
  bindingValidationError,
  chordSurvivesTyping,
  resetAll,
  resolveKeybindings,
  setBinding,
} = await import("../src/web/lib/keybindings.ts");
const { ComposerEditorModal } = await import("../src/web/components/ComposerEditorModal.tsx");
type ComposerActivityHandlers = Parameters<typeof ComposerEditorModal>[0]["activity"];
const { TranscriptPanel } = await import("../src/web/components/TranscriptPanel.tsx");
const { updateUiConfig } = await import("../src/web/lib/uiConfig.ts");
const { withOverlayHost } = await import("./helpers/overlay-host.ts");
const { mkSession } = await import("./helpers/session-fixture.ts");

const expand = () => ACTIONS.find((a) => a.id === "composerEditor")!;

beforeEach(() => {
  resetAll();
});

// ---- the action ----------------------------------------------------------------

test("expanding the message box is a customizable selection action on ⌃G", () => {
  const action = expand();
  assert.equal(action.defaultBinding, "ctrl+g");
  assert.equal(action.group, "selection");
  // The load-bearing field: it is what makes the registry refuse a chord a textarea would
  // receive as text.
  assert.equal(action.firesWhileTyping, true);
});

test("every shipped default for such an action survives typing", () => {
  // `sanitize` refuses an unsafe OVERRIDE and falls the action back to its default, so a
  // default that was itself unsafe would be the one binding nothing could take away.
  for (const action of ACTIONS.filter((a) => a.firesWhileTyping)) {
    assert.equal(
      bindingValidationError(resolveKeybindings({}), action.id, action.defaultBinding),
      null,
      `${action.id} ships with a default its own rule refuses`,
    );
  }
});

test("it is the only action that fires from inside a text field", () => {
  // A second one would not be dispatched by the composer that dispatches this one, so make
  // the addition deliberate rather than silent.
  assert.deepEqual(
    ACTIONS.filter((a) => a.firesWhileTyping).map((a) => a.id),
    ["composerEditor"],
  );
});

// ---- the chord constraint ------------------------------------------------------

test("a chord that types a character is refused for a shortcut that fires while typing", () => {
  const bindings = resolveKeybindings({});
  // `z` is bound to nothing, so only the typing rule can refuse it: the refusal is about
  // the action, not the chord.
  const refusal = bindingValidationError(bindings, "composerEditor", "z");
  assert.match(refusal ?? "", /fires from inside the send box/);
  assert.match(refusal ?? "", /⌘ or ⌃/);
  // And nothing refuses that chord for an ordinary action.
  assert.equal(bindingValidationError(bindings, "queue", "z"), null);
});

test("⌘, ⌃ and function-key chords remain bindable to it", () => {
  const bindings = resolveKeybindings({});
  for (const chord of ["cmd+e", "ctrl+j", "F9", "shift+F8"]) {
    assert.equal(
      bindingValidationError(bindings, "composerEditor", chord),
      null,
      `${chord} should be bindable`,
    );
  }
  // Shift alone is not enough - Shift+Z still types a character.
  assert.match(bindingValidationError(bindings, "composerEditor", "shift+z") ?? "", /typed into the message/);
});

test("a text-editing command is refused, so the send box keeps copy, paste and undo", () => {
  const bindings = resolveKeybindings({});
  // ⌘V is the one that matters: it carries a command modifier, so the old rule accepted it,
  // and the composer would then have matched it, called preventDefault, and eaten the paste.
  for (const chord of ["cmd+v", "ctrl+v", "cmd+c", "ctrl+c", "cmd+x", "cmd+a", "cmd+z", "ctrl+y", "cmd+shift+z"]) {
    const refusal = bindingValidationError(bindings, "composerEditor", chord);
    assert.match(refusal ?? "", /text-editing command/, `${chord} should be refused`);
    assert.equal(chordSurvivesTyping(chord), false, `${chord} must not survive typing`);
    // And the runtime agrees, so a stored one from an older build opens nothing either.
    assert.equal(composerEditorRequested(chord, chord), false, `${chord} must not open the editor`);
  }
  // The neighbours that are NOT editing commands stay bindable.
  for (const chord of ["ctrl+g", "cmd+e", "cmd+b", "F9"]) {
    assert.equal(bindingValidationError(bindings, "composerEditor", chord), null, `${chord} should bind`);
  }
});

test("excluding editing chords does not disturb Interrupt, which App dispatches itself", () => {
  // ⌃C is the shipped interrupt binding. It is not a `firesWhileTyping` action - App runs it
  // behind its own typing guard - so the composer's rule must not reach it.
  const interrupt = ACTIONS.find((a) => a.id === "interrupt");
  assert.equal(interrupt?.defaultBinding, "ctrl+c");
  assert.equal(interrupt?.firesWhileTyping, undefined);
  assert.equal(bindingValidationError(resolveKeybindings({}), "interrupt", "ctrl+c"), null);
  assert.equal(resolveKeybindings({}).interrupt, "ctrl+c");
});

test("the editor refuses to store a chord that would type itself", () => {
  setBinding("composerEditor", "z");
  assert.equal(resolveKeybindings({}).composerEditor, "ctrl+g", "the refused rebind must not stick");
  setBinding("composerEditor", "cmd+e");
  assert.equal(resolveKeybindings({ composerEditor: "cmd+e" }).composerEditor, "cmd+e");
});

test("a persisted unsafe override is dropped on read rather than obeyed", () => {
  // The migration path for a config written by hand, or by a build that shipped a different
  // rule. Left in place it would open a dialog on every `z` typed into a message.
  assert.equal(resolveKeybindings({ composerEditor: "z" }).composerEditor, "ctrl+g");
});

// ---- the two keystrokes --------------------------------------------------------

test("the bound chord opens the editor and nothing else does", () => {
  assert.equal(composerEditorRequested("ctrl+g", "ctrl+g"), true);
  assert.equal(composerEditorRequested("g", "ctrl+g"), false);
  assert.equal(composerEditorRequested("ctrl+h", "ctrl+g"), false);
  // A lone modifier press yields no chord, and an action with no chord claims nothing.
  assert.equal(composerEditorRequested(null, "ctrl+g"), false);
  assert.equal(composerEditorRequested("ctrl+g", ""), false);
});

test("a binding that could be typed never opens the editor, even if it is stored", () => {
  // The second lock: if such a binding reaches the composer anyway, the character is typed
  // and no dialog appears.
  assert.equal(composerEditorRequested("z", "z"), false);
  assert.equal(composerEditorRequested("shift+z", "shift+z"), false);
});

test("⌘Enter and ⌃Enter stage; a plain or composing Enter does not", () => {
  assert.equal(composerEditorStages({ key: "Enter", metaKey: true, ctrlKey: false }), true);
  assert.equal(composerEditorStages({ key: "Enter", metaKey: false, ctrlKey: true }), true);
  // Enter has to stay a newline: this box exists to write multi-line messages.
  assert.equal(composerEditorStages({ key: "Enter", metaKey: false, ctrlKey: false }), false);
  assert.equal(composerEditorStages({ key: "a", metaKey: true, ctrlKey: false }), false);
  // The IME candidate commit is the same keystroke on a Japanese/Chinese/Korean keyboard.
  assert.equal(
    composerEditorStages({ key: "Enter", metaKey: true, ctrlKey: false, isComposing: true }),
    false,
  );
});

// ---- the hints -----------------------------------------------------------------

test("the composer legend names the resolved expand chord, not the default", () => {
  assert.equal(
    composerKeysHint("ctrl+g"),
    "enter sends · shift+enter newline · ⌃G expands · drop images",
  );
  setBinding("composerEditor", "cmd+e");
  assert.equal(
    composerKeysHint(resolveKeybindings({ composerEditor: "cmd+e" }).composerEditor),
    "enter sends · shift+enter newline · ⌘E expands · drop images",
  );
});

test("an unset expand action drops its clause rather than printing empty punctuation", () => {
  assert.equal(composerKeysHint(""), "enter sends · shift+enter newline · drop images");
  // And the chat rendering prints an empty span rather than a stray chord-less word.
  assert.equal(composerExpandHint(""), "");
  assert.equal(composerExpandHint("ctrl+g"), "⌃G expands");
});

function renderComposer(view: "chat" | "terminal"): string {
  void updateUiConfig({ conversationView: view });
  return renderToStaticMarkup(
    createElement(TranscriptPanel, { session: mkSession(), canSend: true }),
  );
}

test("both conversation composers print the expand chord beside the box", () => {
  for (const view of ["chat", "terminal"] as const) {
    assert.match(renderComposer(view), /⌃G expands/, view);
  }
});

test("the chat composer takes only the expand clause, and keeps teaching the rest", () => {
  // The whole legend on its own line under chat costs the transcript log ~20px, a share
  // `console-tabs-toolbar.spec.ts` measures. Chat prints the one key a placeholder cannot
  // carry; the placeholder keeps the other three.
  const chat = renderComposer("chat");
  assert.match(chat, /<span class="pty-sendkey">⌃G expands<\/span>/);
  assert.ok(!chat.includes("enter sends ·"), "the full legend must not reach the chat row");
  assert.match(
    chat,
    /Reply to this session…  \(Enter to send, Shift\+Enter for newline, drop or paste images\)/,
  );
  // The terminal prompt row has space beside it, so it keeps the whole list.
  assert.match(
    renderComposer("terminal"),
    /enter sends · shift\+enter newline · ⌃G expands · drop images/,
  );
});

test("both conversation composers follow a rebound expand action", () => {
  setBinding("composerEditor", "cmd+e");
  for (const view of ["chat", "terminal"] as const) {
    const html = renderComposer(view);
    assert.match(html, /⌘E expands/, view);
    assert.ok(!html.includes("⌃G"), `${view}: the stale default must not remain`);
  }
});

// ---- the dialog ----------------------------------------------------------------

/** The activity handlers the dialog must wire, recorded so a test can see which fired. */
function recordingActivity(): { calls: string[]; handlers: ComposerActivityHandlers } {
  const calls: string[] = [];
  return {
    calls,
    handlers: {
      onFocus: () => calls.push("focus"),
      onBlur: () => calls.push("blur"),
      onInput: () => calls.push("input"),
    },
  };
}

function renderModal(
  props: { text: string; reopenHint: string },
  activity: ComposerActivityHandlers = recordingActivity().handlers,
): string {
  return renderToStaticMarkup(
    withOverlayHost(
      createElement(ComposerEditorModal, {
        ...props,
        activity,
        onStage: () => {},
        onClose: () => {},
      }),
    ),
  );
}

test("the editor opens on exactly what the send box holds", () => {
  const html = renderModal({ text: "first line\nsecond line", reopenHint: "⌃G" });
  assert.match(html, /first line\nsecond line<\/textarea>/);
  assert.match(html, /aria-label="Message"/);
});

test("the editor's textarea wires the composer's activity reporter", () => {
  // Read from source, because `renderToStaticMarkup` drops handlers and this is precisely a
  // handler bug: opening the dialog blurs the reply box, so the panel releases the composer
  // lease and stops its heartbeat. Without all three of these the operator reads as idle
  // while they write, and Foreman enters the conversation mid-message.
  const src = readFileSync(
    new URL("../src/web/components/ComposerEditorModal.tsx", import.meta.url),
    "utf8",
  );
  for (const wiring of [
    "onFocus={activity.onFocus}",
    "onBlur={activity.onBlur}",
    "onChange={activity.onInput}",
  ]) {
    assert.ok(src.includes(wiring), `the editor's textarea must wire ${wiring}`);
  }
});

test("the editor never offers to send, only to stage", () => {
  const html = renderModal({ text: "draft", reopenHint: "⌃G" });
  assert.match(html, /Stage in the send box/);
  // The one thing this dialog must not do. A Send button here would deliver a message
  // somebody opened this box specifically to think about.
  assert.ok(!/>Send</.test(html), "the editor must not offer a send");
  assert.match(html, /without sending it/);
});

test("the dialog names the way back into itself, and drops that clause when unbound", () => {
  assert.match(renderModal({ text: "", reopenHint: "⌃G" }), /⌃G opens it here again/);
  const unbound = renderModal({ text: "", reopenHint: "" });
  assert.ok(!unbound.includes("opens it here again"));
  assert.match(unbound, /without sending it\./);
});
