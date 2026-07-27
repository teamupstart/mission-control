// The Ensemble member signal has to reach every layout, the same way the Workflow marks do:
// a shared leaf drawn in all four renderers, an `onOpenEnsemble` that flows through the one
// prop bag so `GridView` cannot silently drop it, and a tone/label vocabulary that stays
// DISTINCT from the Workflow marks so the two never conflate on one session. If a renderer
// re-inlines its own variant or a prop stops being threaded, this fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { TaskEnsembleLink } from "../src/shared/ensemble.ts";
import {
  EnsembleChip,
  EnsembleRailMark,
  EnsembleTileFlag,
  ensembleMemberStateLabel,
  ensembleMemberTone,
} from "../src/web/components/session-bits.tsx";

const link: TaskEnsembleLink = {
  runId: "run-1",
  strategyId: "best_of_n",
  strategyLabel: "Best of N",
  memberId: "m-1",
  ordinal: 2,
  wave: 1,
  role: "candidate-2",
  launchedMembers: 3,
  maxMembers: 3,
  status: "retained",
  resultLabel: "rank 1",
  needsInput: false,
};

test("ensemble member tone reads standing, not run health", () => {
  assert.equal(ensembleMemberTone({ ...link, status: "retained" }), "kept");
  assert.equal(ensembleMemberTone({ ...link, status: "advanced" }), "kept");
  assert.equal(ensembleMemberTone({ ...link, status: "eliminated" }), "out");
  assert.equal(ensembleMemberTone({ ...link, status: "failed" }), "out");
  assert.equal(ensembleMemberTone({ ...link, status: "submitted" }), "waiting");
  assert.equal(ensembleMemberTone({ ...link, status: "active" }), "running");
  assert.equal(ensembleMemberTone({ ...link, status: null }), "running");
});

test("the state label prefers the server-derived resultLabel over the status", () => {
  assert.equal(ensembleMemberStateLabel(link), "rank 1");
  assert.equal(ensembleMemberStateLabel({ ...link, resultLabel: null, status: "eliminated" }), "not selected");
});

test("all three ensemble marks render the member with an accessible label and a distinct E/⧉ mark", () => {
  const chip = renderToStaticMarkup(createElement(EnsembleChip, { link }));
  const tile = renderToStaticMarkup(createElement(EnsembleTileFlag, { link }));
  const rail = renderToStaticMarkup(createElement(EnsembleRailMark, { link }));
  for (const html of [chip, tile, rail]) {
    assert.match(html, /aria-label="Best of N: candidate 2 of 3 - rank 1"/);
  }
  assert.match(chip, /ensemble-chip/);
  assert.match(tile, /tf-ensemble/);
  assert.match(rail, /rail-ensemble/);
  assert.doesNotMatch(rail, /role="button"/);
  // Rail keeps the bounded resultLabel; tile keeps the ordinal.
  assert.match(rail, /rank 1/);
  assert.match(tile, /#?\s*2|>2</);
});

test("a session with no ensemble link draws no mark at all", () => {
  for (const Comp of [EnsembleChip, EnsembleTileFlag, EnsembleRailMark]) {
    assert.equal(renderToStaticMarkup(createElement(Comp, { link: null })), "");
  }
});

test("all four session renderers reference the shared ensemble leaf", () => {
  const read = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");
  assert.match(read("../src/web/components/SessionCard.tsx"), /<EnsembleChip/);
  assert.match(read("../src/web/components/layouts/ConsoleDetail.tsx"), /<EnsembleChip/);
  assert.match(read("../src/web/components/layouts/SessionTile.tsx"), /<EnsembleTileFlag/);
  assert.match(read("../src/web/components/layouts/RailRow.tsx"), /<EnsembleRailMark/);
});

test("onOpenEnsemble flows through SessionViewProps and cardProps so GridView cannot drop it", () => {
  const types = readFileSync(new URL("../src/web/components/layouts/types.ts", import.meta.url), "utf8");
  assert.match(types, /onOpenEnsemble\?:/);
  assert.match(types, /onOpenEnsemble: p\.onOpenEnsemble/);
});
