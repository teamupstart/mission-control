import assert from "node:assert/strict";
import test from "node:test";
import {
  applyVoiceIndicatorSelection, hydrateUiConfig, refreshUiSkin, uiConfig, updateUiConfig,
} from "../src/web/lib/uiConfig.ts";

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
