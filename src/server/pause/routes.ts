import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { FleetPauseRequestSchema, PauseSessionRequestSchema } from "@shared/protocol.ts";
import { logEvent } from "../db.ts";
import { parseBody } from "../http-body.ts";
import { sessionControlCallerRefusal } from "../session-control.ts";
import type { PauseManager, PauseResult } from "./manager.ts";

/**
 * The pause routes. Every one is an OPERATOR action: an agent's token, an attributed agent
 * request or a page from another origin is refused, the way session control refuses them -
 * an agent pausing its peers, or lifting its own pause, would defeat the point of either.
 *
 * Each answers the caller with the outcome; every open dashboard converges over SSE
 * (`session_upsert` for a session's pause, `pause_state` for the fleet-wide half).
 */
/**
 * The largest pause request body accepted. The real ones are a few dozen bytes (`{"mode":"now"}`,
 * Pause all's three fields); the cap stops a strict parse from buffering an arbitrary body.
 */
export const PAUSE_BODY_MAX_BYTES = 4096;

const pauseBodyLimit = bodyLimit({
  maxSize: PAUSE_BODY_MAX_BYTES,
  onError: (c) => c.json({ ok: false, error: "The pause request is too large" }, 413),
});

export function registerPauseRoutes(app: Hono, pauses: PauseManager | undefined): void {
  const reply = (result: PauseResult) =>
    result.ok ? { body: { ok: true } as const, status: 200 as const } : { body: { ok: false, error: result.error }, status: result.status };

  app.get("/api/pause", (c) => {
    if (!pauses) return c.json({ error: "pause manager unavailable" }, 503);
    return c.json(pauses.state());
  });

  app.post("/api/sessions/:id/pause", pauseBodyLimit, async (c) => {
    const refusal = sessionControlCallerRefusal(c);
    if (refusal) return c.json({ ok: false, error: refusal === "forbidden" ? refusal : "Only the operator can pause a session" }, 403);
    if (!pauses) return c.json({ ok: false, error: "pause manager unavailable" }, 503);
    const parsed = await parseBody(c, PauseSessionRequestSchema, { strict: true });
    if (!parsed.ok) return parsed.res;
    const id = c.req.param("id");
    const { body, status } = reply(await pauses.pause(id, parsed.data.mode));
    if (body.ok) logEvent(id, Date.now(), "session_paused", { mode: parsed.data.mode });
    return c.json(body, status);
  });

  app.post("/api/sessions/:id/resume", async (c) => {
    const refusal = sessionControlCallerRefusal(c);
    if (refusal) return c.json({ ok: false, error: refusal === "forbidden" ? refusal : "Only the operator can resume a session" }, 403);
    if (!pauses) return c.json({ ok: false, error: "pause manager unavailable" }, 503);
    const id = c.req.param("id");
    const { body, status } = reply(await pauses.resume(id));
    if (body.ok) logEvent(id, Date.now(), "session_resumed", {});
    return c.json(body, status);
  });

  app.post("/api/sessions/:id/priority", async (c) => {
    const refusal = sessionControlCallerRefusal(c);
    if (refusal) return c.json({ ok: false, error: refusal === "forbidden" ? refusal : "Only the operator can choose a priority session" }, 403);
    if (!pauses) return c.json({ ok: false, error: "pause manager unavailable" }, 503);
    const id = c.req.param("id");
    const { body, status } = reply(await pauses.setPriority(id));
    if (body.ok) logEvent(id, Date.now(), "session_priority", {});
    return c.json(body, status);
  });

  app.post("/api/pause/priority/end", async (c) => {
    const refusal = sessionControlCallerRefusal(c);
    if (refusal) return c.json({ ok: false, error: refusal === "forbidden" ? refusal : "Only the operator can end priority" }, 403);
    if (!pauses) return c.json({ ok: false, error: "pause manager unavailable" }, 503);
    const { body, status } = reply(await pauses.endPriority());
    return c.json(body, status);
  });

  app.post("/api/pause/fleet", pauseBodyLimit, async (c) => {
    const refusal = sessionControlCallerRefusal(c);
    if (refusal) return c.json({ ok: false, error: refusal === "forbidden" ? refusal : "Only the operator can pause every session" }, 403);
    if (!pauses) return c.json({ ok: false, error: "pause manager unavailable" }, 503);
    const parsed = await parseBody(c, FleetPauseRequestSchema, { strict: true });
    if (!parsed.ok) return parsed.res;
    const { body, status } = reply(await pauses.pauseFleet(parsed.data));
    return c.json(body, status);
  });

  app.post("/api/pause/fleet/resume", async (c) => {
    const refusal = sessionControlCallerRefusal(c);
    if (refusal) return c.json({ ok: false, error: refusal === "forbidden" ? refusal : "Only the operator can resume every session" }, 403);
    if (!pauses) return c.json({ ok: false, error: "pause manager unavailable" }, 503);
    const { body, status } = reply(await pauses.resumeFleet());
    return c.json(body, status);
  });
}
