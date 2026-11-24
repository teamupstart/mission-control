import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { VOICE_TEST_MODEL } from "../src/shared/voice-models.ts";
import { ensureCachedModelFile, voiceTestModel } from "./helpers/voice-test-model.ts";

test("cold unit shards stay offline, required downloads exhaust three attempts, offline corrupt hits fail", async t => {
  const root = await mkdtemp(join(tmpdir(), "voice-cache-"));
  const previous = process.env.MISSION_VOICE_TEST_MODEL_DIR;
  process.env.MISSION_VOICE_TEST_MODEL_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.MISSION_VOICE_TEST_MODEL_DIR;
    else process.env.MISSION_VOICE_TEST_MODEL_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
  assert.equal(await voiceTestModel(false), null);
  assert.equal(fetch.mock.callCount(), 0);
  await assert.rejects(voiceTestModel(true), /HTTP 503/);
  assert.equal(fetch.mock.callCount(), 3);
  const first = VOICE_TEST_MODEL.files[0]!;
  const path = join(root, first.path);
  await assert.rejects(readFile(path), { code: "ENOENT" });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.alloc(first.bytes));
  await assert.rejects(voiceTestModel(false), /Wrong digest/);
  assert.equal(fetch.mock.callCount(), 3);
});

for (const [reason, corrupt] of [["size", "short"], ["digest", "bad bytes"]] as const) {
  test(`the required job atomically repairs a cache file with the wrong ${reason}`, async t => {
    const root = await mkdtemp(join(tmpdir(), "voice-cache-repair-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const good = "new bytes";
    const file = { ...VOICE_TEST_MODEL.files[0]!, path: "model.onnx", bytes: good.length,
      sha256: createHash("sha256").update(good).digest("hex") };
    const path = join(root, file.path);
    await writeFile(path, corrupt);
    const original = await stat(path);
    let payload = "bad bytes";
    const fetch = t.mock.method(globalThis, "fetch", async (url: string) => {
      assert.equal(url, file.url);
      assert.equal(await readFile(path, "utf8"), corrupt);
      return new Response(payload);
    });
    await assert.rejects(ensureCachedModelFile(root, file, true), /Wrong digest/);
    assert.ok(fetch.mock.callCount() > 0, "a corrupt cache hit must trigger a replacement download");
    assert.equal((await stat(path)).ino, original.ino);
    assert.deepEqual(await readdir(root), [file.path]);

    payload = good;
    assert.equal(await ensureCachedModelFile(root, file, true), true);
    assert.equal(await readFile(path, "utf8"), good);
    assert.notEqual((await stat(path)).ino, original.ino);
    const requests = fetch.mock.callCount();
    assert.equal(await ensureCachedModelFile(root, file, false), true);
    assert.equal(fetch.mock.callCount(), requests);
  });
}
