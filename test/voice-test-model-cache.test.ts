import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { VOICE_TEST_MODEL } from "../src/shared/voice-models.ts";
import { voiceTestModel } from "./helpers/voice-test-model.ts";

test("cold unit shards stay offline, required downloads exhaust three attempts, corrupt cache hits fail", async t => {
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
  await assert.rejects(voiceTestModel(true), /Wrong digest/);
  assert.equal(fetch.mock.callCount(), 3);
});
