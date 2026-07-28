/**
 * What is at stake: a driver request can put four questions on screen at once. In the
 * Console/Board detail pane that form shares a fixed-height column with the goal,
 * transcript, and footer. A `.pane-dialog` with visible overflow keeps its full
 * min-content height, so flexbox cannot shrink it; `.detail-body` then clips the form
 * and leaves the later questions and Submit button unreachable.
 *
 * The detail-pane dialog must therefore be the bounded scroll surface. The surrounding
 * conversation intentionally stays pinned so the transcript/reply contract does not
 * change, and the generic card dialog intentionally keeps its natural height.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(
  fileURLToPath(new URL("../src/web/styles.css", import.meta.url)),
  "utf8",
);

interface Rule {
  selectors: string[];
  body: string;
}

function rules(source: string): Rule[] {
  const out: Rule[] = [];
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, " ");
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(withoutComments))) {
    const selectors = splitSelectorList(match[1] ?? "")
      .map((selector) => selector.trim().replace(/\s+/g, " "))
      .filter(Boolean);
    if (selectors.length > 0) out.push({ selectors, body: match[2] ?? "" });
  }
  return out;
}

function splitSelectorList(selectorList: string): string[] {
  const selectors: string[] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < selectorList.length; i += 1) {
    const character = selectorList[i];
    if (character === "(" || character === "[") depth += 1;
    if (character === ")" || character === "]") depth -= 1;
    if (character === "," && depth === 0) {
      selectors.push(selectorList.slice(start, i));
      start = i + 1;
    }
  }
  selectors.push(selectorList.slice(start));
  return selectors;
}

function declaration(body: string, property: string): string | null {
  const re = new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]*)`, "gi");
  let value: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body))) value = (match[1] ?? "").trim();
  return value;
}

function subjectStart(selector: string): number {
  let start = 0;
  let depth = 0;
  for (let i = 0; i < selector.length; i += 1) {
    const character = selector[i];
    if (character === "(" || character === "[") depth += 1;
    if (character === ")" || character === "]") depth -= 1;
    if (depth === 0 && (/\s/.test(character ?? "") || character === ">" || character === "+" || character === "~")) {
      start = i + 1;
    }
  }
  return start;
}

function targetsPaneDialog(selector: string): boolean {
  return /\.pane-dialog(?![\w-])/.test(selector.slice(subjectStart(selector)));
}

function isDetailPaneDialog(selector: string): boolean {
  const prefix = selector.slice(0, subjectStart(selector));
  let lineageStart = 0;
  let depth = 0;
  for (let i = 0; i < prefix.length; i += 1) {
    const character = prefix[i];
    if (character === "(" || character === "[") depth += 1;
    if (character === ")" || character === "]") depth -= 1;
    if (depth === 0 && (character === "+" || character === "~")) lineageStart = i + 1;
  }
  const lineage = prefix.slice(lineageStart);
  depth = 0;
  for (let i = 0; i < lineage.length; i += 1) {
    const character = lineage[i];
    if (character === "(" || character === "[") depth += 1;
    if (character === ")" || character === "]") depth -= 1;
    if (
      depth === 0 &&
      lineage.startsWith(".detail-conv", i) &&
      !/[\w-]/.test(lineage[i + ".detail-conv".length] ?? "")
    ) {
      return true;
    }
  }
  return false;
}

function hasCap(property: string, value: string): boolean {
  const naturalValues =
    property.startsWith("max-")
      ? /^(?:none|initial|unset|revert(?:-layer)?)$/i
      : property === "height" || property === "block-size"
        ? /^(?:auto|initial|unset|revert(?:-layer)?)$/i
        : /^(?:visible|initial|unset|revert(?:-layer)?)(?:\s+(?:visible|initial|unset|revert(?:-layer)?))?$/i;
  return !naturalValues.test(value);
}

function assertNoGlobalPaneDialogCaps(source: string): void {
  const capProperties = [
    "height",
    "max-height",
    "block-size",
    "max-block-size",
    "overflow",
    "overflow-x",
    "overflow-y",
    "overflow-block",
    "overflow-inline",
  ];
  const caps = rules(source).flatMap((rule) =>
    rule.selectors.flatMap((selector) => {
      if (!targetsPaneDialog(selector) || isDetailPaneDialog(selector)) return [];
      return capProperties.flatMap((property) => {
        const value = declaration(rule.body, property);
        return value !== null && hasCap(property, value)
          ? [`${selector} declares ${property}: ${value}`]
          : [];
      });
    }),
  );
  assert.deepEqual(
    caps,
    [],
    "pane dialogs outside .detail-conv must retain their natural height and visible overflow",
  );
}

test("a long pane dialog scrolls inside the fixed-height detail conversation", () => {
  const selector = ".detail-conv > .pane-dialog";
  const matching = rules(css).filter((rule) => rule.selectors.includes(selector));
  assert.ok(matching.length > 0, `expected a ${selector} rule`);

  const effective = (property: string): string | null => {
    let value: string | null = null;
    for (const rule of matching) {
      const candidate = declaration(rule.body, property);
      if (candidate !== null) value = candidate;
    }
    return value;
  };

  assert.equal(
    effective("overflow-y"),
    "auto",
    "the detail body clips overflow, so the dialog itself must offer vertical scrolling",
  );
  assert.match(
    effective("flex") ?? "",
    /^\s*0\s+1\b/,
    "the dialog must be allowed to shrink below its content height before it can overflow",
  );
  assert.match(
    effective("min-height") ?? "",
    /(?:px|dvh)/,
    "a shrinkable dialog still needs a usable visible floor",
  );
  assert.equal(
    effective("overscroll-behavior"),
    "contain",
    "wheel input at the form boundary must not leak into the fleet behind the detail pane",
  );
});

test("the scroll rule is detail-only, not a global pane-dialog cap", () => {
  assertNoGlobalPaneDialogCaps(css);
});

test("the global cap guard rejects height and overflow regressions", () => {
  const counterexamples = [
    ".pane-dialog { height: 20rem; }",
    ".pane-dialog { max-height: 20rem; }",
    ".card .pane-dialog { overflow: auto; }",
    ".detail-conv > .pane-dialog, .card .pane-dialog { overflow-y: scroll; }",
    ":is(.detail-conv, .card) > .pane-dialog { max-height: 20rem; overflow: auto; }",
  ];

  for (const source of counterexamples) {
    assert.throws(() => assertNoGlobalPaneDialogCaps(source), /must retain their natural height/);
  }
});
