import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LineStrip } from "../src/web/components/LineStrip.tsx";
import { LINE_STAGES, type LineStageSummary, type LineSummary } from "../src/shared/line.ts";
import { tooltipLabels } from "./helpers/markup.ts";

// What is at stake: the strip's markup shape, which is the half a browser test cannot pin
// cheaply and a person reading the page cannot see at all.
//
// Three things live here. The stage buttons' ACCESSIBLE NAMES, because the visible strip is
// a number under a heading - unambiguous with six of them side by side, and meaningless read
// aloud one at a time ("Review, 5"). The FIXED SHAPE across every state, because the strip
// sits directly above the board and a stage that dropped its second line when it had nothing
// to say would step every card underneath it. And VERSION SKEW in both directions, since the
// daemon is a separate process and this payload is append-only: a stage this build has never
// heard of must be ignored, and one the daemon has not sent must still draw.
//
// createElement, not JSX, because the runner's glob only matches .test.ts.

const stage = (over: Partial<LineStageSummary> & { stage: LineStageSummary["stage"] }): LineStageSummary => ({
  count: 0,
  sentence: "",
  tone: "neutral",
  ...over,
});

const full: LineSummary = {
  stages: [
    stage({ stage: "intake", count: 2, sentence: "github-issues swept 4m ago", tone: "idle" }),
    stage({ stage: "backlog", count: 4, sentence: "next up: Fix pane focus stealing", tone: "idle" }),
    stage({ stage: "working", count: 5, sentence: "1 needs you · 4 working", tone: "attention" }),
    stage({ stage: "review", count: 5, sentence: "No-Mistakes Review v8 ×4", tone: "working" }),
    stage({ stage: "decide", count: 1, sentence: "Best of N · waiting on you", tone: "attention" }),
    stage({ stage: "shipped", count: 3, sentence: "this week · ≈$4.05 per PR today", tone: "idle" }),
  ],
};

const render = (summary: LineSummary | null): string =>
  renderToStaticMarkup(createElement(LineStrip, { summary, onStage: () => {} }));

test("every stage is a button whose name says the stage, the figure and what it means", () => {
  const html = render(full);
  // The figure needs a noun or it is a bare number: "Review, 5" is not a fact.
  assert.match(html, /aria-label="Review, 5 runs live - No-Mistakes Review v8 ×4"/);
  assert.match(html, /aria-label="Working, 5 sessions - 1 needs you, 4 working"/);
  assert.match(html, /aria-label="Shipped, 3 pull requests this week/);
  // Singular is not a detail here: "1 ensembles" is the kind of thing that makes a person
  // stop trusting a surface. The trailing " - " is what distinguishes it from the plural.
  assert.match(html, /aria-label="Decide, 1 ensemble - Best of N/);
});

test("the sentence's separators become commas in the accessible name", () => {
  // A screen reader either announces the middle dot or swallows it. Neither produces the
  // pause a sighted reader gets for free.
  const html = render(full);
  assert.match(html, /Best of N, waiting on you"/);
  assert.doesNotMatch(html, /aria-label="[^"]*·/);
});

test("the visible sentence keeps its own typography", () => {
  // The dots are the visual rhythm of the strip; only the ARIA copy is rewritten.
  assert.match(render(full), /class="ls-sub">1 needs you · 4 working</);
});

test("a stage the daemon flagged carries its tone to the markup", () => {
  const html = render(full);
  assert.match(html, /class="line-stage tone-attention" aria-label="Working/);
  assert.match(html, /class="line-stage tone-working" aria-label="Review/);
  assert.match(html, /class="line-stage tone-idle" aria-label="Shipped/);
});

test("the wire into an amber stage is lit, and the others are not", () => {
  // Derived from the two stages either side, which is the ONLY derivation this component
  // is allowed: it is a fact about the drawing, not about the fleet.
  const html = render(full);
  const wires = [...html.matchAll(/class="(line-wire[^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(wires, [
    "line-wire", // intake -> backlog
    "line-wire hot", // backlog -> working, which is amber
    "line-wire", // working -> review
    "line-wire hot", // review -> decide, which is amber
    "line-wire", // decide -> shipped
  ]);
});

test("the wires are decoration and say nothing to a screen reader", () => {
  // Six announced graphics between six buttons would triple the length of the strip read
  // aloud, for information the stages either side already carry.
  const wires = [...render(full).matchAll(/<span class="line-wire[^"]*"[^>]*>/g)].map((m) => m[0]);
  assert.equal(wires.length, 5);
  for (const wire of wires) assert.match(wire, /aria-hidden/);
});

test("a strip with nothing to say still draws six stages and both of their lines", () => {
  // The empty `ls-sub` is the point: it reserves the second line, so the strip is the same
  // height on a silent fleet as on a busy one.
  const html = render(null);
  assert.equal([...html.matchAll(/class="line-stage/g)].length, LINE_STAGES.length);
  assert.equal([...html.matchAll(/class="ls-sub"/g)].length, LINE_STAGES.length);
  assert.match(html, /aria-label="Intake, 0 sources and missions"/);
});

test("a daemon that has not heard of a stage leaves it blank rather than absent", () => {
  const partial: LineSummary = { stages: [full.stages[3]!] };
  const html = render(partial);
  assert.equal([...html.matchAll(/class="line-stage/g)].length, LINE_STAGES.length);
  assert.match(html, /aria-label="Review, 5 runs live/);
  assert.match(html, /aria-label="Backlog, 0 tasks waiting"/);
});

test("a daemon that has grown a seventh stage does not draw an unlabelled hole", () => {
  // The payload is append-only, so a newer daemon CAN send a stage this build cannot name.
  // Rendering it from its own id would put a raw wire value on screen.
  const skewed = {
    stages: [...full.stages, { stage: "archived", count: 9, sentence: "from the future", tone: "idle" }],
  } as unknown as LineSummary;
  const html = render(skewed);
  assert.equal([...html.matchAll(/class="line-stage/g)].length, LINE_STAGES.length);
  assert.doesNotMatch(html, /from the future/);
});

test("the strip is a landmark, so it is reachable rather than just visible", () => {
  assert.match(render(full), /<nav class="line" aria-label="The Line">/);
});

test("each stage teaches its own word, and repeats the sentence the strip had to clip", () => {
  // Two jobs in one label. "Decide" and "Review" are a vocabulary, and the strip is where
  // most people meet it - six mono uppercase words explain nothing on their own. And the
  // visible sentence ellipsizes, so on a narrow window the hover is the only way to finish
  // reading a long task title.
  const labels = tooltipLabels(render(full));
  assert.equal(labels.length, LINE_STAGES.length, "every stage describes itself");
  assert.match(labels[1]!, /^Filed and not started\..* Now: next up: Fix pane focus stealing$/);
  assert.match(labels[4]!, /Ensemble runs racing.* Now: Best of N · waiting on you$/);
});

test("a stage with nothing to report still says what it is for", () => {
  const labels = tooltipLabels(render(null));
  assert.equal(labels.length, LINE_STAGES.length);
  // No dangling "Now:" over a stage whose fold said nothing.
  for (const label of labels) assert.doesNotMatch(label, /Now:\s*$/);
});

// ---- condensed: the fold, and what it is not allowed to cost ----
//
// The whole risk of a density is that it quietly stops SAYING something. Expanded is
// pinned above; these pin that condensing drops the sentences and nothing else - every
// stage, every name, every tone, every drawer, and the amber sentences promoted onto the
// row. See `docs/plans/line-collapse/plan.md`.

const renderCondensed = (
  summary: LineSummary | null,
  onDensity?: (next: "expanded" | "condensed") => void,
): string =>
  renderToStaticMarkup(
    createElement(LineStrip, {
      summary,
      density: "condensed",
      onStage: () => {},
      ...(onDensity ? { onDensity } : {}),
    }),
  );

test("condensed still draws all six stages, with the same accessible names", () => {
  // The fold is a change to what is DRAWN, never to what is announced. A screen reader
  // gets the identical strip at either density, which is what makes the default safe.
  const html = renderCondensed(full);
  assert.equal([...html.matchAll(/class="line-stage/g)].length, LINE_STAGES.length);
  assert.match(html, /aria-label="Review, 5 runs live - No-Mistakes Review v8 ×4"/);
  assert.match(html, /aria-label="Working, 5 sessions - 1 needs you, 4 working"/);
  assert.match(html, /aria-label="Decide, 1 ensemble - Best of N, waiting on you"/);
});

test("condensed omits the sentence element rather than hiding it", () => {
  // `display: none` would keep six nodes and, in some screen readers, still read them -
  // and the sentence is not merely invisible when condensed, it is not being said.
  const html = renderCondensed(full);
  assert.equal([...html.matchAll(/class="ls-sub"/g)].length, 0);
  assert.equal([...render(full).matchAll(/class="ls-sub"/g)].length, LINE_STAGES.length);
});

test("the sentence a condensed stage stopped printing is still in its tooltip", () => {
  // Which is what makes dropping it a fold rather than a deletion, and is why the
  // per-stage prose is one hover away at either density. The tooltip is unchanged by the
  // fold: it carried the full sentence before this setting existed and still does.
  const condensed = renderCondensed(full);
  assert.match(
    condensed,
    /class="tt-desc">Workflow runs still in flight over the work their sessions did\. Now: No-Mistakes Review v8 ×4</,
  );
  // And it is the ONLY place that sentence appears now - it is in the tooltip instead of,
  // not as well as, a visible row.
  assert.equal([...condensed.matchAll(/No-Mistakes Review v8/g)].length, 2, "tooltip and aria-label only");
  assert.equal([...render(full).matchAll(/No-Mistakes Review v8/g)].length, 3, "plus the visible ls-sub");
});

test("condensed keeps every stage's tone, which is the read the strip exists for", () => {
  const html = renderCondensed(full);
  assert.match(html, /class="line-stage tone-attention" aria-label="Working/);
  assert.match(html, /class="line-stage tone-working" aria-label="Review/);
  assert.match(html, /class="line-stage tone-idle" aria-label="Shipped/);
});

test("condensed trades the wires for plain dividers", () => {
  // The wire needs 26px and a second line to sit beside. Six segments with nothing between
  // them read as one run-on string, so the separation survives even though the wire cannot.
  const html = renderCondensed(full);
  assert.equal([...html.matchAll(/class="line-wire/g)].length, 0);
  const divs = [...html.matchAll(/<span class="ls-div"[^>]*>/g)].map((m) => m[0]);
  assert.equal(divs.length, LINE_STAGES.length - 1);
  for (const div of divs) assert.match(div, /aria-hidden/);
});

test("condensed promotes the amber stages' sentences onto the row, verbatim", () => {
  // The one thing the fold must not hide is the reason to look. Both amber stages ride the
  // row; the two idle ones and the blue one do not, because they are not asking for anyone.
  const html = renderCondensed(full);
  const readout = /class="ls-urgent"[^>]*>(.*?)<\/span><\/span>/s.exec(html)?.[1] ?? "";
  assert.ok(readout, "condensed drew no readout for an amber fleet");
  // Verbatim, not re-folded: picking "1 needs you" out of the daemon's prose would make
  // this file a second, worse implementation of a fold the server already did.
  assert.match(readout, /1 needs you · 4 working/);
  assert.match(readout, /Best of N · waiting on you/);
  // And only the amber stages. Intake and Shipped are idle and Review is blue, so none of
  // their sentences belong on a row that exists to say what needs a person.
  assert.doesNotMatch(readout, /github-issues/);
  assert.doesNotMatch(readout, /per PR today/);
  assert.doesNotMatch(readout, /No-Mistakes/);
});

test("each promoted sentence is attributed to its stage rather than joined into one list", () => {
  // The defect this shape exists to prevent: the daemon joins CLAUSES with " · "
  // (`sentence()` in `src/server/line-summary.ts`), so joining two stages' sentences with
  // the same separator makes "4 working" and "Best of N" neighbours in one list and the
  // boundary between Working and Decide disappears.
  const html = renderCondensed(full);
  const items = [...html.matchAll(/class="ls-urgent-item"><span class="ls-urgent-glyph">([^<]*)<\/span>([^<]*)</g)];
  assert.equal(items.length, 2, "two amber stages should be two items");
  // The glyph is the strip's own vocabulary for that stage, so the sentence points back at
  // the segment it came from.
  assert.deepEqual(items.map((m) => m[1]), ["▶", "⧉"]);
  assert.deepEqual(items.map((m) => m[2]), ["1 needs you · 4 working", "Best of N · waiting on you"]);
});

test("the readout says nothing to a screen reader, because the buttons already did", () => {
  // Every sentence is in its own stage button's `aria-label` at BOTH densities - pinned
  // above - so announcing them again here would read one fleet twice. A live region would
  // be worse still: this text changes whenever any session changes state.
  const html = renderCondensed(full);
  assert.match(html, /<span class="ls-urgent" aria-hidden="true">/);
  assert.doesNotMatch(html, /role="status"/);
});

test("a calm fleet spends no row on a readout at all", () => {
  // The space is only taken when something is wrong. A permanent empty readout would be
  // the `ls-sub` mistake again, one line up.
  const calm: LineSummary = {
    stages: LINE_STAGES.map((s) => stage({ stage: s, count: 1, sentence: "all clear", tone: "idle" })),
  };
  assert.doesNotMatch(renderCondensed(calm), /ls-urgent/);
  assert.doesNotMatch(renderCondensed(null), /ls-urgent/);
});

test("the nav says which density it is in", () => {
  assert.match(renderCondensed(full), /<nav class="line is-condensed" aria-label="The Line">/);
});

test("the fold caret appears only when something can act on it", () => {
  // A control that cannot do anything should not be on screen - and this is what lets the
  // tour and these tests render the strip without wiring a store to it.
  assert.doesNotMatch(renderCondensed(full), /ls-fold/);
  assert.doesNotMatch(render(full), /ls-fold/);
  const withCaret = renderCondensed(full, () => {});
  assert.match(withCaret, /class="ls-fold"/);
});

test("the caret reports the fold state, so it is legible without sight", () => {
  // `aria-expanded` on the control is the relationship: pressed at false, the six stages
  // regain their sentences. Without it the caret is an unlabelled triangle.
  assert.match(renderCondensed(full, () => {}), /aria-expanded="false" aria-label="Expand the Line"/);
  const expanded = renderToStaticMarkup(
    createElement(LineStrip, {
      summary: full,
      density: "expanded",
      onStage: () => {},
      onDensity: () => {},
    }),
  );
  assert.match(expanded, /aria-expanded="true" aria-label="Condense the Line"/);
});
