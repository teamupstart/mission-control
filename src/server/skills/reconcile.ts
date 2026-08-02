import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { SkillsConfig } from "@shared/protocol.ts";
import { envVar } from "@shared/harness-runtime.mjs";
import { CLAUDE_SKILLS, HARNESS_CAPABILITIES } from "@shared/harness-capabilities.ts";
import type { SkillsSpec } from "@shared/harness-capabilities.ts";
import { AGENT_TYPES } from "@shared/types.ts";
import { SKILL_DIR_PREFIXES, missionSkillDirName, skillIdFromDirName } from "@shared/skills.ts";
import { skillSourceDir } from "./catalog.ts";
import type { Catalog } from "./catalog.ts";

// Sync `~/.claude/skills/mission-<id>` against the enabled set.
//
// This writes into the operator's GLOBAL claude config - the same discipline
// hooks/install.mjs holds itself to, and for a stronger reason: install.mjs only
// ever changed telemetry, while this changes what the model does. The rules it
// copies are the marker match, idempotence, and a real uninstall.
//
// Symlinks rather than copies because a symlink has no drift: the file Claude reads
// IS the file in the repo, so a catalog edit lands on `git pull` with no
// reconciliation, no content hash, and no way for the two to disagree. Verified
// against claude 2.1.211: symlinked skill directories load, targets under both
// /private/tmp and ~/workspace included.

/**
 * Where a harness's skills live, given its `skills` capability.
 *
 * `~/.claude/skills` for an ordinary claude install - the operator's global claude
 * config, which is the whole point of the feature. But a daemon running on an explicit
 * home override (`MISSION_HOME`, or the older prefixes `envVar` still reads) gets a
 * directory inside that home instead, because it does not own the machine's shared one.
 *
 * That scoping is not tidiness, it is the fix for real data loss. Which skills are on
 * lives in the DB, and the DB lives under the state dir - so an isolated daemon has its
 * OWN, usually empty, config. Pointed at the shared directory it would reconcile the real
 * install's symlinks against that empty config, decide every one of them is no longer
 * desired, and unlink them: observed for real, an isolated test daemon removing the live
 * install's `mission-html-plans`. Nothing announces it, the operator's next session just
 * quietly stops loading the skill, and `startup` runs this on every single launch - so
 * merely running a second daemon, which the test suite and any E2E harness do routinely,
 * silently uninstalls skills. The config and the directory it reconciles have to come from
 * the same home or the pass is comparing two unrelated installs.
 *
 * The same rule `migrateStateDir` already holds: an explicit override owns its own path.
 * The cost is that an isolated daemon's links land where no real `claude` will read them,
 * which is correct - a throwaway home has no business installing skills machine-wide.
 * The spec's `dirEnvVar` still wins over both, so a test (or an operator) that genuinely
 * wants a specific directory names it and gets it.
 */
export function skillsDirFor(spec: SkillsSpec): string {
  const named = process.env[spec.dirEnvVar];
  if (named) return named;
  const home = envVar("HOME");
  if (home) return join(home, spec.isolatedDirName);
  return join(homedir(), ...spec.homeDir);
}

/**
 * The skills directory THIS daemon owns.
 *
 * Named directly rather than reached through `capabilitiesFor("claude")` so the path
 * needs no null check on a capability that is, by construction, present.
 */
export function claudeSkillsDir(): string {
  return skillsDirFor(CLAUDE_SKILLS);
}

/**
 * EVERY skills directory this daemon owns - one per harness that declares a `skills`
 * capability, de-duplicated.
 *
 * This is the loop the single-directory version said would be needed "when a second
 * harness declares `skills`". Codex is that second harness, and it declares
 * `~/.agents/skills`. Until this existed the declaration was inert: `skillsDirFor` had one
 * caller, `claudeSkillsDir`, so every reconcile, blocker, drift and uninstall path walked
 * Claude's directory alone and no skill was ever linked where Codex would read it.
 *
 * NOT `skillsAgents()`, which is a different question. That one asks who the pane reload
 * broadcast is about and so filters on `reloadCommand`, which Codex has no need of - it
 * watches its directory itself. Installing a skill and nudging a running session to notice
 * are two capabilities, and reusing one selector for both is how Codex ends up with the
 * nudge it does not need and none of the skills it does.
 *
 * De-duplicated because `dirEnvVar` is per-harness but nothing stops two of them being
 * pointed at one path: reconciling the same directory twice would have the second pass
 * re-decide the first's writes, and report every link a second time.
 */
export function skillsDirs(): string[] {
  const seen = new Set<string>();
  for (const agent of AGENT_TYPES) {
    const spec = HARNESS_CAPABILITIES[agent].skills;
    if (spec) seen.add(skillsDirFor(spec));
  }
  return [...seen];
}

/**
 * Every path this daemon would WRITE to if nothing redirected it - one per harness,
 * under the operator's actual home.
 *
 * Not `skillsDirs()`, which answers "where do we write?" and honours every override.
 * This one answers the different question `assertTestSkillIsolation` needs: "which
 * paths are the machine's live install?" - so it deliberately ignores `dirEnvVar` and
 * `MISSION_HOME` and reads `homeDir` alone.
 */
function operatorSkillsDirs(): string[] {
  const out: string[] = [];
  for (const agent of AGENT_TYPES) {
    const spec = HARNESS_CAPABILITIES[agent].skills;
    if (spec) out.push(join(homedir(), ...spec.homeDir));
  }
  return out;
}

/**
 * One directory, spelled the single way the FILESYSTEM would spell it.
 *
 * `assertTestSkillIsolation` compares paths to decide whether a walk may proceed, and a
 * raw string comparison answers a question nobody asked: not "is this the operator's live
 * directory?" but "is this the same sequence of characters?". Those come apart constantly
 * and always in the unsafe direction - a trailing slash, a `..` segment, `TMPDIR` on macOS
 * living under `/var -> /private/var`, or a fixture that symlinks a scratch path at a real
 * one. Each spells the same directory differently, and each was enough to walk straight
 * past the guard and unlink the operator's live skills. Verified, both shapes, before this
 * existed.
 *
 * `resolve` fixes the spelling; `realpathSync` fixes the symlinks, which is the half that
 * matters, because a symlink makes two genuinely different paths one directory and no
 * amount of string normalisation will ever see it.
 *
 * The walk up is for the path that does not exist yet. `realpathSync` throws on a missing
 * leaf, and reconciling a directory we are about to `mkdir` is the ordinary case, not an
 * edge one - so this resolves the deepest ancestor that DOES exist and re-appends the rest.
 * That is not pedantry: the symlink that redirects a scratch path into a real skills
 * directory lives in the parent chain, which is exactly the part that exists.
 */
function canonical(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...tail);
    } catch {
      const parent = dirname(head);
      // The root, and nothing along the way existed. Every symlink that could have been
      // followed has been; the resolved spelling is the best answer available.
      if (parent === head) return join(head, ...tail);
      tail.unshift(basename(head));
      head = parent;
    }
  }
}

/**
 * `dev:ino` for a directory that exists, or null when nothing is there to identify.
 *
 * `statSync` and not `lstatSync`: a symlink AT the path is a way of naming the directory
 * it points at, and naming it is what the guard is trying to catch.
 */
function directoryIdentity(path: string): string | null {
  const stat = statSync(path, { throwIfNoEntry: false });
  return stat ? `${stat.dev}:${stat.ino}` : null;
}

/**
 * Whether two paths name the SAME directory - asked of the filesystem, not of the strings.
 *
 * `canonical` above gets the spellings and the symlinks, and that is most of it, but it
 * still cannot answer case. `~/.AGENTS/skills` is the operator's live directory on macOS's
 * default case-insensitive APFS and a different directory on ext4, and `realpath` on macOS
 * reports back the casing it was handed - so a string comparison silently allows the walk on
 * exactly the machine most operators run. Verified: that spelling deleted a live link.
 *
 * Case-folding the comparison would trade a real deletion on macOS for a phantom refusal on
 * Linux, and both answers would be a guess about a filesystem this code cannot see. The
 * inode pair is not a guess: two paths are the same directory when the filesystem says they
 * are, on every platform, and it settles hard links and bind mounts in the same breath.
 *
 * Identity needs both paths to EXIST, which is why it is the first answer and not the only
 * one. A directory a reconcile is about to create has no inode yet, and creating one in the
 * operator's home is its own kind of wrong, so the canonical spellings decide that case.
 */
function sameDirectory(a: string, b: string): boolean {
  const idA = directoryIdentity(a);
  const idB = directoryIdentity(b);
  if (idA !== null && idB !== null) return idA === idB;
  return canonical(a) === canonical(b);
}

/**
 * Refuse to reconcile the operator's real skills directory from inside the test runner.
 *
 * `openDb`'s `assertTestStateIsolation`, for the other half of this app's blast radius,
 * and for the same reason: a test file that reaches a real home directory fails SILENTLY
 * into it. This one has been exercised. `install-hooks.test.ts` pinned `CLAUDE_SKILLS_DIR`
 * and nothing else, which was total isolation on the day it was written - Claude was the
 * only harness with a `skills` spec. Codex and pi then declared theirs, `uninstallSkillLinks`
 * began folding over `skillsDirs()`, and that one pinned variable stopped covering the
 * walk. From then on every `npm run test` unlinked the operator's live `mission-*` skills
 * out of `~/.agents/skills` and `~/.pi/agent/skills` and reported sixteen passing tests.
 *
 * Nothing announced it. The panel went on drawing three switched-on toggles, and the next
 * Codex session to reach a workflow's Pull Request action was refused with
 * `required_skill_unavailable` for a skill the operator had never switched off. Agents run
 * the suite before every PR, so it happened again on the next run.
 *
 * A deny-list of the REAL paths rather than an allow-list of isolated ones, so a test that
 * hands over its own temp directory needs no ceremony, and so a fourth harness is covered
 * by declaring `homeDir` - the same declaration that puts it in harm's way. Throwing rather
 * than skipping the directory, because a quiet skip is how this arrived: the walk has to
 * stop being possible, not merely stop being harmful.
 *
 * `sameDirectory` and not `===`, because a deny-list is only ever as good as its ability to
 * recognise what it is denying. The first cut compared raw strings, which is a guard against
 * one spelling rather than against one directory: a trailing slash, a symlinked scratch path,
 * and a case variant on APFS each walked past it and took the operator's live links with
 * them. All three are pinned in `skills-multi-harness.test.ts`.
 */
function assertTestSkillIsolation(dir: string): void {
  // First, so production pays nothing for the stat and realpath calls below - a live daemon
  // reconciles the operator's real directory on every start, which is the point.
  if (!process.env.NODE_TEST_CONTEXT) return;
  if (!operatorSkillsDirs().some((real) => sameDirectory(real, dir))) return;
  const pins = AGENT_TYPES.map((agent) => HARNESS_CAPABILITIES[agent].skills?.dirEnvVar)
    .filter((name): name is string => name !== undefined);
  throw new Error(
    `refusing to reconcile ${dir} under the test runner: this is the machine's real skills `
      + "directory, and a pass over it uninstalls the operator's live skills from every "
      + "session on the machine. Set MISSION_HOME to a fresh temp dir, which isolates every "
      + `harness at once, or pin all of ${pins.join(", ")} - see skills-multi-harness.test.ts `
      + "for the pattern.",
  );
}

/** What one pass changed, and anything it refused to. */
export interface ReconcileResult {
  /**
   * Whether the symlink SET actually moved, as Claude would see it. The generation
   * bump hangs off this and nothing else: bumping on any config write would reload
   * every session because someone toggled the master switch twice.
   */
  changed: boolean;
  linked: string[];
  unlinked: string[];
  /** What we would not do, and why. In the operator's words - these reach the panel. */
  problems: string[];
  /**
   * The ids we could not put in the state the config asked for. Separate from
   * `problems` because a caller has to be able to ask "did MY change fail?" without
   * matching on prose - see `applySkillsConfig`, where the answer decides whether a
   * patch is rolled back.
   */
  blocked: string[];
}

/**
 * The catalog ids that should be symlinked in, given the config.
 *
 * Takes the directories that EXIST (`catalog.present`), not the ones we could parse.
 * The difference is the whole finding: an id absent from the parsed catalog has two
 * completely different causes - the skill was deleted from the repo, or its SKILL.md
 * defeated our deliberately narrow frontmatter reader - and only the first is a reason
 * to unlink anything. Treating the second as a deletion silently uninstalls a working
 * skill from every Claude on the machine, and broadcasts a reload so they all drop it
 * at once, over a formatting edit. Absence of evidence is not evidence.
 *
 * The master switch resolves HERE rather than at the call site, so "off" is expressed
 * as an empty desired set and takes the ordinary removal path. That is what makes
 * disabling propagate: the set changes, the generation bumps, and every session is told
 * to drop the skills. A master switch that skipped the reconciler instead would leave
 * the symlinks on disk and every session still using skills the panel says are off.
 */
export function desiredSkillIds(cfg: SkillsConfig, present: ReadonlySet<string>): Set<string> {
  if (!cfg.enabled) return new Set();
  return new Set(Object.keys(cfg.skills).filter((id) => cfg.skills[id] === true && present.has(id)));
}

/** How an existing `~/.claude/skills` entry stands relative to what we want. */
type Entry = { kind: "ours"; target: string } | { kind: "foreign" };

/**
 * Classify one entry we hold the marker on.
 *
 * A prefixed entry that is NOT a symlink was not created by us - nothing here has
 * ever made a real directory - so it is the operator's, prefix or no prefix, and we
 * do not remove it. The marker scopes what we may touch; it does not license deleting
 * a directory of someone's work because the name matched. Marker discipline that only
 * holds when the name is the only evidence is not discipline.
 */
function classify(path: string): Entry {
  try {
    if (!lstatSync(path).isSymbolicLink()) return { kind: "foreign" };
    return { kind: "ours", target: readlinkSync(path) };
  } catch {
    // Vanished between readdir and lstat, or unreadable. Treat as foreign: the one
    // thing we must never do on an unclear answer is delete.
    return { kind: "foreign" };
  }
}

/**
 * Make every harness's skills directory match the enabled set, touching nothing else.
 *
 * The fold over `skillsDirs()`; `reconcileOneDir` below is the walk over one of them.
 * Split that way because the walk is where all the care lives (what is ours, what is
 * foreign, what an unreadable directory means) and none of it should be written twice
 * per harness. `changed` is the OR - one directory moving is enough to owe a reload -
 * and the reported ids are unioned, because "linked alpha" is one fact about the fleet
 * however many directories it took.
 */
export function reconcileSkillLinks(
  cfg: SkillsConfig,
  catalog: Catalog,
  dirs: string[] = skillsDirs(),
): ReconcileResult {
  const out: ReconcileResult = { changed: false, linked: [], unlinked: [], problems: [], blocked: [] };
  for (const dir of dirs) {
    const one = reconcileOneDir(cfg, catalog, dir);
    out.changed ||= one.changed;
    for (const id of one.linked) if (!out.linked.includes(id)) out.linked.push(id);
    for (const id of one.unlinked) if (!out.unlinked.includes(id)) out.unlinked.push(id);
    for (const id of one.blocked) if (!out.blocked.includes(id)) out.blocked.push(id);
    // Problems are NOT de-duplicated by id: they name a path, so two harnesses failing
    // for the same reason are two things the operator has to go and fix.
    for (const p of one.problems) if (!out.problems.includes(p)) out.problems.push(p);
  }
  return out;
}

/** One directory's walk. See `reconcileSkillLinks`, which folds this over every harness. */
function reconcileOneDir(
  cfg: SkillsConfig,
  catalog: Catalog,
  dir: string,
): ReconcileResult {
  // Before anything is read, and long before anything is written: from here on this
  // function only ever decides what to unlink.
  assertTestSkillIsolation(dir);
  const out: ReconcileResult = { changed: false, linked: [], unlinked: [], problems: [], blocked: [] };

  // An unreadable catalog is not an empty one. Every id would look deleted, and this
  // function's answer to a deleted id is to unlink it - so a transient read failure
  // (a worktree without `skills/`, a permissions hiccup, a packaged path that resolved
  // wrong) would uninstall every skill on the machine and tell every session to drop
  // them. We know nothing, so we change nothing.
  //
  // `cfg.enabled &&` is the whole guard, not decoration: with the master switch OFF the
  // desired set is empty NO MATTER what the catalog says, so the removal needs no
  // knowledge and is safe. Refusing here regardless would make an unreadable catalog
  // wedge the master switch ON - the operator could not turn the feature off at exactly
  // the moment they most want to.
  if (cfg.enabled && !catalog.readable) {
    out.problems.push(...catalog.problems);
    out.blocked.push(...Object.keys(cfg.skills).filter((id) => cfg.skills[id] === true));
    return out;
  }

  const desired = desiredSkillIds(cfg, catalog.present);
  // Enabled, but its directory is gone from the repo. The link is correctly removed
  // above; this makes the panel say so rather than leaving a toggle that looks on.
  for (const id of Object.keys(cfg.skills)) {
    if (cfg.enabled && cfg.skills[id] === true && !catalog.present.has(id)) {
      out.problems.push(`${id} is switched on but is no longer in the catalog`);
      out.blocked.push(id);
    }
  }

  let existing: string[];
  try {
    existing = readdirSync(dir);
  } catch (err) {
    // ENOENT and "we aren't allowed to look" are NOT the same answer, and a bare catch
    // gives them the same one. An EACCES here would read as "the directory is empty, so
    // there is nothing to unlink" and report a clean, changed:false success - so
    // switching a skill off would tell the operator it worked while the symlink sat
    // there and every session kept using it. Same rule as the catalog above: we know
    // nothing, so we change nothing, and we say so.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      out.problems.push(`couldn't read ${dir}: ${msg(err)}`);
      out.blocked.push(...desired);
      return out;
    }
    // Genuinely absent. Nothing to remove; create it only if we have something to put
    // in it - an empty `~/.claude/skills` we invented is litter.
    if (desired.size === 0) return out;
    try {
      mkdirSync(dir, { recursive: true });
    } catch (mkErr) {
      out.problems.push(`couldn't create ${dir}: ${msg(mkErr)}`);
      out.blocked.push(...desired);
      return out;
    }
    existing = [];
  }

  const seen = new Set<string>();
  for (const name of existing) {
    const id = skillIdFromDirName(name);
    if (id === null) continue; // not ours - the whole point of the prefix
    const path = join(dir, name);
    const entry = classify(path);

    if (entry.kind === "foreign") {
      // Only worth saying when it's in our way. A stray prefixed directory for a
      // skill nobody enabled is just sitting there.
      if (desired.has(id)) {
        out.problems.push(`${path} exists and isn't ours to replace - remove it by hand to enable ${id}`);
        out.blocked.push(id);
        seen.add(id);
      }
      continue;
    }

    if (!desired.has(id)) {
      if (remove(path, out)) out.unlinked.push(id);
      else out.blocked.push(id);
      continue;
    }

    seen.add(id);
    // Right id, wrong target: the app moved (a packaged build, a new worktree). Whether
    // this is a CHANGE depends on the old target, not on the paths differing - Claude
    // reads through the link, so re-pointing one that already resolved swaps a file for
    // an identical file and nothing it loaded moved. Bumping there would type
    // /reload-skills into every idle claude on the machine because the app was rebuilt
    // somewhere else. A DANGLING link, though, meant the skill wasn't loaded at all, and
    // fixing it is a real change every session needs to hear about.
    if (entry.target !== skillSourceDir(id)) {
      const wasLoaded = existsSync(path);
      if (!remove(path, out)) {
        out.blocked.push(id);
        continue;
      }
      // The removal already happened. Record it whatever the relink does, or a failed
      // relink reports `changed: false` having just unlinked a live skill - the one
      // "config ahead of disk with nobody told" state this design must not have.
      if (!link(id, dir, out)) {
        out.unlinked.push(id);
        out.blocked.push(id);
        continue;
      }
      if (!wasLoaded) out.linked.push(id);
    }
  }

  for (const id of desired) {
    if (seen.has(id)) continue;
    if (link(id, dir, out)) out.linked.push(id);
    else out.blocked.push(id);
  }

  out.changed = out.linked.length > 0 || out.unlinked.length > 0;
  return out;
}

/**
 * Where `id` lives, or would live: an entry that already exists under ANY recognised
 * prefix wins over the name a fresh install would write.
 *
 * The read-only checks below both ask "what does the disk say about this skill?", and a
 * link installed before the rename is the live one - Claude loads it, and `reconcile`
 * leaves it exactly where it is. Looking only under the current prefix would call every
 * pre-rename install missing and tell the operator to restart the daemon to repair
 * something that isn't broken (and that a restart would not move).
 */
function skillPath(dir: string, id: string): string {
  for (const prefix of SKILL_DIR_PREFIXES) {
    const path = join(dir, `${prefix}${id}`);
    try {
      // lstat, not exists: a DANGLING link is still an entry that's there, and telling
      // the caller about it is the whole point of `skillDrift`.
      lstatSync(path);
      return path;
    } catch {
      // not here - try the next name we may have written it under
    }
  }
  return join(dir, missionSkillDirName(id));
}

/**
 * Why one skill is not installed in one harness directory, or null when its live link
 * points at this build's catalog entry.
 *
 * Shared by the Settings drift view and workflow skill prerequisites. A second link
 * check would eventually disagree about legacy prefixes, dangling links, or a moved app.
 */
export function skillInstallProblem(id: string, dir: string): string | null {
  const path = skillPath(dir, id);
  let target: string | null = null;
  try {
    target = lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null;
  } catch {
    return `${id} is switched on but isn't installed - restart the daemon to repair it`;
  }
  if (target === null) {
    return `${path} exists and isn't ours to replace - remove it by hand to enable ${id}`;
  }
  if (target !== skillSourceDir(id)) {
    return `${id} is switched on but its link points somewhere else - restart the daemon to repair it`;
  }
  return null;
}

function link(id: string, dir: string, out: ReconcileResult): boolean {
  const path = join(dir, missionSkillDirName(id));
  try {
    symlinkSync(skillSourceDir(id), path, "dir");
    return true;
  } catch (err) {
    out.problems.push(`couldn't enable ${id}: ${msg(err)}`);
    return false;
  }
}

function remove(path: string, out: ReconcileResult): boolean {
  try {
    // The path is a symlink (classify said so), so this unlinks it and never
    // recurses into whatever it points at.
    unlinkSync(path);
    return true;
  } catch (err) {
    out.problems.push(`couldn't remove ${path}: ${msg(err)}`);
    return false;
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Why we could not put `id` in the state a config asks for - checked WITHOUT writing.
 *
 * This exists so `applySkillsConfig` can refuse before it touches anything, rather than
 * writing and undoing. The reconcile-then-roll-back shape it replaces was subtly wrong
 * twice over: the undo pass also HEALED unrelated drift, so the disk had really moved
 * and the caller returned `changed: false` and told nobody, leaving a skill installed
 * that no live session would ever load - and there was no way, after the fact, to tell
 * the healing apart from the undoing. Deciding first has no such window.
 *
 * A blocker must be something the operator can ACT ON, because a refusal's only
 * instruction is "clear this and try again". So the bar here is narrow: a catalog we
 * can't read (fix the path, the permissions, the build) and someone else's directory in
 * the way (move it). An id the catalog no longer HAS is deliberately not one - there is
 * no directory to remove and no panel row to clear the flag on, so refusing over it is a
 * dead end the operator cannot leave. It would also wedge the very control that escapes
 * it: a `git pull` that deletes an enabled skill leaves a stale `true` behind, and
 * `touchedBy` hands a master-switch flip every enabled id, so one deleted skill would
 * refuse the master switch forever and take every healthy skill down with it. It is
 * drift, not a refusal - `skillDrift` says so on every poll, and `desiredSkillIds`
 * already declines to link a directory that isn't there.
 *
 * An I/O failure during the write can't be predicted and isn't pretended at either: the
 * config records the operator's intent and `skillDrift` says loudly that the disk doesn't
 * have it yet.
 */
export function skillBlockers(cfg: SkillsConfig, catalog: Catalog, dirs: string[] = skillsDirs()): Map<string, string> {
  const out = new Map<string, string>();
  const enabledIds = Object.keys(cfg.skills).filter((id) => cfg.skills[id] === true);

  // Nothing to refuse: switching off needs no knowledge of what's in the catalog.
  if (!cfg.enabled) return out;

  if (!catalog.readable) {
    for (const id of enabledIds) out.set(id, catalog.problems[0] ?? "the skills catalog can't be read");
    return out;
  }

  // Across EVERY harness's directory, and the first blocker found wins. A skill that
  // cannot be installed for one harness is refused outright rather than half-installed:
  // a toggle that reported success while one of the two agents never got the skill is
  // exactly the "claims a skill is live in a session that never heard about it" lie the
  // rest of this feature is built to avoid.
  for (const dir of dirs) {
    for (const id of enabledIds) {
      if (!catalog.present.has(id) || out.has(id)) continue;
      const path = skillPath(dir, id);
      try {
        // Ours, or absent, are both fine - we can write either. Only somebody else's
        // directory is a refusal, and only they can clear it.
        if (!lstatSync(path).isSymbolicLink()) {
          out.set(id, `${path} exists and isn't ours to replace - remove it by hand to enable ${id}`);
        }
      } catch {
        // Absent. Nothing in the way.
      }
    }
  }
  return out;
}

/**
 * What the config claims is on, but the disk doesn't have - read-only, no writes.
 *
 * The panel needs this because the reconciler's `problems` are the memory of ONE pass:
 * they reach the operator on the PUT that produced them and nowhere else. A reconcile
 * that fails at STARTUP has no PUT to answer, so its problems went to a console nobody
 * is reading, and the panel would render every toggle happily on while the sessions had
 * none of them. That is the exact "claims a skill is live in twenty sessions" lie the
 * rest of this feature is built to avoid, arriving through the one door left open.
 *
 * So the view asks the DISK on every poll rather than trusting a remembered result.
 * One lstat per enabled skill, next to a `readCatalog` that already reads every
 * SKILL.md on the same request.
 */
export function skillDrift(cfg: SkillsConfig, catalog: Catalog, dirs: string[] = skillsDirs()): string[] {
  if (!cfg.enabled || !catalog.readable) return [];
  const out: string[] = [];
  for (const id of desiredSkillIds(cfg, catalog.present)) {
    // Once per skill, not once per skill per harness: "alpha is switched on but isn't
    // installed" is the same sentence whichever directory is missing it, and the panel
    // rendering it twice reads as two separate faults.
    let said = false;
    for (const dir of dirs) {
      if (said) break;
      const problem = skillInstallProblem(id, dir);
      if (problem) out.push(problem);
      said = problem !== null;
    }
  }
  // An id the config wants that the catalog no longer has. Its row won't render at all
  // (the panel maps over parsed skills), so without this the toggle just vanishes.
  for (const id of Object.keys(cfg.skills)) {
    if (cfg.skills[id] === true && !catalog.present.has(id)) {
      out.push(`${id} is switched on but is no longer in the catalog`);
    }
  }
  return out;
}

/**
 * Remove every symlink of ours and nothing else - the WALK, not the decision.
 *
 * Global blast radius is accepted deliberately (that IS the feature), which is exactly
 * why leaving is as supported as arriving. Expressed as a reconcile against a disabled
 * config rather than as its own walk, so the "only ever remove our own symlinks" rule has
 * one implementation and uninstall cannot drift from it.
 *
 * This does NOT turn the feature off, and callers must not present it as though it does.
 * It touches the disk and nothing else, while the config goes on saying the skills are
 * on - and `reconcileSkills` re-reads that config on every daemon start, so a removal
 * this alone performed is re-created at the next launch, complete with a reload
 * broadcast to every session. The durable off-switch is the master switch
 * (`applySkillsConfig({enabled: false})`), which records the intent and takes this same
 * removal path to carry it out.
 *
 * So the honest use is teardown of an install that is going away with no panel left to
 * click: `hooks/install.mjs --uninstall`, walking out of a checkout.
 */
export function uninstallSkillLinks(dirs: string[] = skillsDirs()): ReconcileResult {
  return reconcileSkillLinks(
    { enabled: false, skills: {}, generation: 0, generationAt: 0 },
    { readable: true, skills: [], present: new Set(), problems: [] },
    dirs,
  );
}
