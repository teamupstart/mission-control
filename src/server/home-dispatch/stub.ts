import type { Context, Handler } from "hono";
import type { RouteDeps } from "../routes.ts";

/**
 * What every `/dispatch/*` module receives. It is the daemon's whole route dependency
 * object, so a phase that fills a stub reaches the registry, reviews, tasks or residents
 * without `routes.ts` changing.
 */
export type HomeDispatchDeps = RouteDeps;

/** Builds one route's handler. A later phase replaces the body and keeps this signature. */
export type HomeDispatchHandler = (deps: HomeDispatchDeps) => Handler;

/** The body every stub answers while the flag is on, until the phase that owns the route lands. */
export const NOT_IMPLEMENTED_BODY = { error: "not implemented", feature: "headless-mode" } as const;

/** A stub handler: 501 with a fixed body. A later phase replaces the call, not the signature. */
export function notImplemented(): Handler {
  return (c: Context) => c.json(NOT_IMPLEMENTED_BODY, 501);
}
