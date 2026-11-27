import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpokenName } from "../src/shared/voice-names.ts";
import type { Task } from "../src/shared/types.ts";
import { mkTask } from "./helpers/session-fixture.ts";

// Automatic call signs: a task dispatched without one takes a distinctive name from a curated
// dictionary as it launches, chosen against every name already spoken for, inside the launch's
// synchronous claim so simultaneous dispatches cannot take the same name.

const home = mkdtempSync(join(tmpdir(), "mission-voice-call-sign-allocation-"));
process.env.HARNESS_HOME = home;
// A binary that exists, so agent-binary resolution is never what stops a launch here (CI has no
// `claude` on PATH): the launches below must reach the provisioning seam each test stubs.
process.env.MISSION_CLAUDE_BIN = "/bin/echo";

const { AUTO_CALL_SIGN_DICTIONARY, chooseAutoCallSign } = await import("../src/shared/voice-call-signs.ts");
const { namesSoundAlike, validateSpokenName } = await import("../src/shared/voice-names.ts");
const { allocateCallSign, callSignClaims } = await import("../src/server/voice/call-sign-allocation.ts");
const { Registry } = await import("../src/server/registry.ts");
const { Dispatcher } = await import("../src/server/dispatcher.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { getTask } = await import("../src/server/db.ts");

after(() => {
  delete process.env.MISSION_CLAUDE_BIN;
  rmSync(home, { recursive: true, force: true });
});

function entry(over: Partial<SpokenName> & Pick<SpokenName, "name">): SpokenName {
  return {
    key: `task:${over.name}`, kind: "session", taskId: null, sessionId: null, role: "", colorId: null,
    agent: "claude", state: "running", ...over,
  };
}

const claim = (name: string, displaceable = false) => ({ name, displaceable });

test("the dictionary holds a few dozen names, each distinctive alone and none heard as another", () => {
  assert.ok(AUTO_CALL_SIGN_DICTIONARY.length >= 30 && AUTO_CALL_SIGN_DICTIONARY.length <= 60, `${AUTO_CALL_SIGN_DICTIONARY.length} names`);
  for (const name of AUTO_CALL_SIGN_DICTIONARY) {
    assert.deepEqual(validateSpokenName(name), [], `${name} draws no warning on its own`);
  }
  for (const [i, a] of AUTO_CALL_SIGN_DICTIONARY.entries()) {
    for (const b of AUTO_CALL_SIGN_DICTIONARY.slice(i + 1)) {
      assert.equal(namesSoundAlike(a, b), false, `${a} and ${b} sound alike`);
    }
  }
});

test("the choice is fixed by the seed, and different seeds spread over the dictionary", () => {
  assert.equal(chooseAutoCallSign([], "task-a"), chooseAutoCallSign([], "task-a"));
  const picks = new Set(Array.from({ length: 40 }, (_, i) => chooseAutoCallSign([], `task-${i}`)));
  assert.ok(picks.size >= 15, `40 seeds chose ${picks.size} different names`);
});

test("a name heard as any agent's is skipped: the same name, a sound-alike, a resident's reference name", () => {
  const dictionary = ["Atlas", "Raven", "Mango"];
  for (const taken of ["atlas", "Atlass", "Atlases"]) {
    const name = chooseAutoCallSign([claim(taken)], "seed", ["Atlas"]);
    assert.equal(name, null, `Atlas is heard as ${taken}`);
  }
  const chosen = chooseAutoCallSign([claim("Ravens"), claim("Atlas"), { name: "Mango", isReferenceName: true, displaceable: false }], "seed", [...dictionary, "Topaz"]);
  assert.equal(chosen, "Topaz");
});

test("with every name held, a finished task's exact name is reused before the task goes unnamed", () => {
  const dictionary = ["Atlas", "Raven"];
  assert.equal(chooseAutoCallSign([claim("Atlas"), claim("Raven", true)], "seed", dictionary), "Raven", "a finished task's name is reused");
  assert.equal(chooseAutoCallSign([claim("Atlas"), claim("Ravens", true)], "seed", dictionary), null,
    "a finished task only heard like it keeps its own name, so reusing it would leave two on the roster");
  assert.equal(chooseAutoCallSign([claim("Atlas"), claim("Raven")], "seed", dictionary), null, "exhausted: no name at all");
  assert.equal(chooseAutoCallSign(AUTO_CALL_SIGN_DICTIONARY.map((name) => claim(name)), "seed"), null, "the whole dictionary held");
});

test("the claims are every unfinished task's name and the roster's, less the task's own", () => {
  const tasks: Task[] = [
    mkTask({ id: "self", status: "dispatching" }),
    mkTask({ id: "launching", status: "dispatching", callSign: "Raven" }),
    mkTask({ id: "shelved", status: "backlog", callSign: "Mango" }),
    mkTask({ id: "done", status: "done", callSign: "Lotus" }),
  ];
  const roster = [
    entry({ key: "resident:r1", kind: "resident", name: "Sage", isReferenceName: true }),
    entry({ key: "task:self", name: "Self" }),
    entry({ key: "task:launching", name: "Raven", taskId: "launching" }),
    entry({ key: "task:done", name: "Lotus", taskId: "done", state: "not-running" }),
    entry({ key: "task:hib", name: "Comet", taskId: "hib", state: "hibernated" }),
  ];
  assert.deepEqual(callSignClaims(tasks[0]!, roster, tasks), [
    { name: "Raven", displaceable: false },
    { name: "Mango", displaceable: false },
    { name: "Sage", isReferenceName: true, displaceable: false },
    { name: "Lotus", displaceable: true },
    { name: "Comet", displaceable: false },
  ]);
});

test("an explicit call sign is kept, and a resident's task is never named", () => {
  assert.equal(allocateCallSign(mkTask({ id: "x", callSign: "Captain" }), [], []), null);
  assert.equal(allocateCallSign(mkTask({ id: "y", kind: "resident" }), [], []), null);
  assert.ok(allocateCallSign(mkTask({ id: "z" }), [], []));
});

test("simultaneous dispatches each take a different, distinctive name in their claim, stored on the task", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const roster = [entry({ key: "resident:r1", kind: "resident", name: "Atlas", isReferenceName: true })];
  const dispatcher = new Dispatcher(registry, undefined, {
    assignCallSign: (task) => allocateCallSign(task, roster, registry.listTasks()),
    // Every launch stops before provisioning: only the claim is under test.
    resolveBases: async () => { throw new Error("stopped before provisioning"); },
  });
  const created = Array.from({ length: 8 }, (_, i) => tasks.create({
    repoRoot: "/repo", intent: `work ${i}`, title: `Work ${i}`, kind: "ship", agent: "claude", workflowId: null, backlog: true,
  }));
  const explicit = tasks.create({
    repoRoot: "/repo", intent: "named", title: "Named", kind: "ship", agent: "claude", workflowId: null, backlog: true, callSign: "Captain",
  });
  const launches = [...created, explicit].map((task) => dispatcher.dispatch(task.id));
  // Read before any launch has awaited anything: each claim already holds its name.
  const names = created.map((task) => registry.getTask(task.id)!.callSign!);
  assert.equal(registry.getTask(explicit.id)!.callSign, "Captain", "an operator's own call sign is kept");
  await Promise.allSettled(launches);

  assert.equal(new Set(names).size, names.length, `distinct: ${names.join(", ")}`);
  for (const [i, name] of names.entries()) {
    assert.ok((AUTO_CALL_SIGN_DICTIONARY as readonly string[]).includes(name), `${name} is from the dictionary`);
    assert.equal(namesSoundAlike(name, "Atlas"), false, "never heard as the resident's reference name");
    assert.equal(namesSoundAlike(name, "Captain"), false);
    for (const other of names.slice(i + 1)) assert.equal(namesSoundAlike(name, other), false, `${name} and ${other}`);
    assert.equal(getTask(created[i]!.id)!.callSign, name, "persisted on the task row");
  }

  // Launched again, a task keeps the name its first launch gave it.
  await dispatcher.dispatch(created[0]!.id).catch(() => {});
  assert.equal(getTask(created[0]!.id)!.callSign, names[0]);
});

test("the task manager hands its launches the installed choice, and none is named without one", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const make = (title: string) => tasks.create({
    repoRoot: join(home, "missing-repo"), intent: title, title, kind: "ship", agent: "claude", workflowId: null, backlog: true,
  });
  const unnamed = make("Unnamed");
  await tasks.dispatch(unnamed.id);
  assert.equal(getTask(unnamed.id)!.callSign, undefined, "no choice installed: no name");

  tasks.useCallSignAllocation((task) => allocateCallSign(task, [], registry.listTasks()));
  const named = make("Named");
  await tasks.dispatch(named.id);
  const sign = getTask(named.id)!.callSign;
  assert.ok(sign && (AUTO_CALL_SIGN_DICTIONARY as readonly string[]).includes(sign), `took ${sign}`);
});

test("with every safe name taken a launch still claims its task and proceeds, unnamed, leaving every holder's name alone", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  // Every dictionary name answered to by a resident: none can be displaced.
  const roster = AUTO_CALL_SIGN_DICTIONARY.map((name, i) =>
    entry({ key: `resident:r${i}`, kind: "resident", name, isReferenceName: true }));
  let reachedProvisioning = 0;
  const dispatcher = new Dispatcher(registry, undefined, {
    assignCallSign: (task) => allocateCallSign(task, roster, registry.listTasks()),
    // Reaching the base lookup proves the launch went on past the claim; it stops here.
    resolveBases: async () => { reachedProvisioning++; throw new Error("stopped before provisioning"); },
  });
  const unnamed = tasks.create({
    repoRoot: "/repo", intent: "work", title: "Work", kind: "ship", agent: "claude", workflowId: null, backlog: true,
  });
  // The file shares one database, so earlier cases' tasks are in this catalog with their names.
  const namesBefore = () => registry.listTasks().filter((task) => task.id !== unnamed.id)
    .map((task) => [task.id, task.callSign ?? null] as const).sort();
  const before = namesBefore();
  const launch = dispatcher.dispatch(unnamed.id);
  const claimed = registry.getTask(unnamed.id)!;
  assert.equal(claimed.status, "dispatching", "the claim is written");
  assert.ok(claimed.dispatchedAt, "the launch is under way");
  assert.equal(claimed.callSign, undefined, "no name rather than one heard as another agent's");
  await launch.catch(() => {});
  assert.equal(reachedProvisioning, 1, "the launch proceeded past the claim");
  assert.equal(getTask(unnamed.id)!.callSign, undefined, "nothing stored");
  assert.equal(getTask(unnamed.id)!.error, "stopped before provisioning", "it failed only where this test stopped it");
  assert.deepEqual(namesBefore(), before, "no other task's name was touched");
});

test("with every name held but one finished task's, a launch reuses that exact name before going unnamed", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const [freed, ...held] = AUTO_CALL_SIGN_DICTIONARY;
  const roster = [
    ...held.map((name, i) => entry({ key: `resident:r${i}`, kind: "resident", name, isReferenceName: true })),
    entry({ key: "task:finished", name: freed!, taskId: "finished", state: "not-running" }),
  ];
  const dispatcher = new Dispatcher(registry, undefined, {
    assignCallSign: (task) => allocateCallSign(task, roster, registry.listTasks()),
    resolveBases: async () => { throw new Error("stopped before provisioning"); },
  });
  const unnamed = tasks.create({
    repoRoot: "/repo", intent: "work", title: "Work", kind: "ship", agent: "claude", workflowId: null, backlog: true,
  });
  await dispatcher.dispatch(unnamed.id).catch(() => {});
  assert.equal(getTask(unnamed.id)!.callSign, freed, "the finished task's name is taken over");
});
