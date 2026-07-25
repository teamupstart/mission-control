import { test } from "node:test";
import assert from "node:assert/strict";

import {
  aggregatePanelVotes,
  PANEL_LENSES,
  PANEL_LENS_IDS,
  PANEL_VERDICT_VERSION,
  parsePanelVerdict,
  type PanelVerdict,
} from "../src/shared/ensemble-strategies/panel-vote.ts";

/**
 * What is at stake: the aggregation is the whole product claim of `panel_vote`. It runs on both
 * sides of the wire - the daemon labels the stage with it and the dashboard draws the result with
 * it - so a disagreement between the two would show the operator one recommendation while the run
 * summary announced another. Four properties are pinned here.
 *
 *  1. **It is a total, deterministic order.** Ranks are contiguous, ties break the same way every
 *     time, and the same ballots always produce the same recommendation.
 *  2. **Disagreement is never averaged away.** A split panel reports a split, per-artifact spread
 *     survives to the row, and a tie is declared rather than silently resolved.
 *  3. **A missing ballot entry is an ABSENCE, not a zero.** Scoring it as the worst possible
 *     verdict would let one judge that skipped a subject decide the panel.
 *  4. **Ordering is by rank, not by score.** A 0-100 score is a scale each judge invented
 *     privately; a rank is a comparison between the same subjects, so a judge with a generous
 *     scale must not be able to outvote the panel.
 */

function verdict(
  judgeKey: string,
  order: string[],
  scores?: Record<string, number>,
): PanelVerdict {
  return {
    version: PANEL_VERDICT_VERSION,
    judgeKey,
    judgeLabel: judgeKey,
    summary: `${judgeKey} summary`,
    caveats: [],
    scorecards: order.map((artifactId, index) => ({
      artifactId,
      score: scores?.[artifactId] ?? 90 - index * 10,
      rank: index + 1,
      strengths: [],
      risks: [],
      rationale: "",
      confidence: 0.8,
    })),
    evidenceTruncated: false,
  };
}

// ---- ordering ----

test("unanimous judges produce a contiguous ranking with no contested rows", () => {
  const aggregate = aggregatePanelVotes([
    verdict("j1", ["a", "b", "c"]),
    verdict("j2", ["a", "b", "c"]),
    verdict("j3", ["a", "b", "c"]),
  ]);
  assert.deepEqual(aggregate.entries.map((e) => e.artifactId), ["a", "b", "c"]);
  assert.deepEqual(aggregate.entries.map((e) => e.rank), [1, 2, 3]);
  assert.equal(aggregate.recommendedArtifactId, "a");
  assert.equal(aggregate.disagreement, 0);
  assert.equal(aggregate.unanimous, true);
  assert.equal(aggregate.tied, false);
  for (const entry of aggregate.entries) {
    assert.equal(entry.contested, false);
    assert.equal(entry.rankSpread, 0);
    assert.equal(entry.ranks.length, 3, "every judge's rank is carried to the row");
  }
});

test("the majority's ordering wins, and the row it split on says so", () => {
  // Two judges prefer b, one prefers a. Borda: b = 2+2+0 = 4, a = 1+1+2 = 4 ... so mean rank
  // separates them, and both rows are contested because no artifact was placed identically.
  const aggregate = aggregatePanelVotes([
    verdict("j1", ["b", "a", "c"]),
    verdict("j2", ["b", "a", "c"]),
    verdict("j3", ["a", "b", "c"]),
  ]);
  assert.equal(aggregate.recommendedArtifactId, "b");
  assert.equal(aggregate.unanimous, false);
  const b = aggregate.entries.find((e) => e.artifactId === "b")!;
  assert.equal(b.contested, true);
  assert.equal(b.rankSpread, 1, "ranked 1, 1 and 2");
  const c = aggregate.entries.find((e) => e.artifactId === "c")!;
  assert.equal(c.contested, false, "every judge put c last, so c is not contested even in a split panel");
});

test("ordering follows ranks, not a generous judge's scores", () => {
  // j1 ranks a first with modest scores; j2 and j3 rank b first while scoring a very highly.
  // If the aggregate ordered on mean score, `a` would win on one judge's private scale.
  const aggregate = aggregatePanelVotes([
    verdict("j1", ["a", "b"], { a: 60, b: 55 }),
    verdict("j2", ["b", "a"], { b: 62, a: 99 }),
    verdict("j3", ["b", "a"], { b: 61, a: 98 }),
  ]);
  assert.equal(aggregate.recommendedArtifactId, "b", "two of three judges ranked b first");
  const a = aggregate.entries.find((e) => e.artifactId === "a")!;
  assert.ok(a.meanScore > aggregate.entries[0]!.meanScore, "the loser genuinely has the higher mean score");
});

// ---- ties ----

test("a dead tie is declared rather than silently resolved, and still orders deterministically", () => {
  const split = [verdict("j1", ["a", "b"], { a: 80, b: 70 }), verdict("j2", ["b", "a"], { b: 80, a: 70 })];
  const aggregate = aggregatePanelVotes(split);
  assert.equal(aggregate.tied, true, "the operator is told the panel could not separate the top two");
  assert.equal(aggregate.disagreement, 1, "two judges, one pair, ordered oppositely");
  // Deterministic: the same ballots in the other order give the same answer, so the recommendation
  // does not depend on which judge happened to finish first.
  assert.equal(aggregatePanelVotes([...split].reverse()).recommendedArtifactId, aggregate.recommendedArtifactId);
  assert.deepEqual(aggregate.entries.map((e) => e.rank), [1, 2], "ranks stay contiguous through a tie");
});

test("a Borda tie stays tied when the judges' private score scales differ", () => {
  const aggregate = aggregatePanelVotes([
    verdict("j1", ["a", "b"], { a: 60, b: 99 }),
    verdict("j2", ["b", "a"], { b: 99, a: 60 }),
  ]);
  const b = aggregate.entries.find((entry) => entry.artifactId === "b")!;
  assert.equal(aggregate.tied, true);
  assert.deepEqual(aggregate.entries.map((entry) => entry.artifactId), ["a", "b"]);
  assert.ok(b.meanScore > aggregate.entries[0]!.meanScore, "the higher private score does not break the tie");
});

// ---- partial quorum and partial ballots ----

test("one ballot aggregates, but is never presented as agreement", () => {
  const aggregate = aggregatePanelVotes([verdict("j1", ["a", "b"])]);
  assert.equal(aggregate.recommendedArtifactId, "a");
  assert.equal(aggregate.judgeCount, 1);
  assert.equal(aggregate.disagreement, 0, "there is no pair of judges to disagree");
  assert.equal(
    aggregate.unanimous,
    false,
    "a single ballot is not unanimity - the quorum exists so this is never the panel's answer",
  );
});

test("no ballots at all yields no recommendation rather than an invented one", () => {
  const aggregate = aggregatePanelVotes([]);
  assert.equal(aggregate.recommendedArtifactId, null);
  assert.deepEqual(aggregate.entries, []);
  assert.equal(aggregate.judgeCount, 0);
  assert.equal(aggregate.tied, false);
});

test("a subject a judge did not rank is an absence, not a last place", () => {
  // j3 ranked only a and b. If the missing `c` were scored as worst-possible, c would be pushed
  // below b on one judge's silence; instead c keeps the standing its two real ballots gave it.
  const aggregate = aggregatePanelVotes([
    verdict("j1", ["c", "a", "b"]),
    verdict("j2", ["c", "a", "b"]),
    verdict("j3", ["a", "b"]),
  ]);
  assert.equal(aggregate.recommendedArtifactId, "c");
  const c = aggregate.entries.find((e) => e.artifactId === "c")!;
  assert.equal(c.ranks.length, 2, "only the judges that ranked it contribute");
  assert.equal(c.meanRank, 1, "its mean is over the ballots that named it, not over the panel");
});

test("disagreement is measured only over the subjects two judges both ranked", () => {
  // j2 saw a smaller set. Its ordering of a and b agrees with j1's, so the panel is in complete
  // agreement - the subject j2 never ranked must not register as a disagreement it never had.
  const aggregate = aggregatePanelVotes([verdict("j1", ["a", "b", "c"]), verdict("j2", ["a", "b"])]);
  assert.equal(aggregate.disagreement, 0);
});

// ---- the lenses ----

test("every lens id has distinct, single-minded text and a label", () => {
  const texts = new Set<string>();
  for (const id of PANEL_LENS_IDS) {
    const lens = PANEL_LENSES[id];
    assert.ok(lens.label.length > 0, `${id} needs a label an operator can pick`);
    assert.ok(lens.blurb.length > 0, `${id} needs a one-line blurb`);
    assert.match(lens.text, /ONE dimension only/, `${id} must tell its judge to weigh one thing`);
    assert.match(lens.text, /do NOT/, `${id} must say what to leave to the other judges`);
    assert.equal(texts.has(lens.text), false, `${id} repeats another lens's text`);
    texts.add(lens.text);
  }
});

test("a stored ballot from a newer build degrades to no ballot rather than a half-rendered one", () => {
  assert.equal(parsePanelVerdict({ version: 99, judgeKey: "j", scorecards: [] }), null);
  assert.equal(parsePanelVerdict(null), null);
  assert.equal(parsePanelVerdict({ version: 1, judgeKey: "j1", judgeLabel: "J", summary: "", caveats: [], scorecards: [], evidenceTruncated: false }), null);
  const good = verdict("j1", ["a", "b"]);
  assert.deepEqual(parsePanelVerdict(JSON.parse(JSON.stringify(good))), good);
});
