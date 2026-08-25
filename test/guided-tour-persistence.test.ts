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
const {
  canStartGuidedTour,
  consumeGuidedTour,
  GUIDED_TOUR_PERSIST_MAX_RETRIES,
  GUIDED_TOUR_PERSIST_MAX_RETRY_MS,
  GUIDED_TOUR_PERSIST_RETRY_MS,
} = await import("../src/web/lib/guided-tour.ts");

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

test("a consumed session cannot reopen the tour while persistence retries", () => {
  assert.equal(canStartGuidedTour(true, false), true);
  assert.equal(canStartGuidedTour(true, true), false);
});

test("failed guided-tour persistence keeps reloads consumed and uses bounded backoff", async () => {
  let attempts = 0;
  const retries: Array<{ callback: () => void; delay: number }> = [];
  consumeGuidedTour(
    async () => {
      attempts += 1;
      return false;
    },
    (callback, delay) => {
      retries.push({ callback, delay });
      return 0;
    },
  );
  for (let retry = 0; retry < GUIDED_TOUR_PERSIST_MAX_RETRIES; retry += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(retries[retry]?.delay, Math.min(
      GUIDED_TOUR_PERSIST_RETRY_MS * (2 ** retry),
      GUIDED_TOUR_PERSIST_MAX_RETRY_MS,
    ));
    retries[retry]?.callback();
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, GUIDED_TOUR_PERSIST_MAX_RETRIES + 1);
  assert.equal(retries.length, GUIDED_TOUR_PERSIST_MAX_RETRIES);
  assert.equal(canStartGuidedTour(true, store.get("ai-harness.guided-tour-consumption-pending") === "true"), false);

  consumeGuidedTour(async () => true);
  await new Promise((resolve) => setImmediate(resolve));
});
