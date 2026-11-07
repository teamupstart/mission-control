import assert from "node:assert/strict";
import test from "node:test";

// What is at stake: the daemon serves the document with the stored skin on `<html>`, but the
// dashboard's preference store seeds itself from the local cache, which a new profile does not
// have. If the store believed its cache, `lib/skin.ts` would replace the served Daylight with
// the cache's Default as its first act - the dark frame the served attribute exists to prevent.

const store = new Map<string, string>(); // a profile with no cache at all
const root = { dataset: { skin: "daylight" } as Record<string, string>, style: { colorScheme: "light" } };
const meta = { getAttribute: (name: string) => (name === "content" ? "daylight" : null) };
const backgrounds: string[] = [];

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
});
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: {
    documentElement: root,
    querySelector: (selector: string) => (selector === 'meta[name="mission-skin"]' ? meta : null),
  },
});
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { missionDesktop: { setWindowBackground: async (color: string) => void backgrounds.push(color) } },
});
Object.defineProperty(globalThis, "getComputedStyle", {
  configurable: true,
  value: () => ({ getPropertyValue: () => (root.dataset.skin === "daylight" ? "#f5f7fa" : "#0a0c0f") }),
});

const { uiConfig } = await import("../src/web/lib/uiConfig.ts");
await import("../src/web/lib/skin.ts");

test("with no cache, the served skin seeds the store and stays on <html>", () => {
  assert.equal(uiConfig().skin, "daylight", "the store fell back to the cache's Default");
  assert.equal(root.dataset.skin, "daylight", "the served Daylight was replaced by Default");
  assert.equal(root.style.colorScheme, "light");
  assert.deepEqual(backgrounds, ["#f5f7fa"]);
});
