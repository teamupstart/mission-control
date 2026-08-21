import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// What is at stake: ⌃C has to mean two different things depending on one fact, and getting
// the ORDER of that decision wrong breaks the commonest thing in the app rather than the
// rarest.
//
// The gesture stops the selected agent. The same chord is Copy on Windows and Linux, which
// the Electron shell inherits. So a live selection wins - and the check that decides it must
// sit ahead of EVERY dispatch path, because App's `typing` flag is true only for focus
// inside an editable field. Selecting a transcript line, a diff hunk, or captured terminal
// output leaves `typing` false, falls through to the action-bar dispatch, and hits an
// unconditional `preventDefault()`. A check placed inside the typing bypass looks sufficient
// (that is where a text field is) and would ship having silently broken copy on read-only
// text, which is the copy operators actually do.
//
// So this file asserts the predicate in both directions, and then asserts its PLACEMENT
// against the source - the part no test on the predicate alone can see.

const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
});
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }),
});

const { ActionBar } = await import("../src/web/components/ActionBar.tsx");
const { chordYieldsToSelection, resolveKeybindings } = await import(
  "../src/web/lib/keybindings.ts"
);
const { canInterruptSession } = await import("../src/shared/session.ts");
const { interruptUnsupportedWhy, canInterrupt } = await import(
  "../src/shared/harness-capabilities.ts"
);
const { stateDisplay } = await import("../src/web/lib/format.ts");
const { mkSession } = await import("./helpers/session-fixture.ts");

const INTERRUPT_CHORD = resolveKeybindings({}).interrupt;
const app = readFileSync(new URL("../src/web/App.tsx", import.meta.url), "utf8");

function yields(over: Partial<Parameters<typeof chordYieldsToSelection>[0]> = {}): boolean {
  return chordYieldsToSelection({
    chord: INTERRUPT_CHORD,
    interruptChord: INTERRUPT_CHORD,
    documentSelection: "",
    fieldSelection: null,
    ...over,
  });
}

// ---- the predicate ---------------------------------------------------------------

test("the interrupt chord is ⌃C, which is what makes the copy collision real", () => {
  assert.equal(INTERRUPT_CHORD, "ctrl+c");
});

test("with nothing selected the chord belongs to the agent", () => {
  assert.equal(yields(), false, "no selection anywhere - this must stop the agent");
  assert.equal(
    yields({ fieldSelection: { start: 4, end: 4 } }),
    false,
    "a caret in a composer is not a selection",
  );
  assert.equal(
    yields({ fieldSelection: { start: null, end: null } }),
    false,
    "a field that reports no span at all is not a selection either",
  );
});

test("a selection anywhere hands the chord back to the browser, so the copy happens", () => {
  // Read-only text: a transcript line, a diff hunk, captured terminal output. `typing` is
  // FALSE for all of these, which is exactly why the gate cannot live in the typing bypass.
  assert.equal(yields({ documentSelection: "an assistant turn worth keeping" }), true);
  // And inside the composer, where `window.getSelection()` reports nothing at all because
  // the selection lives on the field. Both facts are needed or one of the two copies breaks.
  assert.equal(yields({ fieldSelection: { start: 0, end: 12 } }), true);
});

test("only the interrupt chord yields; every other shortcut still fires while text is selected", () => {
  // Scoped deliberately. Nothing else in the registry is a platform editing key, and a
  // shortcut that failed because of a selection the operator had forgotten about would be a
  // shortcut that fails for no visible reason.
  assert.equal(
    yields({ chord: "k", documentSelection: "some selected text" }),
    false,
    "Kill is not a copy",
  );
  // An action that could not claim a chord claims nothing, rather than claiming "".
  assert.equal(
    yields({ chord: "", interruptChord: "", documentSelection: "some selected text" }),
    false,
  );
});

// ---- where the predicate is consulted --------------------------------------------

test("the selection gate is ONE gate, and it sits ahead of every path that eats the key", () => {
  // The defect this phase was revised to prevent, asserted against the source because it is
  // a property of ORDER and nothing else can see it. If the gate moves back down inside the
  // typing bypass, this fails.
  const calls = [...app.matchAll(/chordYieldsToSelection\(/g)];
  assert.equal(calls.length, 1, "a second gate is a second place to get this wrong");
  const gate = calls[0]!.index!;

  const typingGuard = app.indexOf("if (typing) return;");
  const barDispatch = app.indexOf("const bar = BAR_ACTIONS.find");
  const boardArm = app.indexOf('run === "requestInterrupt"');
  for (const [what, at] of [
    ["the typing guard and the composer bypass above it", typingGuard],
    ["the action-bar dispatch, which preventDefaults unconditionally", barDispatch],
    ["the board overview's in-place arm, which preventDefaults too", boardArm],
  ] as const) {
    assert.notEqual(at, -1, `could not find ${what} in App.tsx`);
    assert.ok(gate < at, `the selection gate must come before ${what}`);
  }
});

test("the gate returns the key to the browser rather than claiming and discarding it", () => {
  // `return` without `preventDefault()` IS the copy. A gate that swallowed the key would
  // read as correct here and would leave the operator pressing ⌃C at nothing.
  const gate = app.indexOf("chordYieldsToSelection(");
  const end = app.indexOf("// Preserve the native activation", gate);
  assert.notEqual(end, -1, "the gate's block could not be bounded");
  const body = app.slice(gate, end);
  assert.doesNotMatch(body, /preventDefault/, body);
  assert.match(body, /\{\s*return;\s*\}/, body);
});

test("interrupt is a deferrable bar action, not a hand-rolled chord comparison", () => {
  const table = app.slice(app.indexOf("const BAR_ACTIONS"), app.indexOf("export function App"));
  assert.match(table, /\["interrupt", "requestInterrupt"\]/, table);
});

test("the composer bypass exists, and stays behind a ⌘/⌃ modifier like the palette's", () => {
  // Without it the chord is dead exactly where decision 3 is about - mid-sentence in the
  // composer, writing the instruction that replaces the work being stopped. The modifier
  // gate is what keeps a rebinding to a bare key from eating that character.
  const bypass = app.indexOf("if (typing && chord === bindings.interrupt");
  assert.notEqual(bypass, -1, "the composer bypass is missing");
  assert.ok(bypass < app.indexOf("if (typing) return;"), "and it must sit above the guard");
  assert.match(
    app.slice(bypass, bypass + 200),
    /chordHasCommandModifier\(chord\)/,
    "a bare-key rebinding must fall back behind the typing guard",
  );
});

test("the board overview runs the interrupt in place instead of drilling in", () => {
  // A live control, like the permission-mode cycle beside it. Opening a detail panel for a
  // keystroke that never needed one is the bug that arm exists to fix, and an agent that
  // goes on working while a panel opens is that bug with worse consequences.
  const arm = app.slice(app.indexOf('run === "requestInterrupt"'), app.indexOf("e.preventDefault();\n      pendingBarAction"));
  assert.match(arm, /canInterruptSession\(overviewSel\)/, arm);
  assert.match(arm, /api\.interrupt\(overviewSel\.id\)/, arm);
});

// ---- who may be interrupted ------------------------------------------------------

test("the offer needs both a mechanism and a turn to stop", () => {
  const embedded = mkSession({ runtime: "sdk", agent: "claude" });
  assert.equal(canInterruptSession(embedded), true);
  assert.equal(canInterruptSession({ ...embedded, agent: "codex" }), true);
  // pi has no driver at all, so the pane keystroke is not one of two mechanisms for it -
  // it is the only one, and it is the reason pi can be interrupted here despite `sdk: null`.
  assert.equal(canInterruptSession({ ...embedded, agent: "pi", runtime: "terminal" }), true);
  // And the runtime pi does NOT have stays refused, rather than inheriting the pane answer.
  assert.equal(canInterruptSession({ ...embedded, agent: "pi", runtime: "sdk" }), false);
  // A mechanism, but no turn: interrupting an idle agent is a key that does nothing.
  assert.equal(canInterruptSession({ ...embedded, state: "idle" }), false);
  assert.equal(canInterruptSession({ ...embedded, state: "exited" }), false);
  assert.equal(canInterruptSession({ ...embedded, state: "stopping" }), false);
  // `starting` counts: a driver that has not emitted anything yet is still driving.
  assert.equal(canInterruptSession({ ...embedded, state: "starting" }), true);
  // And an unconfirmed reading does NOT disqualify it. Refusing to stop exactly the
  // sessions we know least about would strand the case the gesture exists for.
  assert.equal(canInterruptSession({ ...embedded, stateConfirmed: false }), true);
});

test("both runtimes are interruptible, and a runtime a harness lacks is still refused", () => {
  // The gesture now resolves to a mechanism on every shipped harness/runtime pair that
  // exists: the driver primitive for an embedded session, `Escape` into the pane for a
  // terminal one. Pi is terminal-only because it has no driver, not because it is behind.
  assert.equal(canInterrupt("claude", "sdk"), true);
  assert.equal(canInterrupt("claude", "terminal"), true);
  assert.equal(canInterrupt("codex", "terminal"), true);
  assert.equal(canInterrupt("pi", "terminal"), true);
  assert.equal(interruptUnsupportedWhy("claude", "sdk"), null);
  assert.equal(interruptUnsupportedWhy("claude", "terminal"), null);
  assert.equal(interruptUnsupportedWhy("pi", "terminal"), null);
  // The per-runtime refusal is still reachable and still names the runtime - pi declares no
  // `sdk`, so asking for one is the case that sentence exists for.
  assert.match(
    interruptUnsupportedWhy("pi", "sdk") ?? "",
    /can't yet stop a Pi turn running in the Agent SDK/,
  );
});

// ---- the control ------------------------------------------------------------------

function actionBar(session = mkSession({ runtime: "sdk", task: null })): string {
  return renderToStaticMarkup(
    createElement(ActionBar, {
      session,
      onToggleQueue: () => {},
      onReset: () => {},
      onComplete: () => {},
      onKill: () => {},
    }),
  );
}

/** The interrupt button's opening tag, so `disabled` can be read off it alone. */
function interruptButton(html: string): string {
  const at = html.indexOf("btn-interrupt");
  assert.notEqual(at, -1, `no interrupt control was drawn: ${html}`);
  return html.slice(html.lastIndexOf("<button", at), html.indexOf(">", at) + 1);
}

test("a working embedded session gets a live control", () => {
  const html = actionBar();
  assert.doesNotMatch(interruptButton(html), /disabled/);
  assert.match(html, /Interrupt/);
});

test("a working terminal session gets the same live control, with no component change", () => {
  // The point of routing the offer through a capability: this component was written once,
  // for the embedded runtime, and terminal cards lit up when `interrupt.runtimes` gained
  // `"terminal"`. If this ever needs a runtime test in the component, the capability has
  // stopped being the single gate.
  const html = actionBar(mkSession({ runtime: "terminal", task: null }));
  assert.doesNotMatch(interruptButton(html), /disabled/);
  assert.match(html, /Interrupt/);
  assert.doesNotMatch(html, /can&#x27;t yet stop/);
});

test("a pi session gets it too, on the only runtime pi has", () => {
  const html = actionBar(mkSession({ runtime: "terminal", agent: "pi", task: null }));
  assert.doesNotMatch(interruptButton(html), /disabled/);
});

test("an idle session's control says there is nothing to stop, rather than failing on click", () => {
  const html = actionBar(mkSession({ runtime: "sdk", state: "idle", task: null }));
  assert.match(interruptButton(html), /disabled/);
  assert.match(html, /isn&#x27;t running a turn, so there is nothing to stop/);
});

// ---- the transient presentation ---------------------------------------------------

test("interrupting is a badge, not a session state, and never outranks a real reading", () => {
  const working = mkSession({ runtime: "sdk" });
  assert.deepEqual(stateDisplay(working), { label: "working", tone: "working" });
  assert.deepEqual(stateDisplay(working, true), { label: "interrupting", tone: "working" });
  // The tone stays `working` on purpose: the agent has not stopped yet, and any other
  // colour would claim a result that has not arrived.
  assert.equal(stateDisplay(working, true).tone, stateDisplay(working).tone);

  // Everything that outranks it, and why. A session already leaving is past being
  // interrupted; a review or a menu is a thing needing a human, which is more urgent than
  // the progress of a request that human just made.
  assert.equal(stateDisplay({ ...working, state: "exited" }, true).label, "exited");
  assert.equal(stateDisplay({ ...working, state: "stopping" }, true).label, "stopping");
  assert.equal(stateDisplay({ ...working, pendingReviews: 2 }, true).label, "2 to review");
  // But it DOES stand in for an ordinary reading, including the unconfirmed one - which is
  // the case it matters most for, since that card would otherwise just say "running".
  assert.equal(stateDisplay({ ...working, stateConfirmed: false }, true).label, "interrupting");
  assert.equal(stateDisplay({ ...working, stateConfirmed: false }).label, "running");
});

test("a stop that found nothing takes the badge back and says so", async () => {
  // The race, at the surface that has to explain it. The request succeeded and no turn was
  // stopped, because it ended on its own between the keypress and the request landing - the
  // card renders `working` from an SSE frame and is always slightly behind, which is why the
  // control was still live.
  //
  // Two consequences, and both are here because both are invisible defects. The badge must be
  // taken back NOW: there is no turn ending to produce the reading that would clear it, so it
  // would otherwise claim a stop for its whole six-second timeout. And it has to be SAID,
  // because the daemon deliberately leaves the queue alone in this case - an operator who
  // believes they cleared the queue and then watches it deliver has been misled by us.
  const { interruptReport } = await import("../src/web/lib/interrupting.ts");

  const nothing = interruptReport({ ok: true, stoppedTurn: false });
  assert.equal(nothing.settled, true);
  assert.match(nothing.flash ?? "", /already finished/);
  assert.match(nothing.flash ?? "", /anything queued will still be delivered/);

  // A genuine stop leaves the badge to the next reading, which is what retires it honestly.
  const stopped = interruptReport({ ok: true, stoppedTurn: true, droppedQueued: 2 });
  assert.equal(stopped.settled, false);
  assert.equal(stopped.flash, "Stopped, and dropped 2 queued messages.");
  assert.equal(
    interruptReport({ ok: true, stoppedTurn: true, droppedQueued: 1 }).flash,
    "Stopped, and dropped 1 queued message.",
  );
  // Nothing queued is the ordinary case and needs no words: the badge and the card say it.
  assert.deepEqual(interruptReport({ ok: true, stoppedTurn: true, droppedQueued: 0 }), {
    settled: false,
    flash: null,
  });

  // A refusal takes the badge back and adds nothing - the shared `run` helper has already
  // put the daemon's own reason on screen, and two messages about one click is one too many.
  assert.deepEqual(interruptReport({ ok: false }), { settled: true, flash: null });
});

test("the optimistic badge is retired by a real reading and by its own timeout", async () => {
  const { clearInterrupting, isInterrupting, markInterrupting, reconcileInterrupting } =
    await import("../src/web/lib/interrupting.ts");
  const session = mkSession({ id: "sdk:transient", runtime: "sdk" });

  markInterrupting(session.id);
  assert.equal(isInterrupting(session.id), true);
  // Upserts arrive constantly while an agent works. Clearing on any of them would blink the
  // badge out a frame after it appeared, so only a reading that says the agent STOPPED
  // counts as the confirmation.
  reconcileInterrupting(session);
  assert.equal(isInterrupting(session.id), true);
  reconcileInterrupting({ ...session, state: "idle" });
  assert.equal(isInterrupting(session.id), false);

  // And a refusal takes it back immediately, because a card describing a stop the daemon
  // declined is the one failure this presentation must not produce.
  markInterrupting(session.id);
  clearInterrupting(session.id);
  assert.equal(isInterrupting(session.id), false);
});
