import type { Context } from "hono";

/** The common safeParse result keeps Zod 3 and patched Zod 4 contracts typed at this boundary. */
interface BodySchema<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: { message: string } };
}

/**
 * Parse + validate a JSON request body against a schema. Returns the typed data,
 * or a ready-to-return 400 response - collapsing the safeParse/400 boilerplate
 * every write endpoint otherwise repeats.
 */
// `error` is carried alongside the ready-made `res` so a route with extra facts to
// report on a refusal can build its own body without re-reading this one's. /inject
// is that route: its contract is that EVERY refusal states whether text was pasted.
export async function parseBody<T>(
  c: Context,
  schema: BodySchema<T>,
): Promise<{ ok: true; data: T } | { ok: false; error: string; res: Response }> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return { ok: false, error: parsed.error.message, res: c.json({ error: parsed.error.message }, 400) };
  }
  return { ok: true, data: parsed.data };
}
