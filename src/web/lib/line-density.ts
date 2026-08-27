import { useCallback } from "react";
import { LINE_DENSITIES, UI_CONFIG_DEFAULTS } from "@shared/protocol.ts";
import type { LineDensity } from "@shared/protocol.ts";
import { LINE_STAGES, lineStage } from "@shared/line.ts";
import type { LineStageId, LineSummary } from "@shared/line.ts";
import { uiConfig, updateUiConfig, useUiConfig } from "./uiConfig.ts";

/**
 * How dense the Line strip draws, and what a condensed strip says instead of its sentences.
 *
 * The density itself lives in the daemon (`app_config.ui.lineDensity`) because it is a
 * per-machine display preference like `layout` beside it, and this module is the seam the
 * strip and the settings panel both read it through - neither holds its own copy, so they
 * cannot disagree about a band height.
 *
 * See `docs/plans/line-collapse/plan.md` for the measurements: expanded is 86px, condensed
 * is 38.5px, and the strip is `flex: none` inside a shell that does not scroll, so the
 * difference is 47.5px of conversation.
 */

/**
 * A stored density is only trusted if it is still one we ship - the same rule
 * `parseLayoutMode` states, and load-bearing for the same reason: an unrecognised value
 * read from a cache or a hand-edit would otherwise be adopted and PUT back to the daemon
 * as though it were real.
 */
export function parseLineDensity(raw: string | null | undefined): LineDensity {
  return (LINE_DENSITIES as readonly string[]).includes(raw ?? "")
    ? (raw as LineDensity)
    : UI_CONFIG_DEFAULTS.lineDensity;
}

/** One density, as the settings picker offers it. Prose lives here rather than in
 *  `@shared/protocol.ts` for the reason `LAYOUTS` does: the daemon shows none of it. */
export interface LineDensityOption {
  id: LineDensity;
  label: string;
  description: string;
}

/**
 * In `LINE_DENSITIES` order, which is densest-last, so the picker reads as a fold rather
 * than as two unrelated modes.
 *
 * The descriptions name what is TRADED, not what is drawn, because that is the whole
 * decision: expanded costs 47.5px of conversation to print six sentences a tooltip already
 * carries, and condensed keeps every count, tone and drawer. The pixel figures are in the
 * prose deliberately - this is the rare display setting whose cost is exactly measurable,
 * and stating it is more useful than an adjective.
 */
export const LINE_DENSITY_OPTIONS: readonly LineDensityOption[] = [
  {
    id: "expanded",
    label: "Expanded",
    description:
      "Two rows: every stage's count and the sentence under it. Costs 47.5px of the conversation.",
  },
  {
    id: "condensed",
    label: "Condensed",
    description:
      "One row: counts and tones only, with whatever needs you promoted onto it. Hands 47.5px back.",
  },
];

/** The next density the caret steps to. Two members, so this is the other one. */
export function nextLineDensity(current: LineDensity): LineDensity {
  return current === "expanded" ? "condensed" : "expanded";
}

/** The chosen density, stored in the daemon. Mirrors `useLayoutMode`. */
export function useLineDensity(): [LineDensity, (next: LineDensity) => void] {
  const density = useUiConfig().lineDensity;
  const set = useCallback((next: LineDensity) => {
    void updateUiConfig({ lineDensity: parseLineDensity(next) });
  }, []);
  return [density, set];
}

/**
 * Step the density, reading the CURRENT value at call time rather than taking it as an
 * argument.
 *
 * A module function and not a hook, and that is the whole point of it. `App`'s keydown
 * handler is one big listener registered by an effect with an explicit dependency list, and
 * the first version of the `Shift+L` chord did `setLineDensity(nextLineDensity(lineDensity))`
 * with `lineDensity` closed over from render. It was not in that dependency list, so the
 * listener kept the value it was registered with: the first press folded the strip and every
 * press after it recomputed the same answer and did nothing. `e2e/specs/line-density.spec.ts`
 * is what caught it.
 *
 * Adding the density to the dependency list would have fixed that press and left the trap
 * armed for the next chord. Reading `uiConfig()` - the module store, which is always the
 * live value and is safe to read outside React - cannot go stale by construction, so this
 * needs no dependency and there is nothing for a future edit to forget.
 */
export function toggleLineDensity(): void {
  void updateUiConfig({ lineDensity: nextLineDensity(uiConfig().lineDensity) });
}

/** One amber stage's sentence, kept attributed to the stage it came from. */
export interface LineUrgentItem {
  stage: LineStageId;
  sentence: string;
}

/**
 * What a condensed strip says in place of the six sentences it dropped: the sentences of
 * the stages that are ASKING FOR A PERSON, and nothing else.
 *
 * Condensing trades prose for height, and the sentences that are ever load-bearing are the
 * ones attached to an amber stage - "1 needs you", "2 stalled". Those ride the row so that
 * folding the strip never folds away the reason to look at it. A calm fleet returns an
 * empty list and the row carries no readout at all, which is the whole point: the space is
 * only spent when something is wrong.
 *
 * Each sentence stays ATTRIBUTED rather than being joined into one string, and that is not
 * a cosmetic choice. The daemon builds these sentences by joining clauses with the same
 * ` · ` this would have joined the sentences with (`sentence()` in
 * `src/server/line-summary.ts`), so a flat string turns "8 idle" and "No-Mistakes Review
 * v10 ×3" into neighbours in one list and the boundary between two stages disappears. The
 * caller draws each item beside its stage's glyph instead.
 *
 * The sentence itself is passed through VERBATIM. It is prose written on the server for
 * people to read, and picking "1 needs you" out of "1 needs you · 2 working · 8 idle" would
 * make this file a second, worse implementation of a fold the daemon already did - and the
 * clause order is not a contract: `foldWorking` happens to put the urgent part first,
 * `foldDecide` does not. Long readouts ellipsize in CSS.
 *
 * Driven by `LINE_STAGES` rather than by what arrived, so the order is the pipeline's own
 * and a daemon that grows a seventh stage cannot reorder this behind our back.
 */
export function lineUrgentReadout(summary: LineSummary | null): LineUrgentItem[] {
  const urgent: LineUrgentItem[] = [];
  for (const stage of LINE_STAGES) {
    const fold = lineStage(summary, stage);
    if (fold?.tone === "attention" && fold.sentence) {
      urgent.push({ stage, sentence: fold.sentence });
    }
  }
  return urgent;
}
