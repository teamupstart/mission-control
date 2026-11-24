import assert from "node:assert/strict";
import test from "node:test";

const store = new Map<string, string>();
let calls = 0;
let finishTourWrite: ((response: Response) => void) | undefined;
let deferNextWrite = true;

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
});
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: async () => {
    calls += 1;
    if (deferNextWrite) {
      deferNextWrite = false;
      return new Promise<Response>((resolve) => {
        finishTourWrite = resolve;
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  },
});

const { applyVoiceIndicatorSelection, hydrateUiConfig, uiConfig, updateUiConfig, updateVoiceIndicator } = await import("../src/web/lib/uiConfig.ts");

test("a failed tour preference write does not restore over a newer preference", async () => {
  const savingPreference = updateUiConfig({ showToursOnStartup: false });
  await new Promise((resolve) => setImmediate(resolve));
  await updateUiConfig({ richText: false });
  finishTourWrite?.(new Response(JSON.stringify({ error: "temporary failure" }), { status: 503 }));
  assert.equal(await savingPreference, false);
  assert.equal(uiConfig().showToursOnStartup, true, "the failed request restores only its own field");
  assert.equal(uiConfig().richText, false, "the later preference remains in the live cache");
});

test("a failed older write cannot restore over a successful identical write", async () => {
  deferNextWrite = true;
  const olderWrite = updateUiConfig({ showToursOnStartup: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await updateUiConfig({ showToursOnStartup: false }), true);
  finishTourWrite?.(new Response(JSON.stringify({ error: "temporary failure" }), { status: 503 }));
  assert.equal(await olderWrite, false);
  assert.equal(uiConfig().showToursOnStartup, false, "the newer accepted value remains in the live cache");
});

test("initial hydration cannot undo an indicator save acknowledged after the GET started", async (t) => {
  const before = structuredClone(uiConfig());
  let finishRead!: (response: Response) => void;
  const read = new Promise<Response>(resolve => { finishRead = resolve; });
  let finishRefresh!: (response: Response) => void;
  const refresh = new Promise<Response>(resolve => { finishRefresh = resolve; });
  let reads = 0;
  t.mock.method(globalThis, "fetch", async (path: string) => {
    if (path === "/api/ui/config") return ++reads === 1 ? read : refresh;
    assert.equal(path, "/api/voice/indicators");
    return Response.json({ indicators: ["status-line", "edge"] });
  });
  const hydration = hydrateUiConfig();
  assert.equal(await updateVoiceIndicator("edge", true), "saved");
  finishRead(Response.json({ configured: true, config: { ...before, richText: true } }));
  await hydration;
  assert.deepEqual(uiConfig().voice.indicators, ["status-line", "edge"]);
  assert.equal(uiConfig().richText, true);
  assert.equal(reads, 2);
  const indicators = ["status-line", "edge", "floating"];
  finishRefresh(Response.json({ configured: true, config: { ...before, voice: { ...before.voice, indicators } } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(uiConfig().voice.indicators, indicators);
  assert.equal(uiConfig().richText, true);
});

test("an older indicator response reconciles against the newer selection in the config store", async (t) => {
  const newer = { ...uiConfig().voice, indicators: ["status-line", "edge", "floating"] };
  let acknowledge!: (response: Response) => void;
  const earlier = new Promise<Response>(resolve => { acknowledge = resolve; });
  t.mock.method(globalThis, "fetch", async (path: string, init: RequestInit) => {
    if (path === "/api/voice/indicators") return earlier;
    assert.equal(path, "/api/ui/config");
    return init.method === "PUT" ? Response.json({ ok: true })
      : Response.json({ configured: true, config: { ...uiConfig(), voice: newer } });
  });
  const saving = updateVoiceIndicator("edge", true);
  await updateUiConfig({ voice: newer });
  acknowledge(Response.json({ indicators: ["status-line", "edge"] }));
  assert.equal(await saving, "saved");
  assert.deepEqual(uiConfig().voice.indicators, newer.indicators);
});

test("a confirmed indicator save returns while its reconciliation read is still pending", async (t) => {
  let acknowledge!: (response: Response) => void;
  let finishRead!: (response: Response) => void;
  const write = new Promise<Response>(resolve => { acknowledge = resolve; });
  const read = new Promise<Response>(resolve => { finishRead = resolve; });
  let reads = 0;
  t.mock.method(globalThis, "fetch", async (path: string) => {
    if (path === "/api/voice/indicators") return write;
    assert.equal(path, "/api/ui/config");
    reads++;
    return read;
  });
  const indicators = ["status-line", "edge"];
  const saved = updateVoiceIndicator("edge", true);
  applyVoiceIndicatorSelection(indicators);
  acknowledge(Response.json({ indicators }));
  const beforeRead = await Promise.race([saved, new Promise(resolve => setImmediate(resolve))]);
  const newer = [...indicators, "topbar"];
  finishRead(Response.json({ configured: true, config: { ...uiConfig(), voice: { ...uiConfig().voice, indicators: newer } } }));
  await saved;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(beforeRead, "saved");
  assert.equal(reads, 1);
  assert.deepEqual(uiConfig().voice.indicators, newer);
});
