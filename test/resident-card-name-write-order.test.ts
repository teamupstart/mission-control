import assert from "node:assert/strict";
import test from "node:test";

// Each write is held open until the test releases it, which is the overlap a quick double click
// produces.

const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
});

interface HeldWrite {
  body: Record<string, unknown>;
  finish: (response: Response) => void;
}
const writes: HeldWrite[] = [];
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: async (_path: string, init?: RequestInit) =>
    new Promise<Response>((resolve) => {
      writes.push({ body: JSON.parse(String(init?.body ?? "{}")), finish: resolve });
    }),
});

const { uiConfig } = await import("../src/web/lib/uiConfig.ts");
const { setResidentCardNameStyle } = await import("../src/web/lib/board-card.ts");

const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
const refused = () => new Response(JSON.stringify({ error: "temporary failure" }), { status: 503 });
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("overlapping style clicks are sent one at a time, in the order they were made", async () => {
  setResidentCardNameStyle([], "subtitle", true);
  setResidentCardNameStyle(uiConfig().residentCardNameStyles, "chip", true);
  await settle();
  assert.deepEqual(uiConfig().residentCardNameStyles, ["subtitle", "chip"]);
  assert.equal(writes.length, 1, "the second write was sent before the first was answered");
  assert.deepEqual(writes[0]!.body, { residentCardNameStyles: ["subtitle"] });

  writes[0]!.finish(ok());
  await settle();
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1]!.body, { residentCardNameStyles: ["subtitle", "chip"] }, "the later list is the last one sent");
  writes[1]!.finish(ok());
  await settle();
  assert.deepEqual(uiConfig().residentCardNameStyles, ["subtitle", "chip"]);
});

test("a refused style write still releases the one queued behind it", async () => {
  writes.length = 0;
  setResidentCardNameStyle(["subtitle", "chip"], "chip", false);
  setResidentCardNameStyle(uiConfig().residentCardNameStyles, "subtitle", false);
  await settle();
  assert.equal(writes.length, 1);
  writes[0]!.finish(refused());
  await settle();
  assert.equal(writes.length, 2, "a refused write blocked the queue");
  assert.deepEqual(writes[1]!.body, { residentCardNameStyles: [] });
  writes[1]!.finish(ok());
  await settle();
  assert.deepEqual(uiConfig().residentCardNameStyles, []);
});

test("other preferences are not held behind a pending style write", async () => {
  writes.length = 0;
  const { updateUiConfig } = await import("../src/web/lib/uiConfig.ts");
  setResidentCardNameStyle([], "chip", true);
  const other = updateUiConfig({ richText: false });
  await settle();
  assert.equal(writes.length, 2, "an unrelated preference waited for the style write");
  for (const write of writes) write.finish(ok());
  assert.equal(await other, true);
});
