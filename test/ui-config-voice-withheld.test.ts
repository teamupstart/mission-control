// With the `voice` flag off the daemon withholds `ui.voice` from `GET /api/ui/config`. A window
// that hydrates from such a response keeps the value it already holds, so the record it draws
// from stays whole, while every other field the daemon sent is adopted.
import assert from "node:assert/strict";
import test from "node:test";

const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
});

const { UI_CONFIG_DEFAULTS } = await import("../src/shared/protocol.ts");
const { readCache, writeCache } = await import("../src/web/lib/uiCache.ts");
const cachedVoice = { confirmation: "toast" as const, indicators: ["edge"] };
writeCache({ ...readCache(), voice: cachedVoice });

// The daemon's answer with the flag off: a configured record, `richText` changed, no `voice`.
const { voice: _withheld, ...withoutVoice } = { ...UI_CONFIG_DEFAULTS, richText: false };
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: async () => new Response(JSON.stringify({ configured: true, config: withoutVoice }), { status: 200 }),
});

const { hydrateUiConfig, uiConfig, uiConfigHydrated } = await import("../src/web/lib/uiConfig.ts");

test("hydrating from a response that withholds ui.voice keeps this window's value and adopts the rest", async () => {
  assert.deepEqual(uiConfig().voice, cachedVoice, "the cache seeded this window");
  await hydrateUiConfig();
  assert.equal(uiConfigHydrated(), true);
  assert.equal(uiConfig().richText, false, "a field the daemon sent is adopted");
  assert.deepEqual(uiConfig().voice, cachedVoice, "the withheld field keeps the value this window held");
  assert.deepEqual(readCache().voice, cachedVoice, "and the cache it writes back stays whole");
});
