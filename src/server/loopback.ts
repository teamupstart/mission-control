import type { Context } from "hono";

/** True when the Host header names a loopback address (defeats DNS-rebinding). */
export function hostIsLoopback(host: string | undefined): boolean {
  if (!host) return false;
  // Strip a trailing :port and any [] IPv6 brackets, then match loopback names.
  const h = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

/**
 * Guard for browser-write routes: the body is declared JSON and any `Origin` is a loopback http
 * origin. A page on another site can still reach 127.0.0.1 with a loopback `Host`, but only with a
 * simple request - `text/plain` and its own origin - so this refuses it before the body is read.
 */
export function trustedLoopbackJsonRequest(c: Context): boolean {
  if (c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return false;
  }
  const origin = c.req.header("origin");
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.origin === origin && url.protocol === "http:" && hostIsLoopback(url.hostname);
  } catch {
    return false;
  }
}
