/**
 * Raster image formats accepted by Mission Control.
 *
 * One browser-safe registry owns the MIME vocabulary so uploads, runner validation, and
 * the later workflow evidence contracts cannot drift onto different format sets.
 */
export const RASTER_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export type RasterImageMimeType = (typeof RASTER_IMAGE_MIME_TYPES)[number];

export function isRasterImageMimeType(value: string): value is RasterImageMimeType {
  return (RASTER_IMAGE_MIME_TYPES as readonly string[]).includes(value);
}

/** Identify a supported raster image from its leading bytes. */
export function sniffRasterImageMimeType(buf: Uint8Array): RasterImageMimeType | null {
  const at = (i: number): number => buf[i] ?? -1;
  const ascii = (off: number, value: string): boolean =>
    [...value].every((ch, i) => at(off + i) === ch.charCodeAt(0));

  if (
    ascii(1, "PNG")
    && at(0) === 0x89
    && at(4) === 0x0d
    && at(5) === 0x0a
    && at(6) === 0x1a
    && at(7) === 0x0a
  ) {
    return "image/png";
  }
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  // WEBP is a RIFF container; the format tag sits past the 4-byte length field.
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  return null;
}
