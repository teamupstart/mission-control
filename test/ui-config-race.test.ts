import assert from "node:assert/strict";
import test from "node:test";

const store = new Map<string, string>();
let calls = 0;
let finishTourWrite: ((response: Response) => void) | undefined;

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
    if (calls === 1) {
      return new Promise<Response>((resolve) => {
        finishTourWrite = resolve;
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  },
});

const { uiConfig, updateUiConfig } = await import("../src/web/lib/uiConfig.ts");

test("a failed background tour write does not restore over a newer preference", async () => {
  const consumingTour = updateUiConfig({ guidedTour: false });
  await new Promise((resolve) => setImmediate(resolve));
  await updateUiConfig({ richText: false });
  finishTourWrite?.(new Response(JSON.stringify({ error: "temporary failure" }), { status: 503 }));
  assert.equal(await consumingTour, false);
  assert.equal(uiConfig().guidedTour, true, "the failed request restores only its own field");
  assert.equal(uiConfig().richText, false, "the later preference remains in the live cache");
});
