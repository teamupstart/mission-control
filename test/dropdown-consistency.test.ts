/**
 * What is at stake: every dropdown in the app should read as the same control. A native
 * `<select>` ignores colour, border and radius on macOS/Chrome until `appearance: none`
 * clears the UA control, so ONE shared rule - `select:not([multiple])` - is what themes
 * them all and draws the chevron. This file pins three things a silent-pixel regression
 * would break: the shared rule stays present and themed, and the two deliberate opt-outs
 * stay opted out - the `[multiple]` dependency listbox (excluded by the selector itself)
 * and the backlog priority chip (`.bl-prio select`, styled AS a chip, which must never
 * grow a dropdown chevron). Nothing else reads `styles.css` for this.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../src/web/styles.css", import.meta.url)), "utf8");
const dispatchModal = readFileSync(
  fileURLToPath(new URL("../src/web/components/DispatchModal.tsx", import.meta.url)),
  "utf8",
);

// Comments carry selectors and property names in prose, so strip them before parsing.
const bare = css.replace(/\/\*[\s\S]*?\*\//g, " ");

interface Rule {
  selectors: string[];
  body: string;
}

// styles.css has no preprocessor and no nesting, so this flat pass is exact (same parser
// the desktop-drag-region guard uses). An `@media` wrapper's body is more braces, so it
// never matches `[^{}]*` and only the rules inside it come back - which is what we want.
function rules(source: string): Rule[] {
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    out.push({
      selectors: (m[1] ?? "").split(",").map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean),
      body: m[2] ?? "",
    });
  }
  return out;
}

const ALL = rules(bare);
const ruleFor = (selector: string): Rule | undefined => ALL.find((r) => r.selectors.includes(selector));
const CHEVRON = /background-image:\s*url\("data:image\/svg\+xml/;

test("one shared rule themes every single dropdown", () => {
  const base = ruleFor("select:not([multiple])");
  assert.ok(base, "the shared `select:not([multiple])` dropdown rule is gone");
  // appearance:none is the load-bearing line - without it the rest is ignored by the UA control.
  assert.match(base.body, /appearance:\s*none/, "a native select ignores theming without appearance:none");
  assert.match(base.body, CHEVRON, "the shared rule no longer draws its chevron");
  assert.match(base.body, /background-color:\s*var\(--bg-2\)/);
  assert.match(base.body, /border-radius:/);
  // The chevron sits at the right, and the padding leaves room for it there.
  assert.match(base.body, /background-position:\s*right/, "the chevron is not pinned to the right edge");
  assert.match(base.body, /padding:/);
});

test("the chevron is drawn in exactly one place, so dropdowns cannot drift apart", () => {
  // The whole point of the shared rule is that no surface paints its own near-miss. Any
  // other select rule that grows a chevron is a second source of truth.
  const chevronSelectRules = ALL.filter(
    (r) => CHEVRON.test(r.body) && r.selectors.some((s) => /(^|\s|>)select\b|-select\b/.test(s)),
  );
  assert.deepEqual(chevronSelectRules.flatMap((r) => r.selectors), ["select:not([multiple])"]);
});

test("the multi-select dependency picker opts out through :not([multiple])", () => {
  // The `:not([multiple])` in the shared selector is the opt-out; it only means anything
  // if a real picker is actually `multiple`. The dependency picker in Dispatch is that one.
  assert.ok(ruleFor("select:not([multiple])"), "the shared dropdown rule is gone");
  assert.match(
    dispatchModal,
    /className="field-input dependency-select"[\s\S]{0,80}\bmultiple\b/,
    "the dependency picker is no longer a <select multiple>, so :not([multiple]) guards nothing",
  );
});

test("the backlog priority chip stays a chip, not a dropdown", () => {
  const chip = ruleFor(".bl-prio select");
  assert.ok(chip, "the priority chip rule is gone");
  // It clears the UA control like the shared rule, but paints its own chip surface with a
  // `background` shorthand - which also resets any inherited chevron image - and never a chevron.
  assert.match(chip.body, /appearance:\s*none/);
  assert.match(chip.body, /background:\s/, "the chip no longer paints its own surface, so the shared chevron leaks in");
  assert.doesNotMatch(chip.body, /data:image\/svg\+xml/, "the priority chip grew a dropdown chevron");
});
