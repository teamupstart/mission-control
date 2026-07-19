import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Context, MiddlewareHandler } from "hono";
import type { TypeOf, ZodTypeAny } from "zod";
import {
  AddWorkItemSchema,
  CompleteTaskSchema,
  CreateReviewSchema,
  DispatchSchema,
  ResolveRepoSchema,
  EditWorkItemSchema,
  ForemanConfigPatchSchema,
  ForemanHeartbeatSchema,
  GateReplySchema,
  HarnessesConfigPatchSchema,
  HookIngestSchema,
  InjectPromptSchema,
  MarkItemSentSchema,
  NomistakesRespondSchema,
  ReattachQueueSchema,
  RenameSchema,
  ReorderQueueSchema,
  ResetSchema,
  ResolveReviewSchema,
  SelectOptionSchema,
  SendTextSchema,
  SetNoteSchema,
  SetPermissionModeSchema,
  SetWorkItemStateSchema,
  SkillsConfigPatchSchema,
  StandardsRequestSchema,
  StatusLineIngestSchema,
  StatusSchema,
  WrapupSchema,
} from "@shared/protocol.ts";
import type { NomistakesRespond } from "@shared/protocol.ts";
import { capturePaneText } from "./discovery/pane-mode.ts";
import { noteKeyFor } from "./registry.ts";
import type { Registry } from "./registry.ts";
import type { QueueManager } from "./queue.ts";
import type { NmRunSummary, Session, SkillsView, WorkItem } from "@shared/types.ts";
import type { ReviewManager } from "./reviews.ts";
import type { TaskManager } from "./tasks.ts";
import { sseHandler } from "./sse.ts";
import { recordInjection } from "./injections.ts";
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
import { getHarnessesConfig, setHarnessesConfig } from "./harnesses.ts";
import { readCatalog } from "./skills/catalog.ts";
import { applySkillsConfig, getSkillsConfig } from "./skills/config.ts";
import { skillDrift } from "./skills/reconcile.ts";
import { pendingReloads } from "./skills/reload.ts";
import { readStandards } from "./standards.ts";
import { computeCommitDiff, computeSessionDiff, repoRootOf } from "./diff.ts";
import { fixDetail, forgetFixLog } from "./nomistakes-fixes.ts";
import { checkToken } from "./auth.ts";
import { dropGateReply, getSkillsAcks, logGateReply } from "./db.ts";
import {
  cyclePermissionMode,
  focus,
  injectPrompt,
  kill,
  rename,
  resetPreview,
  resetToOrigin,
  selectPaneOption,
  sendText,
  setPermissionMode,
  validateSessionName,
  validateSessionNameAgainstTasks,
} from "./actions.ts";
import { respond as nomistakesRespond } from "./nomistakes.ts";
import { buildReport, renderReportMarkdown } from "./report.ts";
import { listRepos } from "./repos.ts";
import { MAX_UPLOAD_BYTES, saveImageUpload } from "./uploads.ts";
import { run } from "./util/exec.ts";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

/** Long-poll window for the agent's review wait (it re-polls if still pending). */
const WAIT_TIMEOUT_MS = 30000;

/** The upload cap as the refusal states it - both size guards say the same number. */
const TOO_BIG_MB = Math.round(MAX_UPLOAD_BYTES / 1024 / 1024);

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

/**
 * Stake the "you typed this" byline on a gate decision that is about to go out.
 * Returns the row to retract if it doesn't land, or null if there is nothing to
 * take back (the byline is best-effort, so a failed write costs the byline alone).
 */
function stakeYourByline(
  session: Session,
  gate: NmRunSummary,
  step: string,
  body: NomistakesRespond,
): number | null {
  try {
    return logGateReply({
      sessionId: session.id,
      ts: Date.now(),
      source: "you",
      runId: gate.id,
      step,
      // What the human actually picked. Falling back to every finding at the gate
      // matches the Fix box's own contract - it sends an empty list to mean "all
      // shown findings" - so the recorded set is what was decided either way, which
      // is what the join reads.
      findingIds:
        body.findings.length > 0 ? body.findings : gate.findings.map((f) => f.id).filter(Boolean),
      // The Fix box sends `trim() || undefined`, so selecting findings and typing
      // nothing is ordinary and lands as null: an author with no words, not an
      // absent author.
      text: body.instructions ?? null,
    });
  } catch (err) {
    // The decision still goes out; losing the byline must not fail the request.
    console.error("[nomistakes] could not record the gate reply:", err);
    return null;
  }
}

/**
 * Take back a "you typed this" byline the gate never received.
 *
 * Fail-soft, like the write it undoes: this runs both in a request path and in a
 * background `.then()`, and losing the retraction costs one wrong byline while
 * throwing would cost the caller its response or its reconcile.
 */
function retractByline(rowId: number): void {
  try {
    dropGateReply(rowId);
  } catch (err) {
    console.error("[nomistakes] could not retract the gate reply:", err);
  }
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
    c.json({ ok: true, service: "mission-control", version: VERSION, pid: process.pid }),
  );
  app.get("/api/sessions", (c) => c.json(registry.snapshot().sessions));
  app.get("/api/reviews", (c) => c.json(registry.snapshot().reviews));
  app.get("/api/tasks", (c) => c.json(tasks.list()));
  // Git repos under the workspace roots - the pickable bases for a new dispatch.
  app.get("/api/repos", async (c) => c.json(await listRepos()));

  // Resolve a typed path to its canonical git repo root, so the Foreman allowlist
  // picker stores what the server actually gates on (a realpath'd top-level) and
  // rejects a non-repo path instead of letting a typo sit inertly on the list.
  app.post("/api/repos/resolve", async (c) => {
    const parsed = await parseBody(c, ResolveRepoSchema);
    if (!parsed.ok) return parsed.res;
    const repoRoot = await resolveRepoRoot(parsed.data.path);
    if (!repoRoot) return c.json({ error: `not a git repository: ${parsed.data.path}` }, 400);
    return c.json({ repoRoot });
  });
  // Roundup report (/bearings): a projection of the live snapshot, as JSON or a
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

  // The child's rendered screen - the only place an ask that is BLOCKING on the user
  // exists (see `ReviewInput.pane`). Foreman's reviewer reads it alongside the transcript.
  //
  // Captured on demand rather than served off the poll's snapshot, even though
  // `annotatePermissionModes` already captures every pane each tick and throws the text
  // away. A review fires after a settle debounce, so a snapshot would be up to a tick stale
  // - and "stale by one tick" here is not a slightly-old screen, it is the wrong question:
  // the menu the reviewer is about to answer may have replaced the one the poll saw. The
  // cost is one `tmux capture-pane` per review, which is noise beside the `claude -p` it
  // feeds.
  app.get("/api/sessions/:id/pane", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    return c.json({ text: await capturePaneText(session) });
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
    // `commit` isolates ONE commit (`<sha>^..<sha>`) - what a single no-mistakes
    // fix changed. Distinct from `base`, which diffs from the merge-base and so
    // would answer with everything *since* that sha.
    const commit = c.req.query("commit");
    if (commit) return c.json(await computeCommitDiff(session.cwd, commit));
    const source = c.req.query("base") || undefined;
    return c.json(await computeSessionDiff(session.cwd, source));
  });

  // The context behind one no-mistakes fix: the findings that justified it and
  // the reply that authorized it. Fetched per fix rather than denormalized onto
  // the card - a 22-finding fix carries ~20KB of description text.
  app.get("/api/sessions/:id/nomistakes/fixes/:sha", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    if (!session.cwd) return c.json({ error: "session has no repo directory" }, 400);
    const detail = await fixDetail(session.cwd, c.req.param("sha"));
    if (!detail) return c.json({ error: "no such fix on this branch" }, 404);
    return c.json(detail);
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
    const { env, sessionId, cwd, kind, title, body, decisions } = parsed.data;
    const session = registry.findSessionByEnv(env, sessionId, cwd);
    if (!session) return c.json({ error: "no matching session" }, 404);
    const review = reviews.create(session.id, kind, title, body, decisions ?? null);
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

  // Answer the option menu a session is showing by selecting a row.
  //
  // A refusal is a 409, not a 500: every way this fails is the pane declining to confirm
  // (no menu on screen, the row moved, the dialog closed under us), which is a state
  // conflict rather than a server fault - and, because the Enter is never pressed, the
  // child is left exactly as it was found. Foreman's client throws on it either way; the
  // distinction is for the human reading the log, who should not be hunting a crash.
  app.post("/api/sessions/:id/select-option", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, SelectOptionSchema);
    if (!parsed.ok) return parsed.res;
    const r = await selectPaneOption(session, parsed.data);
    return c.json(r, r.ok ? 200 : 409);
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
    // Only once it landed: a refused or failed delivery is not a turn anybody will read,
    // and claiming it would mis-attribute a LATER turn that happens to repeat the text.
    if (r.ok && parsed.data.origin !== "human") recordInjection(session.id, parsed.data.text, parsed.data.origin);
    return c.json(r, r.ok ? 200 : 500);
  });

  // Park a dropped image on disk and hand back its path, which the caller pastes
  // into a prompt for the agent to read - the same trick a terminal plays when you
  // drag a file onto it, and the only one available when the last hop is a pty.
  //
  // Not bound to a session: the dispatch modal drops images before a session
  // exists, and an upload is inert until a path is typed somewhere, so scoping it
  // to a session would buy nothing.
  //
  // The response is a path this daemon just wrote inside its own state dir, never
  // one the client named - the request supplies bytes and a display name, and
  // `saveImageUpload` decides where they land. That, plus the sniff (bytes must
  // BE an image, whatever the client claims) and the loopback guard above, is what
  // keeps "write a file the agent will act on" from being a wider door than /send.
  //
  // `bodyLimit` runs first so an oversized request is refused while it's still a
  // stream - `formData()` would otherwise buffer the whole thing into memory before
  // anyone could object to its size. The slack over the cap covers the multipart
  // envelope (boundaries, headers) wrapping the bytes; the route re-checks the
  // decoded part below, which is what lets the refusal talk about the IMAGE's size
  // rather than the request's.
  app.post(
    "/api/uploads",
    bodyLimit({
      maxSize: MAX_UPLOAD_BYTES + 64 * 1024,
      onError: (c) => c.json({ error: `image is larger than ${TOO_BIG_MB}MB` }, 413),
    }),
    async (c) => {
      const form = await c.req.formData().catch(() => null);
      const file = form?.get("file");
      if (!(file instanceof File)) return c.json({ error: "expected a `file` part" }, 400);
      if (file.size > MAX_UPLOAD_BYTES) {
        return c.json({ error: `image is larger than ${TOO_BIG_MB}MB` }, 413);
      }
      try {
        const saved = saveImageUpload(new Uint8Array(await file.arrayBuffer()), file.name);
        return c.json(saved);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    },
  );

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
    // The fix log needs no dismissal - the reset destroyed the commits it's read
    // from, so it's empty by construction. But drop the cached read: it's keyed on
    // HEAD, and the reset moved HEAD, so a stale entry could still be served.
    if (r.ok && session.cwd) {
      forgetFixLog(session.cwd);
      registry.clearNomistakesFixes(session.id);
    }
    // The reset discarded the task these queued items were authored for - the branch
    // is gone and (with `clear`) the agent's context is wiped - so clear the whole
    // batch. This is the deliberate "start over", the one case that overrides the
    // re-attach affordance a bare /clear leans on. Keyed on the PRE-reset session,
    // whose note key still names the queue: a /clear only rotates that key once the
    // agent processes it, which is after this handler returns.
    if (r.ok) registry.clearQueue(noteKeyFor(session));
    return c.json(r, r.ok ? 200 : 500);
  });

  // Answer a no-mistakes gate (approve / fix / skip) for the session's repo.
  app.post("/api/sessions/:id/nomistakes/respond", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    if (!session.cwd) return c.json({ error: "session has no repo directory" }, 400);
    const parsed = await parseBody(c, NomistakesRespondSchema);
    if (!parsed.ok) return parsed.res;
    // The "you typed this" byline. Recorded HERE rather than inside `respond()`
    // because this route is what the claim actually means: `respond()` is a helper
    // keyed by cwd that anything could call, while a POST to this route is by
    // definition the dashboard's Fix box. It's also the only side holding a session
    // and its live run.
    //
    // Only for `fix`: `approve`/`skip` commit nothing, so they have no fix to put a
    // byline on.
    //
    // Written BEFORE the decision goes out and RETRACTED if it doesn't land, rather
    // than written once we know. The ordering is load-bearing, not an optimisation:
    // `axi respond` blocks server-side until the run reaches the next gate or an
    // outcome, so by the time it settles the fix it authorized is already committed -
    // a byline stamped then would date from after that commit, and `pickGateReply`'s
    // causality filter would discard it. Logging on the way out is the only way the
    // row's `ts` can precede the fix it explains; the alternative silently deletes
    // the whole "you" lane.
    const gate = session.nomistakes;
    const step = parsed.data.step || gate?.gateStep;
    const rowId =
      parsed.data.action === "fix" && gate && step
        ? stakeYourByline(session, gate, step, parsed.data)
        : null;

    const r = await nomistakesRespond(registry, session.cwd, parsed.data.action, {
      ...parsed.data,
      // Undelivered is un-authored. The gate the user answered may be one the run has
      // already moved past (status is polled, so the Fix box can be ~seconds stale),
      // and `axi respond` then exits non-zero having said nothing. Left behind, that
      // row would sign whatever the agent later decided for itself through the
      // `/no-mistakes` skill - stamping "by you, in the dashboard" on an autonomous
      // fix, which is the feature's own distinction inverted, in its worst direction.
      //
      // KNOWN LIMITATION: only the LOUD failure is compensated. `axi` exiting 0 while
      // no-opping on an already-decided gate leaves a row nothing here can tell from a
      // delivered one, so that byline stands. Guessing at it would reintroduce exactly
      // the misattribution this closes.
      onUndelivered: rowId === null ? undefined : () => retractByline(rowId),
    });
    // Rejected before anything was spawned (no binary, or a decision already in
    // flight): the gate heard nothing, so the same retraction applies.
    if (!r.ok && rowId !== null) retractByline(rowId);
    return c.json(r, r.ok ? 200 : 409);
  });

  // Record a Foreman gate nudge, for the fix log's byline. Loopback-gated like
  // every /api route: the worker is a separate process with no DB access of its own.
  app.post("/api/sessions/:id/gate-reply", async (c) => {
    const session = registry.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "no such session" }, 404);
    const parsed = await parseBody(c, GateReplySchema);
    if (!parsed.ok) return parsed.res;
    try {
      logGateReply({
        sessionId: session.id,
        ts: Date.now(),
        source: "foreman",
        runId: parsed.data.runId,
        step: parsed.data.step,
        findingIds: parsed.data.findingIds,
        text: parsed.data.text || null,
      });
    } catch (err) {
      // Fail soft, like every other byline write (stakeYourByline, retractByline,
      // attribute, the prune). A byline is never worth an error to its caller: the
      // foreman's reply is already delivered by the time it posts this, so a DB
      // failure must cost the byline and nothing else. 500ing here would be the one
      // write in the feature that breaks that posture.
      console.error("[nomistakes] could not record the foreman gate reply:", err);
    }
    return c.json({ ok: true });
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

  // Cross-session: queues with no live session at all, so nothing is stranded with
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
  // twice, and both workers would draacross the sessions.
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

  // --- custom skills: the catalog + what's switched on (localhost only) ---

  /**
   * The whole panel in one read: the catalog, what's enabled, how many sessions are
   * behind, and anything the reconciler refused.
   *
   * One route rather than a config/status pair, because unlike Foreman there is no
   * second consumer - the worker process doesn't read this - and the two halves are
   * only ever rendered together. A split would be two polls to draw one panel.
   */
  const skillsView = (): SkillsView => {
    const cfg = getSkillsConfig();
    const catalog = readCatalog();
    return {
      enabled: cfg.enabled,
      skills: catalog.skills.map((s) => ({ ...s, enabled: cfg.skills[s.id] === true })),
      pending: pendingReloads(registry.snapshot().sessions, getSkillsAcks(), cfg),
      // Catalog problems plus a fresh look at the DISK. The drift check is what keeps a
      // failed STARTUP reconcile from being invisible: its problems had no PUT to answer,
      // so they went to a console nobody reads, and every toggle would render on while
      // the sessions had none of them.
      problems: [...catalog.problems, ...skillDrift(cfg, catalog)],
    };
  };

  app.get("/api/skills", (c) => c.json(skillsView()));

  /**
   * Reconcile, then persist - both inside `applySkillsConfig`, so this route cannot
   * do one without the other.
   *
   * The patch schema accepts only `enabled` and `skills`. The generation is the
   * server's watermark, and a client that could set it could either silence every
   * session's reload (set it back) or type into every pane on the machine at will (set
   * it forward). Excluding it at the boundary beats trusting the route.
   *
   * 409 on `refused` and NOT on `problems`, which is the difference between "your
   * toggle didn't work" and "something else is wrong". A reconcile pass reports on every
   * enabled skill, so `problems` is routinely non-empty for reasons the caller had
   * nothing to do with - one skill dropped from the catalog by a `git pull` says so on
   * every pass, forever. 409ing on that turned a toggle that had fully applied into
   * "nothing changed" in the panel, reverted the switch, and let the next poll flip it
   * back on - and wedged every other toggle the same way. Those problems reach the
   * operator through the view, which reports them continuously anyway.
   */
  app.put("/api/skills/config", async (c) => {
    const parsed = await parseBody(c, SkillsConfigPatchSchema);
    if (!parsed.ok) return parsed.res;
    const synced = applySkillsConfig(parsed.data);
    if (synced.refused.length > 0) return c.json({ error: synced.refused.join("; ") }, 409);
    return c.json(skillsView());
  });

  // --- Harnesses: dispatch-time defaults for launched sessions (localhost only) ---
  app.get("/api/harnesses/config", (c) => c.json(getHarnessesConfig()));
  app.put("/api/harnesses/config", async (c) => {
    const parsed = await parseBody(c, HarnessesConfigPatchSchema);
    if (!parsed.ok) return parsed.res;
    return c.json(setHarnessesConfig(parsed.data));
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
