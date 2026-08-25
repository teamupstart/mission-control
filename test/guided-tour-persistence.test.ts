import assert from "node:assert/strict";
import test from "node:test";

const store = new Map<string, string>();
const writes: unknown[] = [];
let firstRead = true;

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
  value: async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "PUT") {
      writes.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    assert.ok(firstRead, "the legacy-rescue test reads the daemon config once");
    firstRead = false;
    return new Response(JSON.stringify({ configured: false, config: {} }), { status: 200 });
  },
});

store.set("ai-harness.layout", "board");

const { hydrateUiConfig } = await import("../src/web/lib/uiConfig.ts");
const { consumeGuidedTour, GUIDED_TOUR_PERSIST_RETRY_MS } = await import("../src/web/lib/guided-tour.ts");

test("rescuing settings from a legacy product name consumes the guided tour", async () => {
  await hydrateUiConfig();
  assert.deepEqual(writes, [{
    layout: "board",
    keybindings: {},
    alerts: { notifications: false, sound: true },
    richText: true,
    keybindingHints: true,
    guidedDispatch: true,
    guidedTour: false,
    trustStaged: [],
    hiddenDisplayItems: ["worktree"],
    conversationView: "terminal",
  }]);
});

test("a failed guided-tour consumption schedules a durable retry", async () => {
  let attempts = 0;
  let retry: (() => void) | undefined;
  consumeGuidedTour(
    async () => ++attempts === 2,
    (callback, delay) => {
      assert.equal(delay, GUIDED_TOUR_PERSIST_RETRY_MS);
      retry = callback;
      return 0;
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 1);
  assert.ok(retry, "a failed write should schedule a retry");
  retry();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2);
});
