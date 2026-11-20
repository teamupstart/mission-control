import type { Hono, MiddlewareHandler } from "hono";
import { HEADLESS_MODE_FLAG_ID } from "@shared/feature-flag-registry.ts";
import { checkToken } from "../auth.ts";
import { requireFeature } from "../feature-flags/index.ts";
import { answersHandler } from "./answers.ts";
import { sendHandler, transcriptHandler, transcriptStreamHandler } from "./chat.ts";
import { configHandler } from "./config.ts";
import { confirmDraftHandler, createDraftHandler, updateDraftHandler } from "./drafts.ts";
import { inboxHandler } from "./inbox.ts";
import { dispatchOptionsHandler } from "./options.ts";
import { readinessHandler } from "./readiness.ts";
import { listResidentsHandler, residentActionHandler } from "./residents.ts";
import { registerSessionHandler } from "./sessions.ts";
import type { HomeDispatchDeps } from "./stub.ts";

/**
 * Every `/dispatch/*` route (spec 2.3). This file only delegates: each route's behavior is a
 * handler in the module its owning phase fills, so no later phase edits it.
 *
 * While the headless-mode flag is off the group answers 404
 * `{ error: "This feature is disabled.", feature: "headless-mode" }`, read for each request so
 * a flag change takes effect without a restart. While on, a route is 501 until its owner lands.
 * Like `/hooks`, the group needs the `x-harness-token` header, and like `/api` a loopback Host.
 */
export function registerHomeDispatchRoutes(
  app: Hono,
  deps: HomeDispatchDeps,
  requireLoopback: MiddlewareHandler,
): void {
  const requireToken: MiddlewareHandler = async (c, next) => {
    if (!checkToken(c.req.header("x-harness-token"))) return c.json({ error: "unauthorized" }, 401);
    await next();
  };
  app.use("/dispatch/*", requireLoopback, requireFeature(HEADLESS_MODE_FLAG_ID), requireToken);

  app.post("/dispatch/sessions", registerSessionHandler(deps));
  app.get("/dispatch/inbox", inboxHandler(deps));
  app.post("/dispatch/answers", answersHandler(deps));
  app.get("/dispatch/config", configHandler(deps));
  app.post("/dispatch/dispatch-options", dispatchOptionsHandler(deps));
  app.post("/dispatch/drafts", createDraftHandler(deps));
  app.post("/dispatch/drafts/:id", updateDraftHandler(deps));
  app.post("/dispatch/drafts/:id/confirm", confirmDraftHandler(deps));
  app.get("/dispatch/readiness", readinessHandler(deps));
  app.get("/dispatch/residents", listResidentsHandler(deps));
  app.post("/dispatch/residents/:runId/:action", residentActionHandler(deps));
  app.get("/dispatch/tasks/:taskId/transcript", transcriptHandler(deps));
  app.get("/dispatch/tasks/:taskId/transcript/stream", transcriptStreamHandler(deps));
  app.post("/dispatch/tasks/:taskId/send", sendHandler(deps));
}
