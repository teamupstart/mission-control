import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LlmImageInput } from "../../src/shared/llm.ts";
import type { RasterImageMimeType } from "../../src/shared/images.ts";

/** A real 1x1 PNG used by every runner-boundary image test. */
export const PNG_IMAGE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** A complete static 1x1 GIF. */
export const STATIC_GIF_IMAGE = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
  "base64",
);

/** The static image descriptor repeated before the trailer, making a valid two-frame GIF. */
export const ANIMATED_GIF_IMAGE = Buffer.from(
  "47494638396101000100800000000000ffffff"
    + "2c00000000010001000002014c00"
    + "2c00000000010001000002014c00"
    + "3b",
  "hex",
);

export function imageDescriptor(
  path: string,
  mimeType: RasterImageMimeType,
  id: string,
): LlmImageInput {
  const data = readFileSync(path);
  return {
    id,
    path,
    mimeType,
    bytes: data.byteLength,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}

export function writeImageDescriptor(
  dir: string,
  name: string,
  data: Uint8Array,
  mimeType: RasterImageMimeType,
  id: string,
): LlmImageInput {
  const path = join(dir, name);
  writeFileSync(path, data);
  return imageDescriptor(path, mimeType, id);
}
