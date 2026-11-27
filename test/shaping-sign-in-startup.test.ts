// The daemon's wiring of shaper sign-in (`startShaperSignIns`): with both flags on it tells the
// service which connections the known shapers name, from the stored config and one scan of the
// shapers folder, and again on every config change and every reported scan. While either flag
// is off it reads nothing and reports nothing. Fake hosts only, no request is made, and the
// memory store is forced so no Keychain is touched.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "mission-sign-in-startup-"));
process.env.MISSION_HOME = home;
process.env.MISSION_SHAPER_SIGN_IN_STORE = "memory";
after(() => rmSync(home, { recursive: true, force: true }));

const { setAppConfig } = await import("../src/server/db.ts");
const { APP_CONFIG_ENTRIES } = await import("../src/shared/app-config-entries.ts");
const { SHAPER_SIGN_IN_FLAG_ID } = await import("../src/shared/feature-flag-registry.ts");
const { reloadFeatureFlags } = await import("../src/server/feature-flags/index.ts");
const { reloadShaping } = await import("../src/server/shaping/index.ts");
const { discoverShapers, shapersFolder } = await import("../src/server/shaping/discovery.ts");
const { noteShaperFolderScan, shaperSignIns, startShaperSignIns } = await import("../src/server/shaping/sign-in/index.ts");

const marked = (id: string, scope: string, url = `https://tools.example/${id}`) => ({
  id, label: id, stage: "select",
  transport: {
    type: "mcp", tool: "get_guidance",
    server: { type: "http", url, headers: {}, auth: { type: "oauth", scope } },
  },
});

function setFlags(on: boolean): void {
  setAppConfig(APP_CONFIG_ENTRIES.featureFlags, { enableAll: false, overrides: { "task-shaping": on, [SHAPER_SIGN_IN_FLAG_ID]: on } });
  reloadFeatureFlags();
}

function setRegistered(...shapers: Array<ReturnType<typeof marked>>): void {
  setAppConfig(APP_CONFIG_ENTRIES.shaping, { shapers });
  reloadShaping();
}

function dropManifest(id: string, scope: string): void {
  const dir = join(shapersFolder(home), id);
  mkdirSync(dir, { recursive: true });
  chmodSync(shapersFolder(home), 0o755);
  chmodSync(dir, 0o755);
  writeFileSync(join(dir, "shaper.json"), JSON.stringify(marked(id, scope)));
  chmodSync(join(dir, "shaper.json"), 0o644);
}

/** The view as `shaper ids by scope`, which is what setInUse decides. */
const inUse = () => Object.fromEntries(shaperSignIns.view().map((entry) => [entry.scope, entry.shapers]));

async function eventually(check: () => boolean, what: string): Promise<void> {
  for (let tries = 0; tries < 200 && !check(); tries++) await new Promise((done) => setTimeout(done, 10));
  assert.ok(check(), what);
}

const settle = async () => {
  await new Promise((done) => setTimeout(done, 30));
  await shaperSignIns.idle();
};

test("startShaperSignIns keeps the connections in use current from config and folder, and only while both flags are on", async () => {
  setFlags(false);
  setRegistered(marked("alpha", "mcp:alpha"));
  dropManifest("delta", "mcp:delta");
  const reports: unknown[] = [];
  const off = shaperSignIns.onChanged((view) => reports.push(view));
  const stop = startShaperSignIns();
  try {
    // Flags off: nothing is listed, and a config change reports nothing.
    await settle();
    assert.deepEqual(shaperSignIns.view(), []);
    setRegistered(marked("alpha", "mcp:alpha"), marked("beta", "mcp:beta"));
    await settle();
    assert.deepEqual(reports, []);
    assert.deepEqual(shaperSignIns.accessToken({ url: "https://tools.example/alpha", scope: "mcp:alpha", issuer: null }), { ok: false, reason: "flagOff" });

    // task-shaping off with shaper-sign-in on is still off: nothing listed, nothing read, flagOff.
    setAppConfig(APP_CONFIG_ENTRIES.featureFlags, { enableAll: false, overrides: { "task-shaping": false, [SHAPER_SIGN_IN_FLAG_ID]: true } });
    reloadFeatureFlags();
    await settle();
    assert.deepEqual(shaperSignIns.view(), []);
    assert.deepEqual(reports, []);
    assert.deepEqual(shaperSignIns.accessToken({ url: "https://tools.example/alpha", scope: "mcp:alpha", issuer: null }), { ok: false, reason: "flagOff" });
    assert.equal((await shaperSignIns.begin({ url: "https://tools.example/alpha", scope: "mcp:alpha", issuer: null }) as { code: string }).code, "flag_off");

    // Both on: the stored config at once, then the folder's one scan.
    setFlags(true);
    await eventually(() => "mcp:delta" in inUse(), "the folder scan's shaper is in use");
    assert.deepEqual(inUse(), { "mcp:alpha": ["alpha"], "mcp:beta": ["beta"], "mcp:delta": ["delta"] });
    assert.ok(shaperSignIns.view().every((entry) => entry.state === "signed_out" && entry.storage === "memory"));

    // A config change: a new registered shaper on alpha's connection, combined with the folder's last scan.
    setRegistered(marked("alpha", "mcp:alpha"), marked("gamma", "mcp:alpha", "https://tools.example/alpha"));
    await settle();
    assert.deepEqual(inUse(), { "mcp:alpha": ["alpha", "gamma"], "mcp:delta": ["delta"] });

    // A later scan, as Settings reports one, is kept for the next config change too.
    dropManifest("epsilon", "mcp:epsilon");
    noteShaperFolderScan(await discoverShapers({ home }));
    await settle();
    assert.deepEqual(inUse(), { "mcp:alpha": ["alpha", "gamma"], "mcp:delta": ["delta"], "mcp:epsilon": ["epsilon"] });
    setRegistered(marked("alpha", "mcp:alpha"));
    await settle();
    assert.deepEqual(inUse(), { "mcp:alpha": ["alpha"], "mcp:delta": ["delta"], "mcp:epsilon": ["epsilon"] });

    // One flag off: the list empties, and config changes made meanwhile are read when it is on again.
    setAppConfig(APP_CONFIG_ENTRIES.featureFlags, { enableAll: false, overrides: { "task-shaping": true, [SHAPER_SIGN_IN_FLAG_ID]: false } });
    reloadFeatureFlags();
    await settle();
    assert.deepEqual(shaperSignIns.view(), []);
    assert.deepEqual(reports.at(-1), []);
    const quiet = reports.length;
    setRegistered(marked("zeta", "mcp:zeta"));
    await settle();
    assert.equal(reports.length, quiet, "no report while a flag is off");
    setFlags(true);
    await settle();
    assert.deepEqual(inUse(), { "mcp:delta": ["delta"], "mcp:epsilon": ["epsilon"], "mcp:zeta": ["zeta"] });
  } finally {
    off();
    await stop();
  }

  // Stopped: later config changes reach nothing.
  setRegistered(marked("eta", "mcp:eta"));
  await settle();
  assert.ok(!("mcp:eta" in inUse()));
});
