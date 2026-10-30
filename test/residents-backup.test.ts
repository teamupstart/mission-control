import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Resident profiles in the logical settings backup: captured with their current revision,
// restored as NEW revisions (so a pinned run keeps its revision), archived when absent from
// the snapshot, and left untouched by a snapshot written before the domain existed.

const home = mkdtempSync(join(tmpdir(), "mission-residents-backup-"));
process.env.HARNESS_HOME = join(home, "state");
process.env.CLAUDE_SETTINGS_PATH = join(home, "claude-settings.json");

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { WorkflowStore } = await import("../src/server/workflows/store.ts");
const { SettingsBackupService } = await import("../src/server/settings-backups/service.ts");
const { SettingsBackupStore } = await import("../src/server/settings-backups/store.ts");
const { createSettingsBackupEnvelope, validateSettingsBackupDomains } =
  await import("../src/server/settings-backups/format.ts");
const store = await import("../src/server/residents/store.ts");
const { RESIDENT_LIMITS, ResidentProfileRevisionSchema } = await import("../src/shared/residents.ts");
const { SETTINGS_BACKUP_LIMITS } = await import("../src/shared/settings-backups.ts");

const db = openDb();
const workflowStore = new WorkflowStore(db);

after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => {
  db.exec("DELETE FROM resident_runs; DELETE FROM resident_profile_revisions; DELETE FROM resident_profiles;");
});

function settings(name: string, instructions: string, personaId = "builtin:code-risk-reviewer") {
  return ResidentProfileRevisionSchema.parse({
    identity: { name },
    persona: { personaId },
    instructions: { markdown: instructions },
  });
}

function service(root: string, registry = new Registry()) {
  return new SettingsBackupService(
    workflowStore,
    new SettingsBackupStore(root),
    () => new Date("2026-10-30T18:00:00.000Z"),
    "residents-test",
    {
      registry,
      preflightSkills: () => [],
      preflightCost: () => {},
      reconcileSkills: () => {},
      reconcileCost: () => {},
    },
  );
}

test("a snapshot captures every profile with its current revision and counts them", async () => {
  store.createResidentProfile({ id: "live", settings: settings("Triage Bot", "v1"), at: 1 });
  store.createResidentProfile({ id: "gone", settings: settings("Docs Gardener", "v1"), at: 1 });
  store.archiveResidentProfile({ id: "gone", expectedRevision: 1, at: 2 });
  const svc = service(join(home, "capture"));
  const read = await svc.ensureDailySnapshot("2026-10-30");
  assert.equal(read.status, "ready");
  if (read.status !== "ready") return;
  const entry = read.snapshot.domains.find((domain) => domain.domain === "resident-profiles");
  const rows = entry?.payload as Array<{ id: string; archivedAt: number | null; revision: number }>;
  assert.deepEqual(rows.map((row) => [row.id, row.archivedAt !== null]).sort(), [["gone", true], ["live", false]]);
  assert.equal(read.snapshot.counts.residentProfiles, 2);
});

test("restore writes a new revision for a changed profile, reactivates and archives, and keeps pinned revisions readable", async () => {
  store.createResidentProfile({ id: "a", settings: settings("Triage Bot", "snapshot brief"), at: 1 });
  store.createResidentProfile({ id: "b", settings: settings("Docs Gardener", "docs"), at: 1 });
  const root = join(home, "round-trip");
  const capture = service(root);
  const captured = await capture.ensureDailySnapshot("2026-10-30");
  assert.equal(captured.status, "ready");
  if (captured.status !== "ready") return;

  // After the snapshot: A is edited (a run would pin revision 2), B archived, C created.
  assert.equal(store.updateResidentProfile({ id: "a", expectedRevision: 1, settings: settings("Triage Bot", "later brief"), at: 3 }).status, "ok");
  store.archiveResidentProfile({ id: "b", expectedRevision: 1, at: 3 });
  store.createResidentProfile({ id: "c", settings: settings("Release Watch", "new"), at: 3 });
  // The daemon's live catalog as it stands now: A at revision 2, and C.
  const registry = new Registry();
  const svc = service(root, registry);

  const preview = svc.previewRestore(captured.snapshot.id);
  assert.equal(preview.status, "ready", JSON.stringify(preview));
  if (preview.status !== "ready") return;
  assert.deepEqual(preview.preview.residentProfiles, { added: 0, changed: 1, archived: 1, reactivated: 1 });

  const events: string[] = [];
  registry.subscribe((event) => {
    if (event.type === "resident_profile_upsert" || event.type === "resident_profile_remove") {
      events.push(`${event.type}:${"profile" in event ? event.profile.id : event.id}`);
    }
  });
  const restored = await svc.restore(captured.snapshot.id, captured.snapshot.digest);
  assert.equal(restored.status, "restored", JSON.stringify(restored));

  const a = store.getResidentProfile("a")!;
  assert.equal(a.revision, 3, "a changed profile gets a new revision, never its stored number");
  assert.equal(a.settings.instructions.markdown, "snapshot brief");
  assert.equal(store.residentProfileRevision("a", 2)?.instructions.markdown, "later brief", "the revision a run pinned survives");
  assert.equal(store.getResidentProfile("b")?.archivedAt, null, "reactivated");
  assert.notEqual(store.getResidentProfile("c")?.archivedAt, null, "absent from the snapshot: archived, not deleted");
  assert.deepEqual(
    store.listLiveResidentProfiles().map((profile) => profile.id).sort(),
    ["a", "b"],
  );
  assert.ok(events.includes("resident_profile_remove:c"), events.join());
  assert.ok(events.includes("resident_profile_upsert:a"), events.join());
});

test("a snapshot written before the resident domain existed validates and restores without touching profiles", async () => {
  const root = join(home, "older");
  const svc = service(root);
  const captured = await svc.ensureDailySnapshot("2026-10-30");
  if (captured.status !== "ready") assert.fail(captured.status);
  // Rebuild the snapshot as an older build wrote it: no domain, no count.
  const { digest: _digest, ...body } = structuredClone(captured.snapshot);
  body.domains = body.domains.filter((entry) => entry.domain !== "resident-profiles");
  delete body.counts.residentProfiles;
  const older = createSettingsBackupEnvelope(body);
  assert.doesNotThrow(() => validateSettingsBackupDomains(older));
  new SettingsBackupStore(root).write(older);

  store.createResidentProfile({ id: "kept", settings: settings("Triage Bot", "kept"), at: 5 });
  const preview = svc.previewRestore(older.id);
  if (preview.status !== "ready") assert.fail(JSON.stringify(preview));
  assert.deepEqual(preview.preview.residentProfiles, { added: 0, changed: 0, archived: 0, reactivated: 0 });
  const restored = await svc.restore(older.id, older.digest);
  assert.equal(restored.status, "restored", JSON.stringify(restored));
  assert.equal(store.getResidentProfile("kept")?.archivedAt, null);
  assert.equal(store.getResidentProfile("kept")?.revision, 1);
});

test("a snapshot holding more live profiles than the catalog bound is blocked before anything is written", async () => {
  const root = join(home, "over-limit");
  const svc = service(root);
  const captured = await svc.ensureDailySnapshot("2026-10-30");
  if (captured.status !== "ready") assert.fail(captured.status);
  const { digest: _digest, ...body } = structuredClone(captured.snapshot);
  const rows = Array.from({ length: RESIDENT_LIMITS.liveProfiles + 1 }, (_, i) => ({
    id: `bulk-${i}`,
    name: `Bulk ${i}`,
    normalizedName: `bulk ${i}`,
    revision: 1,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    settings: settings(`Bulk ${i}`, ""),
  }));
  body.domains = body.domains.map((entry) =>
    entry.domain === "resident-profiles" ? { ...entry, payload: rows } : entry);
  body.counts.residentProfiles = rows.length;
  const over = createSettingsBackupEnvelope(body);
  new SettingsBackupStore(root).write(over);

  store.createResidentProfile({ id: "kept", settings: settings("Triage Bot", "kept"), at: 5 });
  const preview = svc.previewRestore(over.id);
  assert.equal(preview.status, "preflight_blocked", JSON.stringify(preview));
  if (preview.status === "preflight_blocked") {
    assert.ok(preview.preview.blockers.some((b) => /201 live resident profiles; at most 200/.test(b)), preview.preview.blockers.join());
  }
  const restored = await svc.restore(over.id, over.digest);
  assert.equal(restored.status, "preflight_blocked");
  assert.deepEqual(store.listLiveResidentProfiles().map((profile) => profile.id), ["kept"]);
});

test("the restore write boundary refuses a catalog past the live bound and rolls the whole restore back", async () => {
  const at = Date.now();
  const rows = Array.from({ length: RESIDENT_LIMITS.liveProfiles + 1 }, (_, i) => ({
    id: `guard-${i}`,
    name: `Guard ${i}`,
    archivedAt: null,
    createdAt: 1,
    settings: settings(`Guard ${i}`, ""),
  }));
  store.createResidentProfile({ id: "kept", settings: settings("Triage Bot", "kept"), at });
  db.exec("BEGIN IMMEDIATE");
  db.prepare("INSERT INTO app_config (key, value) VALUES ('residents-guard-probe', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  assert.throws(() => store.restoreResidentProfilesInTransaction(rows, at), /at most 200/);
  db.exec("ROLLBACK");
  assert.equal(db.prepare("SELECT value FROM app_config WHERE key = 'residents-guard-probe'").get(), undefined, "another domain's write in the same transaction is rolled back");
  assert.deepEqual(store.listLiveResidentProfiles().map((profile) => profile.id), ["kept"]);
});

test("restore is blocked when a resident it leaves live would name a Persona that is not live afterwards", async () => {
  const root = join(home, "persona-guard");
  const svc = service(root);
  const captured = await svc.ensureDailySnapshot("2026-10-30");
  if (captured.status !== "ready") assert.fail(captured.status);

  // An older snapshot (no resident domain) keeps current residents as they are; its Persona
  // catalog has no operator Persona, so a resident on one would be stranded.
  const { digest: _digest, ...body } = structuredClone(captured.snapshot);
  body.domains = body.domains.filter((entry) => entry.domain !== "resident-profiles");
  delete body.counts.residentProfiles;
  const older = createSettingsBackupEnvelope({ ...body, id: "daily-2026-10-29", localDate: "2026-10-29" });
  new SettingsBackupStore(root).write(older);

  store.createResidentProfile({ id: "on-builtin", settings: settings("On builtin", ""), at: 5 });
  const fine = svc.previewRestore(older.id);
  assert.equal(fine.status, "ready", JSON.stringify(fine));

  store.createResidentProfile({ id: "stranded", settings: settings("Stranded", "", "operator-persona-gone"), at: 5 });
  const blocked = svc.previewRestore(older.id);
  assert.equal(blocked.status, "preflight_blocked", JSON.stringify(blocked));
  if (blocked.status === "preflight_blocked") {
    assert.ok(blocked.preview.blockers.some((b) => /Stranded uses Persona operator-persona-gone/.test(b)), blocked.preview.blockers.join());
  }
  assert.equal((await svc.restore(older.id, older.digest)).status, "preflight_blocked");

  // A snapshot that carries the resident domain is checked against its own rows the same way.
  const withResidents = await svc.ensureDailySnapshot("2026-10-31");
  if (withResidents.status !== "ready") assert.fail(withResidents.status);
  assert.ok(withResidents.snapshot.domains.some((entry) => entry.domain === "resident-profiles"));
  const own = svc.previewRestore(withResidents.snapshot.id);
  assert.equal(own.status, "preflight_blocked");
});

test("archived history beyond the catalog limit never stops snapshots, and restoring one changes no omitted profile", async () => {
  const limit = SETTINGS_BACKUP_LIMITS.entriesPerCatalog;
  const insertProfile = db.prepare(`INSERT INTO resident_profiles (id, name, normalized_name, revision, archived_at, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, ?)`);
  const insertRevision = db.prepare(`INSERT INTO resident_profile_revisions (profile_id, revision, settings_json, created_at) VALUES (?, 1, ?, 1)`);
  const body = JSON.stringify(settings("Archived", ""));
  db.exec("BEGIN");
  // limit + 1 archived profiles: archived_at 1 is the oldest, so it is the one left out.
  for (let i = 1; i <= limit + 1; i += 1) {
    const id = `archived-${String(i).padStart(5, "0")}`;
    insertProfile.run(id, `Archived ${i}`, `archived ${i}`, i, i);
    insertRevision.run(id, body);
  }
  db.exec("COMMIT");
  store.createResidentProfile({ id: "live-a", settings: settings("Live A", "a"), at: 10 });
  store.createResidentProfile({ id: "live-b", settings: settings("Live B", "b"), at: 10 });

  const root = join(home, "archived-history");
  const svc = service(root);
  const captured = await svc.ensureDailySnapshot("2026-10-30");
  assert.equal(captured.status, "ready", JSON.stringify(captured).slice(0, 300));
  if (captured.status !== "ready") return;
  const rows = captured.snapshot.domains.find((entry) => entry.domain === "resident-profiles")?.payload as Array<{ id: string; archivedAt: number | null }>;
  assert.equal(rows.length, limit);
  assert.equal(captured.snapshot.counts.residentProfiles, limit);
  const ids = new Set(rows.map((row) => row.id));
  assert.ok(ids.has("live-a") && ids.has("live-b"), "every live profile is carried");
  assert.ok(ids.has(`archived-${String(limit + 1).padStart(5, "0")}`), "the most recently archived is carried");
  assert.ok(!ids.has("archived-00001") && !ids.has("archived-00002") && !ids.has("archived-00003"), "the oldest archived are left out");

  const restored = await svc.restore(captured.snapshot.id, captured.snapshot.digest);
  assert.equal(restored.status, "restored", JSON.stringify(restored));
  assert.deepEqual(store.listLiveResidentProfiles().map((profile) => profile.id).sort(), ["live-a", "live-b"]);
  const oldest = store.getResidentProfile("archived-00001");
  assert.equal(oldest?.archivedAt, 1, "an omitted archived profile is untouched");
  assert.equal(oldest?.revision, 1);
  assert.equal(store.residentProfileRevision("archived-00001", 1)?.identity.name, "Archived", "its pinned revision is kept");
});
