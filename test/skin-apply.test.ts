import assert from "node:assert/strict";
import test from "node:test";

// What is at stake: `lib/skin.ts` is the one writer of `<html data-skin>`, and it learns
// about a skin only by following the preference store. If it ran only once, a picked tile
// would not repaint until a reload; if it ignored a rollback, a write the daemon refused
// would leave the page in a skin that is not stored. Both are a picker that lies.
//
// A minimal document and bridge stand in for the browser, and the cache is seeded with
// Daylight, so the module's load-time apply is observable too.

const store = new Map<string, string>([["mission-control.ui", JSON.stringify({ skin: "daylight" })]]);
const backgrounds: string[] = [];
let nextStatus = 200;
const root = { dataset: {} as Record<string, string>, style: { colorScheme: "" } };
const TOKENS: Record<string, string> = { default: "#0a0c0f", daylight: "#f5f7fa" };

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
});
Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: root } });
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { missionDesktop: { setWindowBackground: async (color: string) => void backgrounds.push(color) } },
});
Object.defineProperty(globalThis, "getComputedStyle", {
  configurable: true,
  value: () => ({ getPropertyValue: () => TOKENS[root.dataset.skin ?? "default"] }),
});
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: async () => new Response(JSON.stringify({}), { status: nextStatus }),
});

const { uiConfig, updateUiConfig } = await import("../src/web/lib/uiConfig.ts");
await import("../src/web/lib/skin.ts");

test("the cached skin is on <html> as soon as the module loads, before anything renders", () => {
  assert.equal(root.dataset.skin, "daylight");
  assert.equal(root.style.colorScheme, "light");
  assert.deepEqual(backgrounds, ["#f5f7fa"], "the desktop window was not told the skin's background");
});

test("picking Default repaints at once, and Default is the absence of the attribute", async () => {
  const saved = updateUiConfig({ skin: "default" });
  // Optimistic: applied before the daemon has answered.
  assert.equal(root.dataset.skin, undefined);
  assert.equal(root.style.colorScheme, "dark");
  assert.equal(await saved, true);
  assert.equal(backgrounds.at(-1), "#0a0c0f");
});

test("an unrelated preference does not re-apply the skin", async () => {
  const before = backgrounds.length;
  await updateUiConfig({ richText: false });
  assert.equal(backgrounds.length, before);
});

test("a skin the daemon refuses is taken back off the page", async () => {
  nextStatus = 400;
  const saved = updateUiConfig({ skin: "daylight" });
  assert.equal(root.dataset.skin, "daylight", "the optimistic skin was not applied");
  assert.equal(await saved, false);
  assert.equal(uiConfig().skin, "default");
  assert.equal(root.dataset.skin, undefined, "the rollback left a skin on the page that is not stored");
  assert.equal(root.style.colorScheme, "dark");
  assert.equal(backgrounds.at(-1), "#0a0c0f");
});
