import { test } from "node:test";
import assert from "node:assert/strict";

import {
  HARNESS_CAPABILITIES,
  type ModelDiscoverySpec,
} from "../src/shared/harness-capabilities.ts";
import { MODEL_CATALOG } from "../src/shared/model.ts";
import { AGENT_TYPES, type AgentType } from "../src/shared/types.ts";
import {
  HARNESS_MODEL_CATALOG_LIMITS,
  HarnessModelCatalogsSchema,
  type HarnessModelCatalogChoice,
  type HarnessModelCatalogProblem,
} from "../src/shared/protocol.ts";
import { HARNESSES } from "../src/server/harness/index.ts";
import {
  HarnessModelCatalogService,
  type ModelCatalogSpecs,
} from "../src/server/harness/model-catalog-service.ts";

const liveChoice: HarnessModelCatalogChoice = {
  id: "openai/gpt-5.6-sol",
  label: "GPT-5.6 Sol",
  hint: null,
  provider: "openai",
  contextWindow: 1_000_000,
  reasoning: true,
  inputModes: ["text", "image"],
};

function specs(piDiscover: ModelCatalogSpecs["pi"]["discover"]): ModelCatalogSpecs {
  return {
    claude: { shipped: MODEL_CATALOG.claude, discover: null },
    codex: { shipped: MODEL_CATALOG.codex, discover: null },
    pi: { shipped: MODEL_CATALOG.pi, discover: piDiscover },
  };
}

test("the shared response is exhaustive and rejects every bounded field outside its limit", () => {
  const catalog = {
    choices: [liveChoice],
    source: "live",
    refreshedAt: "2026-08-18T15:00:00.000Z",
    problem: null,
  } as const;
  const valid = { claude: { ...catalog, source: "shipped", refreshedAt: null }, codex: { ...catalog, source: "shipped", refreshedAt: null }, pi: catalog };
  assert.equal(HarnessModelCatalogsSchema.safeParse(valid).success, true);
  assert.equal(HarnessModelCatalogsSchema.safeParse({ ...valid, pi: undefined }).success, false);
  assert.equal(HarnessModelCatalogsSchema.safeParse({ ...valid, extra: catalog }).success, false);
  assert.equal(HarnessModelCatalogsSchema.safeParse({ ...valid, pi: { ...catalog, source: "remote" } }).success, false);
  assert.equal(HarnessModelCatalogsSchema.safeParse({ ...valid, pi: { ...catalog, problem: "raw_error" } }).success, false);
  assert.equal(HarnessModelCatalogsSchema.safeParse({ ...valid, pi: { ...catalog, refreshedAt: "last Tuesday" } }).success, false);

  const badChoices: Array<[string, unknown]> = [
    ["id", { ...liveChoice, id: "../../unsafe" }],
    ["long id", { ...liveChoice, id: `a/${"b".repeat(79)}` }],
    ["label", { ...liveChoice, label: "x".repeat(HARNESS_MODEL_CATALOG_LIMITS.labelChars + 1) }],
    ["hint", { ...liveChoice, hint: "x".repeat(HARNESS_MODEL_CATALOG_LIMITS.hintChars + 1) }],
    ["provider", { ...liveChoice, provider: "x".repeat(HARNESS_MODEL_CATALOG_LIMITS.providerChars + 1) }],
    ["zero contextWindow", { ...liveChoice, contextWindow: 0 }],
    ["negative contextWindow", { ...liveChoice, contextWindow: -1 }],
    ["fractional contextWindow", { ...liveChoice, contextWindow: 272_000.5 }],
    ["contextWindow", { ...liveChoice, contextWindow: HARNESS_MODEL_CATALOG_LIMITS.contextWindow + 1 }],
    ["inputModes", { ...liveChoice, inputModes: ["text", "audio"] }],
    ["excessive inputModes", { ...liveChoice, inputModes: ["text", "image", "text"] }],
  ];
  for (const [field, choice] of badChoices) {
    assert.equal(
      HarnessModelCatalogsSchema.safeParse({ ...valid, pi: { ...catalog, choices: [choice] } }).success,
      false,
      field,
    );
  }
  assert.equal(
    HarnessModelCatalogsSchema.safeParse({
      ...valid,
      pi: { ...catalog, choices: Array(HARNESS_MODEL_CATALOG_LIMITS.choices + 1).fill(liveChoice) },
    }).success,
    false,
  );
});

test("every harness explicitly owns shipped models and a discovery decision", () => {
  assert.deepEqual(Object.keys(HARNESSES).sort(), [...AGENT_TYPES].sort());
  for (const agent of AGENT_TYPES) {
    assert.deepEqual(HARNESSES[agent].models.shipped, MODEL_CATALOG[agent]);
    assert.equal("discover" in HARNESSES[agent].models, true);
  }
  // Claude is the one harness still on shipped rows, and deliberately so: its live rows
  // are account-shaped aliases, two of which `ModelIdSchema` rejects, so adopting them is
  // a persisted-vocabulary decision rather than a catalog refresh. See
  // `docs/plans/claude-codex-live-model-catalog/plan.md`.
  assert.equal(HARNESSES.claude.models.discover, null);
  assert.equal(typeof HARNESSES.codex.models.discover, "function");
  assert.equal(typeof HARNESSES.pi.models.discover, "function");
});

test("the browser's discovery flag and the server's probe are one fact in two files", () => {
  // The treatment `runtimes` / `sdk` and `resumes` / `resume` get. The browser draws the
  // catalog notice and its retry button from `discoversModels`, so a probe wired here
  // without the flag can never report its own failure, and a flag set without a probe
  // offers a retry that does nothing.
  for (const agent of AGENT_TYPES) {
    assert.equal(
      HARNESS_CAPABILITIES[agent].discoversModels,
      HARNESSES[agent].models.discover !== null,
      `${agent} disagrees about whether it discovers models`,
    );
  }
});

test("discovery and its sign-in sentence cannot disagree, because neither half compiles alone", () => {
  // The invariant that used to live in the assertion below, moved into the type. A
  // discovering harness answers with the models its signed-in accounts offer, so it can
  // report `unavailable` for no reason other than being signed out; without a sign-in
  // sentence the notice describes that state and offers only a retry, which is the one
  // action that cannot fix it. A harness on shipped rows has no catalog to be signed out
  // of and must not advertise an account for one.
  //
  // `ModelDiscoverySpec` discriminates on `discoversModels`, so BOTH nonsense
  // combinations are unrepresentable. These two directives are the test: if either
  // combination ever starts compiling, `tsc` fails the build on the unused
  // `@ts-expect-error` rather than waiting for anyone to run this file.
  // @ts-expect-error - discovery with no way to sign in would render a remedy-less notice
  const discoversWithoutSignIn: ModelDiscoverySpec = {
    discoversModels: true,
    modelProviderSignIn: null,
  };
  // @ts-expect-error - shipped rows cannot be signed out of, so a sentence here is a lie
  const signInWithoutDiscovery: ModelDiscoverySpec = {
    discoversModels: false,
    modelProviderSignIn: "run something login",
  };
  void discoversWithoutSignIn;
  void signInWithoutDiscovery;

  // The legal pair still type-checks, so the union refuses the invalid states rather than
  // simply being impossible to satisfy.
  const legal: readonly ModelDiscoverySpec[] = [
    { discoversModels: true, modelProviderSignIn: "open a Pi session and run /login" },
    { discoversModels: false, modelProviderSignIn: null },
  ];
  assert.equal(legal.length, 2);

  // And the shipped table populates both halves, which is what the browser reads.
  for (const agent of AGENT_TYPES) {
    const capabilities = HARNESS_CAPABILITIES[agent];
    if (capabilities.discoversModels) {
      // Narrowed to `string` by the discriminant - no null check is possible here.
      assert.ok(
        capabilities.modelProviderSignIn.length > 0,
        `${agent} discovers models but offers an empty sign-in sentence`,
      );
    } else {
      assert.equal(capabilities.modelProviderSignIn, null);
    }
  }
});

test("static harnesses never discover, while one successful Pi probe is cached fresh", async () => {
  let calls = 0;
  let now = Date.parse("2026-08-18T15:00:00.000Z");
  const service = new HarnessModelCatalogService({
    specs: specs(async () => {
      calls++;
      return { ok: true, choices: [liveChoice] };
    }),
    now: () => now,
    freshForMs: 60_000,
  });

  const first = await service.getCatalogs();
  assert.equal(calls, 1);
  assert.deepEqual(first.claude.choices, MODEL_CATALOG.claude.map((choice) => ({
    ...choice,
    provider: null,
    contextWindow: null,
    reasoning: null,
    inputModes: [],
  })));
  assert.equal(first.claude.source, "shipped");
  assert.equal(first.codex.source, "shipped");
  assert.equal(first.pi.source, "live");
  assert.equal(first.pi.refreshedAt, "2026-08-18T15:00:00.000Z");

  now += 20_000;
  const second = await service.getCatalogs();
  assert.equal(calls, 1);
  assert.equal(second.pi.source, "cached");
  assert.equal(second.pi.problem, null);
});

test("simultaneous reads and forced refreshes share one in-flight probe", async () => {
  let calls = 0;
  let announceStarted!: () => void;
  const started = new Promise<void>((resolve) => { announceStarted = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const service = new HarnessModelCatalogService({
    specs: specs(async () => {
      calls++;
      announceStarted();
      await gate;
      return { ok: true, choices: [liveChoice] };
    }),
  });

  const reads = [service.getCatalogs(), service.getCatalogs({ refresh: true }), service.getCatalogs()];
  await started;
  assert.equal(calls, 1);
  release();
  const results = await Promise.all(reads);
  assert.ok(results.every((result) => result.pi.source === "live"));
  assert.equal(calls, 1);
});

test("stopping the service aborts and drains its active discovery", async () => {
  let calls = 0;
  let observedSignal: AbortSignal | null = null;
  let announceStarted!: () => void;
  const started = new Promise<void>((resolve) => { announceStarted = resolve; });
  const service = new HarnessModelCatalogService({
    specs: specs(async (signal) => {
      calls++;
      observedSignal = signal;
      announceStarted();
      return await new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () => resolve({ ok: false, problem: "process_failed" }),
          { once: true },
        );
      });
    }),
  });

  const read = service.getCatalogs();
  await started;
  await service.stop();
  const result = await read;
  assert.equal((observedSignal as AbortSignal | null)?.aborted, true);
  assert.equal(result.pi.source, "fallback");
  assert.equal(result.pi.problem, "process_failed");

  const afterStop = await service.getCatalogs({ refresh: true });
  assert.equal(calls, 1, "a stopped service must not spawn another discovery child");
  assert.equal(afterStop.pi.source, "fallback");
});

test("failure returns shipped fallback before success and stale cache after success", async () => {
  let outcome: "failure" | "success" = "failure";
  let calls = 0;
  let now = Date.parse("2026-08-18T15:00:00.000Z");
  const service = new HarnessModelCatalogService({
    specs: specs(async () => {
      calls++;
      return outcome === "success"
        ? { ok: true, choices: [liveChoice] }
        : { ok: false, problem: "timeout" satisfies HarnessModelCatalogProblem };
    }),
    now: () => now,
  });

  const fallback = await service.getCatalogs();
  assert.equal(fallback.pi.source, "fallback");
  assert.equal(fallback.pi.problem, "timeout");
  assert.equal(fallback.pi.refreshedAt, null);
  assert.deepEqual(fallback.pi.choices.map((choice) => choice.id), MODEL_CATALOG.pi.map((choice) => choice.id));

  const fallbackAgain = await service.getCatalogs();
  assert.equal(fallbackAgain.pi.source, "fallback");
  assert.equal(calls, 2, "failed probes must not become fresh cache entries");

  outcome = "success";
  now += 1_000;
  const live = await service.getCatalogs({ refresh: true });
  assert.equal(live.pi.source, "live");
  assert.equal(calls, 3);

  outcome = "failure";
  now += 1_000;
  const stale = await service.getCatalogs({ refresh: true });
  assert.equal(stale.pi.source, "cached");
  assert.equal(stale.pi.problem, "timeout");
  assert.equal(stale.pi.refreshedAt, live.pi.refreshedAt);
  assert.deepEqual(stale.pi.choices, [liveChoice]);
  assert.equal(calls, 4);
});

test("an oversized discovered collection degrades to fallback or stale cache", async () => {
  const oversized = Array.from(
    { length: HARNESS_MODEL_CATALOG_LIMITS.choices + 1 },
    (_, index) => ({ ...liveChoice, id: `openai/model-${index}`, label: `Model ${index}` }),
  );
  const fallbackService = new HarnessModelCatalogService({
    specs: specs(async () => ({ ok: true, choices: oversized })),
  });
  const fallback = await fallbackService.getCatalogs();
  assert.equal(fallback.pi.source, "fallback");
  assert.equal(fallback.pi.problem, "invalid_response");
  assert.deepEqual(
    fallback.pi.choices.map((choice) => choice.id),
    MODEL_CATALOG.pi.map((choice) => choice.id),
  );

  let overLimit = false;
  const staleService = new HarnessModelCatalogService({
    specs: specs(async () => overLimit
      ? { ok: true, choices: oversized }
      : { ok: true, choices: [liveChoice] }),
  });
  const live = await staleService.getCatalogs();
  overLimit = true;
  const stale = await staleService.getCatalogs({ refresh: true });
  assert.equal(live.pi.source, "live");
  assert.equal(stale.pi.source, "cached");
  assert.equal(stale.pi.problem, "invalid_response");
  assert.deepEqual(stale.pi.choices, [liveChoice]);
});

test("an expired successful cache is replaced by the next valid result", async () => {
  let now = 1_000;
  let choice = liveChoice;
  let calls = 0;
  const service = new HarnessModelCatalogService({
    specs: specs(async () => {
      calls++;
      return { ok: true, choices: [choice] };
    }),
    now: () => now,
    freshForMs: 100,
  });
  await service.getCatalogs();
  choice = { ...liveChoice, id: "openai/gpt-5.6-terra", label: "GPT-5.6 Terra" };
  now += 101;
  const next = await service.getCatalogs();
  assert.equal(calls, 2);
  assert.equal(next.pi.choices[0]!.id, "openai/gpt-5.6-terra");
});

test("the service remains exhaustive when its specs are traversed generically", async () => {
  const seen: AgentType[] = [];
  const catalogSpecs = specs(async () => ({ ok: true, choices: [liveChoice] }));
  for (const agent of AGENT_TYPES) {
    const original = catalogSpecs[agent];
    catalogSpecs[agent] = {
      ...original,
      discover: original.discover && (async (signal) => {
        seen.push(agent);
        return original.discover!(signal);
      }),
    };
  }
  const service = new HarnessModelCatalogService({ specs: catalogSpecs });
  const result = await service.getCatalogs();
  assert.deepEqual(Object.keys(result), [...AGENT_TYPES]);
  assert.deepEqual(seen, ["pi"]);
});
