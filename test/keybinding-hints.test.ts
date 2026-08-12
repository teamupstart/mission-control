import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

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
  // The card row in drawn order: Send, Focus, Files, Queue, Reset, Interrupt, Complete,
  // Kill - every one of them bound, and every one of them silent about it before this.
  // Interrupt sits immediately BEFORE the Complete/Kill pair rather than inside it: those
  // two are the ways a session ends and their adjacency is deliberate, while this is the
  // rung short of both.
  assert.deepEqual(keycaps(cardBar()), ["s", "p", "⇧F", "q", "⌃R", "⌃C", "c", "k"]);
});

test("turning the preference off leaves the buttons, and not one keycap", () => {
  resetAll();
  setHints(false);
  const card = cardBar();
  assert.equal(keycaps(card).length, 0);
  assert.ok(!card.includes("kb-hint"), "no empty keycap element left behind either");
  // The controls themselves are untouched - this is a presentation switch, not a feature
  // flag on the action row.
  for (const label of ["Send", "Focus", "Files", "Queue", "Reset", "Interrupt", "Complete", "Kill"]) {
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
  assert.deepEqual(keycaps(footBar()), ["p", "d", "⌃R", "⌃C", "c", "k"]);
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

/** The visible label of every keycap-carrying button, in drawn order. */
function keycapLabels(html: string): string[] {
  return [...html.matchAll(/<kbd class="kb-hint">[^<]*<\/kbd>(?:<!-- -->)?\s*([A-Za-z]+)/g)].map(
    (m) => m[1] ?? "",
  );
}

test("the docs name the keycapped buttons in the order they are actually drawn", () => {
  // What is at stake: `docs/ui.md` enumerates every control that prints its chord, by hand,
  // and nothing tied that list to the row it describes. A control inserted in one place and
  // documented in another is a doc that is wrong in the one way a reader cannot detect - it
  // is still a true list of the buttons, just not of their order - and that is exactly the
  // drift this caught: Interrupt was first drawn between Complete and Kill, then moved ahead
  // of the pair, and the sentence kept the old order.
  //
  // An ORDERED SUBSEQUENCE rather than an exact string, so the prose stays prose: commas,
  // "and", and the surrounding clauses are free to change, while a swap fails.
  resetAll();
  setHints(true);
  const docs = readFileSync(new URL("../docs/ui.md", import.meta.url), "utf8");
  const section = docs.slice(docs.indexOf("### Keycaps on the buttons"));
  assert.ok(section.length > 0, "the Keycaps enumeration is gone from docs/ui.md");

  for (const [surface, endsAt, labels] of [
    ["the card row", "on a card", keycapLabels(cardBar())],
    ["the Console footer", "in the Console\nfooter", keycapLabels(footBar())],
  ] as const) {
    const clause = section.slice(0, section.indexOf(endsAt));
    assert.ok(clause.length > 0, `docs/ui.md no longer says "${endsAt}"`);
    let at = 0;
    for (const label of labels) {
      // Case-insensitive: the card row capitalises its labels and the console footer does
      // not, while the prose names each control once.
      const found = clause.toLowerCase().indexOf(label.toLowerCase(), at);
      assert.notEqual(
        found,
        -1,
        `docs/ui.md lists ${surface}'s buttons out of order: ${label} does not follow the one before it. Drawn order is ${labels.join(", ")}.`,
      );
      at = found + label.length;
    }
  }
});
