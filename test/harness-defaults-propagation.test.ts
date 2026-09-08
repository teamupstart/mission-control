import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";

/**
 * Whether a change to the per-harness dispatch defaults actually takes effect - the two
 * ways it could fail to, both of which it did.
 *
 * The daemon was never the problem: `resolveDispatchModel` reads the config on every
 * dispatch, and `dispatch-model.test.ts` already pins that. What was wrong sat either side
 * of it.
 *
 * READ-BACK. The settings panel is optimistic and reconciles from three asynchronous
 * sources (a mount read, an SSE-triggered read, a backstop poll). Every response used to be
 * written into state unconditionally, so a read issued BEFORE an edit could land after it
 * and put the pre-edit value back - the operator's change appeared to be ignored while the
 * daemon held it the whole time. `readIsCurrent` is the ordering rule that stops that.
 *
 * PINNING. Foreman's per-harness backlog model was WRITTEN onto the task row before
 * dispatch. Because a task's own model outranks the panel default and `reschedule` does not
 * clear it, a task Foreman had launched once was pinned to that model forever - a value
 * nothing in the UI had asked for. It is now passed per-launch instead.
 */

const home = mkdtempSync(join(tmpdir(), "mission-harness-propagation-"));
// Set before importing anything that resolves the state dir.
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { resolveDispatchModel, setHarnessesConfig } = await import("../src/server/harnesses.ts");
const { mergeHarnessesPatch, readIsCurrent } = await import("../src/web/harnesses-reconcile.ts");
const { HarnessesConfigSchema } = await import("@shared/protocol.ts");

after(() => rmSync(home, { recursive: true, force: true }));

beforeEach(() => {
  openDb().exec("DELETE FROM app_config");
});

/** The shipped config, schema defaults and all - what the panel holds before any edit. */
function baseConfig() {
  return HarnessesConfigSchema.parse({});
}

// ---- the read-back ordering rule ----

test("a read issued before an edit is refused, so it cannot restore the pre-edit value", () => {
  // The reproduced bug, as one assertion. Sequence 3 left, the operator changed something
  // (4), and the response arrived late carrying the old config. Applying it is what made a
  // saved change look ignored for up to a poll interval.
  assert.equal(readIsCurrent(3, 4), false);
});

test("a read issued after the last edit is applied, so the daemon still gets the last word", () => {
  // The guard must not become "ignore the server". A read that no edit overtook is how an
  // out-of-band change - another tab, or a value the daemon normalised on write - reaches
  // this panel at all.
  assert.equal(readIsCurrent(4, 4), true);
});

test("the guard counts edits rather than comparing configs", () => {
  // Two edits can land on the same value (set Sonnet, set Opus, set Sonnet). "The body
  // matches what I show" is not the same fact as "this read is current", and a body compare
  // would silently re-admit the stale read in exactly the case the counter exists for.
  assert.equal(readIsCurrent(1, 3), false);
});

// ---- the optimistic merge mirrors the daemon's ----

test("an optimistic edit to one harness leaves the others alone", () => {
  // The panel shows all three cards. A patch that replaced the map wholesale would blank
  // the two rows the operator never touched, for as long as it took the confirming read to
  // come back - and the daemon does NOT do that, so the flicker would be pure invention.
  const before = mergeHarnessesPatch(baseConfig(), {
    defaultModel: { claude: "claude-opus-5", codex: "gpt-5.6-sol" },
  });

  const after_ = mergeHarnessesPatch(before, { defaultModel: { claude: "claude-sonnet-5" } });

  assert.equal(after_.defaultModel.claude, "claude-sonnet-5");
  assert.equal(after_.defaultModel.codex, "gpt-5.6-sol", "the untouched card must not blank");
});

test("an optimistic terminal edit leaves the other harness choices alone", () => {
  const before = mergeHarnessesPatch(baseConfig(), {
    terminalBackend: { claude: "herdr", codex: "wezterm" },
  });

  const after_ = mergeHarnessesPatch(before, { terminalBackend: { claude: "ghostty" } });

  assert.equal(after_.terminalBackend.claude, "ghostty");
  assert.equal(after_.terminalBackend.codex, "wezterm");
});

test("the optimistic merge agrees with the daemon's merge for the same patch", () => {
  // The panel's merge is a COPY of `setHarnessesConfig`'s. Pinned against the real thing
  // rather than described, because the failure mode is silent: the panel would show one
  // thing, the daemon would store another, and only a reload would reveal which.
  setHarnessesConfig({ defaultModel: { claude: "claude-opus-5", codex: "gpt-5.6-sol" } });
  const patch = { defaultEffort: { claude: "high" as const } };

  const daemon = setHarnessesConfig(patch);
  const panel = mergeHarnessesPatch(
    HarnessesConfigSchema.parse({
      defaultModel: { claude: "claude-opus-5", codex: "gpt-5.6-sol" },
    }),
    patch,
  );

  assert.deepEqual(panel.defaultModel, daemon.defaultModel);
  assert.deepEqual(panel.defaultEffort, daemon.defaultEffort);
});

// ---- the three model tiers ----

test("a launch-only model outranks the panel default but not the task's own pin", () => {
  setHarnessesConfig({ defaultModel: { claude: "claude-sonnet-5" } });

  // Nothing supplied: the panel default, read now.
  assert.equal(resolveDispatchModel("claude", null), "claude-sonnet-5");
  // Foreman's backlog model, for this launch only.
  assert.equal(resolveDispatchModel("claude", null, "claude-haiku-4-5"), "claude-haiku-4-5");
  // An explicit operator choice on the task always wins over both.
  assert.equal(resolveDispatchModel("claude", "claude-fable-5", "claude-haiku-4-5"), "claude-fable-5");
});

test("a launch-only model does not survive into the next launch of the same task", () => {
  // The whole point of passing rather than persisting: the default is changed AFTER a launch
  // that used Foreman's model, and the next launch of that same unpinned task follows the
  // new default instead of the model it happened to run on last time.
  setHarnessesConfig({ defaultModel: { claude: "claude-sonnet-5" } });
  assert.equal(resolveDispatchModel("claude", null, "claude-haiku-4-5"), "claude-haiku-4-5");

  setHarnessesConfig({ defaultModel: { claude: "claude-fable-5" } });
  assert.equal(resolveDispatchModel("claude", null), "claude-fable-5");
});

// ---- the task row stays unpinned ----

test("dispatching with a launch-only default does not pin the task's model", async () => {
  // The regression that made the reported symptom permanent rather than merely delayed.
  // Foreman passes its per-harness backlog model on a backlog launch; if that lands on the
  // task row, this task outranks the Harnesses default for the rest of its life.
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  registry.upsertTask(mkTask({ id: "t1", status: "backlog", model: null }));

  await tasks.dispatch("t1", { defaultModel: "claude-haiku-4-5" });

  assert.equal(
    registry.getTask("t1")!.model,
    null,
    "an unpinned task must stay unpinned - nothing in the UI asked for this model",
  );
});

test("dispatching does not overwrite a model the operator did pin", async () => {
  // The other direction of the same write: an explicit choice must survive a dispatch that
  // also carries a launch-only default.
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  registry.upsertTask(mkTask({ id: "t2", status: "backlog", model: "claude-fable-5" }));

  await tasks.dispatch("t2", { defaultModel: "claude-haiku-4-5" });

  assert.equal(registry.getTask("t2")!.model, "claude-fable-5");
});

test("a rescheduled task carries no model it was never pinned with", async () => {
  // `reschedule` clears the outcome, branch and worktree but NOT `model` - which is correct
  // for a real pin and was the trap for a written-in one. With the write gone there is
  // nothing for it to carry.
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  registry.upsertTask(mkTask({ id: "t3", status: "backlog", model: null }));

  await tasks.dispatch("t3", { defaultModel: "claude-haiku-4-5" });
  const dispatched = registry.getTask("t3")!;
  registry.upsertTask({ ...dispatched, status: "cancelled" });

  const r = await tasks.reschedule("t3");
  assert.equal(r.ok, true);
  assert.equal(registry.getTask("t3")!.model, null);
});
