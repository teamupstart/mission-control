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
