// The decision-model key routes (contract E) over HTTP: a key is saved per provider in one private
// file and never read back, logged, or written to SQLite or a settings backup; the report says
// which provider is in use and where each provider's key comes from.
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import fs, { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-voice-key-"));
process.env.MISSION_HOME = home;
const { closeDb } = await import("../src/server/db.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const flags = await import("../src/server/feature-flags/index.ts");
const { decisionKeyPath } = await import("../src/server/voice/decision-key.ts");
const { captureSettingsConfig } = await import("../src/server/settings-backups/config-registry.ts");
type Report = import("../src/shared/voice-decide.ts").VoiceDecisionKeyReport;

const OPENAI_KEY = "sk-saved-openai-key-0123456789";
const JEV_KEY = "ts-saved-jev-key-0123456789";
const headers = { host: "127.0.0.1:7317", "content-type": "application/json" };
const registry = new Registry();
const app = buildApp({ registry, reviews: new ReviewManager(registry), tasks: new TaskManager(registry), queues: new QueueManager(registry) });
const request = (path: string, method = "GET", body?: unknown) =>
  app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const report = async (path = "/api/voice/decision-key", method = "GET", body?: unknown) => {
  const response = await request(path, method, body);
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as Report & { error?: string } };
};
const setProvider = (decisionProvider: string | null) => request("/api/voice/config", "PUT", { decisionProvider });

let logged: string[] = [];
beforeEach(async () => {
  for (const id of ["voice", "async-input", "inbox", "filed-plan-decisions"]) flags.applyFeatureFlagIntent({ kind: "flag", id, enabled: true });
  rmSync(decisionKeyPath(), { force: true });
  delete process.env.OPENAI_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  await setProvider(null);
  logged = [];
  for (const method of ["log", "info", "warn", "error"] as const) {
    mock.method(console, method, (...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
  }
});
afterEach(() => {
  mock.restoreAll();
  delete process.env.OPENAI_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
});
after(() => { closeDb(); rmSync(home, { recursive: true, force: true }); });

test("with no key anywhere the report names no provider and each source as not set", async () => {
  const { status, body } = await report();
  assert.equal(status, 200);
  assert.deepEqual(body, { provider: null, keys: { openai: { source: null }, jev: { source: null } } });
});

test("the dashboard reads the saved selection and active provider at the same revision", async () => {
  process.env.OPENAI_API_KEY = OPENAI_KEY;
  let previous: string | undefined;
  for (const [selection, active] of [[null, "openai"], ["openai", "openai"], ["off", null]] as const) {
    await setProvider(selection);
    const dashboard = await app.request("/api/voice/decision-key", {
      headers: { ...headers, "x-voice-provider-revision": "read" },
    });
    const data = await dashboard.json() as Report & { selection: string | null; providerRevision: string };
    assert.deepEqual([data.selection, data.provider], [selection, active]);
    assert.ok(data.providerRevision && data.providerRevision !== previous);
    previous = data.providerRevision;
  }
});

test("disabling Voice while a key PUT reads its body prevents saving the credential", async () => {
  const payload = new TextEncoder().encode(JSON.stringify({ provider: "jev", key: JEV_KEY }));
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      flags.applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: false });
      controller.enqueue(payload);
      controller.close();
    },
  }, { highWaterMark: 0 });
  const response = await app.request("/api/voice/decision-key", {
    method: "PUT", headers: { ...headers, "content-length": String(payload.length) }, body, duplex: "half",
  } as RequestInit & { duplex: "half" });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "This feature is disabled.", feature: "voice" });
  assert.equal(existsSync(decisionKeyPath()), false);
});

test("a saved key is never echoed, lands in a 0600 file under the state home, and switches automatic on", async () => {
  const saved = await report("/api/voice/decision-key", "PUT", { provider: "openai", key: OPENAI_KEY });
  assert.equal(saved.status, 200);
  assert.ok(!saved.text.includes(OPENAI_KEY));
  assert.deepEqual(saved.body, { provider: "openai", keys: { openai: { source: "settings" }, jev: { source: null } } });

  const path = decisionKeyPath();
  assert.equal(path, join(home, "voice", "decision-key.json"));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(home, "voice")).mode & 0o077, 0);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { openai: OPENAI_KEY });

  const read = await report();
  assert.ok(!read.text.includes(OPENAI_KEY));
  assert.equal(read.body.provider, "openai");
  assert.ok(!logged.some((line) => line.includes(OPENAI_KEY)), "nothing logged the key");
});

test("a key saved and removed for one provider leaves the other's", async () => {
  await report("/api/voice/decision-key", "PUT", { provider: "openai", key: OPENAI_KEY });
  await report("/api/voice/decision-key", "PUT", { provider: "jev", key: JEV_KEY });
  assert.deepEqual(JSON.parse(readFileSync(decisionKeyPath(), "utf8")), { openai: OPENAI_KEY, jev: JEV_KEY });
  assert.equal((await report()).body.provider, "openai", "automatic: a saved OpenAI key comes first");

  const removed = await report("/api/voice/decision-key?provider=openai", "DELETE");
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body, { provider: "jev", keys: { openai: { source: null }, jev: { source: "settings" } } });
  assert.deepEqual(JSON.parse(readFileSync(decisionKeyPath(), "utf8")), { jev: JEV_KEY });
  assert.equal(statSync(decisionKeyPath()).mode & 0o777, 0o600);

  await report("/api/voice/decision-key?provider=jev", "DELETE");
  assert.equal(existsSync(decisionKeyPath()), false, "with no key left the file goes");
  assert.equal((await report("/api/voice/decision-key?provider=jev", "DELETE")).status, 200, "removing nothing is not an error");
});

test("a failed key save returns 500, preserves the existing key and cleans up the temporary file", async (t) => {
  const saved = await report("/api/voice/decision-key", "PUT", { provider: "openai", key: OPENAI_KEY });
  assert.equal(saved.status, 200);
  const path = decisionKeyPath();
  const dir = join(home, "voice");
  const originalFiles = readdirSync(dir).sort();
  const rename = fs.renameSync;
  const fault = t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (to === path) throw new Error("injected key publication failure");
    rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    const failed = await report("/api/voice/decision-key", "PUT", { provider: "jev", key: JEV_KEY });
    assert.equal(failed.status, 500);
    assert.deepEqual(failed.body, { error: "save_failed", reason: "The key could not be saved." });
    assert.deepEqual((await report()).body, saved.body);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { openai: OPENAI_KEY });
    assert.deepEqual(readdirSync(dir).sort(), originalFiles);
    assert.ok(logged.every((line) => !line.includes(OPENAI_KEY) && !line.includes(JEV_KEY)));
  } finally {
    fault.mock.restore();
    syncBuiltinESMExports();
  }
});

test("a failed removal of the last key returns 500 and keeps the key saved and selected", async (t) => {
  const saved = await report("/api/voice/decision-key", "PUT", { provider: "jev", key: JEV_KEY });
  assert.equal(saved.status, 200);
  const path = decisionKeyPath();
  const remove = fs.rmSync;
  const fault = t.mock.method(fs, "rmSync", (...args: Parameters<typeof fs.rmSync>) => {
    if (args[0] === path) throw new Error("injected key removal failure");
    remove(...args);
  });
  syncBuiltinESMExports();
  try {
    const failed = await report("/api/voice/decision-key?provider=jev", "DELETE");
    assert.equal(failed.status, 500);
    assert.deepEqual(failed.body, { error: "save_failed", reason: "The key could not be removed." });
    assert.deepEqual((await report()).body, saved.body);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { jev: JEV_KEY });
    assert.ok(logged.every((line) => !line.includes(JEV_KEY)));
  } finally {
    fault.mock.restore();
    syncBuiltinESMExports();
  }
});

test("each provider's source: the environment, a saved key over it, and the chosen provider or Off", async () => {
  process.env.OPENAI_API_KEY = "sk-env-openai";
  process.env.TYPESAFE_API_KEY = "ts-env-jev";
  let read = await report();
  assert.deepEqual(read.body, { provider: "openai", keys: { openai: { source: "environment" }, jev: { source: "environment" } } });
  assert.ok(!read.text.includes("sk-env-openai") && !read.text.includes("ts-env-jev"));

  await report("/api/voice/decision-key", "PUT", { provider: "jev", key: JEV_KEY });
  read = await report();
  assert.deepEqual(read.body, { provider: "jev", keys: { openai: { source: "environment" }, jev: { source: "settings" } } });

  await setProvider("openai");
  assert.equal((await report()).body.provider, "openai");
  await setProvider("off");
  assert.equal((await report()).body.provider, null);
  delete process.env.OPENAI_API_KEY;
  await setProvider("openai");
  assert.equal((await report()).body.provider, null, "a chosen provider with no key is none, never the other's key");
});

test("a refused key is not echoed in the error, and a bad provider is refused", async () => {
  const short = await report("/api/voice/decision-key", "PUT", { provider: "openai", key: "sk-1" });
  assert.equal(short.status, 400);
  assert.ok(!short.text.includes("sk-1"));
  const spaced = await report("/api/voice/decision-key", "PUT", { provider: "openai", key: "sk-has a space-0123" });
  assert.equal(spaced.status, 400);
  assert.ok(!spaced.text.includes("has a space"));
  assert.equal((await report("/api/voice/decision-key", "PUT", { provider: "anthropic", key: OPENAI_KEY })).status, 400);
  assert.equal((await report("/api/voice/decision-key?provider=anthropic", "DELETE")).status, 400);
  assert.equal(existsSync(decisionKeyPath()), false);
});

test("saving a key secures an existing voice directory before publishing", async () => {
  const dir = join(home, "voice");
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o755);
  assert.equal((await report("/api/voice/decision-key", "PUT", { provider: "jev", key: JEV_KEY })).status, 200);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(decisionKeyPath()).mode & 0o777, 0o600);
});

test("an unreadable key file makes the settings report unavailable without disclosing its content", async () => {
  fs.mkdirSync(join(home, "voice"), { recursive: true, mode: 0o700 });
  writeFileSync(decisionKeyPath(), "not json " + OPENAI_KEY, { mode: 0o600 });
  const read = await report();
  assert.equal(read.status, 200);
  assert.equal(read.body.savedKeysUnavailable, true);
  assert.equal(read.body.provider, null);
  process.env.TYPESAFE_API_KEY = JEV_KEY;
  const env = await report();
  assert.equal(env.body.provider, "jev");
  assert.equal(env.body.keys.jev.source, "environment");
  assert.equal(env.body.savedKeysUnavailable, true);
  await setProvider("off");
  assert.equal((await report()).body.provider, null);
  assert.ok(!read.text.includes(OPENAI_KEY));
  assert.ok(!logged.some((line) => line.includes(OPENAI_KEY)));
});

for (const operation of ["save", "remove"] as const) {
  test(`a key-file read error prevents ${operation} from replacing existing credentials`, async (t) => {
    const path = decisionKeyPath();
    assert.equal((await report("/api/voice/decision-key", "PUT", { provider: "openai", key: OPENAI_KEY })).status, 200);
    const contents = readFileSync(path);
    const open = fs.openSync;
    const fault = t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
      if (args[0] === path) throw Object.assign(new Error("read denied"), { code: "EACCES" });
      return open(...args);
    });
    syncBuiltinESMExports();
    try {
      assert.equal((await report()).body.savedKeysUnavailable, true);
      const response = operation === "save" ? await report("/api/voice/decision-key", "PUT", { provider: "jev", key: JEV_KEY })
        : await report("/api/voice/decision-key?provider=openai", "DELETE");
      assert.equal(response.status, 500);
      assert.equal(response.body.error, "save_failed");
    } finally {
      fault.mock.restore();
      syncBuiltinESMExports();
    }
    assert.deepEqual(readFileSync(path), contents);
    assert.equal((await report()).body.keys.openai.source, "settings");
  });
}

test("malformed key-file contents survive both mutations without disclosure", async () => {
  const path = decisionKeyPath();
  assert.equal((await report("/api/voice/decision-key", "PUT", { provider: "openai", key: OPENAI_KEY })).status, 200);
  for (const contents of [OPENAI_KEY, "null", "[]", JSON.stringify({ openai: OPENAI_KEY, jev: false })]) {
    writeFileSync(path, contents);
    for (const response of [await report("/api/voice/decision-key", "PUT", { provider: "jev", key: JEV_KEY }),
      await report("/api/voice/decision-key?provider=openai", "DELETE")]) {
      assert.equal(response.status, 500);
      assert.equal(response.body.error, "save_failed");
      assert.ok(!response.text.includes(OPENAI_KEY));
    }
    assert.equal(readFileSync(path, "utf8"), contents);
  }
  assert.ok(logged.every(line => !line.includes(OPENAI_KEY) && !line.includes(JEV_KEY)));
});

test("every key route answers 404 with the voice flag off", async () => {
  flags.applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: false });
  assert.equal((await request("/api/voice/decision-key")).status, 404);
  assert.equal((await request("/api/voice/decision-key", "PUT", { provider: "openai", key: OPENAI_KEY })).status, 404);
  assert.equal((await request("/api/voice/decision-key?provider=openai", "DELETE")).status, 404);
  assert.equal(existsSync(decisionKeyPath()), false);
});

test("a saved key is in neither SQLite nor a settings backup", async () => {
  await report("/api/voice/decision-key", "PUT", { provider: "openai", key: OPENAI_KEY });
  await setProvider("openai");
  assert.ok(!JSON.stringify(captureSettingsConfig()).includes(OPENAI_KEY), "the settings snapshot holds no key");
  closeDb();
  for (const file of readdirSync(home).filter((name) => name.startsWith("harness.db"))) {
    assert.equal(readFileSync(join(home, file)).includes(OPENAI_KEY), false, file);
  }
});

for (const component of ["directory", "file"] as const) {
  test(`the key store refuses a linked ${component} on read, save and last-key removal`, async (t) => {
    const dir = join(home, "voice");
    const fixture = mkdtempSync(join(home, "key-fixture-"));
    const target = join(fixture, "decision-key.json");
    const contents = JSON.stringify({ openai: OPENAI_KEY });
    writeFileSync(target, contents);
    if (component === "directory") {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.symlinkSync(fixture, dir, "dir");
    } else {
      fs.mkdirSync(dir, { recursive: true });
      fs.symlinkSync(target, decisionKeyPath());
    }
    const link = component === "directory" ? dir : decisionKeyPath();
    t.after(() => fs.unlinkSync(link));
    assert.equal((await report()).body.savedKeysUnavailable, true);
    assert.equal((await report("/api/voice/decision-key", "PUT", { provider: "jev", key: JEV_KEY })).status, 500);
    assert.equal((await report("/api/voice/decision-key?provider=openai", "DELETE")).status, 500);
    assert.equal(readFileSync(target, "utf8"), contents);
    assert.ok(fs.lstatSync(link).isSymbolicLink());
  });
}
