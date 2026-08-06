/**
 * What is at stake: the topbar is the desktop shell's title bar, and its height is
 * published as `--topbar-h` for every full-height surface beneath it. Its only responsive
 * strategy used to be `flex-wrap`, which sheds one control at a time onto ragged extra
 * rows - the bar grew from 110px to 191px between a maximised window and half a screen,
 * and everything under it shrank by however much the bar had chosen to sprawl.
 *
 * The replacement is a five-rung ladder, applied by MEASUREMENT: `fitTopbar` puts the bar at
 * rung 0, asks whether it wrapped, and steps down until it did not, writing the rungs it
 * landed on into `data-rung`. It replaced a `@container topbar (max-width: Npx)` ladder that
 * keyed on the width the bar HAD rather than the width its content NEEDED - two independent
 * quantities, because the pulse is sized by its own text and swings 457px with the fleet.
 *
 * The failure modes are all completely silent - no console, no compile error, and a diff that
 * reads fine:
 *
 * 1. The CSS and `TOPBAR_RUNGS` disagree on how many rungs there are. The fit then either
 *    stops one rung early with room still to give back, or steps onto a rung that does not
 *    exist and reports the bar unfittable.
 * 2. `.topbar` stops wrapping. The fit READS `flex-wrap`, so `nowrap` means it can never
 *    observe a second row, never steps down at all, and the bar silently overflows instead.
 * 3. A rung animates a LAYOUT property in the collapsing direction. While the animation runs
 *    the property still has its old value, so the rung frees nothing on the frame it is
 *    applied: the fit steps straight past it looking for room it had already found, and the
 *    bar flashes two rows before settling several rungs over-collapsed.
 * 4. A rung sheds a label with `display: none`. The bar looks right and every collapsed
 *    control loses its accessible name at the same time, turning a narrow window into a
 *    row of unnamed icons.
 *
 * Driven from source for the reason `topbar-popover-dismiss.test.ts` gives: App sits
 * behind an SSE stream that hangs headless automation, and there is no jsdom here. What a
 * browser has to answer instead - that the bar actually stays on one row, at every width and
 * on every fleet - is `e2e/specs/topbar-one-row.spec.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { TOPBAR_RUNGS } from "../src/web/topbarLadder.ts";

const CSS_PATH = fileURLToPath(new URL("../src/web/styles.css", import.meta.url));
const css = readFileSync(CSS_PATH, "utf8");
const app = readFileSync(fileURLToPath(new URL("../src/web/App.tsx", import.meta.url)), "utf8");

/** Comments discuss `display: none` and rung numbers in prose, so they go first. */
const bare = css.replace(/\/\*[\s\S]*?\*\//g, " ");

/** Every `[selector, body]` pair in the sheet. The ladder is flat now, so this reads it. */
const RULES: [string, string][] = [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
  ([, s = "", b = ""]) => [s.trim().replace(/\s+/g, " "), b],
);

/** The token a rung's selector carries, e.g. 3 for `.topbar[data-rung~="3"] .filter-input`. */
function rungOf(selector: string): number | null {
  const found = [...selector.matchAll(/\.topbar\[data-rung~="(\d+)"\]/g)].map((m) => Number(m[1]));
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

/** The ladder: every rule keyed on a rung, grouped by rung number. */
const LADDER = new Map<number, [string, string][]>();
for (const [selector, body] of RULES) {
  const rung = rungOf(selector);
  if (rung === null) continue;
  if (!LADDER.has(rung)) LADDER.set(rung, []);
  LADDER.get(rung)!.push([selector, body]);
}

test("every rung the fit can reach exists in the stylesheet, and no rung beyond it does", () => {
  // Failure mode 1, in both directions. `fitTopbar` counts to TOPBAR_RUNGS and the sheet has
  // to mean the same thing by that number: a rung it never reaches is dead ink the bar could
  // have spent, and a number past the last rung is a step that frees nothing while the fit
  // reports the bar unfittable.
  const defined = [...LADDER.keys()].sort((a, b) => a - b);
  assert.deepEqual(
    defined,
    Array.from({ length: TOPBAR_RUNGS }, (_, i) => i + 1),
    `styles.css defines rungs [${defined.join(", ")}] but topbarLadder.ts steps through ` +
      `1..${TOPBAR_RUNGS}. They have to agree - the fit cannot see what it did not apply.`,
  );
});

test("the bar still wraps, because the fit reads wrapping as its signal", () => {
  // Failure mode 2, and the most tempting edit in the file: with a ladder in place `nowrap`
  // reads like the tidy way to state "this bar is one row". It is the one value that makes
  // the ladder inert - `fitTopbar` measures the bar's laid-out height against its tallest
  // child, so with nowrap it observes one row at every width, never steps down, and the bar
  // overflows its container instead of wrapping under it.
  const topbar = bare.slice(bare.indexOf(".topbar {"));
  const block = topbar.slice(0, topbar.indexOf("}"));
  assert.match(
    block,
    /flex-wrap:\s*wrap/,
    "`.topbar` no longer wraps. The measured ladder has nothing to measure: it steps down " +
      "only while the bar is taller than one row, so `nowrap` freezes it at rung 0.",
  );
  assert.match(block, /display:\s*flex/, "`.topbar` is no longer a flex row");
});

test("the retired container query is gone, not merely unused", () => {
  // `.topbar` no longer declares a container, so any `@container topbar` rule left behind is
  // dead - it matches nothing, reports nothing, and reads exactly like live code.
  assert.doesNotMatch(
    bare,
    /@container\s+topbar\b/,
    "an `@container topbar` rule survives, but `.topbar` declares no container - it is dead",
  );
  const topbar = bare.slice(bare.indexOf(".topbar {"));
  assert.doesNotMatch(
    topbar.slice(0, topbar.indexOf("}")),
    /container(-type|-name)?:/,
    "`.topbar` declares a container again - either the ladder moved back to container " +
      "queries, or this is containment nothing asked for",
  );
});

test("no rung animates a layout property in the direction it collapses", () => {
  // Failure mode 3, and it cost a full debugging pass: `.filter-input` collapsed with
  // `transition: width 0.16s`, so on the frame rung 3 was applied the field was still 150px
  // to layout. The fit measured a bar that was still wrapped, walked past rung 3 to rungs 4
  // and 5, and the bar flashed two rows for the length of the animation before settling
  // over-collapsed. The transition now lives on the OPEN state, which is driven by focus and
  // never measured across.
  const LAYOUT = /\b(width|height|padding|margin|font-size|gap|flex-basis|inset)\b/;
  for (const [selector, body] of LADDER.get(3) ?? []) {
    // The open states are the exception, and they are exactly the ones that re-widen it.
    if (/:focus-within|:not\(:placeholder-shown\)/.test(selector)) continue;
    const transition = /transition:\s*([^;]*)/.exec(body)?.[1] ?? "";
    assert.doesNotMatch(
      transition,
      LAYOUT,
      `"${selector}" animates a layout property while collapsing. The rung then frees ` +
        `nothing on the frame it is applied, and fitTopbar steps past it.`,
    );
  }
  // And the open state does keep its animation, so this test cannot pass by the transition
  // having simply been deleted.
  const open = (LADDER.get(3) ?? []).find(([s]) => /:focus-within/.test(s));
  assert.ok(open, "the filter's focus-driven open state is gone");
  assert.match(open[1], /transition:[^;]*width/, "the filter no longer animates back open");
});

test("every rung rule leads with its rung prefix", () => {
  // The `@container` ladder contributed NO specificity, so between an identical selector
  // inside a rung and one outside it, source order alone decided - and a base rule authored
  // below the ladder silently won. That is what `.filter-input { width }` did during
  // development: the pulse collapsed and the filter did not.
  //
  // The `.topbar[data-rung~="N"]` prefix ends that whole class of bug, and this is the check
  // that the construction holds. A rung rule that lost its prefix is two failures at once: it
  // applies at every width, and it is back to deciding by source order.
  //
  // There is deliberately no source-order assertion beside this one. The prefix adds a class
  // and an attribute selector to every rung rule, so a rung always outranks the bare base rule
  // it overrides - `.topbar[data-rung~="3"] .filter-input` is (0,3,0) against `.filter-input`
  // at (0,1,0) - and it wins wherever either is authored. Pinning the base rules above the
  // ladder would only pin the current file layout: a reorder for readability would fail with a
  // message claiming a cascade bug that the specificity rules make impossible.
  //
  // What is left unguarded by that reasoning is a FUTURE base rule that is itself at least as
  // specific, and no regex over source text settles that - it depends on which elements two
  // selectors can both match. `e2e/specs/topbar-one-row.spec.ts` settles it instead, in the
  // only place it can be settled. Its first case is the one that bites: at the reported width
  // it asserts the bar is on one row, that the search is NOT drawn, and that the page
  // segment's and pulse's words ARE. An overridden rung 3 fails it twice over - the field is
  // still 150px wide, and the bar it was supposed to fit is still on two rows.
  //
  // Note it is that case rather than the width sweep in the same file. The sweep excuses a bar
  // that has spent every rung, so a rung silently doing nothing would just push the fit one
  // rung further down and slip through it.
  for (const [rung, rules] of LADDER) {
    for (const [selector] of rules) {
      for (const part of selector.split(",")) {
        assert.match(
          part.trim(),
          new RegExp(`^\\.topbar\\[data-rung~="${rung}"\\]`),
          `"${part.trim()}" is in rung ${rung} but does not lead with the rung prefix, so it ` +
            `applies at every width`,
        );
      }
    }
  }
});

test("a shed label goes visually hidden, never display:none", () => {
  // Failure mode 4. The line is between hiding a WHOLE control (or region) and hiding the
  // NAME off one that stays on screen. `display: none` on the brand wordmark, the keycap,
  // Foreman's mode chip or the entire pulse takes the pixels and the accessible node
  // together, and leaves nothing behind that a reader could meet unlabelled. `display: none`
  // on a `.tb-label` leaves a live, clickable glyph with no name at all - which is the whole
  // failure mode the ladder is written to avoid, and the one invisible in a screenshot.
  const LABELS = /\.tb-label|\.pulse-link-label/;
  for (const [rung, rules] of LADDER) {
    for (const [selector, body] of rules) {
      if (!LABELS.test(selector)) continue;
      assert.doesNotMatch(
        body,
        /display:\s*none/,
        `rung ${rung} hides "${selector}" with display:none. A label must be hidden VISUALLY ` +
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
  // And at least the three known label sheds are present, so the test cannot pass by the
  // ladder having quietly stopped collapsing anything.
  const shed = [...LADDER.values()].flat().filter(([s]) => LABELS.test(s));
  assert.ok(shed.length >= 3, `only ${shed.length} label rules left in the ladder`);
});

test("a disconnected pulse keeps its stale figures and review control visible", () => {
  assert.match(
    bare,
    /\.pulse\.is-down \.pulse-seg:not\(\.pulse-link\)\s*\{[^}]*opacity:\s*0\.5/,
    "the disconnected pulse no longer dims its stale figures",
  );
  for (const [rung, rules] of LADDER) {
    for (const [selector, body] of rules) {
      const hidesSegment = selector
        .split(",")
        .some((part) => /\.pulse\.is-down \.pulse-seg:not\(\.pulse-link\)\s*$/.test(part.trim()));
      if (!hidesSegment) continue;
      assert.doesNotMatch(
        body,
        /display:\s*none/,
        `rung ${rung} removes the disconnected pulse's figures and review control`,
      );
    }
  }
});

test("filter compaction keeps both interactive pulse controls visible", () => {
  // The pulse now carries TWO controls: the leading live/Keep-awake trigger
  // (`.pulse-link`, a button since the Keep Awake feature) and the trailing reviews
  // control (`.pulse-btn`). An active filter may take the count readouts, but it must
  // not make the bar's only route to reviews - or its only route to Keep awake -
  // unreachable. What survives is one compact pill: the live segment leading, the
  // reviews control trailing, and the hairline the review button inherits from its
  // hidden siblings as the divider between them.
  const rules = (LADDER.get(3) ?? []).flatMap(([selectors, body]) =>
    selectors.split(",").map((selector) => ({ selector: selector.trim(), body })),
  );
  assert.ok(rules.length > 0, "the filter rung is gone");

  const readoutSelectors = rules.filter(({ selector }) =>
    /\.pulse-seg:not\(\.pulse-btn\):not\(\.pulse-link\)$/.test(selector),
  );
  assert.equal(readoutSelectors.length, 2, "filter compaction must cover focus and a held term");
  for (const { body } of readoutSelectors) assert.match(body, /display:\s*none/);

  // No rung-3 rule may hide the pulse itself or either interactive segment. (The
  // `.pulse-btn .pulse-dot` rules end with `.pulse-dot`, so they pass this sweep.)
  for (const { selector, body } of rules) {
    if (!/display:\s*none/.test(body)) continue;
    assert.doesNotMatch(selector, /\.pulse$/, "filter compaction hides the entire pulse");
    assert.doesNotMatch(
      selector,
      /\.pulse-link$/,
      "filter compaction hides the live/Keep-awake trigger",
    );
    assert.doesNotMatch(selector, /\.pulse-btn$/, "filter compaction hides the review control");
  }

  const buttonSelectors = rules.filter(({ selector }) => /\.pulse-btn$/.test(selector));
  assert.equal(buttonSelectors.length, 2, "the review control must survive both filter states");
  for (const { body } of buttonSelectors) {
    assert.match(body, /padding:\s*0 9px/);
    assert.doesNotMatch(body, /display:\s*none/);
    // The divider between the two surviving controls is the hairline the review button
    // inherits from `.pulse-seg + .pulse-seg` even while its siblings are hidden. A
    // compaction that cancels it fuses the live trigger and the review count into one
    // unreadable pill.
    assert.doesNotMatch(body, /border-left:\s*none/);
  }

  // The empty-wrapper HIDE is GONE, not merely relaxed: with the live control leading,
  // the pulse is never empty, and a resurrected `.pulse:not(:has(.pulse-btn))` hide
  // would take the Keep awake control off screen with it. Anchored at the subject and
  // gated on display so the sole-survivor ROUNDING rule below does not trip it.
  const emptyPulseSelectors = rules.filter(
    ({ selector, body }) =>
      /\.pulse:not\(:has\(\.pulse-btn\)\)$/.test(selector) && /display:\s*none/.test(body),
  );
  assert.deepEqual(
    emptyPulseSelectors.map(({ selector }) => selector),
    [],
    "the empty-pulse hide is back, and it would take the Keep awake control off screen",
  );

  // And when no reviews control exists (empty inbox - the common fleet), the surviving
  // live trigger takes the full rounding the review button used to take as sole
  // survivor: its leading-edge-only radius would otherwise draw a square trailing
  // corner on hover inside the pulse's fully rounded pill.
  const soleSurvivor = rules.filter(({ selector }) =>
    /\.pulse:not\(:has\(\.pulse-btn\)\) \.pulse-link$/.test(selector),
  );
  assert.equal(
    soleSurvivor.length,
    2,
    "the lone live trigger must regain full rounding for focus and a held term",
  );
  for (const { body } of soleSurvivor) assert.match(body, /border-radius:\s*999px/);
});

test("Dispatch never degrades, and the labels that do are marked", () => {
  const bar = app.slice(app.indexOf('<div className="topbar-actions">'));
  const cluster = bar.slice(0, bar.indexOf("</header>"));
  const dispatch = cluster.slice(cluster.indexOf('className="dispatch-btn"'));
  assert.doesNotMatch(
    dispatch.slice(0, dispatch.indexOf("</button>")),
    /tb-label/,
    "Dispatch took a `.tb-label` - the primary action must keep its word at every width",
  );
  // The ones that DO shed, so a rung has something to act on.
  const at = cluster.indexOf("missions-btn");
  assert.notEqual(at, -1, "missions-btn is gone from the action cluster");
  assert.match(
    cluster.slice(at, cluster.indexOf("</button>", at)),
    /tb-label/,
    "missions-btn lost its `.tb-label`, so the ladder can no longer collapse it",
  );
  // The page segment sheds too, and it lives at the LEFT of the bar rather than in the
  // action cluster - so it is read from the whole topbar.
  const seg = app.slice(app.indexOf('<nav className="page-seg"'));
  assert.match(
    seg.slice(0, seg.indexOf("</nav>")),
    /tb-label/,
    "the page segment lost its `.tb-label`, so the ladder can no longer collapse it",
  );
});

test("the cost chip survives every rung; only its duplicated rate is shed", () => {
  // The chip is now the ONLY cost surface in the app's chrome - the row it replaced could
  // afford to fold away because folding left the figure beside the toggle, and there is no
  // toggle any more. A rung that hid it would take the fleet's economics off screen
  // entirely on a narrow window, silently.
  for (const [rung, rules] of LADDER) {
    for (const [selector, body] of rules) {
      const hidesChip = selector
        .split(",")
        .some((part) => /\.spend-chip(-wrap)?$/.test(part.trim()));
      if (!hidesChip) continue;
      assert.doesNotMatch(body, /display:\s*none/, `rung ${rung} hides the cost chip itself`);
    }
  }
  // And the one segment that IS shed is still shed, so the bar has something to give back.
  const shed = [...LADDER.values()]
    .flat()
    .filter(([sel, body]) => sel.trim().endsWith(".spend-chip-rate") && /display:\s*none/.test(body));
  assert.equal(shed.length, 1, "the chip's rate segment no longer collapses with the bar");
});

test("a control that keeps only a glyph still says what it is", () => {
  // Every button the ladder strips to an icon has to carry its own name - the visually
  // hidden label covers the ones that have one, an `aria-label` covers the rest.
  const bar = app.slice(app.indexOf('<div className="topbar-actions">'));
  const cluster = bar.slice(0, bar.indexOf("</header>"));
  const missions = cluster.indexOf("missions-btn");
  assert.match(
    cluster.slice(missions, cluster.indexOf("</button>", missions)),
    /aria-label=/,
    "missions-btn is drawn as a bare glyph on narrow windows and has no aria-label",
  );
  // The page segment takes the other route: its `.tb-label` IS its accessible name, and the
  // rung hides it visually rather than removing it, so Fleet, Library and Runs survive the
  // collapse. That is checked by the `display: none` sweep above, which is what makes this
  // the safe option rather than the lazy one - an `aria-label` here would be a second name
  // beside the visible word, and the two would drift.
  const seg = app.slice(app.indexOf('<nav className="page-seg"'));
  const segMarkup = seg.slice(0, seg.indexOf("</nav>"));
  assert.match(segMarkup, /aria-label="Pages"/, "the segment is a landmark and must be named");
  assert.match(segMarkup, /aria-current/, "the segment must say which page you are on");
  const foreman = readFileSync(
    fileURLToPath(new URL("../src/web/components/ForemanBar.tsx", import.meta.url)),
    "utf8",
  );
  // Located by the className EXPRESSION rather than by the literal `foreman-btn$`. That
  // string does match today - the class sits in a template literal, so an interpolation's
  // `$` really does follow it - but it matches by coincidence of the neighbouring syntax,
  // and rewriting the same className any other way would leave this slicing from -1.
  const at = foreman.search(/className=\{[^}]*foreman-btn/);
  assert.notEqual(at, -1, "the Foreman button's className expression is gone");
  const btn = foreman.slice(at, foreman.indexOf("</button>", at));
  assert.notEqual(btn.length, 0, "no button markup followed the className - check the slice");
  assert.match(
    btn,
    /aria-label=/,
    "Foreman's word is a `.tb-label` the ladder takes away; the button needs its own name",
  );
});

test("the pulse opts out of the desktop drag region, because the last rung takes its words", () => {
  // This belongs to the LADDER, not to the generic drag-region sweep, which is why it lives
  // here rather than in `desktop-drag-region.test.ts`. That file scans for layers painted
  // OVER the bar - `position: fixed`, or a `z-index` above the bar's 10 - and skips
  // everything else outright (`if (!floats) continue`). `.pulse` is a normal in-flow child of
  // the draggable `.topbar` itself, so it does not match there and never will.
  //
  // What makes the rule load bearing is the last rung. Four of the pulse's five segments are
  // divs, and that rung draws them as a dot and a figure with the word taken away - so the
  // tooltip becomes the only place a bare "3" still says "need you". A drag region swallows
  // the mouse entirely: a hover inside one never reaches the renderer, so that tooltip would
  // simply never appear, at exactly the widths where it is the only thing carrying the
  // meaning. Both halves are asserted, because it is the pair that states the hazard - a rung
  // that stopped shedding, or a no-drag rule that went away, each make this comment a lie.
  const sheds = (LADDER.get(TOPBAR_RUNGS) ?? []).some(([selector]) =>
    selector.split(",").some((part) => /\.pulse\b.*\.tb-label\s*$/.test(part.trim())),
  );
  assert.ok(
    sheds,
    `rung ${TOPBAR_RUNGS} no longer sheds the pulse's words, so this test is guarding the ` +
      `wrong rung - find where the words go now and re-anchor it`,
  );

  const optedOut = RULES.some(
    ([selectors, body]) =>
      /-webkit-app-region:\s*no-drag/.test(body) &&
      selectors.split(",").some((s) => /\.is-desktop \.topbar \.pulse\s*$/.test(s.trim())),
  );
  assert.ok(
    optedOut,
    "`.is-desktop .topbar .pulse` is not in the no-drag list, so in the desktop shell the OS " +
      `swallows every hover on the pulse - and with rung ${TOPBAR_RUNGS} drawing its segments ` +
      "as bare figures, the tooltip it kills is the only thing naming them",
  );
});

test("the fit runs after every render, not only on mount", () => {
  // The bar's requirement is a function of its CONTENT, and its content is the fleet: one
  // session arriving adds a ~150px pulse segment to a bar that may have had 40px to spare.
  // A mount-only fit would be correct exactly until the first server event. `useLayoutEffect`
  // rather than `useEffect` so it lands before paint - and with no dependency array, which is
  // what makes it "every render".
  const at = app.indexOf("fitTopbar(topbarRef.current)");
  assert.notEqual(at, -1, "App no longer fits the topbar on render");
  const effect = app.lastIndexOf("useLayoutEffect", at);
  assert.notEqual(effect, -1, "the per-render fit is not in a useLayoutEffect");
  assert.match(
    app.slice(at, app.indexOf("\n\n", at)),
    /\}\);/,
    "the per-render fit grew a dependency array - it must run after EVERY render",
  );
});
