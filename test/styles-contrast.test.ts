import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// What is at stake: readability of the smallest text in the app.
//
// `styles.css` is one hand-maintained file with no preprocessor, no linter and no
// stylelint, so a token nudged by eye against a dark background is never checked by
// anything. `--dim` shipped at #5d6775, which is 3.1:1 on the settings panel - under the
// WCAG AA floor - and it is the colour of nearly every help blurb, hint and row
// description in the product, all set around 11.5px. It read as disabled text.
//
// This pins the whole text ramp against every surface it can land on, so the next person
// who reaches for "a slightly quieter grey" finds out here rather than from a user
// squinting at a settings panel.

const css = readFileSync(fileURLToPath(new URL("../src/web/styles.css", import.meta.url)), "utf8");

/** Pull a `--name: #rrggbb;` declaration out of the `:root` block. */
function token(name: string): string {
  const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`));
  const hex = m?.[1];
  assert.ok(hex, `token --${name} is missing or is no longer a plain 6-digit hex`);
  return hex;
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const channel = (i: number): number => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG contrast ratio between two hex colours. */
function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Every background a body-text token is drawn on. `--panel-2` is the lightest, so it is
// the binding constraint - a token that passes there passes everywhere.
const SURFACES = ["bg", "bg-2", "panel", "panel-2"];

// The text ramp, loudest to quietest. `--dim` is the bottom: there is nothing below it
// that is still meant to be read.
const TEXT = ["fg", "muted", "dim"];

test("the text ramp clears WCAG AA on every surface it is drawn on", () => {
  for (const fg of TEXT) {
    for (const bg of SURFACES) {
      const ratio = contrast(token(fg), token(bg));
      assert.ok(
        ratio >= 4.5,
        `--${fg} (${token(fg)}) on --${bg} (${token(bg)}) is ${ratio.toFixed(2)}:1, under the 4.5:1 AA floor for small text`,
      );
    }
  }
});

test("the text ramp stays a ramp", () => {
  // Bumping one token for contrast must not flatten it into its neighbour: the three
  // levels have to stay visibly ordered or the hierarchy they encode is gone.
  for (let i = 1; i < TEXT.length; i++) {
    const brighter = TEXT[i - 1]!;
    const quieter = TEXT[i]!;
    assert.ok(
      luminance(token(brighter)) > luminance(token(quieter)),
      `--${brighter} must stay brighter than --${quieter}`,
    );
  }
});
