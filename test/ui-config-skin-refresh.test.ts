import assert from "node:assert/strict";
import test from "node:test";
import {
  applyVoiceIndicatorSelection, hydrateUiConfig, refreshUiSkin, uiConfig, updateUiConfig,
} from "../src/web/lib/uiConfig.ts";
import { api } from "../src/web/lib/api.ts";

test("out-of-order skin refreshes preserve newer peer selections, local writes and independent voice state", async (t) => {
  const reads: Array<(response: Response) => void> = [];
  const writes: Array<(response: Response) => void> = [];
  const reply = (skin: "default" | "daylight" | "paper") => Response.json({ skin });
  t.mock.method(globalThis, "fetch", async (path: string, init?: RequestInit) => {
    if (path === "/api/ui/config" && init?.method !== "PUT") {
      return Response.json({ configured: true, config: uiConfig() });
    }
    const write = init?.method === "PUT";
    assert.equal(path, write ? "/api/ui/config" : "/api/ui/skin");
    return new Promise<Response>(resolve => (write ? writes : reads).push(resolve));
  });
  await hydrateUiConfig();
  applyVoiceIndicatorSelection(["status-line", "edge"], { source: "fixture", revision: 1 });
  const first = refreshUiSkin();
  const second = refreshUiSkin();
  const voice = uiConfig().voice;
  reads[1]!(reply("daylight"));
  await second;
  reads[0]!(reply("default"));
  await first;
  assert.equal(uiConfig().skin, "daylight");
  assert.equal(uiConfig().voice, voice);

  const stale = refreshUiSkin();
  const ownFirst = updateUiConfig({ skin: "default" });
  const ownSecond = updateUiConfig({ skin: "paper" });
  await Promise.resolve();
  assert.equal(writes.length, 1, "this window sends edits in user selection order");
  await refreshUiSkin();
  reads[2]!(reply("daylight"));
  await stale;
  assert.equal(uiConfig().skin, "paper");

  writes[0]!(Response.json({ ok: true }));
  await ownFirst;
  assert.equal(writes.length, 2);
  writes[1]!(Response.json({ ok: true }));
  await ownSecond;
  assert.equal(uiConfig().skin, "paper");
  reads[3]!(reply("paper"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(uiConfig().skin, "paper");
  assert.equal(uiConfig().voice, voice);
});

test("failed skin reads retry with backoff until refreshed or superseded", async (t) => {
  const reads: Array<(response: Response) => void> = [];
  t.mock.method(globalThis, "fetch", async (path: string) => {
    if (path === "/api/ui/config") return Response.json({ configured: true, config: uiConfig() });
    assert.equal(path, "/api/ui/skin");
    return new Promise<Response>(resolve => reads.push(resolve));
  });
  await hydrateUiConfig();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const busy = () => new Response(null, { status: 503 });
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  const prior = uiConfig().skin;
  const pending = refreshUiSkin();
  reads[0]!(busy());
  await pending;
  assert.equal(uiConfig().skin, prior);
  t.mock.timers.tick(999);
  assert.equal(reads.length, 1);
  t.mock.timers.tick(1);
  assert.equal(reads.length, 2);
  reads[1]!(busy());
  await settle();
  t.mock.timers.tick(1_999);
  assert.equal(reads.length, 2);
  t.mock.timers.tick(1);
  const recovered = prior === "daylight" ? "paper" : "daylight";
  reads[2]!(Response.json({ skin: recovered }));
  await settle();
  assert.equal(uiConfig().skin, recovered);

  const failing = refreshUiSkin();
  reads[3]!(busy());
  await failing;
  const newer = refreshUiSkin();
  reads[4]!(Response.json({ skin: "default" }));
  await newer;
  t.mock.timers.tick(30_000);
  assert.equal(reads.length, 5, "a new invalidation cancels the previous backoff");
  assert.equal(uiConfig().skin, "default");
});

test("an aborted settings response body is a failed save even after successful headers", async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async (path: string, init?: RequestInit) => {
    assert.equal(path, "/api/ui/config");
    assert.equal(init?.signal, controller.signal);
    return new Response(new ReadableStream({
      start(stream) {
        controller.signal.addEventListener("abort", () => stream.error(controller.signal.reason), { once: true });
      },
    }));
  });

  const result = api.setUiConfig({ skin: "paper" }, controller.signal);
  controller.abort(new DOMException("Save deadline expired", "TimeoutError"));
  assert.deepEqual(await result, { ok: false, error: "Save deadline expired" });
});
