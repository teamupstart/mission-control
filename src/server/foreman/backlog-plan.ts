import { z } from "zod";
import type { BacklogPlanInput } from "@shared/protocol.ts";
import type { Task } from "@shared/types.ts";
import { parseModelJson, runStructured } from "../claude-cli.ts";
import { buildBacklogPrompt } from "./backlog-prompt.ts";

// The backlog dependency read: one fresh, tool-less `claude -p` over every backlog
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
export const DEFAULT_BACKLOG_MODEL = "claude-sonnet-5";

/** The planner's wall-clock cap. Generous: it runs rarely and blocks nothing live. */
const BACKLOG_TIMEOUT_MS = Number(process.env.FOREMAN_BACKLOG_TIMEOUT_MS || 90_000);

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
 *    Broken by walking the model's own order and keeping only the edges that point
 *    BACKWARD in it - which is the ordering it asked for, so the repair follows its
 *    intent rather than overriding it. An edge pointing forward is the model
 *    contradicting itself and is the one to drop.
 *  - **Missing entries appended.** A backlog item with no entry leaves `planStale` true
 *    forever, so the worker replans on every single tick - an unbounded loop of Sonnet
 *    calls that produces nothing. Appended unblocked, at the end, which is the safe
 *    reading: we do not know that anything blocks it.
 *
 * Deps are also deduplicated, so a repeated id cannot inflate a card's blocked count.
 */
export function sanitizePlan(report: BacklogReport, backlog: Task[]): BacklogPlanInput {
  const known = new Set(backlog.map((t) => t.id));

  // The model's order, restricted to real backlog ids and deduplicated. This array is
  // what "backward" means below, so it has to be settled before any edge is judged.
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

  const rank = new Map(order.map((id, i) => [id, i]));
  const byId = new Map(report.tasks.map((t) => [t.id, t]));

  const entries = order.map((id) => {
    const raw = byId.get(id);
    const deps: string[] = [];
    for (const dep of raw?.dependsOn ?? []) {
      if (dep === id) continue; // self-reference
      if (!known.has(dep)) continue; // unknown, or a task already out of the backlog
      if (deps.includes(dep)) continue; // duplicate
      // Keep only edges pointing backward in the model's own order. A forward edge is
      // the reply contradicting itself, and following both directions is what builds a
      // cycle - so this both breaks cycles and keeps the ordering it asked for.
      if ((rank.get(dep) ?? Infinity) >= (rank.get(id) ?? -1)) continue;
      deps.push(dep);
    }
    return { taskId: id, dependsOn: deps, reason: raw?.reason?.trim() || null };
  });

  return { entries, note: report.note?.trim() || null };
}

/**
 * Read the backlog's dependencies. Never throws - a failure is reported as a value so
 * the worker can count it toward the serial-mode fallback rather than dying on it.
 *
 * `backlog` is what gets planned; the model is shown nothing else, because the tasks
 * that already left the backlog are either finished (nothing to wait for) or running
 * (nothing autopilot can reorder).
 */
export async function planBacklog(
  backlog: Task[],
  model = process.env.FOREMAN_BACKLOG_MODEL || DEFAULT_BACKLOG_MODEL,
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

  const result = await runStructured(
    buildBacklogPrompt(backlog),
    (raw) => parseModelJson(raw, BacklogReportSchema),
    "The backlog planner",
    { model, timeoutMs: BACKLOG_TIMEOUT_MS },
  );
  if (result.kind === "failed") return result;
  return { kind: "ok", plan: sanitizePlan(result.value, backlog) };
}
