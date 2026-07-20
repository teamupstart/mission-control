import { z } from "zod";
import { BacklogPlanSchema } from "@shared/protocol.ts";
import type { BacklogPlanInput } from "@shared/protocol.ts";
import type { BacklogPlan } from "@shared/types.ts";
import { getAppConfig, setAppConfig } from "./db.ts";

// Where Foreman's reading of the backlog is kept: one row in `app_config`, exactly
// like the Foreman config itself. Not a table and not a column on `tasks`, because a
// plan is an opinion ABOUT the backlog rather than a fact about any one task - the
// same line notes and episodes draw against `Session` - and because a new table would
// buy nothing over a value that is rewritten whole every time it changes.

const PLAN_KEY = "backlog.plan";

/** What is on disk: the posted plan plus the daemon's own timestamp. */
const StoredPlanSchema = BacklogPlanSchema.extend({
  generatedAt: z.number(),
});

/**
 * The stored plan, or null when there isn't a usable one.
 *
 * Parsed rather than cast, for the reason `getForemanConfig` parses: this drives
 * whether an agent gets LAUNCHED and in what order, so a value written by an older
 * build - or corrupted - must degrade to "no plan", which makes the machine replan.
 * Casting it would let a half-shaped object reach the scheduler, where a missing
 * `dependsOn` reads as "nothing blocks this" and starts work out of order.
 */
export function getBacklogPlan(): BacklogPlan | null {
  const raw = getAppConfig<unknown>(PLAN_KEY);
  if (raw === undefined) return null;
  const parsed = StoredPlanSchema.safeParse(raw);
  if (!parsed.success) return null;
  return {
    entries: parsed.data.entries.map((e) => ({
      taskId: e.taskId,
      dependsOn: e.dependsOn,
      reason: e.reason,
    })),
    note: parsed.data.note,
    generatedAt: parsed.data.generatedAt,
  };
}

/**
 * Replace the plan wholesale and stamp it with the DAEMON's clock.
 *
 * Whole, never merged: a plan is a statement about a set of tasks read together, and
 * patching one entry into an older graph would produce an ordering no planner ever
 * proposed. The timestamp is taken here rather than accepted from the worker so the
 * "planned N minutes ago" on the board cannot be back-dated by a skewed clock or by a
 * replayed body.
 */
export function setBacklogPlan(input: BacklogPlanInput, now = Date.now()): BacklogPlan {
  const plan: BacklogPlan = {
    entries: input.entries.map((e) => ({
      taskId: e.taskId,
      dependsOn: e.dependsOn,
      reason: e.reason ?? null,
    })),
    note: input.note ?? null,
    generatedAt: now,
  };
  setAppConfig(PLAN_KEY, plan);
  return plan;
}
