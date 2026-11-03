import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_SKIN, SKIN_IDS, SKINS, skinById } from "../src/shared/skins.ts";

// What is at stake: a skin repaints every surface of the dashboard, and nothing else in the
// repository would notice one that made text unreadable or left a state colour invisible.
//
// This is the contract every skin is held to - Default included, and every skin a later
// change registers, with no new case: the registry and the files agree, each skin declares
// the tokens it must, and its text and state tones clear WCAG contrast on the surfaces they
// are drawn on. A skin that fails it is fixed, never the thresholds relaxed.

const STYLES = readFileSync(fileURLToPath(new URL("../src/web/styles.css", import.meta.url)), "utf8");
const SKINS_DIR = new URL("../src/web/skins/", import.meta.url);
const skinPath = (id: string): string => fileURLToPath(new URL(`${id}.css`, SKINS_DIR));

/** The body of the first `<selector> { ... }` block, or null. */
function block(css: string, selector: string): string | null {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) return null;
  const open = css.indexOf("{", start);
  const close = css.indexOf("\n}", open);
  return close === -1 ? null : css.slice(open + 1, close);
}

/** `--name: value;` declarations at the top level of a block (comments stripped). */
function declarations(body: string): Map<string, string> {
  const tokens = new Map<string, string>();
  const plain = body.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of plain.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) tokens.set(m[1]!, m[2]!.trim());
  return tokens;
}

const ROOT = (() => {
  const body = block(STYLES, ":root");
  assert.ok(body, "styles.css has no leading :root block");
  return declarations(body);
})();

/** A skin's tokens over `:root`'s: what the page resolves while that skin is in force. */
function tokensOf(id: string): Map<string, string> {
  if (id === DEFAULT_SKIN) return new Map(ROOT);
  const own = block(readFileSync(skinPath(id), "utf8"), `:root[data-skin="${id}"]`);
  assert.ok(own, `src/web/skins/${id}.css has no :root[data-skin="${id}"] block`);
  return new Map([...ROOT, ...declarations(own)]);
}

/** A token as `#rrggbb`, following `var()` aliases (`--held: var(--purple)`). */
function hex(tokens: Map<string, string>, name: string, seen: string[] = []): string {
  const value = tokens.get(name);
  assert.ok(value, `${name} is not declared`);
  const alias = /^var\((--[\w-]+)\)$/.exec(value);
  if (alias) {
    assert.ok(!seen.includes(name), `${name} aliases itself through ${seen.join(" -> ")}`);
    return hex(tokens, alias[1]!, [...seen, name]);
  }
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  assert.match(value, /^#[0-9a-f]{6}$/i, `${name} (${value}) must be a hex colour or a var() alias of one`);
  return value.toLowerCase();
}

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

const SURFACES = ["--bg", "--panel", "--panel-2"];
/** Text and state tones that must read as small text. `--held` aliases `--purple`. */
const AA_TONES = ["--fg", "--muted", "--dim", "--working", "--idle", "--attention", "--danger", "--held"];
/** `--exited` marks a finished session and is meant to recede: 3:1, not 4.5:1. Default's own
 *  measures 3.94:1 on `--panel-2`, so 4.5:1 would force a change to today's look. */
const RECEDING_TONES = ["--exited"];

/** What a skin file must state, because Default's dark value would paint wrong under it. */
const REQUIRED = [
  "--bg", "--bg-2", "--panel", "--panel-2", "--border", "--border-soft",
  "--fg", "--muted", "--dim",
  "--working", "--idle", "--attention", "--danger", "--exited", "--purple",
  "--radius", "--shadow",
];

test("ids are unique, kebab-case, and Default comes first", () => {
  assert.equal(SKINS[0].id, DEFAULT_SKIN, "Default must stay first; ids are append-only");
  assert.deepEqual(SKIN_IDS, SKINS.map((s) => s.id));
  assert.equal(new Set(SKIN_IDS).size, SKIN_IDS.length, "a skin id is registered twice");
  for (const id of SKIN_IDS) assert.match(id, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, `${id} is not kebab-case`);
  for (const skin of SKINS) {
    assert.ok(skin.label.trim(), `${skin.id} has no label`);
    assert.ok(skin.description.trim(), `${skin.id} has no description`);
  }
  // The shipped order is persisted on machines; Phase 3 appends after these.
  assert.deepEqual(SKIN_IDS.slice(0, 2), ["default", "daylight"]);
  assert.equal(skinById("not-a-skin").id, DEFAULT_SKIN);
});

test("every non-default skin has its file, and index.css imports exactly those, in order", () => {
  const index = readFileSync(fileURLToPath(new URL("index.css", SKINS_DIR)), "utf8");
  const imported = [...index.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/@import\s+"\.\/([\w-]+)\.css"\s*;/g)]
    .map((m) => m[1]);
  const expected = SKIN_IDS.filter((id) => id !== DEFAULT_SKIN);
  assert.deepEqual(imported, expected, "src/web/skins/index.css and the registry disagree");
  for (const id of expected) assert.ok(existsSync(skinPath(id)), `src/web/skins/${id}.css is missing`);
  assert.equal(existsSync(skinPath(DEFAULT_SKIN)), false, "Default is :root itself and has no file");
});

test("every skin file declares every required token and scopes every rule to itself", () => {
  for (const id of SKIN_IDS.filter((s) => s !== DEFAULT_SKIN)) {
    const css = readFileSync(skinPath(id), "utf8");
    const own = block(css, `:root[data-skin="${id}"]`);
    assert.ok(own, `${id}.css has no :root[data-skin="${id}"] block`);
    const declared = declarations(own);
    const missing = REQUIRED.filter((name) => !declared.has(name));
    assert.deepEqual(missing, [], `${id}.css does not restate ${missing.join(", ")}`);
    // A selector that is not scoped to this skin would restyle every other skin too.
    const selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(^|})\s*([^{}@][^{}]*)\{/g)]
      .flatMap((m) => m[2]!.split(","))
      .map((s) => s.trim())
      .filter(Boolean);
    for (const selector of selectors) {
      assert.ok(selector.startsWith(`:root[data-skin="${id}"]`), `${id}.css has an unscoped rule: ${selector}`);
    }
  }
});

test("the registry declares a colour scheme that matches its skin file", () => {
  for (const skin of SKINS) {
    if (skin.id === DEFAULT_SKIN) {
      assert.match(block(STYLES, ":root")!, /color-scheme:\s*dark\s*;/);
      assert.equal(skin.colorScheme, "dark");
      continue;
    }
    const own = block(readFileSync(skinPath(skin.id), "utf8"), `:root[data-skin="${skin.id}"]`)!;
    const declared = /color-scheme:\s*(dark|light)\s*;/.exec(own)?.[1] ?? "dark";
    assert.equal(declared, skin.colorScheme, `${skin.id}.css says ${declared}, the registry ${skin.colorScheme}`);
  }
});

test("text and state tones clear WCAG contrast on every surface, in every skin", () => {
  const failures: string[] = [];
  for (const id of SKIN_IDS) {
    const tokens = tokensOf(id);
    for (const surface of SURFACES) {
      const bg = hex(tokens, surface);
      for (const [tones, floor] of [[AA_TONES, 4.5], [RECEDING_TONES, 3]] as const) {
        for (const tone of tones) {
          const ratio = contrast(hex(tokens, tone), bg);
          if (ratio < floor) failures.push(`${id}: ${tone} on ${surface} is ${ratio.toFixed(2)}:1, under ${floor}:1`);
        }
      }
    }
  }
  assert.deepEqual(failures, []);
});

test("the picker's swatches are the skin's own token values", () => {
  const map = { bg: "--bg", panel: "--panel", fg: "--fg", working: "--working", idle: "--idle", attention: "--attention" } as const;
  for (const skin of SKINS) {
    const tokens = tokensOf(skin.id);
    for (const [key, token] of Object.entries(map) as [keyof typeof map, string][]) {
      assert.equal(skin.swatches[key], hex(tokens, token), `${skin.id} swatch ${key} disagrees with ${token}`);
    }
  }
});
