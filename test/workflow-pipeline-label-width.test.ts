/**
 * What is at stake: on a workflow run, every card in the pipeline puts a status chip next to a
 * label. The chip is `flex: none` and carries a whole phrase - "Changes requested" is 120px of a
 * 176px terminus - so on a single line it takes its width out of the label beside it. With the
 * label also declaring `overflow-wrap: anywhere`, its min-content width was ONE CHARACTER, and
 * flexbox happily shrank it that far: an operator's run drew "Session" as a 105px vertical
 * column, one letter per line, and "Intent Conformance Judge" broke mid-word as "Conforma/nce".
 *
 * Two declarations prevent that, and this file pins both:
 *
 * 1. Every container that renders a chip beside a label is a grid that assigns the chip its own
 *    row. A chip on its own row costs one row of height; a chip that stays on the label's line
 *    costs the label its width.
 * 2. No pipeline label declares `overflow-wrap: anywhere`. `break-word` breaks the same words
 *    that genuinely cannot fit, without also reporting a one-character min-content width for a
 *    sibling or a track to shrink into - which is the floor that turned a tight fit into a
 *    vertical column rather than a wrap. (This is the opposite call from `.ensemble-detail`,
 *    which wants `anywhere` so nothing can size a column - see `ensemble-text-overflow.test.ts`.
 *    The difference is that a pipeline card's width is fixed by the stylesheet, so the label has
 *    no column to widen and nothing to gain from breaking mid-word.)
 *
 * Assertion 3 is what keeps 1 honest: the chip's render sites are counted in `pipeline-bits.tsx`,
 * so a fourth leaf that grows one cannot quietly skip the escape the other three declare.
 *
 * The limit of what this can prove: these assertions read DECLARATIONS. Nothing here lays out a
 * card, so a rule that parses as sound and still renders wrong is outside their reach.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../src/web/styles.css", import.meta.url)), "utf8");
const source = readFileSync(
  fileURLToPath(new URL("../src/web/workflows/pipeline-bits.tsx", import.meta.url)),
  "utf8",
);

/** Comments discuss these properties in prose, so they go before anything is parsed. */
const bare = css.replace(/\/\*[\s\S]*?\*\//g, " ");

interface Rule {
  selectors: string[];
  body: string;
}

/** styles.css has no preprocessor and no nesting, so one flat pass is exact. */
function rules(cssSource: string): Rule[] {
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(cssSource))) {
    const selectors = (match[1] ?? "")
      .split(",")
      .map((selector) => selector.trim().replace(/\s+/g, " "))
      .filter(Boolean);
    if (selectors.length > 0) out.push({ selectors, body: match[2] ?? "" });
  }
  return out;
}

const ALL = rules(bare);

function declaration(rule: Rule, property: string): string | null {
  const found = new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]+)`, "i").exec(rule.body);
  return found ? (found[1] ?? "").trim() : null;
}

/**
 * The class tokens of a selector's SUBJECT - the compound after the last combinator, which is the
 * element the rule styles. `.wf-pipeline-terminus .wf-pipeline-status` is a rule about the chip.
 */
function subjectClasses(selector: string): string[] {
  const subject = selector.split(/\s+|>|\+|~/).filter(Boolean).pop() ?? "";
  return [...subject.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]!);
}

function rulesFor(cls: string): Rule[] {
  return ALL.filter((rule) => rule.selectors.some((s) => subjectClasses(s).includes(cls)));
}

function declaredOn(cls: string, property: string): string[] {
  return rulesFor(cls)
    .map((rule) => declaration(rule, property))
    .filter((value): value is string => value !== null);
}

/**
 * The containers `pipeline-bits.tsx` renders a `PipelineStatusChip` into, as a sibling of the
 * label. Assertion 3 pins the count, so this list cannot silently fall behind the component.
 */
const CHIP_CONTAINERS = [
  "wf-pipeline-terminus",
  "wf-pipeline-reviewer",
  "wf-pipeline-stage-head",
  // The fixed Inspector footer. It carries the longest label of the four - a whole sentence
  // about what the gate is waiting on - so it is the container that most needed the escape.
  "wf-pipeline-inspector",
];

/**
 * The escape: the container is a grid that gives the chip its own explicit column, so the chip
 * auto-places onto a row of its own instead of into the label's track.
 *
 * `flex-wrap: wrap` is deliberately NOT accepted, though it looks like it should be. It is only
 * an escape when the label contributes its width to line-breaking, and a label sized `flex: 1`
 * has `flex-basis: 0` - it contributes nothing, every chip "fits", and the wrap never fires.
 * `.wf-pipeline-stage-head` was written that way and was still broken; a check that accepted
 * `flex-wrap` would have called it fixed. Grid placement is unconditional, so it cannot lie.
 */
function chipCanLeaveTheLabelsLine(cls: string): boolean {
  const isGrid = declaredOn(cls, "display").some((value) => value === "grid");
  const placesChip = ALL.some(
    (rule) =>
      rule.selectors.some(
        (s) => s.includes(`.${cls}`) && subjectClasses(s).includes("wf-pipeline-status"),
      ) && declaration(rule, "grid-column") !== null,
  );
  return isGrid && placesChip;
}

test("a pipeline status chip never takes its width out of the label beside it", () => {
  const trapped = CHIP_CONTAINERS.filter((cls) => !chipCanLeaveTheLabelsLine(cls));
  assert.deepEqual(
    trapped,
    [],
    "The chip is `flex: none` and as wide as its longest phrase, so on a shared line it shrinks " +
      "the label instead of itself - which is how a run drew `Session` one letter per line. " +
      "Make each of these a grid that assigns `.wf-pipeline-status` its own `grid-column`; see " +
      "this file's header for why `flex-wrap: wrap` is not accepted as a substitute. Offenders: " +
      trapped.join(", "),
  );
});

test("no pipeline label reports a one-character min-content width", () => {
  const offenders = ALL.flatMap((rule) => {
    const subjects = rule.selectors.filter((s) =>
      subjectClasses(s).some((cls) => cls.startsWith("wf-pipeline-")),
    );
    if (subjects.length === 0) return [];
    return declaration(rule, "overflow-wrap") === "anywhere" ? [subjects.join(", ")] : [];
  });
  assert.deepEqual(
    offenders,
    [],
    "`overflow-wrap: anywhere` lets a flex sibling shrink these labels to a single character. " +
      "A pipeline card has a width the stylesheet fixed, so the label has no column to widen " +
      "and `break-word` breaks the same over-long words without offering that floor. Offenders: " +
      offenders.join(", "),
  );
});

/**
 * Giving the chip its own row moved the terminus from one row to two, and the diamond has to
 * stay centred against the whole card rather than against the label row.
 *
 * The trap this pins is `grid-row: 1 / -1`, which reads as "span every row" and does not:
 * `-1` counts back from the last line of the EXPLICIT grid, and the chip's row is implicit, so
 * it resolves to row 1 alone. It shipped that way once and left the diamond 14.5px high.
 */
test("the terminus diamond spans the chip's row rather than floating above centre", () => {
  const markRules = rulesFor("wf-pipeline-terminus-mark");

  const trap = markRules
    .filter((rule) => /\/\s*-1\s*$/.test(declaration(rule, "grid-row") ?? ""))
    .flatMap((rule) => rule.selectors);
  assert.deepEqual(
    trap,
    [],
    "`grid-row: <n> / -1` does not span an implicit row - `-1` is the last line of the " +
      "EXPLICIT grid, and `.wf-pipeline-terminus` declares no `grid-template-rows`. Use an " +
      "explicit `span`. Offenders: " + trap.join(", "),
  );

  // The span has to be scoped to the cards that HAVE a chip: spanning unconditionally adds an
  // empty second track to the editor's chipless terminus, which `row-gap` then makes 6px taller.
  const scopedSpan = markRules.some(
    (rule) =>
      /\bspan\b/.test(declaration(rule, "grid-row") ?? "")
      && rule.selectors.some((s) => s.includes(":has(.wf-pipeline-status)")),
  );
  assert.ok(
    scopedSpan,
    "`.wf-pipeline-terminus-mark` needs a `grid-row` span scoped by " +
      "`:has(.wf-pipeline-status)`, so the diamond spans the chip's row on a run and the " +
      "chipless terminus in the editor keeps its single-row height.",
  );
});

test("every chip render site is one of the containers the escape was checked on", () => {
  const renderSites = [...source.matchAll(/<PipelineStatusChip\b/g)].length;
  assert.equal(
    renderSites,
    CHIP_CONTAINERS.length,
    "`pipeline-bits.tsx` renders " + renderSites + " status chips but only " +
      CHIP_CONTAINERS.length + " containers are checked above. Add the new leaf's container " +
      "class to CHIP_CONTAINERS so its label is held to the same rule.",
  );
});

/**
 * Every card the strip lays out side by side, and the one property that keeps each of them the
 * width it declares.
 *
 * `.wf-pipeline-strip` is a flex row whose content is routinely wider than the pane - that is
 * what its `overflow-x: auto` is for - and flex-shrink runs BEFORE overflow ever scrolls. So a
 * card with a `width` and no `flex: none` does not get the width it asked for; it collapses
 * toward min-content while its own grid, sized `minmax(0, 1fr)`, lets the text spill out past
 * the border. The Inspector footer was the one card missing it, and because it is the only one
 * that draws a visible dashed edge, the collapse showed up as a ~40px sliver with the sentence
 * printed beside it rather than inside it.
 *
 * Only visible on a pipeline long enough to overflow, which is why four stages had to ship
 * before anyone saw it. This asserts the property directly so the next card cannot inherit the
 * same gap.
 */
const STRIP_CARDS = [
  "wf-pipeline-stage",
  "wf-pipeline-terminus",
  "wf-pipeline-inspector",
];

test("no card in the pipeline strip can be shrunk below the width it declares", () => {
  const offenders = STRIP_CARDS.filter((cls) => {
    const declaresWidth = declaredOn(cls, "width").length > 0;
    const holds = declaredOn(cls, "flex").some((value) => /^none\b/.test(value))
      || declaredOn(cls, "flex-shrink").some((value) => value.trim() === "0");
    return declaresWidth && !holds;
  });
  assert.deepEqual(
    offenders,
    [],
    "A strip card declares a `width` but nothing stopping flex from shrinking it. The strip "
      + "scrolls rather than reflows, so the card has to keep its declared width: add "
      + "`flex: none`. Offenders: " + offenders.join(", "),
  );
});
