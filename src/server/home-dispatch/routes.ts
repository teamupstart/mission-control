import { Hono, type Context } from "hono";
import {
  AnswerRequestSchema,
  CheckinRequestSchema,
  DispatchOptionsRequestSchema,
  DraftConfirmSchema,
  DraftCreateSchema,
  DraftUpdateSchema,
  HEADLESS_MODE_FLAG_ID,
  HOME_DISPATCH_ROUTE_PREFIX,
  HOME_DISPATCH_ROUTES as R,
  HomeSessionRegistrationSchema,
  homeDispatchGroupPath as at,
  InboxQuerySchema,
  JumpRequestSchema,
} from "@shared/home-dispatch.ts";
import { requireFeature } from "../feature-flags/index.ts";
import { parseBody } from "../http-body.ts";
import { handleAnswer } from "./answers.ts";
import { handleCheckin } from "./checkins.ts";
import { handleReadConfig } from "./config.ts";
import { handleConfirmDraft, handleCreateDraft, handleUpdateDraft } from "./drafts.ts";
import { handleReadInbox } from "./inbox.ts";
import { handleJump } from "./jump.ts";
import { handleDispatchOptions } from "./options.ts";
import { handleRegisterSession } from "./sessions.ts";
import type { HomeDispatchResult } from "./stub.ts";

/** The `:id` of the draft routes. The paths come from the shared table, so Hono cannot infer it. */
const draftId = (c: Context): string => c.req.param("id") ?? "";

export interface HomeDispatchRouteDeps {
  /** The `x-harness-token` check every ingest-family route uses. */
  authed: (c: Context) => boolean;
}

/**
 * Every `/mcp/dispatch/*` route (spec 2.3). Mounted once from `routes.ts`.
 *
 * Gate order: token first (401, as for the rest of `/mcp/*`), then ONE `requireFeature` for the
 * whole group, so a flag-off daemon answers 404 `{ error: "This feature is disabled.", feature }`
 * before any body is read and before any handler runs. The gate reads the flag on every
 * request, never at module load, so a toggle takes effect without a restart.
 *
 * Every body is validated with `parseBody` (spec 3.7). While the flag is on, the handlers are
 * stubs that answer 501 until their owning work package lands (see `stub.ts`).
 */
export function registerHomeDispatchRoutes(parent: Hono, deps: HomeDispatchRouteDeps): void {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (!deps.authed(c)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });
  app.use("*", requireFeature(HEADLESS_MODE_FLAG_ID));

  const reply = (c: Context, result: HomeDispatchResult) => c.json(result.body as object, result.status);

  app.post(at(R.sessions), async (c) => {
    const parsed = await parseBody(c, HomeSessionRegistrationSchema);
    if (!parsed.ok) return parsed.res;
    return reply(c, await handleRegisterSession(parsed.data));
  });

  app.get(at(R.inbox), async (c) => {
    const parsed = InboxQuerySchema.safeParse({ repo: c.req.query("repo") });
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    return reply(c, await handleReadInbox(parsed.data));
  });

  app.post(at(R.answers), async (c) => {
    const parsed = await parseBody(c, AnswerRequestSchema);
    if (!parsed.ok) return parsed.res;
    return reply(c, await handleAnswer(parsed.data));
  });

  app.post(at(R.dispatchOptions), async (c) => {
    const parsed = await parseBody(c, DispatchOptionsRequestSchema);
    if (!parsed.ok) return parsed.res;
    return reply(c, await handleDispatchOptions(parsed.data));
  });

  app.post(at(R.drafts), async (c) => {
    const parsed = await parseBody(c, DraftCreateSchema);
    if (!parsed.ok) return parsed.res;
    return reply(c, await handleCreateDraft(parsed.data));
  });

  app.post(at(R.draft), async (c) => {
    const parsed = await parseBody(c, DraftUpdateSchema);
    if (!parsed.ok) return parsed.res;
    return reply(c, await handleUpdateDraft(draftId(c), parsed.data));
  });

  app.post(at(R.draftConfirm), async (c) => {
    const parsed = await parseBody(c, DraftConfirmSchema);
    if (!parsed.ok) return parsed.res;
    return reply(c, await handleConfirmDraft(draftId(c), parsed.data));
  });

  app.post(at(R.checkins), async (c) => {
    const parsed = await parseBody(c, CheckinRequestSchema);
    if (!parsed.ok) return parsed.res;
    return reply(c, await handleCheckin(parsed.data));
  });

  app.get(at(R.config), async (c) => reply(c, await handleReadConfig({})));

  app.post(at(R.jump), async (c) => {
    const parsed = await parseBody(c, JumpRequestSchema);
    if (!parsed.ok) return parsed.res;
    return reply(c, await handleJump(parsed.data));
  });

  parent.route(HOME_DISPATCH_ROUTE_PREFIX, app);
}
