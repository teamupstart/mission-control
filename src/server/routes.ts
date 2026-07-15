import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { TypeOf, ZodTypeAny } from "zod";
import {
  AddWorkItemSchema,
  CompleteTaskSchema,
  CreateReviewSchema,
  DispatchSchema,
  EditWorkItemSchema,
  ForemanConfigPatchSchema,
  ForemanHeartbeatSchema,
  HookIngestSchema,
  InjectPromptSchema,
  MarkItemSentSchema,
  NomistakesRespondSchema,
  ReattachQueueSchema,
  RenameSchema,
  ReorderQueueSchema,
  ResetSchema,
  ResolveReviewSchema,
  SendTextSchema,
  SetNoteSchema,
  SetPermissionModeSchema,
  SetWorkItemStateSchema,
  StandardsRequestSchema,
  StatusLineIngestSchema,
  StatusSchema,
  WrapupSchema,
} from "@shared/protocol.ts";
import { noteKeyFor } from "./registry.ts";
import type { Registry } from "./registry.ts";
import type { QueueManager } from "./queue.ts";
import type { WorkItem } from "@shared/types.ts";
import type { ReviewManager } from "./reviews.ts";
import type { TaskManager } from "./tasks.ts";
import { sseHandler } from "./sse.ts";
import {
  readTranscriptSince,
  readTranscriptWindow,
  resolveTranscriptPath,
  transcriptSize,
  transcriptStreamHandler,
} from "./transcript.ts";
import {
  claimForemanLease,
  foremanStatus,
  getForemanConfig,
  releaseForemanLease,
  setForemanConfig,
} from "./foreman/config.ts";
import { readStandards } from "./standards.ts";
import { computeSessionDiff, repoRootOf } from "./diff.ts";
import { checkToken } from "./auth.ts";
import {
  cyclePermissionMode,
  focus,
  injectPrompt,
  kill,
  rename,
  resetPreview,
  resetToOrigin,
  sendText,
  setPermissionMode,
  validateSessionName,
  validateSessionNameAgainstTasks,
} from "./actions.ts";
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
// `error` is carried alongside the ready-made `res` so a route with extra facts to
// report on a refusal can build its own body without re-reading this one's. /inject
// is that route: its contract is that EVERY refusal states whether text was pasted.
async function parseBody<S extends ZodTypeAny>(
  c: Context,
  schema: S,
): Promise<{ ok: true; data: TypeOf<S> } | { ok: false; error: string; res: Response }> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return { ok: false, error: parsed.error.message, res: c.json({ error: parsed.error.message }, 400) };
  }
  return { ok: true, data: parsed.data };
}

/**
 * Resolve an item-scoped queue route: the `:id` session must exist, and `:itemId`
 * must belong to ITS queue.
 *
 * Without the ownership half, `:id` was decoration - the item was addressed
 * globally, so `POST /api/sessions/does-not-exist/queue/<real-item>/approve`
 * answered 200. That isn't hypothetical mischief: item ids SURVIVE a re-attach
 * (`reattachQueue` preserves `i.id` while re-keying), so a tab holding a
 * pre-re-attach list - SSE dropped, or backgrounded, so no refresh fired - would
 * click Remove on item X under session A and delete it out of session B's live
 * queue. Membership is the only thing that distinguishes those two, and it is
 * checked at the write because that is the boundary the damage crosses.
 *
 * The queue's own key is the unit of ownership, not `session.id`: the id churns
 * with pid/tty while the note key is the identity the queue is stored under.
 */
function ownedItem(
  registry: Registry,
  queues: QueueManager,
  c: Context,
): { ok: true; item: WorkItem } | { ok: false; res: Response } {
  const session = registry.getSession(c.req.param("id") ?? "");
  if (!session) return { ok: false, res: c.json({ error: "no such session" }, 404) };
  const item = queues.getItem(c.req.param("itemId") ?? "");
  if (!item) return { ok: false, res: c.json({ error: "no such item" }, 404) };
  if (item.noteKey !== noteKeyFor(session)) {
    return { ok: false, res: c.json({ error: "that item is not in this session's queue" }, 404) };
  }
  return { ok: true, item };
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

export function buildApp(
  registry: Registry,
  reviews: ReviewManager,
  tasks: TaskManager,
  queues: QueueManager,
): Hono {
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
  // One-shot transcript window for a non-streaming reader (Foreman's triage
  // reviewer, and the queue verifier).
  //
  // `?since=<byteOffset>` reads FORWARD from an offset - how the queue scopes a
  // window to one work item. A turn count can't do that: a 48-turn window can span
  // three items, and the head+tail window elides the middle of a big file, so
  // filtering it by timestamp would silently drop an item's earliest turns (the
  // ones that establish what the agent set out to do). The transcript is
  // append-only, so a stored file size is an exact, O(1) item boundary.
  app.get("/api/sessions/:id/transcript", (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const path = resolveTranscriptPath(session);
    if (!path) return c.json({ messages: [], truncated: false, unavailable: true });
    const since = Number(c.req.query("since"));
    if (Number.isFinite(since) && since >= 0) return c.json(readTranscriptSince(path, since));
    const turns = Number(c.req.query("turns"));
    const tail = Number.isFinite(turns) && turns > 0 ? Math.min(turns, 200) : 48;
    return c.json(readTranscriptWindow(path, 12, tail));
  });

  // The transcript's current byte size - the anchor a work item records when it's
  // delivered, so its verify window starts exactly at its first turn.
  app.get("/api/sessions/:id/transcript/size", (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const path = resolveTranscriptPath(session);
    return c.json({ size: path ? transcriptSize(path) : null });
  });

  // The repo standards the queue verifier judges an item's diff against.
  //
  // Resolved against the git TOPLEVEL, not the session's cwd: `paths` come from the
  // diff, and git emits those relative to the toplevel wherever it was invoked from.
  // A session sitting in a subdirectory (a monorepo package - the ordinary case)
  // would otherwise look for the root AGENTS.md one level down and resolve every
  // changed path into a directory chain that doesn't exist, quietly loading NO
  // standards at all. Worse, `truncated` would be false, so the prompt wouldn't even
  // print its "some standards docs were omitted" line - the verifier would judge
  // against the repo's main contract without it, and nothing would say so.
  //
  // A POST carrying the paths in its body, though it is a pure read: the list comes
  // from a patch capped at 1.2MB, so as `path=` query params a large refactor's few
  // hundred encoded paths overrun Node's 16KB default `maxHeaderSize` and the request
  // never arrives. The caller degrades that to an empty bundle, which is the exact
  // silent failure the paragraph above is about.
  app.post("/api/sessions/:id/standards", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, StandardsRequestSchema);
    if (!parsed.ok) return parsed.res;
    const root = await repoRootOf(session.cwd);
    return c.json(readStandards(root, parsed.data.paths));
  });
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

  // Rename the session's tmux session / wezterm tab; discovery reads the new name
  // back onto the card, and the registry echoes it immediately so it doesn't lag a
  // poll. A name the backing handle can't accept, or one a task's teardown still
  // aims at, is a 400 the editor can show; a shelled-out failure a 500.
  app.post("/api/sessions/:id/rename", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, RenameSchema);
    if (!parsed.ok) return parsed.res;
    const valid = validateSessionName(session, parsed.data.name);
    if (!valid.ok) return c.json({ ok: false, error: valid.error }, 400);
    const free = validateSessionNameAgainstTasks(session, valid.name, registry.listTasks());
    if (!free.ok) return c.json({ ok: false, error: free.error }, 400);
    const r = await rename(session, valid.name);
    if (r.ok) registry.renameSession(session.id, valid.name);
    return c.json(r, r.ok ? 200 : 500);
  });

  // Deliver a whole prompt as ONE submission (bracketed paste), unlike /send's
  // literal send-keys where every embedded newline submits. This is the only way
  // to deliver a multi-line intent or a bulleted gap list at all.
  //
  // Mirrors /send's contract exactly - `c.json(r, r.ok ? 200 : 500)` - so the
  // client genuinely throws on failure. That's what lets the worker write
  // `awaiting_pickup` only AFTER the inject resolves (the send-first-then-stamp
  // discipline applyVerdict already encodes).
  // The response carries `pasted`, which is what lets the worker tell a delivery
  // that never happened (retryable) from one that may be sitting unsubmitted in the
  // pane (must not be retyped over). Every refusal below reports it too, since
  // rejecting a request outright is the one case where we KNOW nothing was typed.
  app.post("/api/sessions/:id/inject", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session", pasted: false }, 404);
    // `parseBody`'s generic 400 carries no `pasted`, and the client reads a MISSING
    // field as "may have landed" (absence of evidence is not evidence - see
    // InjectError). That default is right everywhere else and exactly wrong here: a
    // rejected body never reached tmux, so reporting the refusal without the field
    // terminally escalates the item ("Foreman couldn't tell whether this reached the
    // pane", no undo) instead of taking the clean re-queue. Say what we know.
    const parsed = await parseBody(c, InjectPromptSchema);
    if (!parsed.ok) return c.json({ error: parsed.error, pasted: false }, 400);
    const r = await injectPrompt(session, parsed.data.text);
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

  // Cycle the session's permission mode one Shift+Tab step - Claude only.
  app.post("/api/sessions/:id/mode/cycle", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    if (session.agent !== "claude")
      return c.json({ error: "permission modes are a Claude feature" }, 400);
    const r = await cyclePermissionMode(session);
    // `r.mode` was read back off the pane, so recording it can't diverge from
    // what Claude actually did; it's null when the pane didn't show us a mode.
    if (r.ok) registry.recordObservedPermissionMode(session.id, r.mode ?? null);
    return c.json(r, r.ok ? 200 : 500);
  });

  // Drive the session to a specific permission mode - Claude only. Walks the
  // Shift+Tab cycle, verifying against the pane at each step; see
  // `setPermissionMode` for why the distance can't just be computed.
  app.post("/api/sessions/:id/mode", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    if (session.agent !== "claude")
      return c.json({ error: "permission modes are a Claude feature" }, 400);
    const parsed = await parseBody(c, SetPermissionModeSchema);
    if (!parsed.ok) return parsed.res;
    const r = await setPermissionMode(session, parsed.data.mode);
    // Record on failure too: a walk that stops early still leaves the session in a
    // mode we observed, and the chip should show where it actually ended up.
    registry.recordObservedPermissionMode(session.id, r.mode ?? null);
    return c.json(r, r.ok ? 200 : 409);
  });

  // Preview what a reset-to-origin would discard (fetches origin; localhost read).
  app.get("/api/sessions/:id/reset/preview", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    return c.json(await resetPreview(session));
  });

  // Pull latest and hard-reset the checkout to origin's default branch, then
  // clear the agent's context. The UI confirms (with the loss preview) first.
  app.post("/api/sessions/:id/reset", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, ResetSchema);
    if (!parsed.ok) return parsed.res;
    // Sample the run the user is looking at BEFORE the reset: the fetch inside can
    // take ~30s, and the poller may swap or clear the run in that window.
    const showing = session.nomistakes;
    const r = await resetToOrigin(session, parsed.data.clear);
    // The reset discarded the work the run validated, so retire its strip along
    // with the rest of the card's state. Only on success: a failed reset left the
    // work - and the run that describes it - in place. Retired against the
    // checkout it wiped (root + the branch standing in it), not this session, so
    // it holds for a sibling sharing the checkout and across a restart.
    if (r.ok && showing) registry.dismissNomistakes(showing, r.root, session.gitBranch);
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

  // --- Foreman session notes (localhost only) ---
  // Full note incl. handledMarker, for the worker's idempotency check.
  app.get("/api/sessions/:id/note", (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    return c.json(registry.getNote(session.id));
  });

  app.put("/api/sessions/:id/note", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, SetNoteSchema);
    if (!parsed.ok) return parsed.res;
    const note = registry.upsertNote(session.id, parsed.data);
    if (!note) return c.json({ error: "no such session" }, 404);
    return c.json(note);
  });

  // --- Foreman session work queues (localhost only) ---
  app.get("/api/sessions/:id/queue", (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    return c.json(queues.get(session.id));
  });

  app.post("/api/sessions/:id/queue", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, AddWorkItemSchema);
    if (!parsed.ok) return parsed.res;
    const item = queues.add(session.id, parsed.data.intent);
    // The session resolved above, so the only refusal `ensureQueue` has left is the
    // Claude-only one - and saying "no such session" about a session that plainly
    // exists sends the caller hunting for the wrong bug.
    if (!item) {
      return c.json(
        { error: "work queues are Claude-only - Foreman reads transcripts to check the work" },
        409,
      );
    }
    return c.json(item);
  });

  // Edit: 409 on a CAS miss or an item that has left queued/proposed - Foreman may
  // already have typed it into a pane, and "edited" would then be a lie.
  app.patch("/api/sessions/:id/queue/:itemId", async (c) => {
    const owned = ownedItem(registry, queues, c);
    if (!owned.ok) return owned.res;
    const parsed = await parseBody(c, EditWorkItemSchema);
    if (!parsed.ok) return parsed.res;
    const r = queues.edit(owned.item.id, parsed.data.intent, parsed.data.revision);
    if (r.ok) return c.json(r.item);
    return c.json({ error: r.error }, r.error === "no such item" ? 404 : 409);
  });

  app.delete("/api/sessions/:id/queue/:itemId", (c) => {
    const owned = ownedItem(registry, queues, c);
    if (!owned.ok) return owned.res;
    const r = queues.remove(owned.item.id);
    return c.json(r, r.ok ? 200 : r.error === "no such item" ? 404 : 409);
  });

  app.put("/api/sessions/:id/queue/order", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, ReorderQueueSchema);
    if (!parsed.ok) return parsed.res;
    const r = queues.reorder(session.id, parsed.data.ids);
    return c.json(r, r.ok ? 200 : 409);
  });

  app.post("/api/sessions/:id/queue/:itemId/approve", (c) => {
    const owned = ownedItem(registry, queues, c);
    if (!owned.ok) return owned.res;
    const r = queues.approve(owned.item.id);
    return c.json(r, r.ok ? 200 : r.error === "no such item" ? 404 : 409);
  });

  app.put("/api/sessions/:id/queue/:itemId/state", async (c) => {
    const owned = ownedItem(registry, queues, c);
    if (!owned.ok) return owned.res;
    const parsed = await parseBody(c, SetWorkItemStateSchema);
    if (!parsed.ok) return parsed.res;
    const r = queues.setState(owned.item.id, parsed.data);
    if (r.ok) return c.json(r.item);
    // 409, not 500: a single-flight refusal means the caller broke the invariant,
    // and it must be able to tell that from the daemon falling over.
    return c.json({ error: r.error }, r.error === "no such item" ? 404 : 409);
  });

  // Stamp delivery. Separate from /state because `sentAt` is the daemon's clock,
  // not the worker's: the pickup guard compares it against `lastActivity`, which
  // the registry stamps from the hook payload, so the two must share a writer.
  app.post("/api/sessions/:id/queue/:itemId/sent", async (c) => {
    const owned = ownedItem(registry, queues, c);
    if (!owned.ok) return owned.res;
    const parsed = await parseBody(c, MarkItemSentSchema);
    if (!parsed.ok) return parsed.res;
    const r = queues.markSent(owned.item.id, parsed.data.baseSha, parsed.data.transcriptAnchor);
    if (r.ok) return c.json(r.item);
    return c.json({ error: r.error }, r.error === "no such item" ? 404 : 409);
  });

  // Adopt an item a restart left mid-send (see QueueManager.recover).
  app.post("/api/sessions/:id/queue/:itemId/recover", (c) => {
    const owned = ownedItem(registry, queues, c);
    if (!owned.ok) return owned.res;
    const r = queues.recover(owned.item.id);
    if (r.ok) return c.json(r.item);
    return c.json({ error: r.error }, r.error === "no such item" ? 404 : 409);
  });

  // The human's answer to the drain-time ask.
  app.put("/api/sessions/:id/queue/wrapup", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const queue = queues.get(session.id);
    if (!queue) return c.json({ error: "no queue for this session" }, 404);
    const parsed = await parseBody(c, WrapupSchema);
    if (!parsed.ok) return parsed.res;
    queues.setWrapupAnswer(queue.noteKey, parsed.data.answer);
    return c.json(queues.get(session.id));
  });

  // The worker's "I've raised the ask" stamp - what makes it fire exactly once.
  // Separate from the answer above because they have different writers: this is
  // Foreman recording that it asked, that is the human recording what they said.
  app.post("/api/sessions/:id/queue/wrapup/asked", (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const queue = queues.get(session.id);
    if (!queue) return c.json({ error: "no queue for this session" }, 404);
    queues.markWrapupAsked(queue.noteKey);
    return c.json(queues.get(session.id));
  });

  // Re-attach an orphaned queue onto this live session. Always an explicit click:
  // a different agent at the same cwd may be doing something else entirely.
  app.post("/api/sessions/:id/queue/reattach", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, ReattachQueueSchema);
    if (!parsed.ok) return parsed.res;
    const r = queues.reattach(parsed.data.noteKey, session.id);
    return c.json(r, r.ok ? 200 : 409);
  });

  // Fleet-level: queues with no live session at all, so nothing is stranded with
  // no surface whatsoever (the cwd-match hint only covers a queue whose cwd still
  // has a live session on it).
  app.get("/api/queues", (c) =>
    c.json(c.req.query("orphaned") === "1" ? queues.orphaned() : queues.list()),
  );

  /*
    The same write, addressed by QUEUE KEY - the orphan sweep's route.

    It exists because the session-scoped routes above now insist the session
    resolves, and the sweep's whole subject is a queue whose session is GONE: it
    terminalizes the in-flight item of a queue nothing can drive any more, so there
    is no `:id` for it to name. It previously borrowed the session route by passing
    the note key as the session id, which worked only because that route ignored the
    segment entirely - i.e. the sweep was relying on the very bug that let any tab
    write to any queue.

    Ownership is checked the same way, against the key the caller named.
  */
  app.put("/api/queues/:key/items/:itemId/state", async (c) => {
    const item = queues.getItem(c.req.param("itemId"));
    if (!item) return c.json({ error: "no such item" }, 404);
    if (item.noteKey !== c.req.param("key")) {
      return c.json({ error: "that item is not in this queue" }, 404);
    }
    const parsed = await parseBody(c, SetWorkItemStateSchema);
    if (!parsed.ok) return parsed.res;
    const r = queues.setState(item.id, parsed.data);
    if (r.ok) return c.json(r.item);
    return c.json({ error: r.error }, r.error === "no such item" ? 404 : 409);
  });

  // --- Foreman config + status (localhost only) ---
  app.get("/api/foreman/config", (c) => c.json(getForemanConfig()));
  app.put("/api/foreman/config", async (c) => {
    const parsed = await parseBody(c, ForemanConfigPatchSchema);
    if (!parsed.ok) return parsed.res;
    return c.json(setForemanConfig(parsed.data));
  });
  app.get("/api/foreman/status", (c) => c.json(foremanStatus(registry)));

  // A LEASED heartbeat: acquires when free/expired, renews when already ours, and
  // reports leader:false otherwise. The old bare heartbeat was one module-global
  // timestamp that couldn't detect a second worker at all - it just got beaten
  // twice, and both workers would drain the fleet.
  app.post("/api/foreman/heartbeat", async (c) => {
    const parsed = await parseBody(c, ForemanHeartbeatSchema);
    if (!parsed.ok) return parsed.res;
    return c.json(claimForemanLease(parsed.data.workerId));
  });

  // A leader handing the lease back on a clean shutdown, so a standby takes over
  // at once rather than waiting out the TTL. Best-effort by nature: a crash just
  // lets the lease expire, which is exactly what the TTL is for.
  app.post("/api/foreman/heartbeat/release", async (c) => {
    const parsed = await parseBody(c, ForemanHeartbeatSchema);
    if (!parsed.ok) return parsed.res;
    releaseForemanLease(parsed.data.workerId);
    return c.body(null, 204);
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
