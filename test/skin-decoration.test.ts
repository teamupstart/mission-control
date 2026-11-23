import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_SKIN, SKIN_IDS } from "../src/shared/skins.ts";

// What is at stake: a skin is allowed to look different and never to move anything. Its
// token block can only recolour, refont and re-round, but the rules it adds beside that block
// can set any property at all - and a padding, a font size or a `filter` there would shift
// the Line strip, push a measured ladder across a breakpoint, or cost paint time on a large
// board, under one skin only, where nobody happened to look.
//
// `skins.test.ts` holds the token block (required tokens, contrast, scoping). This holds what
// sits beside it to the limit `docs/agent-guides/change-contracts.md` states, for every skin
// a later change registers, with no new case.

const SKINS_DIR = new URL("../src/web/skins/", import.meta.url);
const skinCss = (id: string): string =>
  readFileSync(fileURLToPath(new URL(`${id}.css`, SKINS_DIR)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * What a decoration rule may set. Paint only: backgrounds and the two shadows draw outside
 * the box model, `text-transform` changes letters and not boxes, and `color` and
 * `border-color` recolour an existing border without changing its width.
 */
const DECORATION = new Set([
  "background",
  "background-color",
  "background-image",
  "background-position",
  "background-size",
  "background-repeat",
  "box-shadow",
  "text-shadow",
  "text-transform",
  "color",
  "border-color",
]);

interface Rule {
  selector: string;
  properties: Map<string, string>;
}

/** Top-level rules of a skin file. Skin files hold no at-rules and no nesting. */
function rules(css: string): Rule[] {
  const out: Rule[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const properties = new Map<string, string>();
    // A declaration ends at a semicolon outside quotes, so a data URI's own `;` stays inside.
    for (const d of m[2]!.matchAll(/([\w-]+)\s*:\s*((?:"[^"]*"|'[^']*'|[^;"'])+);?/g)) {
      properties.set(d[1]!.trim(), d[2]!.trim());
    }
    out.push({ selector: m[1]!.trim(), properties });
  }
  return out;
}

const DECORATED = SKIN_IDS.filter((id) => id !== DEFAULT_SKIN);

test("a skin's token block holds tokens and its colour scheme, nothing else", () => {
  for (const id of DECORATED) {
    const own = rules(skinCss(id)).filter((r) => r.selector === `:root[data-skin="${id}"]`);
    assert.equal(own.length, 1, `${id}.css should declare its token block exactly once`);
    const stray = [...own[0]!.properties.keys()].filter((name) => !name.startsWith("--") && name !== "color-scheme");
    assert.deepEqual(stray, [], `${id}.css sets ${stray.join(", ")} on :root itself`);
  }
});

test("every decoration rule paints and never sizes, filters or animates", () => {
  const failures: string[] = [];
  for (const id of DECORATED) {
    for (const rule of rules(skinCss(id))) {
      if (rule.selector === `:root[data-skin="${id}"]`) continue;
      for (const name of rule.properties.keys()) {
        if (!DECORATION.has(name)) failures.push(`${id}: ${rule.selector} sets ${name}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test("the scanner sees a forbidden property and reads past a data URI", () => {
  const css = `:root[data-skin="x"] { --a: url("data:a;b"); }\n:root[data-skin="x"] .y { padding: 1px; filter: blur(2px); color: red; }`;
  const [tokens, deco] = rules(css);
  assert.deepEqual([...tokens!.properties.keys()], ["--a"]);
  assert.deepEqual(
    [...deco!.properties.keys()].filter((n) => !DECORATION.has(n)),
    ["padding", "filter"],
  );
});

// ---- Neon Dusk's Dispatch button ----

function luminance(colour: string): number {
  const channel = (i: number): number => {
    const c = parseInt(colour.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

test("Neon Dusk's Dispatch lettering clears 4.5:1 on both ends of its gradient", () => {
  const all = rules(skinCss("neon-dusk"));
  const tokens = all.find((r) => r.selector === ':root[data-skin="neon-dusk"]')!.properties;
  const button = all.find((r) => r.selector === ':root[data-skin="neon-dusk"] .dispatch-btn')!.properties;
  // The rule names its ends and its ink by token; resolve those through the skin's block, so a
  // retuned --purple, --working or --bg is measured here rather than a copy of their values.
  assert.equal(button.get("color"), "var(--bg)");
  assert.match(button.get("background") ?? "", /^linear-gradient\(90deg, var\(--purple\), var\(--working\)\) border-box$/);
  const ink = tokens.get("--bg")!;
  for (const end of ["--purple", "--working"]) {
    const ratio = contrast(ink, tokens.get(end)!);
    assert.ok(ratio >= 4.5, `Dispatch text on ${end} (${tokens.get(end)}) is ${ratio.toFixed(2)}:1`);
  }
});
