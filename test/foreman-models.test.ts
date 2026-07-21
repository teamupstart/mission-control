import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FOREMAN_MODEL_ROLES,
  FOREMAN_MODEL_SPECS,
  resolveForemanModel,
  resolveForemanModels,
} from "../src/shared/foreman-models.ts";
import type { ForemanModelRole } from "../src/shared/foreman-models.ts";
import { ForemanConfigSchema } from "../src/shared/protocol.ts";
import { DEFAULT_TRIAGE_MODEL } from "../src/server/foreman/triage.ts";
import { DEFAULT_BACKLOG_MODEL } from "../src/server/foreman/backlog-plan.ts";
import { DEFAULT_REVIEW_MODEL } from "../src/server/foreman/review.ts";
import { DEFAULT_VERIFY_MODEL } from "../src/server/foreman/queue-verify.ts";
import { modelSourceNote } from "../src/web/components/ModelField.tsx";

// What's at stake: the worker SPAWNS a model and the settings panel PRINTS one, and a
// user who cannot trust the printed answer is back where this feature started - unable
// to say what Foreman runs as. Every test here defends the property that makes the
// readout worth having: one ladder, one answer, no second copy of a default.

// ---- the resolution ladder -------------------------------------------------------------

test("config wins over env, env wins over the shipped default", () => {
  const spec = FOREMAN_MODEL_SPECS.review;
  const env = { [spec.envVar]: "from-env" };

  assert.deepEqual(resolveForemanModel("review", { reviewModel: "from-config" }, env), {
    role: "review",
    id: "from-config",
    source: "config",
  });
  assert.deepEqual(resolveForemanModel("review", {}, env), {
    role: "review",
    id: "from-env",
    source: "env",
  });
  assert.deepEqual(resolveForemanModel("review", {}, {}), {
    role: "review",
    id: spec.fallback,
    source: "default",
  });
});

test("an emptied box falls through the ladder instead of spawning with no model id", () => {
  // The whole reason this uses `||` and not `??`. A config holding "" is a human who
  // cleared the field, and the one thing it must never mean is `--model ""`.
  for (const blank of ["", "   "]) {
    const r = resolveForemanModel("triage", { triageModel: blank }, {});
    assert.equal(r.id, FOREMAN_MODEL_SPECS.triage.fallback);
    assert.equal(r.source, "default");
  }
  // Same for a whitespace-only env var, which is what an unset shell export looks like.
  const viaEnv = resolveForemanModel("triage", {}, { FOREMAN_TRIAGE_MODEL: "  " });
  assert.equal(viaEnv.source, "default");
});

test("a typed id is trimmed, so a stray space can't become a different model", () => {
  const r = resolveForemanModel("backlog", { backlogModel: "  claude-sonnet-5  " }, {});
  assert.deepEqual(r, { role: "backlog", id: "claude-sonnet-5", source: "config" });
});

test("a missing config resolves rather than throwing - the panel renders before the first poll", () => {
  const all = resolveForemanModels(null, {});
  for (const role of FOREMAN_MODEL_ROLES) {
    assert.equal(all[role].source, "default");
    assert.equal(all[role].id, FOREMAN_MODEL_SPECS[role].fallback);
  }
});

// ---- no second copy of a default -------------------------------------------------------

test("every role's config key exists on the config schema", () => {
  // A spec naming a key the schema doesn't have would silently never resolve from
  // config: the panel would write it, zod would strip it, and the box would revert.
  const parsed = ForemanConfigSchema.parse({});
  const shape = ForemanConfigSchema.shape;
  for (const role of FOREMAN_MODEL_ROLES) {
    const key = FOREMAN_MODEL_SPECS[role].configKey;
    assert.ok(key in shape, `${role}: ${key} is missing from ForemanConfigSchema`);
    // Optional, so a config that has never been written round-trips as undefined
    // rather than as an empty id.
    assert.equal(parsed[key], undefined);
  }
});

test("a written model id survives the schema round-trip", () => {
  const cfg = ForemanConfigSchema.parse({ reviewModel: "claude-fable-5", verifyModel: "" });
  assert.equal(cfg.reviewModel, "claude-fable-5");
  // Stored as written; the ladder - not the schema - is what turns "" back into a default.
  assert.equal(resolveForemanModel("verify", cfg, {}).source, "default");
});

test("the server's DEFAULT_* constants are the shared spec, not a second opinion", () => {
  // Each of these used to be (or would naturally become) a literal declared next to its
  // caller. Two literals is how the panel starts advertising a default the worker isn't
  // using - the exact failure this module was extracted to prevent.
  assert.equal(DEFAULT_REVIEW_MODEL, FOREMAN_MODEL_SPECS.review.fallback);
  assert.equal(DEFAULT_VERIFY_MODEL, FOREMAN_MODEL_SPECS.verify.fallback);
  assert.equal(DEFAULT_TRIAGE_MODEL, FOREMAN_MODEL_SPECS.triage.fallback);
  assert.equal(DEFAULT_BACKLOG_MODEL, FOREMAN_MODEL_SPECS.backlog.fallback);
});

test("every role is spec'd, and no two roles share an env var", () => {
  const seen = new Set<string>();
  for (const role of FOREMAN_MODEL_ROLES) {
    const spec = FOREMAN_MODEL_SPECS[role];
    assert.ok(spec, `${role} has no spec`);
    assert.ok(spec.label && spec.blurb, `${role} is missing panel copy`);
    assert.ok(spec.fallback, `${role} has no default - it would spawn with no --model`);
    assert.ok(!seen.has(spec.envVar), `${spec.envVar} is claimed by two roles`);
    seen.add(spec.envVar);
  }
  assert.equal(seen.size, FOREMAN_MODEL_ROLES.length);
});

test("the deep calls default to a deeper model than the cheap ones", () => {
  // Not a style rule: `triage` exists to keep a bucketing off the reviewer's model, and
  // a refactor that quietly levelled these would erase the cost split without failing
  // anything else.
  assert.notEqual(FOREMAN_MODEL_SPECS.review.fallback, FOREMAN_MODEL_SPECS.triage.fallback);
  assert.notEqual(FOREMAN_MODEL_SPECS.review.fallback, FOREMAN_MODEL_SPECS.backlog.fallback);
});

// ---- what the panel says ---------------------------------------------------------------

test("the source note stays silent for a value the box already shows", () => {
  const note = modelSourceNote(
    { id: "claude-opus-4-8", source: "config" },
    "FOREMAN_REVIEW_MODEL",
  );
  assert.equal(note, null);
});

test("the source note names the env var that is outranking an empty box", () => {
  // The case the panel could not work out on its own: the browser has no `process`, so
  // without the daemon reporting this the field would claim the shipped default.
  const note = modelSourceNote(
    { id: "claude-haiku-4-5", source: "env" },
    "FOREMAN_TRIAGE_MODEL",
  );
  assert.match(note ?? "", /FOREMAN_TRIAGE_MODEL/);
});

test("the source note says so when nothing has been configured at all", () => {
  const note = modelSourceNote(
    { id: "claude-opus-4-8", source: "default" },
    "FOREMAN_VERIFY_MODEL",
  );
  assert.match(note ?? "", /default/i);
});

test("the source note never repeats the id the input is already showing", () => {
  // The id lives in the box (as the placeholder when empty); printing it again one line
  // below reads as two separate facts. This line explains the SOURCE, nothing else.
  for (const source of ["env", "default"] as const) {
    const note = modelSourceNote(
      { id: "claude-opus-4-8", source },
      "FOREMAN_REVIEW_MODEL",
    );
    assert.doesNotMatch(note ?? "", /claude-opus-4-8/);
  }
});

test("the source note tolerates a status that hasn't arrived yet", () => {
  assert.equal(modelSourceNote(undefined, "FOREMAN_REVIEW_MODEL"), null);
});

// ---- the role list is the display list -------------------------------------------------

test("the deep calls are listed before the cheap ones", () => {
  // FOREMAN_MODEL_ROLES is the panel's render order, so this is a UI assertion in
  // disguise: the two calls that dominate the bill should be the first two you see.
  assert.deepEqual([...FOREMAN_MODEL_ROLES], ["review", "verify", "triage", "backlog"]);
});

test("resolveForemanModels covers exactly the declared roles", () => {
  const all = resolveForemanModels({ reviewModel: "x" }, {});
  assert.deepEqual(Object.keys(all).sort(), [...FOREMAN_MODEL_ROLES].sort());
  for (const role of FOREMAN_MODEL_ROLES) {
    assert.equal(all[role].role, role as ForemanModelRole);
  }
});
