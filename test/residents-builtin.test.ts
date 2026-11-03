import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Built-in residents: installed at daemon start, replaced by a NEW revision when an upgrade
// changes them (so a pinned run keeps what it launched with), refused every edit and archive,
// reserved by name, left out of settings snapshots, never archived by a restore, and shadowed
// by an operator profile that already held the name.

const home = mkdtempSync(join(tmpdir(), "mission-residents-builtin-"));
process.env.HARNESS_HOME = join(home, "state");
process.env.CLAUDE_SETTINGS_PATH = join(home, "claude-settings.json");

const root = resolve(import.meta.dirname, "..");

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { WorkflowStore } = await import("../src/server/workflows/store.ts");
const { SettingsBackupService } = await import("../src/server/settings-backups/service.ts");
const { SettingsBackupStore } = await import("../src/server/settings-backups/store.ts");
const { ResidentManager } = await import("../src/server/residents/manager.ts");
const store = await import("../src/server/residents/store.ts");
const { BUILTIN_RESIDENTS, builtinResidentProfileId, builtinResidentsFrom } =
  await import("../src/server/residents/builtin-residents.ts");
const { BUILTIN_RESIDENT_SOURCES } = await import("../src/server/residents/builtin-residents.generated.ts");
const { RESIDENT_LIMITS, ResidentProfileRevisionSchema, residentProfileChoiceName } = await import("../src/shared/residents.ts");

const db = openDb();
const workflowStore = new WorkflowStore(db);
after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => {
  db.exec("DELETE FROM resident_runs; DELETE FROM resident_profile_revisions; DELETE FROM resident_profiles;");
});

const SHEPHERD = builtinResidentProfileId("agent-shepherd");

function settings(name: string, instructions = "Do the thing.") {
  return ResidentProfileRevisionSchema.parse({ identity: { name }, instructions: { markdown: instructions } });
}

function shipped(markdown: string) {
  return builtinResidentsFrom(
    [{ slug: "agent-shepherd", instructionsMarkdown: markdown }],
    { "agent-shepherd": { execution: { agent: "claude", model: "claude-sonnet-5-5", effort: "xhigh" } } },
  );
}

function manager(registry = new Registry()) {
  return new ResidentManager({
    registry,
    createTask: () => { throw new Error("no launches here"); },
    persona: () => null,
  });
}

test("the committed module is exactly what regenerating residents/*.md produces", async () => {
  const { NON_RESIDENT_DOCUMENTS, builtinResidentSources, renderBuiltinResidentModule } =
    await import("../scripts/builtin-residents.ts");
  const dir = join(root, "residents");
  assert.equal(
    readFileSync(join(root, "src", "server", "residents", "builtin-residents.generated.ts"), "utf8"),
    renderBuiltinResidentModule(builtinResidentSources(dir)),
    "run `npm run residents` and commit the result",
  );
  const excluded = new Set<string>(NON_RESIDENT_DOCUMENTS);
  const documents = readdirSync(dir).filter((entry) => entry.endsWith(".md") && !excluded.has(entry));
  assert.equal(BUILTIN_RESIDENT_SOURCES.length, documents.length);
});

test("Agent Shepherd ships as a launchable built-in whose whole role is its document", () => {
  const shepherd = BUILTIN_RESIDENTS.find((builtin) => builtin.id === SHEPHERD);
  assert.ok(shepherd, "Agent Shepherd is in the catalog");
  assert.equal(shepherd.settings.identity.name, "Agent Shepherd");
  assert.match(shepherd.settings.identity.description, /^Keeps your agents moving along/);
  assert.equal(shepherd.settings.persona.personaId, "", "no Persona to go missing on another machine");
  assert.equal(
    shepherd.settings.instructions.markdown,
    readFileSync(join(root, "residents", "agent-shepherd.md"), "utf8"),
  );
  assert.equal(shepherd.settings.authority.controlOtherSessions, true);
  assert.equal(manager().settingsProblem(shepherd.settings), null, "the shipped settings are launchable");
});

test("a document without settings, or settings without a document, fails at load", () => {
  assert.throws(() => builtinResidentsFrom([{ slug: "orphan", instructionsMarkdown: "# Orphan\n" }], {}), /has no settings/);
  assert.throws(() => builtinResidentsFrom([], { ghost: {} }), /has no residents\/ghost\.md/);
});

test("reconcile installs once, then appends a revision only when the shipped settings change", () => {
  const [v1] = shipped("# Agent Shepherd\n\nFirst.\n");
  const installed = store.reconcileBuiltinResidentProfiles([v1!], 10);
  assert.equal(installed.length, 1);
  const first = store.getResidentProfile(SHEPHERD)!;
  assert.equal(first.revision, 1);
  assert.equal(first.builtin, true);
  assert.equal(first.name, "Agent Shepherd");

  assert.deepEqual(store.reconcileBuiltinResidentProfiles([v1!], 20), [], "an unchanged restart writes nothing");
  assert.equal(store.getResidentProfile(SHEPHERD)!.updatedAt, 10);

  const [v2] = shipped("# Agent Shepherd\n\nSecond.\n");
  store.reconcileBuiltinResidentProfiles([v2!], 30);
  const upgraded = store.getResidentProfile(SHEPHERD)!;
  assert.equal(upgraded.revision, 2, "an upgrade is a new revision, never an edit in place");
  assert.equal(upgraded.settings.instructions.markdown, "# Agent Shepherd\n\nSecond.\n");
  assert.equal(
    store.residentProfileRevision(SHEPHERD, 1)?.instructions.markdown,
    "# Agent Shepherd\n\nFirst.\n",
    "the revision a running resident pinned is still readable",
  );
});

test("reconcile refuses an id outside the built-in namespace", () => {
  assert.throws(
    () => store.reconcileBuiltinResidentProfiles([{ id: "operator-id", settings: settings("Sneaky") }], 1),
    /must start with builtin:/,
  );
});

test("a built-in cannot be edited or archived, through the store or the manager", () => {
  store.reconcileBuiltinResidentProfiles(BUILTIN_RESIDENTS, 1);
  const edit = store.updateResidentProfile({ id: SHEPHERD, expectedRevision: 1, settings: settings("Agent Shepherd", "mine"), at: 2 });
  assert.equal(edit.status, "builtin");
  assert.equal(store.archiveResidentProfile({ id: SHEPHERD, expectedRevision: 1, at: 2 }).status, "builtin");

  const residents = manager();
  const refusedEdit = residents.updateProfile(SHEPHERD, 1, settings("Agent Shepherd", "mine"));
  assert.equal(refusedEdit.ok, false);
  if (!refusedEdit.ok) {
    assert.equal(refusedEdit.status, 409);
    assert.match(refusedEdit.error, /ships with Mission Control and cannot be edited; duplicate it/);
  }
  const refusedArchive = residents.archiveProfile(SHEPHERD, 1);
  assert.equal(refusedArchive.ok, false);
  if (!refusedArchive.ok) assert.match(refusedArchive.error, /cannot be archived/);

  const after = store.getResidentProfile(SHEPHERD)!;
  assert.equal(after.revision, 1);
  assert.equal(after.archivedAt, null);
});

test("Duplicate's copy is an ordinary profile, and the built-in name stays reserved", () => {
  store.reconcileBuiltinResidentProfiles(BUILTIN_RESIDENTS, 1);
  const shepherd = store.getResidentProfile(SHEPHERD)!;
  const residents = manager();

  const copy = residents.createProfile({
    ...shepherd.settings,
    identity: { ...shepherd.settings.identity, name: "Agent Shepherd copy" },
  });
  assert.equal(copy.ok, true);
  if (!copy.ok) return;
  assert.equal(copy.profile.builtin, undefined);
  assert.equal(copy.profile.settings.instructions.markdown, shepherd.settings.instructions.markdown);
  const edited = residents.updateProfile(copy.profile.id, 1, { ...copy.profile.settings, instructions: { markdown: "Mine now." } });
  assert.equal(edited.ok, true, "the copy is editable");

  const taken = residents.createProfile(settings("agent  SHEPHERD"));
  assert.equal(taken.ok, false);
  if (!taken.ok) assert.match(taken.error, /built-in resident's name/);
  const renamed = residents.updateProfile(copy.profile.id, 2, settings("Agent Shepherd"));
  assert.equal(renamed.ok, false, "renaming into a built-in's name is refused");
});

test("an operator profile that held the name before it shipped keeps it and its data, and both stay listed", () => {
  store.createResidentProfile({ id: "mine", settings: settings("Agent Shepherd", "my brief"), at: 1 });
  store.reconcileBuiltinResidentProfiles(BUILTIN_RESIDENTS, 2);

  const live = store.listLiveResidentProfiles();
  assert.deepEqual(live.map((profile) => profile.id).sort(), ["builtin:agent-shepherd", "mine"]);
  const saved = store.updateResidentProfile({ id: "mine", expectedRevision: 1, settings: settings("Agent Shepherd", "edited"), at: 3 });
  assert.equal(saved.status, "ok", "keeping its own name is not a rename into the built-in's");

  const after = store.listLiveResidentProfiles();
  const mine = after.find((profile) => profile.id === "mine")!;
  const shepherd = after.find((profile) => profile.id === SHEPHERD)!;
  assert.equal(mine.settings.instructions.markdown, "edited", "the operator's profile and its data are untouched");
  assert.equal(mine.builtin, undefined, "and it stays the operator's, editable");
  assert.equal(shepherd.builtin, true, "the built-in is installed beside it, never hidden behind it");
  // Two choices that read the same are told apart wherever they are offered.
  assert.equal(residentProfileChoiceName(mine), "Agent Shepherd");
  assert.equal(residentProfileChoiceName(shepherd), "Agent Shepherd (built-in)");
});

test("settings snapshots leave built-ins out, and a restore never archives one", async () => {
  store.reconcileBuiltinResidentProfiles(BUILTIN_RESIDENTS, 1);
  store.createResidentProfile({ id: "a", settings: settings("Triage Bot"), at: 1 });
  const backups = join(home, "backups");
  const service = () => new SettingsBackupService(
    workflowStore,
    new SettingsBackupStore(backups),
    () => new Date("2026-11-03T18:00:00.000Z"),
    "residents-builtin-test",
    { registry: new Registry(), preflightSkills: () => [], preflightCost: () => {}, reconcileSkills: () => {}, reconcileCost: () => {} },
  );
  const captured = await service().ensureDailySnapshot("2026-11-03");
  assert.equal(captured.status, "ready");
  if (captured.status !== "ready") return;
  const rows = captured.snapshot.domains.find((domain) => domain.domain === "resident-profiles")?.payload as Array<{ id: string }>;
  assert.deepEqual(rows.map((row) => row.id), ["a"]);

  const restored = await service().restore(captured.snapshot.id, captured.snapshot.digest);
  assert.equal(restored.status, "restored", JSON.stringify(restored));
  const shepherd = store.getResidentProfile(SHEPHERD)!;
  assert.equal(shepherd.archivedAt, null, "a snapshot that omits a built-in does not archive it");
  assert.equal(shepherd.revision, 1);
});

test("the restore write boundary refuses a snapshot row that claims a built-in id", () => {
  store.reconcileBuiltinResidentProfiles(BUILTIN_RESIDENTS, 1);
  assert.throws(
    () => store.restoreResidentProfilesInTransaction([
      { id: SHEPHERD, name: "Agent Shepherd", archivedAt: null, createdAt: 1, settings: settings("Agent Shepherd", "hijack") },
    ], 2),
    /belongs to a built-in/,
  );
  assert.equal(store.getResidentProfile(SHEPHERD)!.revision, 1, "rolled back");
});

test("built-ins do not count toward the live operator profile bound", () => {
  store.reconcileBuiltinResidentProfiles(BUILTIN_RESIDENTS, 1);
  for (let i = 0; i < RESIDENT_LIMITS.liveProfiles; i += 1) {
    store.createResidentProfile({ id: `p${i}`, settings: settings(`Profile ${i}`), at: 1 });
  }
  assert.throws(
    () => store.createResidentProfile({ id: "one-more", settings: settings("One more"), at: 1 }),
    store.ResidentProfileLimitError,
  );
  const live = store.listLiveResidentProfiles();
  assert.equal(live.length, RESIDENT_LIMITS.liveProfiles + 1, "a full operator catalog still lists the built-in");
  assert.ok(live.some((profile) => profile.id === SHEPHERD));
});
