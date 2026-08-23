import { Fragment } from "react";
import type { LineStageId, LineStageSummary, LineSummary } from "@shared/line.ts";
import { LINE_STAGES, LINE_STAGE_LABELS, lineStage } from "@shared/line.ts";
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
 * The strip renders at a FIXED height whatever it is saying, including nothing. A pipeline
 * that grew a row when a stage got wordy would move the board underneath it every time a
 * session changed state, and a strip that vanished when the fleet went quiet would stop
 * being the place you look.
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
  openStage = null,
  stageRef,
  onStage,
}: {
  /** The daemon's fold, or null before the first snapshot lands. */
  summary: LineSummary | null;
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
}): React.JSX.Element {
  const tourRef = useTourTargetRef<HTMLElement>("see-work:line");
  // Driven by LINE_STAGES rather than by what arrived, which is what makes the strip
  // survive a version skew in both directions: a daemon that predates a stage this build
  // draws leaves it blank, and one that has grown a seventh has it ignored rather than
  // rendered as an unlabelled hole.
  const folds = LINE_STAGES.map((stage) => lineStage(summary, stage) ?? blankStage(stage));

  return (
    <nav ref={tourRef} className="line" aria-label="The Line">
      {folds.map((fold, i) => (
        <Fragment key={fold.stage}>
          {i > 0 && (
            // Decoration, and named as such: the wires carry no information the stages
            // either side do not already state, and six announced "graphic"s between six
            // buttons would triple the length of the strip read aloud.
            <span
              className={`line-wire${folds[i]!.tone === "attention" ? " hot" : ""}`}
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
              {/* Always rendered, even empty: it reserves the second line, so the strip is
                  the same height on a silent fleet as on a busy one and the board below it
                  never steps up and down. */}
              <span className="ls-sub">{fold.sentence}</span>
            </button>
          </Tooltip>
        </Fragment>
      ))}
    </nav>
  );
}
