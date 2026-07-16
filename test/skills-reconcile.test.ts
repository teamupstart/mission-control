import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillCatalogEntry } from "../src/shared/types.ts";
import type { Catalog } from "../src/server/skills/catalog.ts";
import type { SkillsConfig } from "../src/shared/protocol.ts";

// The reconciler writes into ~/.claude/skills - the operator's own directory, next to
// hand-authored skills the harness must never touch. So these run against a REAL
// directory with real symlinks: the whole safety argument is about what lstat says and
// what rm does, and a mocked fs would assert the mock.

const home = mkdtempSync(join(tmpdir(), "fleet-skills-rec-"));
const claudeSkills = join(home, "claude-skills");
const catalogDir = join(home, "catalog");
process.env.CLAUDE_SKILLS_DIR = claudeSkills;
process.env.FLEET_SKILLS_DIR = catalogDir;

const { reconcileSkillLinks, uninstallSkillLinks, desiredSkillIds } = await import(
  "../src/server/skills/reconcile.ts"
);

after(() => rmSync(home, { recursive: true, force: true }));

function mkCfg(over: Partial<SkillsConfig> = {}): SkillsConfig {
  return { enabled: true, skills: {}, generation: 0, generationAt: 0, ...over };
}

function mkSkill(id: string): SkillCatalogEntry {
  return { id, name: id, description: "d", category: "c", enforcement: "triggered" };
}

const SKILLS = [mkSkill("alpha"), mkSkill("beta")];

/** A readable catalog whose directories are all present - the healthy case. */
function mkCatalog(over: Partial<Catalog> = {}): Catalog {
  return {
    readable: true,
    skills: SKILLS,
    present: new Set(SKILLS.map((s) => s.id)),
    problems: [],
    ...over,
  };
}
const CATALOG = mkCatalog();

beforeEach(() => {
  rmSync(claudeSkills, { recursive: true, force: true });
  rmSync(catalogDir, { recursive: true, force: true });
  for (const s of SKILLS) {
    mkdirSync(join(catalogDir, s.id), { recursive: true });
    writeFileSync(join(catalogDir, s.id, "SKILL.md"), `---\nname: ${s.id}\n---\nbody\n`);
  }
  mkdirSync(claudeSkills, { recursive: true });
});

function entries(): string[] {
  return readdirSync(claudeSkills).sort();
}

test("enabling a skill symlinks it in under the fleet- prefix", () => {
  const r = reconcileSkillLinks(mkCfg({ skills: { alpha: true } }), CATALOG, claudeSkills);

  assert.equal(r.changed, true);
  assert.deepEqual(r.linked, ["alpha"]);
  assert.deepEqual(entries(), ["fleet-alpha"]);
  assert.equal(lstatSync(join(claudeSkills, "fleet-alpha")).isSymbolicLink(), true);
  // Claude reads the SKILL.md through the link, so the link has to actually resolve.
  assert.match(readFileSync(join(claudeSkills, "fleet-alpha", "SKILL.md"), "utf8"), /name: alpha/);
});

test("re-running against a correct directory writes nothing and reports unchanged", () => {
  const cfg = mkCfg({ skills: { alpha: true } });
  reconcileSkillLinks(cfg, CATALOG, claudeSkills);

  const again = reconcileSkillLinks(cfg, CATALOG, claudeSkills);

  // This is what lets the daemon reconcile on every startup without reloading the
  // fleet: `changed: false` is what withholds the generation bump.
  assert.equal(again.changed, false);
  assert.deepEqual(again.linked, []);
  assert.deepEqual(again.unlinked, []);
  assert.deepEqual(entries(), ["fleet-alpha"]);
});

test("disabling a skill removes only its link", () => {
  reconcileSkillLinks(mkCfg({ skills: { alpha: true, beta: true } }), CATALOG, claudeSkills);

  const r = reconcileSkillLinks(mkCfg({ skills: { alpha: true, beta: false } }), CATALOG, claudeSkills);

  assert.equal(r.changed, true);
  assert.deepEqual(r.unlinked, ["beta"]);
  assert.deepEqual(entries(), ["fleet-alpha"]);
});

test("THE test: a user's own skills are untouched, whatever we do", () => {
  // The operator's real directory holds no-mistakes, implement-plan, phase-plan...
  // hand-authored, not ours, and irreplaceable.
  mkdirSync(join(claudeSkills, "no-mistakes"), { recursive: true });
  writeFileSync(join(claudeSkills, "no-mistakes", "SKILL.md"), "the user's work\n");
  const theirLink = join(home, "their-skill-src");
  mkdirSync(theirLink, { recursive: true });
  symlinkSync(theirLink, join(claudeSkills, "implement-plan"), "dir");

  reconcileSkillLinks(mkCfg({ skills: { alpha: true, beta: true } }), CATALOG, claudeSkills);
  reconcileSkillLinks(mkCfg({ skills: {} }), CATALOG, claudeSkills);
  uninstallSkillLinks(claudeSkills);

  // Not "we tried not to" - after linking, unlinking, and a full uninstall, both are
  // still exactly as they were. A symlink of theirs is no more ours than a directory.
  assert.deepEqual(entries(), ["implement-plan", "no-mistakes"]);
  assert.equal(readFileSync(join(claudeSkills, "no-mistakes", "SKILL.md"), "utf8"), "the user's work\n");
  assert.equal(readlinkSync(join(claudeSkills, "implement-plan")), theirLink);
});

test("a REAL directory wearing our prefix is refused, not deleted", () => {
  // Nothing here ever creates a real directory, so this one is the operator's however
  // its name reads. Marker discipline that deletes on a name match alone isn't
  // discipline - it's the prefix doing the operator's filing for them.
  const theirs = join(claudeSkills, "fleet-alpha");
  mkdirSync(theirs, { recursive: true });
  writeFileSync(join(theirs, "SKILL.md"), "hand-written\n");

  const r = reconcileSkillLinks(mkCfg({ skills: { alpha: true } }), CATALOG, claudeSkills);

  assert.equal(r.changed, false);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0] ?? "", /isn't ours to replace/);
  assert.equal(readFileSync(join(theirs, "SKILL.md"), "utf8"), "hand-written\n");
});

test("a DANGLING link is re-pointed, and that IS a change the fleet needs", () => {
  // The link resolves to nothing, so claude loaded no skill at all. Fixing it changes
  // what the fleet has.
  symlinkSync(join(home, "old-app", "skills", "alpha"), join(claudeSkills, "fleet-alpha"), "dir");

  const r = reconcileSkillLinks(mkCfg({ skills: { alpha: true } }), CATALOG, claudeSkills);

  assert.equal(r.changed, true);
  assert.deepEqual(r.linked, ["alpha"]);
  assert.equal(readlinkSync(join(claudeSkills, "fleet-alpha")), join(catalogDir, "alpha"));
});

test("a RESOLVING link re-pointed at the same skill is not a change - no fleet reload", () => {
  // The app was rebuilt somewhere else, so the target path differs. Claude reads THROUGH
  // the link, so it loaded the skill before and loads the same skill after: nothing it
  // can see moved. Bumping here would type /reload-skills into every idle claude on the
  // machine because a developer switched worktrees.
  const otherCopy = join(home, "other-copy", "alpha");
  mkdirSync(otherCopy, { recursive: true });
  writeFileSync(join(otherCopy, "SKILL.md"), "---\nname: alpha\n---\n");
  symlinkSync(otherCopy, join(claudeSkills, "fleet-alpha"), "dir");

  const r = reconcileSkillLinks(mkCfg({ skills: { alpha: true } }), CATALOG, claudeSkills);

  assert.equal(r.changed, false, "the skill was loaded before and is loaded now");
  assert.equal(readlinkSync(join(claudeSkills, "fleet-alpha")), join(catalogDir, "alpha"), "still re-pointed");
});

test("a link that can't be created is blocked, not silently counted as done", () => {
  // A fresh link that fails - here an id whose directory name can't be created, because
  // its parent doesn't exist. `blocked` is what tells applySkillsConfig the ask failed,
  // and `changed: false` is what withholds a generation bump for a skill nobody got.
  const r = reconcileSkillLinks(
    mkCfg({ skills: { "nested/id": true } }),
    mkCatalog({ present: new Set(["nested/id"]) }),
    claudeSkills,
  );

  assert.deepEqual(r.linked, []);
  assert.deepEqual(r.blocked, ["nested/id"]);
  assert.equal(r.changed, false);
  assert.match(r.problems[0] ?? "", /couldn't enable nested\/id/);
});

test("a re-point we cannot even start is blocked, and nothing claims to have changed", () => {
  // The stale link is there but the directory is read-only, so `remove` fails. Nothing
  // moved, so `changed` must stay false - and the id must land in `blocked`, or the
  // operator's toggle would look applied while the skill is still pointing nowhere.
  symlinkSync(join(home, "old-app", "skills", "alpha"), join(claudeSkills, "fleet-alpha"), "dir");
  chmodSync(claudeSkills, 0o500);
  try {
    const r = reconcileSkillLinks(mkCfg({ skills: { alpha: true } }), CATALOG, claudeSkills);

    assert.equal(r.changed, false);
    assert.deepEqual(r.blocked, ["alpha"]);
    assert.match(r.problems[0] ?? "", /couldn't remove/);
  } finally {
    chmodSync(claudeSkills, 0o700);
  }
});

test("the master switch off unlinks everything, whatever the rows say", () => {
  reconcileSkillLinks(mkCfg({ skills: { alpha: true, beta: true } }), CATALOG, claudeSkills);

  const r = reconcileSkillLinks(mkCfg({ enabled: false, skills: { alpha: true, beta: true } }), CATALOG, claudeSkills);

  // Off has to reach the DISK. A master switch that only stopped new links would leave
  // the fleet running skills the panel says are off.
  assert.equal(r.changed, true);
  assert.deepEqual(r.unlinked, ["alpha", "beta"]);
  assert.deepEqual(entries(), []);
});

test("desiredSkillIds ignores an id whose directory is gone from the repo", () => {
  // A stale enabled flag for a skill deleted from the repo must not become a symlink
  // pointing at nothing.
  const cfg = mkCfg({ skills: { alpha: true, "deleted-last-year": true } });
  assert.deepEqual([...desiredSkillIds(cfg, CATALOG.present)], ["alpha"]);
});

test("THE regression: a skill we can't PARSE is still desired, and stays linked", () => {
  // "Absent from the parsed catalog" has two causes and only one is a deletion. A
  // SKILL.md reformatted into a YAML folded scalar is still valid, still loaded by
  // claude - it just defeats our deliberately narrow reader. Reading that as a deletion
  // silently uninstalls a working skill from every claude on the machine, and bumps the
  // generation so they all drop it at once, over a formatting edit.
  const unparsed: Catalog = {
    readable: true,
    skills: [mkSkill("beta")], // alpha failed to parse...
    present: new Set(["alpha", "beta"]), // ...but its directory is right there
    problems: ["skills/alpha/SKILL.md has no 'description'"],
  };
  const cfg = mkCfg({ skills: { alpha: true } });
  assert.deepEqual([...desiredSkillIds(cfg, unparsed.present)], ["alpha"]);

  reconcileSkillLinks(cfg, CATALOG, claudeSkills);
  const r = reconcileSkillLinks(cfg, unparsed, claudeSkills);
  assert.equal(r.changed, false, "a parse failure must not move the disk");
  assert.deepEqual(entries(), ["fleet-alpha"], "the skill is still installed");
});

test("THE regression: an UNREADABLE catalog changes nothing at all", () => {
  // An unreadable skills/ is a fact about us, not about the operator's skills. Every id
  // would look deleted, and this function's answer to a deleted id is to unlink - so a
  // worktree without skills/, or one permissions hiccup, would uninstall every skill on
  // the machine and broadcast a reload telling the fleet to drop them.
  const cfg = mkCfg({ skills: { alpha: true, beta: true } });
  reconcileSkillLinks(cfg, CATALOG, claudeSkills);

  const blind = reconcileSkillLinks(cfg, mkCatalog({ readable: false, skills: [], present: new Set(), problems: ["couldn't read the skills catalog at /nope: ENOENT"] }), claudeSkills);

  assert.equal(blind.changed, false, "we know nothing, so we change nothing");
  assert.deepEqual(entries(), ["fleet-alpha", "fleet-beta"], "both skills survive");
  assert.deepEqual(blind.blocked.sort(), ["alpha", "beta"]);
  assert.match(blind.problems[0] ?? "", /couldn't read the skills catalog/);
});

test("an enabled skill that really IS gone is unlinked, and the panel is told", () => {
  const cfg = mkCfg({ skills: { alpha: true } });
  reconcileSkillLinks(cfg, CATALOG, claudeSkills);

  // Readable catalog, alpha genuinely deleted from the repo.
  const r = reconcileSkillLinks(cfg, mkCatalog({ skills: [mkSkill("beta")], present: new Set(["beta"]) }), claudeSkills);

  assert.deepEqual(r.unlinked, ["alpha"]);
  assert.equal(r.changed, true);
  assert.deepEqual(entries(), []);
  assert.match(r.problems[0] ?? "", /no longer in the catalog/);
});

test("a skills dir we CAN'T READ is not an empty one - nothing is reported as done", () => {
  // ENOENT and "we aren't allowed to look" must not give the same answer. Read as
  // "empty, so nothing to unlink", switching a skill off would report a clean success
  // while the symlink sat there and the whole fleet kept using it.
  reconcileSkillLinks(mkCfg({ skills: { alpha: true } }), CATALOG, claudeSkills);
  chmodSync(claudeSkills, 0o200); // write-only: readdir fails with EACCES
  try {
    const r = reconcileSkillLinks(mkCfg({ skills: { alpha: false } }), CATALOG, claudeSkills);

    assert.equal(r.changed, false, "we know nothing, so we changed nothing");
    assert.match(r.problems[0] ?? "", /couldn't read/);
  } finally {
    chmodSync(claudeSkills, 0o700);
  }
  assert.deepEqual(entries(), ["fleet-alpha"], "and the link really is still there");
});

test("an absent ~/.claude/skills is created only when there's something to put in it", () => {
  rmSync(claudeSkills, { recursive: true, force: true });

  reconcileSkillLinks(mkCfg({ skills: {} }), CATALOG, claudeSkills);
  assert.equal(existsSync(claudeSkills), false, "an empty dir we invented is litter");

  reconcileSkillLinks(mkCfg({ skills: { alpha: true } }), CATALOG, claudeSkills);
  assert.deepEqual(entries(), ["fleet-alpha"]);
});
