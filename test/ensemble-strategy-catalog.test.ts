import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { ENSEMBLE_PLAN_VERSION, ENSEMBLE_STRATEGY_IDS } from "../src/shared/ensemble.ts";
import {
  ENSEMBLE_STRATEGY_INFO,
  creatableStrategies,
  knownStrategyId,
  strategyLabelFor,
} from "../src/shared/ensemble-strategies.ts";
import {
  ENSEMBLE_STRATEGIES,
  creatableStrategyDescriptors,
  defineStrategy,
  descriptorFor,
  strategyFor,
  type StrategyCatalog,
} from "../src/server/ensembles/strategies/index.ts";

/**
 * What is at stake: the catalog is the thing that stops execution code from ever asking
 * "is this Best-of-N?". Two failures it has to make impossible:
 *
 *  1. A strategy id with no descriptor, or a descriptor filed under someone else's id.
 *     Either one means a run that can be created and never compiled, or compiled by the
 *     wrong thing - and typecheck alone cannot catch the second.
 *  2. A lookup that falls back to "the only strategy we have" when an id is unknown. That
 *     is exactly how a run written by a newer build would be executed as something else.
 */

test("every strategy id has exactly one descriptor, filed under its own id", () => {
  for (const id of ENSEMBLE_STRATEGY_IDS) {
    const descriptor = ENSEMBLE_STRATEGIES[id];
    assert.ok(descriptor, `${id} has no descriptor`);
    assert.equal(descriptor.id, id, `${id} is filed under the wrong key`);
  }
  assert.deepEqual(Object.keys(ENSEMBLE_STRATEGIES).sort(), [...ENSEMBLE_STRATEGY_IDS].sort());
});

test("no descriptor claims an id that is not in the shared tuple", () => {
  for (const descriptor of Object.values(ENSEMBLE_STRATEGIES)) {
    assert.ok(
      (ENSEMBLE_STRATEGY_IDS as readonly string[]).includes(descriptor.id),
      `${descriptor.id} is not a registered strategy id`,
    );
  }
});

test("the server descriptor and the browser-safe half describe the same strategy", () => {
  // The two records exist so the dashboard can render a strategy it cannot import. They must
  // not become two different answers - the reason the descriptor spreads the info in rather
  // than restating a label.
  for (const id of ENSEMBLE_STRATEGY_IDS) {
    const info = ENSEMBLE_STRATEGY_INFO[id];
    const descriptor = ENSEMBLE_STRATEGIES[id];
    assert.equal(descriptor.label, info.label);
    assert.equal(descriptor.blurb, info.blurb);
    assert.equal(descriptor.explanation, info.explanation);
    assert.equal(descriptor.currentVersion, info.currentVersion);
    assert.equal(descriptor.enabled, info.enabled);
    assert.deepEqual(descriptor.capabilities, info.capabilities);
    assert.deepEqual(descriptor.form, info.form);
  }
});

test("a descriptor compiles the version its form advertises", () => {
  for (const id of ENSEMBLE_STRATEGY_IDS) {
    const descriptor = ENSEMBLE_STRATEGIES[id];
    assert.equal(
      descriptor.compilesVersion,
      descriptor.currentVersion,
      `${id} advertises v${descriptor.currentVersion} and compiles v${descriptor.compilesVersion}`,
    );
  }
});

test("an unknown id resolves to null and never to the one strategy this build has", () => {
  assert.equal(strategyFor("best_of_n")?.id, "best_of_n");
  assert.equal(strategyFor("tournament"), null);
  assert.equal(strategyFor("__proto__"), null);
  assert.equal(strategyFor("constructor"), null);
  assert.equal(knownStrategyId("tournament"), null);
  assert.equal(knownStrategyId(null), null);
});

test("a strategy from a newer build is labelled by what it says it is, not by ours", () => {
  assert.equal(strategyLabelFor("best_of_n", "raw"), "Best of N");
  // Falling back to "Best of N" here would tell the operator a run is something it is not.
  assert.equal(strategyLabelFor("tournament", "tournament@3"), "tournament@3");
});

test("only enabled strategies are offered for creation, on both halves of the split", () => {
  assert.deepEqual(
    creatableStrategies().map((info) => info.id),
    creatableStrategyDescriptors().map((descriptor) => descriptor.id),
  );
});

test("every strategy's form addresses fields that exist in its own config", () => {
  for (const id of ENSEMBLE_STRATEGY_IDS) {
    const descriptor = ENSEMBLE_STRATEGIES[id];
    const defaults = descriptor.configSchema.parse({}) as Record<string, unknown>;
    for (const field of descriptor.form.fields) {
      let cursor: unknown = defaults;
      for (const segment of field.key.split(".")) {
        assert.ok(
          cursor !== null && typeof cursor === "object" && segment in (cursor as object),
          `${id}: form field ${field.key} does not exist in its config`,
        );
        cursor = (cursor as Record<string, unknown>)[segment];
      }
    }
  }
});

test("an estimate is refused rather than invented for a config that would not validate", () => {
  const descriptor = ENSEMBLE_STRATEGIES.best_of_n;
  assert.ok(descriptor.estimate({}));
  // The number an operator reads before pressing a button that launches local agents.
  assert.equal(descriptor.estimate({ members: [] }), null);
  assert.equal(descriptor.estimate("nonsense"), null);
});

// ---- extension proof ----

test("a catalog can register a descriptor without appending a test id to the production tuple", () => {
  // The reason `StrategyCatalog` is generic over its key. A test - or a later plugin - builds
  // its own catalog, while the production record stays exhaustive over `EnsembleStrategyId`
  // and still fails typecheck the moment a real id is added with nothing to compile it.
  const fake = defineStrategy<{ size: number }>({
    id: "best_of_n",
    currentVersion: 7,
    compilesVersion: 7,
    label: "Fake",
    blurb: "b",
    explanation: "e",
    enabled: false,
    capabilities: {
      singleSessionFinalization: false,
      sharesArtifacts: true,
      requiresHumanDecision: true,
      artifactKinds: ["summary"],
      launchShape: "adaptive",
    },
    configSchema: z.object({ size: z.number().int().min(1).max(3).default(1) }),
    form: { fields: [] },
    estimate: () => null,
    compile: (config) => ({
      ok: true,
      config: { size: config.size },
      plan: {
        planVersion: ENSEMBLE_PLAN_VERSION,
        strategyKey: "fake@7",
        budget: {
          maxMembers: config.size,
          maxConcurrentMembers: 1,
          maxWaves: 1,
          maxStageAttempts: 1,
          deadlineMs: null,
        },
        information: { kind: "isolated" },
        roles: [
          {
            key: "r1",
            label: "R1",
            ordinal: 1,
            wave: 1,
            agent: null,
            model: null,
            effort: null,
            approach: null,
            promptTemplate: "",
            requiredArtifacts: ["summary"],
            input: { kind: "run_base" },
          },
        ],
        stages: [
          {
            id: "s1",
            ordinal: 1,
            label: "S1",
            driverKind: "member",
            driverKey: "member_wave@1",
            dependsOn: [],
            barrier: { kind: "none" },
            maxAttempts: 1,
            wave: 1,
            roleKeys: ["r1"],
          },
        ],
      },
    }),
  });

  const catalog: StrategyCatalog<"fixture"> = { fixture: fake };
  assert.equal(descriptorFor(catalog, "fixture")?.label, "Fake");
  assert.equal(descriptorFor(catalog, "best_of_n"), null);
  assert.equal(descriptorFor(catalog, "toString"), null);
});

test("erasure parses through the descriptor's own schema and reports the failing path", () => {
  const fake = defineStrategy<{ size: number }>({
    id: "best_of_n",
    currentVersion: 1,
    compilesVersion: 1,
    label: "Fake",
    blurb: "b",
    explanation: "e",
    enabled: false,
    capabilities: {
      singleSessionFinalization: false,
      sharesArtifacts: false,
      requiresHumanDecision: true,
      artifactKinds: [],
      launchShape: "fixed",
    },
    configSchema: z.object({ size: z.number().int().min(2) }),
    form: { fields: [] },
    estimate: () => null,
    compile: () => ({ ok: false, issues: [] }),
  });
  const result = fake.compile({ size: 1 }, { repoRoot: "/repo", personas: new Map(), now: 0 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.issues[0]?.path, "size");
});
