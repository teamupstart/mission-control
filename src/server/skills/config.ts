import { SkillsConfigSchema } from "@shared/protocol.ts";
import type { SkillsConfig, SkillsConfigPatch } from "@shared/protocol.ts";
import { getAppConfig, setAppConfig } from "../db.ts";
import { readCatalog } from "./catalog.ts";
import { reconcileSkillLinks, skillBlockers } from "./reconcile.ts";
import type { ReconcileResult } from "./reconcile.ts";

// The skills config, mirroring foreman/config.ts: a schema-validated blob over the
// `app_config` KV, so a new key needs no migration.
//
// What this file adds over that mirror is the TRANSACTION - reconcile the disk, then
// persist, and move the watermark only if the symlink set actually moved. It lives in
// one place so a caller cannot perform two of the three, and so the invariant the
// whole coalescing story rests on ("the generation moves only when the disk moves")
// has exactly one enforcement point.

const CONFIG_KEY = "skills";

/** The current config, with schema defaults applied over whatever was stored. */
export function getSkillsConfig(): SkillsConfig {
  return SkillsConfigSchema.parse(getAppConfig<unknown>(CONFIG_KEY) ?? {});
}

/**
 * Merge a patch over a config. `skills` merges PER KEY - it does not replace the map -
 * which is the one place this parts from `setForemanConfig`'s plain spread.
 *
 * Replacement would make `{skills: {"html-plans": true}}` mean "html-plans on, and
 * everything else off", so the panel would have to round-trip the whole map on every
 * click. Which sounds survivable until two dashboards are open: the second tab's
 * toggle carries a map from its last 4-second poll, and silently switches off a skill
 * the first tab just enabled across every session. A per-key merge makes concurrent
 * toggles of different skills commute, and there's nothing to lose by it - `false` and
 * absent are the same fact to `desiredSkillIds`, so nothing needs deleting.
 */
function merge(before: SkillsConfig, patch: SkillsConfigPatch): SkillsConfig {
  return SkillsConfigSchema.parse({
    ...before,
    ...patch,
    skills: { ...before.skills, ...patch.skills },
  });
}

/**
 * Merge a patch over the current config and persist it, WITHOUT reconciling. Not for
 * the route - `applySkillsConfig` is - but the tests need a way to set up a state
 * without a filesystem in the way.
 */
export function setSkillsConfig(patch: SkillsConfigPatch): SkillsConfig {
  const next = merge(getSkillsConfig(), patch);
  setAppConfig(CONFIG_KEY, next);
  return next;
}

/** Make the disk match one config. No DB writes - the caller owns those. */
function reconcileTo(cfg: SkillsConfig): ReconcileResult {
  return reconcileSkillLinks(cfg, readCatalog());
}

/** The ids whose desired state a patch actually moves. */
function touchedBy(before: SkillsConfig, asked: SkillsConfig): Set<string> {
  const ids = new Set<string>();
  // A master-switch flip changes the desired state of every enabled skill at once, so
  // it owns all of them; otherwise only the rows whose flag moved.
  if (before.enabled !== asked.enabled) {
    for (const id of Object.keys(asked.skills)) if (asked.skills[id] === true) ids.add(id);
  }
  for (const id of Object.keys(asked.skills)) {
    if (before.skills[id] !== asked.skills[id]) ids.add(id);
  }
  return ids;
}

/** A reconcile pass and the config in force after it. */
export interface SkillsSyncResult extends ReconcileResult {
  config: SkillsConfig;
  /**
   * Why THIS patch was refused, or empty when it went through. The one thing a caller
   * needs and `problems` cannot tell it.
   *
   * A reconcile pass reports on every enabled skill, not only the ones a patch moved, so
   * `problems` is routinely non-empty for reasons that have nothing to do with the
   * caller: one skill deleted from the catalog by a `git pull` makes every pass say so,
   * forever. The route used to answer 409 on any problem, which turned a toggle that had
   * fully applied - links written, generation bumped, sessions notified - into "nothing
   * changed" in the panel, reverted the switch, and then let the next poll flip it back
   * on. Every subsequent toggle wedged the same way. So refusal is its own answer, and
   * `problems` stays what it is: things the operator should know about, none of which
   * are necessarily about what they just clicked.
   */
  refused: string[];
}

/** Persist a config, bumping the watermark iff `changed` says the disk moved. */
function persist(cfg: SkillsConfig, changed: boolean, now: number): SkillsConfig {
  const next = changed ? { ...cfg, generation: cfg.generation + 1, generationAt: now } : cfg;
  setAppConfig(CONFIG_KEY, next);
  return next;
}

/**
 * Make the disk match the stored config, and move the watermark iff the disk moved.
 *
 * Safe (and intended) to call on daemon startup. The DB says which skills are on, but
 * `~/.claude/skills` is the operator's own directory and drifts under us: a link
 * deleted by hand, an app bundle that moved, a DB restored onto a fresh machine.
 * Because reconciling is idempotent the healthy case writes nothing and reloads
 * nobody, while the drifted case bumps once and every session is correctly told.
 *
 * It also closes the one crash window `applySkillsConfig` leaves open - see there.
 */
export function reconcileSkills(now = Date.now()): SkillsSyncResult {
  const cfg = getSkillsConfig();
  const result = reconcileTo(cfg);
  if (!result.changed) return { ...result, config: cfg, refused: [] };
  return { ...result, config: persist(cfg, true, now), refused: [] };
}

/**
 * The dashboard's write: refuse what can't work, then reconcile the disk, then persist.
 *
 * **Decide, then write.** A patch that cannot work is refused before anything is
 * touched, rather than written and undone. The reconcile-then-roll-back shape this
 * replaces was wrong twice over, and both ways were invisible: its undo pass also HEALED
 * unrelated drift, so the disk genuinely moved while the caller reported `changed:
 * false` and bumped nothing - leaving a skill installed that no live session would ever
 * be told to load, with no drift left for the panel to report. And after the fact
 * nothing could tell the healing apart from the undoing, so there was no fixing it in
 * place. Deciding first has no write to take back.
 *
 * **Refusal is scoped to THIS PATCH**, and the scoping is load-bearing at both layers.
 * A reconcile pass reports on every enabled skill, not just the ones that moved, so a
 * single stuck row (a skill a `git pull` deleted, someone's own `mission-beta` directory)
 * would otherwise refuse every unrelated toggle in the panel - naming a skill the
 * operator never touched. Which is why `refused` is separate from `problems`: the route
 * answers 409 on the former only. One stuck row must not wedge the whole control.
 *
 * **Reconcile before persist.** Persisting first would let a partly-applied patch leave
 * the config claiming a skill that isn't on disk, and every way of rendering that lies.
 * That leaves one crash window and it is the harmless direction - die between them and
 * the DISK is ahead of the config, which startup's `reconcileSkills` removes. The
 * opposite window is the one nothing heals, and this order does not have it.
 *
 * What is NOT pretended at is an I/O failure mid-write: it can't be predicted, so the
 * config records the operator's intent and `skillDrift` tells the panel, on every poll,
 * that the disk doesn't have it yet.
 */
export function applySkillsConfig(patch: SkillsConfigPatch, now = Date.now()): SkillsSyncResult {
  const before = getSkillsConfig();
  const asked = merge(before, patch);
  const catalog = readCatalog();

  // Only what the patch actually moves. Everything else is somebody else's problem -
  // reported by `skillDrift` on the panel, not thrown at whoever clicked next.
  const touched = touchedBy(before, asked);
  const blockers = skillBlockers(asked, catalog);
  const refused = [...touched].filter((id) => blockers.has(id)).map((id) => blockers.get(id) ?? id);
  if (refused.length > 0) {
    return { changed: false, linked: [], unlinked: [], blocked: [...touched], problems: [], config: before, refused };
  }

  const result = reconcileSkillLinks(asked, catalog);
  return { ...result, config: persist(asked, result.changed, now), refused: [] };
}
