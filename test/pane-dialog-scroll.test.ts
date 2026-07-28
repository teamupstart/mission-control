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
    const selectors = (match[1] ?? "")
      .split(",")
      .map((selector) => selector.trim().replace(/\s+/g, " "))
      .filter(Boolean);
    if (selectors.length > 0) out.push({ selectors, body: match[2] ?? "" });
  }
  return out;
}

function declaration(body: string, property: string): string | null {
  const re = new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]*)`, "gi");
  let value: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body))) value = (match[1] ?? "").trim();
  return value;
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
  const global = rules(css).filter((rule) => rule.selectors.includes(".pane-dialog"));
  assert.ok(global.length > 0, "expected the shared pane-dialog rule");
  assert.equal(
    global.some((rule) => declaration(rule.body, "overflow-y") === "auto"),
    false,
    "grid cards should keep their natural dialog height; only fixed-height detail panes need a cap",
  );
});
