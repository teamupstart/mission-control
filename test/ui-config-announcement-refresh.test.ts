import assert from "node:assert/strict";
import test from "node:test";

/**
 * `refreshAnnouncedTours` re-reads one field from the daemon just before an announcement-driven
 * startup opening. These cases drive its three outcomes against the real store with a scripted
 * `fetch`: adopting the daemon's list, refusing to let a response that was already in flight
 * overwrite a local announcement write that began after it, and changing nothing when the daemon
 * cannot answer.
 */

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

/** What the next GET /api/ui/config answers, or a hold the test releases itself. */
let nextRead: { announcedTours: readonly string[] } | { status: number } | "hold" = { announcedTours: [] };
let releaseHeldRead: ((response: Response) => void) | undefined;
const writes: unknown[] = [];

const view = (announcedTours: readonly string[]): Response => new Response(
  JSON.stringify({ configured: true, config: { ...UI_CONFIG_DEFAULTS, announcedTours: [...announcedTours] } }),
  { status: 200 },
);

Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: async (_input: unknown, init?: RequestInit) => {
    if (init?.method === "PUT") {
      writes.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    const read = nextRead;
    if (read === "hold") {
      return new Promise<Response>((resolve) => { releaseHeldRead = resolve; });
    }
    if ("status" in read) return new Response(JSON.stringify({ error: "unavailable" }), { status: read.status });
    return view(read.announcedTours);
  },
});

const { refreshAnnouncedTours, uiConfig, updateUiConfig } = await import("../src/web/lib/uiConfig.ts");

test("a refresh adopts the daemon's announcedTours over the copy this window loaded", async () => {
  // The cold cache reads every announced tour as seen; the daemon's record owes one.
  assert.deepEqual(uiConfig().announcedTours, [...UI_CONFIG_DEFAULTS.announcedTours]);
  nextRead = { announcedTours: [] };
  assert.equal(await refreshAnnouncedTours(), true);
  assert.deepEqual(uiConfig().announcedTours, []);
});

test("a stale refresh response cannot overwrite an announcement write that began after it", async () => {
  assert.deepEqual(uiConfig().announcedTours, []);
  // The refresh goes out and its response is held.
  nextRead = "hold";
  const refreshing = refreshAnnouncedTours();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(releaseHeldRead, "the refresh read is in flight");

  // Meanwhile this window announces the tour and records it.
  assert.equal(await updateUiConfig({ announcedTours: ["residents"] }), true);
  assert.deepEqual(writes.at(-1), { announcedTours: ["residents"] });
  assert.deepEqual(uiConfig().announcedTours, ["residents"]);

  // The held response lands carrying the record as it was before that write.
  releaseHeldRead!(view([]));
  assert.equal(await refreshing, true, "the daemon answered");
  assert.deepEqual(uiConfig().announcedTours, ["residents"], "the newer local write stands");
});

test("a refresh the daemon cannot answer changes nothing and says so", async () => {
  const before = uiConfig().announcedTours;
  nextRead = { status: 503 };
  assert.equal(await refreshAnnouncedTours(), false);
  assert.equal(uiConfig().announcedTours, before);

  // With no write in between, the next answered refresh adopts the daemon's list again: the
  // case above kept its write because one began, not because a refresh cannot apply.
  nextRead = { announcedTours: ["residents", "from-a-newer-build"] };
  assert.equal(await refreshAnnouncedTours(), true);
  assert.deepEqual(uiConfig().announcedTours, ["residents", "from-a-newer-build"]);
});
