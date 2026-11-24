// The speech model manager (contract H) against a local fixture server: a download that verifies,
// a digest mismatch, a short file, Cancel, a stall, Retry after a failure, the start-up hash, a
// same-size edit refused at the next start, a new revision replacing the old, and the routes.
// Nothing here reaches Hugging Face: every manifest below names fixture files, and the manager is
// pointed at the fixture server the way `MISSION_VOICE_MODEL_BASE_URL` points the daemon.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "mission-voice-model-"));
process.env.HARNESS_HOME = home;
const { VoiceModelManager, voiceModelManifestsFromEnv, voiceModelBaseUrlFromEnv } = await import("../src/server/voice/models.ts");
const { VoiceStateStore } = await import("../src/server/voice/state.ts");
const { registerVoiceRoutes } = await import("../src/server/voice/routes.ts");
const flags = await import("../src/server/feature-flags/index.ts");
const { closeDb } = await import("../src/server/db.ts");
const { Hono } = await import("hono");
const { VOICE_CONFIG_DEFAULTS, VOICE_MODEL_STATE_NONE } = await import("../src/shared/voice.ts");
const { VOICE_MODELS } = await import("../src/shared/voice-models.ts");
type VoiceModelManagerType = InstanceType<typeof VoiceModelManager>;
type VoiceModelState = import("../src/shared/voice.ts").VoiceModelState;
type VoiceModelManifest = import("../src/shared/voice-models.ts").VoiceModelManifest;
type VoiceBackend = import("../src/shared/voice.ts").VoiceBackend;

// ---- fixture files and a server that can misbehave on request ----

const COMMIT = "c0ffee".padEnd(40, "0");
const REPOSITORY = "fixture/parakeet-fixture";

interface Fixture {
  path: string;
  url: string;
  body: Buffer;
}

function fixture(file: string, size: number): Fixture {
  return {
    path: `parakeet-fixture/${file}`,
    url: `https://huggingface.co/${REPOSITORY}/resolve/${COMMIT}/${file}`,
    body: randomBytes(size),
  };
}

const FILES = [fixture("Encoder.mlmodelc/weights/weight.bin", 256 * 1024), fixture("vocab.json", 3000), fixture("Decoder.mlmodelc/coremldata.bin", 500)];

function manifest(revision: string, files: readonly Fixture[] = FILES): VoiceModelManifest {
  return {
    revision,
    label: "Fixture model",
    sources: [{ repository: REPOSITORY, commit: COMMIT, license: "CC-BY-4.0", basedOn: "fixture/upstream" }],
    files: files.map((file) => ({
      path: file.path,
      url: file.url,
      bytes: file.body.length,
      sha256: createHash("sha256").update(file.body).digest("hex"),
    })),
  };
}

type Behavior = "ok" | "corrupt" | "short" | "long" | "wrong-length" | "hold" | "missing" | "gzip";

const server = {
  origin: "",
  behavior: new Map<string, Behavior>(),
  requests: [] as string[],
  acceptEncodings: [] as string[],
  holds: [] as Array<() => void>,
  bodies: new Map<string, Buffer>(),
};

function handle(request: IncomingMessage, response: ServerResponse): void {
  const prefix = `/${REPOSITORY}/resolve/${COMMIT}/`;
  const file = (request.url ?? "").startsWith(prefix) ? request.url!.slice(prefix.length) : null;
  const body = file === null ? undefined : server.bodies.get(file);
  server.requests.push(file ?? request.url ?? "");
  server.acceptEncodings.push(String(request.headers["accept-encoding"] ?? ""));
  const behavior = (file && server.behavior.get(file)) ?? "ok";
  if (!body || behavior === "missing") {
    response.writeHead(404).end("not found");
    return;
  }
  switch (behavior) {
    case "ok":
      response.writeHead(200, { "content-length": body.length }).end(body);
      return;
    case "corrupt": {
      const bad = Buffer.from(body);
      bad[bad.length - 1] = bad[bad.length - 1]! ^ 0xff;
      response.writeHead(200, { "content-length": bad.length }).end(bad);
      return;
    }
    case "short":
      // No length header, so nothing can refuse it before it ends: the stream simply stops early.
      response.writeHead(200, { "transfer-encoding": "chunked" });
      response.end(body.subarray(0, Math.floor(body.length / 2)));
      return;
    case "gzip": {
      // Compressed whatever the request asked for, as a CDN in between might: the length header
      // is the compressed size, and `fetch` decodes the body.
      const packed = gzipSync(body);
      response.writeHead(200, { "content-encoding": "gzip", "content-length": packed.length });
      response.end(packed);
      return;
    }
    case "long":
      // The whole file and then more, with no length header to refuse it up front: only the
      // running count can tell it went past its pinned size.
      response.writeHead(200, { "transfer-encoding": "chunked" });
      response.write(body);
      response.end(randomBytes(4096));
      return;
    case "wrong-length":
      response.writeHead(200, { "content-length": body.length - 1 }).end(body.subarray(0, body.length - 1));
      return;
    case "hold":
      // Half now, the rest when the test releases it, so a test can act mid-download.
      response.writeHead(200, { "content-length": body.length });
      response.write(body.subarray(0, Math.floor(body.length / 2)));
      server.holds.push(() => { if (!response.destroyed) response.end(body.subarray(Math.floor(body.length / 2))); });
      return;
  }
}

const http = createServer(handle);
before(async () => {
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  server.origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  for (const file of FILES) server.bodies.set(file.path.slice("parakeet-fixture/".length), file.body);
});
afterEach(() => {
  for (const release of server.holds.splice(0)) release();
  server.behavior.clear();
  server.requests.length = 0;
  server.acceptEncodings.length = 0;
});
after(async () => {
  http.closeAllConnections();
  await new Promise<void>((resolve) => http.close(() => resolve()));
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

// ---- a manager over a temp root ----

interface Harness {
  manager: VoiceModelManagerType;
  root: string;
  dir(revision?: string): string;
  published: VoiceModelState[];
  setManifest(next: VoiceModelManifest | null): void;
  active: { on: boolean };
}

function harness(options: {
  root?: string; manifest?: VoiceModelManifest | null; stallMs?: number; backend?: VoiceBackend; progressEveryMs?: number;
  removeDir?: (path: string) => Promise<void>;
} = {}): Harness {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "mission-voice-models-"));
  let current: VoiceModelManifest | null = options.manifest === undefined ? manifest("r1") : options.manifest;
  const active = { on: true };
  const backend = options.backend ?? "fluidaudio";
  const manager = new VoiceModelManager({
    root: () => root,
    active: () => active.on,
    backend: () => backend,
    manifests: () => ({ fluidaudio: backend === "fluidaudio" ? current : null, "sherpa-onnx": backend === "sherpa-onnx" ? current : null }),
    baseUrl: () => server.origin,
    progressEveryMs: options.progressEveryMs ?? 0,
    stallMs: options.stallMs ?? 10_000,
    ...(options.removeDir ? { removeDir: options.removeDir } : {}),
  });
  const published: VoiceModelState[] = [];
  manager.onChange((model) => published.push(model));
  return {
    manager,
    root,
    dir: (revision = current?.revision ?? "r1") => join(root, backend, revision),
    published,
    setManifest: (next) => { current = next; },
    active,
  };
}

/** Resolve once the manager's state satisfies `predicate`. */
function until(manager: VoiceModelManagerType, predicate: (model: VoiceModelState) => boolean): Promise<VoiceModelState> {
  const now = manager.state();
  if (predicate(now)) return Promise.resolve(now);
  return new Promise((resolve) => {
    const stop = manager.onChange((model) => {
      if (!predicate(model)) return;
      stop();
      resolve(model);
    });
  });
}

function partFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return (readdirSync(root, { recursive: true }) as string[]).filter((name) => name.endsWith(".part"));
}

/** Put the fixture files on disk as a finished download would leave them. */
function placeFiles(dir: string, files: readonly Fixture[] = FILES): void {
  for (const file of files) {
    const target = join(dir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.body);
  }
}

const TOTAL = FILES.reduce((sum, file) => sum + file.body.length, 0);

/** A directory removal that waits until the test releases it, then removes for real. */
function heldRemoval(): { removeDir: (path: string) => Promise<void>; started: Promise<void>; release: () => void } {
  let release!: () => void;
  let markStarted!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  return {
    removeDir: async (path) => {
      markStarted();
      await gate;
      rmSync(path, { recursive: true, force: true });
    },
    started,
    release,
  };
}

// ---- the tests ----

test("a missing model reads missing at once, and Download fetches, verifies and keeps every file", async () => {
  const h = harness();
  h.manager.sync();
  assert.equal(h.manager.state().status, "missing");
  assert.equal(h.manager.state().totalBytes, TOTAL);
  assert.equal(h.manager.state().revision, "r1");
  const started = h.manager.download();
  assert.equal(started.ok, true);
  assert.equal(started.model.status, "downloading");
  const ready = await until(h.manager, (model) => model.status === "ready");
  assert.equal(ready.directory, h.dir());
  assert.equal(ready.doneBytes, TOTAL);
  for (const file of FILES) assert.deepEqual(readFileSync(join(h.dir(), file.path)), file.body, file.path);
  assert.deepEqual(partFiles(h.root), [], "no temporary file is left behind");
  const downloading = h.published.filter((model) => model.status === "downloading");
  assert.ok(downloading.length > 1, "progress is published while it downloads");
  const done = downloading.map((model) => model.doneBytes);
  assert.deepEqual(done, [...done].sort((a, b) => a - b), "progress only moves forward");
  assert.ok(done.some((bytes) => bytes > 0 && bytes < TOTAL), "a reading part-way through");
  assert.deepEqual(h.manager.download(), { ok: true, model: h.manager.state() }, "a verified model is not fetched again");
  assert.equal(server.requests.length, FILES.length);
});

test("progress held back by the publishing limit is still published when the download pauses", async () => {
  // The first chunks of a file arrive inside the limit's window; if nothing follows them (a slow
  // link, or here a held response), the bar must still show how far it got.
  const h = harness({ progressEveryMs: 200 });
  h.manager.sync();
  server.behavior.set("Encoder.mlmodelc/weights/weight.bin", "hold");
  h.manager.download();
  const paused = await until(h.manager, () => h.published.some((model) => model.status === "downloading" && model.doneBytes > 0));
  assert.equal(paused.status, "downloading");
  const last = h.published.at(-1)!;
  assert.equal(last.doneBytes, FILES[0]!.body.length / 2, "the published reading is the held half");
  for (const release of server.holds.splice(0)) release();
  await until(h.manager, (model) => model.status === "ready");
});

test("a file whose bytes do not match its digest fails, is deleted, and says so", async () => {
  const h = harness();
  h.manager.sync();
  server.behavior.set("vocab.json", "corrupt");
  h.manager.download();
  const failed = await until(h.manager, (model) => model.status === "failed");
  assert.equal(failed.error, "The download of parakeet-fixture/vocab.json did not match its checksum and was deleted.");
  assert.equal(existsSync(join(h.dir(), "parakeet-fixture/vocab.json")), false);
  assert.deepEqual(partFiles(h.root), []);
});

test("a short file fails as short, and a server offering the wrong size is refused before it is read", async () => {
  const short = harness();
  short.manager.sync();
  server.behavior.set("Encoder.mlmodelc/weights/weight.bin", "short");
  short.manager.download();
  const failed = await until(short.manager, (model) => model.status === "failed");
  assert.match(failed.error ?? "", /^The download of parakeet-fixture\/Encoder\.mlmodelc\/weights\/weight\.bin ended after 131072 of 262144 bytes and was deleted\.$/);
  assert.deepEqual(partFiles(short.root), []);

  server.behavior.set("Encoder.mlmodelc/weights/weight.bin", "wrong-length");
  const wrong = harness();
  wrong.manager.sync();
  wrong.manager.download();
  const refused = await until(wrong.manager, (model) => model.status === "failed");
  assert.equal(refused.error, "The server offered parakeet-fixture/Encoder.mlmodelc/weights/weight.bin as 262143 bytes, and its pinned size is 262144. Nothing was kept.");
  assert.deepEqual(partFiles(wrong.root), []);
});

test("a body that runs past its pinned size fails as too large, and nothing of it is kept", async () => {
  const h = harness();
  h.manager.sync();
  server.behavior.set("vocab.json", "long");
  h.manager.download();
  const failed = await until(h.manager, (model) => model.status === "failed");
  assert.equal(failed.error, `The download of parakeet-fixture/vocab.json is larger than its pinned ${FILES[1]!.body.length} bytes and was deleted.`);
  assert.equal(existsSync(join(h.dir(), "parakeet-fixture/vocab.json")), false, "the oversized file was not renamed into place");
  assert.deepEqual(partFiles(h.root), [], "and its temporary file is gone");
  assert.equal(failed.directory, null);
});

test("files are asked for uncompressed, and one compressed anyway is checked by its decoded bytes", async () => {
  const h = harness();
  h.manager.sync();
  server.behavior.set("vocab.json", "gzip");
  h.manager.download();
  const ready = await until(h.manager, (model) => model.status === "ready" || model.status === "failed");
  assert.equal(ready.status, "ready", ready.error ?? "");
  assert.deepEqual(readFileSync(join(h.dir(), "parakeet-fixture/vocab.json")), FILES[1]!.body);
  assert.ok(server.acceptEncodings.length > 0 && server.acceptEncodings.every((value) => value === "identity"), server.acceptEncodings.join(", "));
});

test("a 404 fails with the status, and a stalled download fails instead of hanging", async () => {
  const missing = harness();
  missing.manager.sync();
  server.behavior.set("vocab.json", "missing");
  missing.manager.download();
  assert.equal((await until(missing.manager, (model) => model.status === "failed")).error,
    "The download of parakeet-fixture/vocab.json failed: the server answered 404.");

  server.behavior.clear();
  server.behavior.set("Encoder.mlmodelc/weights/weight.bin", "hold");
  const stalled = harness({ stallMs: 150 });
  stalled.manager.sync();
  stalled.manager.download();
  assert.equal((await until(stalled.manager, (model) => model.status === "failed")).error,
    "The download of parakeet-fixture/Encoder.mlmodelc/weights/weight.bin stalled: nothing arrived for 150 ms.");
  assert.deepEqual(partFiles(stalled.root), []);
});

test("Cancel stops the download, removes everything it wrote, and reads missing again", async () => {
  const h = harness();
  h.manager.sync();
  server.behavior.set("vocab.json", "hold");
  h.manager.download();
  // The large file finishes, then the second is held half-way.
  await until(h.manager, (model) => model.status === "downloading" && model.doneBytes > FILES[0]!.body.length);
  assert.ok(existsSync(join(h.dir(), FILES[0]!.path)), "the first file was kept once it verified");
  const after = await h.manager.cancel();
  assert.equal(after.status, "missing");
  assert.equal(existsSync(h.dir()), false, "the unverified revision is gone");
  assert.deepEqual(partFiles(h.root), []);
  assert.equal(h.published.at(-1)?.status, "missing");
});

test("Cancel while voice is switched off removes the download and does not read the disk again", async () => {
  const h = harness();
  h.manager.sync();
  server.behavior.set("vocab.json", "hold");
  h.manager.download();
  await until(h.manager, (model) => model.status === "downloading" && model.doneBytes > FILES[0]!.body.length);
  // The flag goes off while Cancel is still removing the files: `sync` has set the state, and
  // the cancelled job must not publish a model over it once its cleanup ends.
  const cancelling = h.manager.cancel();
  h.active.on = false;
  h.manager.sync();
  assert.deepEqual(await cancelling, VOICE_MODEL_STATE_NONE);
  await h.manager.idle();
  assert.deepEqual(h.manager.state(), VOICE_MODEL_STATE_NONE);
  assert.deepEqual(h.published.at(-1), VOICE_MODEL_STATE_NONE, "nothing was published after voice went off");
  assert.equal(existsSync(h.dir()), false, "the cancelled download is still removed");
});

test("a Download pressed while Cancel is still removing files is a real job that a second Cancel stops", async () => {
  const removal = heldRemoval();
  const h = harness({ removeDir: removal.removeDir });
  h.manager.sync();
  server.behavior.set("vocab.json", "hold");
  h.manager.download();
  await until(h.manager, (model) => model.doneBytes > FILES[0]!.body.length);
  const first = h.manager.cancel();
  await removal.started;
  // Download again during the removal, then change your mind before it ends.
  assert.equal(h.manager.download().ok, true);
  assert.equal(h.manager.state().status, "downloading");
  const second = h.manager.cancel();
  const requested = server.requests.length;
  removal.release();
  await Promise.all([first, second]);
  await h.manager.idle();
  assert.equal(h.manager.state().status, "missing", "the second Cancel stopped the second download");
  assert.equal(server.requests.length, requested, "nothing was fetched after it");
  assert.equal(existsSync(h.dir()), false);
});

test("a removal still running when a new download starts never deletes that download's files", async () => {
  const removal = heldRemoval();
  const h = harness({ removeDir: removal.removeDir });
  h.manager.sync();
  server.behavior.set("vocab.json", "hold");
  h.manager.download();
  await until(h.manager, (model) => model.doneBytes > FILES[0]!.body.length);
  const cancelling = h.manager.cancel();
  await removal.started;
  // Voice off and on again while the directory is being removed: the check reads missing rather
  // than the half-removed files, and the new download waits for the removal before writing.
  h.active.on = false;
  h.manager.sync();
  h.active.on = true;
  h.manager.sync();
  assert.equal(h.manager.state().status, "missing");
  server.behavior.clear();
  for (const release of server.holds.splice(0)) release();
  h.manager.download();
  removal.release();
  await cancelling;
  const ready = await until(h.manager, (model) => model.status === "ready");
  assert.equal(ready.directory, h.dir());
  for (const file of FILES) assert.deepEqual(readFileSync(join(h.dir(), file.path)), file.body, file.path);
});

test("a Cancel whose removal fails reads failed with the reason, and Retry downloads again", async () => {
  const h = harness({ removeDir: async () => { throw new Error("EACCES: permission denied"); } });
  h.manager.sync();
  server.behavior.set("vocab.json", "hold");
  h.manager.download();
  await until(h.manager, (model) => model.doneBytes > FILES[0]!.body.length);
  const after = await h.manager.cancel();
  assert.equal(after.status, "failed", "not left downloading with no job behind it");
  assert.equal(after.error, "The cancelled download could not be removed: EACCES: permission denied");
  server.behavior.clear();
  assert.equal(h.manager.download().ok, true);
  assert.equal((await until(h.manager, (model) => model.status === "ready")).status, "ready");
});

test("a cached file that fails its checksum never moves the progress bar back", async () => {
  const h = harness();
  placeFiles(h.dir());
  const target = join(h.dir(), FILES[0]!.path);
  const tampered = readFileSync(target);
  tampered[0] = tampered[0]! ^ 0x01;
  writeFileSync(target, tampered);
  h.manager.sync();
  await until(h.manager, (model) => model.status === "failed");
  h.published.length = 0;
  h.manager.download();
  await until(h.manager, (model) => model.status === "ready");
  const done = h.published.filter((model) => model.status === "downloading").map((model) => model.doneBytes);
  assert.deepEqual(done, [...done].sort((a, b) => a - b), `progress only moves forward: ${done.join(", ")}`);
});

test("Retry after a failure fetches only what is missing or wrong, and verifies", async () => {
  const h = harness();
  h.manager.sync();
  server.behavior.set("Decoder.mlmodelc/coremldata.bin", "corrupt");
  h.manager.download();
  await until(h.manager, (model) => model.status === "failed");
  assert.deepEqual(server.requests, FILES.map((file) => file.path.slice("parakeet-fixture/".length)));
  server.behavior.clear();
  server.requests.length = 0;
  const retry = h.manager.download();
  assert.equal(retry.ok, true);
  const ready = await until(h.manager, (model) => model.status === "ready");
  assert.equal(ready.doneBytes, TOTAL);
  assert.deepEqual(server.requests, ["Decoder.mlmodelc/coremldata.bin"], "the two files that verified were hashed, not fetched");
});

test("a model already on disk reads verifying while it is hashed again, then ready", async () => {
  const h = harness();
  placeFiles(h.dir());
  h.manager.sync();
  assert.equal(h.manager.state().status, "verifying", "every file is the right size, so it is hashed before it reads ready");
  const ready = await until(h.manager, (model) => model.status === "ready");
  assert.equal(ready.directory, h.dir());
  assert.equal(server.requests.length, 0, "verifying fetches nothing");
  const verifying = h.published.filter((model) => model.status === "verifying");
  assert.ok(verifying.some((model) => model.doneBytes > 0), "verifying reports its progress");
});

test("a file altered on disk without changing its size is refused at the next start", async () => {
  const first = harness();
  first.manager.sync();
  first.manager.download();
  await until(first.manager, (model) => model.status === "ready");
  await first.manager.stop();

  const target = join(first.dir(), FILES[0]!.path);
  const tampered = readFileSync(target);
  tampered[1000] = tampered[1000]! ^ 0x01;
  writeFileSync(target, tampered);

  const next = harness({ root: first.root });
  next.manager.sync();
  assert.equal(next.manager.state().status, "verifying", "a same-size file passes the size check");
  const failed = await until(next.manager, (model) => model.status !== "verifying");
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "parakeet-fixture/Encoder.mlmodelc/weights/weight.bin does not match its pinned SHA-256 checksum. Download it again.");
  assert.equal(failed.directory, null, "a failed model names no directory a listener could load");

  // Retry replaces exactly that file.
  server.requests.length = 0;
  next.manager.download();
  await until(next.manager, (model) => model.status === "ready");
  assert.deepEqual(server.requests, ["Encoder.mlmodelc/weights/weight.bin"]);
  assert.deepEqual(readFileSync(target), FILES[0]!.body);
});

test("a missing file reads missing and a wrong size reads failed, both without hashing", async () => {
  const h = harness();
  placeFiles(h.dir(), FILES.slice(1));
  h.manager.sync();
  assert.equal(h.manager.state().status, "missing");
  await h.manager.stop();

  const sized = harness({ root: h.root });
  placeFiles(sized.dir());
  writeFileSync(join(sized.dir(), FILES[1]!.path), "too short");
  sized.manager.sync();
  const state = sized.manager.state();
  assert.equal(state.status, "failed");
  assert.equal(state.error, `parakeet-fixture/vocab.json is 9 bytes on disk, and its pinned size is ${FILES[1]!.body.length}. Download it again.`);
});

test("a new revision downloads beside the old one, which is removed only after the new one verifies", async () => {
  const h = harness();
  h.manager.sync();
  h.manager.download();
  await until(h.manager, (model) => model.status === "ready");
  const old = h.dir("r1");

  h.setManifest(manifest("r2"));
  h.manager.sync();
  assert.equal(h.manager.state().status, "missing", "the new revision is not on disk yet");
  assert.ok(existsSync(old), "the old revision stays while the new one is missing");
  server.behavior.set("vocab.json", "hold");
  h.manager.download();
  await until(h.manager, (model) => model.status === "downloading" && model.doneBytes > FILES[0]!.body.length);
  assert.ok(existsSync(old), "and while the new one downloads");
  for (const release of server.holds.splice(0)) release();
  const ready = await until(h.manager, (model) => model.status === "ready");
  assert.equal(ready.revision, "r2");
  assert.equal(existsSync(old), false, "removed once r2 verified");
  assert.deepEqual(readdirSync(join(h.root, "fluidaudio")), ["r2"]);
});

test("with the flag off the manager reads nothing and refuses to download; a backend with no model says so", async () => {
  const off = harness();
  off.active.on = false;
  off.manager.sync();
  assert.deepEqual(off.manager.state(), VOICE_MODEL_STATE_NONE);
  assert.deepEqual(off.manager.download(), { ok: false, reason: "Voice addressing is off.", model: VOICE_MODEL_STATE_NONE });

  const none = harness({ manifest: null, backend: "sherpa-onnx" });
  none.manager.sync();
  const state = none.manager.state();
  assert.equal(state.status, "missing");
  assert.equal(state.backend, "sherpa-onnx");
  assert.equal(state.revision, null);
  assert.equal(state.error, "No speech model for sherpa-onnx is available in this build yet.");
  const refused = none.manager.download();
  assert.equal(refused.ok, false);
  assert.equal(server.requests.length, 0);
});

test("turning the flag off mid-download stops it, and the next Download resumes from the files that verified", async () => {
  const h = harness();
  h.manager.sync();
  server.behavior.set("vocab.json", "hold");
  h.manager.download();
  await until(h.manager, (model) => model.doneBytes > FILES[0]!.body.length);
  h.active.on = false;
  h.manager.sync();
  assert.deepEqual(h.manager.state(), VOICE_MODEL_STATE_NONE);
  await h.manager.idle();
  assert.deepEqual(partFiles(h.root), [], "the half-written file is removed");
  assert.ok(existsSync(join(h.dir(), FILES[0]!.path)), "the verified file is kept");

  server.behavior.clear();
  server.requests.length = 0;
  h.active.on = true;
  h.manager.sync();
  assert.equal(h.manager.state().status, "missing");
  h.manager.download();
  await until(h.manager, (model) => model.status === "ready");
  assert.deepEqual(server.requests, ["vocab.json", "Decoder.mlmodelc/coremldata.bin"]);
});

test("the environment overrides: a manifest file in the same shape, and only an http(s) base URL", () => {
  assert.equal(voiceModelManifestsFromEnv(undefined), VOICE_MODELS);
  const dir = mkdtempSync(join(tmpdir(), "mission-voice-manifest-"));
  const path = join(dir, "manifest.json");
  writeFileSync(path, JSON.stringify({ fluidaudio: manifest("fixture-r1") }));
  const loaded = voiceModelManifestsFromEnv(path);
  assert.equal(loaded.fluidaudio?.revision, "fixture-r1");
  assert.equal(loaded["sherpa-onnx"], VOICE_MODELS["sherpa-onnx"]);
  const unpinned = manifest("bad");
  unpinned.files[0] = { ...unpinned.files[0]!, url: unpinned.files[0]!.url.replace(COMMIT, "main") };
  writeFileSync(path, JSON.stringify({ fluidaudio: unpinned }));
  assert.equal(voiceModelManifestsFromEnv(path), VOICE_MODELS, "an unpinned override is not used");
  rmSync(dir, { recursive: true, force: true });

  assert.equal(voiceModelBaseUrlFromEnv(undefined), null);
  assert.equal(voiceModelBaseUrlFromEnv(" http://127.0.0.1:9 "), "http://127.0.0.1:9");
  assert.equal(voiceModelBaseUrlFromEnv("file:///tmp"), null);
  assert.equal(voiceModelBaseUrlFromEnv("not a url"), null);
});

test("an explicit launcher override verifies the alternate revision without switching Setup", async t => {
  const root = mkdtempSync(join(tmpdir(), "voice-launch-model-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const alternate = manifest("alternate");
  const manager = new VoiceModelManager({
    root: () => root, active: () => true, backend: () => "fluidaudio",
    manifests: () => ({ fluidaudio: null, "sherpa-onnx": alternate }), baseUrl: () => null,
  });
  const directory = join(root, "sherpa-onnx", alternate.revision);
  const signal = new AbortController().signal;
  assert.equal(await manager.listenerModel("sherpa-onnx", signal), null);
  placeFiles(directory);
  assert.deepEqual(await manager.listenerModel("sherpa-onnx", signal), { backend: "sherpa-onnx", manifest: alternate, directory });
  const first = FILES[0]!;
  writeFileSync(join(directory, first.path), Buffer.alloc(first.body.length));
  assert.equal(await manager.listenerModel("sherpa-onnx", signal), null, "a same-size corrupt file is refused");
  assert.equal(await manager.listenerModel(undefined, signal), null);
});

test("the download routes start, refuse and cancel, and answer 404 with the flag off", async () => {
  const h = harness();
  h.manager.sync();
  const store = new VoiceStateStore({
    now: () => Date.now(),
    enabled: flags.featureEnabled,
    config: () => VOICE_CONFIG_DEFAULTS,
    model: () => h.manager.state(),
  });
  const app = new Hono();
  registerVoiceRoutes(app, store, h.manager);
  const request = (method: string, path = "/api/voice/model/download") => app.request(path, { method });
  const setFlag = (id: "voice", enabled: boolean) => assert.equal(flags.applyFeatureFlagIntent({ kind: "flag", id, enabled }).ok, true);

  setFlag("voice", false);
  for (const method of ["POST", "DELETE"]) {
    const response = await request(method);
    assert.equal(response.status, 404, method);
    assert.deepEqual(await response.json(), { error: "This feature is disabled.", feature: "voice" });
  }
  assert.equal((await request("GET", "/api/voice/devices")).status, 404);

  setFlag("voice", true);
  server.behavior.set("vocab.json", "hold");
  const started = await request("POST");
  assert.equal(started.status, 202);
  assert.equal(((await started.json()) as { model: VoiceModelState }).model.status, "downloading");
  await until(h.manager, (model) => model.doneBytes > FILES[0]!.body.length);
  const again = await request("POST");
  assert.equal(again.status, 202, "a second press while it runs is not a second download");
  const cancelled = await request("DELETE");
  assert.equal(cancelled.status, 200);
  assert.equal(((await cancelled.json()) as { model: VoiceModelState }).model.status, "missing");
  assert.equal(existsSync(h.dir()), false);

  const devices = await request("GET", "/api/voice/devices");
  assert.deepEqual(await devices.json(), { devices: [], listener: false });

  h.setManifest(null);
  const none = harness({ manifest: null, backend: "sherpa-onnx" });
  none.manager.sync();
  const noneApp = new Hono();
  registerVoiceRoutes(noneApp, store, none.manager);
  const refused = await noneApp.request("/api/voice/model/download", { method: "POST" });
  assert.equal(refused.status, 409);
  const body = await refused.json() as { error: string; reason: string };
  assert.equal(body.error, "model_unavailable");
  assert.equal(body.reason, "No speech model for sherpa-onnx is available in this build yet.");
  setFlag("voice", false);
});

