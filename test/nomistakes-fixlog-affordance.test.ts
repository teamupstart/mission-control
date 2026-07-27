/**
 * What is at stake: the collapsed fix log is the ONLY way into the record of what
 * no-mistakes changed on your branch, and it was invisible.
 *
 * `.nm-log` clips its own content (`overflow: hidden`, for the rounded corners on
 * the scroll region inside it). Per the flexbox spec that zeroes a flex item's
 * AUTOMATIC MINIMUM SIZE - the `min-height: auto` that normally stops a column flex
 * item shrinking below its content. So in `.detail-conv`, where the transcript
 * below it is `flex: 1 1 auto` and the pane is routinely over-full, a collapsed log
 * was shrunk to its own two borders: a 2px hairline, measured, carrying a 32px
 * button nobody could see or hit. It read as a divider. The tooltip fired on hover,
 * which is how it was found.
 *
 * That combination is silent in every direction: no compile error, no console
 * warning, no stylelint, and it only appears when the container is over-full - so
 * the tab it happens in is the one with the most content, and a short window makes
 * it worse. There is no rendered test that can catch it either (the suite is
 * `renderToStaticMarkup`, which has no layout), so the guard has to be on the rule.
 *
 * Two things are pinned here:
 *   1. `.nm-log` never gives. If it clips, it must also refuse to shrink, and no
 *      later rule may hand a COLLAPSED log back its flexibility. An open log in a
 *      detail pane is the one case that may shrink, and it is protected by a
 *      `min-height` of its own.
 *   2. The caret is a CONTROL, not a glyph. It was a 9px `▾` in `--dim` sitting
 *      loose beside a count chip, which is punctuation - the row looked like a
 *      static summary line even at full height. Sized and bordered like a button,
 *      it says "this opens" before anyone hovers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../src/web/styles.css", import.meta.url)), "utf8");
const tsx = readFileSync(
  fileURLToPath(new URL("../src/web/components/NomistakesFixLog.tsx", import.meta.url)),
  "utf8",
);

interface Rule {
  selectors: string[];
  body: string;
}

interface LogFlexProblems {
  collapsed: string[];
  openWithoutFloor: string[];
}

function subjectHasClass(selector: string, cls: string): boolean {
  const subject = selector.split(/\s*[>+~]\s*|\s+/).filter(Boolean).pop() ?? "";
  return subject.split(/(?=\.)|:/).some((token) => token === `.${cls}`);
}

/**
 * styles.css has no preprocessor and no nesting, so this flat pass is exact. Comments
 * go first, because several of them quote declarations in prose. An `@media` wrapper
 * can never match (its body is more braces), so only the rules inside it come back -
 * which is what we want, since the wrapper declares nothing itself.
 */
function rules(source: string): Rule[] {
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source.replace(/\/\*[\s\S]*?\*\//g, " ")))) {
    const selectors = (m[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/\s+/g, " "))
      .filter(Boolean);
    if (selectors.length > 0) out.push({ selectors, body: m[2] ?? "" });
  }
  return out;
}

const ALL = rules(css);

/** The declared value of one property in a rule body, or null. */
function decl(body: string, prop: string): string | null {
  const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:([^;]*)`, "gi");
  let value: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) value = (m[1] ?? "").trim();
  return value;
}

function numericValue(value: string): number | null {
  const normalized = value.replace(/\s*!important\s*$/i, "").trim();
  return /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(normalized) ? Number(normalized) : null;
}

function shorthandShrink(value: string): number | null {
  const normalized = value.replace(/\s*!important\s*$/i, "").trim().toLowerCase();
  if (normalized === "none") return 0;
  const parts = normalized.split(/\s+/);
  const first = numericValue(parts[0] ?? "");
  if (first === null) return null;
  if (parts.length === 1) return 1;
  const second = numericValue(parts[1] ?? "");
  return second ?? 1;
}

function effectiveShrink(body: string): number | null | undefined {
  const re = /(?:^|;)\s*(flex|flex-shrink)\s*:([^;]*)/gi;
  let shrink: number | null | undefined;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const property = (m[1] ?? "").toLowerCase();
    const value = (m[2] ?? "").trim();
    shrink = property === "flex" ? shorthandShrink(value) : numericValue(value);
  }
  return shrink;
}

function splitFunctionArgs(value: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      args.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  args.push(value.slice(start).trim());
  return args;
}

function guaranteesPositiveLength(value: string): boolean {
  const normalized = value.replace(/\s*!important\s*$/i, "").trim().toLowerCase();
  const literal = /^([+]?(?:\d+\.?\d*|\.\d+))(?:%|[a-z]+)$/i.exec(normalized);
  if (literal) return Number(literal[1]) > 0;

  const fn = /^(min|max|clamp)\((.*)\)$/i.exec(normalized);
  if (!fn) return false;
  const args = splitFunctionArgs(fn[2] ?? "");
  if (fn[1] === "min") return args.length > 0 && args.every(guaranteesPositiveLength);
  if (fn[1] === "max") return args.some(guaranteesPositiveLength);
  return args.length === 3 && guaranteesPositiveLength(args[0] ?? "");
}

function selectorMinHeight(parsedRules: Rule[], selector: string): string | null {
  let value: string | null = null;
  for (const rule of parsedRules) {
    if (!rule.selectors.includes(selector)) continue;
    const candidate = decl(rule.body, "min-height");
    if (candidate !== null) value = candidate;
  }
  return value;
}

function logFlexProblems(parsedRules: Rule[]): LogFlexProblems {
  const shrinkable = parsedRules.flatMap((rule) => {
    const shrink = effectiveShrink(rule.body);
    if (shrink === undefined || shrink === 0) return [];
    return rule.selectors.filter(
      (selector) =>
        subjectHasClass(selector, "nm-log") || subjectHasClass(selector, "nm-log-open"),
    );
  });

  return {
    collapsed: shrinkable.filter(
      (selector) => !subjectHasClass(selector, "nm-log-open"),
    ),
    openWithoutFloor: shrinkable.filter(
      (selector) =>
        subjectHasClass(selector, "nm-log-open") &&
        !guaranteesPositiveLength(selectorMinHeight(parsedRules, selector) ?? ""),
    ),
  };
}

test("a collapsed fix log cannot be crushed: if .nm-log clips, it also refuses to shrink", () => {
  const base = ALL.find((r) => r.selectors.includes(".nm-log"));
  assert.ok(base, "expected a bare `.nm-log` rule in styles.css");

  // The premise. If the clip ever goes away the automatic minimum size comes back and
  // this whole guard is moot - but then this assertion is what says so out loud,
  // rather than the rule quietly protecting against nothing.
  assert.equal(
    decl(base.body, "overflow"),
    "hidden",
    ".nm-log is expected to clip its content; that is what zeroes its automatic minimum size",
  );

  const flex = decl(base.body, "flex");
  assert.equal(
    flex,
    "none",
    "`.nm-log` clips, so its `min-height: auto` is 0 and a column flex parent will crush it. " +
      "It must declare `flex: none`.",
  );
});

test("no rule hands a COLLAPSED fix log its flexibility back", () => {
  // An open log may shrink only when that selector has a positive `min-height`
  // floor to land on. A collapsed one has no floor, so any non-zero shrink is the
  // original overflow/min-height:auto defect, whether declared by shorthand or
  // longhand.
  const problems = logFlexProblems(ALL);

  assert.deepEqual(
    problems.collapsed,
    [],
    "these selectors let a collapsed .nm-log shrink; overflow:hidden zeroes its " +
      "min-height:auto, so non-zero flex shrink crushes the only control that opens it",
  );
  assert.deepEqual(
    problems.openWithoutFloor,
    [],
    "these open-log selectors can shrink without a positive min-height floor; " +
      "overflow:hidden removes the automatic floor, so their content can be clipped away",
  );
});

test("the flex guard proves it rejects every floorless shrink path", () => {
  assert.deepEqual(logFlexProblems(rules(".nm-log { flex-shrink: 1; }")), {
    collapsed: [".nm-log"],
    openWithoutFloor: [],
  });
  assert.deepEqual(logFlexProblems(rules(".nm-log { flex: 1 1 auto; }")), {
    collapsed: [".nm-log"],
    openWithoutFloor: [],
  });
  assert.deepEqual(logFlexProblems(rules(".nm-log-open { flex: 0 1 auto; }")), {
    collapsed: [],
    openWithoutFloor: [".nm-log-open"],
  });
  assert.deepEqual(
    logFlexProblems(
      rules(`
        .nm-log { flex: none; }
        .detail-conv > .nm-log-open { flex: 0 1 auto; }
        .detail-conv > .nm-log-open { min-height: min(260px, 34dvh); }
      `),
    ),
    { collapsed: [], openWithoutFloor: [] },
  );
});

test("the guard reads flex shorthand and longhand with CSS declaration order", () => {
  assert.equal(effectiveShrink("flex: none"), 0);
  assert.equal(effectiveShrink("flex: 1"), 1);
  assert.equal(effectiveShrink("flex: none; flex-shrink: 1"), 1);
  assert.equal(effectiveShrink("flex-shrink: 1; flex: none"), 0);
});

test("the caret is a sized, bordered control rather than a loose glyph", () => {
  const caret = ALL.find((r) => r.selectors.includes(".nm-log-caret"));
  assert.ok(caret, "expected a `.nm-log-caret` rule");

  // A hit target with edges, so the row reads as openable before anyone hovers it.
  for (const prop of ["width", "height", "border", "border-radius"]) {
    assert.ok(decl(caret.body, prop), `.nm-log-caret should declare ${prop}`);
  }
  const size = Number.parseFloat(decl(caret.body, "width") ?? "0");
  assert.ok(size >= 18, `.nm-log-caret is ${size}px wide; too small to read as a control`);
  assert.equal(
    decl(caret.body, "height"),
    decl(caret.body, "width"),
    "the caret should be square, so its rotation on open pivots in place",
  );

  // Centred by flex, not by the glyph's own metrics - `▾` does not sit on the centre
  // line of its em box, so line-height alone leaves it visibly high.
  assert.match(decl(caret.body, "display") ?? "", /flex/);
  assert.equal(decl(caret.body, "align-items"), "center");
  assert.equal(decl(caret.body, "justify-content"), "center");

  // The rotation is the open/closed state, and it is the reason the tooltip's two
  // labels are not the only signal.
  assert.ok(
    ALL.some(
      (r) => r.selectors.includes(".nm-log-open .nm-log-caret") && /rotate/.test(r.body),
    ),
    "an open log should turn its caret over",
  );
});

test("hovering the rollup answers on the row, the label and the caret together", () => {
  // The row is one control, so a hover that lit only its background left the caret
  // looking disabled next to it. All three move, which is what made the affordance
  // legible in the layout where it was found.
  for (const sel of [".nm-rollup:hover", ".nm-rollup:hover .nm-log-brand", ".nm-rollup:hover .nm-log-caret"]) {
    assert.ok(
      ALL.some((r) => r.selectors.includes(sel)),
      `expected a \`${sel}\` rule`,
    );
  }
  // Keyboard reaches the same control, and gets a ring rather than nothing.
  assert.ok(
    ALL.some((r) => r.selectors.includes(".nm-rollup:focus-visible")),
    "the rollup is a button; it needs a visible focus ring",
  );
});

test("the caret stays decorative to assistive tech - the button already says expandable", () => {
  // `aria-expanded` on the button is the real announcement; a read-out `▾` would be
  // noise on top of it.
  assert.match(tsx, /className="nm-log-caret" aria-hidden="true"/);
  assert.match(tsx, /className="nm-rollup"[\s\S]{0,160}aria-expanded=\{open\}/);
});
