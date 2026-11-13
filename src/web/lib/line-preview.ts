import type { LineSummary } from "@shared/line.ts";

/**
 * The pipeline the Line preview in Display > Top bar draws.
 *
 * The panel mounts the REAL `LineStrip` against this rather than a drawing of one, for the
 * reason `topbar-preview.ts` gives for the bar: a drawing would be a second source of truth
 * for the thing being configured.
 *
 * Every stage carries a count and a sentence, so Expanded has something to say under each
 * one, and two stages are amber, so Condensed shows the readout it promotes onto its row.
 * A preview of a quiet fleet would make the two densities look closer than they are.
 */
export const PREVIEW_LINE_SUMMARY: LineSummary = {
  stages: [
    { stage: "intake", count: 1, sentence: "GitHub issues swept just now", tone: "neutral" },
    { stage: "backlog", count: 5, sentence: "nothing ready · 5 parked", tone: "attention" },
    { stage: "working", count: 9, sentence: "2 working · 7 idle", tone: "working" },
    { stage: "review", count: 3, sentence: "1 needs you · Review v2 ×2", tone: "attention" },
    { stage: "decide", count: 0, sentence: "no ensembles live", tone: "neutral" },
    { stage: "shipped", count: 12, sentence: "this week · ≈$4.10 per PR today", tone: "neutral" },
  ],
};
