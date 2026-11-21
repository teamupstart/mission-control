import { createHmac, randomBytes } from "node:crypto";
import { canonicalJson, shapingConfigView, type ShapingConfig, type ShapingConfigView, type ShapingReviser } from "@shared/shaping.ts";

/**
 * The key revisions are derived with. Random per daemon process and never written anywhere, so
 * a revision can be compared but never recomputed outside the daemon: it cannot confirm a guess
 * at a field the view hides, such as one an unsupported entry restored from a snapshot still
 * holds. A restart changes every revision, which only refuses an intent sent across the restart;
 * the reconnecting dashboard receives the new ones with its snapshot.
 */
const KEY = randomBytes(32);

/**
 * The daemon's revision of everything stored under one id: an HMAC-SHA256 over the entries'
 * canonical JSON in stored order, cut to the 16 hex digits `ShapingRevisionSchema` carries. Any
 * change to what is stored under the id, a field the view never shows or a repeat included,
 * changes it.
 */
export const shapingReviser: ShapingReviser = (entries) =>
  createHmac("sha256", KEY).update(canonicalJson(entries)).digest("hex").slice(0, 16);

/** The config view as the daemon publishes it: with revisions derived by `shapingReviser`. */
export function daemonShapingView(config: ShapingConfig): ShapingConfigView {
  return shapingConfigView(config, shapingReviser);
}

/**
 * Whether `expect` is a revision a dashboard from before daemon-held revisions would send for
 * `id`. Such a tab, left open across an upgrade, computes every revision itself, as an unkeyed
 * FNV-1a over the entry the view shows, and never reads `revisions`: retrying cannot help it,
 * so the routes tell it to reload instead of answering `shaper_changed` for ever. It never
 * matches a revision this daemon issued, so it cannot pass a check. A compatibility shim for
 * the task-shaping preview: remove it once no dashboard that old can still be open.
 */
export function sentByEarlierDashboard(config: ShapingConfig, id: string, expect: string): boolean {
  return shapingConfigView(config, shapingReviser).shapers
    .filter((entry) => entry.id === id)
    .some((entry) => earlierProjections(entry).some((shown) => earlierDashboardRevision(shown) === expect));
}

/**
 * Every shape an earlier dashboard may have hashed an entry in: as the view shows it now, and as
 * it showed it before unsupported entries carried `replaceable`, which a tab loaded then kept.
 */
function earlierProjections(entry: object): object[] {
  if (!("replaceable" in entry)) return [entry];
  const { replaceable: _added, ...before } = entry as { replaceable?: unknown };
  return [entry, before];
}

/** The revision an earlier dashboard computed for a view entry: FNV-1a 64 over its canonical JSON. */
function earlierDashboardRevision(entry: unknown): string {
  const text = canonicalJson(entry);
  let hash = 0xcbf29ce484222325n;
  for (let at = 0; at < text.length; at++) {
    hash ^= BigInt(text.charCodeAt(at));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

/** The refusal a dashboard from before daemon-held revisions receives, which it shows as written. */
export const EARLIER_DASHBOARD_REFUSAL = {
  error: "stale_dashboard",
  reason: "This dashboard tab was loaded from an earlier version of Mission Control. Reload the page, then make the change again.",
} as const;
