/**
 * What is at stake: every dropdown in the app should read as the same control. A native
 * `<select>` ignores colour, border and radius on macOS/Chrome until `appearance` clears
 * the UA control, so ONE shared rule - `select:not([multiple])` - is what themes them all,
 * draws the chevron, and paints the open picker. This file pins three things a silent-pixel regression
 * would break: the shared rule stays present and themed, and the backlog priority chip
 * (`.bl-prio select`, styled AS a chip) stays a deliberate exception that must never grow
 * a dropdown chevron. `[multiple]` is excluded for any future listbox. Nothing else reads
 * `styles.css` for this.
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
  // `none` preserves the fallback; Chromium/Electron's `base-select` then opts into the
  // CSS-painted picker rather than the light OS popup.
  assert.match(base.body, /appearance:\s*none/, "a native select ignores theming without appearance:none");
  assert.match(base.body, /appearance:\s*base-select/, "the dropdown no longer opts into the themed picker");
  assert.match(base.body, CHEVRON, "the shared rule no longer draws its chevron");
  assert.match(
    base.body,
    /color-scheme:\s*dark/,
    "native option popups must explicitly use the app's dark color scheme",
  );
  assert.match(base.body, /background-color:\s*var\(--bg-2\)/);
  assert.match(base.body, /border-radius:/);
  // The chevron sits at the right, and the padding leaves room for it there.
  assert.match(base.body, /background-position:\s*right/, "the chevron is not pinned to the right edge");
  assert.match(base.body, /padding:/);
});

test("the shared rule paints every open dropdown menu", () => {
  const picker = ruleFor("select:not([multiple])::picker(select)");
  assert.ok(picker, "the shared open-dropdown picker rule is gone");
  assert.match(picker.body, /appearance:\s*base-select/);
  assert.match(picker.body, /background:\s*var\(--bg-2\)/);
  assert.match(picker.body, /border-radius:/);
});

test("the themed picker does not duplicate the shared chevron", () => {
  const pickerIcon = ruleFor("select:not([multiple])::picker-icon");
  assert.ok(pickerIcon, "the Chromium picker icon guard is gone");
  assert.match(pickerIcon.body, /display:\s*none/);
});

test("scoped dropdown rules do not erase the shared chrome", () => {
  const ensembleFilters = ruleFor(".ensemble-run-filters select");
  assert.ok(ensembleFilters, "the ensemble-run filter dropdown rule is gone");
  assert.doesNotMatch(
    ensembleFilters.body,
    /\b(?:appearance|background(?:-image|-color)?|border|padding)\s*:/,
    "a scoped dropdown rule must size or place the shared control, not repaint it",
  );
});

test("the chevron is drawn in exactly one place, so dropdowns cannot drift apart", () => {
  // The whole point of the shared rule is that no surface paints its own near-miss. Any
  // other select rule that grows a chevron is a second source of truth.
  const chevronSelectRules = ALL.filter(
    (r) => CHEVRON.test(r.body) && r.selectors.some((s) => /(^|\s|>)select\b|-select\b/.test(s)),
  );
  assert.deepEqual(chevronSelectRules.flatMap((r) => r.selectors), ["select:not([multiple])"]);
});

test("the dependency picker is chips plus one themed single select, not a listbox", () => {
  // The dependency picker used to be the app's one `<select multiple>` - the least themed
  // control in the modal. It is chips plus a grouped add-select now, which the shared
  // dropdown rule themes like everything else. The `:not([multiple])` guard stays in the
  // shared selector for whatever listbox arrives next.
  assert.ok(ruleFor("select:not([multiple])"), "the shared dropdown rule is gone");
  assert.match(dispatchModal, /className="dep-add"/, "the dependency add-select is gone");
  assert.doesNotMatch(
    dispatchModal,
    /\bmultiple\b/,
    "a <select multiple> is back in Dispatch; theme it or turn it into chips",
  );
});

test("the backlog priority chip stays a chip, not a dropdown", () => {
  const chip = ruleFor(".bl-prio select");
  assert.ok(chip, "the priority chip rule is gone");
  // It keeps the shared CSS-painted picker but paints its own closed chip surface with a
  // `background` shorthand - which also resets any inherited chevron image.
  assert.match(chip.body, /appearance:\s*none/);
  assert.match(chip.body, /appearance:\s*base-select/);
  assert.match(chip.body, /background:\s/, "the chip no longer paints its own surface, so the shared chevron leaks in");
  assert.doesNotMatch(chip.body, /data:image\/svg\+xml/, "the priority chip grew a dropdown chevron");
});
