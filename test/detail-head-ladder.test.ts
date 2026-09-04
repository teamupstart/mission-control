/**
 * What is at stake: the console detail header carries the session's identity, its situational
 * chips, the review badge and the whole runtime cluster, and it used to WRAP - so a session
 * with a long name spent a second row on mode, model, effort, context and cost at every width.
 * That row comes straight off the conversation underneath it.
 *
 * Two independent things now keep it on one row, and each has its own silent failure.
 *
 * The first is the identity block's flex BASE size. Flex line-breaking places an item at its
 * hypothetical main size, so `flex-basis: auto` measured the block at the TITLE'S max-content
 * width and pushed everything after it onto a second row before any shrinking happened. A
 * revert to `auto`, or a `min-width: 0` that lets the name surrender every pixel before the
 * cost chip surrenders one, both read as ordinary CSS and neither shows up as a test failure
 * anywhere else.
 *
 * The second is the LADDER, whose failure modes are the ones `topbar-ladder.test.ts` and
 * `detail-tabs-ladder.test.ts` enumerate, because it is the same mechanism
 * (`measuredLadder.ts`):
 *
 * 1. The CSS and `DETAIL_HEAD_RUNGS` disagree on how many rungs there are. The fit then stops
 *    a rung early with room still to give back, or steps onto a rung that does not exist and
 *    reports the row unfittable.
 * 2. The row stops wrapping - or a CHILD starts wrapping. The fit READS wrapping by comparing
 *    the row's height against its tallest child, so `nowrap` on the row makes the ladder inert,
 *    and a child that wraps internally (`.card-runtime` does on a board card) grows the row and
 *    its tallest child in lockstep and hides the overflow from that same comparison.
 * 3. A rung sheds a word with `display: none`, taking the control's accessible name with it.
 * 4. A rung hides the REVIEW BADGE, which is the one control this row must always draw.
 *
 * Driven from source for the reason the other two ladder tests give: there is no jsdom here.
 * What a browser has to answer instead - that the row actually stays on one line at every
 * width, and that the badge is still drawn when it does - is
 * `e2e/specs/console-header-one-row.spec.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DETAIL_HEAD_RUNGS } from "../src/web/detailHeadLadder.ts";
import { ConsoleDetail } from "../src/web/components/layouts/ConsoleDetail.tsx";
import { meta, mkSession } from "./helpers/session-fixture.ts";
import { mkSessionView } from "./helpers/session-view.ts";

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

const css = read("src/web/styles.css");
const detail = read("src/web/components/layouts/ConsoleDetail.tsx");

/** Comments discuss `display: none` and rung numbers in prose, so they go first. */
const bare = css.replace(/\/\*[\s\S]*?\*\//g, " ");

/** Every `[selector, body]` pair in the sheet. */
const RULES: [string, string][] = [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
  ([, s = "", b = ""]) => [s.trim().replace(/\s+/g, " "), b],
);

/**
 * A rung rule nested inside an at-rule, which this flat parse cannot see and which the ladder
 * cannot survive.
 *
 * The parse above is deliberately flat - it reads `[selector, body]` pairs and knows nothing
 * about nesting - so a rung rule inside `@media` reaches every scan below stripped of the
 * query that gates it. The scans would then agree the rule applies unconditionally while the
 * browser applied it at some widths and not others.
 *
 * That is not a hypothetical inconvenience for a MEASURED ladder, it is the one mistake the
 * mechanism exists to avoid: `fitDetailHead` sets a rung and measures what it bought, so a
 * rung that fires on a viewport instead of on the fit's instruction makes the measurement a
 * lie - the fit steps down, nothing changes, and it steps down again to the bottom.
 *
 * Raised as a nitpick by a reviewer on #890. The same flat parse is in `topbar-ladder.test.ts`
 * and `detail-tabs-ladder.test.ts`; neither guards this, and widening them is a change to
 * files this task did not touch.
 */
test("no rung rule hides inside an at-rule, where the fit cannot reach it", () => {
  const nested: string[] = [];
  for (const at of bare.matchAll(/@(media|container|supports)[^{]*\{/g)) {
    let depth = 1;
    let i = at.index! + at[0].length;
    const from = i;
    while (i < bare.length && depth > 0) {
      if (bare[i] === "{") depth += 1;
      else if (bare[i] === "}") depth -= 1;
      i += 1;
    }
    if (bare.slice(from, i).includes(".detail-head[data-rung")) {
      nested.push(at[0].trim().replace(/\s+/g, " "));
    }
  }
  assert.deepEqual(
    nested,
    [],
    "a `.detail-head[data-rung]` rule is nested inside an at-rule, so it fires on a viewport " +
      "rather than when the fit applies it - which makes every measurement the fit takes a " +
      "lie, and hides the rule from every scan in this file",
  );
});

/** The token a rung's selector carries, e.g. 2 for `.detail-head[data-rung~="2"] .wbc-word`. */
function rungOf(selector: string): number | null {
  const found = [...selector.matchAll(/\.detail-head\[data-rung~="(\d+)"\]/g)].map((m) =>
    Number(m[1]),
  );
  if (found.length === 0) return null;
  // A selector list is only ever one rung's; a rule spanning two would apply at the wider of
  // them and silently shed early.
  assert.equal(
    new Set(found).size,
    1,
    `"${selector}" mixes rungs ${[...new Set(found)].join(" and ")} in one rule`,
  );
  return found[0]!;
}

const LADDER = new Map<number, [string, string][]>();
for (const [selector, body] of RULES) {
  const rung = rungOf(selector);
  if (rung === null) continue;
  if (!LADDER.has(rung)) LADDER.set(rung, []);
  LADDER.get(rung)!.push([selector, body]);
}

/** The declaration block of the rule whose selector is exactly `selector`. */
function block(selector: string): string {
  const found = RULES.find(([s]) => s === selector);
  assert.ok(found, `\`${selector}\` is no longer a rule in styles.css`);
  return found![1];
}

/** Every individual selector in a rule's selector LIST, which is what the sheet is written as. */
function parts(selector: string): string[] {
  return selector.split(",").map((s) => s.trim());
}

/**
 * A selector with its `:not(...)` groups emptied, which is what the "never hides" scans have to
 * read.
 *
 * The deepest rung is an ALLOWLIST - `> *:not(.badge):not(.detail-title)...` - so the classes
 * it protects appear inside the selector that hides everything else. Scanned raw, that rule
 * reads as "hides `.badge`" and means the exact opposite. Emptying the groups rather than
 * dropping the rule keeps the scans looking at what the selector really matches.
 */
function withoutNot(selector: string): string {
  return selector.replaceAll(/:not\([^()]*\)/g, ":not()");
}

/** The classes a rung's allowlist protects, e.g. `badge` for `:not(.badge)`. */
function allowlisted(selector: string): string[] {
  return [...selector.matchAll(/:not\(\.([\w-]+)\)/g)].map((m) => m[1]!);
}

/** The first rung that hides a control matching `pattern` outright, or Infinity. */
function hiddenAt(pattern: RegExp): number {
  for (const rung of [...LADDER.keys()].sort((a, b) => a - b)) {
    for (const [selector, body] of LADDER.get(rung)!) {
      if (!/display:\s*none/.test(body)) continue;
      if (parts(selector).map(withoutNot).some((part) => pattern.test(part))) return rung;
    }
  }
  return Number.POSITIVE_INFINITY;
}

/** A header with everything on it: reviews waiting, a bindable workflow, full metadata. */
function head(over: Parameters<typeof mkSession>[0] = {}): string {
  const session = mkSession({
    name: "Investigate and plan adding herdr as a new supported multiplexer",
    runtime: "sdk",
    pendingReviews: 2,
    meta: meta(),
    cost: {
      costUsd: 9.01,
      input: 12_000,
      output: 4_000,
      cacheRead: 900_000,
      cacheWrite: 30_000,
      reasoningOutput: 0,
      basis: "api-equivalent",
      pricingModels: ["claude-opus-4-8"],
      pricingVersions: ["2026-01-01"],
      updatedAt: 0,
    },
    ...over,
  });
  const html = renderToStaticMarkup(
    createElement(ConsoleDetail, {
      session,
      view: mkSessionView(session, { onBindWorkflow: () => {} }),
    }),
  );
  // Sliced to the header, so "the markup contains it somewhere" cannot pass for "this row
  // draws it" - the footer and the tab strip carry chips of their own.
  const from = html.indexOf('class="detail-head"');
  assert.notEqual(from, -1, "the console detail no longer draws a `.detail-head`");
  return html.slice(from, html.indexOf('class="detail-tabs"', from));
}

// ---- the identity block: the flex base size that was causing the wrap ----

test("the identity block is measured at zero and floored, not at the title's width", () => {
  const title = block(".detail-title");
  // The reported defect itself. `flex-basis: auto` here means "place this block at the session
  // name's max-content width", which on a long name fills the first line by itself and wraps
  // the entire runtime cluster - before any shrinking runs.
  assert.match(
    title,
    /flex:\s*\d+\s+1\s+0\b/,
    "`.detail-title` is no longer measured at zero for line-breaking. With `flex-basis: auto` " +
      "the block is placed at the TITLE'S max-content width, so a long session name pushes the " +
      "whole runtime cluster onto a second row at every width.",
  );
  // And the other half: with no floor, the name gives up every pixel before the cost chip
  // gives up one. The chips have a ladder for that; the name does not.
  const floor = /min-width:\s*([\d.]+)(ch|px|rem|em)/.exec(title);
  assert.ok(floor, "`.detail-title` has no min-width, so the session's name can vanish entirely");
  assert.ok(
    Number(floor![1]) > 0,
    `\`.detail-title\` has \`${floor![0]}\`, which is no floor at all`,
  );
  // And the two that give the name back the room a zero base size costs it. `flex-grow` shares
  // free space in PROPORTION, so a block growing at 1 beside the spacer's 1 takes exactly half
  // of it - measured at 302px each, with the name ellipsed and the other 302px empty. The block
  // has to outgrow the spacer; the cap is then what hands the surplus back once the name is
  // fully drawn, which is what keeps the runtime cluster against the right edge.
  const grow = /flex:\s*(\d+)\s+1\s+0/.exec(title);
  const spacer = /flex:\s*(\d+)/.exec(block(".detail-head-spacer"));
  assert.ok(grow && spacer, "either `.detail-title` or the spacer stopped declaring a grow factor");
  assert.ok(
    Number(grow![1]) > Number(spacer![1]),
    `\`.detail-title\` grows at ${grow![1]} against the spacer's ${spacer![1]}, so the two ` +
      `SHARE the free space and the session's name is ellipsed beside an empty gap`,
  );
  assert.match(
    title,
    /max-width:\s*max-content/,
    "`.detail-title` is no longer capped at its content, so it swallows the row and pushes the " +
      "chips that belong beside the name across to the far side of it",
  );
});

// ---- the ladder ----

test("every rung the fit can reach exists in the stylesheet, and no rung beyond it does", () => {
  const defined = [...LADDER.keys()].sort((a, b) => a - b);
  assert.deepEqual(
    defined,
    Array.from({ length: DETAIL_HEAD_RUNGS }, (_, i) => i + 1),
    `styles.css defines rungs [${defined.join(", ")}] but detailHeadLadder.ts steps through ` +
      `1..${DETAIL_HEAD_RUNGS}. They have to agree - the fit cannot see what it did not apply.`,
  );
});

test("the row wraps and the runtime cluster in it does not, because the fit reads both", () => {
  // Failure mode 2, in its two halves.
  const row = block(".detail-head");
  assert.match(row, /display:\s*flex/, "`.detail-head` is no longer a flex row");
  assert.match(
    row,
    /flex-wrap:\s*wrap/,
    "`.detail-head` no longer wraps. The measured ladder has nothing to measure: it steps " +
      "down only while the row is taller than its tallest child, so `nowrap` freezes it at " +
      "rung 0 and the row overflows the pane instead.",
  );
  // The subtler half, and the one this row has that the tab strip does not: `.card-runtime`
  // wraps on a board card, where it is a row of its own. Left wrapping HERE it grows the
  // header and the header's tallest child together, so the fit's comparison stays false while
  // the header quietly goes two rows deep.
  assert.match(
    block(".detail-head .card-runtime"),
    /flex-wrap:\s*nowrap/,
    "the runtime cluster wraps inside the header again, which makes the ladder blind to the " +
      "overflow it exists to fix",
  );
});

test("this row is not a query container, and no rung pretends otherwise", () => {
  // The conversation pane's only `container-type` is on `.transcript`, which this row sits
  // ABOVE rather than inside - so a `@container` rule aimed at the header matches nothing and
  // reads exactly like live code.
  assert.doesNotMatch(
    bare,
    /@container\s+detail-head\b/,
    "an `@container detail-head` rule exists, but nothing declares that container - it is dead",
  );
  assert.doesNotMatch(
    block(".detail-head"),
    /container(-type|-name)?:/,
    "`.detail-head` declares a container - either the ladder moved to container queries, " +
      "which cannot work here, or this is containment nothing asked for",
  );
});

test("every rung rule leads with its rung prefix", () => {
  // Without the prefix a rung rule applies at EVERY width and is back to deciding by source
  // order against the base rule it overrides. Same construction, and same reasoning, as the
  // other two ladders'.
  for (const [rung, rules] of LADDER) {
    for (const [selector] of rules) {
      for (const part of selector.split(",")) {
        assert.match(
          part.trim(),
          new RegExp(`^\\.detail-head\\[data-rung~="${rung}"\\]`),
          `"${part.trim()}" is in rung ${rung} but does not lead with the rung prefix, so it ` +
            `applies at every width`,
        );
      }
    }
  }
});

test("a shed word goes visually hidden, never display:none", () => {
  // Failure mode 3, and the line is between hiding a WHOLE control - which the deepest rungs
  // do deliberately, because those controls exist on the board card too - and hiding the WORD
  // off one that stays on screen as its mark. `display: none` on the second leaves a live,
  // clickable glyph with nothing naming it.
  const WORDS =
    /\.runtime-name|\.rt-think-word|\.rt-think-was|\.rt-think-next|\.wbc-word|\.wbc-name|\.wbc-version|\.rt-ctx-num/;
  for (const [rung, rules] of LADDER) {
    for (const [selector, body] of rules) {
      if (!WORDS.test(selector)) continue;
      assert.doesNotMatch(
        body,
        /display:\s*none/,
        `rung ${rung} hides "${selector}" with display:none. A word must be hidden VISUALLY ` +
          `(position: absolute + clip-path) so the control it names keeps its accessible ` +
          `name and its tooltip.`,
      );
      assert.match(
        body,
        /position:\s*absolute[\s\S]*clip-path:\s*inset\(50%\)|clip-path:\s*inset\(50%\)[\s\S]*position:\s*absolute/,
        `rung ${rung}'s "${selector}" does not use the visually-hidden pattern. Without ` +
          `\`position: absolute\` it still costs width and a flex gap; without the clip it ` +
          `is still drawn.`,
      );
    }
  }
  // And the known sheds are present, so this cannot pass by the ladder having quietly stopped
  // collapsing anything. Counted per SELECTOR rather than per rule: the words are shed by two
  // rules carrying eight selectors between them, and a rule count would read as 2 whether the
  // ladder still collapsed all eight or only one.
  const shed = [...LADDER.values()].flat().flatMap(([s]) => parts(s)).filter((p) => WORDS.test(p));
  assert.ok(shed.length >= 6, `only ${shed.length} words left in the ladder`);
});

test("no rung ever hides the review badge, the session's name, or the bind chip", () => {
  // Failure mode 4. The badge is the one control on this row that says an agent has stopped
  // dead waiting on a person, so the ladder may make it smaller and may not take it away. The
  // name is what the pane is about. And the bind chip is the only offer on this row that
  // exists NOWHERE else - the board card draws the mode, effort, model, context and cost
  // chips, which is precisely why the deepest rungs are allowed to hide those.
  const KEPT = [
    [/\.badge(-btn|-attention|-dot)?$/, "the review badge"],
    [/\.detail-title$/, "the session's identity block"],
    [/\.detail-title h2$/, "the session's name"],
    [/\.workflow-bind-chip$/, "the bind chip, which no other surface offers"],
    [/\.wbc-glyph$/, "the bind chip's mark, which is all that is left of it at rung 2"],
    [/\.rt-think-glyph$/, "the effort pill's mark, which is all that is left of it at rung 2"],
    [/\.runtime-glyph$/, "the runtime chip's mark, which is all that is left of it at rung 2"],
  ] as const;
  for (const [rung, rules] of LADDER) {
    for (const [selector, body] of rules) {
      if (!/display:\s*none|clip-path/.test(body)) continue;
      for (const part of parts(selector).map(withoutNot)) {
        for (const [pattern, what] of KEPT) {
          assert.doesNotMatch(part, pattern, `rung ${rung} hides ${what} ("${part}")`);
        }
      }
    }
  }
  // The one thing the badge DOES give up, so rung 1 is not silently doing nothing - and its
  // position is asserted, because the whole ordering rests on the cheapest ink going first.
  const first = (LADDER.get(1) ?? []).map(([s]) => s).join(" ");
  assert.match(first, /\.kb-hint/, "rung 1 no longer sheds the review badge's chord hint");
  assert.match(first, /\.badge-go/, "rung 1 no longer sheds the review badge's arrow");
});

test("the deepest rung is an allowlist, so a chip added later cannot reopen the wrap", () => {
  // The failure this rung exists for, and the reason it is inverted.
  //
  // Rungs 1 to 6 shed what the header ALWAYS draws, which is a fixed set - and a fixed set
  // cannot answer the row this header actually has. The chips between the identity block and
  // the review badge are conditional on the session: a pull request, an Inspector verdict, one
  // workflow chip per repository under review, an ensemble, a pipeline commission, a pipeline
  // link. A conversation carrying several of them spent all six rungs and wrapped anyway,
  // which is this change's own defect arriving through a different door.
  //
  // An ENUMERATION of those chips would close today's doors and leave the next one open: the
  // chip somebody adds to this header next would inherit nothing, and the row would quietly
  // start wrapping again on the sessions that carry it. So the rule is written the other way
  // round, and that shape is what this test pins - not the list.
  const deepest = LADDER.get(DETAIL_HEAD_RUNGS) ?? [];
  const rules = deepest.filter(([, body]) => /display:\s*none/.test(body));
  assert.equal(
    rules.length,
    1,
    `rung ${DETAIL_HEAD_RUNGS} should hide with exactly one rule; it has ${rules.length}`,
  );
  const [selector] = rules[0]!;
  assert.match(
    selector,
    />\s*\*:not\(/,
    `rung ${DETAIL_HEAD_RUNGS} is "${selector}", which enumerates what it hides. It has to ` +
      `hide every child EXCEPT a named few, or the next chip added to this header inherits ` +
      `nothing and the row starts wrapping again on the sessions that carry it.`,
  );

  // And what the allowlist protects. Each of these is either the session's identity or a fixed
  // width, which is what makes the deepest header measure the same on every session.
  const kept = allowlisted(selector);
  for (const [name, why] of [
    ["agent-dot", "the session's agent mark"],
    ["detail-title", "the session's name and objective"],
    ["badge", "the REVIEW BUTTON, which no rung may ever hide"],
    ["workflow-bind-chip", "the bind offer, which no other surface in the app makes"],
    ["si-session-chip", "the standing-instructions mark, a fixed 14px"],
    ["detail-head-spacer", "the zero-width spacer that holds the cluster's edge"],
    [
      "tt-desc",
      "Tooltip's hidden sentence - `display: none` on it takes every explanation in this " +
        "row out of the accessibility tree, so the row fits and stops saying anything",
    ],
  ] as const) {
    assert.ok(
      kept.includes(name),
      `rung ${DETAIL_HEAD_RUNGS} hides \`.${name}\` - ${why}`,
    );
  }

  // Nothing else is protected. A chip that talked its way onto this list would be back to
  // widening the row with the session, which is the whole failure.
  assert.deepEqual(
    kept.filter((name) => !name.startsWith("tt-")).sort(),
    [
      "agent-dot",
      "badge",
      "detail-head-spacer",
      "detail-title",
      "si-session-chip",
      "workflow-bind-chip",
    ],
    "the allowlist grew an entry. Anything kept here is width the deepest header carries on " +
      "some sessions and not others, which is what this rung exists to remove.",
  );
});

test("the pickers only go once the readouts have, and they go last", () => {
  // The order is the design, not an accident of source position: a readout is cheaper to lose
  // than a control that acts on the session. If the mode or effort picker ever sheds before
  // cost, the context meter or the model pill, the row is spending its controls to keep its
  // figures.
  const controls = Math.min(hiddenAt(/\.mode$/), hiddenAt(/\.card-runtime$/));
  assert.ok(
    Number.isFinite(controls),
    "no rung hides the mode and effort pickers, so the deepest header still has nothing left " +
      "to give a pane too narrow for it",
  );
  for (const [pattern, what] of [
    [/\.cost-chip$/, "the cost chip"],
    [/\.rt-ctx$/, "the context meter"],
    [/\.rt-model$/, "the model pill"],
  ] as const) {
    assert.ok(
      hiddenAt(pattern) < controls,
      `${what} is shed at rung ${hiddenAt(pattern)}, at or after the pickers at rung ` +
        `${controls} - readouts go before controls`,
    );
  }
});

test("every control the ladder strips to a mark still draws one, and still says what it is", () => {
  // The visually-hidden word covers it only if a MARK is left behind to click, and only if the
  // control still names itself. Each of these is inside a `Tooltip`, which always renders its
  // sentence into a hidden `aria-describedby` node.
  const html = head();
  for (const [mark, word, what] of [
    ["runtime-glyph", "runtime-name", "the runtime chip"],
    ["rt-think-glyph", "rt-think-word", "the effort picker"],
    ["wbc-glyph", "wbc-word", "the bind chip"],
  ] as const) {
    assert.match(html, new RegExp(word), `${what} lost the span rung 2 collapses`);
    assert.match(html, new RegExp(mark), `${what} has no mark left to draw once its word goes`);
  }
  assert.match(html, /aria-describedby/, "a collapsed chip would have no sentence left");

  // The badge, and the two pieces of it rung 1 takes. `badge-go` is the arrow: without its own
  // element it is a bare text node, which no rule can reach.
  assert.match(html, /badge-btn/, "the review badge is no longer a button on this header");
  assert.match(
    html,
    /badge-go/,
    "the review badge's arrow is not in an element the ladder can shed",
  );

  // And the mode chip is drawn as a button, so rung 6 is hiding a real control rather than a
  // selector that never matched - the claim that justifies it going last.
  assert.match(html, /mode-btn/, "the permission-mode picker left this header");
});

test("one component owns what an effort pill reads, and every host goes through it", () => {
  // Rung 2 sheds `.rt-think-word` and keeps the mark, so the level's own element is load-bearing
  // rather than decorative. Three components draw this pill - the interactive picker,
  // `EffortPicker`'s `EffortChip` fallback for a session it cannot pick for, and
  // `RuntimeMetaRow`'s static spelling - and the rule was written out in all three. It drifted
  // immediately: the fallback was left as a bare text node when the other two were wrapped, a
  // reviewer caught that, and the first fix wrote the same span a third time. `EffortReading` is
  // the owner, and this test is what keeps it the only one.
  //
  // Counted in SOURCE, because "there is one place this is decided" is a fact about the source
  // and cannot be seen in output - three hand-written spans render exactly like three calls to
  // one component, which is why the drift was invisible until someone read the diff.
  const owners = [
    ["src/web/components/EffortPicker.tsx", read("src/web/components/EffortPicker.tsx")],
    ["src/web/components/session-bits.tsx", read("src/web/components/session-bits.tsx")],
  ] as const;
  for (const mark of ["rt-think-word", "rt-think-glyph", "rt-think-next", "rt-think-was"]) {
    const spellings = owners.flatMap(([path, source]) =>
      [...source.matchAll(new RegExp(`className="${mark}"`, "g"))].map(() => path),
    );
    assert.deepEqual(
      spellings,
      ["src/web/components/EffortPicker.tsx"],
      `\`.${mark}\` is written in ${spellings.length} places (${spellings.join(", ")}). ` +
        `\`EffortReading\` owns what an effort pill prints - a second copy is a second thing to ` +
        `remember when the ladder's rung 2 changes what it needs, and forgetting one is the ` +
        `defect a reviewer already had to catch here.`,
    );
  }

  // And the hosts really route through it, on both paths a session can take - a live session
  // reaches the picker, an exited one reaches the fallback, and the static spelling has no
  // session at all. Rendered rather than read, because "this host draws the owner's output" is
  // the half a source count cannot see.
  for (const [what, over] of [
    ["a live session", {}],
    ["a session that cannot be picked for", { state: "exited" as const }],
  ] as const) {
    const html = head({ meta: meta({ thinkingLevel: "high" }), ...over });
    assert.match(
      html,
      /class="rt-think-glyph"/,
      `${what} draws no effort mark, so this case is not being exercised`,
    );
    assert.match(
      html,
      /class="rt-think-word">high</,
      `${what} renders its effort level as a bare text node. Rung 2 sheds \`.rt-think-word\`, ` +
        `so this pill keeps its word at a width where every other one has given it up.`,
    );
  }
});

test("the fit runs after every render, not only on mount", () => {
  // This row's requirement is a function of its CONTENT, and its content is the session: the
  // cost figure ticks, chips appear as a review opens or a pull request lands, and the next
  // session in the rail brings a different name. A mount-only fit is correct exactly until the
  // first server event.
  // Both assertions are anchored to the text AROUND the fit call, which is the correction a
  // reviewer asked for on #890 and it was right: searching the file for a `useLayoutEffect`
  // before the fit is satisfied by any other one in `ConsoleDetail` - and there are several -
  // even with the fit itself sitting in a `useEffect` with a dependency array. A guard that can
  // pass without its claim holding is worse than no guard, because it reads like coverage.
  const CALL = "fitDetailHead(headRef.current)";
  const at = detail.indexOf(CALL);
  assert.notEqual(at, -1, "ConsoleDetail no longer fits its header on render");

  const hook = detail.lastIndexOf("useLayoutEffect(", at);
  assert.notEqual(hook, -1, "the per-render fit is not in a useLayoutEffect, so it lands after paint");
  // Nothing else opens between that hook and the fit, so the hook the search found is the one
  // the fit is actually inside rather than one further up the file.
  assert.doesNotMatch(
    detail.slice(hook + "useLayoutEffect(".length, at),
    /use[A-Z]\w*\(/,
    "the nearest hook before the fit is not the `useLayoutEffect` this test found, so the fit " +
      "is in some other effect",
  );
  // And that effect closes immediately after the fit, with no dependency array between.
  assert.match(
    detail.slice(at + CALL.length),
    /^;\s*\}\);/,
    "the per-render fit grew a dependency array, or something followed it inside the effect - " +
      "it must run after EVERY render",
  );
  assert.match(
    detail,
    /observeDetailHead\(headRef\.current\)/,
    "nothing watches the header for a resize, which is the only signal a render cannot give",
  );
});
