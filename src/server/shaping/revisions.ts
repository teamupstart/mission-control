import { createHmac, randomBytes } from "node:crypto";
import { canonicalJson, shapingConfigView, type ShapingConfig, type ShapingConfigView, type ShapingReviser } from "@shared/shaping.ts";
import { DAEMON_SHAPING_INSTANCE } from "./write-order.ts";

/**
 * The key revisions are derived with. Random per daemon process and never written anywhere, so
 * a revision can be compared but never recomputed outside the daemon: it cannot confirm a guess
 * at a field the view hides, such as one an unsupported entry restored from a snapshot still
 * holds. A restart changes every revision, which only refuses an intent sent across the restart,
 * as `stale_dashboard` since the restarted daemon never issued it;
 * the reconnecting dashboard receives the new ones with its snapshot.
 */
const KEY = randomBytes(32);

/**
 * Each stored id's generation in this daemon process. Content alone cannot tell a definition from
 * the same definition stored again after a replacement, so a write held since the first could pass
 * once the original is imported again. The generation advances whenever what is stored under an
 * id changes, by any writer, and on every import or removal of it, identical content included,
 * and it is part of every revision: no later state of an id ever has an earlier one's revision.
 *
 * Generations come from one counter for the whole process, which only grows, so the map need hold
 * only the ids stored now: an id removed and stored again later takes the counter's next value,
 * which no earlier state of it ever had. An id never advanced since the daemon started is at 0,
 * a value the counter never hands out.
 */
const generations = new Map<string, number>();
let lastGeneration = 0;

/** Advance `id`'s generation: an import or removal of it, which a revision issued before must not survive. */
export function advanceShapingGeneration(id: string): void {
  generations.set(id, ++lastGeneration);
}

/**
 * Advance the generation of every id whose stored entries differ between `before` and `after`,
 * and forget the ids `after` no longer stores, so the map stays the size of the stored list.
 */
export function noteShapingEntriesChanged(before: ShapingConfig, after: ShapingConfig): void {
  const byId = (config: ShapingConfig): Map<string, string> => {
    const groups = new Map<string, unknown[]>();
    for (const entry of config.shapers) groups.set(entry.id, [...(groups.get(entry.id) ?? []), entry]);
    return new Map([...groups].map(([id, entries]) => [id, canonicalJson(entries)]));
  };
  const was = byId(before);
  const now = byId(after);
  for (const id of new Set([...was.keys(), ...now.keys()])) {
    if (!now.has(id)) generations.delete(id);
    else if (was.get(id) !== now.get(id)) advanceShapingGeneration(id);
  }
  for (const id of generations.keys()) if (!now.has(id)) generations.delete(id);
}

/** How many ids this process holds a generation for: never more than the ids stored now. For tests. */
export function trackedShapingGenerations(): number {
  return generations.size;
}

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
  const generation = entries.length > 0 ? generations.get(entries[0]!.id) ?? 0 : 0;
  const revision = createHmac("sha256", KEY).update(canonicalJson({ generation, entries })).digest("hex").slice(0, 16);
  issued.delete(revision);
  issued.add(revision);
  if (issued.size > ISSUED_KEPT) issued.delete(issued.values().next().value!);
  return revision;
};

/**
 * Each committed config's view, taken as it was committed. Listeners run after the commit, and one
 * of them can write again before the next runs, advancing a generation: a view derived at delivery
 * would then give the first config the second write's revision.
 */
const committedViews = new WeakMap<ShapingConfig, ShapingConfigView>();

/**
 * How many commits that changed what a view shows this process has made. Each such commit's view
 * carries the count as it stood then, so a window holding a write's answer can tell whether the
 * stream has reached that commit yet, whatever other writers committed in between.
 */
let lastCommit = 0;

/**
 * Take `config`'s view now, as it is committed, for every reader of that config to see. `advanced`
 * when the commit changed what the view shows, revisions included: it then takes the next commit
 * number. A commit that restated the same config keeps the number of the one before.
 */
export function captureShapingView(config: ShapingConfig, advanced: boolean): void {
  if (advanced) lastCommit += 1;
  committedViews.set(config, published(shapingConfigView(config, shapingReviser)));
}

/** A view as this daemon process publishes it: naming the process and the commit, for write ordering. */
function published(view: ShapingConfigView): ShapingConfigView {
  return { ...view, instance: DAEMON_SHAPING_INSTANCE, commit: lastCommit };
}

/**
 * The config view as the daemon publishes it: with revisions derived by `shapingReviser`, as they
 * were when `config` was committed when it was, otherwise as they are now.
 */
export function daemonShapingView(config: ShapingConfig): ShapingConfigView {
  return committedViews.get(config) ?? published(shapingConfigView(config, shapingReviser));
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
