import type { Hono } from "hono";
import { ScheduleNextIterationRequestSchema } from "@shared/protocol.ts";
import { taskHasRepository } from "@shared/task.ts";
import { RESIDENT_RESTART_PAUSE_REASON, residentRestartRequestId } from "@shared/residents.ts";
import { SCOUT_SUBMISSION_CREDENTIAL_HEADER } from "@shared/harness-runtime.mjs";
import { checkToken } from "../auth.ts";
import { sessionControlCaller, sessionControlCallerRefusal } from "../session-control.ts";
import type { Registry } from "../registry.ts";
import type { ResidentManager } from "./manager.ts";
import type { ResidentLoop } from "./loop.ts";
import { ResidentLoopRefusal, liveRun } from "./loop-store.ts";
import { getResidentProfile, getResidentRun, residentRunIdentityByRequest } from "./store.ts";
import { ProposeResidentInstructionChangesSchema } from "@shared/resident-instructions.ts";
import type { ResidentInstructionChanges } from "./instruction-changes.ts";

/**
 * A resident reading and proposing changes to its own standing instructions.
 *
 * The caller names nothing but its proposal: the daemon attributes the signed session exactly
 * as `schedule_next_iteration` does, and derives the run, profile and Persona from it. No route
 * here writes a profile or a Persona. A proposal only opens a review; the operator's answer to
 * that review, through `/api/reviews/:id/resolve`, is the one path that applies it.
 */
export function registerResidentInstructionRoutes(app: Hono, deps: {
  registry: Registry; changes: ResidentInstructionChanges;
}): void {
  const caller = (header: string | undefined) => {
    const id = sessionControlCaller(deps.registry, header);
    const session = id ? deps.registry.getSession(id) : undefined;
    return session?.runtime === "sdk" ? session : undefined;
  };
  const NO_CALLER = "No matching signed resident session.";

  app.get("/mcp/residents/instructions", (c) => {
    if (!checkToken(c.req.header("x-harness-token"))) return c.json({ error: "unauthorized" }, 401);
    const session = caller(c.req.header(SCOUT_SUBMISSION_CREDENTIAL_HEADER));
    if (!session) return c.json({ error: NO_CALLER }, 409);
    const view = deps.changes.read(session);
    return "error" in view ? c.json({ error: view.error }, view.status) : c.json(view);
  });

  app.post("/mcp/residents/instructions/proposals", async (c) => {
    if (!checkToken(c.req.header("x-harness-token"))) return c.json({ error: "unauthorized" }, 401);
    const session = caller(c.req.header(SCOUT_SUBMISSION_CREDENTIAL_HEADER));
    if (!session) return c.json({ error: NO_CALLER }, 409);
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = ProposeResidentInstructionChangesSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: `Not proposed: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ")}` }, 400);
    }
    const proposed = deps.changes.propose(session, parsed.data);
    return "error" in proposed ? c.json({ error: proposed.error }, proposed.status) : c.json(proposed);
  });

  app.get("/mcp/residents/instructions/proposals/:reviewId", (c) => {
    if (!checkToken(c.req.header("x-harness-token"))) return c.json({ error: "unauthorized" }, 401);
    const session = caller(c.req.header(SCOUT_SUBMISSION_CREDENTIAL_HEADER));
    if (!session) return c.json({ error: NO_CALLER }, 409);
    const outcome = deps.changes.outcome(session, c.req.param("reviewId"));
    return "error" in outcome ? c.json({ error: outcome.error }, outcome.status) : c.json(outcome);
  });
}

export function registerResidentLoopRoutes(app: Hono, deps: {
  registry: Registry; loop: ResidentLoop; residents: ResidentManager;
}): void {
  app.post("/mcp/residents/schedule-next-iteration", async (c) => {
    const refused = (error: string) => c.json({ code: "not_recorded", error }, 409);
    if (!checkToken(c.req.header("x-harness-token"))) return refused("unauthorized");
    const caller = sessionControlCaller(deps.registry, c.req.header(SCOUT_SUBMISSION_CREDENTIAL_HEADER));
    const session = caller && deps.registry.getSession(caller);
    if (!session || session.runtime !== "sdk") return refused("No matching signed resident session.");
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = ScheduleNextIterationRequestSchema.safeParse(body);
    if (!parsed.success) return refused(parsed.error.message);
    try { return c.json(deps.loop.schedule(session, parsed.data)); }
    catch (error) {
      if (error instanceof ResidentLoopRefusal) return refused(error.message);
      throw error; // Unclassified failures may have committed. Never certify rollback.
    }
  });
  for (const action of ["pause", "resume", "run-now", "cancel-run-now", "restart"] as const) {
    app.post(`/api/residents/runs/:id/${action}`, async (c) => {
      const id = c.req.param("id");
      try {
        if (action === "restart") {
          const stored = getResidentRun(id);
          if (!stored) throw new ResidentLoopRefusal("No such resident.");
          const task = deps.registry.getTask(stored.run.taskId);
          if (!task) throw new ResidentLoopRefusal("The original task is unavailable.");
          const request = { repoRoot: taskHasRepository(task) ? task.repoRoot : null, instructions: stored.run.runInstructions, requestId: residentRestartRequestId(id) };
          if (residentRunIdentityByRequest(request.requestId)) {
            const replay = await deps.residents.launch(stored.run.profileId, request);
            return "result" in replay ? c.json(replay.result, replay.status) : c.json({ error: replay.error }, replay.status);
          }
          // Ending the run and launching cannot share a transaction. The persisted pause on an
          // ended run proves this restart request ended it, so a retry can finish the gap before
          // the replacement reserved its request id. Builds that completed the old task here
          // left the same proof, so their interrupted restarts finish too.
          const endedByRestart = stored.run.endedAt !== null && stored.run.pauseReason === RESIDENT_RESTART_PAUSE_REASON;
          if (!endedByRestart) liveRun(id);
          const profile = getResidentProfile(stored.run.profileId);
          if (!profile || profile.archivedAt !== null || profile.revision <= stored.run.profileRevision) throw new ResidentLoopRefusal("No newer live profile revision is available.");
          const problem = deps.residents.settingsProblem(profile.settings);
          if (problem) throw new ResidentLoopRefusal(problem);
          if (!endedByRestart) {
            // The old run stops waking, but its task and session stay open: the operator is
            // offered Complete on the replaced session rather than having it closed for them.
            deps.loop.pause(id, RESIDENT_RESTART_PAUSE_REASON);
            deps.residents.endRun(id);
            deps.registry.refreshTaskResidentRestart(task.id);
          }
          // Settled or not, the replacement's run is reserved by now, so the replaced session's
          // record can name it. A launch that threw leaves the offer to complete in place.
          const result = await deps.residents.launch(profile.id, request, {
            mayConsumeControlClick: sessionControlCallerRefusal(c) === null,
          })
            .finally(() => deps.registry.refreshTaskResidentRestart(task.id));
          return "result" in result ? c.json(result.result, result.status) : c.json({ error: result.error }, result.status);
        }
        liveRun(id);
        if (action === "pause") deps.loop.pause(id);
        else if (action === "resume") deps.loop.resume(id);
        else if (action === "cancel-run-now") deps.loop.cancelRunNow(id);
        else return c.json({ ok: true, outcome: await deps.loop.runNow(id) });
        return c.json({ ok: true });
      } catch (error) {
        if (error instanceof ResidentLoopRefusal) return c.json({ error: error.message }, 409);
        throw error;
      }
    });
  }
}
