import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// What is at stake: a `var()` naming a token nobody defined does not degrade, it DELETES the
// declaration it appears in - and there is nothing in this repository that would say so.
// There is no preprocessor, no stylelint and no unused-CSS check (`AGENTS.md` says as much),
// the stylesheet is not typechecked, and the browser reports it only as an absence.
//
// It has already happened twice, in ways that read as design choices rather than as bugs.
// `.workflow-node-check` asked for `var(--warn)`, which this theme spells `--attention`, so
// a border meant to be amber rendered as the inherited grey and looked deliberate. Worse,
// two `:focus-visible` rules asked for `var(--accent)`, which invalidated the whole
// `outline` shorthand - those buttons had NO focus ring at all, which is an accessibility
// defect that is invisible unless you are navigating by keyboard and looking for it.
//
// So the rule is mechanical: every token this file reads is either defined in this file,
// written with a fallback, or one of a named few set from JavaScript.

const css = readFileSync(
  fileURLToPath(new URL("../src/web/styles.css", import.meta.url)),
  "utf8",
);

/**
 * Tokens set at runtime from JavaScript rather than declared in the stylesheet.
 *
 * Deliberately a short, named list rather than a pattern: each is a measured or
 * per-element value with an owner, and a new one is a decision worth making explicitly
 * instead of a hole a regex left open. Every one of these that CAN carry a fallback does;
 * `--pct` is the exception because the element that reads it is the same element that
 * sets it, so an absent value is not a state the stylesheet can be rendered in.
 */
const SET_FROM_JS = new Map<string, string>([
  ["--agent-accent", "a harness's colour, inline from AGENT_IDENTITY (see AGENTS.md)"],
  ["--topbar-h", "measured in App.tsx (see AGENTS.md)"],
  ["--cmdbar-clearance", "measured in App.tsx (see AGENTS.md)"],
  ["--tt-caret", "the tooltip caret offset, inline from Tooltip.tsx"],
  ["--pct", "a bar's own fill percentage, inline from SpendChip.tsx"],
]);

/** Every `var(--x)` reference, with whether that reference supplied a fallback. */
function references(): Array<{ token: string; hasFallback: boolean; index: number }> {
  const out: Array<{ token: string; hasFallback: boolean; index: number }> = [];
  const pattern = /var\(\s*(--[A-Za-z0-9_-]+)\s*(,?)/g;
  for (let match = pattern.exec(css); match; match = pattern.exec(css)) {
    out.push({ token: match[1]!, hasFallback: match[2] === ",", index: match.index });
  }
  return out;
}

const lineOf = (index: number): number => css.slice(0, index).split("\n").length;

test("every custom property the stylesheet reads is one something defines", () => {
  const defined = new Set(css.match(/^\s*(--[A-Za-z0-9_-]+)\s*:/gm)?.map(
    (line) => line.trim().replace(/\s*:$/, ""),
  ) ?? []);
  assert.ok(defined.size > 20, "the token block should have been found");

  // Per REFERENCE, not per token: `--accent` was written with a fallback in one rule and
  // bare in two others, so a per-token check called it covered while two declarations were
  // being dropped. That is exactly how the focus-ring defect survived.
  const broken = references()
    .filter((ref) => !defined.has(ref.token) && !ref.hasFallback && !SET_FROM_JS.has(ref.token))
    .map((ref) => `styles.css:${lineOf(ref.index)} reads ${ref.token}`);

  assert.deepEqual(
    broken,
    [],
    `these var() references name a token nothing defines, so the whole declaration is dropped:\n  ${broken.join("\n  ")}`,
  );
});

test("the JS-set list stays honest, so it cannot become a place to hide a typo", () => {
  // An entry here is an exemption from the check above. One that no rule reads any more is
  // an exemption nobody is using, and the next typo that happens to match its name would be
  // waved straight through.
  const read = new Set(references().map((ref) => ref.token));
  for (const [token, why] of SET_FROM_JS) {
    assert.ok(read.has(token), `${token} (${why}) is exempted but no rule reads it - drop it`);
  }
});

test("the scan can actually see a token nobody defined", () => {
  // The check above passes trivially if the reference pattern stops matching, so prove the
  // pattern still finds a bare reference and still tells a fallback from the lack of one.
  const found = references();
  assert.ok(found.length > 100, "the stylesheet should read plenty of tokens");
  assert.ok(found.some((ref) => ref.hasFallback), "fallback references should be recognised");
  assert.ok(found.some((ref) => !ref.hasFallback), "bare references should be recognised");
});
