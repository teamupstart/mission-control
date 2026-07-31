/**
 * What is at stake: an ensemble detail puts several agent-authored strings SIDE BY SIDE, and a
 * column that sizes itself to its own content overlaps the candidate next to it - both become
 * unreadable, which is what an operator reported.
 *
 * Why the declarations below are the ones that prevent that is stated where they live, on
 * `.ensemble-detail` in `src/web/styles.css`. This file pins that they are still there, which is
 * all a stylesheet can be held to without rendering it:
 *
 * 1. The detail declares exactly one `overflow-wrap: anywhere`, the value the comment there
 *    requires; `break-word` is the substitution that would satisfy a looser check.
 * 2. No grid in this feature declares an fr track over a content-sized minimum.
 * 3. The stacks that hold a run's own strings declare a floored track rather than inheriting an
 *    implicit one, which assertion 2 cannot see because there is nothing written to inspect.
 * 4. The lanes exempted from 2 still satisfy the premise that makes exempting them safe.
 *
 * The limit of what this can prove: these assertions read DECLARATIONS. A rule that parses as
 * floored and still renders wrong is outside their reach, because nothing here lays out a column.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../src/web/styles.css", import.meta.url)), "utf8");
/** Comments discuss `1fr` and `overflow-wrap` in prose, so they go before anything is parsed. */
const bare = css.replace(/\/\*[\s\S]*?\*\//g, " ");

interface Rule {
  selectors: string[];
  body: string;
}

/** styles.css has no preprocessor and no nesting, so one flat pass is exact. */
function rules(source: string): Rule[] {
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const selectors = (m[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/\s+/g, " "))
      .filter(Boolean);
    out.push({ selectors, body: m[2] ?? "" });
  }
  return out;
}

const ALL = rules(bare);

function declaration(rule: Rule, property: string): string | null {
  const re = new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]+)`, "i");
  const found = re.exec(rule.body);
  return found ? (found[1] ?? "").trim() : null;
}

/**
 * The class tokens of a selector's SUBJECT - the compound after the last combinator, which is the
 * element the rule styles. `.dossier-col .ensemble-scorecard-cols` is a rule about the cols.
 */
function subjectClasses(selector: string): string[] {
  const subject = selector.split(/\s+|>|\+|~/).filter(Boolean).pop() ?? "";
  return [...subject.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]!);
}

test("the ensemble detail wraps agent text at any character, so nothing can size a column", () => {
  const detail = ALL.filter((r) => r.selectors.some((s) => subjectClasses(s).includes("ensemble-detail")))
    .map((r) => declaration(r, "overflow-wrap"))
    .filter((v): v is string => v !== null);
  assert.deepEqual(
    detail,
    ["anywhere"],
    "`.ensemble-detail` must declare exactly one `overflow-wrap: anywhere` - one declaration, " +
      "inherited by the whole subtree. `break-word` is the near-miss this refuses; the comment on " +
      "the rule in `styles.css` says why it is not a substitute.",
  );
});

/**
 * Scope is a class PREFIX, not a list of names, so the next grid added to this feature is covered
 * without anyone remembering this file.
 */
const GRID_PREFIX = /^(dossier-|ensemble-)/;

/**
 * The dispatch form's lanes, which proportion CONTROLS rather than prose: `auto 1.25fr 1fr 0.9fr
 * 1.5fr auto` is a deliberate share-out of an ordinal, three pickers, an approach field and a
 * remove button. The reason it is safe is checked below, not asserted here - the controls declare
 * `min-width: 0`, so the fr shares hold and nothing inside can raise the floor.
 */
const EXEMPT = new Set(["ensemble-lane", "ensemble-judge-lane"]);

function isScopedGrid(selector: string): boolean {
  const classes = subjectClasses(selector);
  if (classes.some((cls) => EXEMPT.has(cls))) return false;
  return classes.some((cls) => GRID_PREFIX.test(cls));
}

/**
 * The `fr` tracks in a track list that carry no explicit minimum. `minmax(0, 1fr)` and
 * `minmax(min(320px, 100%), 1fr)` carry one; a bare `1fr` and `minmax(auto, 1fr)` do not.
 */
function unflooredFrTracks(value: string): string[] {
  // Scanned rather than matched with one regex: a minimum may itself be a function with a comma
  // in it (`minmax(min(320px, 100%), 1fr)`), and splitting on the first comma reads that floor as
  // `min(320px` and calls the sound rule an offender.
  let remaining = "";
  for (let i = 0; i < value.length; ) {
    if (!value.startsWith("minmax(", i)) {
      remaining += value[i];
      i += 1;
      continue;
    }
    const open = i + "minmax(".length;
    let depth = 1;
    let comma = -1;
    let j = open;
    for (; j < value.length && depth > 0; j += 1) {
      const ch = value[j];
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      else if (ch === "," && depth === 1 && comma === -1) comma = j;
    }
    const min = comma === -1 ? "" : value.slice(open, comma).trim();
    if (comma === -1 || !isBoundedMinimum(min)) {
      remaining += value.slice(i, j);
    }
    i = j;
  }
  return [...remaining.matchAll(/[\d.]*fr/g)].map((m) => m[0]!);
}

/**
 * A minimum THIS STYLESHEET chose: a length, a percentage, or a math function over them.
 *
 * An allow-list, not a list of spellings to refuse, because the failure here is a track form nobody
 * anticipated passing by omission. `fit-content(320px)` did exactly that against a deny-list: it
 * names no intrinsic keyword and holds no `fr`, and it still keeps the automatic minimum, so a
 * child that cannot break widens the track anyway. A form this does not recognise is refused, and
 * refusing a sound one is a visible test failure with the value in the message - the direction the
 * mistake should fall.
 */
function isBoundedMinimum(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (!v) return false;
  // A math function over lengths. The keyword check guards THIS branch and only this one:
  // everything unrecognised is already refused below by not matching, but `min(…)` and friends
  // would otherwise swallow whatever is nested in them.
  if (/^(?:calc|min|max|clamp)\(.*\)$/.test(v)) {
    return !/(?:^|[\s,(])(?:auto|min-content|max-content|fit-content)(?=$|[\s,()])/.test(v);
  }
  return /^(?:0|-?\d*\.?\d+(?:px|rem|em|ex|ch|vw|vh|vmin|vmax|cm|mm|in|pt|pc|q|%))$/.test(v);
}

/** The first comma at paren depth 0 - `minmax(min(320px, 100%), 1fr)` splits at the second one. */
function topLevelComma(value: string): number {
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) return i;
  }
  return -1;
}

/** Top-level tracks of a track list, each parenthesised function kept whole. */
function topLevelTracks(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    if (/\s/.test(ch) && depth === 0) {
      if (current) out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

function trackIsBounded(track: string): boolean {
  const t = track.trim();
  if (!t || !t.endsWith(")")) return isBoundedMinimum(t);
  if (/^repeat\(/i.test(t)) {
    // The count is not a track: `auto-fit` there is a repetition rule, not a size.
    const inner = t.slice("repeat(".length, -1);
    const comma = topLevelComma(inner);
    return comma !== -1 && hasExplicitlyBoundedTracks(inner.slice(comma + 1));
  }
  if (/^minmax\(/i.test(t)) {
    // Only the MINIMUM has to be bounded; a `1fr` maximum is what the track is for.
    const inner = t.slice("minmax(".length, -1);
    const comma = topLevelComma(inner);
    return comma !== -1 && isBoundedMinimum(inner.slice(0, comma));
  }
  return isBoundedMinimum(t);
}

function hasExplicitlyBoundedTracks(value: string): boolean {
  const normalized = value.trim();
  if (/^(?:none|subgrid|masonry|inherit|initial|unset|revert|revert-layer)$/i.test(normalized)) {
    return false;
  }
  const tracks = topLevelTracks(normalized);
  return tracks.length > 0 && tracks.every(trackIsBounded);
}

test("the floor detector rejects every content-sized spelling", () => {
  // `fit-content(x)` is the one that does not announce itself: it clamps a max-content size but
  // keeps the automatic minimum, so it reads like a chosen width and behaves like `auto`.
  for (const minimum of ["auto", "min-content", "max-content", "fit-content(320px)"]) {
    assert.deepEqual(
      unflooredFrTracks(`minmax(${minimum}, 1fr)`),
      ["1fr"],
      `${minimum} is content-sized and cannot floor an fr track`,
    );
    assert.equal(
      hasExplicitlyBoundedTracks(minimum),
      false,
      `${minimum} is not an explicitly bounded stack track`,
    );
    assert.equal(
      hasExplicitlyBoundedTracks(`repeat(1, ${minimum})`),
      false,
      `${minimum} stays content-sized when nested in repeat()`,
    );
  }
  assert.equal(hasExplicitlyBoundedTracks("1fr"), false);
  assert.equal(hasExplicitlyBoundedTracks("none"), false);
  assert.equal(hasExplicitlyBoundedTracks(""), false);
  // A form the allow-list does not know is refused rather than assumed sound.
  assert.equal(hasExplicitlyBoundedTracks("somefuture-sizing(2)"), false);
  // A math function is allowed through as a minimum, so it is the one place a content-sized
  // keyword could still ride in nested.
  assert.equal(hasExplicitlyBoundedTracks("minmax(min(fit-content(200px), 50%), 1fr)"), false);
  assert.equal(hasExplicitlyBoundedTracks("minmax(max(auto, 20rem), 1fr)"), false);

  // Every shape the stylesheet actually uses has to survive the allow-list, or the guard would be
  // refusing sound rules instead of unsound ones.
  for (const sound of [
    "minmax(0, 1fr)",
    "minmax(min(320px, 100%), 1fr)",
    "repeat(2, minmax(0, 1fr))",
    "repeat(auto-fit, minmax(min(320px, 100%), 1fr))",
    "repeat(auto-fill, minmax(150px, 1fr))",
    "minmax(220px, 300px) minmax(0, 1fr)",
    "160px minmax(0, 1fr)",
  ]) {
    assert.equal(hasExplicitlyBoundedTracks(sound), true, `${sound} is explicitly bounded`);
    assert.deepEqual(unflooredFrTracks(sound), [], `${sound} floors every fr track`);
  }
});

test("no ensemble grid sizes a track to the text in it", () => {
  const offenders: string[] = [];
  for (const rule of ALL) {
    const subjects = rule.selectors.filter(isScopedGrid);
    if (subjects.length === 0) continue;
    const tracks = declaration(rule, "grid-template-columns");
    if (!tracks) continue;
    const unfloored = unflooredFrTracks(tracks);
    if (unfloored.length > 0) {
      offenders.push(`${subjects.join(", ")} { grid-template-columns: ${tracks} }`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "Give each fr track a floor content cannot raise - `minmax(0, 1fr)` for a share of the row, " +
      "`minmax(min(<width>, 100%), 1fr)` for a column with a readable minimum. Offending rules:\n" +
      offenders.join("\n"),
  );
});

/**
 * Assertion 3's subjects: grids that declare no columns at all, which the floor test cannot see
 * because there is nothing written to inspect until someone adds a track list.
 *
 * Named, and not every implicit-column grid in the section: the others (timeline rows, decision
 * choices, dispatch lanes) hold bounded, app-authored content, and the article's inherited wrapping
 * already keeps prose from sizing them. These five are where a run's own strings land.
 */
const FLOORED_STACKS = [
  "ensemble-detail",
  "ensemble-member-list",
  "ensemble-artifact-list",
  "ensemble-scorecards",
  "dossier-claims",
];

test("the stacks that hold a run's own strings declare the floor rather than inheriting auto", () => {
  const missing = FLOORED_STACKS.filter((cls) => {
    const declared = ALL.filter((rule) =>
      rule.selectors.some((s) => subjectClasses(s).includes(cls) && !/\s/.test(s)),
    )
      .map((rule) => declaration(rule, "grid-template-columns"))
      .filter((v): v is string => v !== null);
    return declared.length === 0 || declared.some((v) => !hasExplicitlyBoundedTracks(v));
  });
  assert.deepEqual(
    missing,
    [],
    "These must each declare `grid-template-columns` with a floored track rather than leaving the " +
      "implicit one a `display: grid` gets. Missing or unfloored: " + missing.join(", "),
  );
});

test("the lane exemption is still true: its fr shares hold because the controls give way", () => {
  // `.ensemble-lane select` / `.ensemble-lane input`: a control inside an exempt lane.
  const controlInLane = /\.ensemble-(judge-)?lane\s+(select|input|textarea)$/;
  const declared = ALL.some(
    (rule) =>
      rule.selectors.some((s) => controlInLane.test(s)) && declaration(rule, "min-width") === "0",
  );
  assert.ok(
    declared,
    "The lane grids are exempt from the floor rule only because the controls in them declare " +
      "`min-width: 0`, so a long approach string cannot widen a track. That declaration is gone, " +
      "so either put it back or drop the exemption in this file.",
  );
});

test("a candidate column cannot be widened by what is inside it", () => {
  const col = ALL.filter((r) => r.selectors.some((s) => subjectClasses(s).includes("dossier-col")));
  assert.ok(
    col.some((r) => declaration(r, "min-width") === "0"),
    "`.dossier-col` needs `min-width: 0`; the rule's own comment in `styles.css` says what a " +
      "column that outgrows its track does instead of clipping.",
  );
});
