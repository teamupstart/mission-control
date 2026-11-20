import type { Context } from "hono";
import type { TypeOf, ZodTypeAny } from "zod";

/**
 * Parse + validate a JSON request body against a schema. Returns the typed data,
 * or a ready-to-return 400 response - collapsing the safeParse/400 boilerplate
 * every write endpoint otherwise repeats.
 */
// `error` is carried alongside the ready-made `res` so a route with extra facts to
// report on a refusal can build its own body without re-reading this one's. /inject
// is that route: its contract is that EVERY refusal states whether text was pasted.
export async function parseBody<S extends ZodTypeAny>(
  c: Context,
  schema: S,
  /**
   * `strict`: a body that is present but is not JSON is refused with a 400, instead of being
   * read as `{}`. For a route whose defaults DO something - a pause's `{}` freezes now, Pause
   * all's holds launches - a garbled request must not quietly become the default action. An
   * absent or empty body still reads as `{}`.
   */
  options: { strict?: boolean } = {},
): Promise<{ ok: true; data: TypeOf<S> } | { ok: false; error: string; res: Response }> {
  let raw: unknown = {};
  if (options.strict) {
    let text: string;
    try {
      text = await c.req.text();
    } catch {
      // Not the same as an empty body: a body that could not be read must not become `{}`.
      const error = "the request body could not be read";
      return { ok: false, error, res: c.json({ error }, 400) };
    }
    if (text.trim() !== "") {
      try {
        raw = JSON.parse(text);
      } catch {
        const error = "the request body is not valid JSON";
        return { ok: false, error, res: c.json({ error }, 400) };
      }
    }
  } else {
    raw = await c.req.json().catch(() => ({}));
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.message, res: c.json({ error: parsed.error.message }, 400) };
  }
  return { ok: true, data: parsed.data };
}

/** True when the Host header names a loopback address (defeats DNS-rebinding). */
export function hostIsLoopback(host: string | undefined): boolean {
  if (!host) return false;
  // Strip a trailing :port and any [] IPv6 brackets, then match loopback names.
  const h = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

/** Guard browser-write routes that accept an otherwise empty JSON object. */
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
