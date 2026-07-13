import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { TypeOf, ZodTypeAny } from "zod";
import {
  CompleteTaskSchema,
  CreateReviewSchema,
  DispatchSchema,
  HookIngestSchema,
  NomistakesRespondSchema,
  ResolveReviewSchema,
  SendTextSchema,
  StatusLineIngestSchema,
  StatusSchema,
} from "@shared/protocol.ts";
import type { Registry } from "./registry.ts";
import type { ReviewManager } from "./reviews.ts";
import type { TaskManager } from "./tasks.ts";
import { sseHandler } from "./sse.ts";
import { transcriptStreamHandler } from "./transcript.ts";
import { computeSessionDiff } from "./diff.ts";
import { checkToken } from "./auth.ts";
import { focus, kill, sendText } from "./actions.ts";
import { respond as nomistakesRespond } from "./nomistakes.ts";
import { buildReport, renderReportMarkdown } from "./report.ts";
import { listRepos } from "./repos.ts";
import { run } from "./util/exec.ts";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

/** Long-poll window for the agent's review wait (it re-polls if still pending). */
const WAIT_TIMEOUT_MS = 30000;

/**
 * Parse + validate a JSON request body against a schema. Returns the typed data,
 * or a ready-to-return 400 response - collapsing the safeParse/400 boilerplate
 * every write endpoint otherwise repeats.
 */
async function parseBody<S extends ZodTypeAny>(
  c: Context,
  schema: S,
): Promise<{ ok: true; data: TypeOf<S> } | { ok: false; res: Response }> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return { ok: false, res: c.json({ error: parsed.error.message }, 400) };
  return { ok: true, data: parsed.data };
}

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

export function buildApp(registry: Registry, reviews: ReviewManager, tasks: TaskManager): Hono {
  const app = new Hono();

  // The daemon binds to loopback, but that alone doesn't stop a web page the user
  // visits from reaching here via DNS-rebinding (the browser sends the *attacker's*
  // Host but the rebound request still hits 127.0.0.1). Writes would be RCE; reads
  // leak task prompts, repo paths, and transcripts. Require a loopback Host on every
  // data endpoint - the same-origin UI and Vite's changeOrigin proxy both qualify,
  // but a rebound cross-site request can't forge it.
  const requireLoopback: MiddlewareHandler = async (c, next) => {
    if (!hostIsLoopback(c.req.header("host"))) return c.json({ error: "forbidden" }, 403);
    await next();
  };
  app.use("/api/*", requireLoopback);
  app.use("/events", requireLoopback);

  app.get("/api/health", (c) =>
    c.json({ ok: true, service: "fleet-control", version: VERSION, pid: process.pid }),
  );
  app.get("/api/sessions", (c) => c.json(registry.snapshot().sessions));
  app.get("/api/reviews", (c) => c.json(registry.snapshot().reviews));
  app.get("/api/tasks", (c) => c.json(tasks.list()));
  // Git repos under the workspace roots - the pickable bases for a new dispatch.
  app.get("/api/repos", async (c) => c.json(await listRepos()));
  // Fleet report (/bearings): a projection of the live snapshot, as JSON or a
  // copy-pasteable markdown digest. Localhost reads, like /api/sessions.
  app.get("/api/report", (c) => c.json(buildReport(registry.snapshot())));
  app.get("/api/report.md", (c) => c.text(renderReportMarkdown(buildReport(registry.snapshot()))));
  app.get("/events", sseHandler(registry));
  // Live transcript for the expanded card (localhost-only, like the actions).
  app.get("/api/sessions/:id/transcript/stream", transcriptStreamHandler(registry));
  // Diff of a session's worktree/branch vs its source branch (localhost read).
  app.get("/api/sessions/:id/diff", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const source = c.req.query("base") || undefined;
    return c.json(await computeSessionDiff(session.cwd, source));
  });

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

  // --- statusLine ingest (token-guarded): Claude's live model / effort / context
  // %, forwarded by hooks/harness-statusline.mjs on every terminal render. ---
  app.post("/statusline", async (c) => {
    if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
    const parsed = await parseBody(c, StatusLineIngestSchema);
    if (!parsed.ok) return parsed.res;
    registry.applyStatusLine(parsed.data);
    return c.body(null, 204);
  });

  // --- MCP review channel (token-guarded) ---
  app.post("/mcp/reviews", async (c) => {
    if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
    const parsed = await parseBody(c, CreateReviewSchema);
    if (!parsed.ok) return parsed.res;
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
    const parsed = await parseBody(c, StatusSchema);
    if (!parsed.ok) return parsed.res;
    registry.applyStatus(parsed.data.env, parsed.data.sessionId, parsed.data.activity);
    return c.body(null, 204);
  });

  // --- review resolution (from the dashboard, localhost) ---
  app.post("/api/reviews/:id/resolve", async (c) => {
    const parsed = await parseBody(c, ResolveReviewSchema);
    if (!parsed.ok) return parsed.res;
    const updated = reviews.resolve(c.req.param("id"), parsed.data.action, parsed.data.response);
    if (!updated) return c.json({ error: "no such review" }, 404);
    return c.json(updated);
  });

  // --- session actions (localhost only) ---
  app.post("/api/sessions/:id/send", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, SendTextSchema);
    if (!parsed.ok) return parsed.res;
    const r = await sendText(session, parsed.data.text, parsed.data.submit);
    return c.json(r, r.ok ? 200 : 500);
  });

  app.post("/api/sessions/:id/focus", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const r = await focus(session);
    return c.json(r, r.ok ? 200 : 500);
  });

  app.post("/api/sessions/:id/kill", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const r = await kill(session);
    return c.json(r, r.ok ? 200 : 500);
  });

  // Answer a no-mistakes gate (approve / fix / skip) for the session's repo.
  app.post("/api/sessions/:id/nomistakes/respond", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    if (!session.cwd) return c.json({ error: "session has no repo directory" }, 400);
    const parsed = await parseBody(c, NomistakesRespondSchema);
    if (!parsed.ok) return parsed.res;
    const r = await nomistakesRespond(registry, session.cwd, parsed.data.action, parsed.data);
    return c.json(r, r.ok ? 200 : 409);
  });

  // --- dispatch: launch/queue agents (localhost only) ---
  app.post("/api/tasks", async (c) => {
    const parsed = await parseBody(c, DispatchSchema);
    if (!parsed.ok) return parsed.res;
    const repoRoot = await resolveRepoRoot(parsed.data.repoRoot);
    if (!repoRoot) return c.json({ error: `not a git repository: ${parsed.data.repoRoot}` }, 400);
    const task = tasks.create({ ...parsed.data, repoRoot });
    return c.json(task);
  });

  app.post("/api/tasks/:id/dispatch", (c) => {
    const t = tasks.dispatch(c.req.param("id"));
    if (!t) return c.json({ error: "no such task" }, 404);
    return c.json(t);
  });

  app.post("/api/tasks/:id/cancel", async (c) => {
    const r = await tasks.cancel(c.req.param("id"));
    return c.json(r, r.ok ? 200 : 404);
  });

  // Free a terminal task's leftover worktree/agent, keeping its status + outcome.
  app.post("/api/tasks/:id/reclaim", async (c) => {
    const r = await tasks.reclaim(c.req.param("id"));
    return c.json(r, r.ok ? 200 : 404);
  });

  app.post("/api/tasks/:id/complete", async (c) => {
    const parsed = await parseBody(c, CompleteTaskSchema);
    if (!parsed.ok) return parsed.res;
    const t = await tasks.complete(c.req.param("id"), parsed.data.outcome, parsed.data.outcomeUrl);
    if (!t) return c.json({ error: "no such task" }, 404);
    return c.json(t);
  });

  app.delete("/api/tasks/:id", async (c) => {
    const r = await tasks.remove(c.req.param("id"));
    return c.json(r, r.ok ? 200 : r.error === "no such task" ? 404 : 409);
  });

  return app;
}

/** True when the Host header names a loopback address (defeats DNS-rebinding). */
export function hostIsLoopback(host: string | undefined): boolean {
  if (!host) return false;
  // Strip a trailing :port and any [] IPv6 brackets, then match loopback names.
  const h = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

/** Validate a dispatch target is a git repo and return its realpath top-level. */
async function resolveRepoRoot(p: string): Promise<string | null> {
  if (!existsSync(p)) return null;
  const r = await run("git", ["-C", p, "rev-parse", "--show-toplevel"]);
  const top = r.stdout.trim();
  if (r.code !== 0 || !top) return null;
  try {
    return realpathSync(top);
  } catch {
    return top;
  }
}
