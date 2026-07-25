import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ENSEMBLE_DRIVER_KEYS,
  ENSEMBLE_ARTIFACT_KINDS,
  ENSEMBLE_STAGE_DRIVER_KINDS,
} from "../src/shared/ensemble.ts";
import { REVIEW_DRIVERS } from "../src/server/ensembles/reviews/index.ts";
import { DECISION_DRIVERS } from "../src/server/ensembles/decisions/index.ts";
import { FINALIZERS } from "../src/server/ensembles/finalizers/index.ts";
import { ARTIFACT_ADAPTERS } from "../src/server/ensembles/artifacts/index.ts";
import * as fx from "./ensemble-strategy-fixtures.ts";

/**
 * What is at stake: Phase 8 turns the ensemble kernel's central promise from a design claim into a
 * merge-blocking test. The promise is that a materially different multi-agent strategy is a new
 * PLAN composed from existing primitives - never a fork of the engine, a branch in the store, a new
 * route, event, Session field, layout, or a node in the Workflow graph. These are the negative
 * assertions: the execution/rendering code contains no branch on a strategy id, the driver/adapter/
 * renderer registries are exhaustive over the shared vocabularies, every extension-proof fixture is
 * built entirely from registered primitives, and a stored plan is immutable across a defaults change.
 *
 * The positive half - that six different shapes actually run through unchanged persistence and the
 * engine - is in ensemble-extension.test.ts.
 */

function src(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

// ---- no strategy branch anywhere execution or rendering happens ----

const STRATEGY_NEUTRAL_FILES = [
  "src/server/ensembles/engine.ts",
  "src/server/ensembles/manager.ts",
  "src/server/ensembles/store.ts",
  "src/server/ensembles/finalizers/index.ts",
  "src/server/ensembles/decisions/index.ts",
  "src/server/routes.ts",
  "src/web/useEventStream.ts",
  "src/web/components/session-bits.tsx",
];

test("no ensemble execution or SSE-reducer code branches on the best_of_n strategy id", () => {
  for (const file of STRATEGY_NEUTRAL_FILES) {
    const source = src(file);
    assert.equal(
      source.includes("best_of_n"),
      false,
      `${file} names best_of_n; execution and reduction must dispatch on driver keys, never a strategy id`,
    );
    assert.doesNotMatch(
      source,
      /strategyId\s*===\s*["']/,
      `${file} branches on a strategy id literal`,
    );
  }
});

test("the generic engine and the Workflow engine share no ensemble strategy or graph node", () => {
  const engine = src("src/server/ensembles/engine.ts");
  assert.doesNotMatch(engine, /switch\s*\(\s*[^)]*strateg/i, "the engine never switches on a strategy");

  // The Workflow graph accepts session/persona/join/end nodes only; an Ensemble node would force a
  // multi-subject binding. The trigger SOURCE `ensemble` is a different, allowed construct.
  const workflow = src("src/shared/workflow.ts");
  assert.doesNotMatch(workflow, /kind:\s*["']ensemble["']/, "the Workflow graph must have no ensemble node");
  const wfEngine = src("src/server/workflows/engine.ts");
  assert.equal(wfEngine.includes("ensembles/engine"), false, "the Workflow engine must not import the ensemble engine");
});

// ---- the extension surfaces are exhaustive over the shared vocabularies ----

test("driver, decision, finalizer and artifact registries are exhaustive over their shared tuples", () => {
  assert.deepEqual(Object.keys(REVIEW_DRIVERS).sort(), [...ENSEMBLE_DRIVER_KEYS].sort());
  assert.deepEqual(Object.keys(DECISION_DRIVERS).sort(), [...ENSEMBLE_DRIVER_KEYS].sort());
  assert.deepEqual(Object.keys(FINALIZERS).sort(), [...ENSEMBLE_DRIVER_KEYS].sort());
  assert.deepEqual(Object.keys(ARTIFACT_ADAPTERS).sort(), [...ENSEMBLE_ARTIFACT_KINDS].sort());
  // Each driver key is claimed by exactly the one kind of driver that runs it, null elsewhere.
  for (const key of ENSEMBLE_DRIVER_KEYS) {
    const implementations = [REVIEW_DRIVERS[key], DECISION_DRIVERS[key], FINALIZERS[key]].filter(Boolean).length;
    assert.ok(implementations <= 1, `${key} is implemented by more than one driver registry`);
  }
});

test("the strategy result renderer is the ONLY strategy-keyed surface, and it is web-only presentation", () => {
  const renderers = src("src/web/ensembles/results/index.ts");
  // The renderer registry is keyed by strategy id by design - it is the one allowed strategy-specific
  // seam. It must live in the web layer and hold no execution authority, so it imports no server code.
  assert.match(renderers, /Record<EnsembleStrategyId/);
  assert.doesNotMatch(
    renderers,
    /from\s+["'][^"']*\/server\//,
    "a result renderer is presentation, never execution - it must import no server module",
  );
});

// ---- every extension-proof fixture is built only from registered primitives ----

test("no extension-proof fixture introduces a new driver key, stage kind, or artifact kind", () => {
  const plans = [
    fx.fixedMatrixPlan([{ agent: "claude" }, { agent: "codex" }]),
    fx.successiveHalvingPlan(4, 2),
    fx.pairwisePlan(3),
    fx.panelPlan(3, 3),
    fx.synthesisPlan(3),
    fx.retainPlan(2),
    fx.adaptivePlan(2, 2),
  ];
  const driverKeys = new Set<string>(ENSEMBLE_DRIVER_KEYS);
  const stageKinds = new Set<string>(ENSEMBLE_STAGE_DRIVER_KINDS);
  const artifactKinds = new Set<string>(ENSEMBLE_ARTIFACT_KINDS);
  for (const plan of plans) {
    for (const stage of plan.stages) {
      assert.ok(driverKeys.has(stage.driverKey), `stage ${stage.id} uses unregistered driver ${stage.driverKey}`);
      assert.ok(stageKinds.has(stage.driverKind), `stage ${stage.id} uses unregistered kind ${stage.driverKind}`);
    }
    for (const roleSpec of plan.roles) {
      for (const kind of roleSpec.requiredArtifacts) {
        assert.ok(artifactKinds.has(kind), `role ${roleSpec.key} requires unregistered artifact ${kind}`);
      }
    }
  }
});

// ---- a stored plan is immutable across a descriptor defaults change ----

test("a compiled plan is deterministic and byte-stable, so a later defaults change cannot re-aim a run", () => {
  // Compilation is a pure function of its inputs: the same shape compiles byte-identically every
  // time, which is what lets recovery trust a stored snapshot rather than recompiling with today's
  // defaults. If a descriptor's defaults later move, an in-flight run keeps executing exactly this.
  const first = fx.pairwisePlan(3);
  const second = fx.pairwisePlan(3);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.strategyKey, "best_of_n@1");
  // No runtime id leaked into the plan - it is logical role/stage ids only, so two runs share it.
  assert.doesNotMatch(JSON.stringify(first), /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/, "no uuid in a compiled plan");
});
