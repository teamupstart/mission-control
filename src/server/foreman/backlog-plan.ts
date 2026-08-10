import { z } from "zod";
import type { BacklogPlanInput } from "@shared/protocol.ts";
import type { Task } from "@shared/types.ts";
import { llmRunner, DEFAULT_LLM_RUNNER_ID } from "../llm/index.ts";
import type { LlmRunnerId } from "@shared/llm.ts";
import { providerJsonSchema } from "../llm/json-schema.ts";
import { parseModelJson, runStructured } from "../llm/structured.ts";
import { buildBacklogPrompt } from "./backlog-prompt.ts";
import { FOREMAN_MODEL_SPECS, resolveForemanModel } from "@shared/foreman-models.ts";

// The backlog dependency read: one fresh, tool-less model call over every backlog
// item, returning an order and a `dependsOn` list per item.
//
// Tool-less for the reason the reviewer is: the prompt embeds task text a human typed
// (and which a compromised MCP client could have written), and the model only ever
// needs to emit JSON - so nothing here should be steerable into touching the repo.

/**
 * The planner's model. Not the triage router's Haiku: this is a judgment call over
 * prose - "does this task build on that one?" - made once per backlog change, where the
 * router is a bucketing made once per prompt. The cost profile is opposite, so the
 * default is too.
 */
export const DEFAULT_BACKLOG_MODEL = FOREMAN_MODEL_SPECS.backlog.fallback;

/**
 * Fixed part of the planner's budget: starting the headless call and reading the prompt.
 * Independent of the backlog's length, which is what the per-item term is for.
 */
export const BACKLOG_BASE_MS = 60_000;

/**
 * Budget added per backlog item, because the reply grows with the backlog: the model is
 * asked for one entry per task, each carrying a written `reason`.
 *
 * Sized off measurement rather than a guess, and off the SLOWEST measurement rather than
 * the average. The 24-item backlog that produced this comment was timed end to end
 * against the real CLI at 267s and again at 305s - the same prompt, the same model,
 * nearly 40s apart, because the run competes with whatever else the operator's machine
 * is doing. So the spread is the thing being budgeted for, not the mean: ~10.2s an item
 * at the slow end once `BACKLOG_BASE_MS` is taken off, carried at roughly 2x here.
 */
export const BACKLOG_PER_TASK_MS = 20_000;

/**
 * The hard ceiling, whatever the backlog's length.
 *
 * `planBacklog` is awaited on the Foreman worker's single loop, so its budget is also
 * the longest the fleet's needs-you triage and queue drain can go unattended. The
 * scaling above has to stop somewhere for that reason, and a backlog long enough to hit
 * this is one no single call was going to read well anyway.
 *
 * What makes a ceiling BELOW the scaling safe is that a timeout is now a degradation
 * rather than an outage: three of them drop the machine to serial scheduling, which
 * `inFlightTasks` (backlog-machine.ts) will actually advance. Trading a very long
 * backlog's dependency read for a responsive fleet is the right way round only because
 * of that; before it, the same trade stopped scheduling altogether.
 */
export const BACKLOG_CEILING_MS = 600_000;

/**
 * The planner's wall-clock budget for a read of `count` items.
 *
 * A CONSTANT was wrong by construction here, and it failed totally rather than
 * partially. The cost of this call scales with the backlog - one written entry per task
 * - while a fixed cap does not, so the feature worked on the small backlogs it was
 * built against and stopped working, permanently and silently, once one grew. 90s could
 * not cover the 24-item backlog above. Every attempt timed out, so no plan was ever
 * stored, so `planStale` stayed true, so `decideBacklogTick` answered `plan` on every
 * single tick: the autopilot spent 90s a pass to schedule nothing while the operator
 * looked at two dozen ready items and an idle fleet. Backlogs GROW, which is what made
 * a fixed cap a time bomb rather than a tuning miss.
 *
 * `FOREMAN_BACKLOG_TIMEOUT_MS` still overrides the whole calculation, flat: an operator
 * who sets it is naming a hard ceiling for their own machine, and a value that quietly
 * grew with their backlog would not be one.
 */
export function backlogTimeoutMs(count: number): number {
  const override = Number(process.env.FOREMAN_BACKLOG_TIMEOUT_MS);
  if (Number.isFinite(override) && override > 0) return override;
  const scaled = BACKLOG_BASE_MS + BACKLOG_PER_TASK_MS * Math.max(0, count);
  return Math.min(scaled, BACKLOG_CEILING_MS);
}

/**
 * Which model reads the backlog: config, then env, then the default.
 *
 * The empty-string-is-a-cleared-box rule this function used to state is now enforced for
 * all four roles at once inside `resolveForemanModel`.
 */
export function backlogModel(cfg: { backlogModel?: string; runner?: LlmRunnerId }): string {
  return resolveForemanModel("backlog", cfg, process.env, cfg.runner ?? "claude").id;
}

/** What the model returns, before any of it is believed. See `sanitizePlan`. */
export const BacklogReportSchema = z.object({
  tasks: z.array(
    z.object({
      id: z.string().min(1),
      dependsOn: z.array(z.string()).default([]),
      reason: z.string().optional(),
    }),
  ),
  note: z.string().optional(),
});
const BACKLOG_REPORT_JSON_SCHEMA = providerJsonSchema(BacklogReportSchema);
export type BacklogReport = z.infer<typeof BacklogReportSchema>;

export type BacklogPlanResult =
  | { kind: "ok"; plan: BacklogPlanInput }
  | { kind: "failed"; reason: string };

/**
 * Turn a model reply into a plan that is SAFE TO SCHEDULE FROM, whatever it said.
 *
 * Four repairs, and none of them is tidiness - each one closes a way a plausible reply
 * silently breaks the feature:
 *
 *  - **Unknown ids dropped.** An entry for a task that is not in the backlog, or a
 *    dependency on an id nobody has heard of, would otherwise be an unmet dependency
 *    that can never be met, because no task will ever reach `done` under that id.
 *    (`blockersFor` treats an id it cannot find as satisfied, so this is belt and
 *    braces on the storage side rather than the only guard - but a plan on disk should
 *    not carry ids that mean nothing.)
 *  - **Self-references dropped.** A task waiting on itself never starts.
 *  - **Cycles broken.** Two tasks waiting on each other deadlock the pair FOREVER, and
 *    invisibly: a blocked card looks exactly like a card correctly waiting its turn.
 *    Broken by finding the cycles themselves and dropping ONLY the edges that close
 *    one. The narrowness is the point: the model is asked for a topological order but
 *    routinely answers in priority order, and a repair that judged edges by position
 *    in that array would delete perfectly good dependencies - the one thing this
 *    feature exists to produce - every time it did. The entries are then emitted in a
 *    topological order derived from the surviving edges, so the model's ordering
 *    signal still shows through wherever it does not contradict a dependency.
 *  - **Missing entries appended.** A backlog item with no entry leaves `planStale` true
 *    forever, so the worker replans on every single tick - an unbounded loop of Sonnet
 *    calls that produces nothing. Appended unblocked, at the end, which is the safe
 *    reading: we do not know that anything blocks it.
 *
 * Deps are also deduplicated, so a repeated id cannot inflate a card's blocked count.
 */
export function sanitizePlan(report: BacklogReport, backlog: Task[]): BacklogPlanInput {
  const known = new Set(backlog.map((t) => t.id));

  // The model's order, restricted to real backlog ids and deduplicated. It is a
  // preference, not a constraint: it breaks ties in the topological sort below.
  const order: string[] = [];
  const placed = new Set<string>();
  for (const t of report.tasks) {
    if (!known.has(t.id) || placed.has(t.id)) continue;
    placed.add(t.id);
    order.push(t.id);
  }
  for (const t of backlog) {
    if (placed.has(t.id)) continue;
    placed.add(t.id);
    order.push(t.id);
  }

  const byId = new Map(report.tasks.map((t) => [t.id, t]));

  const deps = new Map<string, string[]>();
  for (const id of order) {
    const kept: string[] = [];
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (dep === id) continue; // self-reference
      if (!known.has(dep)) continue; // unknown, or a task already out of the backlog
      if (kept.includes(dep)) continue; // duplicate
      kept.push(dep);
    }
    deps.set(id, kept);
  }

  dropCyclicEdges(order, deps);

  // Operator-declared edges are facts, not the planner's opinion. Add them to a
  // combined graph first, then discard only MODEL edges that would point back across
  // one and deadlock the backlog. The ordinary model-only cycle repair above stays
  // unchanged, preserving its narrow deterministic cut.
  const combined = new Map<string, string[]>(
    backlog.map((task) => [
      task.id,
      task.dependencies.flatMap((dependency) =>
        dependency.type === "task" &&
        dependency.satisfiedAt === null &&
        known.has(dependency.taskId)
          ? [dependency.taskId]
          : [],
      ),
    ]),
  );
  for (const id of order) {
    const kept: string[] = [];
    for (const dependency of deps.get(id) ?? []) {
      if (pathReaches(dependency, id, combined)) continue;
      kept.push(dependency);
      const edges = combined.get(id) ?? [];
      if (!edges.includes(dependency)) combined.set(id, [...edges, dependency]);
    }
    deps.set(id, kept);
  }

  const entries = topoOrder(order, combined).map((id) => ({
    taskId: id,
    dependsOn: deps.get(id) ?? [],
    reason: byId.get(id)?.reason?.trim() || null,
  }));

  return { entries, note: report.note?.trim() || null };
}

function pathReaches(from: string, target: string, deps: Map<string, string[]>): boolean {
  const seen = new Set<string>();
  const visit = (id: string): boolean => {
    if (id === target) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return (deps.get(id) ?? []).some(visit);
  };
  return visit(from);
}

/**
 * Make the graph acyclic in place, dropping as little as possible.
 *
 * A depth-first walk in the model's own order: an edge into a node that is still OPEN
 * on the current stack is the edge that closes a cycle, and it is the only kind
 * dropped. Every other edge - including one the model listed "out of order", which is
 * the common case when it answers by priority - survives untouched.
 *
 * Some edge of a cycle has to go, and which one is still decided by the model's order:
 * the walk is ROOTED from the back of that order, which makes the edge it cuts the one
 * running from an earlier item to a later one - the reply contradicting the sequence it
 * just asked for. So the repair follows its stated intent where it must choose, without
 * letting that intent overrule a dependency it also stated.
 */
function dropCyclicEdges(order: string[], deps: Map<string, string[]>): void {
  const state = new Map<string, "open" | "done">();
  const visit = (id: string): void => {
    state.set(id, "open");
    const kept: string[] = [];
    for (const dep of deps.get(id) ?? []) {
      const seen = state.get(dep);
      if (seen === "open") continue;
      if (seen === undefined) visit(dep);
      kept.push(dep);
    }
    deps.set(id, kept);
    state.set(id, "done");
  };
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]!;
    if (!state.has(id)) visit(id);
  }
}

/**
 * Order the ids so every dependency precedes the item that waits on it, breaking ties
 * by the model's own order.
 *
 * `readyBacklog` filters on blockers rather than position, so this ordering is a
 * READOUT more than a schedule - but it is the readout the board's column and the
 * "next up" mark are drawn from, and a plan that listed an item above the thing it
 * waits on would be telling the operator the opposite of what the scheduler will do.
 *
 * `deps` must already be acyclic; the fallback below only keeps this total.
 */
function topoOrder(order: string[], deps: Map<string, string[]>): string[] {
  const remaining = [...order];
  const emitted = new Set<string>();
  const out: string[] = [];
  while (remaining.length > 0) {
    const i = remaining.findIndex((id) => (deps.get(id) ?? []).every((d) => emitted.has(d)));
    const [id] = remaining.splice(i < 0 ? 0 : i, 1);
    emitted.add(id!);
    out.push(id!);
  }
  return out;
}

/**
 * Read the backlog's dependencies. Never throws - a failure is reported as a value so
 * the worker can count it toward the serial-mode fallback rather than dying on it.
 *
 * ONE model call, deliberately. Splitting a long backlog across several calls was tried
 * and taken back out: the calls run on the Foreman worker's single loop, which also
 * drives queue drain and needs-you triage, so N reads is N times the span in which
 * nothing else in the fleet is attended to. One read is one attempt's worth of that
 * span, whatever the backlog's length, and `PLANNABLE_LIMIT` (@shared/backlog.ts) is
 * what keeps the prompt a prompt.
 *
 * `backlog` is what gets planned; the model is shown nothing else, because the tasks
 * that already left the backlog are either finished (nothing to wait for) or running
 * (nothing autopilot can reorder).
 */
export async function planBacklog(
  backlog: Task[],
  model = process.env.FOREMAN_BACKLOG_MODEL || DEFAULT_BACKLOG_MODEL,
  runnerId: LlmRunnerId = DEFAULT_LLM_RUNNER_ID,
): Promise<BacklogPlanResult> {
  // A single-item backlog has nothing to relate it to, so the answer is knowable
  // without a model: it depends on nothing. Worth the branch - a human who queues one
  // task at a time would otherwise pay for a Sonnet call per task, for a graph with no
  // edges in it.
  if (backlog.length < 2) {
    return {
      kind: "ok",
      plan: {
        entries: backlog.map((t) => ({ taskId: t.id, dependsOn: [], reason: null })),
        note: null,
      },
    };
  }

  const runner = llmRunner(runnerId);
  const result = await runStructured(
    (p) =>
      runner.run(p, {
        model,
        timeoutMs: backlogTimeoutMs(backlog.length),
        role: "foreman:backlog",
        schema: BACKLOG_REPORT_JSON_SCHEMA,
      }),
    buildBacklogPrompt(backlog),
    (raw) => parseModelJson(raw, BacklogReportSchema),
    "The backlog planner",
    undefined,
    { shapeGuaranteed: runner.structuredOutput?.guaranteesInputShape === true },
  );
  if (result.kind === "failed") return result;
  return { kind: "ok", plan: sanitizePlan(result.value, backlog) };
}
