import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalSettingsBackupJson,
  inspectSettingsBackupValue,
  SETTINGS_BACKUP_FORMAT,
  SETTINGS_BACKUP_FORMAT_VERSION,
  SETTINGS_BACKUP_LIMITS,
  type SettingsBackupEnvelopeBodyV1,
  type SettingsBackupEnvelopeV1,
} from "../src/shared/settings-backups.ts";

const home = mkdtempSync(join(tmpdir(), "mission-settings-backups-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { WorkflowStore, clearWorkflowTables } = await import("../src/server/workflows/store.ts");
const { normalizePersonaName, normalizeSessionActionName, normalizeWorkflowName } =
  await import("../src/shared/workflow.ts");
const { captureSettingsCatalogs, settingsCatalogCounts } =
  await import("../src/server/settings-backups/catalogs.ts");
const { captureSettingsConfig } = await import("../src/server/settings-backups/config-registry.ts");
const { createSettingsBackupEnvelope, settingsBackupDigest, settingsBackupFileText } =
  await import("../src/server/settings-backups/format.ts");
const { SettingsBackupService } = await import("../src/server/settings-backups/service.ts");
const { SettingsBackupStore } = await import("../src/server/settings-backups/store.ts");
const { SETTINGS_BACKUPS_DIR } = await import("../src/server/config.ts");

const db = openDb();
const workflowStore = new WorkflowStore(db);

after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => {
  clearWorkflowTables(db);
  db.exec("DELETE FROM app_config");
});

test("the default backup root follows the isolated daemon state home", () => {
  assert.equal(SETTINGS_BACKUPS_DIR, join(process.env.HARNESS_HOME!, "backups", "settings"));
  assert.equal(new SettingsBackupStore().root, SETTINGS_BACKUPS_DIR);
  assert.ok(SETTINGS_BACKUPS_DIR.startsWith(home));
});

const draft = {
  nodes: [
    { id: "session", kind: "session" as const, position: { x: 0, y: 0 } },
    { id: "judge", kind: "persona" as const, personaId: "operator-persona", position: { x: 220, y: 0 } },
    { id: "end", kind: "end" as const, outcome: "Approved", position: { x: 440, y: 0 } },
  ],
  edges: [
    { id: "start", source: "session", sourcePort: "submitted" as const, target: "judge", targetPort: "activate" as const },
    { id: "pass", source: "judge", sourcePort: "pass" as const, target: "end", targetPort: "terminal" as const },
    { id: "fail", source: "judge", sourcePort: "fail" as const, target: "session", targetPort: "return_for_changes" as const },
  ],
};

function seedOperatorCatalogs(): void {
  assert.equal(workflowStore.insertPersona({
    id: "operator-persona",
    name: "Operator Persona",
    normalizedName: normalizePersonaName("Operator Persona"),
    description: "Exact operator row",
    guidanceMarkdown: "# Operator Persona\r\n\r\nKeep exact bytes.  \r\n",
    runner: null,
    model: null,
    createdAt: 10,
    updatedAt: 10,
  }).ok, true);
  assert.equal(workflowStore.insertSessionAction({
    id: "operator-action",
    name: "Operator Action",
    normalizedName: normalizeSessionActionName("Operator Action"),
    description: "Exact operator action",
    promptMarkdown: "# Operator Action\n\nDo the exact thing.\n",
    requiredSkillId: null,
    completion: { kind: "session_turn" },
    createdAt: 11,
    updatedAt: 11,
  }).ok, true);
  assert.equal(workflowStore.insertWorkflow({
    id: "operator-workflow",
    name: "Operator Workflow",
    normalizedName: normalizeWorkflowName("Operator Workflow"),
    description: "Operator draft",
    draft,
    completionPolicy: { kind: "none" },
    resumptionPolicy: "manual",
    bindingDefaults: { triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 2 },
    createdAt: 12,
    updatedAt: 12,
  }).ok, true);
  assert.equal(workflowStore.publishWorkflow("operator-workflow", 1, "operator-version", 13).ok, true);
  assert.equal(workflowStore.archivePersonaCas("operator-persona", 1, 20).ok, true);
  assert.equal(workflowStore.archiveSessionActionCas("operator-action", 1, 21).ok, true);
  assert.equal(workflowStore.archiveWorkflowCas("operator-workflow", 1, 22).ok, true);
}

function makeSnapshot(
  id = "daily-2026-08-24",
  kind: "daily" | "pre_restore" = "daily",
  localDate = "2026-08-24",
  createdAt = "2026-08-24T12:00:00.000Z",
): SettingsBackupEnvelopeV1 {
  const catalogs = captureSettingsCatalogs(workflowStore);
  const body: SettingsBackupEnvelopeBodyV1 = {
    format: SETTINGS_BACKUP_FORMAT,
    formatVersion: SETTINGS_BACKUP_FORMAT_VERSION,
    id,
    kind,
    createdAt,
    localDate,
    appVersion: "test-version",
    domains: [...captureSettingsConfig(), ...catalogs]
      .sort((left, right) => left.domain.localeCompare(right.domain)),
    counts: settingsCatalogCounts(catalogs),
  };
  return createSettingsBackupEnvelope(body);
}

test("canonical JSON and digest parsing are deterministic and fail closed", () => {
  assert.equal(
    canonicalSettingsBackupJson({ b: 2, a: { d: 4, c: 3 } }),
    '{"a":{"c":3,"d":4},"b":2}',
  );
  assert.throws(() => canonicalSettingsBackupJson({ value: Number.NaN }));
  assert.equal(settingsBackupDigest({
    format: SETTINGS_BACKUP_FORMAT,
    formatVersion: SETTINGS_BACKUP_FORMAT_VERSION,
    id: "daily-2026-08-24",
    kind: "daily",
    createdAt: "2026-08-24T12:00:00.000Z",
    localDate: "2026-08-24",
    appVersion: "golden",
    domains: [],
    counts: {
      personas: 0,
      sessionActions: 0,
      workflowCommands: 0,
      workflowDefinitions: 0,
      workflowVersions: 0,
    },
  }), "17bc8d7871bf527343da4ba2e055311168aba7675594f4d694cb6d23af5b4d11");

  const snapshot = makeSnapshot();
  assert.equal(inspectSettingsBackupValue(snapshot).status, "ready");
  const edited = structuredClone(snapshot);
  edited.appVersion = "edited";
  const root = join(home, "digest");
  const store = new SettingsBackupStore(root);
  store.write(snapshot);
  writeFileSync(join(root, `${edited.id}.json`), settingsBackupFileText(edited));
  assert.deepEqual(store.read(edited.id).status, "corrupt");

  const newer = { ...snapshot, formatVersion: 2 };
  assert.equal(inspectSettingsBackupValue(newer).status, "produced_by_newer_build");
  const newerDomain = structuredClone(snapshot) as unknown as { domains: Array<{ version: number }> };
  newerDomain.domains[0]!.version = 2;
  assert.equal(inspectSettingsBackupValue(newerDomain).status, "produced_by_newer_build");
  const malformedDomain = structuredClone(snapshot) as unknown as { domains: Array<{ version: number }> };
  malformedDomain.domains[0]!.version = 0;
  assert.equal(inspectSettingsBackupValue(malformedDomain).status, "corrupt");
  const tooManyRows = structuredClone(snapshot);
  tooManyRows.counts.personas = SETTINGS_BACKUP_LIMITS.entriesPerCatalog + 1;
  assert.equal(inspectSettingsBackupValue(tooManyRows).status, "corrupt");
});

test("daily capture includes archived operator catalogs and excludes built-ins and operations", async () => {
  seedOperatorCatalogs();
  let now = new Date("2026-08-24T12:00:00.000Z");
  const root = join(home, "capture");
  const service = new SettingsBackupService(
    workflowStore,
    new SettingsBackupStore(root),
    () => now,
    "1.2.3-test",
  );
  const first = await service.ensureDailySnapshot("2026-08-24");
  assert.equal(first.status, "ready");
  if (first.status !== "ready") return;
  assert.equal(first.snapshot.appVersion, "1.2.3-test");
  assert.equal(first.snapshot.counts.personas, 1);
  assert.equal(first.snapshot.counts.sessionActions, 1);
  assert.equal(first.snapshot.counts.workflowDefinitions, 1);
  assert.equal(first.snapshot.counts.workflowVersions, 1);
  assert.equal(first.snapshot.counts.workflowCommands, 4);
  const personaPayload = first.snapshot.domains.find((entry) => entry.domain === "personas")
    ?.payload as Array<{ id: string; archivedAt: number | null; builtin: boolean; guidanceMarkdown: string }>;
  assert.equal(personaPayload.length, 1);
  assert.equal(personaPayload[0]?.id, "operator-persona");
  assert.equal(personaPayload[0]?.archivedAt, 20);
  assert.equal(personaPayload[0]?.guidanceMarkdown, "# Operator Persona\r\n\r\nKeep exact bytes.  \r\n");
  assert.equal(personaPayload.some((entry) => entry.builtin), false);
  assert.equal(first.snapshot.domains.some((entry) => entry.domain === "tasks" as never), false);
  assert.equal(first.snapshot.domains.some((entry) => entry.domain === "workflow-runs" as never), false);

  now = new Date("2026-08-24T23:00:00.000Z");
  const second = await service.ensureDailySnapshot("2026-08-24");
  assert.equal(second.status, "ready");
  if (second.status === "ready") assert.equal(second.snapshot.createdAt, first.snapshot.createdAt);
  assert.equal(readdirSync(root).filter((name) => name.startsWith("daily-")).length, 1);

  now = new Date("2026-08-25T01:00:00.000Z");
  const safety = await service.capturePreRestoreSnapshot();
  assert.equal(safety.status, "ready");
  assert.equal(readdirSync(root).filter((name) => name.startsWith("pre-restore-")).length, 1);

  const newer = { ...first.snapshot, formatVersion: 2 };
  writeFileSync(join(root, `${first.snapshot.id}.json`), canonicalSettingsBackupJson(newer));
  const preserved = await service.ensureDailySnapshot("2026-08-24");
  assert.equal(preserved.status, "produced_by_newer_build");
  assert.equal(JSON.parse(readFileSync(join(root, `${first.snapshot.id}.json`), "utf8")).formatVersion, 2);
});

test("the store writes owner-only files, diagnoses symlinks and bounds reads", () => {
  const root = join(home, "security");
  const store = new SettingsBackupStore(root);
  const snapshot = makeSnapshot();
  assert.equal(store.write(snapshot).status, "ready");
  assert.equal(lstatSync(root).mode & 0o777, 0o700);
  assert.equal(lstatSync(join(root, `${snapshot.id}.json`)).mode & 0o777, 0o600);

  const linkName = "daily-2026-08-25.json";
  symlinkSync(join(root, `${snapshot.id}.json`), join(root, linkName));
  assert.equal(store.read("daily-2026-08-25").status, "unreadable");

  const oversizedName = "daily-2026-08-26.json";
  writeFileSync(join(root, oversizedName), Buffer.alloc(SETTINGS_BACKUP_LIMITS.fileBytes + 1));
  assert.equal(store.read("daily-2026-08-26").status, "unreadable");
  const listed = store.list();
  assert.ok(listed.some((entry) => entry.status === "ready"));
  assert.ok(listed.some((entry) => entry.status === "unreadable"));
  assert.ok(listed.every((entry) => !("snapshot" in entry)));
  assert.throws(() => store.read("../../secrets"));

  symlinkSync(join(root, "missing-target"), join(root, "daily-2026-08-27.json"));
  assert.throws(
    () => store.write(makeSnapshot(
      "daily-2026-08-27",
      "daily",
      "2026-08-27",
      "2026-08-27T12:00:00.000Z",
    )),
    /non-regular/,
  );

  const realRoot = join(home, "real-security-root");
  const linkedRoot = join(home, "linked-security-root");
  mkdirSync(realRoot);
  symlinkSync(realRoot, linkedRoot);
  assert.throws(() => new SettingsBackupStore(linkedRoot).list(), /real directory/);

  const crowdedRoot = join(home, "crowded");
  const crowdedStore = new SettingsBackupStore(crowdedRoot);
  crowdedStore.list();
  for (let index = 0; index <= SETTINGS_BACKUP_LIMITS.ownedFiles; index += 1) {
    const day = String((index % 28) + 1).padStart(2, "0");
    const cycle = String(Math.floor(index / 28)).padStart(2, "0");
    writeFileSync(join(crowdedRoot, `pre-restore-202601${day}T0000${cycle}.000Z-${String(index).padStart(12, "0")}.json`), "{}");
  }
  assert.throws(() => crowdedStore.list(), /too many owned files/);
});

test("failed temp publication preserves the previous daily and cleans only its temp", () => {
  const root = join(home, "atomic");
  const originalStore = new SettingsBackupStore(root);
  const original = makeSnapshot();
  originalStore.write(original);
  const before = readFileSync(join(root, `${original.id}.json`), "utf8");

  const changedBody = { ...original, appVersion: "changed" };
  const { digest: _digest, ...body } = changedBody;
  const changed = createSettingsBackupEnvelope(body);
  const failingStore = new SettingsBackupStore(root, {
    beforeRename: () => { throw new Error("injected publication failure"); },
  });
  assert.throws(() => failingStore.write(changed), /injected publication failure/);
  assert.equal(readFileSync(join(root, `${original.id}.json`), "utf8"), before);
  assert.deepEqual(readdirSync(root).filter((name) => name.endsWith(".tmp")), []);
});

test("retention keeps 90 daily and 10 pre-restore snapshots independently", () => {
  const root = join(home, "retention");
  const store = new SettingsBackupStore(root);
  store.write(makeSnapshot());

  for (let offset = 1; offset <= 91; offset += 1) {
    const date = new Date(Date.UTC(2026, 7, 24 + offset));
    const localDate = date.toISOString().slice(0, 10);
    const snapshot = makeSnapshot(`daily-${localDate}`, "daily", localDate, date.toISOString());
    writeFileSync(join(root, `${snapshot.id}.json`), settingsBackupFileText(snapshot), { mode: 0o600 });
  }
  const dailyFinalDate = "2026-12-01";
  store.write(makeSnapshot(
    `daily-${dailyFinalDate}`,
    "daily",
    dailyFinalDate,
    "2026-12-01T12:00:00.000Z",
  ));

  for (let index = 0; index < 10; index += 1) {
    const timestamp = `20261202T0000${String(index).padStart(2, "0")}.000Z`;
    const id = `pre-restore-${timestamp}-${String(index).padStart(12, "0")}`;
    const snapshot = makeSnapshot(id, "pre_restore", "2026-12-02", `2026-12-02T00:00:${String(index).padStart(2, "0")}.000Z`);
    writeFileSync(join(root, `${snapshot.id}.json`), settingsBackupFileText(snapshot), { mode: 0o600 });
  }
  store.write(makeSnapshot(
    "pre-restore-20261202T000010.000Z-aaaaaaaaaaaa",
    "pre_restore",
    "2026-12-02",
    "2026-12-02T00:00:10.000Z",
  ));

  const names = readdirSync(root);
  assert.equal(names.filter((name) => name.startsWith("daily-")).length, 90);
  assert.equal(names.filter((name) => name.startsWith("pre-restore-")).length, 10);
  for (const name of names) chmodSync(join(root, name), 0o600);
});
