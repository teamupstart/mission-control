// The after-work prompt (task shaping's route stage, D12 and D16): once per launch, from either
// caller, delivered only at idle, held behind Foreman's wrap-up on a task with no workflow, and
// recorded in its own table. The outbox is a stand-in that runs the real queueing transaction;
// both real callers are driven through `WorkflowManager` at the end.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { PendingTurn, ServerEvent, Session, Task } from "../src/shared/types.ts";
import type { TaskShaping } from "../src/shared/shaping.ts";

const home = mkdtempSync(join(tmpdir(), "mission-shaping-after-work-"));
process.env.HARNESS_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const db = await import("../src/server/db.ts");
const { AfterWorkSkills, afterWorkTurnId, renderAfterWorkPrompt, wireAfterWorkSkills } = await import("../src/server/shaping/after-work.ts");
const { deliverySchedule, deliveryStage, AFTER_WORK_SKILLS_TURN_PREFIX } = await import("../src/shared/message-delivery.ts");
const { mkTask } = await import("./helpers/session-fixture.ts");

function record(sessionId: string, skills: Array<[string, string, string?]> = [["retro", "after-work"], ["lint-fix", "during"]]): TaskShaping {
  return {
    state: "ok", at: 1, durationMs: 5, entries: 0, bytes: 400, truncated: false, sessionId, deliveryId: `d-${sessionId}`,
    shapers: [{
      id: "router", label: "Router", stage: "route", origin: "registered", sha256: null, outcome: "ok", reason: null,
      durationMs: 1, entries: 0, bytes: 0, truncated: false, redacted: false, version: null,
    }],
    skills: skills.map(([name, lifecyclePoint, state = "announced"]) => ({
      name, lifecyclePoint, reasonId: `r/${name}`, shaper: "router", repositories: ["repo"],
      state: state as "announced", verified: false, reason: null,
    })),
  };
}

/** A registry with exactly what the prompter reads, over tasks stored in the real database. */
class FakeRegistry extends EventEmitter {
  sessions = new Map<string, Session>();
  tasks = new Map<string, Task>();
  getSession(id: string) { return this.sessions.get(id); }
  getTask(id: string) { return this.tasks.get(id); }
  subscribe(fn: (event: ServerEvent) => void) { this.on("event", fn); return () => this.off("event", fn); }
  onTurnDelivered(fn: (event: { sessionId: string; turnId: string; deliveredAt: number }) => void) {
    this.on("delivered", fn);
    return () => this.off("delivered", fn);
  }
  launch(taskId: string, sessionId: string, shaping: TaskShaping | null = record(sessionId), agent: Session["agent"] = "claude") {
    // Bound under the delivery the record describes, as a launch's commit binds it.
    const task = {
      ...(this.tasks.get(taskId) ?? baseTask(taskId)),
      sessionId,
      ...(shaping ? { shaping, shapingDelivery: shaping.deliveryId } : {}),
    } as Task;
    if (!shaping) {
      delete (task as { shaping?: unknown }).shaping;
      delete (task as { shapingDelivery?: unknown }).shapingDelivery;
    }
    this.tasks.set(taskId, task);
    db.upsertTask(task);
    this.sessions.set(sessionId, { id: sessionId, agent, task: { id: taskId } } as unknown as Session);
  }
}

function baseTask(id: string): Task {
  return mkTask({ id, status: "running" });
}

interface Queued { sessionId: string; turn: PendingTurn }

function setup(options: {
  enabled?: boolean;
  staged?: Set<string>;
  catalog?: Record<string, string>;
  /** Catalog ids whose live check fails, with the sentence `requiredSkillCommand` would give. */
  refused?: Record<string, string>;
  /** The outbox refuses while this returns a refusal, as a starting outbox or a busy pane does. */
  outboxRefusal?: () => { error: string; retryable: boolean } | null;
  /** A task-shaping flag the test turns on and off, and tells the prompter about, as the flag store does. */
  flag?: { on: boolean; listeners: Set<() => void> };
  /** Collects what the prompter schedules, with its delay, so a test runs it when it chooses. */
  scheduled?: Array<{ fn: () => void; ms: number; cancelled: boolean }>;
  /** Sessions a durable signal says are owed a prompt, as the workflow manager reports them. */
  owed?: () => Array<{ sessionId: string; submittedAt: number }>;
} = {}) {
  const registry = new FakeRegistry();
  const queued: Queued[] = [];
  let now = 1_000;
  const prompts = new AfterWorkSkills({
    registry,
    outbox: {
      submitDaemonTurn(sessionId, create) {
        const refusal = options.outboxRefusal?.();
        if (refusal) return { ok: false, retryable: refusal.retryable, pasted: false, submitVerified: false, error: refusal.error };
        const turn = create(`note:${sessionId}`, now);
        if (turn) queued.push({ sessionId, turn });
        return { ok: true, pasted: false, submitVerified: false, delivery: "pending", ...(turn ? { pendingTurn: turn } : {}) };
      },
    },
    workflowSkills: () => options.staged ?? new Set(),
    enabled: () => (options.flag ? options.flag.on : options.enabled ?? true),
    ...(options.flag
      ? { onFlagsChanged: (listener: () => void) => { options.flag!.listeners.add(listener); return () => { options.flag!.listeners.delete(listener); }; } }
      : {}),
    now: () => ++now,
    ...(options.owed ? { owedSessions: options.owed } : {}),
    ...(options.scheduled
      ? { schedule: (fn: () => void, ms: number) => {
          const entry = { fn, ms, cancelled: false };
          options.scheduled!.push(entry);
          return () => { entry.cancelled = true; };
        } }
      : {}),
    catalogId: (name) => options.catalog?.[name] ?? null,
    catalogCommand: (_session, id) => options.refused?.[id]
      ? { ok: false, message: options.refused[id]! }
      : { ok: true, command: `/${id}` },
  });
  prompts.start();
  return { registry, queued, prompts };
}

let taskCounter = 0;
const nextTask = () => `task-${++taskCounter}`;

test("schema 45 adds the prompt table to an upgraded database, keyed by task and session", () => {
  db.openDb();
  db.closeDb();
  const raw = new DatabaseSync(join(home, "harness.db"));
  raw.exec("DROP TABLE task_skill_prompts");
  raw.exec("PRAGMA user_version = 44");
  raw.close();
  const upgraded = db.openDb();
  assert.ok(db.CURRENT_DATABASE_SCHEMA_VERSION >= 45);
  assert.equal((upgraded.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, db.CURRENT_DATABASE_SCHEMA_VERSION);
  const key = (upgraded.prepare("PRAGMA table_info(task_skill_prompts)").all() as Array<{ name: string; pk: number }>)
    .filter((column) => column.pk > 0).map((column) => column.name);
  assert.deepEqual(key, ["task_id", "session_id"]);
  const write = (sessionId: string) => db.insertTaskSkillPrompt({ taskId: "keyed", sessionId, state: "held", reason: null, skills: ["retro"], now: 1 });
  assert.equal(write("s1"), true);
  assert.equal(write("s1"), false, "one row per task and session");
  assert.equal(write("s2"), true, "a second launch into another session has its own row");
  // A resume carries the row to its successor, replacing a row the successor held from an earlier launch.
  assert.equal(db.rekeyTaskSkillPrompt("keyed", "s1", "s3"), true);
  assert.equal(db.getTaskSkillPrompt("keyed", "s1"), null);
  assert.equal(db.getTaskSkillPrompt("keyed", "s3")?.state, "held");
  db.settleTaskSkillPrompt({ taskId: "keyed", sessionId: "s2", from: ["held"], state: "skipped", reason: "earlier launch", at: 2 });
  assert.equal(db.rekeyTaskSkillPrompt("keyed", "s3", "s2"), true);
  assert.equal(db.getTaskSkillPrompt("keyed", "s2")?.state, "held", "the carried launch's row, not the obsolete one");
  assert.equal(db.getTaskSkillPrompt("keyed", "s3"), null);
});

test("an after-work row is idle-only on the outbox: it never steers or interrupts, unless expedited", () => {
  const session = { agent: "claude", runtime: "sdk" } as Session;
  const turn = { id: `${AFTER_WORK_SKILLS_TURN_PREFIX}t:s`, createdAt: 0, deliveryMode: "after-turn", deadlineAt: null } as PendingTurn;
  assert.deepEqual(deliverySchedule(session, turn), []);
  assert.equal(deliveryStage(session, turn, 10 * 60_000), null);
  const operator = { ...turn, id: "operator-message" };
  assert.ok(deliverySchedule(session, operator).length > 0, "an operator message still escalates");
  assert.deepEqual(deliverySchedule(session, { ...turn, deliveryMode: "steer", deadlineAt: 5 }), [{ at: 5, action: "steer" }]);
});

test("a submission prompts the after-work skills once, as one daemon turn led by the first invocation", () => {
  const { registry, queued, prompts } = setup();
  const taskId = nextTask();
  registry.launch(taskId, "s1", record("s1", [["retro", "after-work"], ["lint-fix", "during"], ["notes", "after-work"]]));
  assert.deepEqual(prompts.prompt("s1"), { kind: "queued" });
  assert.equal(queued.length, 1);
  const { turn } = queued[0]!;
  assert.equal(turn.id, afterWorkTurnId(taskId, "s1", 1));
  assert.equal(turn.text.split("\n")[0], "/retro", "the first skill's invocation is the turn's first line");
  assert.match(turn.text, /skill routing chose these skills for this task when it was dispatched/);
  assert.match(turn.text, /The work is complete/);
  assert.match(turn.text, /1\. `\/retro`\n2\. `\/notes`/);
  assert.doesNotMatch(turn.text, /lint-fix/, "only after-work skills");
  assert.deepEqual(db.getTaskSkillPrompt(taskId, "s1"), {
    taskId, turnId: turn.id, sessionId: "s1", state: "queued", reason: null, skills: ["retro", "notes"], createdAt: db.getTaskSkillPrompt(taskId, "s1")!.createdAt, deliveredAt: null,
  });
  // A repair round, a resubmit and the other caller never repeat it.
  assert.deepEqual(prompts.prompt("s1"), { kind: "none", why: "already" });
  assert.deepEqual(prompts.prompt("s1", { hold: true }), { kind: "none", why: "already" });
  assert.equal(queued.length, 1);
  // Delivery settles the row.
  registry.emit("delivered", { sessionId: "s1", turnId: turn.id, deliveredAt: 7_777 });
  assert.equal(db.getTaskSkillPrompt(taskId, "s1")?.state, "delivered");
  assert.equal(db.getTaskSkillPrompt(taskId, "s1")?.deliveredAt, 7_777);
  prompts.stop();
});

test("a second launch of the task into the same session replaces the first launch's prompt in its shaping commit", () => {
  const { registry, queued, prompts } = setup();
  const taskId = nextTask();
  // The first launch: its after-work prompt is queued and not yet delivered.
  registry.launch(taskId, "s1", { ...record("s1"), at: 100 });
  db.commitTaskShaping(taskId, { ...record("s1"), at: 100 }, "## Skills for this task", 100);
  assert.equal(prompts.prompt("s1").kind, "queued");
  const firstTurn = queued[0]!.turn.id;
  const outbox = () => db.openDb().prepare("SELECT id FROM pending_turns WHERE id = ?").all(firstTurn);
  assert.equal(outbox().length, 1);
  // A handover launches the task into the same session again. Its shaping commit supersedes the
  // first launch: the old row and its unclaimed outbox turn go in the same transaction.
  const second = { ...record("s1", [["notes", "after-work"]]), at: 200 };
  registry.launch(taskId, "s1", second);
  assert.equal(db.commitTaskShaping(taskId, second, "## Skills for this task", 200), true);
  assert.equal(db.getTaskSkillPrompt(taskId, "s1"), null, "no earlier launch's row reads as this launch's");
  assert.equal(outbox().length, 0, "the first launch's queued prompt never reaches the second launch");
  // The second launch is prompted for its own skills, once.
  assert.equal(prompts.prompt("s1").kind, "queued");
  assert.equal(queued.length, 2);
  assert.equal(queued[1]!.turn.text.split("\n")[0], "/notes");
  assert.notEqual(queued[1]!.turn.id, firstTurn, "each launch's turn has its own id");
  assert.deepEqual(db.getTaskSkillPrompt(taskId, "s1")?.skills, ["notes"]);
  assert.deepEqual(prompts.prompt("s1"), { kind: "none", why: "already" });
  // A delivery the first launch's turn would report settles nothing now.
  registry.emit("delivered", { sessionId: "s1", turnId: firstTurn, deliveredAt: 9 });
  assert.equal(db.getTaskSkillPrompt(taskId, "s1")?.state, "queued");
  // A third launch that no shaper applied to still supersedes the row for its session, and a
  // row for another session of the task is that launch's own and is kept.
  db.insertTaskSkillPrompt({ taskId, sessionId: "s0", state: "skipped", reason: null, skills: ["retro"], now: 1 });
  db.commitTaskShaping(taskId, null, "", 300, "s1");
  assert.equal(db.getTaskSkillPrompt(taskId, "s1"), null);
  assert.equal(db.getTaskSkillPrompt(taskId, "s0")?.state, "skipped");
  prompts.stop();
});

test("a restart is still once per launch, and a later launch into a new session gets its own prompt", () => {
  const first = setup();
  const taskId = nextTask();
  first.registry.launch(taskId, "s1");
  assert.equal(first.prompts.prompt("s1").kind, "queued");
  first.prompts.stop();
  // A fresh prompter over the same database: what a restarted daemon has.
  const restarted = setup();
  restarted.registry.tasks = first.registry.tasks;
  restarted.registry.sessions = first.registry.sessions;
  assert.deepEqual(restarted.prompts.prompt("s1"), { kind: "none", why: "already" });
  assert.equal(restarted.queued.length, 0);
  // The task launched again, into another session, with its own record.
  restarted.registry.launch(taskId, "s2");
  assert.equal(restarted.prompts.prompt("s2").kind, "queued");
  assert.equal(restarted.queued[0]!.turn.id, afterWorkTurnId(taskId, "s2", 1));
  assert.equal(db.getTaskSkillPrompt(taskId, "s1")?.state, "queued", "the first launch's row is its own");
  // The first session is no longer the task's: its prompt is never written again.
  assert.deepEqual(restarted.prompts.prompt("s1"), { kind: "none", why: "no_record" });
  restarted.prompts.stop();
});

test("nothing is prompted with the flag off, for a record naming another session, or with no after-work skill", () => {
  const off = setup({ enabled: false });
  const taskId = nextTask();
  off.registry.launch(taskId, "s1");
  assert.deepEqual(off.prompts.prompt("s1"), { kind: "none", why: "disabled" });
  assert.equal(db.getTaskSkillPrompt(taskId, "s1"), null);
  const on = setup();
  on.registry.launch(taskId, "s1", record("s0"));
  assert.deepEqual(on.prompts.prompt("s1"), { kind: "none", why: "no_record" });
  const other = nextTask();
  on.registry.launch(other, "s9", record("s9", [["lint-fix", "during"], ["retro", "after-work", "unavailable"]]));
  assert.deepEqual(on.prompts.prompt("s9"), { kind: "none", why: "no_after_work_skills" });
  assert.equal(db.getTaskSkillPrompt(other, "s9"), null);
  const unshaped = nextTask();
  on.registry.launch(unshaped, "s8", null);
  assert.deepEqual(on.prompts.prompt("s8"), { kind: "none", why: "no_record" });
  assert.equal(on.queued.length, 0);
  off.prompts.stop();
  on.prompts.stop();
});

test("a skill the armed workflow runs as a session-action stage is left to that stage", () => {
  const { registry, queued, prompts } = setup({ staged: new Set(["retro"]), catalog: { retro: "retro" } });
  const both = nextTask();
  registry.launch(both, "s1", record("s1", [["retro", "after-work"], ["notes", "after-work"]]));
  assert.equal(prompts.prompt("s1").kind, "queued");
  assert.equal(queued[0]!.turn.text.split("\n")[0], "/notes");
  assert.doesNotMatch(queued[0]!.turn.text, /retro/);
  const only = nextTask();
  registry.launch(only, "s2", record("s2", [["retro", "after-work"]]));
  assert.equal(prompts.prompt("s2").kind, "skipped");
  assert.equal(db.getTaskSkillPrompt(only, "s2")?.state, "skipped");
  assert.equal(queued.length, 1);
  prompts.stop();
});

test("with no workflow the prompt is held until the wrap-up is answered, and an unanswered card holds it", () => {
  const { registry, queued, prompts } = setup();
  const taskId = nextTask();
  registry.launch(taskId, "s1");
  // The session is idle at the claim already; still nothing is queued.
  assert.deepEqual(prompts.prompt("s1", { hold: true }), { kind: "held" });
  assert.equal(queued.length, 0);
  assert.deepEqual(db.getTaskSkillPrompt(taskId, "s1")?.skills, ["retro"]);
  assert.equal(db.getTaskSkillPrompt(taskId, "s1")?.state, "held");
  // The submission caller cannot overtake the hold either.
  assert.deepEqual(prompts.prompt("s1"), { kind: "none", why: "already" });
  assert.equal(queued.length, 0);
  // Answered: automatic, the card, or a skipped wrap-up all release it, once.
  prompts.release("s1");
  assert.equal(queued.length, 1);
  assert.equal(db.getTaskSkillPrompt(taskId, "s1")?.state, "queued");
  prompts.release("s1");
  assert.equal(queued.length, 1, "a second answer queues nothing more");
  prompts.stop();
});

test("a skipped wrap-up's marker releases a held prompt through the queue", async () => {
  const { Registry } = await import("../src/server/registry.ts");
  const { QueueManager } = await import("../src/server/queue.ts");
  const queues = new QueueManager(new Registry());
  const answered: string[] = [];
  queues.onWrapupAnswered((key) => answered.push(key));
  queues.setWrapupAnswer("note-1", "foreman:automatic-wrapup-skipped");
  queues.setWrapupAnswer("note-1", null);
  queues.setWrapupAnswer("note-2", "/ship");
  assert.deepEqual(answered, ["note-1", "note-2"], "every recorded answer, never a cleared one");
});

test("a session that ends before delivery leaves the row not delivered, with why", () => {
  const { registry, prompts } = setup();
  const queuedTask = nextTask();
  registry.launch(queuedTask, "s1");
  prompts.prompt("s1");
  const heldTask = nextTask();
  registry.launch(heldTask, "s2");
  prompts.prompt("s2", { hold: true });
  registry.emit("event", { type: "session_remove", id: "s1" });
  registry.emit("event", { type: "session_remove", id: "s2" });
  for (const taskId of [queuedTask, heldTask]) {
    const row = db.getTaskSkillPrompt(taskId, taskId === queuedTask ? "s1" : "s2");
    assert.equal(row?.state, "not_delivered");
    assert.match(row?.reason ?? "", /session ended/);
  }
  // Releasing a held prompt whose session is gone writes the same.
  const goneTask = nextTask();
  registry.launch(goneTask, "s3");
  prompts.prompt("s3", { hold: true });
  registry.sessions.delete("s3");
  prompts.release("s3");
  assert.equal(db.getTaskSkillPrompt(goneTask, "s3")?.state, "not_delivered");
  prompts.stop();
});

test("a prompt whose skills cannot be invoked is not delivered, and says which and why", () => {
  const refusal = "Wait for Claude to reload its skills before sending this instruction.";
  const { registry, queued, prompts } = setup({ catalog: { retro: "retro" }, refused: { retro: refusal } });
  const taskId = nextTask();
  // The one after-work skill is a catalog skill whose live check fails when the work is complete.
  registry.launch(taskId, "s1", record("s1"));
  const outcome = prompts.prompt("s1");
  assert.equal(outcome.kind, "not_delivered");
  assert.equal(queued.length, 0, "no turn is queued");
  const row = db.getTaskSkillPrompt(taskId, "s1");
  assert.equal(row?.state, "not_delivered");
  assert.equal(row?.turnId, null, "it never reached the outbox");
  assert.deepEqual(row?.skills, ["retro"]);
  assert.equal(row?.reason, `No skill resolved. retro: ${refusal}`, "the reason names the skill and why");
  // Once per launch: the failure is the launch's answer, and a later call does not retry it.
  assert.deepEqual(prompts.prompt("s1"), { kind: "none", why: "already" });
  assert.equal(queued.length, 0);
  // A held prompt that cannot be invoked when it is released ends the same way.
  const held = nextTask();
  registry.launch(held, "s2", record("s2"));
  assert.deepEqual(prompts.prompt("s2", { hold: true }), { kind: "held" });
  prompts.release("s2");
  assert.equal(queued.length, 0);
  assert.equal(db.getTaskSkillPrompt(held, "s2")?.state, "not_delivered");
  assert.equal(db.getTaskSkillPrompt(held, "s2")?.reason, `No skill resolved. retro: ${refusal}`);
  // With one skill refused and another resolved, the prompt goes out with the one that resolved.
  const mixed = nextTask();
  registry.launch(mixed, "s3", record("s3", [["retro", "after-work"], ["notes", "after-work"]]));
  assert.equal(prompts.prompt("s3").kind, "queued");
  assert.equal(queued[0]!.turn.text.split("\n")[0], "/notes");
  assert.doesNotMatch(queued[0]!.turn.text, /retro/);
  assert.deepEqual(db.getTaskSkillPrompt(mixed, "s3")?.skills, ["notes"]);
  assert.equal(renderAfterWorkPrompt("s1", []), null);
  prompts.stop();
});

test("a Codex session's prompt leads with Codex's typed invocation and names the rest without it", () => {
  const { registry, queued, prompts } = setup();
  const taskId = nextTask();
  registry.launch(taskId, "s1", record("s1", [["retro", "after-work"], ["notes", "after-work"]]), "codex");
  assert.equal(prompts.prompt("s1").kind, "queued");
  assert.equal(queued[0]!.turn.text.split("\n")[0], "$retro - run this skill now.");
  assert.match(queued[0]!.turn.text, /1\. `\$retro`\n2\. `\$notes`/, "the list names them without the clause");
  prompts.stop();
});

// ---------------------------------------------------------------------------------------------
// Both callers, through the workflow manager

test("the engine's activation and a claim with no binding both reach the prompter", async () => {
  const { Registry } = await import("../src/server/registry.ts");
  const { QueueManager } = await import("../src/server/queue.ts");
  const { PersonaManager } = await import("../src/server/workflows/personas.ts");
  const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
  const { fallbackWorkflowContext } = await import("../src/server/workflows/context.ts");
  const d = db.openDb();
  const graph = {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 100, y: 0 } },
    ],
    edges: [{ id: "done", source: "session", sourcePort: "submitted", target: "end", targetPort: "terminal" }],
  };
  const defaults = JSON.stringify({ triggerMode: "foreman_complete", deliveryMode: "preview", maxRepairRounds: 2 });
  d.prepare(`INSERT INTO workflow_definitions (id, name, normalized_name, description, draft_graph_json, completion_policy_json,
      binding_defaults_json, draft_revision, current_version_id, archived_at, created_at, updated_at)
    VALUES ('w', 'Review', 'review', '', ?, '{"kind":"none"}', ?, 1, 'v', NULL, 1, 1)`).run(JSON.stringify(graph), defaults);
  d.prepare(`INSERT INTO workflow_versions (id, workflow_id, version, source_draft_revision, graph_json, completion_policy_json,
      binding_defaults_json, published_at) VALUES ('v', 'w', 1, 1, ?, '{"kind":"none"}', ?, 1)`).run(JSON.stringify(graph), defaults);
  const registry = new Registry();
  const session = (id: string) => ({
    syntheticId: id, agent: "claude", name: id, nameSource: "process", cwd: "/repo", gitBranch: "feature", gitRoot: "/repo",
    repoRoot: "/repo", agentSessionId: id, pid: id.length, tty: `tty-${id}`, terminals: [], startedAt: 1,
  });
  registry.applyDiscovery([session("bound"), session("unbound")] as never);
  const calls: Array<[string, boolean]> = [];
  const workflows = new WorkflowManager(registry, new PersonaManager(registry).store, {
    queueManager: new QueueManager(registry),
    afterWorkSkills: { prompt: (sessionId, options) => calls.push([sessionId, options?.hold === true]) },
    inject: (async () => ({ ok: true, pasted: true, submitVerified: true })) as never,
    recordInjection: (() => {}) as never,
    readContextRaw: async (_registry, binding) => {
      const raw = {
        primaryGoal: { rawPrompt: "Goal", refined: null, sourceNoteKey: binding.noteKey },
        humanDecisions: [], priorPersonaFeedback: [],
        session: { agent: "claude", name: "bound", cwd: "/repo", branch: "feature" },
        evidence: {
          headSha: "abc", diffFingerprint: "diff", diff: "patch", diffTruncated: false, workingTreeDirty: true,
          workingTreeStatus: [], workingTreeStatusTruncated: false, transcript: [], transcriptAnchor: 1,
          transcriptTruncated: false, standards: [], standardsTruncated: false,
        },
      };
      return {
        raw, context: fallbackWorkflowContext(raw, null),
        boundary: { noteKey: binding.noteKey, sessionId: binding.sessionId!, headSha: "abc", transcriptPath: null, transcriptSize: 1, repositoryFingerprint: "repo" },
      };
    },
    boundaryChanged: async () => false,
    compactContext: async (raw) => fallbackWorkflowContext(raw, "test"),
  });
  workflows.store.insertBinding({
    id: "binding", workflowVersionId: "v", noteKey: "bound", sessionId: "bound", sessionAgent: "claude", sessionName: "bound",
    sessionCwd: "/repo", sessionRepoRoot: "/repo", triggerMode: "foreman_complete", deliveryMode: "preview", maxRepairRounds: 2, now: 1,
  });
  // The drain proof a claim spends: a queue whose one item was verified complete.
  d.prepare(`INSERT INTO foreman_queues (note_key, cwd, branch, wrapup_asked_at, wrapup_answer, prompted_goal, updated_at)
    VALUES ('bound', '/repo', 'feature', NULL, NULL, NULL, 10)`).run();
  d.prepare(`INSERT INTO foreman_queue_items (id, note_key, seq, intent, state, round, base_sha, transcript_anchor, gaps,
      send_attempts, verify_failures, escalation_reason, last_verdict, approved_at, proposed_payload, recovered_at, revision,
      created_at, updated_at, sent_at, completed_at)
    VALUES ('item', 'bound', 0, 'work', 'verified', 1, 'base', 1, '[]', 1, 0, NULL, 'complete', NULL, NULL, NULL, 0, 1, 2, 1, 2)`).run();
  const claim = (marker: string) => ({
    completionKind: "drain" as const, marker, expectedWorkCycle: null, summary: "Done.", evidenceFingerprint: "evidence", expectedIntent: null,
  });
  assert.deepEqual(await workflows.claimCompletion("unbound", claim("0".repeat(64))), { claimed: false, reason: "no_binding" });
  assert.deepEqual(calls, [["unbound", true]], "a claim with no binding holds the prompt behind Foreman's wrap-up");
  const claimed = await workflows.claimCompletion("bound", claim("1".repeat(64)));
  assert.equal(claimed.claimed, true);
  assert.deepEqual(calls.slice(1), [["bound", false]], "the after-work step starting prompts it");
  assert.deepEqual([...workflows.sessionActionSkills("bound")], [], "this workflow runs no skill as a stage");
});

test("a resume moves the launch's record and its prompt row together, or neither", () => {
  const taskId = nextTask();
  db.upsertTask(mkTask({ id: taskId, status: "running", sessionId: "s1" }));
  db.commitTaskShaping(taskId, record("s1"), "", 1);
  db.insertTaskSkillPrompt({ taskId, sessionId: "s1", state: "held", reason: null, skills: ["retro"], now: 1 });
  const d = db.openDb();
  // The second write fails: the first is undone with it, so a restart can never find the record
  // on the successor with its prompt row left behind on the prior session.
  d.exec(`CREATE TEMP TRIGGER fail_prompt_rekey BEFORE UPDATE OF session_id ON task_skill_prompts
          BEGIN SELECT RAISE(ABORT, 'prompt re-key failed'); END`);
  assert.throws(() => db.rekeyTaskLaunch(taskId, "s1", "s2"), /prompt re-key failed/);
  assert.equal(db.taskShapingRecord(taskId)?.sessionId, "s1", "the record did not move without its prompt row");
  assert.equal(db.getTaskSkillPrompt(taskId, "s1")?.state, "held");
  // Inside a caller's transaction the failure undoes only the two moves, never the caller's writes.
  d.exec("BEGIN IMMEDIATE");
  db.insertTaskSkillPrompt({ taskId, sessionId: "caller-write", state: "skipped", reason: null, skills: [], now: 2 });
  assert.throws(() => db.rekeyTaskLaunch(taskId, "s1", "s2"));
  assert.equal(d.isTransaction, true, "the caller's transaction is still open");
  d.exec("COMMIT");
  assert.equal(db.getTaskSkillPrompt(taskId, "caller-write")?.state, "skipped");
  assert.equal(db.taskShapingRecord(taskId)?.sessionId, "s1");
  d.exec("DROP TRIGGER fail_prompt_rekey");
  // With nothing failing, both move in the one call.
  assert.equal(db.rekeyTaskLaunch(taskId, "s1", "s2"), true);
  assert.equal(db.taskShapingRecord(taskId)?.sessionId, "s2");
  assert.equal(db.getTaskSkillPrompt(taskId, "s1"), null);
  assert.equal(db.getTaskSkillPrompt(taskId, "s2")?.state, "held");
});

test("an outbox refusal that can clear keeps the prompt waiting, and it is sent once the session can take it", () => {
  let refusal: { error: string; retryable: boolean } | null = { error: "pending turns are still starting", retryable: true };
  const { registry, queued, prompts } = setup({ outboxRefusal: () => refusal });
  const taskId = nextTask();
  registry.launch(taskId, "s1");
  const outcome = prompts.prompt("s1");
  assert.equal(outcome.kind, "waiting");
  assert.equal(queued.length, 0);
  assert.equal(db.getTaskSkillPrompt(taskId, "s1")?.state, "waiting");
  assert.match(db.getTaskSkillPrompt(taskId, "s1")?.reason ?? "", /pending turns are still starting/);
  // The other caller, a repair round or a resubmit cannot queue a second one in the meantime.
  assert.deepEqual(prompts.prompt("s1"), { kind: "none", why: "already" });
  // A change to the session while the outbox still refuses keeps it waiting.
  registry.emit("event", { type: "session_upsert", session: registry.getSession("s1") });
  assert.equal(db.getTaskSkillPrompt(taskId, "s1")?.state, "waiting");
  // Once the outbox takes it, the next change to the session sends it, once.
  refusal = null;
  registry.emit("event", { type: "session_upsert", session: registry.getSession("s1") });
  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.turn.text.split("\n")[0], "/retro");
  assert.equal(db.getTaskSkillPrompt(taskId, "s1")?.state, "queued");
  registry.emit("event", { type: "session_upsert", session: registry.getSession("s1") });
  assert.equal(queued.length, 1, "a later change sends nothing more");
  prompts.stop();
});

test("a waiting prompt survives a restart and is sent when the daemon starts again", () => {
  const before = setup({ outboxRefusal: () => ({ error: "this session cannot receive messages", retryable: true }) });
  const taskId = nextTask();
  before.registry.launch(taskId, "s1");
  assert.equal(before.prompts.prompt("s1").kind, "waiting");
  before.prompts.stop();
  // A fresh prompter over the same database, whose outbox takes turns: what a restarted daemon
  // has. It starts before its sessions are restored, and a missing session is not an ended one.
  const after = setup();
  assert.equal(db.getTaskSkillPrompt(taskId, "s1")?.state, "waiting", "kept while the session is not restored yet");
  after.registry.tasks = before.registry.tasks;
  after.registry.sessions = before.registry.sessions;
  after.registry.emit("event", { type: "session_upsert", session: after.registry.getSession("s1") });
  assert.equal(after.queued.length, 1, "sent once its session is back");
  assert.equal(db.getTaskSkillPrompt(taskId, "s1")?.state, "queued");
  // And a restart that finds the session already there sends it at start.
  const third = nextTask();
  const waitingAgain = setup({ outboxRefusal: () => ({ error: "pending turns are still starting", retryable: true }) });
  waitingAgain.registry.launch(third, "s3");
  assert.equal(waitingAgain.prompts.prompt("s3").kind, "waiting");
  waitingAgain.prompts.stop();
  after.registry.tasks = waitingAgain.registry.tasks;
  after.registry.sessions = waitingAgain.registry.sessions;
  after.prompts.stop();
  after.prompts.start();
  assert.equal(db.getTaskSkillPrompt(third, "s3")?.state, "queued");
  after.prompts.stop();
});

test("a refusal that cannot clear still ends the prompt not delivered, and a waiting prompt whose session ends does too", () => {
  const gone = setup({ outboxRefusal: () => ({ error: "no such session", retryable: false }) });
  const taskId = nextTask();
  gone.registry.launch(taskId, "s1");
  assert.equal(gone.prompts.prompt("s1").kind, "not_delivered");
  assert.match(db.getTaskSkillPrompt(taskId, "s1")?.reason ?? "", /no such session/);
  gone.prompts.stop();
  const waiting = setup({ outboxRefusal: () => ({ error: "pending turns are still starting", retryable: true }) });
  const other = nextTask();
  waiting.registry.launch(other, "s2");
  assert.equal(waiting.prompts.prompt("s2").kind, "waiting");
  waiting.registry.emit("event", { type: "session_remove", id: "s2" });
  assert.equal(db.getTaskSkillPrompt(other, "s2")?.state, "not_delivered");
  waiting.prompts.stop();
});

test("a held prompt whose wrap-up was answered just before the daemon stopped is released when it starts again", () => {
  const before = setup();
  const taskId = nextTask();
  before.registry.launch(taskId, "s1");
  assert.deepEqual(before.prompts.prompt("s1", { hold: true }), { kind: "held" });
  // Foreman's answer is recorded, which marks the held prompt in the answer's own transaction,
  // and the daemon stops before the listener could release it.
  before.prompts.recordAnswered("s1");
  before.prompts.stop();
  assert.equal(before.queued.length, 0);

  // The restarted daemon: same database, its sessions not restored yet at start.
  const after = setup();
  after.prompts.stop();
  after.prompts.start();
  assert.equal(db.getTaskSkillPrompt(taskId, "s1")?.state, "held", "kept while the session is not restored");
  after.registry.tasks = before.registry.tasks;
  after.registry.sessions = before.registry.sessions;
  after.registry.emit("event", { type: "session_upsert", session: after.registry.getSession("s1") });
  assert.equal(after.queued.length, 1, "the recorded answer releases it once the session is back");
  assert.equal(after.queued[0]!.turn.text.split("\n")[0], "/retro");
  assert.equal(db.getTaskSkillPrompt(taskId, "s1")?.state, "queued");
  after.prompts.stop();

  // Whatever the answer says - the same skip marker as an earlier episode included - a recorded
  // answer releases it, and a session already there at start is released at once.
  const again = setup();
  const second = nextTask();
  again.registry.launch(second, "s4");
  assert.deepEqual(again.prompts.prompt("s4", { hold: true }), { kind: "held" });
  // No answer recorded yet: a restart keeps it held, as an unanswered card does.
  again.prompts.stop();
  again.prompts.start();
  assert.equal(again.queued.length, 0);
  assert.equal(db.getTaskSkillPrompt(second, "s4")?.state, "held");
  again.prompts.recordAnswered("s4");
  again.prompts.stop();
  again.prompts.start();
  assert.equal(again.queued.length, 1);
  assert.equal(db.getTaskSkillPrompt(second, "s4")?.state, "queued");
  again.prompts.stop();
});

test("a recorded wrap-up answer and the held prompts it marks commit together, or neither", async () => {
  const { Registry } = await import("../src/server/registry.ts");
  const { QueueManager } = await import("../src/server/queue.ts");
  const registry = new Registry();
  const queues = new QueueManager(registry);
  const taskId = nextTask();
  db.insertTaskSkillPrompt({ taskId, sessionId: "q1", state: "held", reason: null, skills: ["retro"], now: 1 });
  db.openDb().prepare(`INSERT INTO foreman_queues (note_key, cwd, branch, wrapup_asked_at, wrapup_answer, prompted_goal, updated_at)
    VALUES ('note-q1', '/repo', 'main', 5, NULL, NULL, 1)`).run();
  const answer = () => (db.openDb().prepare(`SELECT wrapup_answer FROM foreman_queues WHERE note_key = 'note-q1'`).get() as { wrapup_answer: string | null }).wrapup_answer;
  const marked = () => db.listAnsweredHeldTaskSkillPromptSessions().includes("q1");
  // A recorder that fails rolls the answer back with it: neither is recorded.
  const failing = queues.onWrapupAnswerRecorded(() => { db.markHeldTaskSkillPromptsAnswered("q1"); throw new Error("marker failed"); });
  assert.throws(() => queues.setWrapupAnswer("note-q1", "/ship"), /marker failed/);
  assert.equal(answer(), null);
  assert.equal(marked(), false);
  failing();
  // One that succeeds commits both.
  queues.onWrapupAnswerRecorded(() => { db.markHeldTaskSkillPromptsAnswered("q1"); });
  queues.setWrapupAnswer("note-q1", "/ship");
  assert.equal(answer(), "/ship");
  assert.equal(marked(), true);
});

test("a held prompt is released after a restart when Foreman's wrap-up is answered through the queue with the same text as before", async () => {
  const { Registry } = await import("../src/server/registry.ts");
  const { QueueManager } = await import("../src/server/queue.ts");
  // The session's queue still carries an earlier episode's answer, with its ask time.
  const key = "note-repeat";
  const skip = "foreman:automatic-wrapup-skipped";
  db.openDb().prepare(`INSERT INTO foreman_queues (note_key, cwd, branch, wrapup_asked_at, wrapup_answer, prompted_goal, updated_at)
    VALUES (?, '/repo', 'main', 5, ?, NULL, 1)`).run(key, skip);
  const queueRow = () => db.openDb().prepare(`SELECT wrapup_asked_at, wrapup_answer FROM foreman_queues WHERE note_key = ?`)
    .get(key) as { wrapup_asked_at: number | null; wrapup_answer: string | null };

  // The daemon before the stop: the prompter wired to the real queue, exactly as `index.ts` wires it.
  const before = setup();
  const queues = new QueueManager(new Registry());
  const taskId = nextTask();
  before.registry.launch(taskId, "s-repeat");
  assert.deepEqual(before.prompts.prompt("s-repeat", { hold: true }), { kind: "held" });
  // The daemon stops after the answer commits and before any listener runs: the first listener
  // to run after the commit is where the process ends.
  queues.onWrapupAnswered(() => { throw new Error("the daemon stopped"); });
  const unwire = wireAfterWorkSkills(before.prompts, queues, (k) => (k === key ? "s-repeat" : null));
  // Foreman skips the wrap-up again: the same answer text, and no new ask.
  assert.throws(() => queues.setWrapupAnswer(key, skip), /the daemon stopped/);
  unwire();
  before.prompts.stop();
  assert.deepEqual({ ...queueRow() }, { wrapup_asked_at: 5, wrapup_answer: skip }, "the queue reads exactly as it did before the answer");
  assert.equal(before.queued.length, 0, "the release never ran");
  assert.equal(db.getTaskSkillPrompt(taskId, "s-repeat")?.state, "held");

  // The restarted daemon releases it, though nothing on the queue changed.
  const after = setup();
  after.prompts.stop();
  after.registry.tasks = before.registry.tasks;
  after.registry.sessions = before.registry.sessions;
  after.prompts.start();
  assert.equal(after.queued.length, 1, "the held prompt is released at start");
  assert.equal(after.queued[0]!.turn.text.split("\n")[0], "/retro");
  assert.equal(db.getTaskSkillPrompt(taskId, "s-repeat")?.state, "queued");
  after.prompts.stop();
});

test("an answered held prompt found while task shaping is off is released when the flag is turned on again", () => {
  const flag = { on: true, listeners: new Set<() => void>() };
  const toggle = (on: boolean) => { flag.on = on; for (const listener of [...flag.listeners]) listener(); };
  const before = setup({ flag });
  const taskId = nextTask();
  before.registry.launch(taskId, "s-flag");
  assert.deepEqual(before.prompts.prompt("s-flag", { hold: true }), { kind: "held" });
  // Foreman's answer is recorded, and the daemon stops before the release.
  before.prompts.recordAnswered("s-flag");
  before.prompts.stop();

  // The daemon starts again with task shaping off: nothing is released, and nothing is given up.
  flag.on = false;
  const after = setup({ flag });
  after.prompts.stop();
  after.registry.tasks = before.registry.tasks;
  after.registry.sessions = before.registry.sessions;
  after.prompts.start();
  after.registry.emit("event", { type: "session_upsert", session: after.registry.getSession("s-flag") });
  assert.equal(after.queued.length, 0, "nothing is sent while the flag is off");
  assert.equal(db.getTaskSkillPrompt(taskId, "s-flag")?.state, "held");

  // Turned on again in the same daemon: the answered prompt is released, with no restart.
  toggle(true);
  assert.equal(after.queued.length, 1, "released once the flag is on");
  assert.equal(db.getTaskSkillPrompt(taskId, "s-flag")?.state, "queued");

  // A wrap-up answered live while the flag is off is released the same way when it is on again.
  const live = nextTask();
  after.registry.launch(live, "s-live");
  assert.deepEqual(after.prompts.prompt("s-live", { hold: true }), { kind: "held" });
  toggle(false);
  after.prompts.recordAnswered("s-live");
  after.prompts.release("s-live");
  assert.equal(db.getTaskSkillPrompt(live, "s-live")?.state, "held");
  toggle(true);
  assert.equal(db.getTaskSkillPrompt(live, "s-live")?.state, "queued");
  after.prompts.stop();
});

test("a waiting prompt follows an ordinary resume to its successor session and is sent there", () => {
  let refusal: { error: string; retryable: boolean } | null = { error: "this session cannot receive messages", retryable: true };
  const { registry, queued, prompts } = setup({ outboxRefusal: () => refusal });
  const taskId = nextTask();
  registry.launch(taskId, "s-old");
  db.commitTaskShaping(taskId, record("s-old"), "", 1);
  assert.equal(prompts.prompt("s-old").kind, "waiting");
  // The conversation resumes in a successor session: the durable row moves with the record.
  assert.equal(db.rekeyTaskLaunch(taskId, "s-old", "s-new"), true);
  registry.launch(taskId, "s-new");
  registry.sessions.delete("s-old");
  // A session update reads nothing from the database: the pending sets are memory only.
  refusal = null;
  registry.emit("event", { type: "session_upsert", session: registry.getSession("s-new") });
  assert.equal(queued.length, 0, "a session update alone does not re-read the pending rows");
  // No restart and no flag change: the task published with its record's new session is what the
  // prompter follows, and the successor is sent the prompt once it can take it.
  registry.emit("event", { type: "task_upsert", task: registry.getTask(taskId)! });
  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.sessionId, "s-new");
  assert.equal(db.getTaskSkillPrompt(taskId, "s-new")?.state, "queued");
  prompts.stop();
});

test("a held prompt whose release fails is tried again on a timer while the daemon keeps running", () => {
  const scheduled: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const { registry, queued, prompts } = setup({ scheduled });
  const taskId = nextTask();
  registry.launch(taskId, "s-held-retry");
  assert.deepEqual(prompts.prompt("s-held-retry", { hold: true }), { kind: "held" });
  prompts.recordAnswered("s-held-retry");
  // The release meets a transient failure: nothing is queued, and the prompt stays held.
  const getSession = registry.getSession.bind(registry);
  let failures = 2;
  registry.getSession = (id: string) => {
    if (failures > 0) { failures -= 1; throw new Error("transient read failure"); }
    return getSession(id);
  };
  prompts.release("s-held-retry");
  assert.equal(queued.length, 0);
  assert.equal(db.getTaskSkillPrompt(taskId, "s-held-retry")?.state, "held");
  assert.equal(scheduled.length, 1, "a retry is scheduled, with no session update or restart needed");
  assert.equal(scheduled[0]!.ms, 1_000);
  // The first retry fails too, and the next one waits longer.
  scheduled[0]!.fn();
  assert.equal(queued.length, 0);
  assert.equal(scheduled.length, 2);
  assert.equal(scheduled[1]!.ms, 2_000);
  // Once the failure clears, the retry releases it, and nothing further is scheduled.
  scheduled[1]!.fn();
  assert.equal(queued.length, 1);
  assert.equal(db.getTaskSkillPrompt(taskId, "s-held-retry")?.state, "queued");
  assert.equal(scheduled.length, 2);
  // A stale timer, or one that fires after the release, sends nothing more.
  scheduled[0]!.fn();
  scheduled[1]!.fn();
  assert.equal(queued.length, 1);
  prompts.stop();
});

test("a pending held retry is cancelled when its session ends or the prompter stops", () => {
  const scheduled: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const { registry, prompts } = setup({ scheduled });
  for (const id of ["s-ends", "s-stops"]) {
    registry.launch(nextTask(), id);
    assert.deepEqual(prompts.prompt(id, { hold: true }), { kind: "held" });
    prompts.recordAnswered(id);
  }
  const getSession = registry.getSession.bind(registry);
  let failing = true;
  registry.getSession = (id: string) => {
    if (failing) throw new Error("transient read failure");
    return getSession(id);
  };
  prompts.release("s-ends");
  prompts.release("s-stops");
  failing = false;
  assert.equal(scheduled.length, 2);
  registry.emit("event", { type: "session_remove", id: "s-ends" });
  assert.equal(scheduled[0]!.cancelled, true, "the ended session's retry is cancelled");
  assert.equal(scheduled[1]!.cancelled, false);
  prompts.stop();
  assert.equal(scheduled[1]!.cancelled, true, "and stopping cancels the rest");
});

test("a first prompt that fails before it writes its row stays owed and is written by a retry", () => {
  const scheduled: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const { registry, queued, prompts } = setup({ scheduled });
  const taskId = nextTask();
  registry.launch(taskId, "s-prompt-retry");
  const getSession = registry.getSession.bind(registry);
  let failures = 1;
  registry.getSession = (id: string) => {
    if (failures > 0) { failures -= 1; throw new Error("transient read failure"); }
    return getSession(id);
  };
  // The submission's activation meets a transient failure, and is not called again.
  assert.deepEqual(prompts.prompt("s-prompt-retry"), { kind: "none", why: "retrying" });
  assert.equal(db.getTaskSkillPrompt(taskId, "s-prompt-retry"), null, "nothing was written");
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0]!.ms, 1_000);
  // The retry writes the row and queues the prompt, once.
  scheduled[0]!.fn();
  assert.equal(queued.length, 1);
  assert.equal(db.getTaskSkillPrompt(taskId, "s-prompt-retry")?.state, "queued");
  scheduled[0]!.fn();
  assert.equal(queued.length, 1, "a stale timer queues nothing more");
  prompts.stop();
});

test("a held first prompt whose wrap-up is answered before its retry is queued, not held where nothing would release it", () => {
  const scheduled: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const { registry, queued, prompts } = setup({ scheduled });
  const taskId = nextTask();
  registry.launch(taskId, "s-hold-retry");
  const getSession = registry.getSession.bind(registry);
  let failures = 1;
  registry.getSession = (id: string) => {
    if (failures > 0) { failures -= 1; throw new Error("transient read failure"); }
    return getSession(id);
  };
  assert.deepEqual(prompts.prompt("s-hold-retry", { hold: true }), { kind: "none", why: "retrying" });
  // Foreman's wrap-up is answered while the prompt is still owed: there is no held row to mark.
  prompts.recordAnswered("s-hold-retry");
  prompts.release("s-hold-retry");
  assert.equal(queued.length, 0);
  scheduled[0]!.fn();
  assert.equal(queued.length, 1, "the wrap-up has reached the session, so the retry queues it");
  assert.equal(db.getTaskSkillPrompt(taskId, "s-hold-retry")?.state, "queued");
  prompts.stop();
});

test("an owed first prompt is forgotten when its session ends or the prompter stops", () => {
  const scheduled: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const { registry, queued, prompts } = setup({ scheduled });
  for (const id of ["s-owed-ends", "s-owed-stops"]) registry.launch(nextTask(), id);
  const getSession = registry.getSession.bind(registry);
  let failing = true;
  registry.getSession = (id: string) => {
    if (failing) throw new Error("transient read failure");
    return getSession(id);
  };
  prompts.prompt("s-owed-ends");
  prompts.prompt("s-owed-stops");
  failing = false;
  registry.emit("event", { type: "session_remove", id: "s-owed-ends" });
  assert.equal(scheduled[0]!.cancelled, true);
  assert.equal(scheduled[1]!.cancelled, false);
  prompts.stop();
  assert.equal(scheduled[1]!.cancelled, true);
  scheduled[0]!.fn();
  scheduled[1]!.fn();
  assert.equal(queued.length, 0);
});

test("retiring a delivered after-work turn settles its row in the same transaction, and a settle that fails retires nothing", () => {
  const d = db.openDb();
  const taskId = nextTask();
  const turnId = `shaping-after-work:${taskId}:s-retire:1`;
  db.queueTaskSkillPromptTurn({ taskId, sessionId: "s-retire", noteKey: "note:s-retire", turnId, text: "/wrap-notes", skills: ["wrap-notes"], from: null, now: 1 });
  const claim = () => {
    d.prepare(`UPDATE pending_turns SET state = 'sending', claimed_at = 2 WHERE id = ?`).run(turnId);
    return (d.prepare(`SELECT revision FROM pending_turns WHERE id = ?`).get(turnId) as { revision: number }).revision;
  };
  // The prompt row cannot be written: the retire is rolled back with it, and it throws.
  d.exec(`CREATE TEMP TRIGGER refuse_prompt_settle BEFORE UPDATE ON task_skill_prompts BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`);
  const revision = claim();
  assert.throws(() => db.retireDeliveredPendingTurn(turnId, revision, 50), /disk I\/O error/);
  assert.equal((d.prepare(`SELECT state FROM pending_turns WHERE id = ?`).get(turnId) as { state: string } | undefined)?.state, "sending",
    "the claimed turn is still there, so the delivery is not recorded without its prompt row");
  assert.equal(db.getTaskSkillPrompt(taskId, "s-retire")?.state, "queued");
  d.exec(`DROP TRIGGER refuse_prompt_settle`);
  // With the write possible again, the delivery and its record commit together.
  assert.equal(db.retireDeliveredPendingTurn(turnId, revision, 60), true);
  assert.equal(d.prepare(`SELECT 1 FROM pending_turns WHERE id = ?`).get(turnId), undefined);
  const row = db.getTaskSkillPrompt(taskId, "s-retire");
  assert.equal(row?.state, "delivered");
  assert.equal(row?.deliveredAt, 60);
});

test("a first prompt a restart lost is written at start for a running submission, once, and never for a later launch", () => {
  // The submission was activated, its prompt failed before writing a row, and the daemon stopped.
  const first = setup();
  const lost = nextTask();
  first.registry.launch(lost, "s-lost");
  const later = nextTask();
  first.registry.launch(later, "s-later");
  const done = nextTask();
  first.registry.launch(done, "s-done");
  assert.equal(first.prompts.prompt("s-done").kind, "queued", "one already prompted before the restart");
  first.prompts.stop();

  const recordAt = (taskId: string) => first.registry.getTask(taskId)!.shaping!.at;
  const owed = [
    { sessionId: "s-lost", submittedAt: recordAt(lost) + 10 },
    // The task was launched again into this session after the submission it is running.
    { sessionId: "s-later", submittedAt: recordAt(later) - 1 },
    { sessionId: "s-done", submittedAt: recordAt(done) + 10 },
    // A session still being restored at start is prompted when it is registered.
    { sessionId: "s-restored", submittedAt: Number.MAX_SAFE_INTEGER },
  ];
  const after = setup({ owed: () => owed });
  after.prompts.stop();
  after.registry.tasks = first.registry.tasks;
  after.registry.sessions = new Map(first.registry.sessions);
  const restoredTask = nextTask();
  const restored = new Map(after.registry.sessions);
  after.registry.launch(restoredTask, "s-restored");
  const restoredSession = after.registry.sessions.get("s-restored")!;
  after.registry.sessions = restored;
  after.prompts.start();

  assert.equal(db.getTaskSkillPrompt(lost, "s-lost")?.state, "queued", "the lost prompt is written at start");
  assert.equal(db.getTaskSkillPrompt(later, "s-later"), null, "a later launch is not prompted for earlier work");
  assert.deepEqual(after.queued.map((q) => q.sessionId), ["s-lost"], "and the one already prompted is not sent again");
  after.registry.sessions.set("s-restored", restoredSession);
  after.registry.emit("event", { type: "session_upsert", session: restoredSession });
  assert.equal(db.getTaskSkillPrompt(restoredTask, "s-restored")?.state, "queued");
  after.registry.emit("event", { type: "session_upsert", session: restoredSession });
  assert.equal(after.queued.length, 2, "prompted once when it arrives, not on every update");
  after.prompts.stop();
});

test("a retried first prompt never prompts a launch written after it was owed, whether called or recovered at start", () => {
  for (const recovered of [false, true]) {
    const scheduled: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
    const sessionId = recovered ? "s-bound-recovered" : "s-bound-called";
    const taskId = nextTask();
    // The record's launch time sits well before both bounds, as a real launch does.
    const owed = () => [{ sessionId, submittedAt: 500 }];
    const { registry, queued, prompts } = setup({ scheduled, ...(recovered ? { owed } : {}) });
    if (recovered) prompts.stop();
    registry.launch(taskId, sessionId);
    // Fail exactly the prompt's own session read: recovery reads it twice first (its own check and promptOwed's).
    const getSession = registry.getSession.bind(registry);
    const failOn = recovered ? 3 : 1;
    let reads = 0;
    registry.getSession = (id: string) => {
      reads += 1;
      if (reads === failOn) throw new Error("transient read failure");
      return getSession(id);
    };
    if (recovered) prompts.start();
    else assert.deepEqual(prompts.prompt(sessionId), { kind: "none", why: "retrying" });
    assert.equal(queued.length, 0);
    assert.equal(scheduled.length, 1, "the failed prompt is owed and retried");
    // The task is launched again into the same session before the retry runs.
    registry.launch(taskId, sessionId, { ...record(sessionId), at: Number.MAX_SAFE_INTEGER - 1 });
    scheduled[0]!.fn();
    assert.equal(queued.length, 0, `the later launch is not prompted for the earlier one's work (${recovered ? "recovered" : "called"})`);
    assert.equal(db.getTaskSkillPrompt(taskId, sessionId), null);
    assert.equal(scheduled.length, 1, "and nothing is owed any more");
    prompts.stop();
  }
});

test("a fresh prompt for a newer launch is decided by its own bound, never by an older launch's owed entry", () => {
  for (const fresh of [{ label: "an activation", options: {} }, { label: "a recovery", options: { notAfter: Number.MAX_SAFE_INTEGER } }]) {
    const scheduled: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
    const { registry, queued, prompts } = setup({ scheduled });
    const sessionId = `s-fresh-${fresh.label.split(" ")[1]}`;
    const taskId = nextTask();
    registry.launch(taskId, sessionId);
    // The older launch's prompt fails and stays owed, bounded by its own call.
    const getSession = registry.getSession.bind(registry);
    let failures = 1;
    registry.getSession = (id: string) => {
      if (failures > 0) { failures -= 1; throw new Error("transient read failure"); }
      return getSession(id);
    };
    assert.deepEqual(prompts.prompt(sessionId), { kind: "none", why: "retrying" });
    // The task is launched again into the session, and the newer launch's own call arrives.
    registry.launch(taskId, sessionId, { ...record(sessionId), at: Number.MAX_SAFE_INTEGER - 1 });
    assert.equal(prompts.prompt(sessionId, fresh.options).kind, "queued", `${fresh.label} prompts the newer launch`);
    assert.equal(queued.length, 1);
    assert.equal(db.getTaskSkillPrompt(taskId, sessionId)?.state, "queued");
    // The older launch's retry is settled with it: nothing further is sent.
    scheduled[0]!.fn();
    assert.equal(queued.length, 1);
    prompts.stop();
  }
});
