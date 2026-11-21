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
 * Revisions this daemon process has issued, most recent last, so a refusal can tell a revision
 * that is merely stale from one the daemon never issued. Bounded: an issued revision is 16
 * characters, and only one far older than the last few thousand issued is ever forgotten, which
 * then reads as never issued and gets the reload guidance below, the safe side to err on.
 */
const issued = new Set<string>();
const ISSUED_KEPT = 4096;

/**
 * The daemon's revision of everything stored under one id: an HMAC-SHA256 over the entries'
 * canonical JSON in stored order, cut to the 16 hex digits `ShapingRevisionSchema` carries. Any
 * change to what is stored under the id, a field the view never shows or a repeat included,
 * changes it.
 */
export const shapingReviser: ShapingReviser = (entries) => {
  const revision = createHmac("sha256", KEY).update(canonicalJson(entries)).digest("hex").slice(0, 16);
  issued.delete(revision);
  issued.add(revision);
  if (issued.size > ISSUED_KEPT) issued.delete(issued.values().next().value!);
  return revision;
};

/** The config view as the daemon publishes it: with revisions derived by `shapingReviser`. */
export function daemonShapingView(config: ShapingConfig): ShapingConfigView {
  return shapingConfigView(config, shapingReviser);
}

/**
 * Whether this daemon process ever issued `revision`. One it did not issue cannot come from a
 * dashboard tab that read this daemon's views: a tab loaded from an earlier version of Mission
 * Control computes revisions of its own, of whatever definition it showed, and a tab's request
 * can outlive a daemon restart, which changes the key. Retrying from that tab cannot succeed,
 * so the routes tell it to reload instead of answering `shaper_changed`, which asks it to review
 * and retry.
 */
export function issuedByThisDaemon(revision: string): boolean {
  return issued.has(revision);
}

/** The refusal for a revision this daemon never issued, which the sending tab shows as written. */
export const UNISSUED_REVISION_REFUSAL = {
  error: "stale_dashboard",
  reason: "This dashboard tab sent a revision this daemon never issued, as a tab loaded from an earlier version of Mission Control or open across a daemon restart does. Reload the page, then make the change again.",
} as const;
