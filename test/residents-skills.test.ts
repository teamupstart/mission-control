import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os, { homedir, tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const root = mkdtempSync(join(tmpdir(), "resident-skills-test-"));
process.env.MISSION_HOME = join(root, "state");
after(() => rmSync(root, { recursive: true, force: true }));
const { defaultSkillSources, parseResidentSkill, scanSkillSources, saveResidentSkillSources, residentSkillIndex, validateSkillDirectories } = await import("../src/server/residents/skill-index.ts");
const { ResidentSkillSourcesSchema } = await import("../src/shared/resident-skills.ts");
const { APP_CONFIG_ENTRIES } = await import("../src/shared/app-config-entries.ts");
const { getAppConfig, setAppConfig } = await import("../src/server/db.ts");
const { captureSettingsConfig, stageSettingsConfigRestore, restoreSettingsConfigInTransaction } = await import("../src/server/settings-backups/config-registry.ts");
const { openDb } = await import("../src/server/db.ts");

function skill(path: string, name: string, description = "A fixture") {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nContent\n`);
}
function source(path: string, id = "test") { return { id, path, label: id, custom: true, problems: [] }; }
function directory(path: string) { return { id: `custom-${randomUUID()}`, path }; }

test("predefined ids and roots include daemon CODEX_HOME, with the standard fallback", () => {
  const before = process.env.CODEX_HOME;
  try {
    delete process.env.CODEX_HOME;
    const defaults = defaultSkillSources(root, undefined, join(root, "mission"));
    assert.deepEqual(defaults.map((s) => s.id), ["mission", "claude-global", "agents-global", "codex-global", "claude-builtin", "codex-builtin"]);
    assert.equal(defaults.find((s) => s.id === "codex-global")?.path, join(root, ".codex/skills"));
    process.env.CODEX_HOME = join(root, "custom-codex");
    assert.equal(defaultSkillSources(root).find((s) => s.id === "codex-global")?.path, join(root, "custom-codex/skills"));
    skill(join(root, "custom-codex/skills/example"), "custom-home");
    const catalog = scanSkillSources(defaultSkillSources(root, undefined, join(root, "mission")), { directories: [] });
    assert.ok(catalog.skills.some((s) => s.id === "codex-global:example"));
    assert.ok(catalog.sources.filter((s) => s.id.endsWith("builtin")).every((s) => s.path === null && s.problems.length > 0));
  } finally { if (before === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = before; }
});

test("external YAML supports multiline descriptions and refuses malformed, duplicate and alias metadata", () => {
  assert.deepEqual(parseResidentSkill("---\nname: 'folded'\ndescription: >-\n  First line\n  second line\n---\n"), { name: "folded", description: "First line second line" });
  for (const text of ["no metadata", "---\nname: n\n---", "---\nname: n\nname: m\ndescription: d\n---", "---\nname: [\n---", "---\nname: &x a\ndescription: *x\n---"]) {
    assert.throws(() => parseResidentSkill(text));
  }
});

test("scan reports per-source problems, follows skill links, indexes groups, and keeps independent mission-prefixed skills", () => {
  const path = join(root, "catalog");
  skill(join(path, "good"), "skill-name");
  skill(join(path, "mission-example"), "mission-skill");
  skill(join(path, "group/nested"), "nested-skill");
  symlinkSync(join(path, "good"), join(path, "linked"));
  symlinkSync(path, join(path, "cycle"));
  mkdirSync(join(path, "empty"));
  skill(join(path, "bad"), "[]");
  writeFileSync(join(path, "big"), "not a directory");
  mkdirSync(join(path, "oversized"));
  writeFileSync(join(path, "oversized/SKILL.md"), "x".repeat(128 * 1024 + 1));
  const result = scanSkillSources([source(path, "claude-global"), source(join(root, "missing"))], { directories: [] });
  assert.deepEqual(result.skills.map((s) => s.id).sort(), ["claude-global:good", "claude-global:group/nested", "claude-global:linked", "claude-global:mission-example"]);
  assert.ok(result.sources[0]!.problems.some((p) => p.includes("no SKILL.md")));
  assert.ok(result.sources[0]!.problems.some((p) => p.includes("link cycle")));
  assert.ok(result.sources[0]!.problems.some((p) => p.includes("128 KiB")));
  assert.ok(result.sources[1]!.problems.some((p) => p.includes("missing")));
  assert.ok(scanSkillSources([source(path, "agents-global")], { directories: [] }).skills.some((s) => s.folder === "mission-example"));
  skill(join(path, "good"), "renamed");
  assert.equal(scanSkillSources([source(path, "claude-global")], { directories: [] }).skills.find((s) => s.folder === "good")?.id, "claude-global:good");
});

test("Claude links are omitted only when their resolved skill is indexed by Mission Control", () => {
  const mission = join(root, "duplicate-mission");
  const claude = join(root, "duplicate-claude");
  const external = join(root, "independent-mission");
  skill(join(mission, "example"), "owned-skill");
  skill(join(claude, "mission-example"), "independent-directory");
  skill(external, "independent-link");
  symlinkSync(join(mission, "example"), join(claude, "mission-owned"));
  symlinkSync(external, join(claude, "mission-external"));
  const sources = [source(claude, "claude-global"), source(mission, "mission")];
  for (const ordered of [sources, [...sources].reverse()]) {
    const result = scanSkillSources(ordered, { directories: [] });
    assert.deepEqual(result.skills.map((entry) => entry.id).sort(), [
      "claude-global:mission-example", "claude-global:mission-external", "mission:example",
    ]);
    assert.ok(result.sources.every((entry) => entry.problems.length === 0));
  }
  const standalone = scanSkillSources([sources[0]!], { directories: [] });
  assert.ok(standalone.skills.some((entry) => entry.id === "claude-global:mission-owned"));
});

test("scan refuses child links to home or its ancestors but follows narrow external skill links", (t) => {
  const parent = join(root, "broad-target");
  const home = join(parent, "home");
  const path = join(root, "child-links");
  skill(join(home, "home-skill"), "home-must-not-be-scanned");
  skill(join(parent, "parent-skill"), "parent-must-not-be-scanned");
  skill(join(path, "safe"), "safe");
  mkdirSync(join(path, "group"));
  symlinkSync(home, join(path, "group/home-link"));
  symlinkSync(parent, join(path, "group/parent-link"));
  symlinkSync(join(home, "home-skill"), join(path, "narrow-link"));
  const fixtureHome = t.mock.method(os, "homedir", () => home);
  syncBuiltinESMExports();
  try {
    validateSkillDirectories({ directories: [directory(path)] });
    const result = scanSkillSources([source(path)], { directories: [] });
    assert.deepEqual(result.skills.map((entry) => entry.id), ["test:narrow-link", "test:safe"]);
    assert.deepEqual(result.sources[0]!.problems, [
      "group/home-link: This directory resolves at or above your home. Choose a narrower folder.",
      "group/parent-link: This directory resolves at or above your home. Choose a narrower folder.",
    ]);
  } finally { fixtureHome.mock.restore(); syncBuiltinESMExports(); }
});

test("scan accepts a 128 KiB document and rejects one additional byte", () => {
  const path = join(root, "document-limit");
  const folder = join(path, "bounded");
  mkdirSync(folder, { recursive: true });
  const header = "---\nname: bounded\ndescription: A fixture\n---\n";
  const remaining = 128 * 1024 - Buffer.byteLength(header);
  // Multibyte content distinguishes the file byte limit from a character limit.
  const document = header + "é".repeat(Math.floor(remaining / 2)) + "x".repeat(remaining % 2);
  assert.equal(Buffer.byteLength(document), 128 * 1024);
  writeFileSync(join(folder, "SKILL.md"), document);
  const accepted = scanSkillSources([source(path)], { directories: [] });
  assert.deepEqual(accepted.skills.map((entry) => entry.id), ["test:bounded"]);
  assert.deepEqual(accepted.sources[0]!.problems, []);

  writeFileSync(join(folder, "SKILL.md"), document + "x");
  const rejected = scanSkillSources([source(path)], { directories: [] });
  assert.deepEqual(rejected.skills, []);
  assert.deepEqual(rejected.sources[0]!.problems, ["bounded: SKILL.md must be a file no larger than 128 KiB."]);
});

test("scan accepts 5000 entries including the source root and stops before entry 5001", () => {
  const path = join(root, "entry-limit");
  // The source root consumes one entry; the remaining 4999 entries are skill folders.
  const folders = Array.from({ length: 4999 }, (_, i) => `skill-${String(i + 1).padStart(4, "0")}`);
  for (const folder of folders) skill(join(path, folder), folder);
  const accepted = scanSkillSources([source(path)], { directories: [] });
  assert.deepEqual(accepted.skills.map((entry) => entry.folder), folders);
  assert.deepEqual(accepted.sources[0]!.problems, []);

  skill(join(path, "skill-5000"), "beyond-limit");
  const capped = scanSkillSources([source(path)], { directories: [] });
  // When truncated, the bounded prefix follows filesystem enumeration order.
  assert.equal(capped.skills.length, 4999);
  const allFolders = new Set([...folders, "skill-5000"]);
  assert.ok(capped.skills.every((entry) => allFolders.has(entry.folder)));
  assert.deepEqual(capped.sources[0]!.problems, ["Source exceeds the 5000-entry scan limit."]);
});

test("ordinary and hidden files consume the shared enumeration budget before grouped skills", () => {
  const path = join(root, "file-entry-limit");
  skill(join(path, "group/skill"), "at-limit");
  // Root, group and skill consume three entries; even ignored files consume the rest.
  for (let i = 0; i < 4997; i++) writeFileSync(join(path, `${i % 2 ? "." : ""}file-${i}`), "");
  const accepted = scanSkillSources([source(path)], { directories: [] });
  assert.deepEqual(accepted.skills.map((entry) => entry.id), ["test:group/skill"]);
  assert.deepEqual(accepted.sources[0]!.problems, []);

  writeFileSync(join(path, "one-more-file"), "");
  const capped = scanSkillSources([source(path)], { directories: [] });
  assert.deepEqual(capped.skills, []);
  assert.deepEqual(capped.sources[0]!.problems, ["Source exceeds the 5000-entry scan limit."]);
});

test("enumeration stops reading after the limit probe and closes the directory handle", (t) => {
  const path = join(root, "enumeration-stop");
  mkdirSync(path);
  for (let i = 0; i < 6000; i++) writeFileSync(join(path, `file-${i}`), "");
  const open = fs.opendirSync;
  let reads = 0;
  let closes = 0;
  const observe = t.mock.method(fs, "opendirSync", (...args: Parameters<typeof fs.opendirSync>) => {
    const handle = open(...args);
    const read = handle.readSync.bind(handle);
    const close = handle.closeSync.bind(handle);
    t.mock.method(handle, "readSync", () => { reads++; return read(); });
    t.mock.method(handle, "closeSync", () => { closes++; close(); });
    return handle;
  });
  syncBuiltinESMExports();
  try {
    const result = scanSkillSources([source(path)], { directories: [] });
    assert.deepEqual(result.skills, []);
    assert.deepEqual(result.sources[0]!.problems, ["Source exceeds the 5000-entry scan limit."]);
    assert.equal(reads, 5000, "4999 entries plus one overflow probe, without draining the folder");
    assert.equal(closes, 1);
  } finally { observe.mock.restore(); syncBuiltinESMExports(); }
});

test("enumeration closes its handle on read failure and continues with other sources", (t) => {
  const path = join(root, "enumeration-error");
  mkdirSync(path);
  const other = join(root, "enumeration-after-error");
  skill(join(other, "valid"), "still-indexed");
  const open = fs.opendirSync;
  let closes = 0;
  const fault = t.mock.method(fs, "opendirSync", (...args: Parameters<typeof fs.opendirSync>) => {
    const handle = open(...args);
    if (String(args[0]) === path) {
      const close = handle.closeSync.bind(handle);
      t.mock.method(handle, "readSync", () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
      t.mock.method(handle, "closeSync", () => { closes++; close(); });
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    const result = scanSkillSources([source(path), source(other, "other")], { directories: [] });
    assert.deepEqual(result.sources[0]!.problems, [`${path}: directory is unreadable.`]);
    assert.deepEqual(result.skills.map((entry) => entry.id), ["other:valid"]);
    assert.equal(closes, 1);
  } finally { fault.mock.restore(); syncBuiltinESMExports(); }
});

test("scan indexes skills at depth six but reports the group before depth seven", () => {
  const path = join(root, "depth-limit");
  const folder = "one/two/three/four/five/six";
  skill(join(path, folder), "at-depth-six");
  const accepted = scanSkillSources([source(path)], { directories: [] });
  assert.deepEqual(accepted.skills.map((entry) => entry.id), [`test:${folder}`]);
  assert.deepEqual(accepted.sources[0]!.problems, []);

  rmSync(join(path, folder, "SKILL.md"));
  skill(join(path, folder, "seven"), "beyond-depth-six");
  const rejected = scanSkillSources([source(path)], { directories: [] });
  assert.deepEqual(rejected.skills, []);
  assert.deepEqual(rejected.sources[0]!.problems, [`${folder}: grouped folders exceed the depth limit of 6.`]);
});

test("scan retains all 100 problems, caps the 101st, and still indexes later valid skills", () => {
  const path = join(root, "problem-limit");
  const folders = Array.from({ length: 100 }, (_, i) => `empty-${String(i + 1).padStart(3, "0")}`);
  for (const folder of folders) mkdirSync(join(path, folder), { recursive: true });
  const expected = folders.map((folder) => `${folder}: no SKILL.md.`);
  const accepted = scanSkillSources([source(path)], { directories: [] });
  assert.deepEqual(accepted.skills, []);
  assert.deepEqual(accepted.sources[0]!.problems, expected);

  mkdirSync(join(path, "empty-101"));
  skill(join(path, "z-valid"), "still-indexed");
  const capped = scanSkillSources([source(path)], { directories: [] });
  assert.deepEqual(capped.sources[0]!.problems, expected);
  assert.deepEqual(capped.skills.map((entry) => entry.id), ["test:z-valid"]);
});

test("scan accepts metadata at 128 and 16000 characters and reports each overlong field", () => {
  const path = join(root, "metadata-limit");
  const name = "n".repeat(128);
  const description = "d".repeat(16000);
  skill(join(path, "name"), name, "d");
  skill(join(path, "description"), "n", description);
  const accepted = scanSkillSources([source(path)], { directories: [] });
  assert.deepEqual(accepted.skills.map((entry) => ({ folder: entry.folder, name: entry.name, description: entry.description })), [
    { folder: "description", name: "n", description },
    { folder: "name", name, description: "d" },
  ]);
  assert.deepEqual(accepted.sources[0]!.problems, []);

  skill(join(path, "name"), name + "n", "d");
  skill(join(path, "description"), "n", description + "d");
  const rejected = scanSkillSources([source(path)], { directories: [] });
  assert.deepEqual(rejected.skills, []);
  assert.deepEqual(rejected.sources[0]!.problems, [
    "description: SKILL.md needs a description of at most 16000 characters.",
    "name: SKILL.md needs a name of at most 128 characters on one line.",
  ]);
});

test("source schema accepts 16 registrations and rejects the 17th", () => {
  const directories = Array.from({ length: 16 }, (_, i) => directory(join(root, `registered-${i}`)));
  assert.deepEqual(ResidentSkillSourcesSchema.parse({ directories }), { directories });
  const rejected = ResidentSkillSourcesSchema.safeParse({ directories: [...directories, directory(join(root, "registered-16"))] });
  assert.ok(!rejected.success);
  assert.deepEqual(rejected.error.issues.map((issue) => ({ code: issue.code, path: issue.path })), [
    { code: "too_big", path: ["directories"] },
  ]);
});

test("source schema accepts a 4096-character path and rejects one additional character", () => {
  const row = directory("/" + "x".repeat(4095));
  assert.deepEqual(ResidentSkillSourcesSchema.parse({ directories: [row] }), { directories: [row] });
  const rejected = ResidentSkillSourcesSchema.safeParse({ directories: [{ ...row, path: row.path + "x" }] });
  assert.ok(!rejected.success);
  assert.deepEqual(rejected.error.issues.map((issue) => ({ code: issue.code, path: issue.path })), [
    { code: "too_big", path: ["directories", 0, "path"] },
  ]);
});

test("registration rejects broad, relative, duplicate, predefined and duplicate-id sources", () => {
  assert.throws(() => validateSkillDirectories({ directories: [directory(homedir())] }));
  assert.throws(() => validateSkillDirectories({ directories: [directory("relative")] }));
  assert.throws(() => validateSkillDirectories({ directories: [directory(root), directory(join(root, "."))] }));
  assert.throws(() => validateSkillDirectories({ directories: [directory(join(homedir(), ".agents/skills"))] }));
  const same = directory(join(root, "deferred"));
  assert.equal(ResidentSkillSourcesSchema.safeParse({ directories: [same, same] }).success, false);
  assert.equal(ResidentSkillSourcesSchema.safeParse({ directories: [{ ...same, id: "mission" }] }).success, false);
  validateSkillDirectories({ directories: [same] });
});

test("saved catalogs remain stable until rescan, and source removal preserves files", () => {
  const path = join(root, "cached");
  skill(join(path, "one"), "one");
  const row = directory(path);
  const initial = saveResidentSkillSources({ directories: [row] });
  skill(join(path, "two"), "two");
  assert.equal(residentSkillIndex(), initial);
  const refreshed = residentSkillIndex(true);
  assert.equal(refreshed.skills.filter((s) => s.sourceId === row.id).length, 2);
  saveResidentSkillSources({ directories: [] });
  assert.ok(!residentSkillIndex().skills.some((s) => s.sourceId === row.id));
  assert.match(readFileSync(join(path, "one/SKILL.md"), "utf8"), /name: one/);
});

test("a registered symlink becoming a home root is refused again on rescan", () => {
  const link = join(root, "retargeted");
  symlinkSync(root, link);
  const row = directory(link);
  saveResidentSkillSources({ directories: [row] });
  rmSync(link);
  symlinkSync(homedir(), link);
  assert.ok(residentSkillIndex(true).sources.find((s) => s.id === row.id)?.problems.some((p) => p.includes("above your home")));
});

test("sources round-trip in settings backups; old snapshots leave the current list intact", () => {
  const config = { directories: [directory(join(root, "backup-source"))] };
  saveResidentSkillSources(config);
  const captured = new Map(captureSettingsConfig().map((entry) => [entry.domain, entry.payload]));
  assert.deepEqual(captured.get("resident-skill-sources"), config);
  saveResidentSkillSources({ directories: [] });
  restoreSettingsConfigInTransaction(openDb(), stageSettingsConfigRestore(captured));
  assert.deepEqual(getAppConfig(APP_CONFIG_ENTRIES.residentSkillSources), config);
  captured.delete("resident-skill-sources");
  const staged = stageSettingsConfigRestore(captured);
  assert.ok(!staged.some((entry) => entry.domain === "resident-skill-sources"));
  restoreSettingsConfigInTransaction(openDb(), staged);
  assert.deepEqual(getAppConfig(APP_CONFIG_ENTRIES.residentSkillSources), config);
});

test("restored invalid source paths are reported and never scanned", () => {
  const row = directory("relative/skills");
  setAppConfig(APP_CONFIG_ENTRIES.residentSkillSources, { directories: [row] });
  const index = residentSkillIndex(true);
  assert.ok(index.sources.find((source) => source.id === row.id)?.problems.some((problem) => problem.includes("not an absolute path")));
  assert.ok(!index.skills.some((skill) => skill.sourceId === row.id));
});
