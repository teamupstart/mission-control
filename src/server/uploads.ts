import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sniffRasterImageMimeType } from "@shared/images.ts";
import { STATE_DIR } from "./config.ts";

/**
 * Dropped images, on disk, so they can be handed to an agent.
 *
 * Every channel to an agent ends at a pty - tmux `send-keys` / `paste-buffer`,
 * wezterm `cli send-text` - so bytes can't be handed over directly. What the
 * agent CLIs *do* accept is what a terminal produces when you drag a file onto
 * it: an absolute path in the prompt, which they read with their own file tools.
 * So an upload's whole job is to become a path worth pasting.
 *
 * That framing decides the rest of this module: the file has to outlive the send
 * (the agent reads it on its own schedule, and may re-read it later in the
 * conversation), it has to sit somewhere stable that the agent can reach, and its
 * name has to survive being pasted into a shell prompt verbatim.
 */

/** Where dropped images land. A sibling of the db, so one state dir holds it all. */
export const UPLOADS_DIR = join(STATE_DIR, "uploads");

/**
 * The biggest image worth taking. Enforced twice on purpose: `bodyLimit` refuses an
 * oversized request before it's buffered, and the route re-checks the decoded part
 * so the message can name the file's own size rather than the envelope's.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** How long an upload survives before the startup sweep reclaims it. */
export const UPLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type ImageExt = "png" | "jpg" | "gif" | "webp";

export interface SavedUpload {
  /** Absolute path - the only form worth having, since this gets pasted into a prompt. */
  path: string;
  /** The stored basename (not the client's original). */
  name: string;
  bytes: number;
}

/**
 * Identify an image by its leading bytes, returning the extension it has earned.
 *
 * Deliberately not `file.type`: that's a client-supplied string, and this file is
 * about to be written under a name an agent will act on. Sniffing is what makes
 * the extension we hand back an honest claim about the content rather than a
 * relabeling service for arbitrary bytes.
 */
export function detectImageExt(buf: Uint8Array): ImageExt | null {
  switch (sniffRasterImageMimeType(buf)) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
    case null: return null;
  }
}

/**
 * Build the stored basename: a readable stem from the client's filename, plus
 * random bytes, plus the sniffed extension.
 *
 * The stem is reduced to `[A-Za-z0-9._-]` because this name becomes the tail of a
 * path typed into a live shell prompt. A name carrying a space, a quote, or a
 * backtick would need escaping that the agent TUIs each handle differently -
 * cheaper to make the name incapable of needing it. The random suffix (not a
 * counter) keeps two drops of `Screenshot.png` from colliding without having to
 * read the directory first.
 */
export function uploadFileName(original: string, ext: ImageExt): string {
  const base = original.replace(/^.*[/\\]/, "").replace(/\.[^.]*$/, "");
  const stem = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 48);
  return `${stem || "image"}-${randomBytes(4).toString("hex")}.${ext}`;
}

/**
 * Write an image to the uploads dir under a generated name.
 *
 * Throws on bytes that aren't a recognised image - the caller turns that into a
 * 400. Nothing about the client's own filename reaches the filesystem except as
 * sanitized stem text, so no input here can steer where the write lands.
 */
export function saveImageUpload(bytes: Uint8Array, originalName: string): SavedUpload {
  const ext = detectImageExt(bytes);
  if (!ext) throw new Error("not a recognised image (png, jpeg, gif or webp)");
  mkdirSync(UPLOADS_DIR, { recursive: true });
  const name = uploadFileName(originalName, ext);
  const path = join(UPLOADS_DIR, name);
  writeFileSync(path, bytes);
  return { path, name, bytes: bytes.byteLength };
}

/**
 * Delete uploads older than `maxAgeMs`. Returns how many went.
 *
 * Uploads can't be deleted at send time: the path is a promise to the agent, which
 * reads it whenever it gets there and may re-read it later in the same
 * conversation. So they expire on a clock instead, swept at startup - the moment
 * we know no send is mid-flight. Fail-soft per file: a sweep is housekeeping and
 * must never be the reason the daemon won't boot.
 */
export function sweepUploads(maxAgeMs: number = UPLOAD_TTL_MS, now: number = Date.now()): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(UPLOADS_DIR);
  } catch {
    return 0; // nothing dropped yet
  }
  for (const entry of entries) {
    const path = join(UPLOADS_DIR, entry);
    try {
      if (now - statSync(path).mtimeMs <= maxAgeMs) continue;
      rmSync(path, { force: true });
      removed++;
    } catch {
      // A file that vanished or won't stat is not worth failing the sweep over.
    }
  }
  return removed;
}
