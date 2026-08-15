import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  base64EncodedBytes,
  LLM_IMAGE_LIMITS,
  llmRunInputBytes,
  type LlmImageInput,
  type LlmRunOptions,
} from "../src/shared/llm.ts";
import { validateLlmImages } from "../src/server/llm/images.ts";
import {
  ANIMATED_GIF_IMAGE,
  imageDescriptor,
  PNG_IMAGE,
  STATIC_GIF_IMAGE,
  writeImageDescriptor,
} from "./helpers/llm-image-fixtures.ts";

const root = mkdtempSync(join(tmpdir(), "llm-image-input-"));
after(() => rmSync(root, { recursive: true, force: true }));

function fixtureDir(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir);
  return dir;
}

test("LlmRunOptions carries an optional readonly image descriptor list", () => {
  const dir = fixtureDir("shape");
  const image = writeImageDescriptor(dir, "one.png", PNG_IMAGE, "image/png", "evidence-1");
  const omitted: LlmRunOptions = {};
  const supplied: LlmRunOptions = { images: [image] };
  assert.equal(omitted.images, undefined);
  assert.deepEqual(supplied.images, [image]);
});

test("runner image limits record raw and base64 ceilings for the next phase", () => {
  assert.deepEqual(LLM_IMAGE_LIMITS.mimeTypes, [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
  ]);
  assert.equal(LLM_IMAGE_LIMITS.maxCount, 8);
  assert.equal(LLM_IMAGE_LIMITS.maxBytesPerImage, 5 * 1024 * 1024);
  assert.equal(LLM_IMAGE_LIMITS.maxAggregateBytes, 20 * 1024 * 1024);
  assert.equal(
    base64EncodedBytes(LLM_IMAGE_LIMITS.maxBytesPerImage),
    6_990_508,
  );
  assert.equal(
    base64EncodedBytes(LLM_IMAGE_LIMITS.maxAggregateBytes),
    27_962_028,
  );
  assert.equal(LLM_IMAGE_LIMITS.allowAnimatedGif, false);
});

test("validation preserves order and the exact MIME, size, digest-checked bytes", () => {
  const dir = fixtureDir("valid");
  const png = writeImageDescriptor(dir, "one.png", PNG_IMAGE, "image/png", "one");
  const gif = writeImageDescriptor(dir, "two.gif", STATIC_GIF_IMAGE, "image/gif", "two");
  const images = validateLlmImages([png, gif]);
  assert.deepEqual(images.map((image) => image.id), ["one", "two"]);
  assert.deepEqual(images[0]?.data, PNG_IMAGE);
  assert.deepEqual(images[1]?.data, STATIC_GIF_IMAGE);
  assert.ok(Object.isFrozen(images));
  assert.ok(images.every(Object.isFrozen));
});

test("validation accepts every provider-compatible MIME signature", () => {
  const dir = fixtureDir("mimes");
  const inputs = [
    writeImageDescriptor(dir, "one.png", PNG_IMAGE, "image/png", "png"),
    writeImageDescriptor(dir, "one.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "image/jpeg", "jpeg"),
    writeImageDescriptor(dir, "one.gif", STATIC_GIF_IMAGE, "image/gif", "gif"),
    writeImageDescriptor(
      dir,
      "one.webp",
      Buffer.from("524946460400000057454250", "hex"),
      "image/webp",
      "webp",
    ),
  ];
  assert.deepEqual(validateLlmImages(inputs).map((image) => image.mimeType), [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
  ]);
});

test("validation refuses missing, non-regular, symlinked, changed, and spoofed files", () => {
  const dir = fixtureDir("refusals");
  const original = writeImageDescriptor(dir, "original.png", PNG_IMAGE, "image/png", "original");

  const missingPath = join(dir, "missing.png");
  const missing: LlmImageInput = { ...original, id: "missing", path: missingPath };
  assert.throws(() => validateLlmImages([missing]), /could not be opened or read/);

  const folder = join(dir, "folder.png");
  mkdirSync(folder);
  const directory: LlmImageInput = { ...original, id: "folder", path: folder };
  assert.throws(() => validateLlmImages([directory]), /must be a regular file/);

  const link = join(dir, "linked.png");
  symlinkSync(original.path, link);
  const symlinked: LlmImageInput = { ...original, id: "link", path: link };
  assert.throws(() => validateLlmImages([symlinked]), /non-symlink file/);

  const changed = { ...original, id: "changed" };
  writeFileSync(changed.path, Buffer.concat([PNG_IMAGE, Buffer.from([0])]));
  assert.throws(() => validateLlmImages([changed]), /size changed/);

  const spoofed = writeImageDescriptor(dir, "spoofed.jpg", PNG_IMAGE, "image/jpeg", "spoofed");
  assert.throws(() => validateLlmImages([spoofed]), /MIME does not match/);

  const badDigest = writeImageDescriptor(dir, "digest.png", PNG_IMAGE, "image/png", "digest");
  assert.throws(
    () => validateLlmImages([{ ...badDigest, sha256: "0".repeat(64) }]),
    /SHA-256 does not match/,
  );
});

test("validation refuses animated GIF before provider invocation", () => {
  const dir = fixtureDir("animated");
  const image = writeImageDescriptor(
    dir,
    "animated.gif",
    ANIMATED_GIF_IMAGE,
    "image/gif",
    "animated",
  );
  assert.throws(() => validateLlmImages([image]), /only non-animated GIF is supported/);
});

test("collection, item, aggregate, id, and descriptor bounds fail before file access", () => {
  const base: LlmImageInput = {
    id: "base",
    path: "/does/not/exist.png",
    mimeType: "image/png",
    bytes: 1,
    sha256: "0".repeat(64),
  };
  assert.throws(
    () => validateLlmImages(Array.from(
      { length: LLM_IMAGE_LIMITS.maxCount + 1 },
      (_, index) => ({ ...base, id: `image-${index}` }),
    )),
    /maximum is 8/,
  );
  assert.throws(
    () => validateLlmImages([{ ...base, bytes: LLM_IMAGE_LIMITS.maxBytesPerImage + 1 }]),
    /item limit/,
  );
  assert.throws(
    () => validateLlmImages(Array.from(
      { length: 5 },
      (_, index) => ({
        ...base,
        id: `aggregate-${index}`,
        bytes: LLM_IMAGE_LIMITS.maxBytesPerImage,
      }),
    )),
    /declared aggregate/,
  );
  assert.throws(() => validateLlmImages([{ ...base, id: "bad\nlabel" }]), /invalid evidence id/);
  assert.throws(() => validateLlmImages([{ ...base, path: "relative.png" }]), /absolute local path/);
  assert.throws(
    () => validateLlmImages([{ ...base, mimeType: "image/bmp" as never }]),
    /unsupported MIME type/,
  );
  assert.throws(() => validateLlmImages([{ ...base, sha256: "not-a-digest" }]), /invalid SHA-256/);
});

test("refusals disclose only bounded ids and basenames, never absolute paths", () => {
  const dir = fixtureDir("diagnostics");
  const image = writeImageDescriptor(dir, "private.png", PNG_IMAGE, "image/png", "visible-id");
  rmSync(image.path);
  assert.throws(
    () => validateLlmImages([image]),
    (error: Error) => {
      assert.match(error.message, /visible-id \(private\.png\)/);
      assert.equal(error.message.includes(dir), false);
      assert.ok(error.message.length < 240);
      return true;
    },
  );
});

test("input accounting adds raw images without embedding transport base64", () => {
  assert.equal(llmRunInputBytes("plain text"), Buffer.byteLength("plain text"));
  assert.equal(
    llmRunInputBytes("pixels 🖼️", [{ bytes: 11 }, { bytes: 17 }]),
    Buffer.byteLength("pixels 🖼️") + 28,
  );
});

test("a digest-only mutation is refused even when size and MIME stay unchanged", () => {
  const dir = fixtureDir("digest-mutation");
  const path = join(dir, "same-size.png");
  writeFileSync(path, PNG_IMAGE);
  const image = imageDescriptor(path, "image/png", "same-size");
  const changed = Buffer.from(PNG_IMAGE);
  changed[changed.byteLength - 1] = changed[changed.byteLength - 1]! ^ 0x01;
  writeFileSync(path, changed);
  assert.equal(changed.byteLength, image.bytes);
  assert.throws(() => validateLlmImages([image]), /SHA-256 does not match/);
});
