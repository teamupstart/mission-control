import { persistConfigPatch } from "../config-patch-storage.ts";
import { getAppConfig, hasAppConfig } from "../db.ts";
import { ShippingConfigSchema } from "@shared/protocol.ts";
import type { ShippingConfig, ShippingConfigPatch } from "@shared/protocol.ts";
import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import { repoAllowlisted } from "@shared/allowlist.ts";

// YOLO mode's config: a schema-validated blob over the `app_config` KV, exactly like the
// Inspector's next door, so a new key needs no migration - Zod's defaults are applied on
// every read, and a blob written by an older build gains new fields for free.
//
// Its own key rather than a section of the Inspector's, because it is its own grant. See
// `ShippingConfigSchema`: "you may comment here" and "you may merge here" are different
// permissions, and a shared blob is how one of them ends up implying the other.

const CONFIG_ENTRY = APP_CONFIG_ENTRIES.shipping;

/** The current config, with schema defaults applied over whatever was stored. */
export function getShippingConfig(): ShippingConfig {
  return ShippingConfigSchema.parse(getAppConfig(CONFIG_ENTRY) ?? {});
}

/** Merge a patch over the current config, persist, and return the result. */
export function setShippingConfig(patch: ShippingConfigPatch): ShippingConfig {
  const current = getShippingConfig();
  const next = ShippingConfigSchema.parse({ ...current, ...patch });
  persistConfigPatch(CONFIG_ENTRY, current, next, patch);
  return next;
}

/** An unavailable or malformed setting cannot authorize observation or delivery. */
export function codeRabbitEnabled(): boolean {
  try { return getShippingConfig().codeRabbitAutoResolve; } catch { return false; }
}

/**
 * Whether this repository holds the merge grant: it is on Shipping's own allowlist, whether
 * or not YOLO mode is armed right now.
 *
 * Fails closed, deliberately. An absent setting is the empty allowlist, as everywhere else. A
 * stored setting that cannot be read - JSON that does not parse, a shape the schema refuses, a
 * database error - reads as holding the grant, which keeps the GitHub review: the direction that
 * never leaves a head without merge provenance. `getAppConfig` reports unparseable JSON as
 * absent, so the stored row is checked separately rather than letting a corrupt value default to
 * an empty allowlist.
 */
export function repositoryHoldsMergeGrant(cwd: string | null, repoRoot: string | null): boolean {
  try {
    const stored = getAppConfig(CONFIG_ENTRY);
    if (stored === undefined && hasAppConfig(CONFIG_ENTRY)) return true;
    return repoAllowlisted(cwd, repoRoot, ShippingConfigSchema.parse(stored ?? {}).repoAllowlist);
  } catch {
    return true;
  }
}
