// App-issued logical operations: one id per thing a person asked the app to do.
//
// Pure - no React, no fetch - so the panels, the API layer and the tests all mint and read the
// same thing. The id exists to answer a question neither an HTTP request nor a server event can
// answer on its own: WHICH user action caused this? One click can produce a request that is
// retried, an SSE frame that is replayed on reconnect, and a server-side fact captured minutes
// later, and without a shared id those are three unrelated records.
//
// It is deliberately NOT a request id. The app already has those - per route, in the body, for
// idempotency (`selectOption`, `submitOptions`, the workflow actions) - and they identify an
// HTTP attempt. This identifies the ATTEMPT'S PURPOSE, which is why a retry reuses it while a
// second click does not.
//
// And it is attribution, never authority. The daemon records what these headers say alongside a
// `basis` that says how much it is worth, and no authorization decision anywhere reads them.
// See `resolveOperationContext` in `@shared/telemetry-ingress.ts`, which is where that is
// enforced rather than merely promised.

import {
  OPERATION_ACTOR_HEADER,
  OPERATION_ID_HEADER,
  OPERATION_SURFACE_HEADER,
  type TelemetryOperationSurface,
} from "@shared/telemetry-ingress.ts";

/**
 * One logical operation.
 *
 * A value the caller holds, not a module slot the caller reads back. A shared "current
 * operation" would make one panel's id depend on whether another panel started something in
 * between - the same race the daemon's capture result avoids by returning its correlation
 * rather than parking it.
 */
export interface AppOperation {
  id: string;
  surface: TelemetryOperationSurface;
  /** The headers to attach. A plain object so it merges into any `RequestInit`. */
  headers: Record<string, string>;
}

/**
 * Mint one.
 *
 * `crypto.randomUUID` with the dashes stripped, cut to 32 characters: the daemon's pattern
 * admits 8-32 lowercase alphanumerics, and anything outside it is dropped rather than
 * truncated, so the format is pinned here rather than assumed. The fallback covers a browser
 * without `randomUUID` on an insecure origin, which is a real state for a daemon reached over
 * plain HTTP on a LAN address.
 */
export function beginOperation(surface: TelemetryOperationSurface): AppOperation {
  const id = mintId();
  return {
    id,
    surface,
    headers: {
      [OPERATION_ID_HEADER]: id,
      [OPERATION_SURFACE_HEADER]: surface,
      // What the app believes. The daemon decides what that is worth - a well-formed operation
      // from a known surface earns `app_context`, and this header alone earns `declared`.
      [OPERATION_ACTOR_HEADER]: "human",
    },
  };
}

function mintId(): string {
  const random = globalThis.crypto;
  if (random && typeof random.randomUUID === "function") {
    return random.randomUUID().replace(/-/g, "").slice(0, 32);
  }
  let out = "";
  while (out.length < 32) out += Math.random().toString(36).slice(2);
  return out.slice(0, 32);
}
