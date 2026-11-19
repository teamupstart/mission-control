import { HEADLESS_MODE_FLAG_ID, homeDispatchRouteLabel, type HomeDispatchRoute } from "@shared/home-dispatch.ts";

/** What a route handler hands back to `routes.ts`: a status and a JSON body. */
export interface HomeDispatchResult<T = unknown> {
  status: 200 | 400 | 403 | 404 | 409 | 501;
  /** Error bodies are `{ error }`; a stub also carries `feature`, `route` and `owner` (`HomeDispatchNotImplementedSchema`). */
  body: T | ({ error: string } & Record<string, unknown>);
}

/**
 * The seam a later work package replaces. Every handler module exports one function per
 * route and answers with this until its owner lands the real behavior. The shape of a
 * handler's input and output is the contract (spec 8.1 rule 1): replace the body, never the signature.
 */
export function notImplemented(route: HomeDispatchRoute, owner: string): HomeDispatchResult<never> {
  return {
    status: 501,
    body: { error: "not implemented", feature: HEADLESS_MODE_FLAG_ID, route: homeDispatchRouteLabel(route), owner },
  };
}
