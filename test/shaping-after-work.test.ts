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
const { AfterWorkSkills, afterWorkTurnId, renderAfterWorkPrompt } = await import("../src/server/shaping/after-work.ts");
const { deliverySchedule, deliveryStage, AFTER_WORK_SKILLS_TURN_PREFIX } = await import("../src/shared/message-delivery.ts");
const { mkTask } = await import("./helpers/session-fixture.ts");

function record(sessionId: string, skills: Array<[string, string, string?]> = [["retro", "after-work"], ["lint-fix", "during"]]): TaskShaping {
  return {
    state: "ok", at: 1, durationMs: 5, entries: 0, bytes: 400, truncated: false, sessionId,
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
    const task = { ...(this.tasks.get(taskId) ?? baseTask(taskId)), sessionId, ...(shaping ? { shaping } : {}) } as Task;
    if (!shaping) delete (task as { shaping?: unknown }).shaping;
    this.tasks.set(taskId, task);
    db.upsertTask(task);
    this.sessions.set(sessionId, { id: sessionId, agent, task: { id: taskId } } as unknown as Session);
  }
}

function baseTask(id: string): Task {
  return mkTask({ id, status: "running" });
}

interface Queued { sessionId: string; turn: PendingTurn }

function setup(options: { enabled?: boolean; staged?: Set<string>; catalog?: Record<string, string> } = {}) {
  const registry = new FakeRegistry();
  const queued: Queued[] = [];
  let now = 1_000;
  const prompts = new AfterWorkSkills({
    registry,
    outbox: {
      submitDaemonTurn(sessionId, create) {
        const turn = create(`note:${sessionId}`, now);
        if (turn) queued.push({ sessionId, turn });
        return { ok: true, pasted: false, submitVerified: false, delivery: "pending", ...(turn ? { pendingTurn: turn } : {}) };
      },
    },
    workflowSkills: () => options.staged ?? new Set(),
    enabled: () => options.enabled ?? true,
    now: () => ++now,
    catalogId: (name) => options.catalog?.[name] ?? null,
    catalogCommand: (_session, id) => ({ ok: true, command: `/${id}` }),
  });
  prompts.start();
  return { registry, queued, prompts };
}

let taskCounter = 0;
const nextTask = () => `task-${++taskCounter}`;

test("schema 43 adds the prompt table to an upgraded database, keyed by task and session", () => {
  db.openDb();
  db.closeDb();
  const raw = new DatabaseSync(join(home, "harness.db"));
  raw.exec("DROP TABLE task_skill_prompts");
  raw.exec("PRAGMA user_version = 42");
  raw.close();
  const upgraded = db.openDb();
  assert.equal(db.CURRENT_DATABASE_SCHEMA_VERSION, 43);
  assert.equal((upgraded.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 43);
  const key = (upgraded.prepare("PRAGMA table_info(task_skill_prompts)").all() as Array<{ name: string; pk: number }>)
    .filter((column) => column.pk > 0).map((column) => column.name);
  assert.deepEqual(key, ["task_id", "session_id"]);
  const write = (sessionId: string) => db.insertTaskSkillPrompt({ taskId: "keyed", sessionId, state: "held", reason: null, skills: ["retro"], now: 1 });
  assert.equal(write("s1"), true);
  assert.equal(write("s1"), false, "one row per task and session");
  assert.equal(write("s2"), true, "a second launch into another session has its own row");
  // A resume carries the row to its successor, and never over a row the successor already has.
  assert.equal(db.rekeyTaskSkillPrompt("keyed", "s1", "s3"), true);
  assert.equal(db.getTaskSkillPrompt("keyed", "s1"), null);
  assert.equal(db.getTaskSkillPrompt("keyed", "s3")?.state, "held");
  assert.equal(db.rekeyTaskSkillPrompt("keyed", "s3", "s2"), false);
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
  const { registry, queued, prompts } = setup();
  const taskId = nextTask();
  registry.launch(taskId, "s1", record("s1"), "codex");
  // Codex can invoke by name, so this one resolves; its line keeps Codex's typed clause first.
  assert.equal(prompts.prompt("s1").kind, "queued");
  assert.equal(queued[0]!.turn.text.split("\n")[0], "$retro - run this skill now.");
  assert.match(queued[0]!.turn.text, /1\. `\$retro`/, "the list names it without the clause");
  assert.equal(renderAfterWorkPrompt("s1", []), null);
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
