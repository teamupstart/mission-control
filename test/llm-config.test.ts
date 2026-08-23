import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake: the LLM config is the one blob two PROCESSES read - the daemon resolves
// its background jobs from it, and the Foreman worker reads the runner off a route backed by
// it. So the two things that must hold are the ones a single-reader config never has to
// think about.
//
// First, a stored value this build cannot resolve must DEGRADE, not throw. `getLlmConfig` is
// on the path of every titling, every goal refresh, every digest and the settings route; a
// schema that rejected a runner id from a newer build would take all of them down over a
// preference, and a downgrade is an ordinary thing to do.
//
// Second, a patch merges the model map PER KEY. Two dashboards are the normal case, and a
// replacing write means the second tab's stale map silently clears an override the first tab
// just typed. The PATCH schema is strict where the config's is tolerant, for the opposite
// reason: a typo from the panel should be a refusal the operator can read, not a key that
// sits in the blob forever doing nothing.
//
// Real db, so the round-trip through zod's defaults is exercised rather than mocked.

const home = mkdtempSync(join(tmpdir(), "mission-llm-cfg-"));
// Set before importing anything that resolves the state dir.
process.env.HARNESS_HOME = join(home, "state");

const { openDb, setAppConfig } = await import("../src/server/db.ts");
const {
  claudeTransportChoice,
  codexTransportChoice,
  getLlmConfig,
  llmJobModel,
  llmJobRunner,
  llmRunnerChoice,
  setLlmConfig,
} = await import("../src/server/llm/config.ts");
// From `./status.ts`, not `./config.ts`: the status assembles the provider LIST, which is the
// one thing that needs every adapter loaded, and the resolvers deliberately do not.
const { llmStatus } = await import("../src/server/llm/status.ts");
const { LLM_JOB_IDS, LLM_JOB_SPECS } = await import("../src/shared/llm-jobs.ts");
const {
  CLAUDE_TRANSPORT_ENV_VAR,
  CLAUDE_TRANSPORTS,
  CODEX_TRANSPORT_ENV_VAR,
  CODEX_TRANSPORTS,
  DEFAULT_CLAUDE_TRANSPORT,
  DEFAULT_CODEX_TRANSPORT,
  DEFAULT_LLM_RUNNER_ID,
  LLM_RUNNER_IDS,
} = await import(
  "../src/shared/llm.ts"
);
const { LlmConfigPatchSchema } = await import("../src/shared/protocol.ts");
const { MODEL_CATALOG } = await import("../src/shared/model.ts");

after(() => rmSync(home, { recursive: true, force: true }));

beforeEach(() => {
  openDb().exec("DELETE FROM app_config");
  for (const job of LLM_JOB_IDS) delete process.env[LLM_JOB_SPECS[job].envVar];
  delete process.env.MISSION_LLM_RUNNER;
  delete process.env.MISSION_CLAUDE_TRANSPORT;
});

test("an unconfigured daemon uses the shipped runner, SDK transport, and model defaults", () => {
  assert.equal(llmRunnerChoice().id, DEFAULT_LLM_RUNNER_ID);
  assert.equal(DEFAULT_CLAUDE_TRANSPORT, "sdk");
  assert.equal(claudeTransportChoice(), DEFAULT_CLAUDE_TRANSPORT);
  for (const job of LLM_JOB_IDS) {
    const resolved = llmJobModel(job);
    assert.equal(resolved.id, LLM_JOB_SPECS[job].fallback, job);
    assert.equal(resolved.source, "default", job);
  }
});

test("Claude transport resolves config, then env, then the SDK default", () => {
  process.env.MISSION_CLAUDE_TRANSPORT = "print";
  assert.equal(claudeTransportChoice(), "print", "the environment fallback was ignored");

  setLlmConfig({ claudeTransport: "sdk" });
  assert.equal(claudeTransportChoice(), "sdk", "the stored choice must beat the environment");

  setLlmConfig({ claudeTransport: "print" });
  assert.equal(claudeTransportChoice(), "print", "print must remain a pinnable escape hatch");
});

test("an unknown Claude transport degrades to the shipped default", () => {
  setAppConfig("llm", { claudeTransport: "future-wire", models: {} });
  assert.doesNotThrow(() => getLlmConfig());
  assert.equal(getLlmConfig().claudeTransport, "");
  assert.equal(claudeTransportChoice(), DEFAULT_CLAUDE_TRANSPORT);

  process.env.MISSION_CLAUDE_TRANSPORT = "future-wire";
  assert.equal(claudeTransportChoice(), DEFAULT_CLAUDE_TRANSPORT);
});

/**
 * What is at stake: the Codex transport is a choice about how a reply is PARSED, never about
 * what is executed - the SDK spawns the same binary. So the shipped default must stay `exec`,
 * and an unreadable stored value must degrade to it rather than take every background job
 * down. Same ladder, same tolerance, and asserted separately from Claude's so a change to one
 * cannot quietly move the other.
 */
test("Codex transport resolves config, then env, then the exec default", () => {
  assert.equal(DEFAULT_CODEX_TRANSPORT, "exec", "the shipped path must remain the default");
  assert.equal(codexTransportChoice(), DEFAULT_CODEX_TRANSPORT);

  process.env.MISSION_CODEX_TRANSPORT = "sdk";
  assert.equal(codexTransportChoice(), "sdk", "the environment fallback was ignored");

  setLlmConfig({ codexTransport: "exec" });
  assert.equal(codexTransportChoice(), "exec", "the stored choice must beat the environment");

  setLlmConfig({ codexTransport: "sdk" });
  assert.equal(codexTransportChoice(), "sdk");
  delete process.env.MISSION_CODEX_TRANSPORT;
});

test("an unknown Codex transport degrades to the shipped default", () => {
  setAppConfig("llm", { codexTransport: "future-wire", models: {} });
  assert.doesNotThrow(() => getLlmConfig());
  assert.equal(getLlmConfig().codexTransport, "");
  assert.equal(codexTransportChoice(), DEFAULT_CODEX_TRANSPORT);

  process.env.MISSION_CODEX_TRANSPORT = "future-wire";
  assert.equal(codexTransportChoice(), DEFAULT_CODEX_TRANSPORT);
  delete process.env.MISSION_CODEX_TRANSPORT;
});

test("a model override is stored and resolves as `config`", () => {
  setLlmConfig({ models: { goal: "claude-sonnet-5" } });
  assert.equal(llmJobModel("goal").id, "claude-sonnet-5");
  assert.equal(llmJobModel("goal").source, "config");
  // The others are untouched by a write that named one job.
  assert.equal(llmJobModel("task-title").source, "default");
});

test("Codex background-job defaults are persisted and provider-compatible", () => {
  setLlmConfig({ runner: "codex", models: { goal: "" } });
  assert.equal(getLlmConfig().runner, "codex");
  assert.deepEqual(llmJobModel("goal"), {
    job: "goal",
    id: "gpt-5.6-luna",
    source: "default",
    unsupported: null,
  });
});

test("the model map merges per key, so two panels editing different jobs commute", () => {
  setLlmConfig({ models: { goal: "a" } });
  setLlmConfig({ models: { "task-title": "b" } });
  const cfg = getLlmConfig();
  assert.equal(cfg.models.goal, "a", "a later write cleared an earlier, unrelated one");
  assert.equal(cfg.models["task-title"], "b");
});

test("an empty string is stored, and means 'go back to the ladder'", () => {
  setLlmConfig({ models: { goal: "claude-sonnet-5" } });
  setLlmConfig({ models: { goal: "" } });
  assert.equal(getLlmConfig().models.goal, "", "a cleared box must not be dropped from the patch");
  assert.equal(llmJobModel("goal").id, LLM_JOB_SPECS.goal.fallback);
  assert.equal(llmJobModel("goal").source, "default");
});

test("an env var outranks the shipped default and is reported as such", () => {
  process.env[LLM_JOB_SPECS.goal.envVar] = "claude-opus-4-8";
  const resolved = llmJobModel("goal");
  assert.equal(resolved.id, "claude-opus-4-8");
  // The SOURCE is what the panel prints under an empty box - the one thing an empty greyed
  // field cannot tell you is whether it is a shipped default or an env var overriding it.
  assert.equal(resolved.source, "env");
});

test("a config override still beats the env var", () => {
  process.env[LLM_JOB_SPECS.goal.envVar] = "from-env";
  setLlmConfig({ models: { goal: "from-config" } });
  assert.equal(llmJobModel("goal").id, "from-config");
});

test("a stored runner this build cannot resolve degrades instead of throwing", () => {
  // Written straight to the KV, as a newer build (or a hand edit) would leave it. Every
  // reader below is on a hot path; a throw here is a daemon that cannot title a dispatch.
  setAppConfig("llm", { runner: "ollama", models: { goal: "claude-sonnet-5" } });
  assert.doesNotThrow(() => getLlmConfig());
  assert.equal(llmRunnerChoice().id, DEFAULT_LLM_RUNNER_ID);
  // ...and the rest of the blob survives the one field that could not be read.
  assert.equal(llmJobModel("goal").id, "claude-sonnet-5");
});

test("a stored models map of the wrong shape degrades instead of throwing", () => {
  setAppConfig("llm", { models: "not an object" });
  assert.doesNotThrow(() => getLlmConfig());
  assert.equal(llmJobModel("goal").id, LLM_JOB_SPECS.goal.fallback);
});

test("the PATCH refuses what the config tolerates, so a typo is answerable", () => {
  // The panel writes through this. Tolerating an unknown job here would store a key that
  // never resolves - a control that appears to work and does nothing.
  assert.equal(LlmConfigPatchSchema.safeParse({ models: { "not-a-job": "x" } }).success, false);
  assert.equal(LlmConfigPatchSchema.safeParse({ runner: "ollama" }).success, false);
  assert.equal(LlmConfigPatchSchema.safeParse({ claudeTransport: "future-wire" }).success, false);
  assert.equal(LlmConfigPatchSchema.safeParse({}).success, false, "an empty patch says nothing");
  assert.equal(LlmConfigPatchSchema.safeParse({ runner: LLM_RUNNER_IDS[0] }).success, true);
  assert.equal(LlmConfigPatchSchema.safeParse({ runner: "" }).success, true, "clearing the pick");
  for (const transport of CLAUDE_TRANSPORTS) {
    assert.equal(LlmConfigPatchSchema.safeParse({ claudeTransport: transport }).success, true);
  }
  assert.equal(
    LlmConfigPatchSchema.safeParse({ claudeTransport: "" }).success,
    true,
    "clearing the transport pick",
  );
  assert.equal(LlmConfigPatchSchema.safeParse({ models: { goal: "" } }).success, true);
});

test("the status route carries every job, the runner, and the providers this build has", () => {
  const status = llmStatus();
  assert.deepEqual(Object.keys(status.models).sort(), [...LLM_JOB_IDS].sort());
  assert.deepEqual(
    status.runners.map((r) => r.id),
    [...LLM_RUNNER_IDS],
  );
  // A LABEL, not just an id: the browser cannot import a runner implementation to find one.
  for (const r of status.runners) assert.ok(r.label.trim().length > 0, `${r.id} has no label`);
  assert.equal(status.runner.id, DEFAULT_LLM_RUNNER_ID);
  assert.equal(status.claudeTransport, DEFAULT_CLAUDE_TRANSPORT);

  setLlmConfig({ claudeTransport: "sdk" });
  assert.equal(llmStatus().claudeTransport, "sdk", "the resolved transport did not reach status");
});

// ---- A provider per background job ----
//
// What is at stake: the five jobs were the only model slots in the product with no provider
// of their own, so "run the Goal job on Claude while Workflow context runs on Codex" was
// unsayable - and the workaround the panel used, wiping every model box whenever the app-wide
// radio moved, was the only thing keeping a stored `claude-*` id from being handed to `codex`.
// Removing that wipe is what makes the pair able to disagree, so every assertion below is
// about a way the two halves can drift apart and what says so out loud.

test("a job runs on its own provider, and its neighbours do not move", () => {
  setLlmConfig({ runners: { goal: "codex" } });
  assert.equal(llmJobRunner("goal").id, "codex");
  assert.equal(llmJobRunner("goal").source, "config");
  for (const job of LLM_JOB_IDS.filter((j) => j !== "goal")) {
    assert.equal(llmJobRunner(job).id, DEFAULT_LLM_RUNNER_ID, `${job} followed goal's override`);
  }
  // ...and the MODEL re-bases onto that provider, or the job spawns Codex with a Claude id.
  assert.equal(llmJobModel("goal").id, "gpt-5.6-luna");
  assert.equal(llmJobModel("task-title").id, "claude-haiku-4-5");
});

test("an unset job resolves exactly as it did before any of this existed", () => {
  setLlmConfig({ runner: "codex" });
  for (const job of LLM_JOB_IDS) {
    assert.equal(llmJobRunner(job).id, "codex", job);
    assert.equal(llmJobRunner(job).source, llmRunnerChoice().source, job);
  }
});

test("the per-job ladder is the job's override, then app-wide, then the shipped default", () => {
  assert.equal(llmJobRunner("goal").id, DEFAULT_LLM_RUNNER_ID);
  setLlmConfig({ runner: "codex" });
  assert.equal(llmJobRunner("goal").id, "codex", "the app-wide rung was skipped");
  setLlmConfig({ runners: { goal: "claude" } });
  assert.equal(llmJobRunner("goal").id, "claude", "the job's own rung must outrank app-wide");
});

test("the runners map merges per key, so two panels editing different jobs commute", () => {
  setLlmConfig({ runners: { goal: "codex" } });
  setLlmConfig({ runners: { "task-title": "claude" } });
  const cfg = getLlmConfig();
  assert.equal(cfg.runners.goal, "codex", "a later write cleared an earlier, unrelated one");
  assert.equal(cfg.runners["task-title"], "claude");
});

test("an unreadable per-job override is REPORTED, and inherits rather than dropping to the default", () => {
  // The rungs beneath an override this build cannot read are the rest of the ladder, not the
  // bottom of it: "I cannot read your choice here" is much closer to "you did not choose
  // here" than to "use whatever ships".
  setAppConfig("llm", { runner: "codex", runners: { goal: "ollama" } });
  assert.doesNotThrow(() => getLlmConfig());
  const resolved = llmJobRunner("goal");
  assert.equal(resolved.unknown, "ollama", "a dropped choice must not be silently swallowed");
  assert.equal(resolved.id, "codex", "it inherited the shipped default instead of app-wide");
});

test("an unreadable APP-WIDE provider is reported too, which the old enum schema could not do", () => {
  // Pre-existing and closed on the way past: `.catch("")` sanitised the stored id before
  // `resolveLlmRunner` saw it, the ladder skips an empty value, and the `unknown` branch was
  // dead for every stored value - so the panel printed the fallback as the operator's choice
  // while the field's own comment promised the opposite.
  setAppConfig("llm", { runner: "ollama" });
  const resolved = llmRunnerChoice();
  assert.equal(resolved.unknown, "ollama");
  assert.equal(resolved.id, DEFAULT_LLM_RUNNER_ID);
});

test("one unreadable entry leaves every OTHER slot's override intact", () => {
  // A record-level `.catch` is all or nothing. One id a build cannot read used to discard the
  // whole map, silently, which is indistinguishable from never having configured anything.
  setAppConfig("llm", {
    runners: { goal: "ollama", "task-title": "codex" },
    models: { goal: "not a valid model id!!", "task-title": "gpt-5.6-sol" },
  });
  const cfg = getLlmConfig();
  assert.equal(cfg.runners["task-title"], "codex", "a neighbour's provider was discarded");
  assert.equal(cfg.models["task-title"], "gpt-5.6-sol", "a neighbour's model was discarded");
  assert.equal(cfg.models.goal, "", "the malformed id recovered to inherit rather than persisting");
  assert.equal(llmJobModel("task-title").id, "gpt-5.6-sol");
});

test("a NON-STRING persisted override recovers that entry instead of taking getLlmConfig down", () => {
  // The difference between a `.catch` on the value and no `.catch` at all. `getLlmConfig` is
  // on the path of every titling, goal refresh, digest and the settings route; a throw here
  // is a daemon that cannot do its own bookkeeping, over a hand edit.
  setAppConfig("llm", { runners: { goal: 7, "task-title": "codex" }, models: { goal: null } });
  assert.doesNotThrow(() => getLlmConfig());
  assert.equal(getLlmConfig().runners.goal, "");
  assert.equal(getLlmConfig().runners["task-title"], "codex");
  assert.equal(llmJobRunner("goal").id, DEFAULT_LLM_RUNNER_ID);
  assert.equal(llmJobRunner("goal").unknown, null, "corruption is recovered from, not reported");
});

test("a legacy config's models are pinned to the OUTGOING provider when the app-wide radio moves", () => {
  // The upgrade case. Before this change a saved model was implicitly bound to the app-wide
  // runner, because the panel wiped the map whenever that runner changed. With the wipe gone,
  // the moment the radio moves is the only moment that provenance is both needed and still
  // knowable.
  setAppConfig("llm", { runner: "claude", models: { goal: "claude-sonnet-5" }, runners: {} });
  setLlmConfig({ runner: "codex" });
  const cfg = getLlmConfig();
  assert.equal(cfg.runners.goal, "claude", "a deliberate Claude model was carried over to Codex");
  assert.equal(cfg.models.goal, "claude-sonnet-5", "the model itself must survive untouched");
  assert.equal(llmJobRunner("goal").id, "claude");
  assert.equal(llmJobModel("goal").id, "claude-sonnet-5");
  // A job with nothing to preserve is left alone rather than acquiring a pin it never asked for.
  assert.equal(cfg.runners["task-title"], undefined);
  assert.equal(llmJobRunner("task-title").id, "codex");
});

test("the pin uses the RESOLVED outgoing provider, so an env-driven installation pins correctly", () => {
  // The stored field is empty on an installation driven by `MISSION_LLM_RUNNER`; pinning what
  // it says would record "" and preserve nothing.
  process.env.MISSION_LLM_RUNNER = "codex";
  setAppConfig("llm", { runner: "", models: { goal: "gpt-5.6-sol" }, runners: {} });
  setLlmConfig({ runner: "claude" });
  assert.equal(getLlmConfig().runners.goal, "codex");
  delete process.env.MISSION_LLM_RUNNER;
});

test("a model pinned to one provider survives an app-wide provider change", () => {
  setLlmConfig({ runners: { goal: "claude" }, models: { goal: "claude-sonnet-5" } });
  setLlmConfig({ runner: "codex" });
  assert.equal(getLlmConfig().models.goal, "claude-sonnet-5", "the app-wide radio cleared a pin");
  assert.equal(llmJobModel("goal").id, "claude-sonnet-5");
  // Only the Inherit slots re-resolved.
  assert.equal(llmJobModel("task-title").id, "gpt-5.6-luna");
});

test("a model belonging to another provider falls back to that provider's default, and says so", () => {
  // Reachable with no config write at all: `MISSION_LLM_RUNNER` moving between daemon restarts
  // shifts the effective provider under a saved model, which is why the guard lives at
  // resolution rather than in the write path. Broken on the build before this one, too.
  setAppConfig("llm", { runners: { goal: "codex" }, models: { goal: "claude-sonnet-5" } });
  const resolved = llmJobModel("goal");
  assert.equal(resolved.id, "gpt-5.6-luna", "Codex was handed a Claude model id");
  assert.equal(resolved.unsupported, "claude-sonnet-5", "the dropped id must be reported");
  assert.equal(resolved.source, "default", "a substituted default must not be credited to config");
});

test("an id in NO catalog passes through untouched, because model ids are free text", () => {
  // The guard acts only on an id positively known to belong to another provider. A new or
  // custom id is not that, and rejecting it would be the worse failure of the two.
  setLlmConfig({ runners: { goal: "codex" }, models: { goal: "gpt-6-unreleased" } });
  const resolved = llmJobModel("goal");
  assert.equal(resolved.id, "gpt-6-unreleased");
  assert.equal(resolved.unsupported, null);
  assert.equal(resolved.source, "config");
});

test("no reachable pair reaches a runner that cannot honour it", () => {
  // The exit criterion, swept: every combination of a stored provider and a stored model from
  // the other provider's catalog resolves to something the resolved provider actually offers.
  for (const provider of LLM_RUNNER_IDS) {
    for (const other of LLM_RUNNER_IDS) {
      for (const choice of MODEL_CATALOG[other]) {
        setAppConfig("llm", { runners: { goal: provider }, models: { goal: choice.id } });
        const resolved = llmJobModel("goal");
        assert.ok(
          MODEL_CATALOG[provider].some((c) => c.id === resolved.id),
          `${provider} was left holding ${resolved.id}`,
        );
      }
    }
  }
});

test("the status route carries each job's provider beside its model, and Foreman's three fields still parse", () => {
  setLlmConfig({ runners: { goal: "codex" } });
  const status = llmStatus();
  assert.deepEqual(Object.keys(status.jobRunners).sort(), [...LLM_JOB_IDS].sort());
  assert.equal(status.jobRunners.goal.id, "codex");
  assert.equal(status.jobRunners["task-title"].id, DEFAULT_LLM_RUNNER_ID);
  assert.equal(status.models.goal.id, "gpt-5.6-luna", "the per-job model must use the per-job provider");
  // Foreman reads exactly these three off this payload from another process; widening the
  // shape must not move them.
  assert.equal(status.runner.id, DEFAULT_LLM_RUNNER_ID, "the app-wide runner must stay app-wide");
  assert.ok(typeof status.claudeTransport === "string");
  assert.ok(typeof status.codexTransport === "string");
});

test("the runners PATCH refuses what the config tolerates", () => {
  assert.equal(LlmConfigPatchSchema.safeParse({ runners: { goal: "codex" } }).success, true);
  assert.equal(LlmConfigPatchSchema.safeParse({ runners: { goal: "" } }).success, true, "clearing");
  assert.equal(LlmConfigPatchSchema.safeParse({ runners: { goal: "ollama" } }).success, false);
  assert.equal(LlmConfigPatchSchema.safeParse({ runners: { "not-a-job": "codex" } }).success, false);
});

/**
 * What is at stake: both transports are chosen by an environment variable an operator types
 * into a shell, and a variable nobody can find is a variable nobody can use. The project
 * standard is that a configuration change lands with its documentation in the same commit - a
 * rule that is only worth anything if something notices when it is skipped, which nothing did
 * when the Codex transport first shipped.
 *
 * BOTH files, because they answer different questions and a reader arrives at only one of
 * them: `README.md` is where someone deciding whether to touch this at all looks, and
 * `docs/configuration.md` is the exhaustive table someone already reaching for the variable
 * looks. Documenting a transport in one and not the other is the failure that was reviewed
 * here, not a lesser version of it.
 *
 * Pinned for BOTH transports rather than only the newer one: the defect this guards is "a
 * transport shipped undocumented", and asserting it asymmetrically would leave the next one to
 * be caught by a human again.
 */
test("every headless transport env var is documented where an operator would look", () => {
  const pages = ["../README.md", "../docs/configuration.md"];
  for (const page of pages) {
    const doc = readFileSync(new URL(page, import.meta.url), "utf8");
    for (const name of [CLAUDE_TRANSPORT_ENV_VAR, CODEX_TRANSPORT_ENV_VAR]) {
      assert.ok(
        doc.includes(`\`${name}\``),
        `${name} selects a transport but ${page.replace("../", "")} never names it`,
      );
    }
  }
});

/**
 * The values and the default, not just the variable name. A page that names
 * `MISSION_CODEX_TRANSPORT` without saying what may be put in it, or which value holds when
 * nobody sets it, has documented that a knob exists and nothing an operator can act on.
 */
test("the readme names every transport value and which one ships as the default", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  for (const value of [...CLAUDE_TRANSPORTS, ...CODEX_TRANSPORTS]) {
    assert.ok(readme.includes(`\`${value}\``), `README.md never names the \`${value}\` transport`);
  }
  assert.ok(
    readme.includes("`llm.codexTransport`"),
    "README.md does not say where a Codex transport choice is stored",
  );
  assert.ok(
    readme.includes("`llm.claudeTransport`"),
    "README.md does not say where a Claude transport choice is stored",
  );
  // The defaults ride in the table's own cells, so pin the rows rather than the bare words -
  // "`sdk`" appears as a selectable value for both providers and proves nothing on its own.
  assert.match(
    readme,
    /\| Codex \|[^\n]*\| `exec` \|\s*$/m,
    `README.md must show ${DEFAULT_CODEX_TRANSPORT} as the shipped Codex default`,
  );
  assert.match(
    readme,
    /\| Claude \|[^\n]*\| `sdk` \|\s*$/m,
    `README.md must show ${DEFAULT_CLAUDE_TRANSPORT} as the shipped Claude default`,
  );
});
