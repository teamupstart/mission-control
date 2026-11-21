import type { Hono } from "hono";
import { sessionControlCallerRefusal } from "../session-control.ts";
import type { HibernationManager, HibernationResult } from "./manager.ts";

/**
 * Hibernate a task's session, and resume a hibernated task. Both are OPERATOR actions, refused
 * to an agent's token, an attributed agent request or another origin, the way pause is: an
 * agent hibernating a peer, or waking itself, would defeat the point of either.
 *
 * Hibernate is gated on the `task-hibernation` preview flag (inside the manager, so a test can
 * drive it the same way). Resume is NOT: a task hibernated before the flag was switched off
 * must still be reachable, or switching a preview off would strand its conversation.
 *
 * Each answers the caller with the task as it now stands; every open dashboard converges over
 * SSE through the ordinary `task_upsert`.
 */
export function registerHibernationRoutes(app: Hono, hibernation: HibernationManager | undefined): void {
  const reply = (result: HibernationResult) =>
    result.ok
      ? { body: { ok: true as const, task: result.task }, status: 200 as const }
      : { body: { ok: false as const, error: result.error }, status: result.status };

  app.post("/api/sessions/:id/hibernate", async (c) => {
    const refusal = sessionControlCallerRefusal(c);
    if (refusal) {
      return c.json({ ok: false, error: refusal === "forbidden" ? refusal : "Only the operator can hibernate a session" }, 403);
    }
    if (!hibernation) return c.json({ ok: false, error: "this daemon has no Agent SDK supervisor" }, 503);
    const { body, status } = reply(await hibernation.hibernate(c.req.param("id")));
    return c.json(body, status);
  });

  app.post("/api/tasks/:id/resume", async (c) => {
    const refusal = sessionControlCallerRefusal(c);
    if (refusal) {
      return c.json({ ok: false, error: refusal === "forbidden" ? refusal : "Only the operator can resume a hibernated task" }, 403);
    }
    if (!hibernation) return c.json({ ok: false, error: "this daemon has no Agent SDK supervisor" }, 503);
    const { body, status } = reply(await hibernation.resume(c.req.param("id")));
    return c.json(body, status);
  });
}
