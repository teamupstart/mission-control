import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { basename, isAbsolute } from "node:path";
import {
  LLM_IMAGE_LIMITS,
  type LlmImageInput,
} from "@shared/llm.ts";
import {
  isRasterImageMimeType,
  sniffRasterImageMimeType,
} from "@shared/images.ts";

/** A descriptor whose exact file bytes were opened and verified by the runner boundary. */
export interface ValidatedLlmImage extends LlmImageInput {
  /** Exact bytes used for MIME and digest checks; provider adapters own their encoding. */
  readonly data: Buffer;
}

export class LlmImageValidationError extends Error {
  readonly code = "llm_image_input_invalid";

  constructor(message: string) {
    super(message);
    this.name = "LlmImageValidationError";
  }
}

function refuse(message: string): never {
  throw new LlmImageValidationError(`LLM image input refused: ${message}`);
}

/** One bounded printable label. Never includes an absolute path. */
function imageLabel(image: LlmImageInput, index: number): string {
  const clean = (value: string, max: number): string =>
    value.replace(/[^\x20-\x7e]/g, "?").slice(0, max);
  const id = clean(image.id, 64) || `#${index + 1}`;
  const name = clean(basename(image.path), 80) || "unnamed";
  return `${id} (${name})`;
}

function hasAsciiControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function skipGifSubBlocks(data: Uint8Array, start: number): number | null {
  let offset = start;
  while (offset < data.byteLength) {
    const size = data[offset++]!;
    if (size === 0) return offset;
    offset += size;
    if (offset > data.byteLength) return null;
  }
  return null;
}

/** Count complete GIF image descriptors, or return null for malformed structure. */
function gifFrameCount(data: Uint8Array): number | null {
  if (data.byteLength < 13) return null;
  let offset = 13;
  const globalColorTable = (data[10]! & 0x80) !== 0;
  if (globalColorTable) offset += 3 * (1 << ((data[10]! & 0x07) + 1));
  if (offset > data.byteLength) return null;

  let frames = 0;
  while (offset < data.byteLength) {
    const marker = data[offset++]!;
    if (marker === 0x3b) return frames;
    if (marker === 0x21) {
      if (offset >= data.byteLength) return null;
      offset += 1; // extension label
      const next = skipGifSubBlocks(data, offset);
      if (next === null) return null;
      offset = next;
      continue;
    }
    if (marker === 0x2c) {
      if (offset + 9 > data.byteLength) return null;
      const packed = data[offset + 8]!;
      offset += 9;
      if ((packed & 0x80) !== 0) offset += 3 * (1 << ((packed & 0x07) + 1));
      if (offset >= data.byteLength) return null;
      offset += 1; // LZW minimum code size
      const next = skipGifSubBlocks(data, offset);
      if (next === null) return null;
      offset = next;
      frames += 1;
      continue;
    }
    // A zero byte may appear as padding between top-level blocks.
    if (marker === 0x00) continue;
    return null;
  }
  return null;
}

function validateDescriptorSet(images: readonly LlmImageInput[]): void {
  if (images.length > LLM_IMAGE_LIMITS.maxCount) {
    refuse(`received ${images.length} images; maximum is ${LLM_IMAGE_LIMITS.maxCount}`);
  }
  const ids = new Set<string>();
  let aggregate = 0;
  for (const [index, image] of images.entries()) {
    const label = imageLabel(image, index);
    if (
      image.id.length === 0
      || image.id.length > LLM_IMAGE_LIMITS.maxIdChars
      || hasAsciiControl(image.id)
    ) {
      refuse(`image #${index + 1} has an invalid evidence id`);
    }
    if (ids.has(image.id)) refuse(`duplicate evidence id ${label}`);
    ids.add(image.id);
    if (!isAbsolute(image.path)) refuse(`${label} does not name an absolute local path`);
    if (!isRasterImageMimeType(image.mimeType)) {
      refuse(`${label} declares unsupported MIME type`);
    }
    if (!Number.isSafeInteger(image.bytes) || image.bytes <= 0) {
      refuse(`${label} declares an invalid byte count`);
    }
    if (image.bytes > LLM_IMAGE_LIMITS.maxBytesPerImage) {
      refuse(`${label} exceeds the ${LLM_IMAGE_LIMITS.maxBytesPerImage}-byte item limit`);
    }
    if (!/^[0-9a-f]{64}$/.test(image.sha256)) {
      refuse(`${label} declares an invalid SHA-256 digest`);
    }
    aggregate += image.bytes;
  }
  if (aggregate > LLM_IMAGE_LIMITS.maxAggregateBytes) {
    refuse(
      `declared aggregate is ${aggregate} bytes; maximum is ${LLM_IMAGE_LIMITS.maxAggregateBytes}`,
    );
  }
}

/**
 * Open, bound, sniff, and hash every image before a provider process can start.
 *
 * O_NOFOLLOW closes a leaf-symlink swap on platforms that implement it. The explicit
 * lstat refusal keeps the same contract on platforms where that flag is unavailable. A
 * daemon-owned immutable path is still required because Codex consumes the path after this
 * check; the next phase creates those immutable copies before it calls a runner.
 */
export function validateLlmImages(
  requested: readonly LlmImageInput[] | undefined,
): readonly ValidatedLlmImage[] {
  const images = requested ?? [];
  if (images.length === 0) return [];
  validateDescriptorSet(images);

  const validated: ValidatedLlmImage[] = [];
  let actualAggregate = 0;
  for (const [index, image] of images.entries()) {
    const label = imageLabel(image, index);
    let fd: number | null = null;
    try {
      if (lstatSync(image.path).isSymbolicLink()) {
        refuse(`${label} must be a regular non-symlink file`);
      }
      fd = openSync(image.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const before = fstatSync(fd);
      if (!before.isFile()) refuse(`${label} must be a regular file`);
      if (before.size !== image.bytes) {
        refuse(`${label} size changed from ${image.bytes} to ${before.size} bytes`);
      }
      if (before.size > LLM_IMAGE_LIMITS.maxBytesPerImage) {
        refuse(`${label} exceeds the ${LLM_IMAGE_LIMITS.maxBytesPerImage}-byte item limit`);
      }

      const data = readFileSync(fd);
      const after = fstatSync(fd);
      if (
        after.dev !== before.dev
        || after.ino !== before.ino
        || after.size !== before.size
        || after.mtimeMs !== before.mtimeMs
      ) {
        refuse(`${label} changed while it was being read`);
      }
      if (data.byteLength !== image.bytes) {
        refuse(`${label} yielded ${data.byteLength} bytes instead of ${image.bytes}`);
      }
      actualAggregate += data.byteLength;
      if (actualAggregate > LLM_IMAGE_LIMITS.maxAggregateBytes) {
        refuse(`actual image bytes exceed the ${LLM_IMAGE_LIMITS.maxAggregateBytes}-byte limit`);
      }

      const sniffed = sniffRasterImageMimeType(data);
      if (sniffed === null) refuse(`${label} is not a supported raster image`);
      if (sniffed !== image.mimeType) {
        refuse(`${label} MIME does not match its bytes`);
      }
      if (sniffed === "image/gif") {
        const frames = gifFrameCount(data);
        if (frames === null || frames === 0) refuse(`${label} is not a complete GIF image`);
        if (!LLM_IMAGE_LIMITS.allowAnimatedGif && frames > 1) {
          refuse(`${label} is animated; only non-animated GIF is supported`);
        }
      }

      const digest = createHash("sha256").update(data).digest("hex");
      if (digest !== image.sha256) refuse(`${label} SHA-256 does not match its bytes`);
      validated.push(Object.freeze({ ...image, data }));
    } catch (error) {
      if (error instanceof LlmImageValidationError) throw error;
      refuse(`${label} could not be opened or read`);
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }
  return Object.freeze(validated);
}
