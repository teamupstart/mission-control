import type { Context, Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { SHAPER_SIGN_IN_FLAG_ID } from "@shared/feature-flag-registry.ts";
import {
  classifyShapers, shaperSignInTarget, ShaperSignInRequestSchema, ShaperSignOutRequestSchema,
  type DiscoveredShaper, type Shaper, type ShaperSignInReply, type ShaperSignOutReply,
} from "@shared/shaping.ts";
import { requireFeature } from "../../feature-flags/index.ts";
import { parseBody } from "../../http-body.ts";
import { discoverShapers } from "../discovery.ts";
import { getShapingConfig } from "../index.ts";
import { notFinishedPage, signedInPage, SIGN_IN_PAGE_HEADERS, type SignInPageFailure } from "./callback-page.ts";
import { SIGN_IN_CALLBACK_PATH } from "./index.ts";
import { SIGN_IN_BEGIN_REFUSALS, type BeginFailureCode, type ShaperSignInService } from "./service.ts";

/** Both bodies are one short id; the limit is a ceiling with room for whitespace, never an allocation. */
export const SIGN_IN_BODY_MAX_BYTES = 4 * 1024;
/** The most a callback query value may be, in UTF-8 bytes. A longer one is no value a sign-in sends. */
export const SIGN_IN_CALLBACK_VALUE_MAX_BYTES = 2 * 1024;

/** The callback's query: these four, and nothing else is read. */
const CALLBACK_PARAMS = ["state", "code", "error", "iss"] as const;

/**
 * `begin` refusals that are Mission Control's own, not the server's: the request was sound and
 * this daemon declined it as things stand, so they are 409. A timeout is the server's slowness,
 * 504. Every other failure is 502: the server could not be reached, or answered unusably.
 */
const OWN_REFUSALS: ReadonlySet<BeginFailureCode> = new Set(["registration_limit", "store_unread", "flag_off"]);

/**
 * What a failed start answers, one fixed sentence per code. The service's own reason is never
 * forwarded: it may carry text a server sent, and a reply may hold no value from the flow. The
 * daemon's log keeps it for diagnosis.
 */
export const SIGN_IN_START_FAILURES: Readonly<Record<BeginFailureCode, string>> = Object.freeze({
  ...SIGN_IN_BEGIN_REFUSALS,
  refused: "The server or its authorization server refused to start the sign-in. Check the shaper's URL and scope, then try again at Settings > Task shaping.",
  client_rejected: "The authorization server rejected Mission Control's client registration. Try again at Settings > Task shaping.",
  sign_in_again: "The authorization server's answer did not match this sign-in. Try again at Settings > Task shaping.",
  retry: "The server or its authorization server could not be reached, or did not answer in time. Try again at Settings > Task shaping.",
  failed: "The server or its authorization server could not start the sign-in. Check the shaper's URL and scope, then try again at Settings > Task shaping.",
});

/**
 * What a body that fails its schema answers. Fixed, never the schema's own message: that can name
 * an unexpected key or quote a value, and a reply may repeat nothing from the request.
 */
export const INVALID_SIGN_IN_BODY = Object.freeze({ error: "invalid_request", reason: "The body must be a JSON object with one field, shaper: a shaper id." });
export const INVALID_SIGN_OUT_BODY = Object.freeze({ error: "invalid_request", reason: "The body must be a JSON object with one field, connection: a connection id." });

export interface ShaperSignInRouteDeps {
  service: ShaperSignInService;
  /** Told what a scan of the shapers folder found, so the service's connections in use stay current. */
  noteScan: (discovered: readonly DiscoveredShaper[]) => void;
}

/**
 * A shaper by id, among the registered shapers this build can run and then the folder's valid
 * manifests, as dispatch would find it. A registered id shadows a folder entry of the same id.
 */
async function findShaper(id: string, deps: ShaperSignInRouteDeps): Promise<Shaper | null> {
  const discovered = await discoverShapers();
  deps.noteScan(discovered);
  for (const entry of classifyShapers(getShapingConfig())) {
    if (entry.stored.id === id) return entry.kind === "known" ? entry.shaper : null;
  }
  const folder = discovered.find((entry) => entry.id === id && entry.state === "ok" && entry.shaper);
  return folder?.shaper ?? null;
}

function callbackPage(c: Context, page: { status: 200 | 400; body: string }): Response {
  return c.body(page.body, page.status, { ...SIGN_IN_PAGE_HEADERS });
}

/**
 * Shaper sign-in's three routes, behind `task-shaping` and then `shaper-sign-in`: with either off
 * each answers 404 before its handler runs. Registered from `registerShapingRoutes`, under the
 * loopback `Host` check every `/api` route has.
 *
 * - `POST /api/shaping/sign-in` `{ shaper }` starts a sign-in and answers
 *   `{ authorizationUrl, expiresAt, connection }`. The URL is the one place the OAuth `state`
 *   parameter and the client id leave the daemon.
 * - `POST /api/shaping/sign-out` `{ connection }` ends a pending or held sign-in and answers
 *   `{ signIns }`.
 * - `GET /api/shaping/sign-in/callback` is the loopback redirect URI. It hands the redirect's
 *   `state`, `code`, `error` and `iss` to the service, persists none of them, and answers a static
 *   page that shows none of them.
 */
export function registerShaperSignInRoutes(
  app: Hono,
  options: { shapingGate: MiddlewareHandler; loopbackWrite: MiddlewareHandler; deps: ShaperSignInRouteDeps },
): void {
  const { shapingGate, loopbackWrite, deps } = options;
  const signInGate = requireFeature(SHAPER_SIGN_IN_FLAG_ID);
  const limit = bodyLimit({
    maxSize: SIGN_IN_BODY_MAX_BYTES,
    onError: (c) => c.json({ error: "request_too_large", reason: "The request body is too large." }, 413),
  });

  app.post("/api/shaping/sign-in", shapingGate, signInGate, loopbackWrite, limit, async (c) => {
    const parsed = await parseBody(c, ShaperSignInRequestSchema);
    if (!parsed.ok) return c.json(INVALID_SIGN_IN_BODY, 400);
    const shaper = await findShaper(parsed.data.shaper, deps);
    // Fixed reasons: a reply repeats no value from the request or the stored definition.
    if (!shaper) return c.json({ error: "unknown_shaper", reason: "No shaper this build can run has that id." }, 404);
    const target = shaperSignInTarget(shaper);
    if (!target) return c.json({ error: "no_sign_in", reason: "That shaper does not sign in: its definition carries no auth marker." }, 400);
    const answer = await deps.service.begin(target);
    if (!answer.ok) {
      const status = OWN_REFUSALS.has(answer.code) ? 409 : answer.code === "timeout" ? 504 : 502;
      // The flow's reasons are redacted and bounded; even so they go to the log only, never the reply.
      if (status !== 409) console.warn(`[shaping] sign-in for "${shaper.id}" did not start (${answer.code}): ${answer.reason}`);
      return c.json({ error: answer.code, reason: SIGN_IN_START_FAILURES[answer.code] }, status);
    }
    const reply: ShaperSignInReply = { authorizationUrl: answer.authorizationUrl, expiresAt: answer.expiresAt, connection: answer.connection };
    return c.json(reply);
  });

  app.post("/api/shaping/sign-out", shapingGate, signInGate, loopbackWrite, limit, async (c) => {
    const parsed = await parseBody(c, ShaperSignOutRequestSchema);
    if (!parsed.ok) return c.json(INVALID_SIGN_OUT_BODY, 400);
    if (!(await deps.service.signOut(parsed.data.connection))) {
      return c.json({ error: "unknown_connection", reason: "No sign-in, pending or held, has that connection id." }, 404);
    }
    const reply: ShaperSignOutReply = { signIns: deps.service.view() };
    return c.json(reply);
  });

  app.get(SIGN_IN_CALLBACK_PATH, shapingGate, signInGate, async (c) => {
    const values: Partial<Record<(typeof CALLBACK_PARAMS)[number], string>> = {};
    for (const name of CALLBACK_PARAMS) {
      const value = c.req.query(name);
      if (value === undefined) continue;
      if (Buffer.byteLength(value, "utf8") > SIGN_IN_CALLBACK_VALUE_MAX_BYTES) return callbackPage(c, notFinishedPage("malformed"));
      values[name] = value;
    }
    // Held in the service's memory only, for the one exchange; nothing here keeps them.
    const done = await deps.service.complete({
      state: values.state ?? null, code: values.code ?? null, error: values.error ?? null, iss: values.iss ?? null,
    });
    const failure: SignInPageFailure | null = done.ok ? null : done.code;
    return callbackPage(c, failure === null ? signedInPage() : notFinishedPage(failure));
  });
}
