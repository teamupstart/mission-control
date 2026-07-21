import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INSPECTOR_MODEL_ENV,
  INSPECTOR_MODEL_SPEC,
  resolveInspectorModel,
} from "../src/shared/inspector.ts";
import { resolveModelChoice } from "../src/shared/model-choice.ts";
import { resolveForemanModel } from "../src/shared/foreman-models.ts";
import { InspectorConfigSchema } from "../src/shared/protocol.ts";

// What is at stake: the Inspector spawns `claude -p` on every push to every PR we open,
// and for the life of the feature it passed NO `--model` at all - so what it ran as was
// whatever the local CLI happened to default to. On this machine that resolved to
// `claude-opus-4-8[1m]`, the 1M-context premium tier, at ~$2 a round; nothing in the app
// recorded that, and the settings screen had no field that could have shown it. These
// tests pin the two halves of the fix: a NAMED default, and one ladder deciding it so the
// panel's answer and the worker's spawn cannot come apart.

test("the shipped default is named, not left to the CLI", () => {
  // The property, not the id: an unset `--model` is the failure being ruled out here.
  assert.ok(INSPECTOR_MODEL_SPEC.fallback.trim().length > 0);
  assert.equal(resolveInspectorModel({ model: undefined }, undefined).id, "claude-sonnet-5");
  assert.equal(resolveInspectorModel({ model: undefined }, undefined).source, "default");
});

test("a fresh config names no model, so the default is what actually runs", () => {
  // The config field is optional and the daemon ships with it unset, so the spec's
  // fallback is not a rare path - it is the one every install takes until someone types
  // in the box.
  const fresh = InspectorConfigSchema.parse({});
  assert.equal(fresh.model, undefined);
  assert.equal(resolveInspectorModel(fresh, undefined).id, INSPECTOR_MODEL_SPEC.fallback);
});

test("config wins over env, env wins over the shipped default", () => {
  assert.deepEqual(resolveInspectorModel({ model: "from-config" }, "from-env"), {
    id: "from-config",
    source: "config",
  });
  assert.deepEqual(resolveInspectorModel({ model: undefined }, "from-env"), {
    id: "from-env",
    source: "env",
  });
});

test("clearing the box is a change the daemon will actually accept", () => {
  // The field is free text, so an operator emptying it commits `""`. The id regex alone
  // REFUSED that - which meant anyone who had once typed a model could never get back to
  // the default: the write failed, the panel reverted, and nothing said why.
  const cleared = InspectorConfigSchema.safeParse({ model: "" });
  assert.ok(cleared.success, "an empty model must be storable - it is how an override is cleared");
  assert.equal(resolveInspectorModel(cleared.data!, undefined).id, INSPECTOR_MODEL_SPEC.fallback);

  // And the shell-safety constraint the field is typed with still holds: this value
  // becomes a `--model` argument, so a leading dash would be read as a flag.
  assert.equal(InspectorConfigSchema.safeParse({ model: "--dangerous" }).success, false);
  assert.equal(InspectorConfigSchema.safeParse({ model: "a; rm -rf /" }).success, false);
});

test("a cleared box falls back rather than spawning with no model id", () => {
  // `""` is a human who emptied the field. Passing it through as `--model ""` would be
  // the exact unset-model state this whole spec exists to prevent, so every layer treats
  // blank and whitespace as absent.
  for (const cleared of ["", "   "]) {
    assert.equal(resolveInspectorModel({ model: cleared }, undefined).source, "default");
    assert.equal(resolveInspectorModel({ model: cleared }, "from-env").source, "env");
    assert.equal(resolveInspectorModel({ model: undefined }, cleared).source, "default");
  }
});

test("the env var the panel PRINTS is one the daemon would actually read", () => {
  // The panel shows a name to export; the daemon looks the value up through `envVar()`,
  // which sweeps the `MISSION_` / `FLEET_` / `HARNESS_` prefixes over a suffix. Two
  // literals could drift into a settings screen naming a variable that does nothing.
  assert.equal(INSPECTOR_MODEL_SPEC.envVar, `MISSION_${INSPECTOR_MODEL_ENV}`);
});

test("the Inspector and Foreman rank the same three layers the same way", () => {
  // Two subsystems, one ladder (`resolveModelChoice`). Copies of this ranking are how an
  // empty box comes to mean two different things in two panels that look identical.
  const spec = { envVar: "X", fallback: "shipped", label: "l", blurb: "b" };
  assert.equal(resolveModelChoice(spec, "cfg", "env").source, "config");
  assert.equal(resolveModelChoice(spec, undefined, "env").source, "env");
  assert.equal(resolveModelChoice(spec, undefined, undefined).id, "shipped");

  const foreman = resolveForemanModel("review", {}, {});
  assert.equal(foreman.source, "default");
  assert.equal(resolveInspectorModel({}, undefined).source, foreman.source);
});
