// Adopting an older build's browser settings sends them to the daemon as one patch. That patch
// must not name `voice`: legacy storage never held it, and the daemon refuses a patch naming it
// while the voice flag is off, which would fail the whole adoption.
import assert from "node:assert/strict";
import test from "node:test";

const store = new Map<string, string>([["ai-harness.layout", "board"], ["ai-harness.rich-text", "0"]]);
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
});

// A failed adoption schedules a hydration retry; captured here so it can never keep the process alive.
const timers: Array<() => void> = [];
Object.defineProperty(globalThis, "setTimeout", {
  configurable: true,
  value: (callback: () => void) => { timers.push(callback); return timers.length; },
});

const writes: Array<Record<string, unknown>> = [];
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: async (_url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "PUT") {
      const patch = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
      writes.push(patch);
      // What the daemon answers with the voice flag off.
      if ("voice" in patch) return new Response(JSON.stringify({ error: "This feature is disabled.", feature: "voice" }), { status: 404 });
      return new Response(JSON.stringify({ configured: true, config: {} }), { status: 200 });
    }
    return new Response(JSON.stringify({ configured: false, config: {} }), { status: 200 });
  },
});

const { hydrateUiConfig, uiConfig, uiConfigHydrated } = await import("../src/web/lib/uiConfig.ts");

test("legacy settings are adopted with a patch that does not name voice", async () => {
  await hydrateUiConfig();
  assert.equal(writes.length, 1);
  assert.equal("voice" in writes[0]!, false, "the adoption patch leaves voice out");
  assert.equal(writes[0]!.layout, "board");
  assert.equal(writes[0]!.richText, false);
  assert.equal(uiConfigHydrated(), true, "the adoption succeeded");
  assert.equal(timers.length, 0, "and no retry was scheduled");
  assert.deepEqual(uiConfig().voice, { confirmation: "pill", indicators: ["status-line"] }, "this window keeps its own voice value");
});
