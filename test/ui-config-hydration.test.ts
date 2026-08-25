import assert from "node:assert/strict";
import test from "node:test";

const store = new Map<string, string>();
let online = false;
const timers: Array<{ callback: () => void; delay: number }> = [];

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
});
Object.defineProperty(globalThis, "setTimeout", {
  configurable: true,
  value: (callback: () => void, delay: number) => {
    timers.push({ callback, delay });
    return timers.length;
  },
});
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: async () => {
    if (!online) throw new Error("daemon unavailable");
    return new Response(JSON.stringify({ configured: false, config: {} }), { status: 200 });
  },
});

const {
  hydrateUiConfig,
  uiConfigHydrated,
  UI_CONFIG_HYDRATE_MAX_RETRY_MS,
  UI_CONFIG_HYDRATE_RETRY_MS,
} = await import("../src/web/lib/uiConfig.ts");

test("a failed config hydration keeps onboarding unavailable and uses capped retries", async () => {
  await hydrateUiConfig();
  assert.equal(uiConfigHydrated(), false);
  assert.equal(timers.length, 1);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    assert.equal(timers[attempt]?.delay, Math.min(
      UI_CONFIG_HYDRATE_RETRY_MS * (2 ** attempt),
      UI_CONFIG_HYDRATE_MAX_RETRY_MS,
    ));
    timers[attempt]?.callback();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(timers[6]?.delay, UI_CONFIG_HYDRATE_MAX_RETRY_MS);

  online = true;
  timers[6]?.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(uiConfigHydrated(), true);
});
