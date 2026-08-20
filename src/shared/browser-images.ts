/**
 * Image formats the Files workspace can hand directly to a browser image element.
 *
 * This registry is shared by the daemon classifier and the browser's default-view
 * decision so a path cannot open in Preview only to arrive as an ordinary binary file.
 * Keep it to formats with broad browser support; native or specialist formats belong in
 * an external viewer until browsers can render them consistently.
 */
export const BROWSER_IMAGE_MEDIA_TYPES = {
  apng: "image/apng",
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jfif: "image/jpeg",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
} as const;

export type BrowserImageMediaType =
  (typeof BROWSER_IMAGE_MEDIA_TYPES)[keyof typeof BROWSER_IMAGE_MEDIA_TYPES];

/** Browser image media type for a checkout path, or null for a non-image extension. */
export function browserImageMediaTypeForPath(filePath: string): BrowserImageMediaType | null {
  const normalized = filePath.replaceAll("\\", "/");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  return BROWSER_IMAGE_MEDIA_TYPES[extension as keyof typeof BROWSER_IMAGE_MEDIA_TYPES] ?? null;
}
