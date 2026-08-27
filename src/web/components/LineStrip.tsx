import { Fragment } from "react";
import type { LineStageId, LineStageSummary, LineSummary } from "@shared/line.ts";
import { LINE_STAGES, LINE_STAGE_LABELS, lineStage } from "@shared/line.ts";
import type { LineDensity } from "@shared/protocol.ts";
import { lineUrgentReadout, nextLineDensity } from "../lib/line-density.ts";
import { lineStageHasDrawer } from "../lib/line-targets.ts";
import { useTourTargetRef } from "../tour/target-context.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * The Line: a permanent pipeline strip above the fleet's session layouts.
 *
 * Six stages - intake, backlog, working, review, decide, shipped - each a glyph, a count and
 * one sentence, wired left to right. It answers one question at a glance, in the order work
 * actually moves: where is everything, and does any of it need me?
 *
 * IT COMPUTES NOTHING. Every count, sentence and tone arrives folded from the daemon in a
 * single `line_summary` event; this file decides only how that reads on screen - which glyph,
 * which colour, which wire is lit. The one derivation here is presentational and stays that
 * way: a wire is "hot" when the stage it feeds is amber, which is a fact about the two
 * stages either side of it and not about the fleet.
 *
 * The strip renders at a FIXED height whatever it is SAYING, including nothing. A pipeline
 * that grew a row when a stage got wordy would move the board underneath it every time a
 * session changed state, and a strip that vanished when the fleet went quiet would stop
 * being the place you look.
 *
 * That invariant is per DENSITY, and the distinction is the whole design of the fold. The
 * strip has two densities - 86px expanded, 38.5px condensed - and each is fixed against
 * everything the fleet can do to it. What moves the band is an operator pressing the
 * caret, which is a deliberate act with a persisted result; what must never move it is a
 * workflow name getting longer or a stage going quiet. Condensed is the shipped default
 * (`UI_CONFIG_DEFAULTS.lineDensity`), because the 47.5px it hands the conversation is a
 * better trade than six sentences a hover already carries.
 *
 * Condensing must not fold away the reason to look at the strip. Every count and every
 * tone survives, all six drawers stay reachable, and the sentences of the AMBER stages -
 * the ones asking for a person - are promoted onto the row by `lineUrgentReadout`. The
 * measurements and the four rejected shapes are in `docs/plans/line-collapse/plan.md`.
 */

/** One glyph per stage, in the mockup's vocabulary. Decoration - `aria-hidden` below. */
const LINE_STAGE_GLYPHS: Record<LineStageId, string> = {
  intake: "⇊",
  backlog: "☰",
  working: "▶",
  review: "⌁",
  decide: "⧉",
  shipped: "⚑",
};

/**
 * What the count counts, for the accessible name only.
 *
 * The visible strip never says these words - the column is a number under a heading, which
 * is unambiguous when you can see the six of them side by side. Read aloud one at a time it
 * is not, and "Review, 5" says nothing at all.
 */
const LINE_STAGE_NOUNS: Record<LineStageId, [singular: string, plural: string]> = {
  intake: ["source or mission", "sources and missions"],
  backlog: ["task waiting", "tasks waiting"],
  working: ["session", "sessions"],
  review: ["run live", "runs live"],
  decide: ["ensemble", "ensembles"],
  shipped: ["pull request this week", "pull requests this week"],
};

/**
 * What each stage MEANS, for the tooltip.
 *
 * Six mono uppercase words are a vocabulary, and a vocabulary has to be taught somewhere -
 * "Decide" and "Review" are not self-evident, and the strip is most people's first meeting
 * with either. The tooltip also carries the sentence in full, which is the other half of
 * why it is here: the visible line ellipsizes, so on a narrow window a hover is the only
 * way to finish reading a long workflow name or task title.
 */
const LINE_STAGE_BLURBS: Record<LineStageId, string> = {
  intake: "Where work comes from: task sources that sweep, and Recurring Missions that fire.",
  backlog: "Filed and not started. The next one up is what autopilot would take.",
  working: "Sessions open right now, and how many of them are stuck on you.",
  review: "Workflow runs still in flight over the work their sessions did.",
  decide: "Ensemble runs racing; the amber ones have stopped for your answer.",
  shipped: "Pull requests your agents opened and adopted, and what they cost.",
};

/** An empty stage, for a strip that has not heard from the daemon yet. */
function blankStage(stage: LineStageId): LineStageSummary {
  return { stage, count: 0, sentence: "", tone: "neutral" };
}

/**
 * The button's accessible name: the stage, what its number means, and the sentence.
 *
 * The sentence's `·` separators become commas because a screen reader either announces the
 * middle dot or swallows it, and neither produces the pause a sighted reader gets for free.
 */
function stageLabel(fold: LineStageSummary): string {
  const [singular, plural] = LINE_STAGE_NOUNS[fold.stage];
  const head = `${LINE_STAGE_LABELS[fold.stage]}, ${fold.count} ${fold.count === 1 ? singular : plural}`;
  const rest = fold.sentence.replaceAll(" · ", ", ");
  return rest ? `${head} - ${rest}` : head;
}

/** What the stage is for, then what it currently says - the ellipsized line, in full. */
function stageTooltip(fold: LineStageSummary): string {
  const blurb = LINE_STAGE_BLURBS[fold.stage];
  return fold.sentence ? `${blurb} Now: ${fold.sentence}` : blurb;
}

/** The id the drawer's region carries, so an expanded stage button can point at it. */
export const LINE_DRAWER_DOM_ID = "line-drawer";

export function LineStrip({
  summary,
  density = "expanded",
  openStage = null,
  stageRef,
  onStage,
  onDensity,
}: {
  /** The daemon's fold, or null before the first snapshot lands. */
  summary: LineSummary | null;
  /**
   * How much the strip says. `expanded` is the two-line strip at 86px; `condensed` drops
   * the sentences and the wires for a single 38.5px row, handing 47.5px to the
   * conversation below.
   *
   * Defaulted to `expanded` rather than to the product default, which is `condensed`. The
   * default here is for a CALLER that forgot the prop, and the honest answer to that is
   * "draw everything" - a component that silently condensed itself would hide facts
   * because of a missing prop. The product default lives in `UI_CONFIG_DEFAULTS`, where
   * one line decides it, and `App` passes it in.
   */
  density?: LineDensity;
  /**
   * Which stage's drawer is showing, or null. The strip does not own this - App does - and
   * it is passed IN rather than held here because the drawer is a sibling of the strip, not
   * a child of it: a stage that remembered its own open state would be a second answer to
   * "what is showing below", and the two would disagree the first time `esc` closed one.
   */
  openStage?: LineStageId | null;
  /**
   * Hands each stage's button to the owner as it mounts (and `null` as it unmounts).
   *
   * One prop, for one job: putting the keyboard back where it came from when a drawer
   * closes. That has to be done by whoever OWNS the open state, because the drawer has
   * already unmounted by then - and it cannot be done by querying the DOM, since the
   * attribute that identified the open stage went with it.
   */
  stageRef?: (stage: LineStageId, button: HTMLButtonElement | null) => void;
  onStage: (stage: LineStageId) => void;
  /**
   * Step the density. Optional, and when it is absent the caret is NOT rendered - a
   * control that cannot do anything should not be on screen. That is what lets the
   * `renderToStaticMarkup` tests and the tour render the strip without wiring a store.
   */
  onDensity?: (next: LineDensity) => void;
}): React.JSX.Element {
  const tourRef = useTourTargetRef<HTMLElement>("see-work:line");
  const condensed = density === "condensed";
  // Only condensed spends a row on this, and only when a stage is actually asking for a
  // person. Expanded already prints every sentence in full under its own stage.
  const urgent = condensed ? lineUrgentReadout(summary) : [];
  // Driven by LINE_STAGES rather than by what arrived, which is what makes the strip
  // survive a version skew in both directions: a daemon that predates a stage this build
  // draws leaves it blank, and one that has grown a seventh has it ignored rather than
  // rendered as an unlabelled hole.
  const folds = LINE_STAGES.map((stage) => lineStage(summary, stage) ?? blankStage(stage));

  return (
    <nav
      ref={tourRef}
      className={`line${condensed ? " is-condensed" : ""}`}
      aria-label="The Line"
    >
      {folds.map((fold, i) => (
        <Fragment key={fold.stage}>
          {i > 0 && (
            // Decoration, and named as such: the wires carry no information the stages
            // either side do not already state, and six announced "graphic"s between six
            // buttons would triple the length of the strip read aloud.
            //
            // Condensed draws a plain divider in their place rather than a wire. The wire
            // is 26px of width carrying a travelling dot, and on one row there is neither
            // the room for it nor a second line for it to sit beside - but six segments
            // with nothing between them read as one run-on string.
            <span
              className={
                condensed
                  ? "ls-div"
                  : `line-wire${folds[i]!.tone === "attention" ? " hot" : ""}`
              }
              aria-hidden
            />
          )}
          <Tooltip label={stageTooltip(fold)}>
            <button
              type="button"
              ref={stageRef ? (el) => stageRef(fold.stage, el) : undefined}
              className={`line-stage tone-${fold.tone}${
                openStage === fold.stage ? " is-open" : ""
              }`}
              aria-label={stageLabel(fold)}
              // Only the stages that OPEN something are expandable. Announcing
              // `aria-expanded="false"` on Working - which clears the filter - would promise
              // a panel that no press produces.
              {...(lineStageHasDrawer(fold.stage)
                ? {
                    "aria-expanded": openStage === fold.stage,
                    ...(openStage === fold.stage ? { "aria-controls": LINE_DRAWER_DOM_ID } : {}),
                  }
                : {})}
              onClick={() => onStage(fold.stage)}
            >
              <span className="ls-head">
                <span className="ls-glyph" aria-hidden>
                  {LINE_STAGE_GLYPHS[fold.stage]}
                </span>
                <span className="ls-name">{LINE_STAGE_LABELS[fold.stage]}</span>
                <span className="ls-count">{fold.count}</span>
              </span>
              {/* Expanded only. Always rendered when it is rendered at all, even empty: it
                  reserves the second line, so the strip is the same height on a silent
                  fleet as on a busy one and the board below it never steps up and down.

                  Condensed omits the ELEMENT rather than hiding it in CSS. A `display:
                  none` sentence still costs a DOM node per stage and, worse, still reads
                  aloud in some screen readers - and the sentence is not merely invisible
                  when condensed, it is genuinely not being said. What survives is the
                  tooltip, which carries every sentence in full at both densities. */}
              {!condensed && <span className="ls-sub">{fold.sentence}</span>}
            </button>
          </Tooltip>
        </Fragment>
      ))}
      {/* Condensed's replacement for the six sentences it dropped: the amber ones only,
          and nothing at all on a calm fleet.

          `aria-hidden`, and deliberately so rather than as an oversight. Every sentence is
          already in its own stage button's `aria-label` at BOTH densities - the fold costs
          a screen reader nothing, which `line-strip-render.test.ts` pins - so announcing
          them a second time here would read the same fleet twice. A live region was tried
          and rejected for the same reason in the other direction: `role="status"` on a
          readout that changes whenever any session changes state is a surface that
          interrupts constantly to say what the buttons already say.

          Each item carries its stage's GLYPH, which is what keeps two amber stages apart.
          Joining the sentences into one string put "8 idle" next to "No-Mistakes Review
          v10 ×3" separated by the same ` · ` the daemon uses inside a sentence, so the
          boundary between two stages vanished. */}
      {urgent.length > 0 && (
        <span className="ls-urgent" aria-hidden>
          {urgent.map((item) => (
            <span key={item.stage} className="ls-urgent-item">
              <span className="ls-urgent-glyph">{LINE_STAGE_GLYPHS[item.stage]}</span>
              {item.sentence}
            </span>
          ))}
        </span>
      )}
      {onDensity && (
        <Tooltip
          label={
            condensed
              ? "Expand the Line, and show each stage's sentence"
              : "Condense the Line to one row, and give the space to the conversation"
          }
        >
          <button
            type="button"
            className="ls-fold"
            // The strip is a `nav`, not a disclosure, and this button folds the nav it
            // sits inside. `aria-expanded` on the CONTROL is exactly that relationship,
            // and it is the one attribute that makes the fold legible without sight:
            // pressed at `false`, the six stages regain their sentences.
            aria-expanded={!condensed}
            aria-label={condensed ? "Expand the Line" : "Condense the Line"}
            onClick={() => onDensity(nextLineDensity(density))}
          >
            <span aria-hidden>{condensed ? "▾" : "▴"}</span>
          </button>
        </Tooltip>
      )}
    </nav>
  );
}
