import type { Hono } from "hono";
import { ScheduleNextIterationRequestSchema } from "@shared/protocol.ts";
import { taskHasRepository } from "@shared/task.ts";
import { SCOUT_SUBMISSION_CREDENTIAL_HEADER } from "@shared/harness-runtime.mjs";
import { checkToken } from "../auth.ts";
import { sessionControlCaller } from "../session-control.ts";
import type { Registry } from "../registry.ts";
import type { TaskManager } from "../tasks.ts";
import type { ResidentManager } from "./manager.ts";
import type { ResidentLoop } from "./loop.ts";
import { ResidentLoopRefusal, liveRun } from "./loop-store.ts";
import { getResidentProfile, getResidentRun, residentRunIdentityByRequest } from "./store.ts";

export function registerResidentLoopRoutes(app: Hono, deps: {
  registry: Registry; loop: ResidentLoop; residents: ResidentManager; tasks: TaskManager;
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
  for (const action of ["pause", "resume", "run-now", "restart"] as const) {
    app.post(`/api/residents/runs/:id/${action}`, async (c) => {
      const id = c.req.param("id");
      try {
        if (action === "restart") {
          const stored = getResidentRun(id);
          if (!stored) throw new ResidentLoopRefusal("No such resident.");
          const task = deps.registry.getTask(stored.run.taskId);
          if (!task) throw new ResidentLoopRefusal("The original task is unavailable.");
          const request = { repoRoot: taskHasRepository(task) ? task.repoRoot : null, instructions: stored.run.runInstructions, requestId: `resident-restart:${id}` };
          if (residentRunIdentityByRequest(request.requestId)) {
            const replay = await deps.residents.launch(stored.run.profileId, request);
            return "result" in replay ? c.json(replay.result, replay.status) : c.json({ error: replay.error }, replay.status);
          }
          liveRun(id);
          const profile = getResidentProfile(stored.run.profileId);
          if (!profile || profile.archivedAt !== null || profile.revision <= stored.run.profileRevision) throw new ResidentLoopRefusal("No newer live profile revision is available.");
          const problem = deps.residents.settingsProblem(profile.settings);
          if (problem) throw new ResidentLoopRefusal(problem);
          if (stored.run.endedAt === null) {
            deps.loop.pause(id, "Restarting on new profile");
            if (!await deps.tasks.complete(task.id, "Restarted on new resident profile")) throw new ResidentLoopRefusal("The original task could not be completed.");
          }
          const result = await deps.residents.launch(profile.id, request);
          return "result" in result ? c.json(result.result, result.status) : c.json({ error: result.error }, result.status);
        }
        liveRun(id);
        if (action === "pause") deps.loop.pause(id);
        else if (action === "resume") deps.loop.resume(id);
        else await deps.loop.runNow(id);
        return c.json({ ok: true });
      } catch (error) {
        if (error instanceof ResidentLoopRefusal) return c.json({ error: error.message }, 409);
        throw error;
      }
    });
  }
}
