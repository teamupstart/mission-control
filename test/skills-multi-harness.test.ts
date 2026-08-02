import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HARNESS_CAPABILITIES } from "../src/shared/harness-capabilities.ts";
import { AGENT_TYPES } from "../src/shared/types.ts";
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
// pi declares a skills dir too, so it MUST be pinned here as well - the reconcile folds over
// `skillsDirs()`, so an unpinned `PI_SKILLS_DIR` would write into the operator's real
// `~/.pi/agent/skills` (the same trap this file's comment already warns about for Codex).
const piSkills = join(home, "pi-skills");
const catalogDir = join(home, "catalog");
process.env.CLAUDE_SKILLS_DIR = claudeSkills;
process.env.CODEX_SKILLS_DIR = codexSkills;
process.env.PI_SKILLS_DIR = piSkills;
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
  for (const dir of [claudeSkills, codexSkills, piSkills, catalogDir]) {
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

// ---- the test-runner guard ----
//
// These name the machine's ACTUAL skills directories, which is the one thing every other
// test in this suite exists to avoid. So they are built so that a guard which has stopped
// working fails the assertion instead of performing the deletion:
//
//   `cfg.enabled` with an UNREADABLE catalog returns from `reconcileOneDir` before it reads
//   the directory, let alone writes to it. Absence of evidence is not evidence, and this
//   file leans on that: with the guard removed the call is inert and `assert.throws` simply
//   fails. A regression here costs a red test, never the operator's skills.
//
// `uninstallSkillLinks` cannot be defused that way - it supplies its own config, and the
// empty desired set is precisely what unlinks everything - so it is exercised in the child
// process below, against a fake `$HOME`, where a failed guard has nothing real to destroy.
const INERT: Catalog = { readable: false, skills: [], present: new Set(), problems: ["unreadable"] };

test("a pass over the machine's REAL skills directory is refused under the test runner", () => {
  // The fold's isolation is one env var per harness, and the count of harnesses grows.
  // `install-hooks.test.ts` pinned `CLAUDE_SKILLS_DIR` and nothing else, which was complete
  // isolation until Codex and pi declared a `skills` spec - after which every `npm run test`
  // unlinked the operator's live `mission-*` skills out of `~/.agents/skills` and
  // `~/.pi/agent/skills`, went green, and left the next Codex session refused at a workflow's
  // Pull Request action for a skill nobody had switched off.
  //
  // So the walk refuses the real paths outright rather than trusting every test file to
  // remember a list that keeps growing. Asserted for EVERY declaring harness, so the harness
  // added next year is covered by declaring `homeDir` - the same declaration that would
  // otherwise put it in harm's way.
  for (const agent of AGENT_TYPES) {
    const spec = HARNESS_CAPABILITIES[agent].skills;
    if (!spec) continue;
    assert.throws(
      () => reconcileSkillLinks(mkCfg({ skills: { alpha: true } }), INERT, [join(homedir(), ...spec.homeDir)]),
      /refusing to reconcile/,
      `${agent}'s real directory must be refused`,
    );
  }
});

test("the refusal names a fix the caller can apply", () => {
  // A guard whose message is "no" is a guard someone deletes. This one has to say which
  // knob restores isolation, because the caller it fires on is a test file whose author
  // believed they had already set it.
  const real = join(homedir(), ...(HARNESS_CAPABILITIES.claude.skills?.homeDir ?? []));
  assert.throws(() => reconcileSkillLinks(mkCfg({ skills: { alpha: true } }), INERT, [real]), (err: Error) => {
    assert.match(err.message, /MISSION_HOME/, "the one variable that isolates every harness");
    assert.match(err.message, /CLAUDE_SKILLS_DIR/);
    assert.match(err.message, /CODEX_SKILLS_DIR/);
    assert.match(err.message, /PI_SKILLS_DIR/);
    return true;
  });
});

/**
 * The child that proves the guard by trying to defeat it, run against a throwaway `$HOME`
 * so a spelling that gets through destroys a fake install and not the operator's.
 *
 * Written as a real reconcile against a real seeded link, because the assertion that matters
 * is "the link is still there", and a guard is only worth what the disk says afterwards.
 * Both entry points, because `uninstallSkillLinks` is the one that did the damage.
 */
const GUARD_PROBE = `
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const { reconcileSkillLinks, uninstallSkillLinks } = await import("./src/server/skills/reconcile.ts");

const home = homedir();
const live = join(home, ".agents", "skills");
const source = join(home, "their-skill");
const aliasDir = join(home, "alias-agents");
const OFF = { enabled: false, skills: {}, generation: 0, generationAt: 0 };
const READABLE = { readable: true, skills: [], present: new Set(), problems: [] };

// A catalog with something in it, for the ABSENT cases below: an empty desired set removes
// nothing and creates nothing, so it could not tell an allowed pass from a refused one.
const catalogDir = process.env.MISSION_SKILLS_DIR;
mkdirSync(join(catalogDir, "alpha"), { recursive: true });
writeFileSync(join(catalogDir, "alpha", "SKILL.md"), "---\\nname: alpha\\n---\\nbody\\n");
const ON = { enabled: true, skills: { alpha: true }, generation: 0, generationAt: 0 };
const WITH_ALPHA = { readable: true, skills: [], present: new Set(["alpha"]), problems: [] };

function seed() {
  rmSync(live, { recursive: true, force: true });
  mkdirSync(live, { recursive: true });
  mkdirSync(source, { recursive: true });
  symlinkSync(source, join(live, "mission-alpha"), "dir");
}

// Once, not per seed: it points at ".agents", which seed() re-creates but never removes.
// Re-making it each time meant REMOVING it each time, and \`rmSync\` on a symlink to a
// directory is not portable - it raised ERR_FS_EISDIR on CI's node 24 Linux runner while
// passing on node 26 there and on node 24 locally under macOS. Creating it once needs no
// removal and so has no version to be wrong about.
seed();
symlinkSync(join(home, ".agents"), aliasDir, "dir");

// String concatenation, not join(): join() would normalise the spelling away before the
// guard ever saw it, which is how the first cut of these cases passed against a guard that
// could not handle them.
//
// \`absent\` flips the question from "was the live link destroyed?" to "was a live directory
// CREATED?". Both are ways of writing into the operator's home, and the second one only
// appears when the directory is not there yet - the state where no inode exists to compare
// and the check has nothing but the spelling to go on.
const SPELLINGS = {
  exact: { spell: () => live },
  trailingSlash: { spell: () => live + "/" },
  doubleSlash: { spell: () => join(home, ".agents") + "//skills" },
  dotDot: { spell: () => join(home, ".agents") + "/skills/../skills" },
  symlinkedParent: { spell: () => join(aliasDir, "skills") },
  upperCase: { spell: () => join(home, ".AGENTS", "skills") },
  exactAbsent: { absent: true, spell: () => live },
  upperCaseAbsent: { absent: true, spell: () => join(home, ".AGENTS", "skills") },
};

const out = {};
for (const [name, { spell, absent }] of Object.entries(SPELLINGS)) {
  out[name] = {};
  // An absent directory has nothing to unlink, so the destructive entry point has nothing
  // to say about it; the creating one is the whole question.
  const entries = absent
    ? [["reconcile", (d) => reconcileSkillLinks(ON, WITH_ALPHA, [d])]]
    : [
        ["reconcile", (d) => reconcileSkillLinks(OFF, READABLE, [d])],
        ["uninstall", (d) => uninstallSkillLinks([d])],
      ];
  for (const [entry, call] of entries) {
    if (absent) rmSync(join(home, ".agents"), { recursive: true, force: true });
    else seed();
    let refused = false;
    try {
      call(spell());
    } catch (err) {
      refused = /refusing to reconcile/.test(err.message);
    }
    out[name][entry] = absent
      ? { refused, intact: !existsSync(join(home, ".agents")) }
      : { refused, intact: readdirSync(live).includes("mission-alpha") };
  }
}
console.log(JSON.stringify(out));
`;

test("no spelling of a live skills directory gets past the guard", () => {
  // Two review findings, one test. Round 1: the guard compared raw strings, so it guarded a
  // SPELLING rather than a DIRECTORY - a trailing slash and a symlinked scratch path each
  // walked through and deleted the seeded link, and on macOS so did a case variant.
  // Round 3: the same weakness survives wherever the inode cannot speak, which is precisely
  // when the directory does not exist yet - and there the pass CREATES the operator's skills
  // directory and links a temp catalog into it, which dangles the moment the temp dir goes.
  // Both were reproduced against a fake $HOME before either was fixed.
  const fakeHome = join(home, "guard-probe-home");
  const probeCatalog = join(home, "guard-probe-catalog");
  mkdirSync(fakeHome, { recursive: true });
  mkdirSync(probeCatalog, { recursive: true });

  const out = execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", GUARD_PROBE],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      // MISSION_SKILLS_DIR so the child's own catalog is what a permitted pass would link
      // FROM, rather than this repo's real `skills/`.
      env: { ...process.env, HOME: fakeHome, MISSION_SKILLS_DIR: probeCatalog },
      encoding: "utf8",
    },
  );

  const results = JSON.parse(out.trim().split("\n").filter(Boolean).at(-1) ?? "{}") as
    Record<string, Record<string, { refused: boolean; intact: boolean }>>;

  assert.deepEqual(
    Object.keys(results).sort(),
    ["dotDot", "doubleSlash", "exact", "exactAbsent", "symlinkedParent", "trailingSlash", "upperCase", "upperCaseAbsent"],
    "every spelling was attempted",
  );

  for (const [name, entries] of Object.entries(results)) {
    for (const [entry, { refused, intact }] of Object.entries(entries)) {
      // The assertion that actually matters, and the reason the child works on a real disk
      // rather than asserting a return value: whatever the guard decided, the operator's home
      // is untouched afterwards - the seeded link still there, or the directory still absent.
      assert.equal(intact, true, `${entry} via ${name} wrote into the operator's home`);
      assert.equal(refused, true, `${entry} via ${name} was not refused`);
    }
  }
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
  delete env.PI_SKILLS_DIR;

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
  assert.deepEqual(
    dirs.sort(),
    [
      join(isolated, "claude-skills"),
      join(isolated, "codex-skills"),
      join(isolated, "pi-skills"),
    ].sort(),
  );
  for (const dir of dirs) {
    assert.ok(dir.startsWith(isolated), `${dir} escaped the isolated home`);
  }
});
