import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// An agent, model and effort per TASK KIND: a dispatched `plan` running somewhere other than
// a `ship`, chosen once in Settings rather than overridden by hand on every dispatch.
//
// What is at stake here is not "does the value come back" - it is a set of quiet failures
// that all look like the feature working:
//
//   - A model configured against Codex reaching a Claude launch, where it becomes a
//     `--model` flag naming an id that harness has never heard of.
//   - A row that carries a model but no agent: a value that can never apply to anything, and
//     which reads in the panel as a setting that is simply being ignored.
//   - An effort the target harness does not offer at launch, passed anyway - `max` on a Codex
//     model outside its newest two, which the CLI rejects.
//   - An effort resolved against the model on the ROW rather than the model this launch
//     actually resolved, so the capability check answers a question about the wrong model.
//   - `pipeline` acquiring a row, which would be a control that cannot reach the process it
//     appears to describe, since Conductor owns its downstream launch.
//   - And the one that makes the whole feature unreachable: `DispatchSchema.agent` carrying
//     `.default("claude")`, so an omitted agent has already become an explicit Claude by the
//     time any code that knows the kind can see it.

const home = mkdtempSync(join(tmpdir(), "mission-kind-defaults-"));
// Set before importing anything that resolves the state dir.
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const {
  getHarnessesConfig,
  setHarnessesConfig,
  resolveDispatchModel,
  resolveDispatchEffort,
  resolveTaskAgent,
  taskKindDefaults,
} = await import("../src/server/harnesses.ts");
const { DispatchSchema, HarnessesConfigPatchSchema, HarnessesConfigSchema } = await import(
  "@shared/protocol.ts"
);
const { HARNESS_LAUNCHED_TASK_KINDS, TASK_KIND_BEHAVIOR } = await import("@shared/task.ts");
const { TASK_KINDS } = await import("@shared/types.ts");
const { mergeHarnessesPatch } = await import("../src/web/harnesses-reconcile.ts");

after(() => rmSync(home, { recursive: true, force: true }));

beforeEach(() => {
  openDb().exec("DELETE FROM app_config");
});

// ---- the row set is derived, not listed ----

test("the rows are exactly the kinds this app launches, pipeline excluded", () => {
  // Derived from `TASK_KIND_BEHAVIOR`, so a kind added later appears (or stays out) by
  // answering that registry rather than by anybody remembering to edit a second list.
  assert.deepEqual(
    [...HARNESS_LAUNCHED_TASK_KINDS].sort(),
    TASK_KINDS.filter((kind) => TASK_KIND_BEHAVIOR[kind].launch === "harness").sort(),
  );
  assert.equal(HARNESS_LAUNCHED_TASK_KINDS.includes("pipeline" as never), false);
  assert.deepEqual(Object.keys(getHarnessesConfig().kindDefaults).sort(), [
    ...HARNESS_LAUNCHED_TASK_KINDS,
  ].sort());
  // And asking for the one kind with no row answers "there is none" rather than reading
  // `undefined` off a record and letting it flow on as a value.
  assert.equal(taskKindDefaults("pipeline"), null);
});

test("an untouched installation resolves exactly as it did before this key existed", () => {
  // No migration: the key is additive with a default, so nothing about how an existing
  // installation dispatches changes until a row is set.
  const cfg = getHarnessesConfig();
  for (const kind of HARNESS_LAUNCHED_TASK_KINDS) {
    assert.deepEqual(cfg.kindDefaults[kind], { agent: null, model: null, effort: null });
  }
  assert.equal(resolveTaskAgent("plan"), "claude");
  assert.equal(resolveDispatchModel("claude", null, null, "plan"), null);
  assert.equal(resolveDispatchEffort("claude", null, "plan", null), null);
});

// ---- the ladder ----

test("the model ladder puts the kind below the launch model and above the harness default", () => {
  setHarnessesConfig({
    defaultModel: { claude: "claude-sonnet-5" },
    kindDefaults: { plan: { agent: "claude", model: "claude-opus-4-8" } },
  });
  // Harness default for a kind with no row of its own.
  assert.equal(resolveDispatchModel("claude", null, null, "ship"), "claude-sonnet-5");
  // The kind's model, above the harness default.
  assert.equal(resolveDispatchModel("claude", null, null, "plan"), "claude-opus-4-8");
  // Foreman's launch-only model, above the kind.
  assert.equal(resolveDispatchModel("claude", null, "claude-haiku-4-5", "plan"), "claude-haiku-4-5");
  // The task's own pin, above everything.
  assert.equal(
    resolveDispatchModel("claude", "claude-fable-5", "claude-haiku-4-5", "plan"),
    "claude-fable-5",
  );
});

test("a kind's model is not applied to a task running a different harness - but its effort is", () => {
  setHarnessesConfig({
    defaultModel: { codex: "gpt-5.6-sol" },
    defaultEffort: { codex: "low" },
    kindDefaults: { plan: { agent: "claude", model: "claude-opus-4-8", effort: "high" } },
  });
  // The model is agent-namespaced, so a Claude id must never become Codex's `--model`.
  assert.equal(resolveDispatchModel("codex", null, null, "plan"), "gpt-5.6-sol");
  // The effort is one shared vocabulary, so "plan with high" still means something here.
  assert.equal(resolveDispatchEffort("codex", null, "plan", "gpt-5.6-sol"), "high");
  // ...and it stays below the task's own pin.
  assert.equal(resolveDispatchEffort("codex", "low", "plan", "gpt-5.6-sol"), "low");
});

test("an effort the target harness does not offer falls through to the harness default", () => {
  // `max` is exactly the level Codex drops on every model but its newest two, so this is the
  // real narrowing rather than an invented one.
  setHarnessesConfig({
    defaultEffort: { codex: "medium" },
    kindDefaults: { plan: { effort: "max" } },
  });
  assert.equal(resolveDispatchEffort("codex", null, "plan", "gpt-5.2-codex"), "medium");
  // The same level on a model Codex DOES offer it for reaches the launch.
  assert.equal(resolveDispatchEffort("codex", null, "plan", "gpt-5.6-sol"), "max");
});

test("the effort is checked against the model THIS launch resolved, not the row's", () => {
  // The row names a model Codex offers `max` for; the task pins one it does not. The task's
  // pin is what launches, so the row's effort must be judged against that - which is why the
  // dispatcher resolves the model first and passes it in.
  setHarnessesConfig({
    defaultEffort: { codex: "medium" },
    kindDefaults: { plan: { agent: "codex", model: "gpt-5.6-sol", effort: "max" } },
  });
  const withRowModel = resolveDispatchModel("codex", null, null, "plan");
  assert.equal(withRowModel, "gpt-5.6-sol");
  assert.equal(resolveDispatchEffort("codex", null, "plan", withRowModel), "max");

  const pinned = resolveDispatchModel("codex", "gpt-5.2-codex", null, "plan");
  assert.equal(pinned, "gpt-5.2-codex");
  assert.equal(resolveDispatchEffort("codex", null, "plan", pinned), "medium");
});

test("the kind's effort is taken only where the harness offers it at launch", async () => {
  // Registry-driven rather than written against one agent name: every harness answers the
  // same question, and a harness that declares no effort spec at all answers it with an empty
  // list - the arm that must take NOTHING from the kind tier rather than pass a flag on.
  const { launchEffortLevels } = await import("@shared/harness-capabilities.ts");
  const { AGENT_TYPES, THINKING_LEVELS } = await import("@shared/types.ts");
  for (const agent of AGENT_TYPES) {
    const levels = launchEffortLevels(agent, null);
    const missing = THINKING_LEVELS.find((level) => !levels.includes(level));
    if (missing) {
      openDb().exec("DELETE FROM app_config");
      setHarnessesConfig({
        defaultEffort: { [agent]: "medium" },
        kindDefaults: { plan: { effort: missing } },
      });
      assert.equal(
        resolveDispatchEffort(agent, null, "plan", null),
        "medium",
        `${agent} does not offer ${missing} at launch, so the harness default must win`,
      );
    }
    const offered = levels[0];
    if (offered) {
      openDb().exec("DELETE FROM app_config");
      setHarnessesConfig({ kindDefaults: { plan: { effort: offered } } });
      assert.equal(resolveDispatchEffort(agent, null, "plan", null), offered);
    } else {
      openDb().exec("DELETE FROM app_config");
      setHarnessesConfig({ kindDefaults: { plan: { effort: "high" } } });
      assert.equal(
        resolveDispatchEffort(agent, null, "plan", null),
        null,
        `${agent} has no launch effort control, so nothing may be passed`,
      );
    }
  }
});

// ---- what may be written ----

test("a task's OWN effort is capability-checked too, not passed on for having been chosen", () => {
  // The tier everything else was already careful about, and the one that was not. A stored
  // effort is a level chosen against some harness at some earlier moment, and neither of those
  // need still be true at launch: a task filed with an inherited agent had no harness to be
  // checked against, and one that has a harness can still resolve a model that narrows the
  // levels. Passed on unchecked, it reaches the CLI as a flag it rejects.
  setHarnessesConfig({ kindDefaults: { plan: { agent: "codex", effort: "high" } } });

  // `max` is a level Codex does not offer at all. The pin loses to the tier below it rather
  // than being handed to the harness.
  assert.equal(resolveDispatchEffort("codex", "max", "plan", null), "high");

  // ...and with no kind row to fall to, to the harness default rather than to the pin.
  assert.equal(resolveDispatchEffort("codex", "max", "ship", null), null);

  // A pin the harness DOES offer still wins every tier above it - this is a capability check,
  // not a demotion of the operator's choice.
  assert.equal(resolveDispatchEffort("codex", "low", "plan", null), "low");
});

test("a row that inherits its agent may set an effort but never a model", () => {
  assert.equal(
    HarnessesConfigPatchSchema.safeParse({ kindDefaults: { plan: { effort: "high" } } }).success,
    true,
  );
  assert.equal(
    HarnessesConfigPatchSchema.safeParse({ kindDefaults: { plan: { agent: null, model: "claude-opus-4-8" } } })
      .success,
    false,
    "a model stored against no agent could never apply to anything",
  );
  // A patch naming ONLY a model is not contradictory on its own - it depends on the row it
  // lands on - so the door lets it through and the merge is what judges it.
  assert.equal(
    HarnessesConfigPatchSchema.safeParse({ kindDefaults: { plan: { model: "claude-opus-4-8" } } }).success,
    true,
  );
  assert.throws(
    () => setHarnessesConfig({ kindDefaults: { plan: { model: "claude-opus-4-8" } } }),
    /inherits its agent/,
    "refused rather than dropped: a 200 over a dropped model says it worked",
  );
  assert.equal(getHarnessesConfig().kindDefaults.plan.model, null);
  // ...and the same model lands once the row names the harness it belongs to.
  setHarnessesConfig({ kindDefaults: { plan: { agent: "claude" } } });
  assert.equal(
    setHarnessesConfig({ kindDefaults: { plan: { model: "claude-opus-4-8" } } }).kindDefaults.plan.model,
    "claude-opus-4-8",
  );
  assert.equal(
    HarnessesConfigPatchSchema.safeParse({
      kindDefaults: { plan: { agent: "claude", model: "claude-opus-4-8" } },
    }).success,
    true,
  );
  // No row for the kind Conductor launches, so the write door refuses one rather than
  // silently dropping it and leaving the caller believing it saved.
  assert.equal(
    HarnessesConfigPatchSchema.safeParse({ kindDefaults: { pipeline: { agent: "claude" } } }).success,
    false,
  );
});

test("the READ path tolerates a row a newer build wrote, dropping only the model", () => {
  // The dispatch path parses this blob, so a value from a newer build must not throw - that
  // would take out the per-harness defaults too, over a key the caller never asked about.
  const parsed = HarnessesConfigSchema.parse({
    kindDefaults: { plan: { agent: null, model: "claude-opus-4-8", effort: "high" } },
  });
  assert.deepEqual(parsed.kindDefaults.plan, { agent: null, model: null, effort: "high" });
});

test("kind rows merge per kind AND per field, on the server and in the browser", () => {
  setHarnessesConfig({ kindDefaults: { ship: { agent: "codex" } } });
  const cfg = setHarnessesConfig({ kindDefaults: { plan: { effort: "high" } } });
  // The kind nobody mentioned is untouched...
  assert.equal(cfg.kindDefaults.ship.agent, "codex");
  // ...and so is the field nobody mentioned inside the kind that was.
  const merged = setHarnessesConfig({ kindDefaults: { ship: { effort: "low" } } });
  assert.deepEqual(merged.kindDefaults.ship, { agent: "codex", model: null, effort: "low" });

  // The optimistic browser merge is a COPY of that rule, so it has to agree arm for arm or
  // the panel shows one thing for a beat and the daemon stores another.
  assert.deepEqual(
    mergeHarnessesPatch(merged, { kindDefaults: { ship: { effort: "high" } } }).kindDefaults.ship,
    { agent: "codex", model: null, effort: "high" },
  );
  assert.deepEqual(
    mergeHarnessesPatch(merged, { kindDefaults: { plan: { agent: "pi" } } }).kindDefaults.ship,
    merged.kindDefaults.ship,
  );
  // ...including the model-follows-agent rule, so an inheriting row is never SHOWN a model
  // the daemon is about to refuse.
  assert.equal(
    mergeHarnessesPatch(
      setHarnessesConfig({ kindDefaults: { scout: { agent: "claude", model: "claude-opus-4-8" } } }),
      { kindDefaults: { scout: { agent: null } } },
    ).kindDefaults.scout.model,
    null,
  );
});

// ---- the schema-default trap ----

test("DispatchSchema no longer turns an omitted agent into an explicit Claude", () => {
  // The whole feature hangs on this. With `.default("claude")` on the schema, a route sees an
  // explicit Claude for a body that named no agent, and no downstream resolution can tell the
  // two apart - so no caller could ever have reached a kind default.
  const omitted = DispatchSchema.parse({ repoRoot: "/r", intent: "go", kind: "plan" });
  assert.equal(omitted.agent, undefined);
  assert.equal(omitted.kind, "plan", "the kind keeps its own default, so it is always known");
  const named = DispatchSchema.parse({ repoRoot: "/r", intent: "go", agent: "codex" });
  assert.equal(named.agent, "codex");
});

test("an effort is still refused at the door when the harness is named", () => {
  assert.equal(
    DispatchSchema.safeParse({ repoRoot: "/r", intent: "go", agent: "codex", effort: "max" }).success,
    false,
  );
  // With no agent named the harness is not knowable in a browser-safe schema, so the body
  // parses. `TaskManager.create` does NOT refuse it once the kind has answered either: the
  // level was chosen without knowing which harness would answer, so it takes the ladder's
  // ordinary rule and falls back to the harness default at launch.
  assert.equal(
    DispatchSchema.safeParse({ repoRoot: "/r", intent: "go", effort: "max" }).success,
    true,
  );
});

test("an omitted agent resolves from the kind; a named one is always a pin", () => {
  setHarnessesConfig({ kindDefaults: { plan: { agent: "codex" } } });
  assert.equal(resolveTaskAgent("plan"), "codex");
  assert.equal(resolveTaskAgent("plan", undefined), "codex");
  assert.equal(resolveTaskAgent("ship"), "claude", "a kind with no row inherits");
  assert.equal(
    resolveTaskAgent("plan", "claude"),
    "claude",
    "an explicit Claude stays Claude even when the kind says otherwise",
  );
  // The kind Conductor launches has no row to read, so it inherits rather than throwing.
  assert.equal(resolveTaskAgent("pipeline"), "claude");
});
