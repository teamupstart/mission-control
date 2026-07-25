/**
 * What is at stake: every control in the dashboard says what it does, through ONE
 * tooltip, and a new control cannot be added without one.
 *
 * The app used to describe its controls with the native `title` attribute - about a
 * hundred of them, on roughly a third of its buttons. That is three defects in one. The
 * bubble is drawn by the OS, so it was the single surface in a carefully themed app that
 * ignored the theme; `title` never fires on focus, so a keyboard user could not reach any
 * of it; and because it was optional and invisible in review, most controls simply had
 * none - the operator's only clue to what a bare `✕` or `⌁` did was to click it.
 *
 * So the mechanism is `components/Tooltip.tsx`, and this file is what stops the coverage
 * regressing. It is a source scan rather than a render test on purpose: rendering can only
 * check the components a test happens to mount, and the failure being prevented here is a
 * control nobody thought about - exactly the one no test would mount.
 *
 * Two rules, and the second is what keeps the first honest:
 *   1. every interactive element routes through `<Tooltip>`, directly or through a
 *      deliberately disjoint child when wrapping the whole control would nest triggers;
 *   2. no `title` attribute survives anywhere, so there is no second way to do this that
 *      quietly comes back.
 *
 * Free-text entry (`<input type=text|number|…>`, `<textarea>`) is deliberately NOT in the
 * enforced set: those carry a visible `<label>` or placeholder that is on screen the whole
 * time, and a tooltip repeating it is noise rather than help. Anything you ACT on - a
 * button, a link, a select, a checkbox, a radio, a `<summary>` - is in.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import ts from "typescript";

const WEB = fileURLToPath(new URL("../src/web", import.meta.url));
const STYLES = readFileSync(new URL("../src/web/styles.css", import.meta.url), "utf8");

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p));
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out.sort();
}

/**
 * Blank out comments so prose describing markup is never mistaken for markup. Same width,
 * so reported line numbers still point at the real line.
 */
function withoutComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

const FREE_TEXT = /^(text|number|search|password|email|url|file|hidden)$/;
const INTERACTIVE_ROLES = new Set([
  "button",
  "option",
  "menuitem",
  "menuitemradio",
  "menuitemcheckbox",
  "switch",
  "tab",
]);
const INTERACTIVE_COMPONENTS = new Set(["ControlButton"]);

/** The tag that opens immediately before `index`, or "" at the start of a file. */
function enclosingTag(src: string, index: number): string {
  // Scanning back for a bare "<" would find the comparison in a `foo(x) < 0` inside a
  // Tooltip's own label expression, and report a wrapped control as unwrapped.
  for (let i = index - 1; i >= 0; i--) {
    if (src[i] === "<" && /[A-Za-z/]/.test(src[i + 1] ?? "")) {
      return (src.slice(i + 1).match(/^[A-Za-z][\w.]*/) ?? [""])[0]!;
    }
  }
  return "";
}

function attribute(node: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  return node.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText() === name,
  );
}

function stringAttribute(node: ts.JsxOpeningLikeElement, name: string): string | undefined {
  const initializer = attribute(node, name)?.initializer;
  return initializer && ts.isStringLiteral(initializer) ? initializer.text : undefined;
}

function tagName(node: ts.JsxOpeningLikeElement): string {
  return node.tagName.getText();
}

function tooltipAncestors(node: ts.Node): ts.JsxElement[] {
  const ancestors: ts.JsxElement[] = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isJsxElement(parent) && tagName(parent.openingElement) === "Tooltip") {
      ancestors.push(parent);
    }
  }
  return ancestors;
}

function descendants(
  node: ts.Node,
  predicate: (candidate: ts.JsxOpeningLikeElement) => boolean,
): ts.JsxOpeningLikeElement[] {
  const found: ts.JsxOpeningLikeElement[] = [];
  function visit(candidate: ts.Node): void {
    if (ts.isJsxElement(candidate)) {
      if (predicate(candidate.openingElement)) found.push(candidate.openingElement);
    } else if (ts.isJsxSelfClosingElement(candidate) && predicate(candidate)) {
      found.push(candidate);
    }
    ts.forEachChild(candidate, visit);
  }
  ts.forEachChild(node, visit);
  return found;
}

function hasDisjointTooltipChild(node: ts.JsxElement): boolean {
  const tooltipChildren = node.children.filter(
    (child) => ts.isJsxElement(child) && tagName(child.openingElement) === "Tooltip",
  );
  return (
    tooltipChildren.length === 1 &&
    descendants(node, isInteractive).length === 0 &&
    descendants(tooltipChildren[0]!, isInteractive).length === 0
  );
}

function hasValidTooltipOwner(node: ts.Node): boolean {
  const owners = tooltipAncestors(node);
  if (owners.length !== 1) return false;
  const owner = owners[0]!;
  return (
    descendants(owner, isInteractive).length === 1 &&
    descendants(owner, (candidate) => tagName(candidate) === "Tooltip").length === 0
  );
}

function isInteractive(node: ts.JsxOpeningLikeElement): boolean {
  const name = tagName(node);
  if (INTERACTIVE_COMPONENTS.has(name)) return Boolean(attribute(node, "onClick"));
  if (name === "button" || name === "select" || name === "summary") return true;
  if (name === "a") return Boolean(attribute(node, "href"));
  if (name === "input") {
    const typeAttribute = attribute(node, "type");
    if (!typeAttribute) return false;
    const type = stringAttribute(node, "type");
    return type === undefined || !FREE_TEXT.test(type);
  }
  const role = stringAttribute(node, "role");
  return Boolean(
    role &&
      INTERACTIVE_ROLES.has(role) &&
      (attribute(node, "onClick") || attribute(node, "onMouseDown")),
  );
}

function unwrappedInSource(raw: string, file: string): string[] {
  const source = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const misses: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isJsxElement(node) && isInteractive(node.openingElement)) {
      if (!hasValidTooltipOwner(node) && !hasDisjointTooltipChild(node)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        misses.push(`${file}:${line} <${tagName(node.openingElement)}>`);
      }
    } else if (ts.isJsxSelfClosingElement(node) && isInteractive(node)) {
      if (!hasValidTooltipOwner(node)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        misses.push(`${file}:${line} <${tagName(node)}>`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return misses;
}

function unwrapped(): string[] {
  const misses: string[] = [];
  for (const file of tsxFiles(WEB)) {
    if (file.endsWith("Tooltip.tsx")) continue;
    const relative = file.slice(WEB.length + 1);
    misses.push(...unwrappedInSource(readFileSync(file, "utf8"), relative));
  }
  return misses;
}

test("every interactive element is wrapped in the shared Tooltip", () => {
  const misses = unwrapped();
  assert.deepEqual(
    misses,
    [],
    `these controls give the operator no hover description - wrap each in <Tooltip label="…">:\n  ${misses.join("\n  ")}`,
  );
});

test("nothing describes itself with a native title attribute any more", () => {
  // The second way to do this. Left available, it comes back one control at a time, and
  // each one is a bubble the theme does not reach and a keyboard user never sees.
  const offenders: string[] = [];
  for (const file of tsxFiles(WEB)) {
    const raw = readFileSync(file, "utf8");
    const src = withoutComments(raw);
    // `title=` on a DOM element only. `<Section title="Needs you">` and friends are
    // component PROPS that happen to share the name, and are none of this test's business.
    for (const m of src.matchAll(/\stitle=/g)) {
      const openedBy = enclosingTag(src, m.index);
      if (openedBy && openedBy[0] === openedBy[0]!.toUpperCase()) continue;
      // `<iframe title>` is the frame's ACCESSIBLE NAME, not a tooltip - it is what a
      // screen reader announces the embedded document as, and it is required. Browsers
      // do not render a bubble for it, so there is nothing here for `Tooltip` to replace.
      if (openedBy === "iframe") continue;
      const line = raw.slice(0, m.index).split("\n").length;
      offenders.push(`${file.slice(WEB.length + 1)}:${line}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `use <Tooltip label="…"> instead of a native title attribute:\n  ${offenders.join("\n  ")}`,
  );
});

test("tooltips shrink-fit their text before the viewport cap", () => {
  const body = /\.tooltip\s*\{([^}]*)\}/.exec(STYLES)?.[1];
  assert.ok(body, "the shared .tooltip rule is gone");
  assert.match(body, /\bwidth:\s*max-content\s*;/);
  assert.match(body, /\bmax-width:\s*[^;]+\s*;/);
});

test("the scan can actually see a missing tooltip", () => {
  // A coverage test that cannot fail is a green light wired to nothing. These pin the two
  // things the real scan depends on: that a bare control is caught, and that the `<` in a
  // Tooltip's own label expression does not make a wrapped one look bare.
  const bare = `const A = () => <div><button onClick={x}>Go</button></div>;`;
  assert.equal(enclosingTag(bare, bare.indexOf("<button")), "div");

  const wrapped =
    `const B = () => <Tooltip label={n < 0 ? "first" : "earlier"}><button>↑</button></Tooltip>;`;
  assert.equal(enclosingTag(wrapped, wrapped.indexOf("<button")), "Tooltip");

  const roleControl =
    `const C = () => <ul><li role="option" onMouseDown={choose}>repo</li></ul>;`;
  assert.deepEqual(unwrappedInSource(roleControl, "role.tsx"), ["role.tsx:1 <li>"]);

  const wrappedRole =
    `const D = () => <ul><Tooltip label="repo"><li role="option" onMouseDown={choose}>repo</li></Tooltip></ul>;`;
  assert.deepEqual(unwrappedInSource(wrappedRole, "wrapped-role.tsx"), []);

  const wrappedRow =
    `const E = () => <Tooltip label="mode"><label><input type="radio" /></label></Tooltip>;`;
  assert.deepEqual(unwrappedInSource(wrappedRow, "wrapped-row.tsx"), []);

  const disjoint =
    `const F = () => <button><Tooltip label="open"><span>Name</span></Tooltip></button>;`;
  assert.deepEqual(unwrappedInSource(disjoint, "disjoint.tsx"), []);

  const expressionType = `const G = () => <input type={kind} />;`;
  assert.deepEqual(unwrappedInSource(expressionType, "expression.tsx"), [
    "expression.tsx:1 <input>",
  ]);

  const nestedControls =
    `const H = () => <Tooltip label="wrong"><div><button>One</button><button>Two</button></div></Tooltip>;`;
  assert.deepEqual(unwrappedInSource(nestedControls, "nested.tsx"), [
    "nested.tsx:1 <button>",
    "nested.tsx:1 <button>",
  ]);

  const componentControl =
    `const I = () => <ControlButton onClick={zoom}>+</ControlButton>;`;
  assert.deepEqual(unwrappedInSource(componentControl, "component.tsx"), [
    "component.tsx:1 <ControlButton>",
  ]);
});
