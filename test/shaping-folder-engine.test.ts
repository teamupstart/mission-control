// A shaper dropped into the shapers folder, end to end through the engine and the real `command`
// transport: it runs at the next shaping run with no settings write, a stored choice on or off
// always wins and survives a reopened store, a manifest that asks to start off waits for the
// operator, a registered id shadows it, and every launch records which definition ran.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "mission-shaping-folder-"));
process.env.MISSION_HOME = home;
const { closeDb, deleteAppConfig, getAppConfig } = await import("../src/server/db.ts");
const { APP_CONFIG_ENTRIES } = await import("../src/shared/app-config-entries.ts");
const { SHAPING_LIMIT_RANGES } = await import("../src/shared/shaping.ts");
const { initializeExecutableEnvironment } = await import("../src/server/executables/locator.ts");
const store = await import("../src/server/shaping/index.ts");
const { discoverShapers, shapersFolder } = await import("../src/server/shaping/discovery.ts");
const { dryRunShaper, shapeTask } = await import("../src/server/shaping/engine.ts");
type ShapeTaskInput = import("../src/server/shaping/engine.ts").ShapeTaskInput;

const root = shapersFolder(home);
const input: ShapeTaskInput = {
  task: "Retry failed charges",
  context: {
    taskId: "t_folder", title: "Retry failed charges", kind: "ship", harness: "claude", runtime: "sdk",
    afterWork: null, labels: [], priority: null,
    repositories: [{ name: "billing-api", role: "primary", branch: "task/retry", baseSha: "abc123", path: null }],
  },
};

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  // No stored config at all and an empty folder: every case starts with no settings write.
  rmSync(root, { recursive: true, force: true });
  deleteAppConfig(APP_CONFIG_ENTRIES.shaping);
  store.reloadShaping();
});

/** A folder shaper whose `./run` answers with one guidance entry naming `body`. */
function dropShaper(id: string, body: string, extra: Record<string, unknown> = {}): string {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o755);
  const program = join(dir, "run");
  writeFileSync(program, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${JSON.stringify({ guidance: [{ id: "folder/entry", title: "From the folder", body }] })}'\n`);
  chmodSync(program, 0o755);
  const text = JSON.stringify({ id, label: `Folder ${id}`, stage: "select", transport: { type: "command", command: "./run" }, ...extra });
  writeFileSync(join(dir, "shaper.json"), text);
  chmodSync(join(dir, "shaper.json"), 0o644);
  return createHash("sha256").update(text).digest("hex");
}

// Nothing in this file is about timing, and it used to fail its first case with `timed_out` under
// the full suite. The command transport locates its executable through the process-wide locator,
// whose first use probes the operator's login shell (`$SHELL -ilc`, bounded at 5 s), and that wait
// was spent from the first shaper call's own 5 s budget. A slow shell start under load used it up.
// The probe is paid here, once, before any case, outside every call's budget.
await initializeExecutableEnvironment();

/**
 * The stored config as it stands now, with the time limits at their ceilings, as headroom for a
 * real `/bin/sh` spawn on a loaded machine. Read fresh on every call, so a stored choice still
 * decides what runs, and passed as the run's snapshot, so nothing is written to settings.
 */
const roomyConfig = () => {
  const config = store.getShapingConfig();
  return {
    ...config,
    limits: { ...config.limits, timeoutMs: SHAPING_LIMIT_RANGES.timeoutMs.max, deadlineMs: SHAPING_LIMIT_RANGES.deadlineMs.max },
  };
};

const shape = () => shapeTask(input, { enabled: true, config: roomyConfig() });

test("a dropped-in folder runs at the next shaping run with no settings write, and records its origin and hash", async () => {
  const stored = getAppConfig(APP_CONFIG_ENTRIES.shaping);
  const sha256 = dropShaper("acme-notes", "Charge each key once.");
  const run = await shape();
  assert.equal(run.summary?.shapers.length, 1);
  const row = run.summary!.shapers[0]!;
  assert.equal(row.id, "acme-notes");
  assert.equal(row.origin, "discovered");
  assert.equal(row.sha256, sha256);
  assert.equal(row.outcome, "ok");
  assert.match(run.section, /Charge each key once\./);
  // Nothing was stored to make it run.
  assert.deepEqual(getAppConfig(APP_CONFIG_ENTRIES.shaping), stored);
});

test("a replaced manifest runs as its new definition at the next run, and that launch records the new hash", async () => {
  const first = dropShaper("acme-notes", "First answer.");
  assert.equal((await shape()).summary?.shapers[0]?.sha256, first);
  const second = dropShaper("acme-notes", "Second answer.", { label: "Folder notes, revised" });
  const run = await shape();
  assert.notEqual(second, first);
  assert.equal(run.summary?.shapers[0]?.sha256, second);
  assert.equal(run.summary?.shapers[0]?.label, "Folder notes, revised");
  assert.match(run.section, /Second answer\./);
});

test("a stored off wins over the manifest, and survives a reopened store", async () => {
  dropShaper("acme-notes", "Charge each key once.");
  const discovered = await discoverShapers();
  assert.equal(store.applyShapingIntent({ kind: "enable", id: "acme-notes", enabled: false }, discovered).ok, true);
  assert.equal((await shape()).summary, null);
  // A daemon restart reads the stored choice back from the database.
  closeDb();
  store.reloadShaping();
  assert.equal(store.getShapingConfig().overrides["acme-notes"], false);
  assert.equal((await shape()).summary, null);
  assert.equal(store.applyShapingIntent({ kind: "enable", id: "acme-notes", enabled: true }, discovered).ok, true);
  assert.equal((await shape()).summary?.shapers[0]?.id, "acme-notes");
});

test("a manifest that asks to start off does not run until the operator switches it on, then does", async () => {
  dropShaper("quiet-notes", "Only when asked.", { enabled: false });
  assert.equal((await shape()).summary, null);
  const discovered = await discoverShapers();
  assert.equal(store.applyShapingIntent({ kind: "enable", id: "quiet-notes", enabled: true }, discovered).ok, true);
  const run = await shape();
  assert.equal(run.summary?.shapers[0]?.id, "quiet-notes");
  assert.match(run.section, /Only when asked\./);
});

test("switching on is bound to the manifest the operator was shown", async () => {
  const shown = dropShaper("quiet-notes", "Shown.", { enabled: false });
  dropShaper("quiet-notes", "Replaced.", { enabled: false, label: "Replaced notes" });
  const discovered = await discoverShapers();
  const refused = store.applyShapingIntent({ kind: "enable", id: "quiet-notes", enabled: true, manifest: shown }, discovered);
  assert.equal(refused.ok, false);
  assert.equal(!refused.ok && refused.error, "shaper_changed");
  assert.equal((await shape()).summary, null);
  // Switching off is always applied, whatever the folder holds now.
  assert.equal(store.applyShapingIntent({ kind: "enable", id: "quiet-notes", enabled: false, manifest: shown }, discovered).ok, true);
});

test("a registered shaper with the same id shadows the folder's, which never runs", async () => {
  dropShaper("acme-notes", "From the folder.");
  const discovered = await discoverShapers();
  const registered = { id: "acme-notes", label: "Registered notes", stage: "select", transport: { type: "command", command: "/bin/echo", args: ["{}"] } };
  assert.equal(store.applyShapingIntent({ kind: "upsert", shaper: registered } as never, discovered).ok, true);
  assert.equal((await discoverShapers())[0]?.state, "shadowed");
  // Stored off by the upsert: nothing runs.
  assert.equal((await shape()).summary, null);
  // Switched on, the registered definition runs, never the folder's.
  assert.equal(store.applyShapingIntent({ kind: "enable", id: "acme-notes", enabled: true }, discovered).ok, true);
  const run = await shape();
  assert.equal(run.summary?.shapers.length, 1);
  assert.equal(run.summary?.shapers[0]?.origin, "registered");
  assert.doesNotMatch(run.section, /From the folder\./);
  assert.equal(store.applyShapingIntent({ kind: "remove", id: "acme-notes" }, discovered).ok, true);
});

test("an invalid or refused manifest never runs, even when stored on", async () => {
  dropShaper("acme-notes", "Never.");
  const discovered = await discoverShapers();
  assert.equal(store.applyShapingIntent({ kind: "enable", id: "acme-notes", enabled: true }, discovered).ok, true);
  chmodSync(join(root, "acme-notes", "run"), 0o777);
  assert.equal((await discoverShapers())[0]?.state, "refused");
  assert.equal((await shape()).summary, null);
  writeFileSync(join(root, "acme-notes", "shaper.json"), "{ not json");
  assert.equal((await discoverShapers())[0]?.state, "invalid");
  assert.equal((await shape()).summary, null);
});

test("a dry run reads the folder too, and runs the discovered definition", async () => {
  const sha256 = dropShaper("acme-notes", "Dry run answer.", { enabled: false });
  const result = await dryRunShaper("acme-notes", input, { config: roomyConfig() });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.run.summary?.shapers[0]?.origin, "discovered");
  assert.equal(result.ok && result.run.summary?.shapers[0]?.sha256, sha256);
});

test("with the flag off nothing runs, whatever the folder holds", async () => {
  dropShaper("acme-notes", "Never.");
  assert.deepEqual(await shapeTask(input, { enabled: false }), { summary: null, section: "", entries: [], skills: [] });
});
