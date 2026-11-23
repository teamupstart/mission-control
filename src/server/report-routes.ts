import type { Context, Hono } from "hono";
import { INBOX_FLAG } from "@shared/inbox.ts";
import { McpPostReportSchema, ReportFollowUpSchema, ReportReplySchema } from "@shared/protocol.ts";
import { reportReceipt } from "@shared/reports.ts";
import { OPERATION_ACTOR_HEADER } from "@shared/telemetry-ingress.ts";
import { SCOUT_SUBMISSION_CREDENTIAL_HEADER } from "@shared/harness-runtime.mjs";
import { checkToken } from "./auth.ts";
import { requireFeature } from "./feature-flags/index.ts";
import { parseBody } from "./http-body.ts";
import type { Registry } from "./registry.ts";
import { ReportRefusal, type FollowUpTaskPort, type ReportManager, type SubmitOperatorTurn } from "./reports.ts";

/**
 * Why this request may not act for the operator on a report, or null when it may. Opening and
 * marking read are the operator's: an agent (the machine token, a signed agent credential, or an
 * agent-attributed request) and Foreman never mark a report read or record that it was opened.
 */
function operatorRefusal(c: Context): string | null {
  const actor = c.req.header(OPERATION_ACTOR_HEADER);
  if (c.req.header("x-harness-token") || c.req.header(SCOUT_SUBMISSION_CREDENTIAL_HEADER)
    || actor === "agent" || actor === "foreman") {
    return "Only the operator can open, mark read, reply to or follow up a report";
  }
  return null;
}

/**
 * Agent reports' routes, all behind the `inbox` flag. A refusal while the flag is off is a 404
 * carrying `feature`, which the MCP tool turns into a message saying where to turn it on.
 *
 * `reports` is optional so an app built without the manager answers 503 rather than building a
 * second owner of the table here.
 */
export function registerReportRoutes(
  app: Hono,
  registry: Registry,
  reports: ReportManager | undefined,
  answers: {
    /** The outbox's operator submit, as the composer's Send uses it. Absent answers 503. */
    submit?: SubmitOperatorTurn;
    /** Task creation and dispatch for a follow-up. Absent answers 503. */
    followUpTasks?: FollowUpTaskPort;
  } = {},
): void {
  const gate = requireFeature(INBOX_FLAG);
  const unavailable = (c: Context) => c.json({ error: "Reports are unavailable in this build" }, 503);
  const refused = (c: Context, error: unknown) => {
    if (error instanceof ReportRefusal) return c.json({ error: error.message }, error.status);
    throw error;
  };

  // The posting session's own report: bound to the caller the way `/mcp/reviews` is, never to a
  // body-named target.
  app.post("/mcp/reports", gate, async (c) => {
    if (!checkToken(c.req.header("x-harness-token"))) return c.json({ error: "unauthorized" }, 401);
    if (!reports) return unavailable(c);
    const parsed = await parseBody(c, McpPostReportSchema);
    if (!parsed.ok) return parsed.res;
    const { env, sessionId, cwd, ...input } = parsed.data;
    const session = registry.findSessionByEnv(env, sessionId, cwd);
    if (!session) return c.json({ error: "no matching session" }, 404);
    try {
      const report = await reports.post(session, input);
      return c.json({ report, receipt: reportReceipt(report) });
    } catch (error) {
      return refused(c, error);
    }
  });

  // Recorded the first time the operator opens a report, never shown as a count.
  app.post("/api/reports/:id/opened", gate, (c) => {
    const refusal = operatorRefusal(c);
    if (refusal) return c.json({ error: refusal }, 403);
    if (!reports) return unavailable(c);
    const report = reports.markOpened(c.req.param("id"));
    return report ? c.json({ report }) : c.json({ error: "no such report" }, 404);
  });

  // Mark read. Idempotent: a report already read keeps when and how it was first read.
  app.post("/api/reports/:id/read", gate, (c) => {
    const refusal = operatorRefusal(c);
    if (refusal) return c.json({ error: refusal }, 403);
    if (!reports) return unavailable(c);
    const report = reports.markRead(c.req.param("id"), "mark-read");
    return report ? c.json({ report }) : c.json({ error: "no such report" }, 404);
  });

  // Reply. Delivered as the operator's own message, so it is echoed and captured exactly as a
  // typed message is, and it marks the report read only once the outbox accepted it.
  app.post("/api/reports/:id/reply", gate, async (c) => {
    const refusal = operatorRefusal(c);
    if (refusal) return c.json({ error: refusal }, 403);
    if (!reports || !answers.submit) return unavailable(c);
    const parsed = await parseBody(c, ReportReplySchema);
    if (!parsed.ok) return parsed.res;
    try {
      return c.json(reports.reply(c.req.param("id"), parsed.data.text, answers.submit));
    } catch (error) {
      return refused(c, error);
    }
  });

  // Start a follow-up task, for a report whose agent is gone. Never resumes the old session. A
  // failed dispatch answers with the task it created, and calling again dispatches that task.
  app.post("/api/reports/:id/follow-up", gate, async (c) => {
    const refusal = operatorRefusal(c);
    if (refusal) return c.json({ error: refusal }, 403);
    if (!reports || !answers.followUpTasks) return unavailable(c);
    const parsed = await parseBody(c, ReportFollowUpSchema);
    if (!parsed.ok) return parsed.res;
    const outcome = await reports.followUp(c.req.param("id"), parsed.data.text, answers.followUpTasks);
    if (outcome.ok) return c.json({ report: outcome.report, taskId: outcome.taskId });
    return c.json({ error: outcome.error, report: outcome.report, taskId: outcome.taskId }, outcome.status);
  });

  // A session's whole history: every version, read or not. Answered for a session that has
  // already been evicted, because the session is a report's permanent home.
  app.get("/api/sessions/:id/reports", gate, (c) => {
    if (!reports) return unavailable(c);
    return c.json({ reports: reports.listForSession(c.req.param("id")) });
  });
}
