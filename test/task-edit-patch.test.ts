import { test } from "node:test";
import assert from "node:assert/strict";
import { mkTask as baseTask } from "./helpers/session-fixture.ts";
import type { Task } from "../src/shared/types.ts";
import {
  EMPTY_DISPATCH_DRAFT,
  draftFromTask,
  draftPersonaId,
  draftsEqual,
  taskUpdatePatch,
  type DispatchDraft,
} from "../src/web/lib/task-draft.ts";

// What a save is allowed to write, and what a kept working copy is allowed to claim.
//
// At stake is somebody else's edit. The backlog editor is not the only writer of a task:
// the board's card has its own priority picker, and the same task can be open in another
// window. A form that posts all nine of its fields posts the ones it was merely SEEDED
// with too, so a save meant to fix a typo reverts a priority set on the card a minute
// earlier - no error, nothing on screen, and the operator reads it as "editing a task
// doesn't update it". Both halves of the guard are here: the patch carries only what
// changed, and a working copy is falsifiable against the row it was built from.

const mkTask = (over: Partial<Task> = {}): Task =>
  baseTask({
    title: "Rip out the legacy poller",
    intent: "rip out the legacy poller and its dead config",
    kind: "ship",
    agent: "claude",
    repoRoot: "/Users/dev/work/harness",
    priority: null,
    labels: [],
    model: null,
    effort: null,
    ...over,
  });

/** The form as it comes up on a task, with the one field under test changed. */
const edited = (t: Task, over: Partial<DispatchDraft>): DispatchDraft => ({
  ...draftFromTask(t),
  ...over,
});

test("a form that changed nothing sends nothing", () => {
  // Not an empty object: the API refuses one, and rightly - there is nothing to merge.
  // Null is the signal to skip the POST entirely, so Save on an untouched form is a close.
  const t = mkTask();
  assert.equal(taskUpdatePatch(t, draftFromTask(t), t.intent), null);
});

test("only the changed field is sent", () => {
  // The regression this file exists for. The operator retitles; the priority they can
  // see in the form is the one they were shown, not one they chose, so it must not ride
  // along and overwrite whatever the row now says.
  const t = mkTask({ priority: "blocker", labels: ["bug"] });
  const patch = taskUpdatePatch(t, edited(t, { title: "Rip out the poller" }), t.intent);
  assert.deepEqual(patch, { title: "Rip out the poller" });
  assert.ok(patch && !("priority" in patch), "an untouched priority is not restated");
  assert.ok(patch && !("labels" in patch), "untouched labels are not restated");
});

test("a stale draft of an untouched field is still not sent", () => {
  // The same form, but seeded when the task read `low` and saved after the card had been
  // set to `blocker`. The comparison is against the task AS IT NOW READS, so the save is
  // judged on the row it is about to overwrite rather than on the one it remembers.
  const seeded = draftFromTask(mkTask({ priority: "low" }));
  const now = mkTask({ priority: "blocker" });
  assert.equal(taskUpdatePatch(now, { ...seeded, priority: "blocker" }, now.intent), null);
});

test("clearing priority sends an explicit null, not an omission", () => {
  // The one field where "unset" is a value someone chose. An omitted key would mean
  // "leave it alone", which is the opposite instruction.
  const t = mkTask({ priority: "high" });
  assert.deepEqual(taskUpdatePatch(t, edited(t, { priority: "" }), t.intent), { priority: null });
});

test("setting a priority on an untriaged task sends it", () => {
  const t = mkTask();
  assert.deepEqual(taskUpdatePatch(t, edited(t, { priority: "med" }), t.intent), { priority: "med" });
});

test("an emptied title is sent as empty, which asks for one to be derived again", () => {
  const t = mkTask();
  assert.deepEqual(taskUpdatePatch(t, edited(t, { title: "" }), t.intent), { title: "" });
});

test("label text that means the same set is not a change", () => {
  // The text box and the task disagree about what a change is: a trailing comma, a
  // repeat, or a different spacing rewrites the string and not the task. The task is
  // the thing being saved.
  const t = mkTask({ labels: ["bug", "infra"] });
  assert.equal(taskUpdatePatch(t, edited(t, { labels: "bug,  infra, " }), t.intent), null);
  assert.equal(taskUpdatePatch(t, edited(t, { labels: "bug, infra, BUG" }), t.intent), null);
  assert.deepEqual(taskUpdatePatch(t, edited(t, { labels: "bug, perf" }), t.intent), {
    labels: ["bug", "perf"],
  });
  // Emptying the box clears them - an empty array, not an omission.
  assert.deepEqual(taskUpdatePatch(t, edited(t, { labels: "" }), t.intent), { labels: [] });
});

test("un-pinning the model sends null, and pinning one sends the id", () => {
  // Null is how a row that names a model goes back to following the harness default,
  // so it cannot be expressed as an absent field.
  const pinned = mkTask({ model: "claude-opus-4-8" });
  assert.deepEqual(taskUpdatePatch(pinned, edited(pinned, { model: "" }), pinned.intent), {
    model: null,
  });
  const free = mkTask();
  assert.deepEqual(taskUpdatePatch(free, edited(free, { model: "gpt-5.6-sol" }), free.intent), {
    model: "gpt-5.6-sol",
  });
});

test("un-pinning effort sends null, and pinning one sends the level", () => {
  const pinned = mkTask({ effort: "xhigh" });
  assert.deepEqual(taskUpdatePatch(pinned, edited(pinned, { effort: "" }), pinned.intent), {
    effort: null,
  });
  const free = mkTask();
  assert.deepEqual(taskUpdatePatch(free, edited(free, { effort: "high" }), free.intent), {
    effort: "high",
  });
});

test("a legacy advisor pin reads back and can only be cleared, never set", () => {
  const pinned = mkTask({ advisorModel: "opus" });
  assert.equal(draftFromTask(pinned).advisorModel, "opus");
  assert.equal(draftFromTask(mkTask()).advisorModel, "", "no pin reads back as the empty value");
  // "Use Settings" empties the draft's pin, and the save sends the clear.
  assert.deepEqual(taskUpdatePatch(pinned, edited(pinned, { advisorModel: "" }), pinned.intent), {
    advisorModel: null,
  });
  // Saving a pinned task without clearing it leaves the pin alone.
  assert.equal(taskUpdatePatch(pinned, draftFromTask(pinned), pinned.intent), null);
  // The advisor is chosen on Settings -> Harnesses, so a draft cannot pin one.
  const free = mkTask();
  assert.equal(taskUpdatePatch(free, edited(free, { advisorModel: "sonnet" }), free.intent), null);
  assert.equal(draftsEqual(draftFromTask(pinned), draftFromTask(free)), false);
});

test("the composed intent is what the patch compares, so an attachment alone is a change", () => {
  // The stored intent carries the paths `withAttachments` appended, so a drop with no
  // typing still rewrites it - and a save that only re-composed the same text does not.
  const t = mkTask();
  assert.equal(taskUpdatePatch(t, draftFromTask(t), t.intent), null);
  const withPath = `${t.intent}\n\n/tmp/uploads/shot.png`;
  assert.deepEqual(taskUpdatePatch(t, draftFromTask(t), withPath), { intent: withPath });
});

test("repo and kind and agent each travel alone", () => {
  const t = mkTask();
  assert.deepEqual(taskUpdatePatch(t, edited(t, { repoRoot: "/Users/dev/work/other" }), t.intent), {
    repoRoot: "/Users/dev/work/other",
  });
  assert.deepEqual(taskUpdatePatch(t, edited(t, { kind: "scout" }), t.intent), { kind: "scout" });
  assert.deepEqual(taskUpdatePatch(t, edited(t, { agent: "codex" }), t.intent), { agent: "codex" });
});

test("everything at once still goes as one patch", () => {
  const t = mkTask({ priority: "low", labels: ["bug"], model: "claude-opus-4-8" });
  const patch = taskUpdatePatch(
    t,
    edited(t, { title: "New name", kind: "scout", agent: "codex", priority: "blocker",
                labels: "perf", model: "" }),
    "a different intent",
  );
  assert.deepEqual(patch, {
    intent: "a different intent",
    title: "New name",
    kind: "scout",
    agent: "codex",
    priority: "blocker",
    labels: ["perf"],
    model: null,
  });
});

test("every field on the form reaches the patch", () => {
  // The completeness guard, and the reason it is written as a map rather than a list of
  // cases: a field added to the form and to `draftFromTask` but not to `taskUpdatePatch`
  // is a field that displays, edits, and never saves - no error, nothing to notice. A new
  // key here fails this test until somebody writes down what changing it looks like, and
  // then fails it again if the patch ignores that change.
  const changed: {
    [K in keyof Omit<DispatchDraft, "attachments" | "agentPinned">]: DispatchDraft[K];
  } = {
    repoRoot: "/Users/dev/work/elsewhere",
    extraRepoRoots: ["/Users/dev/work/sibling"],
    intent: "something else entirely",
    title: "Another name",
    kind: "scout",
    agent: "codex",
    priority: "blocker",
    labels: "moved",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    // The one change the form can make to a pin is clearing one saved before the advisor
    // moved to Settings -> Harnesses, so it is judged against a task that has one.
    advisorModel: "",
    personaId: "persona-reviewer",
    workflowId: "workflow-review",
    grillFirst: true,
    enabled: false,
    dependencies: [{ type: "task", taskId: "prerequisite" }],
  };
  // Two exclusions, both because the field is not a task field:
  //  - `attachments` is how the intent gets composed, which the `intent` case above covers.
  //  - `agentPinned` records WHERE the agent beside it came from - a choice made, or one the
  //    form resolved - so that reopening the surface does not re-resolve it over the
  //    operator. The task stores the agent, never its provenance, so a patch carrying this
  //    would be a column that does not exist.
  const excluded = new Set(["attachments", "agentPinned"]);
  const formFields = Object.keys(EMPTY_DISPATCH_DRAFT).filter((k) => !excluded.has(k));
  assert.deepEqual(
    formFields.sort(),
    Object.keys(changed).sort(),
    "a field on the form with no entry here is a field nobody has decided how to save",
  );

  for (const [field, value] of Object.entries(changed)) {
    const t = field === "advisorModel" ? mkTask({ advisorModel: "opus" }) : mkTask();
    // `intent` is the one field that does not reach the patch off the draft: what gets
    // stored is the typed text with the attachment paths appended, so the modal composes
    // it and passes it in. Changing the draft's copy alone must therefore do nothing.
    const patch =
      field === "intent"
        ? taskUpdatePatch(t, draftFromTask(t), String(value))
        : taskUpdatePatch(t, edited(t, { [field]: value }), t.intent);
    assert.ok(patch, `changing ${field} must produce a patch`);
    assert.equal(Object.keys(patch).length, 1, `changing ${field} must send ${field} alone`);
  }
});

test("a Persona reads back, is cleared with null, and follows every kind the form offers", () => {
  const t = mkTask({ personaId: "persona-reviewer" });
  assert.equal(draftFromTask(t).personaId, "persona-reviewer");
  assert.equal(draftFromTask(mkTask()).personaId, "", "no Persona is the empty option");
  assert.deepEqual(taskUpdatePatch(t, edited(t, { personaId: "" }), t.intent), { personaId: null });
  assert.deepEqual(taskUpdatePatch(t, edited(t, { personaId: "persona-other" }), t.intent), { personaId: "persona-other" });
  // A harness-launched kind keeps it, so a kind change travels alone.
  assert.deepEqual(taskUpdatePatch(t, edited(t, { kind: "scout" }), t.intent), { kind: "scout" });
  // A pipeline carries one to its Engineer host, so that move travels alone too.
  assert.deepEqual(taskUpdatePatch(t, edited(t, { kind: "pipeline" }), t.intent), { kind: "pipeline" });
  assert.equal(draftPersonaId({ kind: "pipeline", personaId: "persona-reviewer" }), "persona-reviewer");
  // The one kind that cannot carry a dispatch Persona never sends the draft's value.
  assert.equal(draftPersonaId({ kind: "resident", personaId: "persona-reviewer" }), null);
  assert.equal(draftPersonaId({ kind: "chat", personaId: "persona-reviewer" }), "persona-reviewer");
  assert.equal(draftPersonaId({ kind: "ship", personaId: "" }), null);
});

test("a working copy is stale exactly when the row's editable fields moved", () => {
  // What the editor consults on reopen. Editable fields only: a task whose status or
  // timestamps changed is still the task the form was written against, and dropping a
  // draft over that would cost the operator their typing for nothing.
  const seed = draftFromTask(mkTask({ priority: "low" }));
  assert.ok(draftsEqual(seed, draftFromTask(mkTask({ priority: "low", updatedAt: 999 }))));
  assert.ok(draftsEqual(seed, draftFromTask(mkTask({ priority: "low", status: "dispatching" }))));
  assert.ok(!draftsEqual(seed, draftFromTask(mkTask({ priority: "blocker" }))));
  assert.ok(!draftsEqual(seed, draftFromTask(mkTask({ priority: "low", labels: ["bug"] }))));
  assert.ok(!draftsEqual(seed, draftFromTask(mkTask({ priority: "low", title: "Renamed" }))));
  assert.ok(!draftsEqual(seed, draftFromTask(mkTask({ priority: "low", enabled: false }))));
});

test("converting a non-plan task carries every explicit storage choice", () => {
  const task = mkTask({ kind: "ship", planPolicy: null });
  for (const planStorage of ["repository", "local", null] as const) {
    const draft = edited(task, { kind: "plan", planStorage, workflowId: undefined });
    assert.deepEqual(taskUpdatePatch(task, draft, task.intent), { kind: "plan", planStorage });
  }
  const existingPlan = mkTask({ kind: "plan", planPolicy: { storage: "repository", commitPlanHtml: false } });
  assert.equal(taskUpdatePatch(existingPlan, draftFromTask(existingPlan), existingPlan.intent), null);
});

test("plan conversion carries an explicit None even when the ship task also had no workflow", () => {
  const task = mkTask({ kind: "ship", workflowId: null });
  assert.deepEqual(taskUpdatePatch(task, edited(task, { kind: "plan", workflowId: null }), task.intent), {
    kind: "plan", workflowId: null,
  });
});

test("Grill me first reads back as a task's choice and saves only when it moves", () => {
  const ship = mkTask({ kind: "ship", grillFirst: true });
  assert.equal(draftFromTask(ship).grillFirst, true);
  assert.equal(taskUpdatePatch(ship, draftFromTask(ship), ship.intent), null, "an untouched pin is not resent");
  assert.deepEqual(taskUpdatePatch(ship, { ...draftFromTask(ship), grillFirst: false }, ship.intent), { grillFirst: false });
  // A row filed before the column existed reads as off, not as a choice nobody made.
  assert.equal(draftFromTask(mkTask({ kind: "plan" })).grillFirst, false);
  // Between kinds that both offer it the pin goes with the task, so the patch is the kind.
  // (`workflowId: undefined` keeps plan conversion's explicit after-work choice out of it.)
  assert.deepEqual(taskUpdatePatch(ship, { ...draftFromTask(ship), kind: "plan", workflowId: undefined }, ship.intent), { kind: "plan" });
  // Pipeline has no pin, so switching it to plan untouched leaves the daemon to pin plan's
  // default, and a choice made on the switch is sent even when it is off.
  const pipeline = mkTask({ kind: "pipeline" });
  assert.equal(draftFromTask(pipeline).grillFirst, undefined);
  assert.deepEqual(taskUpdatePatch(pipeline, { ...draftFromTask(pipeline), kind: "plan", workflowId: undefined }, pipeline.intent), { kind: "plan" });
  assert.deepEqual(
    taskUpdatePatch(pipeline, { ...draftFromTask(pipeline), kind: "plan", workflowId: undefined, grillFirst: false }, pipeline.intent),
    { kind: "plan", grillFirst: false },
  );
  // Leaving for pipeline there is no pin to save, whatever the box last said.
  assert.deepEqual(taskUpdatePatch(ship, { ...draftFromTask(ship), kind: "pipeline" }, ship.intent), { kind: "pipeline" });
  assert.ok(!draftsEqual(draftFromTask(ship), draftFromTask(mkTask({ kind: "ship", grillFirst: false }))));
});
