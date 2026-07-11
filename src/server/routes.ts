import { Hono } from "hono";
import {
  CreateReviewSchema,
  HookIngestSchema,
  NomistakesRespondSchema,
  ResolveReviewSchema,
  SendTextSchema,
  StatusSchema,
} from "@shared/protocol.ts";
import type { Registry } from "./registry.ts";
import type { ReviewManager } from "./reviews.ts";
import { sseHandler } from "./sse.ts";
import { transcriptStreamHandler } from "./transcript.ts";
import { checkToken } from "./auth.ts";
import { focus, kill, sendText } from "./actions.ts";
import { respond as nomistakesRespond } from "./nomistakes.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

/** Long-poll window for the agent's review wait (it re-polls if still pending). */
const WAIT_TIMEOUT_MS = 30000;

/** Service version, read once from package.json; "unknown" if unreadable. */
const VERSION = readVersion();
function readVersion(): string {
  try {
    const raw = readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8");
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === "string" ? v : "unknown";
  } catch {
    return "unknown";
  }
}

export function buildApp(registry: Registry, reviews: ReviewManager): Hono {
  const app = new Hono();

  app.get("/api/health", (c) =>
    c.json({ ok: true, service: "ai-harness", version: VERSION, pid: process.pid }),
  );
  app.get("/api/sessions", (c) => c.json(registry.snapshot().sessions));
  app.get("/api/reviews", (c) => c.json(registry.snapshot().reviews));
  app.get("/events", sseHandler(registry));
  // Live transcript for the expanded card (localhost-only, like the actions).
  app.get("/api/sessions/:id/transcript/stream", transcriptStreamHandler(registry));

  const authed = (c: { req: { header: (k: string) => string | undefined } }) =>
    checkToken(c.req.header("x-harness-token"));

  // --- hook ingest (token-guarded) ---
  app.post("/hooks/:event", async (c) => {
    if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "invalid json" }, 400);
    const parsed = HookIngestSchema.safeParse({ ...(body as object), event: c.req.param("event") });
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    registry.applyHook(parsed.data);
    return c.body(null, 204);
  });

  // --- MCP review channel (token-guarded) ---
  app.post("/mcp/reviews", async (c) => {
    if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
    const parsed = CreateReviewSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const { env, sessionId, cwd, kind, title, body } = parsed.data;
    const session = registry.findSessionByEnv(env, sessionId, cwd);
    if (!session) return c.json({ error: "no matching session" }, 404);
    const review = reviews.create(session.id, kind, title, body);
    return c.json({ id: review.id, sessionId: session.id });
  });

  app.get("/mcp/reviews/:id/wait", async (c) => {
    if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
    const review = await reviews.wait(c.req.param("id"), WAIT_TIMEOUT_MS);
    if (!review) return c.json({ error: "no such review" }, 404);
    return c.json(review);
  });

  app.post("/mcp/status", async (c) => {
    if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
    const parsed = StatusSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    registry.applyStatus(parsed.data.env, parsed.data.sessionId, parsed.data.activity);
    return c.body(null, 204);
  });

  // --- review resolution (from the dashboard, localhost) ---
  app.post("/api/reviews/:id/resolve", async (c) => {
    const parsed = ResolveReviewSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const updated = reviews.resolve(c.req.param("id"), parsed.data.action, parsed.data.response);
    if (!updated) return c.json({ error: "no such review" }, 404);
    return c.json(updated);
  });

  // --- session actions (localhost only) ---
  app.post("/api/sessions/:id/send", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = SendTextSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const r = await sendText(session, parsed.data.text, parsed.data.submit);
    return c.json(r, r.ok ? 200 : 500);
  });

  app.post("/api/sessions/:id/focus", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const r = await focus(session);
    return c.json(r, r.ok ? 200 : 500);
  });

  app.post("/api/sessions/:id/kill", (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const r = kill(session);
    return c.json(r, r.ok ? 200 : 500);
  });

  // Answer a no-mistakes gate (approve / fix / skip) for the session's repo.
  app.post("/api/sessions/:id/nomistakes/respond", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    if (!session.cwd) return c.json({ error: "session has no repo directory" }, 400);
    const parsed = NomistakesRespondSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const r = await nomistakesRespond(registry, session.cwd, parsed.data.action, parsed.data);
    return c.json(r, r.ok ? 200 : 409);
  });

  return app;
}
