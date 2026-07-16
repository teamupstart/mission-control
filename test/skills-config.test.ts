import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The generation watermark and the apply transaction. Real db, real filesystem: the
// invariant under test ("the generation moves only when the DISK moves") spans both,
// so mocking either would test the mock.

const home = mkdtempSync(join(tmpdir(), "mission-skills-cfg-"));
const claudeSkills = join(home, "claude-skills");
const catalogDir = join(home, "catalog");
// Set before importing anything that resolves the state dir / catalog dir.
process.env.HARNESS_HOME = join(home, "state");
process.env.CLAUDE_SKILLS_DIR = claudeSkills;
process.env.FLEET_SKILLS_DIR = catalogDir;

const { openDb, setAppConfig } = await import("../src/server/db.ts");
const { applySkillsConfig, getSkillsConfig, reconcileSkills } = await import(
  "../src/server/skills/config.ts"
);
const { skillDrift } = await import("../src/server/skills/reconcile.ts");
const { readCatalog } = await import("../src/server/skills/catalog.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const NOW = 5_000_000;

function writeSkill(id: string): void {
  mkdirSync(join(catalogDir, id), { recursive: true });
  writeFileSync(
    join(catalogDir, id, "SKILL.md"),
    `---\nname: ${id}\ndescription: does ${id} things\nmetadata:\n  fleet:\n    category: test\n    enforcement: triggered\n---\nbody\n`,
  );
}

beforeEach(() => {
  openDb().exec("DELETE FROM app_config");
  rmSync(claudeSkills, { recursive: true, force: true });
  rmSync(catalogDir, { recursive: true, force: true });
  writeSkill("alpha");
  writeSkill("beta");
  mkdirSync(claudeSkills, { recursive: true });
});

const links = (): string[] => readdirSync(claudeSkills).sort();

test("ships off, with nothing enabled and nothing owed", () => {
  const cfg = getSkillsConfig();
  // Never on by default: this writes into the operator's global claude config and
  // changes what the model does in every session on the machine.
  assert.equal(cfg.enabled, false);
  assert.deepEqual(cfg.skills, {});
  assert.equal(cfg.generation, 0, "generation 0 means nobody is owed a reload");
});

test("enabling a skill links it and bumps the generation once", () => {
  const r = applySkillsConfig({ enabled: true, skills: { alpha: true } }, NOW);

  assert.deepEqual(r.problems, []);
  assert.deepEqual(links(), ["mission-alpha"]);
  assert.equal(r.config.generation, 1);
  assert.equal(r.config.generationAt, NOW);
});

test("THE invariant: a config write that doesn't move the disk doesn't bump", () => {
  applySkillsConfig({ enabled: true, skills: { alpha: true } }, NOW);

  // Re-asserting the same state, and toggling something that changes no symlink.
  const same = applySkillsConfig({ skills: { alpha: true } }, NOW + 1);
  assert.equal(same.config.generation, 1, "re-enabling an enabled skill owes nobody a reload");

  const noop = applySkillsConfig({ skills: { beta: false } }, NOW + 2);
  assert.equal(noop.config.generation, 1, "disabling an already-disabled skill changes no disk");
  // Bumping here would type /reload-skills into every claude on the machine because
  // someone clicked a toggle twice.
});

test("N rapid toggles land at one generation per real change - one reload each", () => {
  applySkillsConfig({ enabled: true }, NOW);
  const a = applySkillsConfig({ skills: { alpha: true } }, NOW + 1);
  const b = applySkillsConfig({ skills: { beta: true } }, NOW + 2);
  const c = applySkillsConfig({ skills: { alpha: false } }, NOW + 3);

  assert.equal(a.config.generation, 1);
  assert.equal(b.config.generation, 2);
  assert.equal(c.config.generation, 3);
  // A session at ack 0 reads generation 3, reloads ONCE, and re-reads the directory as
  // it stands now. The watermark is the whole coalescing story.
  assert.deepEqual(links(), ["mission-beta"]);
});

test("a patch merges per skill - one toggle never clears another", () => {
  applySkillsConfig({ enabled: true, skills: { alpha: true } }, NOW);
  applySkillsConfig({ skills: { beta: true } }, NOW + 1);

  // A replacing patch would make the second click mean "beta on, alpha off", so two
  // open dashboards would silently switch each other's skills off across the fleet.
  assert.deepEqual(links(), ["mission-alpha", "mission-beta"]);
  assert.deepEqual(getSkillsConfig().skills, { alpha: true, beta: true });
});

test("the master switch off unlinks everything and bumps, so the fleet drops them", () => {
  applySkillsConfig({ enabled: true, skills: { alpha: true, beta: true } }, NOW);

  const off = applySkillsConfig({ enabled: false }, NOW + 1);

  assert.deepEqual(links(), []);
  assert.equal(off.config.generation, 2, "sessions must be told to DROP the skills");
  // The rows keep their state, so flipping the master back restores the same set.
  assert.deepEqual(off.config.skills, { alpha: true, beta: true });
  const on = applySkillsConfig({ enabled: true }, NOW + 2);
  assert.deepEqual(links(), ["mission-alpha", "mission-beta"]);
  assert.equal(on.config.generation, 3);
});

test("a patch that can't work is refused BEFORE anything is written", () => {
  applySkillsConfig({ enabled: true }, NOW);
  // A real directory wearing our prefix: the reconciler will not replace it.
  mkdirSync(join(claudeSkills, "mission-beta"), { recursive: true });

  const r = applySkillsConfig({ skills: { alpha: true, beta: true } }, NOW + 1);

  assert.equal(r.refused.length, 1, "the caller is told THEIR patch failed");
  assert.match(r.refused[0] ?? "", /isn't ours to replace/);
  // Nothing written at all - not the config, and not alpha's link. Deciding first means
  // there is no half-applied state to undo, and no undo that could quietly heal
  // something else on its way past.
  assert.equal(getSkillsConfig().skills.alpha, undefined, "the config never learned the ask");
  assert.equal(getSkillsConfig().generation, 0, "nothing changed, so nobody is owed a reload");
  assert.deepEqual(links(), ["mission-beta"], "and alpha was never linked");
});

test("one blocked skill does NOT wedge every other toggle in the panel", () => {
  applySkillsConfig({ enabled: true, skills: { beta: true } }, NOW);
  // Someone drops a real directory over beta's link - now permanently blocked.
  rmSync(join(claudeSkills, "mission-beta"), { force: true });
  mkdirSync(join(claudeSkills, "mission-beta"), { recursive: true });

  // Every later pass reports beta's problem, forever. Scoping the refusal to the ids the
  // patch MOVES is what stops that one stuck row refusing every unrelated toggle - with
  // an error naming a skill the operator never touched.
  const r = applySkillsConfig({ skills: { alpha: true } }, NOW + 1);

  assert.deepEqual(r.refused, [], "alpha's toggle was not refused over beta's problem");
  assert.equal(getSkillsConfig().skills.alpha, true, "alpha's toggle stuck");
  assert.ok(links().includes("mission-alpha"), "and alpha is really on disk");
  assert.equal(r.config.generation, 2, "alpha's arrival is a real change the fleet needs");
});

test("a skill deleted from the catalog does not wedge the master switch", () => {
  applySkillsConfig({ enabled: true, skills: { alpha: true, beta: true } }, NOW);
  // A `git pull` drops beta from the repo. Startup correctly unlinks it - and correctly
  // leaves `beta: true` in the config, because the row is the operator's intent and the
  // skill may come back.
  rmSync(join(catalogDir, "beta"), { recursive: true, force: true });
  reconcileSkills(NOW + 1);
  assert.deepEqual(links(), ["mission-alpha"]);

  // `touchedBy` hands a master flip EVERY enabled id, so the stale `beta: true` rides
  // along on both of these. Refusing over it would wedge the switch permanently: there
  // is no directory to remove and no panel row to clear the flag on, so the operator
  // could never turn the feature back on - and healthy alpha would go down with it.
  const off = applySkillsConfig({ enabled: false }, NOW + 2);
  assert.deepEqual(off.refused, []);
  const on = applySkillsConfig({ enabled: true }, NOW + 3);

  assert.deepEqual(on.refused, [], "a skill nobody can restore must not refuse the switch");
  assert.equal(getSkillsConfig().enabled, true);
  assert.deepEqual(links(), ["mission-alpha"], "and the skills that DO exist come back");
  // Not silence: it's drift, and the panel says so on every poll.
  assert.match(skillDrift(getSkillsConfig(), readCatalog()).join("; "), /beta is switched on but is no longer/);
});

test("a stale enabled flag for a deleted skill doesn't refuse an unrelated toggle", () => {
  applySkillsConfig({ enabled: true, skills: { beta: true } }, NOW);
  rmSync(join(catalogDir, "beta"), { recursive: true, force: true });

  const r = applySkillsConfig({ skills: { alpha: true } }, NOW + 1);

  assert.deepEqual(r.refused, [], "alpha's toggle is not refused over beta's disappearance");
  assert.ok(links().includes("mission-alpha"));
});

test("a patch IS refused when the skill it names is the blocked one", () => {
  applySkillsConfig({ enabled: true }, NOW);
  // Under the OLD prefix: a directory that was in our way before the rename is still in
  // our way after it, and the refusal has to see it rather than link a duplicate past it.
  mkdirSync(join(claudeSkills, "fleet-beta"), { recursive: true });

  const r = applySkillsConfig({ skills: { beta: true } }, NOW + 1);

  assert.equal(r.refused.length, 1);
  assert.equal(getSkillsConfig().skills.beta, undefined, "the config never learned the ask");
  assert.equal(getSkillsConfig().generation, 0);
});

test("the master switch can be turned OFF even when the catalog is unreadable", () => {
  applySkillsConfig({ enabled: true, skills: { alpha: true } }, NOW);
  rmSync(catalogDir, { recursive: true, force: true });

  // Switching off needs no knowledge of what's in the catalog - the desired set is empty
  // either way. Refusing here would wedge the master switch ON at exactly the moment the
  // operator most wants it off.
  const off = applySkillsConfig({ enabled: false }, NOW + 1);

  assert.deepEqual(off.refused, []);
  assert.equal(off.config.enabled, false);
  assert.deepEqual(links(), [], "and the symlinks really are gone");
});

test("an unreadable catalog refuses to turn a skill ON, rather than guessing", () => {
  applySkillsConfig({ enabled: true }, NOW);
  rmSync(catalogDir, { recursive: true, force: true });

  const r = applySkillsConfig({ skills: { alpha: true } }, NOW + 1);

  assert.equal(r.refused.length, 1);
  assert.match(r.refused[0] ?? "", /couldn't read the skills catalog/);
  assert.equal(getSkillsConfig().skills.alpha, undefined);
});

test("an unreadable catalog never unlinks a live skill", () => {
  // THE regression, at the apply layer: every id looks deleted, and the answer to a
  // deleted id is to unlink it.
  applySkillsConfig({ enabled: true, skills: { alpha: true } }, NOW);
  const gen = getSkillsConfig().generation;
  rmSync(catalogDir, { recursive: true, force: true });

  reconcileSkills(NOW + 1);

  assert.deepEqual(links(), ["mission-alpha"], "the skill survives a catalog we can't read");
  assert.equal(getSkillsConfig().generation, gen, "and nobody is told to drop it");
});

test("startup reconcile heals a link deleted by hand, and tells the fleet", () => {
  applySkillsConfig({ enabled: true, skills: { alpha: true } }, NOW);
  rmSync(join(claudeSkills, "mission-alpha"));

  const healed = reconcileSkills(NOW + 1);

  assert.deepEqual(links(), ["mission-alpha"]);
  assert.equal(healed.config.generation, 2, "the disk moved, so every session must re-read");
});

test("startup reconcile on a healthy install writes nothing and reloads nobody", () => {
  applySkillsConfig({ enabled: true, skills: { alpha: true } }, NOW);

  const again = reconcileSkills(NOW + 1);

  // Idempotence is what makes it safe to run on every daemon start. A bump here would
  // reload the whole fleet every time the app restarts.
  assert.equal(again.changed, false);
  assert.equal(again.config.generation, 1);
  assert.equal(again.config.generationAt, NOW);
});

test("drift is reported on every read, so a failed startup reconcile isn't invisible", () => {
  // The reconciler's problems are the memory of ONE pass and reach the operator on the
  // PUT that produced them. A startup reconcile has no PUT to answer, so without a fresh
  // look at the disk the panel would render the toggle on while the fleet had nothing.
  applySkillsConfig({ enabled: true, skills: { alpha: true } }, NOW);
  assert.deepEqual(skillDrift(getSkillsConfig(), readCatalog()), [], "healthy: nothing to say");

  rmSync(join(claudeSkills, "mission-alpha"));

  const drift = skillDrift(getSkillsConfig(), readCatalog());
  assert.equal(drift.length, 1);
  assert.match(drift[0] ?? "", /alpha is switched on but isn't installed/);
});

test("drift tells a MISSING link apart from a foreign one - they need opposite answers", () => {
  applySkillsConfig({ enabled: true, skills: { alpha: true } }, NOW);
  rmSync(join(claudeSkills, "mission-alpha"));
  mkdirSync(join(claudeSkills, "mission-alpha"), { recursive: true });

  // One is ours to repair, the other is the operator's to move. `classify` folds them
  // together, which is right where it's used and wrong here.
  assert.match(skillDrift(getSkillsConfig(), readCatalog())[0] ?? "", /isn't ours to replace/);
});

test("drift says nothing when the catalog can't be read - it knows nothing to report", () => {
  applySkillsConfig({ enabled: true, skills: { alpha: true } }, NOW);
  const blind = { readable: false, skills: [], present: new Set<string>(), problems: ["boom"] };
  // The catalog's own problem is already surfaced by readCatalog; inventing drift on top
  // of it would blame the skills for a failure that is ours.
  assert.deepEqual(skillDrift(getSkillsConfig(), blind), []);
});

test("a config blob from a future build doesn't crash the panel", () => {
  setAppConfig("skills", { enabled: true, skills: { alpha: true }, somethingNew: 42 });
  assert.equal(getSkillsConfig().enabled, true);
  assert.equal(getSkillsConfig().skills.alpha, true);
});

test("an unwritable skills dir is reported, never thrown", () => {
  // The reconciler touches the operator's home directory; a daemon that died over it
  // would be worse than one running without a skill.
  const locked = join(home, "locked");
  mkdirSync(locked, { recursive: true });
  chmodSync(locked, 0o500);
  after(() => chmodSync(locked, 0o700));
  process.env.CLAUDE_SKILLS_DIR = locked;
  try {
    const r = applySkillsConfig({ enabled: true, skills: { alpha: true } }, NOW);
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0] ?? "", /couldn't enable alpha/);
    assert.equal(getSkillsConfig().generation, 0);
  } finally {
    process.env.CLAUDE_SKILLS_DIR = claudeSkills;
  }
});
