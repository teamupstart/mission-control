import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillCatalogEntry } from "../src/shared/types.ts";
import type { Catalog } from "../src/server/skills/catalog.ts";
import type { SkillsConfig } from "../src/shared/protocol.ts";

// What is at stake: a harness can DECLARE skills and still never receive one.
//
// `HARNESS_CAPABILITIES.codex.skills` names `~/.agents/skills`, but for as long as the
// only directory resolver was `claudeSkillsDir()` that declaration was inert - every
// reconcile, blocker, drift and uninstall path walked Claude's directory and nothing was
// ever linked where Codex would read it. The panel showed the skill on, and one of the two
// harnesses on the machine silently didn't have it. Nothing errored, which is what made it
// survivable enough to ship.
//
// So these pin the FOLD, not the walk (`skills-reconcile.test.ts` owns the walk): that
// every declaring harness's directory is reached, that a failure in one is reported rather
// than swallowed by the other's success, and that uninstall leaves as widely as install
// arrived.

const home = mkdtempSync(join(tmpdir(), "mission-skills-multi-"));
const claudeSkills = join(home, "claude-skills");
const codexSkills = join(home, "codex-skills");
const catalogDir = join(home, "catalog");
process.env.CLAUDE_SKILLS_DIR = claudeSkills;
process.env.CODEX_SKILLS_DIR = codexSkills;
process.env.FLEET_SKILLS_DIR = catalogDir;

const { reconcileSkillLinks, uninstallSkillLinks, skillsDirs, skillDrift, skillBlockers } =
  await import("../src/server/skills/reconcile.ts");

after(() => rmSync(home, { recursive: true, force: true }));

function mkSkill(id: string): SkillCatalogEntry {
  return { id, name: id, description: "d", category: "c", enforcement: "triggered" };
}

const SKILLS = [mkSkill("alpha"), mkSkill("beta")];
const CATALOG: Catalog = {
  readable: true,
  skills: SKILLS,
  present: new Set(SKILLS.map((s) => s.id)),
  problems: [],
};

function mkCfg(over: Partial<SkillsConfig> = {}): SkillsConfig {
  return { enabled: true, skills: {}, generation: 0, generationAt: 0, ...over };
}

beforeEach(() => {
  for (const dir of [claudeSkills, codexSkills, catalogDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const s of SKILLS) {
    mkdirSync(join(catalogDir, s.id), { recursive: true });
    writeFileSync(join(catalogDir, s.id, "SKILL.md"), `---\nname: ${s.id}\n---\nbody\n`);
  }
});

test("every harness that declares a skills directory is in the reconcile set", () => {
  const dirs = skillsDirs();
  assert.ok(dirs.includes(claudeSkills), "claude's directory");
  // The regression itself: this line fails against a resolver that only ever knew about
  // claude, however many harnesses declare the capability.
  assert.ok(dirs.includes(codexSkills), "codex's directory");
  assert.equal(new Set(dirs).size, dirs.length, "no directory is walked twice");
});

test("enabling a skill links it for EVERY harness, not just the first", () => {
  const r = reconcileSkillLinks(mkCfg({ skills: { alpha: true } }), CATALOG);

  assert.equal(r.changed, true);
  // One id, reported once: "linked alpha" is a fact about the fleet, not one per directory.
  assert.deepEqual(r.linked, ["alpha"]);
  assert.deepEqual(readdirSync(claudeSkills), ["mission-alpha"]);
  assert.deepEqual(readdirSync(codexSkills), ["mission-alpha"]);
  assert.equal(readlinkSync(join(codexSkills, "mission-alpha")), join(catalogDir, "alpha"));
});

test("disabling removes it from every harness - not one install left behind", () => {
  reconcileSkillLinks(mkCfg({ skills: { alpha: true, beta: true } }), CATALOG);
  const r = reconcileSkillLinks(mkCfg({ skills: { alpha: true, beta: false } }), CATALOG);

  assert.deepEqual(r.unlinked, ["beta"]);
  assert.deepEqual(readdirSync(claudeSkills), ["mission-alpha"]);
  assert.deepEqual(
    readdirSync(codexSkills),
    ["mission-alpha"],
    "a link left behind here is a skill the operator switched off still loading",
  );
});

test("uninstall leaves as widely as install arrived", () => {
  reconcileSkillLinks(mkCfg({ skills: { alpha: true, beta: true } }), CATALOG);
  uninstallSkillLinks();

  assert.deepEqual(readdirSync(claudeSkills), []);
  assert.deepEqual(readdirSync(codexSkills), []);
});

test("someone else's directory in ONE harness's path blocks the skill outright", () => {
  // Half-installed is the state with no honest thing to say: the panel would report a
  // clean success while one of the two agents never got the skill. So the blocker is
  // fleet-wide even though the obstruction is in one directory.
  mkdirSync(join(codexSkills, "mission-alpha"), { recursive: true });

  const blockers = skillBlockers(mkCfg({ skills: { alpha: true } }), CATALOG);
  assert.ok(blockers.has("alpha"), "a foreign directory anywhere is a refusal");
  assert.match(blockers.get("alpha") ?? "", /isn't ours to replace/);
  assert.match(blockers.get("alpha") ?? "", new RegExp(codexSkills.replace(/\W/g, "\\$&")));
});

test("drift notices a link missing from a harness the operator never looks at", () => {
  reconcileSkillLinks(mkCfg({ skills: { alpha: true } }), CATALOG);
  assert.deepEqual(skillDrift(mkCfg({ skills: { alpha: true } }), CATALOG), [], "healthy");

  rmSync(join(codexSkills, "mission-alpha"), { recursive: true, force: true });
  const drift = skillDrift(mkCfg({ skills: { alpha: true } }), CATALOG);
  assert.equal(drift.length, 1, "one sentence per skill, however many directories miss it");
  assert.match(drift[0] ?? "", /alpha is switched on but isn't installed/);
});

test("an isolated home keeps EVERY harness's directory inside itself", () => {
  // The scoping rule `skillsDirFor` documents, asked of the harness that was added after
  // it was written. A second daemon that sent codex links to the machine's real
  // `~/.agents/skills` would reconcile a live install against its own empty config - the
  // exact data loss the claude-side isolation exists to prevent, arriving through the
  // door a new harness opened.
  const fakeHome = join(home, "isolation", "operator-home");
  const isolated = join(home, "isolation", "second-daemon-state");
  mkdirSync(fakeHome, { recursive: true });
  mkdirSync(isolated, { recursive: true });

  const env: NodeJS.ProcessEnv = { ...process.env, HOME: fakeHome, MISSION_HOME: isolated };
  delete env.CLAUDE_SKILLS_DIR;
  delete env.CODEX_SKILLS_DIR;

  const out = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      'const r = await import("./src/server/skills/reconcile.ts");' +
        "console.log(JSON.stringify(r.skillsDirs()));",
    ],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), env, encoding: "utf8" },
  );

  const dirs = JSON.parse(out.trim().split("\n").filter(Boolean).at(-1) ?? "[]") as string[];
  assert.deepEqual(dirs.sort(), [join(isolated, "claude-skills"), join(isolated, "codex-skills")].sort());
  for (const dir of dirs) {
    assert.ok(dir.startsWith(isolated), `${dir} escaped the isolated home`);
  }
});
