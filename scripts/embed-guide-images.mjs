#!/usr/bin/env node
/**
 * Inline `docs/setup-guide.html`'s figures into the document as `data:` URIs.
 *
 * The guide is published as a self-contained document, so its screenshots are EMBEDDED rather
 * than referenced: a reader who opens the file on its own, away from `docs/images/`, still sees
 * every figure.
 *
 * The obvious hazard of inlining is that the copy in the HTML forks from the PNG that
 * `npm run docs:screenshots` regenerates, and nothing notices. That is why this is a generator
 * and not a one-time paste, and why each `<img>` keeps two attributes beside the data URI:
 *
 *   data-embed         the source path under `docs/`, so a re-run knows what to re-read
 *   data-embed-sha256  the source file's digest at the time it was embedded
 *
 * `test/setup-guide-embedding.test.ts` re-hashes the source files and fails when a digest has
 * moved, so regenerating a figure without re-running this script is a red test rather than a
 * stale picture in published documentation.
 *
 * Idempotent: re-running with no figure changes rewrites the file byte for byte.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const GUIDE = join(REPO_ROOT, "docs/setup-guide.html");

const MIME = new Map([[".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".webp", "image/webp"], [".gif", "image/gif"]]);

/** One attribute's value, or null. Values in this document are always double quoted. */
function attribute(tag, name) {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match ? match[1] : null;
}

export function embedGuideImages({ guidePath = GUIDE, write = true } = {}) {
  const html = readFileSync(guidePath, "utf8");
  const docsDir = dirname(guidePath);
  const embedded = [];

  const next = html.replace(/<img\b[^>]*>/g, (tag) => {
    // `data-embed` wins over `src`, so a second run re-reads the real file rather than trying
    // to interpret the data URI it wrote last time.
    const source = attribute(tag, "data-embed") ?? attribute(tag, "src");
    if (!source || source.startsWith("data:")) return tag;

    const absolute = resolve(docsDir, source);
    const bytes = readFileSync(absolute);
    const extension = source.slice(source.lastIndexOf(".")).toLowerCase();
    const mime = MIME.get(extension);
    if (!mime) throw new Error(`embed-guide-images: unsupported image type ${extension} for ${source}`);

    const digest = createHash("sha256").update(bytes).digest("hex");
    const alt = attribute(tag, "alt") ?? "";
    embedded.push({ source, digest, bytes: bytes.length });

    // Rebuilt rather than patched, so a tag cannot accumulate stale attributes across runs.
    return `<img data-embed="${source}" data-embed-sha256="${digest}" alt="${alt}" src="data:${mime};base64,${bytes.toString("base64")}">`;
  });

  if (write && next !== html) writeFileSync(guidePath, next);
  return { embedded, changed: next !== html, bytes: Buffer.byteLength(next) };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const result = embedGuideImages();
  for (const item of result.embedded) {
    console.log(`[embed] ${item.source} ${(item.bytes / 1024).toFixed(1)} KB ${item.digest.slice(0, 12)}`);
  }
  console.log(
    `[embed] ${result.embedded.length} figures, document is ${(result.bytes / 1024 / 1024).toFixed(2)} MB`
    + `${result.changed ? "" : " (already current)"}`,
  );
}
