import assert from "node:assert/strict";
import { after, test } from "node:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
writeFileSync(fake, `#!/bin/sh\ncat >/dev/null\ncat '${reply}'\n`);
chmodSync(fake, 0o755);
process.env.MISSION_CLAUDE_BIN = fake;
const { configureClaudeRunnerTransport } = await import("../src/server/llm/claude.ts");
const restore = configureClaudeRunnerTransport(() => "print");
const { Registry } = await import("../src/server/registry.ts");
const { startGoalRefiner } = await import("../src/server/goal/refiner.ts");
const { openDb, closeDb, getSessionGoal, upsertSessionGoalWithSteering, readSessionGoalSteering,
  pruneSessionGoalSteering } = await import("../src/server/db.ts");
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
  assert.equal(pruneSessionGoalSteering([], 101), 0);
  pruneSessionGoalSteering([id], 101);
  assert.equal(readSessionGoalSteering(id, 3).length, 2);
  assert.equal(pruneSessionGoalSteering(["another-live-key"], 101), 2);
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
