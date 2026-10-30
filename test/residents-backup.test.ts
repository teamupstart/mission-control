import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

test("a snapshot carries every live profile and only the most recent archived ones, staying within the file limit with maximum instruction and loop text", async () => {
  const archivedCap = RESIDENT_LIMITS.archivedInSnapshot;
  // Maximum instruction and loop text, the live catalog full, and more archived history
  // than a snapshot carries.
  const big = (name: string) => ResidentProfileRevisionSchema.parse({
    identity: { name, description: "d".repeat(RESIDENT_LIMITS.descriptionLength) },
    persona: { personaId: "builtin:code-risk-reviewer" },
    instructions: { markdown: "é".repeat(RESIDENT_LIMITS.instructionsLength) },
    loop: { prompt: "é".repeat(8_000), compactionFocus: "é".repeat(2_000) },
  });
  const insertProfile = db.prepare(`INSERT INTO resident_profiles (id, name, normalized_name, revision, archived_at, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, ?)`);
  const insertRevision = db.prepare(`INSERT INTO resident_profile_revisions (profile_id, revision, settings_json, created_at) VALUES (?, 1, ?, 1)`);
  db.exec("BEGIN");
  for (let i = 1; i <= RESIDENT_LIMITS.liveProfiles; i += 1) {
    const id = `live-${String(i).padStart(4, "0")}`;
    insertProfile.run(id, `Live ${i}`, `live ${i}`, null, 1);
    insertRevision.run(id, JSON.stringify(big(`Live ${i}`)));
  }
  // archivedCap + 50 archived: archived_at 1..50 are the oldest, so they are left out.
  for (let i = 1; i <= archivedCap + 50; i += 1) {
    const id = `archived-${String(i).padStart(4, "0")}`;
    insertProfile.run(id, `Archived ${i}`, `archived ${i}`, i, i);
    insertRevision.run(id, JSON.stringify(big(`Archived ${i}`)));
  }
  db.exec("COMMIT");

  const root = join(home, "archived-history");
  const svc = service(root);
  const captured = await svc.ensureDailySnapshot("2026-10-30");
  assert.equal(captured.status, "ready", JSON.stringify(captured).slice(0, 300));
  if (captured.status !== "ready") return;
  const rows = captured.snapshot.domains.find((entry) => entry.domain === "resident-profiles")?.payload as Array<{ id: string; archivedAt: number | null }>;
  assert.equal(rows.filter((row) => row.archivedAt === null).length, RESIDENT_LIMITS.liveProfiles, "every live profile is carried");
  assert.equal(rows.filter((row) => row.archivedAt !== null).length, archivedCap);
  const ids = new Set(rows.map((row) => row.id));
  assert.ok(ids.has(`archived-${String(archivedCap + 50).padStart(4, "0")}`), "the most recently archived is carried");
  assert.ok(!ids.has("archived-0001") && !ids.has("archived-0050"), "the oldest archived are left out");
  const bytes = readFileSync(join(root, `${captured.snapshot.id}.json`)).length;
  console.log(`maximum-text resident snapshot: ${bytes} bytes of ${SETTINGS_BACKUP_LIMITS.fileBytes}`);
  assert.ok(bytes < SETTINGS_BACKUP_LIMITS.fileBytes, `maximum-text snapshot is ${bytes} bytes`);

  // Restoring it on the same machine changes no omitted profile.
  const restored = await svc.restore(captured.snapshot.id, captured.snapshot.digest);
  assert.equal(restored.status, "restored", JSON.stringify(restored));
  assert.equal(store.listLiveResidentProfiles().length, RESIDENT_LIMITS.liveProfiles);
  const oldest = store.getResidentProfile("archived-0001");
  assert.equal(oldest?.archivedAt, 1, "an omitted archived profile stays archived");
  assert.equal(oldest?.revision, 1);
  assert.equal(store.residentProfileRevision("archived-0001", 1)?.identity.name, "Archived 1", "its pinned revision is kept");
});

test("a newer build's sections travel through a snapshot, onto a fresh installation and over an existing profile", async () => {
  store.createResidentProfile({ id: "fwd", settings: settings("Forward", "v1"), at: 1 });
  const newer = { ...settings("Forward", "v1"), marker: { color: "cyan" } };
  db.prepare("UPDATE resident_profile_revisions SET settings_json = ? WHERE profile_id = 'fwd' AND revision = 1")
    .run(JSON.stringify(newer));
  const root = join(home, "forward-compat");
  const svc = service(root);
  const captured = await svc.ensureDailySnapshot("2026-10-30");
  if (captured.status !== "ready") assert.fail(captured.status);
  const rows = captured.snapshot.domains.find((entry) => entry.domain === "resident-profiles")?.payload as Array<{ id: string; settings: Record<string, unknown> }>;
  assert.deepEqual(rows.find((row) => row.id === "fwd")?.settings.marker, { color: "cyan" }, "the snapshot carries it");

  // A fresh installation: the profile is recreated with the section intact.
  db.exec("DELETE FROM resident_profile_revisions; DELETE FROM resident_profiles;");
  const fresh = await svc.restore(captured.snapshot.id, captured.snapshot.digest);
  assert.equal(fresh.status, "restored", JSON.stringify(fresh));
  assert.deepEqual(store.storedResidentSettings("fwd", 1)?.marker, { color: "cyan" });

  // Over an existing profile whose current revision holds a key the snapshot does not: kept.
  db.prepare("UPDATE resident_profile_revisions SET settings_json = ? WHERE profile_id = 'fwd' AND revision = 1")
    .run(JSON.stringify({ ...newer, futureLoop: { cadence: 300 } }));
  const again = await svc.restore(captured.snapshot.id, captured.snapshot.digest);
  assert.equal(again.status, "restored", JSON.stringify(again));
  const current = store.getResidentProfile("fwd")!;
  const stored = store.storedResidentSettings("fwd", current.revision)!;
  assert.deepEqual(stored.marker, { color: "cyan" });
  assert.deepEqual(stored.futureLoop, { cadence: 300 });
});

test("a snapshot predating skill sources validates and restores without clearing registrations", async () => {
  const { saveResidentSkillSources } = await import("../src/server/residents/skill-index.ts");
  const { APP_CONFIG_ENTRIES } = await import("../src/shared/app-config-entries.ts");
  const { getAppConfig } = await import("../src/server/db.ts");
  const config = { directories: [{ id: "custom-00000000-0000-0000-0000-000000000001", path: join(home, "skills") }] };
  saveResidentSkillSources(config);
  const captured = await service(join(home, "before-skill-sources")).ensureDailySnapshot("2026-10-30");
  assert.equal(captured.status, "ready");
  if (captured.status !== "ready") return;
  const { digest: _digest, ...body } = captured.snapshot;
  const old = createSettingsBackupEnvelope({ ...body, domains: body.domains.filter((entry) => entry.domain !== "resident-skill-sources") });
  validateSettingsBackupDomains(old);
  const { migrateSettingsBackupSnapshot } = await import("../src/server/settings-backups/restore.ts");
  const { stageSettingsConfigRestore, restoreSettingsConfigInTransaction } = await import("../src/server/settings-backups/config-registry.ts");
  restoreSettingsConfigInTransaction(db, stageSettingsConfigRestore(migrateSettingsBackupSnapshot(old).settings));
  assert.deepEqual(getAppConfig(APP_CONFIG_ENTRIES.residentSkillSources), config);
});

test("a snapshot carries custom MCP server definitions and never a secret value", async () => {
  const { createResidentMcpServer } = await import("../src/server/residents/mcp-store.ts");
  const { CreateResidentMcpServerSchema } = await import("../src/shared/resident-mcp.ts");
  db.exec("DELETE FROM app_config; DELETE FROM resident_mcp_secrets;");
  const secret = "backup-sentinel-secret-4417";
  createResidentMcpServer(CreateResidentMcpServerSchema.parse({
    name: "linear",
    harnesses: ["claude"],
    transport: { type: "http", url: `https://mcp.example.com/mcp?key=${secret}`, headers: [{ name: "Authorization", secret: true, value: `Bearer ${secret}` }] },
  }) as never, { id: "00000000-0000-4000-8000-000000000042", at: 1, globals: new Map() });
  const root = join(home, "mcp-servers");
  const captured = await service(root).ensureDailySnapshot("2026-10-30");
  assert.equal(captured.status, "ready");
  if (captured.status !== "ready") return;
  const entry = captured.snapshot.domains.find((domain) => domain.domain === "resident-mcp-servers");
  const payload = JSON.stringify(entry?.payload);
  assert.match(payload, /"name":"linear"/);
  assert.match(payload, /"query":\["key"\]/);
  assert.ok(!readFileSync(join(root, `${captured.snapshot.id}.json`), "utf8").includes(secret), "the snapshot file holds no secret");
});

test("restoring a snapshot keeps a secret only if it was set before the snapshot for an unchanged connection", async () => {
  const mcp = await import("../src/server/residents/mcp-store.ts");
  const { CreateResidentMcpServerSchema } = await import("../src/shared/resident-mcp.ts");
  db.exec("DELETE FROM app_config; DELETE FROM resident_mcp_secrets;");
  // Disposable sentinels. The snapshot is taken at the service's clock, 2026-10-30T18:00Z.
  const snapshotAt = Date.parse("2026-10-30T18:00:00.000Z");
  const before = snapshotAt - 60_000;
  const after = snapshotAt + 60_000;
  const original = `restore-original-${crypto.randomUUID()}`;
  const rotated = `restore-rotated-${crypto.randomUUID()}`;
  const kept = `restore-kept-${crypto.randomUUID()}`;
  const moved = `restore-moved-${crypto.randomUUID()}`;
  // An omitted value keeps the stored one, as the editor sends a secret left blank.
  const input = (name: string, command: string, value?: string) => CreateResidentMcpServerSchema.parse({
    name,
    harnesses: ["claude"],
    transport: { type: "stdio", command, args: [], env: [{ name: "TOKEN", secret: true, ...(value === undefined ? {} : { value }) }] },
  }) as import("../src/shared/resident-mcp.ts").CreateResidentMcpServer;
  const ids = {
    rotated: "00000000-0000-4000-8000-000000000051",
    kept: "00000000-0000-4000-8000-000000000052",
    moved: "00000000-0000-4000-8000-000000000053",
    added: "00000000-0000-4000-8000-000000000054",
  };
  mcp.createResidentMcpServer(input("rotated", "srv", original), { id: ids.rotated, at: before, globals: new Map() });
  mcp.createResidentMcpServer(input("kept", "srv", kept), { id: ids.kept, at: before, globals: new Map() });
  mcp.createResidentMcpServer(input("moved", "old-srv", moved), { id: ids.moved, at: before, globals: new Map() });
  const svc = service(join(home, "mcp-restore"));
  const captured = await svc.ensureDailySnapshot("2026-10-30");
  assert.equal(captured.status, "ready");
  if (captured.status !== "ready") return;

  // After the snapshot: one secret is replaced with an identical definition, one server points
  // somewhere else while its secret stays, and a new server is added.
  mcp.updateResidentMcpServer(ids.rotated, { ...input("rotated", "srv", rotated), expectedRevision: 1 }, { at: after, globals: new Map() });
  // An edit cannot carry a secret to a new connection, so the new value is entered with it. The
  // row is then backdated: a value that predates the snapshot yet belongs to another connection,
  // as one carried in from another machine's history would.
  const movedNew = `restore-moved-new-${crypto.randomUUID()}`;
  mcp.updateResidentMcpServer(ids.moved, { ...input("moved", "new-srv", movedNew), expectedRevision: 1 }, { at: after, globals: new Map() });
  db.prepare("UPDATE resident_mcp_secrets SET updated_at = ? WHERE server_id = ?").run(before, ids.moved);
  mcp.createResidentMcpServer(input("added", "srv", `restore-added-${crypto.randomUUID()}`), { id: ids.added, at: after, globals: new Map() });
  assert.equal(mcp.customSecretValues(ids.rotated).get("env:TOKEN"), rotated);
  assert.equal(mcp.customSecretValues(ids.moved).get("env:TOKEN"), movedNew);

  // The clearing is part of the restore's transaction: a restore that fails clears nothing.
  const failing = new SettingsBackupService(
    workflowStore,
    new SettingsBackupStore(join(home, "mcp-restore")),
    () => new Date("2026-10-30T18:00:00.000Z"),
    "residents-test",
    {
      registry: new Registry(),
      preflightSkills: () => [],
      preflightCost: () => {},
      reconcileSkills: () => {},
      reconcileCost: () => {},
      beforeCommit: () => { throw new Error("rollback seam"); },
    },
  );
  assert.equal((await failing.restore(captured.snapshot.id, captured.snapshot.digest)).status, "restore_failed");
  assert.equal(mcp.customSecretValues(ids.rotated).get("env:TOKEN"), rotated, "a failed restore clears nothing");

  const restored = await svc.restore(captured.snapshot.id, captured.snapshot.digest);
  assert.equal(restored.status, "restored");
  const views = new Map(mcp.residentMcpServerViews().map((server) => [server.id, server]));
  assert.deepEqual([...views.keys()].sort(), [ids.rotated, ids.kept, ids.moved].sort(), "the later server is gone");
  // The snapshot never held a value, so a value set after it cannot be what it restores.
  assert.equal(mcp.customSecretValues(ids.rotated).size, 0, "a value replaced after the snapshot is Not set");
  // A value set for another connection never follows the restored definition back.
  assert.equal(mcp.customSecretValues(ids.moved).size, 0, "a value whose connection the restore replaces is Not set");
  assert.equal(mcp.customSecretValues(ids.kept).get("env:TOKEN"), kept, "a value untouched since the snapshot, on an unchanged connection, stays");
  assert.equal(mcp.customSecretValues(ids.added).size, 0, "a server the snapshot does not hold leaves no value behind");
  const views2 = JSON.stringify([...views.values()]);
  for (const value of [original, rotated, kept, moved, movedNew]) assert.ok(!views2.includes(value));
});
