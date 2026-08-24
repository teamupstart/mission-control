import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_CONFIG_ENTRIES } from "../src/shared/app-config-entries.ts";

// What is at stake: Foreman's four roles no longer share one provider, and two processes have
// to agree about which one each of them got. The daemon resolves it for the panel; the worker
// resolves it again in its own process off a config it fetched over HTTP and an app-wide answer
// it read off a route. A disagreement is not cosmetic - the panel would print one provider while
// the worker spent another operator's account.
//
// The ladder is three rungs where a background job has two, so the tests below are mostly about
// the middle one: a role's own choice, then Foreman's group-level `runner`, then the app-wide
// answer (config, then `MISSION_LLM_RUNNER`, then the shipped default).
//
// Two of these are REGRESSION tests for bugs that existed before this feature. Foreman's panel
// used to clear all four model boxes when its own provider select moved, which kept a pair valid
// only while Foreman had a provider of its own - an unset one inherited the app-wide value, whose
// radio is on a different page where that clearing never fired. And the Inspector resolved an
// unset provider to a literal `claude`, making it the one subsystem that ignored the app-wide
// setting and `MISSION_LLM_RUNNER` entirely.
//
// Real db, so the round-trip through zod's defaults and the persisted blob is exercised.

const home = mkdtempSync(join(tmpdir(), "mission-foreman-providers-"));
// Set before importing anything that resolves the state dir.
process.env.HARNESS_HOME = join(home, "state");

const { openDb, setAppConfig } = await import("../src/server/db.ts");
const {
  foremanGroupRunner,
  foremanGroupRunnerResolved,
  foremanRoleRunner,
  getForemanConfig,
  setForemanConfig,
} = await import("../src/server/foreman/config.ts");
const { getInspectorConfig, inspectorModel, inspectorRunner, setInspectorConfig } = await import(
  "../src/server/inspector/config.ts"
);
const { setLlmConfig } = await import("../src/server/llm/config.ts");
const {
  FOREMAN_MODEL_ROLES,
  FOREMAN_MODEL_SPECS,
  resolveForemanModel,
  resolveForemanRunner,
} = await import("../src/shared/foreman-models.ts");
const { DEFAULT_LLM_RUNNER_ID } = await import("../src/shared/llm.ts");
const { ForemanConfigPatchSchema, InspectorConfigPatchSchema } = await import(
  "../src/shared/protocol.ts"
);

after(() => rmSync(home, { recursive: true, force: true }));

beforeEach(() => {
  openDb().exec("DELETE FROM app_config");
  delete process.env.MISSION_LLM_RUNNER;
  for (const role of FOREMAN_MODEL_ROLES) {
    delete process.env[FOREMAN_MODEL_SPECS[role].envVar];
  }
  delete process.env.MISSION_INSPECTOR_MODEL;
});

const APP_WIDE = { id: "claude", source: "default", unknown: null } as const;

// ---- the three-rung ladder, pure -------------------------------------------------------

test("a role's own provider outranks Foreman's, which outranks the app-wide answer", () => {
  const appWide = { id: "codex", source: "env", unknown: null } as const;

  // Rung 3 only: nothing configured anywhere in Foreman.
  assert.deepEqual(resolveForemanRunner("review", {}, appWide), appWide);

  // Rung 2: Foreman's group-level value, which every role inherits.
  for (const role of FOREMAN_MODEL_ROLES) {
    assert.deepEqual(resolveForemanRunner(role, { runner: "claude" }, appWide), {
      id: "claude",
      source: "config",
      unknown: null,
    });
  }

  // Rung 1: one role leaves, and ONLY that role leaves. This is the whole feature - the deep
  // pair on one account and the cheap pair on another.
  const split = { runner: "claude", reviewRunner: "codex" };
  assert.equal(resolveForemanRunner("review", split, appWide).id, "codex");
  assert.equal(resolveForemanRunner("verify", split, appWide).id, "claude");
  assert.equal(resolveForemanRunner("triage", split, appWide).id, "claude");
  assert.equal(resolveForemanRunner("backlog", split, appWide).id, "claude");
});

test("a blank override is an absence, not a choice, at every rung", () => {
  // A cleared select commits "" rather than deleting the key. It has to mean "inherit", or an
  // operator who set a provider once could never get back to following the row above.
  for (const blank of ["", "   "]) {
    assert.equal(
      resolveForemanRunner("triage", { runner: "codex", triageRunner: blank }, APP_WIDE).id,
      "codex",
    );
    assert.equal(resolveForemanRunner("triage", { runner: blank }, APP_WIDE).id, APP_WIDE.id);
  }
});

test("an unreadable stored provider is reported, then inherits the rest of the ladder", () => {
  // A downgrade, or a provider withdrawn, leaves an id this build cannot resolve. Replacing it
  // silently would make the fallback read back as the operator's own pick - the exact failure
  // `ResolvedLlmRunner.unknown` exists to prevent.
  const role = resolveForemanRunner("verify", { runner: "codex", verifyRunner: "gemini" }, APP_WIDE);
  assert.equal(role.id, "codex", "an unreadable role override falls to Foreman's own value");
  assert.equal(role.unknown, "gemini");

  const group = resolveForemanRunner("verify", { runner: "gemini" }, APP_WIDE);
  assert.equal(group.id, APP_WIDE.id, "an unreadable group value falls to the app-wide answer");
  assert.equal(group.unknown, "gemini");
});

test("a non-string persisted provider recovers to inherit rather than failing the whole parse", () => {
  // `getForemanConfig` is on the path of every worker pass and the settings route. A hand edit
  // or a future build's shape must not take Foreman down over a preference.
  setAppConfig(
    APP_CONFIG_ENTRIES.foreman,
    { runner: 7, reviewRunner: { id: "codex" }, reviewModel: "keep-me" } as never,
  );
  const cfg = getForemanConfig();
  assert.equal(cfg.runner, undefined);
  assert.equal(cfg.reviewRunner, undefined);
  assert.equal(cfg.reviewModel, "keep-me", "a neighbouring key survives its sibling's corruption");
});

// ---- the resolver guard, which is the half no writer can enforce ------------------------

test("a role model saved with no Foreman provider survives an app-wide provider change", () => {
  // THE REGRESSION, and the sequence the pinning rule exists for: leave Foreman's provider and
  // the role's unset, save a Claude model, then move the APP-WIDE radio. That writes the `llm`
  // blob only, so no Foreman write ever happens - which is why the provenance has to be
  // captured when the MODEL is saved rather than chased down afterwards. Without it the role
  // went on inheriting, the guard refused the pair, and the operator's Review model was
  // replaced by the new provider's default with no edit to that role at all.
  setForemanConfig({ reviewModel: "claude-opus-5" });
  assert.equal(getForemanConfig().runner, undefined, "Foreman itself never chose a provider");
  assert.equal(
    getForemanConfig().reviewRunner,
    "claude",
    "saving the model recorded the provider it belongs to",
  );

  setLlmConfig({ runner: "codex" });

  assert.equal(foremanRoleRunner("review").id, "claude", "a pinned role does not follow the move");
  assert.equal(foremanRoleRunner("verify").id, "codex", "an inheriting role still does");
  const resolved = resolveForemanModel(
    "review",
    getForemanConfig(),
    {},
    foremanRoleRunner("review").id,
  );
  assert.equal(resolved.id, "claude-opus-5", "the model the operator chose is what spawns");
  assert.equal(resolved.unsupported, null, "and nothing had to be dropped to get there");
  assert.equal(resolved.source, "config", "credited to the operator, because it is their pick");
});

test("a pair no writer ever recorded is still refused at resolution, and says what it dropped", () => {
  // The half no write path can reach: a blob from a build that had no per-role providers, or a
  // hand edit, or `MISSION_LLM_RUNNER` moving between restarts. The guard is the backstop for
  // all three, and it reports rather than silently substituting.
  setAppConfig(APP_CONFIG_ENTRIES.foreman, { ...getForemanConfig(), reviewModel: "claude-opus-5", reviewRunner: "" });
  const resolved = resolveForemanModel("review", getForemanConfig(), {}, "codex");
  assert.equal(
    resolved.unsupported,
    "claude-opus-5",
    "the pair is refused at resolution and says which id was dropped",
  );
  assert.equal(resolved.id, "gpt-5.6-sol", "and it spawns on that provider's own default");
  assert.equal(
    resolved.source,
    "default",
    "the substitute is not credited to the operator as a config choice",
  );
});

test("a model the new provider also offers is left exactly alone", () => {
  // The guard refuses only a POSITIVELY mismatched pair. An id in no catalog is a custom or
  // newly-released model and passes through untouched, because model ids are free text.
  const custom = resolveForemanModel("triage", { triageModel: "some-private-build" }, {}, "codex");
  assert.equal(custom.id, "some-private-build");
  assert.equal(custom.unsupported, null);
});

// ---- pin-on-provider-change, the writer's half ------------------------------------------

test("changing Foreman's provider pins the outgoing one onto roles carrying a model", () => {
  setForemanConfig({ runner: "claude", reviewModel: "claude-opus-5", triageRunner: "codex" });
  setForemanConfig({ runner: "codex" });

  const cfg = getForemanConfig();
  assert.equal(cfg.runner, "codex");
  assert.equal(
    cfg.reviewRunner,
    "claude",
    "a role with a model and no provider keeps the one it was saved under",
  );
  assert.equal(cfg.reviewModel, "claude-opus-5", "and its model is not deleted to keep it valid");
  assert.equal(cfg.triageRunner, "codex", "a role that already chose is not overwritten");
  assert.equal(
    cfg.verifyRunner,
    undefined,
    "a role with nothing to preserve is not converted into a pinned one",
  );
  assert.equal(foremanRoleRunner("review").id, "claude");
  assert.equal(foremanRoleRunner("verify").id, "codex", "an inheriting role follows the move");
});

test("a role with nothing pinned is never converted into a pinned one", () => {
  // The pin is a statement about a MODEL somebody chose. A role that has not chosen one is
  // still inheriting, and recording a provider for it would invent a decision the operator
  // never made - and quietly stop the app-wide picker from reaching it.
  process.env.MISSION_LLM_RUNNER = "claude";
  setForemanConfig({ reviewModel: "claude-opus-5" });
  setForemanConfig({ runner: "claude", mode: "live" });

  const cfg = getForemanConfig();
  assert.equal(cfg.verifyRunner, undefined, "no model, no pin");
  assert.equal(cfg.triageRunner, undefined);
  assert.equal(cfg.backlogRunner, undefined);
  assert.equal(cfg.reviewRunner, "claude", "the one that DID pin a model kept its provider");
});

test("a model no catalog claims records the provider it was chosen under", () => {
  // A custom or newly released id belongs to nobody the catalog knows, so the honest answer is
  // the provider in force when it was picked - the same one the panel records at that moment.
  // Left unrecorded it would be the one pair an app-wide move could still carry away.
  setLlmConfig({ runner: "codex" });
  setForemanConfig({ triageModel: "some-private-build" });
  assert.equal(getForemanConfig().triageRunner, "codex");

  setLlmConfig({ runner: "claude" });
  assert.equal(foremanRoleRunner("triage").id, "codex", "and it stays where it was chosen");
});

test("a patch of only model and provider keys leaves every sibling setting intact", () => {
  // `setForemanConfig` spreads a patch at the TOP level rather than merging per key, so a
  // second writer of this blob has to send only what it is changing. The Models panel does.
  setForemanConfig({ mode: "live", repoAllowlist: ["/tmp/repo"], maxSessions: 9 });
  setForemanConfig({ reviewRunner: "codex", reviewModel: "gpt-5.6-sol" });

  const cfg = getForemanConfig();
  assert.equal(cfg.mode, "live");
  assert.deepEqual(cfg.repoAllowlist, ["/tmp/repo"]);
  assert.equal(cfg.maxSessions, 9);
  assert.equal(cfg.reviewRunner, "codex");
});

test("the patch schema refuses a provider the panel could not have offered", () => {
  // Strict on write where the read schema is tolerant, and for the opposite reason: a `.catch`
  // here would turn a bad value into a silent inherit that reverts on the next poll.
  assert.equal(ForemanConfigPatchSchema.safeParse({ reviewRunner: "codex" }).success, true);
  assert.equal(ForemanConfigPatchSchema.safeParse({ reviewRunner: "" }).success, true);
  assert.equal(ForemanConfigPatchSchema.safeParse({ reviewRunner: "gemini" }).success, false);
  assert.equal(ForemanConfigPatchSchema.safeParse({ runner: "gemini" }).success, false);
  assert.equal(InspectorConfigPatchSchema.safeParse({ runner: "gemini" }).success, false);
});

// ---- what the daemon reports, and what the worker spawns --------------------------------

test("the group-level readout is Foreman's own answer, not any one role's", () => {
  setLlmConfig({ runner: "codex" });
  setForemanConfig({ reviewRunner: "claude" });
  assert.equal(foremanGroupRunner(), "codex", "unset Foreman inherits the app-wide value");
  assert.equal(foremanRoleRunner("review").id, "claude");
  assert.equal(foremanRoleRunner("verify").id, "codex");
});

test("a Foreman provider this build cannot read is REPORTED at the group level, not swallowed", () => {
  // The group row is the one control on the page with no per-role `unknown` line beneath it,
  // so if the group-level answer is reduced to a bare id the dropped value has nowhere left to
  // be said. What the operator then sees is the app-wide provider drawn as Foreman's own
  // deliberate choice - the exact reading the whole `unknown` mechanism exists to prevent.
  setLlmConfig({ runner: "codex" });
  // Persisted directly: the panel cannot offer this, and the patch schema refuses it. A build
  // that once had it, or a hand-edited blob, is how it gets here.
  setAppConfig(APP_CONFIG_ENTRIES.foreman, { ...getForemanConfig(), runner: "gemini" });

  const resolved = foremanGroupRunnerResolved();
  assert.equal(resolved.id, "codex", "an unreadable provider inherits the app-wide answer");
  assert.equal(resolved.unknown, "gemini", "and says which id it could not honour");
  // The bare-id helper still answers what it always did, so its callers are unaffected.
  assert.equal(foremanGroupRunner(), "codex");
  // And a role with no override of its own reports the same thing one rung down, rather than
  // the two lines of the ladder disagreeing about what was dropped.
  assert.equal(foremanRoleRunner("review").id, "codex");
  assert.equal(foremanRoleRunner("review").unknown, "gemini");
});

test("a readable Foreman provider reports itself, with nothing dropped", () => {
  setLlmConfig({ runner: "codex" });
  setForemanConfig({ runner: "claude" });
  assert.deepEqual(foremanGroupRunnerResolved(), {
    id: "claude",
    source: "config",
    unknown: null,
  });
});

test("the backlog planner's reported identity carries the backlog ROLE's provider", () => {
  // The circuit compares provider+model to decide whether to re-probe. Feeding it the
  // group-level value would leave it comparing against a provider nothing is spawning.
  setForemanConfig({ runner: "claude", backlogRunner: "codex" });
  assert.equal(foremanRoleRunner("backlog").id, "codex");
  assert.equal(
    resolveForemanModel("backlog", getForemanConfig(), {}, foremanRoleRunner("backlog").id).id,
    "gpt-5.6-terra",
    "and the model beside it is the one that provider offers",
  );
});

// ---- the Inspector's fallback ------------------------------------------------------------

test("an unset Inspector provider follows MISSION_LLM_RUNNER instead of a literal claude", () => {
  // THE REGRESSION. `cfg.runner ?? "claude"` made this the one subsystem in the app that
  // ignored the environment and the app-wide setting.
  process.env.MISSION_LLM_RUNNER = "codex";
  const resolved = inspectorRunner();
  assert.equal(resolved.id, "codex");
  assert.equal(resolved.source, "env");
  assert.equal(
    inspectorModel().id,
    "gpt-5.6-sol",
    "and the shipped model default follows the provider it will actually spawn through",
  );
});

test("an unset Inspector provider follows the app-wide config too", () => {
  setLlmConfig({ runner: "codex" });
  assert.equal(inspectorRunner().id, "codex");
  assert.equal(inspectorRunner().source, "config");
});

test("an Inspector provider the operator set outranks both", () => {
  process.env.MISSION_LLM_RUNNER = "codex";
  setInspectorConfig({ runner: "claude" });
  assert.equal(inspectorRunner().id, "claude");
  assert.equal(inspectorRunner().source, "config");
  assert.equal(inspectorRunner().unknown, null);
});

test("an unreadable Inspector provider is reported rather than swallowed", () => {
  setAppConfig(APP_CONFIG_ENTRIES.inspector, { runner: "gemini" });
  const resolved = inspectorRunner();
  assert.equal(resolved.id, DEFAULT_LLM_RUNNER_ID);
  assert.equal(resolved.unknown, "gemini");
});

test("an unrelated Foreman write never pins a legacy role's provider", () => {
  // THE REGRESSION (GitHub Inspector, PR #756). Pinning used to run on EVERY patch, so a
  // write that changed something else entirely - `enabled`, `mode`, the repo allowlist - would
  // reach a role carrying a model saved by a build that recorded no provider with it, and
  // silently record one. For a `claude-opus-5` under app-wide Codex that pin was `claude`,
  // which moved the next review onto a different account than the one it had been running on.
  // Nobody asked for that, and nothing on screen said it happened.
  setLlmConfig({ runner: "codex" });
  setAppConfig(APP_CONFIG_ENTRIES.foreman, { reviewModel: "claude-opus-5" });
  assert.equal(getForemanConfig().reviewRunner, undefined, "the legacy pair starts unpinned");
  assert.equal(foremanRoleRunner("review").id, "codex", "and is running on the app-wide answer");

  setForemanConfig({ mode: "live" });

  assert.equal(getForemanConfig().reviewRunner, undefined, "an unrelated write pins nothing");
  assert.equal(foremanRoleRunner("review").id, "codex", "so the role still inherits");
});

test("a group provider move pins what a legacy role was RUNNING, not what its model owns", () => {
  // The other half of the same finding. On a group move the role's stored model is not
  // evidence of anything the operator just decided - it may predate provider recording
  // entirely - so the honest pin is the provider actually in force, which is what the
  // resolver guard was already spending. Pinning the model's owner instead would use a group
  // change as cover for moving the role somewhere it had never run.
  setLlmConfig({ runner: "codex" });
  setAppConfig(APP_CONFIG_ENTRIES.foreman, { reviewModel: "claude-opus-5" });

  setForemanConfig({ runner: "claude" });

  assert.equal(
    getForemanConfig().reviewRunner,
    "codex",
    "the outgoing provider, not claude-opus-5's owner",
  );
  assert.equal(foremanRoleRunner("review").id, "codex");
});

test("saving a model still records the provider that model belongs to", () => {
  // The narrowing above must not cost the rule the page is documented on: an EXPLICIT model
  // save is a decision, and it pins the provider the chosen id positively belongs to.
  setLlmConfig({ runner: "codex" });
  setForemanConfig({ reviewModel: "claude-opus-5" });
  assert.equal(getForemanConfig().reviewRunner, "claude");
});

test("saving an Inspector model with no provider pins the one it belongs to", () => {
  // THE REGRESSION (GitHub Inspector, PR #756). Foreman's roles pinned on save and the
  // Inspector did not, so a Claude model chosen while its provider was inherited stored half a
  // pair. Moving the app-wide radio then handed a Codex provider a Claude model id - on the
  // one call in this app that writes where other people read.
  setLlmConfig({ runner: "claude" });
  setInspectorConfig({ model: "claude-opus-5" });

  assert.equal(getInspectorConfig().runner, "claude", "the model's own provider is recorded");

  setLlmConfig({ runner: "codex" });
  assert.equal(inspectorRunner().id, "claude", "so an app-wide move cannot carry it away");
  assert.equal(inspectorModel().id, "claude-opus-5", "and the operator's model survives intact");
});

test("an unrelated Inspector write never pins its provider", () => {
  setLlmConfig({ runner: "codex" });
  setAppConfig(APP_CONFIG_ENTRIES.inspector, { model: "claude-opus-5" });

  setInspectorConfig({ mode: "live" });

  assert.equal(getInspectorConfig().runner, undefined, "an inheriting slot stays inheriting");
});

test("an incompatible Inspector pair no writer reached is refused at resolution", () => {
  // The backstop for what pinning cannot reach: a blob written by an older build, a hand
  // edit, or MISSION_LLM_RUNNER moving between restarts. The review is a DEEP call, so the
  // substitute comes from the deep tier rather than quietly downgrading the review.
  setAppConfig(APP_CONFIG_ENTRIES.inspector, { model: "claude-opus-5" });
  setLlmConfig({ runner: "codex" });

  const resolved = inspectorModel();
  assert.equal(resolved.id, "gpt-5.6-sol", "a Codex provider gets a Codex deep model");
  assert.equal(resolved.unsupported, "claude-opus-5", "and the dropped id is reported, not hidden");
  assert.equal(resolved.source, "default", "a substitute is not credited to the operator");
});

test("an Inspector model its provider does offer is left exactly alone", () => {
  setAppConfig(APP_CONFIG_ENTRIES.inspector, { runner: "codex", model: "gpt-5.6-sol" });
  const resolved = inspectorModel();
  assert.equal(resolved.id, "gpt-5.6-sol");
  assert.equal(resolved.unsupported, null);
  assert.equal(resolved.source, "config");
});
