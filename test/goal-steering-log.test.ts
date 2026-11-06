import assert from "node:assert/strict";
import { after, test } from "node:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { IntentRelationship } from "../src/shared/types.ts";
import type { HookIngest } from "../src/shared/protocol.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

const home = mkdtempSync(join(tmpdir(), "mission-steering-"));
process.env.MISSION_HOME = home;
process.env.MISSION_GOAL_POLL_MS = "10";
process.env.MISSION_GOAL_REFRESH_MS = "10";
const fake = join(home, "claude");
const reply = join(home, "reply.json");
// While `gate` exists the fake marks `started` and holds its answer: a classification that is
// in flight, for the test that accepts the objective underneath one.
const gate = join(home, "gate");
const started = join(home, "started");
writeFileSync(fake, `#!/bin/sh\ncat >/dev/null\nif [ -f '${gate}' ]; then touch '${started}'; while [ -f '${gate}' ]; do sleep 0.02; done; fi\ncat '${reply}'\n`);
chmodSync(fake, 0o755);
process.env.MISSION_CLAUDE_BIN = fake;
const { configureClaudeRunnerTransport } = await import("../src/server/llm/claude.ts");
const restore = configureClaudeRunnerTransport(() => "print");
const { Registry } = await import("../src/server/registry.ts");
const { startGoalRefiner } = await import("../src/server/goal/refiner.ts");
const { openDb, closeDb, getSessionGoal, upsertSessionGoalWithSteering, upsertSessionGoalWithSteeringNotes,
  readSessionGoalSteering, pruneSessionGoalSteering } = await import("../src/server/db.ts");
const { reserveInjection, confirmReservedInjection } = await import("../src/server/injections.ts");
after(() => { restore(); rmSync(home, { recursive: true, force: true }); });

function session(id: string) {
  const registry = new Registry();
  registry.applyDiscovery([{
    syntheticId: id, agent: "claude", name: id, nameSource: "process", cwd: home,
    gitBranch: null, gitRoot: null, repoRoot: null, pid: 9001, tty: id,
    terminals: [mkMuxHandle({ session: "s", windowName: "w", windowIndex: 0, paneId: `%${id}` })], startedAt: 1,
  } as DiscoveredSession]);
  registry.captureAcceptedPrompt(id, "Ship the feature", id);
  registry.upsertGoal(id, { resolvedPromptRevision: 1, pendingPrompts: [], relationship: "initial" });
  return registry;
}

async function classify(registry: InstanceType<typeof Registry>, id: string, relationship: IntentRelationship) {
  writeFileSync(reply, JSON.stringify({ result: JSON.stringify({ relationship,
    objective: relationship === "amend" ? "Ship the feature. Also add keyboard access" : "A new objective",
    goal: "A compact goal", focus: "Next step", reason: "Change the method, not the outcome" }) }));
  const revision = registry.getGoal(id)!.promptRevision;
  const stop = startGoalRefiner(registry);
  try {
    const until = Date.now() + 10_000;
    while (registry.getGoal(id)!.resolvedPromptRevision !== revision && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(registry.getGoal(id)!.resolvedPromptRevision, revision);
  } finally { stop(); }
}

test("only a steer verdict appends a durable instruction from the real refiner", async () => {
  for (const relationship of ["steer", "amend", "replace", "unclear"] as const) {
    const id = `classification-${relationship}`;
    const registry = session(id);
    const instruction = "skip the E2E for now, the harness is broken";
    registry.captureAcceptedPrompt(id, instruction, id);
    await classify(registry, id, relationship);
    const notes = readSessionGoalSteering(id, 2);
    assert.equal(notes.length, relationship === "steer" ? 1 : 0);
    if (relationship === "steer") {
      assert.equal(notes[0]!.instruction, instruction);
      assert.equal(registry.getGoal(id)!.objective, "Ship the feature");
      assert.equal(getSessionGoal(id)!.openingPrompt, "Ship the feature");
      assert.deepEqual(new Registry().getGoalSteering(id, 2), [], "a missing live session cannot read another key");
      assert.deepEqual(readSessionGoalSteering(id, 2), notes, "durable reader retains the classified note");
    }
  }
});

for (const [reason, relationship, resolvedPromptRevision] of [
  ["non-steering goal", "amend", 2],
  ["mismatched resolved revision", "steer", 1],
] as const) {
  test(`steering rejects a ${reason} before persisting either row`, () => {
    const id = `invalid-steering-${resolvedPromptRevision}`;
    const template = session(`${id}-template`).getGoal(`${id}-template`)!;
    const goal = { ...template, noteKey: id, relationship, resolvedPromptRevision };
    const note = {
      revision: 2, instruction: "do the smaller one first", relationship: "steer" as const,
      rationale: "Change the sequence", timestamp: 100,
    };
    assert.equal(getSessionGoal(id), undefined);
    assert.deepEqual(readSessionGoalSteering(id, Number.MAX_SAFE_INTEGER), []);

    assert.throws(() => upsertSessionGoalWithSteering(goal, note), {
      name: "Error", message: "Steering must belong to the resolved goal revision",
    });

    assert.equal(getSessionGoal(id), undefined, "the invalid goal must not be persisted");
    assert.deepEqual(readSessionGoalSteering(id, Number.MAX_SAFE_INTEGER), [],
      "the invalid steering instruction must not be persisted");
  });
}

for (const [reason, relationship, resolvedPromptRevision, revisions] of [
  ["non-steering goal", "amend", 3, [2, 3]],
  ["note past the resolved revision", "steer", 2, [2, 3]],
  ["an empty list", "steer", 3, []],
] as const) {
  test(`the list steering writer rejects ${reason} before persisting anything`, () => {
    const id = `invalid-steering-list-${reason.replace(/\W+/g, "-")}`;
    const template = session(`${id}-template`).getGoal(`${id}-template`)!;
    const goal = { ...template, noteKey: id, relationship, resolvedPromptRevision, promptRevision: 3 };
    const notes = revisions.map((revision) => ({
      revision, instruction: `instruction ${revision}`, relationship: "steer" as const,
      rationale: "Accepted by you: the current objective is the completion contract.", timestamp: 100,
    }));
    assert.throws(() => upsertSessionGoalWithSteeringNotes(goal, notes), {
      name: "Error", message: "Steering must belong to the resolved goal revision",
    });
    assert.equal(getSessionGoal(id), undefined, "the invalid goal must not be persisted");
    assert.deepEqual(readSessionGoalSteering(id, Number.MAX_SAFE_INTEGER), []);
  });
}

test("the list steering writer commits the goal and every note at or below its resolved revision", () => {
  const id = "steering-list";
  const template = session(`${id}-template`).getGoal(`${id}-template`)!;
  const goal = { ...template, noteKey: id, relationship: "steer" as const, promptRevision: 3, resolvedPromptRevision: 3 };
  const notes = [2, 3].map((revision) => ({
    revision, instruction: `instruction ${revision}`, relationship: "steer" as const,
    rationale: "Accepted by you: the current objective is the completion contract.", timestamp: 100,
  }));
  upsertSessionGoalWithSteeringNotes(goal, notes);
  assert.equal(getSessionGoal(id)?.resolvedPromptRevision, 3);
  assert.deepEqual(readSessionGoalSteering(id, 3), notes);
  // Same conflict rule as the single-note writer: a second write keeps the first note.
  upsertSessionGoalWithSteeringNotes(goal, notes.map((n) => ({ ...n, instruction: "rewritten" })));
  assert.deepEqual(readSessionGoalSteering(id, 3), notes);
});

test("duplicate writes are idempotent and a failure after the goal update rolls back both durable and cached state", () => {
  const id = "atomic-steering";
  const registry = session(id);
  registry.captureAcceptedPrompt(id, "do the smaller one first", id);
  const before = registry.getGoal(id)!;
  const patch = { relationship: "steer" as const, resolvedPromptRevision: 2, pendingPrompts: [] };
  openDb().exec(`CREATE TRIGGER reject_steering BEFORE INSERT ON session_goal_steering
    WHEN NEW.note_key = 'atomic-steering' BEGIN SELECT RAISE(ABORT, 'injected append failure'); END`);
  try {
    assert.throws(() => registry.resolveGoal(id, patch, before.prompt!, 100), /injected append failure/);
    assert.deepEqual(getSessionGoal(id), before);
    assert.deepEqual(registry.getGoal(id), before);
    assert.deepEqual(readSessionGoalSteering(id, 2), []);
  } finally { openDb().exec("DROP TRIGGER reject_steering"); }
  registry.resolveGoal(id, patch, before.prompt!, 100);
  const note = readSessionGoalSteering(id, 2)[0]!;
  upsertSessionGoalWithSteering(registry.getGoal(id)!, note);
  assert.deepEqual(readSessionGoalSteering(id, 2), [note]);
});

test("accepting the objective rolls back the goal and every earlier note when a later note fails", () => {
  const id = "atomic-steering-list";
  const registry = session(id);
  registry.captureAcceptedPrompt(id, "B", id);
  registry.captureAcceptedPrompt(id, "B, but rename the heading", id);
  const before = registry.getGoal(id)!;
  assert.deepEqual(before.pendingPrompts.map((p) => p.revision), [2, 3]);
  // Fails the SECOND insert, so the goal update and revision 2's note have already been
  // written inside the transaction when the error arrives.
  openDb().exec(`CREATE TRIGGER reject_second_steering BEFORE INSERT ON session_goal_steering
    WHEN NEW.note_key = 'atomic-steering-list' AND NEW.revision = 3
    BEGIN SELECT RAISE(ABORT, 'injected second append failure'); END`);
  try {
    assert.throws(() => registry.acceptGoalObjective(id, 100), /injected second append failure/);
    assert.deepEqual(getSessionGoal(id), before, "the goal update rolled back");
    assert.deepEqual(registry.getGoal(id), before, "the cached goal never moved");
    assert.deepEqual(readSessionGoalSteering(id, Number.MAX_SAFE_INTEGER), [],
      "revision 2's note, written before the failure, rolled back too");
  } finally { openDb().exec("DROP TRIGGER reject_second_steering"); }
  const accepted = registry.acceptGoalObjective(id, 100);
  assert.ok(accepted && accepted.accepted);
  assert.deepEqual(readSessionGoalSteering(id, 3).map((n) => n.revision), [2, 3]);
});

test("a classification already in flight cannot overwrite an objective accepted as is", async () => {
  const id = "accept-during-refine";
  const registry = session(id);
  registry.captureAcceptedPrompt(id, "B", id);
  const before = registry.getGoal(id)!;
  // The verdict that would do the most damage if it landed: a replacement of the objective.
  writeFileSync(reply, JSON.stringify({ result: JSON.stringify({ relationship: "replace",
    objective: "A smaller, different objective", goal: "Smaller", focus: "B", reason: "late verdict" }) }));
  writeFileSync(gate, "");
  const stop = startGoalRefiner(registry);
  try {
    const until = Date.now() + 10_000;
    while (!existsSync(started) && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
    assert.ok(existsSync(started), "the classifier call should be in flight");

    const accepted = registry.acceptGoalObjective(id, 500);
    assert.ok(accepted && accepted.accepted);
    unlinkSync(gate);
    // Let the held verdict return and reach the refiner's resolution check.
    await new Promise((r) => setTimeout(r, 500));
  } finally {
    stop();
    if (existsSync(gate)) unlinkSync(gate);
    if (existsSync(started)) unlinkSync(started);
  }
  const goal = registry.getGoal(id)!;
  assert.equal(goal.relationship, "steer");
  assert.match(goal.rationale ?? "", /^Accepted by you:/);
  assert.equal(goal.objective, before.objective);
  assert.equal(goal.text, before.text);
  assert.equal(goal.objectiveVersion, before.objectiveVersion);
  assert.equal(goal.resolvedPromptRevision, 2);
  assert.deepEqual(getSessionGoal(id)!.objective, before.objective, "durable objective unchanged");
  assert.deepEqual(readSessionGoalSteering(id, 2).map((n) => [n.revision, n.instruction]), [[2, "B"]]);
});

test("an unclear instruction is reconsidered with the next one instead of being dropped", async () => {
  const id = "unclear-reconsidered";
  const registry = session(id);
  registry.captureAcceptedPrompt(id, "maybe also restyle it", id);
  await classify(registry, id, "unclear");
  assert.equal(registry.getGoal(id)!.relationship, "unclear");
  assert.deepEqual(readSessionGoalSteering(id, 2), [], "an unclear verdict records no steering");

  registry.captureAcceptedPrompt(id, "use the existing button styles", id);
  assert.deepEqual(registry.getGoal(id)!.pendingPrompts.map((p) => p.revision), [2, 3]);
  // With the newer instruction in view the real refiner now reads both as steering.
  await classify(registry, id, "steer");
  const goal = registry.getGoal(id)!;
  assert.equal(goal.relationship, "steer");
  assert.equal(goal.resolvedPromptRevision, 3);
  assert.equal(goal.objective, "Ship the feature");
  assert.deepEqual(readSessionGoalSteering(id, 3).map((n) => [n.revision, n.instruction]), [
    [2, "maybe also restyle it"],
    [3, "use the existing button styles"],
  ]);
});

test("two quick instructions judged unclear: the earlier is kept as steering, the later pauses, accept records both", async () => {
  const id = "unclear-pair";
  const registry = session(id);
  registry.captureAcceptedPrompt(id, "maybe also restyle it", id);
  registry.captureAcceptedPrompt(id, "or perhaps the other heading", id);
  await classify(registry, id, "unclear");
  const paused = registry.getGoal(id)!;
  assert.equal(paused.relationship, "unclear", "the latest instruction still pauses wrap-up");
  assert.equal(paused.resolvedPromptRevision, 3);
  assert.equal(paused.objective, "Ship the feature");
  const kept = readSessionGoalSteering(id, 3);
  assert.deepEqual(kept.map((n) => [n.revision, n.instruction]), [[2, "maybe also restyle it"]]);
  assert.match(kept[0]!.rationale, /^Kept as steering: a newer instruction arrived before this one was clear\./);

  const accepted = registry.acceptGoalObjective(id, 900);
  assert.ok(accepted && accepted.accepted);
  assert.deepEqual(readSessionGoalSteering(id, 3).map((n) => [n.revision, n.instruction]), [
    [2, "maybe also restyle it"],
    [3, "or perhaps the other heading"],
  ]);
  assert.equal(registry.getGoal(id)!.objective, "Ship the feature");
});

test("revision controls ordering and cutoff even when timestamps tie; pruning protects live keys", () => {
  const id = "ordered-steering";
  const registry = session(id);
  for (const instruction of ["first method", "second method"]) {
    registry.captureAcceptedPrompt(id, instruction, id);
    registry.resolveGoal(id, { relationship: "steer", resolvedPromptRevision: registry.getGoal(id)!.promptRevision,
      pendingPrompts: [] }, instruction, 100);
  }
  assert.deepEqual(readSessionGoalSteering(id, 3).map((note) => [note.revision, note.timestamp]), [[2, 100], [3, 100]]);
  assert.deepEqual(readSessionGoalSteering(id, 2).map((note) => note.revision), [2]);
  pruneSessionGoalSteering([id], 101);
  assert.equal(readSessionGoalSteering(id, 3).length, 2);
  assert.equal(pruneSessionGoalSteering(["another-live-key"], 101), 2);
});

test("steering pruning with no live keys deletes expired rows but retains cutoff and newer rows", () => {
  const id = "empty-key-steering-prune";
  const registry = session(id);
  for (const timestamp of [1, 2, 3]) {
    registry.captureAcceptedPrompt(id, `Method at ${timestamp}`, id);
    registry.resolveGoal(id, { relationship: "steer", resolvedPromptRevision: registry.getGoal(id)!.promptRevision,
      pendingPrompts: [] }, `Method at ${timestamp}`, timestamp);
  }
  assert.equal(pruneSessionGoalSteering([], 2), 1);
  assert.deepEqual(readSessionGoalSteering(id, 4).map((note) => note.timestamp), [2, 3]);
  assert.equal(pruneSessionGoalSteering([], 2), 0, "repeated pruning is idempotent");
});

test("Registry prunes stranded steering after an empty session sweep, never before discovery", () => {
  const id = "swept-steering-prune";
  const registry = session(id);
  registry.captureAcceptedPrompt(id, "change the sequence", id);
  registry.resolveGoal(id, { relationship: "steer", resolvedPromptRevision: 2,
    pendingPrompts: [] }, "change the sequence", 100);
  const notes = readSessionGoalSteering(id, 2);
  assert.equal(notes.length, 1);
  registry.pruneGoals(101);
  assert.deepEqual(readSessionGoalSteering(id, 2), notes, "an observed live session keeps its steering");

  const recovered = new Registry();
  recovered.pruneGoals(101);
  assert.deepEqual(readSessionGoalSteering(id, 2), notes, "an unswept registry does not know liveness yet");
  recovered.applyDiscovery([]);
  recovered.pruneGoals(101);
  assert.deepEqual(readSessionGoalSteering(id, 2), [], "an observed empty session set permits cleanup");
});

test("daemon echoes never reach steering, while a later human retype does", async () => {
  for (const [index, instruction] of ["skip the E2E for now", "Foreman packet " + "very long payload ".repeat(400)].entries()) {
    const id = `daemon-echo-${index}`;
    const registry = session(id);
    const submit = () => registry.applyHook({
      agent: "claude", event: "UserPromptSubmit", sessionId: null, cwd: null,
      transcriptPath: null, env: { tmuxPane: `%${id}` }, prompt: instruction,
    } as HookIngest);
    reserveInjection(id, instruction, "workflow");
    submit(); // Echo arrives before the delivery acknowledgement, including unreshaped long text.
    confirmReservedInjection(id, instruction, "workflow");
    await classify(registry, id, "steer");
    assert.equal(registry.getGoal(id)!.promptRevision, 1);
    assert.deepEqual(readSessionGoalSteering(id, 2), []);

    submit(); // The delivery owes no more echoes. These are now the human's words.
    const accepted = registry.getGoal(id)!.prompt;
    assert.equal(registry.getGoal(id)!.promptRevision, 2);
    await classify(registry, id, "steer");
    assert.deepEqual(readSessionGoalSteering(id, 2).map((note) => note.instruction), [accepted]);
    assert.equal(registry.isGoalSteering(id, 2, instruction), true,
      "the original transcript text must also stay out of criteria compaction");
  }
});

test("a recovered accepted prompt still records its classified steering", async () => {
  const id = "recovered-steering";
  const registry = session(id);
  registry.captureAcceptedPrompt(id, "unattributed recovered instruction", id);
  const recovered = session("other-session");
  recovered.applyDiscovery([{
    syntheticId: id, agent: "claude", name: id, nameSource: "process", cwd: home,
    gitBranch: null, gitRoot: null, repoRoot: null, pid: 9002, tty: id,
    terminals: [mkMuxHandle({ session: "s", windowName: "w", windowIndex: 0, paneId: `%${id}` })], startedAt: 1,
  } as DiscoveredSession]);
  await classify(recovered, id, "steer");
  assert.deepEqual(readSessionGoalSteering(id, 2).map((note) => note.instruction), ["unattributed recovered instruction"]);
});


test("opening a pre-steering database adds the table without backfilling or changing goals", () => {
  const id = "upgrade-steering";
  const registry = session(id);
  registry.captureAcceptedPrompt(id, "an older resolved instruction", id);
  registry.upsertGoal(id, { relationship: "steer", resolvedPromptRevision: 2, pendingPrompts: [] });
  const before = getSessionGoal(id);
  openDb().exec("DROP TABLE session_goal_steering");
  closeDb();
  openDb();
  assert.deepEqual(getSessionGoal(id), before);
  assert.deepEqual(readSessionGoalSteering(id, 2), []);
});
