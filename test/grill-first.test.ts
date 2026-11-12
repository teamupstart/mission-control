import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";
import type { AgentType, ReviewItem } from "../src/shared/types.ts";
import type { QueueManager } from "../src/server/queue.ts";
import type { ReviewManager } from "../src/server/reviews.ts";

// Throwaway state dir, set before anything reads config - see tasks-db.test.ts.
const home = mkdtempSync(join(tmpdir(), "mission-grill-first-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager, resolveGrillFirstPin } = await import("../src/server/tasks.ts");
const { applySkillsConfig } = await import("../src/server/skills/config.ts");
const { getTask } = await import("../src/server/db.ts");
const { GRILL_FIRST_TASK_KINDS, taskGrillsFirst } = await import("../src/shared/task.ts");
const { GRILL_SKILL } = await import("../src/shared/skills.ts");
const { SkillsConfigPatchSchema } = await import("../src/shared/protocol.ts");
const { PLAN_APPENDIX_MARKER, planContractAppendix } = await import("../src/server/plans/prompt.ts");
const { PLAN_DECISIONS_TOOL } = await import("../src/server/plans/tools.ts");
const { kindMissionMcpRequirement } = await import("../src/server/mission-mcp.ts");
const { withTaskKindContract } = await import("../src/server/task-contract.ts");
const { GRILL_FIRST_HEADING, grillAction, grillFirstAppendix, grillFirstDispatchBlock } =
  await import("../src/server/grill-first.ts");
const {
  BUILTIN_SESSION_ACTIONS, GRILL_SESSION_ACTION_ID, RETRO_SESSION_ACTION_ID,
} = await import("../src/server/workflows/builtin-session-actions.ts");
const { SessionActionManager } = await import("../src/server/workflows/session-actions.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { ReviewManager: LiveReviewManager } = await import("../src/server/reviews.ts");
const { decisionLead, formatResponse } = await import("../src/shared/review-item.ts");
const { ensureToken } = await import("../src/server/auth.ts");

after(() => rmSync(home, { recursive: true, force: true }));

/**
 * Grill me first, for every kind that offers it: a task pinned on opens with the Library's
 * Grill session action - its operator-edited instruction when there is one - and then gets its
 * own kind's contract, unchanged. Off, a task is delivered exactly as it always was.
 */

const SHIPPED = grillAction();
const DELIVERY = { instruction: SHIPPED.promptMarkdown, invocation: "/grill" };
const PLAN_SKILLS = { htmlPlans: "/html-plans", phasedPlan: "/phased-plan" };

/** Every skill on, rendered the way Claude spells an invocation. */
const allOn = (_agent: AgentType, id: string) => ({ ok: true as const, command: `/${id}` });

test("Grill is a built-in session action, editable in place, requiring the grill skill", () => {
  const grill = BUILTIN_SESSION_ACTIONS.find((action) => action.id === GRILL_SESSION_ACTION_ID);
  assert.ok(grill);
  assert.equal(grill.name, "Grill");
  assert.equal(grill.requiredSkillId, GRILL_SKILL);
  assert.deepEqual(grill.completion, { kind: "session_turn" });
  assert.equal(grill.editable, true);
  assert.match(grill.promptMarkdown, /`request_plan_decisions` form/);
  assert.match(grill.promptMarkdown, /may open with nothing selected/);
  assert.match(grill.promptMarkdown, /A dismissed\nround ends the work/);
  assert.equal(BUILTIN_SESSION_ACTIONS.find((action) => action.id === RETRO_SESSION_ACTION_ID)?.editable, undefined);
});

test("every kind this app launches offers it, and only a task pinned on grills", () => {
  assert.deepEqual([...GRILL_FIRST_TASK_KINDS].sort(), ["bugfix", "chat", "document", "plan", "scout", "ship"]);
  for (const kind of GRILL_FIRST_TASK_KINDS) {
    assert.equal(taskGrillsFirst(mkTask({ kind, grillFirst: true })), true, kind);
    assert.equal(taskGrillsFirst(mkTask({ kind, grillFirst: false })), false, kind);
    assert.equal(taskGrillsFirst(mkTask({ kind })), false, `${kind}: a row from before the pin is off`);
  }
  assert.equal(taskGrillsFirst(mkTask({ kind: "pipeline", grillFirst: true })), false, "Conductor launches pipeline");
  assert.equal(taskGrillsFirst(mkTask({ kind: "resident", grillFirst: true })), false);
});

test("off, every kind is delivered exactly as before", () => {
  for (const kind of GRILL_FIRST_TASK_KINDS) {
    const task = mkTask({ kind, grillFirst: false });
    const inputs = kind === "plan" ? { planSkills: PLAN_SKILLS } : {};
    const off = withTaskKindContract(task, task.intent, inputs);
    assert.equal(withTaskKindContract(task, task.intent, { ...inputs, grillFirst: DELIVERY }), off, kind);
    assert.doesNotMatch(off, /Grill me first/, kind);
  }
});

test("on, the Grill action comes first and the kind's own contract follows unchanged", () => {
  const ship = mkTask({ kind: "ship", grillFirst: true });
  const delivered = withTaskKindContract(ship, ship.intent, { grillFirst: DELIVERY });
  const block = grillFirstAppendix(DELIVERY);
  assert.ok(delivered.includes(block), "the block carries the action's exact instruction");
  assert.ok(block.startsWith(`${GRILL_FIRST_HEADING}\n`));
  assert.ok(block.includes("\n/grill\n"), "this harness's skill line");
  assert.ok(block.endsWith(SHIPPED.promptMarkdown), "the instruction is not trimmed or rewritten");
  assert.ok(delivered.indexOf(block) < delivered.indexOf("## Ship task completion handoff"));
  assert.ok(delivered.includes(withTaskKindContract(mkTask({ kind: "ship" }), "").split("\n\n").at(-1)!));

  // A plan: the plan contract, phased follow-up included, is the one it always was.
  const plan = mkTask({ kind: "plan", grillFirst: true });
  const planned = withTaskKindContract(plan, plan.intent, { planSkills: PLAN_SKILLS, grillFirst: DELIVERY });
  const contract = planContractAppendix(PLAN_SKILLS, false, undefined);
  assert.ok(planned.includes(contract), "the plan contract is untouched");
  assert.ok(planned.indexOf(block) < planned.indexOf(PLAN_APPENDIX_MARKER));
  assert.match(planned, /phased implementation follow-up once per root plan/);
});

test("a grill-first delivery without its resolved action is refused, not delivered with a hole", () => {
  const task = mkTask({ kind: "bugfix", grillFirst: true });
  assert.throws(() => withTaskKindContract(task, task.intent, {}), /without its resolved Grill action/);
});

test("the dispatch gate refuses a grill-first task whose grill skill is off", () => {
  const grillOff = (agent: AgentType, id: string) =>
    id === GRILL_SKILL ? { ok: false as const, message: "Enable Skills and the grill skill." } : allOn(agent, id);
  const refused = grillFirstDispatchBlock(mkTask({ kind: "scout", grillFirst: true }), grillOff);
  assert.match(refused ?? "", /^Enable Skills and the grill skill\. A Grill me first task opens with the Grill session action/);
  assert.equal(grillFirstDispatchBlock(mkTask({ kind: "scout", grillFirst: false }), grillOff), null, "off needs no grill");
  assert.equal(grillFirstDispatchBlock(mkTask({ kind: "pipeline", grillFirst: true }), grillOff), null);
  assert.equal(grillFirstDispatchBlock(mkTask({ kind: "ship", grillFirst: true }), allOn), null);
});

test("a grill-first launch pre-approves request_plan_decisions, whatever its kind", () => {
  const ship = mkTask({ kind: "ship", grillFirst: true });
  assert.deepEqual(kindMissionMcpRequirement(ship, null)?.tools, [PLAN_DECISIONS_TOOL]);
  assert.equal(kindMissionMcpRequirement(mkTask({ kind: "ship", grillFirst: false }), null), null, "off, unchanged");
});

test("the per-kind defaults a request may set are bounded by the kinds that offer it", () => {
  const all = [...GRILL_FIRST_TASK_KINDS];
  assert.equal(SkillsConfigPatchSchema.safeParse({ grillFirstKinds: all }).success, true, "every kind at once fits");
  assert.equal(
    SkillsConfigPatchSchema.safeParse({ grillFirstKinds: [...all, all[0]] }).success,
    false,
    "one more entry than there are kinds is refused before its elements are parsed",
  );
});

test("one rule pins the task, from each kind's own default", () => {
  applySkillsConfig({ grillFirstKinds: ["plan", "bugfix"] });
  const task = (kind: string, grillFirst?: boolean) => mkTask({ kind: kind as never, grillFirst });
  assert.equal(resolveGrillFirstPin("plan", undefined), true, "a new task takes its kind's default");
  assert.equal(resolveGrillFirstPin("ship", undefined), false);
  assert.equal(resolveGrillFirstPin("ship", true), true, "a named choice wins");
  assert.equal(resolveGrillFirstPin("plan", false), false);
  assert.equal(resolveGrillFirstPin("pipeline", true), false, "a kind without it pins nothing");
  assert.equal(resolveGrillFirstPin("bugfix", undefined, task("pipeline")), true, "arriving from pipeline takes the default");
  assert.equal(resolveGrillFirstPin("bugfix", undefined, task("ship", false)), false, "between kinds that offer it, the pin stays");
  assert.equal(resolveGrillFirstPin("ship", undefined, task("plan", true)), true);
  assert.equal(resolveGrillFirstPin("pipeline", undefined, task("plan", true)), false, "leaving for pipeline clears it");
  applySkillsConfig({ grillFirstKinds: [] });
  assert.equal(resolveGrillFirstPin("plan", undefined, task("plan", true)), true, "a later default moves no task");
});

test("creation pins each kind's default, a dispatch overrides it, and an edit writes only a moved pin", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const create = (kind: "plan" | "ship" | "pipeline", title: string, grillFirst?: boolean) =>
    tasks.create({ repoRoot: "/repos/demo", intent: "do it", title, kind, grillFirst, backlog: true });

  applySkillsConfig({ grillFirstKinds: ["ship"] });
  const shipDefault = create("ship", "Ship default");
  assert.equal(shipDefault.grillFirst, true);
  assert.equal(create("plan", "Plan default").grillFirst, false, "every other kind starts off");
  assert.equal(create("plan", "Plan named", true).grillFirst, true);
  assert.equal(create("ship", "Ship named off", false).grillFirst, false);
  assert.equal(create("pipeline", "Pipeline", true).grillFirst, false, "pipeline pins nothing");

  applySkillsConfig({ grillFirstKinds: [] });
  assert.equal(getTask(shipDefault.id)?.grillFirst, true, "the row reads back as filed after the default moves");

  const turnedOff = await tasks.update(shipDefault.id, { grillFirst: false });
  assert.equal(turnedOff.ok, true, turnedOff.error);
  assert.equal(getTask(shipDefault.id)?.grillFirst, false);
  const retitled = await tasks.update(shipDefault.id, { title: "Renamed" });
  assert.equal(retitled.ok, true, retitled.error);
  assert.equal(getTask(shipDefault.id)?.grillFirst, false, "an unrelated edit keeps the pin");
  const toScout = await tasks.update(shipDefault.id, { kind: "scout" });
  assert.equal(toScout.ok, true, toScout.error);
  assert.equal(getTask(shipDefault.id)?.grillFirst, false);
});

test("the Grill action is edited in place and reset, and delivery reads what is saved", () => {
  const registry = new Registry();
  const actions = new SessionActionManager(registry);
  const shipped = actions.get(GRILL_SESSION_ACTION_ID)!;
  assert.equal(shipped.customized, undefined);
  const edited = `${shipped.promptMarkdown}\nAsk about rollout risk in the first round.\n`;

  const saved = actions.update(GRILL_SESSION_ACTION_ID, { expectedRevision: shipped.revision, promptMarkdown: edited });
  assert.equal(saved.ok, true);
  const current = actions.get(GRILL_SESSION_ACTION_ID)!;
  assert.equal(current.promptMarkdown, edited);
  assert.equal(current.customized, true);
  assert.equal(current.revision, shipped.revision + 1);
  assert.equal(current.name, "Grill", "the name is the shipped contract");
  assert.equal(registry.getSessionAction(GRILL_SESSION_ACTION_ID)?.promptMarkdown, edited, "the live catalog carries it");
  assert.ok(
    grillFirstAppendix({ instruction: grillAction((id) => registry.getSessionAction(id)).promptMarkdown, invocation: "/grill" })
      .endsWith(edited),
    "a grill-first task is sent the edited instruction",
  );

  // Only the instruction is the operator's; a stale revision is a conflict, not an overwrite.
  const renamed = actions.update(GRILL_SESSION_ACTION_ID, { expectedRevision: current.revision, name: "Interview" });
  assert.equal(renamed.ok, false);
  assert.equal(!renamed.ok && renamed.reason, "builtin");
  const reskilled = actions.update(GRILL_SESSION_ACTION_ID, { expectedRevision: current.revision, requiredSkillId: null });
  assert.equal(!reskilled.ok && reskilled.reason, "builtin");
  const stale = actions.update(GRILL_SESSION_ACTION_ID, { expectedRevision: shipped.revision, promptMarkdown: "# Grill\n\nx\n" });
  assert.equal(!stale.ok && stale.reason, "revision_conflict");

  const reset = actions.reset(GRILL_SESSION_ACTION_ID, current.revision);
  assert.equal(reset.ok, true);
  const restored = actions.get(GRILL_SESSION_ACTION_ID)!;
  assert.equal(restored.promptMarkdown, shipped.promptMarkdown);
  assert.equal(restored.customized, undefined);
  assert.equal(restored.revision, current.revision + 1, "the revision only moves forward");

  // Every other built-in stays read-only.
  const retro = actions.get(RETRO_SESSION_ACTION_ID)!;
  const retroEdit = actions.update(RETRO_SESSION_ACTION_ID, { expectedRevision: retro.revision, promptMarkdown: "# Retro\n\nx\n" });
  assert.equal(!retroEdit.ok && retroEdit.reason, "builtin");
  assert.equal(!actions.reset(RETRO_SESSION_ACTION_ID, retro.revision).ok, true);
});

test("an immediate grill-first dispatch is refused at the route when the grill skill is off", async () => {
  const repo = join(home, "dispatch-repo");
  mkdirSync(repo);
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "initial"]);
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const launched: string[] = [];
  (tasks as unknown as { dispatcher: { dispatch(id: string): Promise<void> } }).dispatcher.dispatch =
    async (id: string) => void launched.push(id);
  const app = buildApp({
    registry,
    reviews: {} as unknown as ReviewManager,
    tasks,
    queues: {} as unknown as QueueManager,
  });
  // After work None keeps the Workflow gate out of it, so a refusal is the skill gate's.
  const dispatch = async (title: string, grillFirst?: boolean): Promise<Response> =>
    app.request("/api/tasks", {
      method: "POST",
      headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
      body: JSON.stringify({ repoRoot: repo, intent: "Add archive exports", title, kind: "ship", agent: "claude", workflowId: null, grillFirst }),
    });

  const synced = applySkillsConfig({
    enabled: true,
    grillFirstKinds: ["ship"],
    skills: { grill: false },
  });
  assert.deepEqual(synced.problems, []);
  const filedBefore = registry.listTasks().length;

  // Grill me first from the ship kind's default, named nowhere in the request.
  const refused = await dispatch("From the default");
  assert.equal(refused.status, 409);
  const error = ((await refused.json()) as { error: string }).error;
  assert.match(error, /Enable Skills and the grill skill/);
  assert.match(error, /A Grill me first task opens with the Grill session action/);
  assert.match(error, /Settings → Skills/);
  // Named on the request, with the default off.
  applySkillsConfig({ grillFirstKinds: [] });
  assert.equal((await dispatch("Named on the form", true)).status, 409);
  assert.equal(registry.listTasks().length, filedBefore, "a refusal files nothing");
  assert.deepEqual(launched, []);

  // The same dispatch with Grill me first off passes the gate: the grill skill is not needed.
  applySkillsConfig({ grillFirstKinds: ["ship"] });
  const accepted = await dispatch("Overridden off", false);
  assert.equal(accepted.status, 200, await accepted.clone().text());
  const task = (await accepted.json()) as { id: string; grillFirst: boolean; status: string };
  assert.equal(task.grillFirst, false);
  assert.equal(task.status, "dispatching");
  assert.deepEqual(launched, [task.id]);
});

/**
 * A grilling round across the process boundary, the way the agent's MCP bridge sends it: a
 * session running a ship task pinned Grill me first posts an UNBOUND plan-decisions round to
 * `/mcp/reviews` (the Grill action binds none to a managed plan), the daemon accepts
 * it with nothing selected, and the agent's blocked wait returns what the human chose - here
 * against every recommendation, so nothing can pass by echoing the recommended options.
 */
test("a grill-first session's unbound round is accepted and returns the human's own answers", async () => {
  const token = ensureToken();
  const registry = new Registry();
  const reviews = new LiveReviewManager(registry);
  const app = buildApp({ registry, reviews, tasks: new TaskManager(registry), queues: {} as unknown as QueueManager });
  const sessionId = "sdk:grill-first-ship";
  registry.registerSdkSession({ id: sessionId, agent: "claude", name: "plan exports", cwd: "/repo/grill" });
  registry.upsertTask(mkTask({ id: "grill-ship", kind: "ship", grillFirst: true, status: "running", sessionId, repoRoot: "/repo/grill" }));
  assert.equal(taskGrillsFirst(registry.taskForSession(sessionId, "/repo/grill")), true, "the session runs a grill-first ship task");

  const decisions = [
    {
      id: "export-format",
      question: "Which format should exports use?",
      options: [
        { id: "csv", label: "CSV", recommended: true },
        { id: "json", label: "JSON" },
      ],
      allowOther: true,
    },
    {
      id: "export-scope",
      question: "What does an export include?",
      options: [
        { id: "visible", label: "What the view shows", recommended: true },
        { id: "all", label: "Every record" },
      ],
      allowOther: true,
    },
  ];
  const authed = { host: "127.0.0.1:7317", "content-type": "application/json", "x-harness-token": token };
  const created = await app.request("/mcp/reviews", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({
      env: {},
      sessionId,
      cwd: "/repo/grill",
      kind: "plan-decisions",
      title: "Round 1: export format",
      body: "Nothing is settled yet. This round decides the format and the scope.",
      decisions,
    }),
  });
  assert.equal(created.status, 200, await created.clone().text());
  const { id } = (await created.json()) as { id: string };

  // Pending with the round intact and nothing answered for the human: no selections, no response.
  const pending = ((await (await app.request("/api/reviews", { headers: { host: "127.0.0.1:7317" } })).json()) as ReviewItem[])
    .find((review) => review.id === id);
  assert.ok(pending, "the round reaches the dashboard");
  assert.equal(pending.kind, "plan-decisions");
  assert.equal(pending.sessionId, sessionId);
  assert.equal(pending.status, "pending");
  assert.deepEqual(pending.decisions, decisions);
  assert.equal(pending.selections ?? null, null, "the daemon preselects nothing");
  assert.equal(pending.response ?? null, null);

  // The human answers against both recommendations: a listed option and an Other.
  const selections = [
    { decisionId: "export-format", selected: ["json"], other: null },
    { decisionId: "export-scope", selected: [], other: "Only records changed since the last export" },
  ];
  const resolved = await app.request(`/api/reviews/${id}/resolve`, {
    method: "POST",
    headers: authed,
    // What the decision form posts on Submit: the selections and the answer text built from them.
    body: JSON.stringify({ action: "answer", selections, response: formatResponse(decisions, selections, decisionLead("plan-decisions")) }),
  });
  assert.equal(resolved.status, 200, await resolved.clone().text());

  const waited = (await (await app.request(`/mcp/reviews/${id}/wait`, { headers: authed })).json()) as ReviewItem;
  assert.equal(waited.status, "answered");
  assert.deepEqual(
    waited.selections?.map(({ decisionId, selected, other }) => ({ decisionId, selected, other })),
    selections,
    "the agent reads back exactly what the human chose",
  );
  assert.match(waited.response ?? "", /JSON/);
  assert.match(waited.response ?? "", /Only records changed since the last export/);
  assert.doesNotMatch(waited.response ?? "", /CSV|What the view shows/, "no recommendation stands in for an answer");
});
