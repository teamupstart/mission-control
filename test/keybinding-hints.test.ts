import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * What is at stake: a button that a shortcut also drives has to TEACH that shortcut,
 * and it has to teach the RESOLVED one.
 *
 * The chords were discoverable from the settings panel and a few tooltips only, so the
 * card's seven action buttons said nothing about the keys that drive them. The fix is a
 * keycap on the button's face - which introduces two ways to be wrong that nothing else
 * catches. A call site that hand-rolls `<kbd>{formatChord(...)}</kbd>` renders a keycap
 * the preference cannot hide (the console footer's five buttons did exactly that before
 * `Keycap.tsx` existed); a call site that hard-codes the default prints the wrong key to
 * an operator who rebound it, which is worse than printing none. So this file asserts
 * both directions on the real components: every bound button carries a `.kb-hint` when
 * the preference is on, NONE of them does when it is off, and a rebind moves what they
 * print.
 *
 * The store is the daemon's (`app_config.ui.keybindingHints`), so both halves are stood
 * up before importing anything that reads them - the same preamble `keybindings.test.ts`
 * documents. `createElement` rather than JSX because the runner's glob only matches
 * .test.ts.
 */

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
  value: () =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }),
});

const { ActionBar } = await import("../src/web/components/ActionBar.tsx");
const { setBinding, resetAll, formatChord } = await import("../src/web/lib/keybindings.ts");
const { updateUiConfig } = await import("../src/web/lib/uiConfig.ts");
const { mkSession } = await import("./helpers/session-fixture.ts");

/** Every keycap the markup prints, in order. */
function keycaps(html: string): string[] {
  return [...html.matchAll(/<kbd class="kb-hint">([^<]*)<\/kbd>/g)].map((m) => m[1] ?? "");
}

function cardBar(): string {
  return renderToStaticMarkup(
    createElement(ActionBar, {
      session: mkSession({ task: null }),
      onToggleQueue: () => {},
      onReset: () => {},
      onComplete: () => {},
      onKill: () => {},
      onFiles: () => {},
    }),
  );
}

function footBar(): string {
  return renderToStaticMarkup(
    createElement(ActionBar, {
      session: mkSession({ task: null }),
      variant: "foot",
      onDiff: () => {},
      onReset: () => {},
      onComplete: () => {},
      onKill: () => {},
    }),
  );
}

function setHints(on: boolean): void {
  void updateUiConfig({ keybindingHints: on });
}

test("hints are on out of the box, so the shortcuts are discoverable without being sought", () => {
  resetAll();
  setHints(true);
  // The card row in drawn order: Send, Focus, Files, Queue, Reset, Complete, Kill - every
  // one of them bound, and every one of them silent about it before this.
  assert.deepEqual(keycaps(cardBar()), ["s", "p", "⇧F", "q", "⌃R", "c", "k"]);
});

test("turning the preference off leaves the buttons, and not one keycap", () => {
  resetAll();
  setHints(false);
  const card = cardBar();
  assert.equal(keycaps(card).length, 0);
  assert.ok(!card.includes("kb-hint"), "no empty keycap element left behind either");
  // The controls themselves are untouched - this is a presentation switch, not a feature
  // flag on the action row.
  for (const label of ["Send", "Focus", "Files", "Queue", "Reset", "Complete", "Kill"]) {
    assert.ok(card.includes(label), `${label} is still drawn`);
  }
  setHints(true);
});

test("the console footer answers to the same switch the card does", () => {
  // Its five buttons carried an unconditional <kbd> before `Keycap.tsx`, so an operator
  // who turned hints off would have kept them here and nowhere else.
  resetAll();
  setHints(false);
  assert.equal(keycaps(footBar()).length, 0);
  setHints(true);
  assert.deepEqual(keycaps(footBar()), ["p", "d", "⌃R", "c", "k"]);
});

test("a rebind moves what the buttons print, so a keycap is never a stale default", () => {
  resetAll();
  setHints(true);
  setBinding("kill", "cmd+x");
  const caps = keycaps(cardBar());
  assert.ok(caps.includes(formatChord("cmd+x")), "the rebound chord reaches the button");
  assert.ok(!caps.includes("k"), "and the default it replaced is gone");
  resetAll();
  assert.ok(keycaps(cardBar()).includes("k"), "resetting puts the default back");
});
