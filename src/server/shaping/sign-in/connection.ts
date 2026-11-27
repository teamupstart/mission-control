import { createHash } from "node:crypto";
import { canonicalJson, type SignInTarget } from "@shared/shaping.ts";

/**
 * The id of the connection a target names: the first 32 hex characters of the SHA-256 of the
 * target's canonical JSON. One sign-in per id, so two shapers that name the same URL, scope
 * and issuer share one. A one-way hash: the stored record keeps the target beside the tokens,
 * so a sign-in is still named after a restart when no shaper names it any more.
 */
export function connectionId(target: SignInTarget): string {
  const canonical = canonicalJson({ url: target.url, scope: target.scope, issuer: target.issuer });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}
