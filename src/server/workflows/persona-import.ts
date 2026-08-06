import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { WORKFLOW_LIMITS } from "@shared/workflow.ts";
import type { PersonaProvenance } from "@shared/workflow.ts";
import { readFileWithinCap } from "../session-files.ts";

/**
 * Reading an externally-authored Markdown role OFF the daemon's machine and INTO the Persona
 * catalog.
 *
 * The motivating source is UpstartClaw's `agent-team` role files under an installed Claude
 * plugin, but nothing here knows that: the operator names a path over the loopback+token API
 * and this module decides whether that path yields a document a reviewer may be built from.
 *
 * There is deliberately NO containment root, which makes this the one file-reading path in the
 * daemon that cannot lean on `readRepoDoc`'s realpath-inside-root check. An operator naming an
 * absolute path on their own machine is the feature - a plugin cache, a checkout, a scratch
 * directory. So the guarantees are assembled from the other end: every property that would
 * make the read unsafe or the result dishonest is refused BY NAME, and the refusal says which.
 *
 * - Absolute and NUL-free is settled by `PersonaSourcePathSchema` before anything is opened.
 * - `realpath` first, then `stat` on the resolved path, so a link to a directory or a device is
 *   refused for what it points AT rather than for what it is called. Links themselves are
 *   allowed: an installed plugin whose `references/` is a symlink is a real layout, and this
 *   read has no root a link could escape from.
 * - Bounded by `personaGuidanceBytes` and **refused** past it, never truncated. A truncated
 *   persona is the worst outcome available here: it would still be a valid Persona, still be
 *   pickable as a workflow judge, and would silently carry less review authority than the file
 *   it claims to be.
 * - Decoded with a fatal UTF-8 decoder and refused if the bytes carry a NUL, because "exact
 *   Markdown" is a promise about text and a replacement character is not the text.
 *
 * The hash is taken over the exact bytes read, which is the same thing the drift check hashes
 * later - so "changed" means the file changed, never that a decoder or a line ending did.
 */

/** A refusal an operator can act on: the reason names the property that failed. */
export class PersonaImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonaImportError";
  }
}

/** How far up the tree a plugin manifest or a git worktree is looked for. */
const ANCESTOR_LIMIT = 40;
/** A plugin manifest is a small JSON file; anything larger is not one worth reading. */
const PLUGIN_MANIFEST_MAX_BYTES = 64 * 1024;

export interface PersonaSource {
  /** The path as provenance will record it: absolute, `.`/`..` resolved, links intact. */
  sourcePath: string;
  /** Exact Markdown, decoded from the exact bytes that were hashed. */
  guidanceMarkdown: string;
  contentSha256: string;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * `O_NONBLOCK` and `O_NOFOLLOW` where the platform has them.
 *
 * `?? 0` rather than assuming: they are POSIX, and a build on a platform without them should
 * lose the hardening rather than pass `NaN` as the flag word and fail every open.
 */
const OPEN_FLAGS = constants.O_RDONLY
  | (constants.O_NONBLOCK ?? 0)
  | (constants.O_NOFOLLOW ?? 0);

type OpenedFile = { handle: FileHandle; size: number };
type OpenRefusal = { refused: "missing" | "not_regular" | "unreadable" };

/**
 * Open a path and prove on the DESCRIPTOR that it is a regular file.
 *
 * The order is the whole point, and it is the opposite of the intuitive one. A `stat` followed by
 * an `open` proves nothing about what was opened: between the two calls the name can be pointed
 * at something else, and then every check that ran on the `stat` was answered about a file this
 * process never reads. The failure is not theoretical for the two cases below.
 *
 * - A **FIFO** swapped in for a regular file passes an earlier `isFile()` and then blocks the
 *   whole request inside `open` until somebody writes to it - a route that hangs for as long as
 *   an attacker likes, holding a connection and a task. `O_NONBLOCK` is what makes that open
 *   return immediately, and the `fstat` below is what refuses it.
 * - A **character device** (`/dev/zero`, a tty) swapped in the same way passes `isFile()` and
 *   then feeds the reader bytes that were never a document.
 *
 * So nothing is trusted from a path-based `stat`; there no longer is one. `fstat` on the handle
 * describes the object actually opened, and both the regular-file check and the size check are
 * answered from it. `O_NOFOLLOW` is belt-and-braces on top - the final component of a realpath
 * is not a symlink, so refusing one means it became one after we looked - and the `fstat` would
 * catch the swap regardless.
 *
 * Shared with the plugin-manifest read below, which has exactly the same exposure.
 */
async function openRegularFile(real: string): Promise<OpenedFile | OpenRefusal> {
  let handle: FileHandle;
  try {
    handle = await open(real, OPEN_FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { refused: "missing" };
    // ELOOP is the swapped-in symlink O_NOFOLLOW just refused; EISDIR is how Linux answers an
    // attempt to read a directory, where macOS opens it and lets the fstat below speak.
    if (code === "ELOOP" || code === "EISDIR" || code === "ENXIO") return { refused: "not_regular" };
    return { refused: "unreadable" };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      await handle.close();
      return { refused: "not_regular" };
    }
    return { handle, size: info.size };
  } catch {
    await handle.close();
    return { refused: "unreadable" };
  }
}

/**
 * Read one Markdown document, or throw a named refusal.
 *
 * Measured before it is read rather than read then measured - an enormous file must not be
 * materialized to discover it is enormous - but measured on the open DESCRIPTOR, so the size and
 * the regular-file check describe the bytes this function is about to read. The second check on
 * the bytes actually read closes the remaining gap: a file being appended to while this runs.
 */
export async function readPersonaSource(requestedPath: string): Promise<PersonaSource> {
  const sourcePath = path.resolve(requestedPath);
  const real = await realpath(sourcePath).catch(() => null);
  if (real === null) throw new PersonaImportError(`no file at ${sourcePath}`);
  const opened = await openRegularFile(real);
  if ("refused" in opened) {
    if (opened.refused === "missing") throw new PersonaImportError(`no file at ${sourcePath}`);
    if (opened.refused === "not_regular") {
      throw new PersonaImportError(`${sourcePath} is not a regular file`);
    }
    throw new PersonaImportError(`${sourcePath} could not be opened for reading`);
  }
  const cap = WORKFLOW_LIMITS.personaGuidanceBytes;
  let bytes: Buffer;
  try {
    if (opened.size > cap) {
      throw new PersonaImportError(
        `${sourcePath} is ${opened.size} bytes; Persona guidance is limited to ${cap} UTF-8 bytes`,
      );
    }
    const bounded = await readFileWithinCap(opened.handle, cap);
    if (bounded.exceeded) {
      throw new PersonaImportError(
        `${sourcePath} grew past the ${cap}-byte Persona guidance limit while it was being read`,
      );
    }
    bytes = bounded.bytes;
  } finally {
    await opened.handle.close();
  }
  if (bytes.includes(0)) {
    throw new PersonaImportError(`${sourcePath} is not a text document`);
  }
  let guidanceMarkdown: string;
  try {
    guidanceMarkdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PersonaImportError(`${sourcePath} is not valid UTF-8`);
  }
  if (guidanceMarkdown.trim().length === 0) {
    throw new PersonaImportError(`${sourcePath} has no content to review with`);
  }
  return { sourcePath, guidanceMarkdown, contentSha256: sha256Hex(bytes) };
}

/** Every directory from `from` up to the filesystem root, nearest first and bounded. */
function ancestors(from: string): string[] {
  const out: string[] = [];
  let current = from;
  for (let depth = 0; depth < ANCESTOR_LIMIT; depth += 1) {
    out.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out;
}

/**
 * The version of the Claude plugin this file belongs to, when there is one to read.
 *
 * Best-effort and deliberately generic: "a `.claude-plugin/plugin.json` with a string
 * `version` somewhere above the file". No plugin name, no marketplace lookup, and nothing
 * specific to any one plugin - Mission Control is a generic product and an `if (upstart)`
 * branch is exactly what this may not become. Null is a legitimate answer and the common one;
 * it means "undeterminable", never "version 0".
 */
export async function readPluginVersion(filePath: string): Promise<string | null> {
  for (const dir of ancestors(path.dirname(filePath))) {
    const manifest = path.join(dir, ".claude-plugin", "plugin.json");
    // Through the same descriptor-validating open as the document read: a manifest path is no
    // more trustworthy than a source path, and a FIFO here would hang the import just as well.
    const opened = await openRegularFile(manifest);
    if ("refused" in opened) continue;
    if (opened.size > PLUGIN_MANIFEST_MAX_BYTES) {
      await opened.handle.close();
      continue;
    }
    try {
      const { bytes } = await readFileWithinCap(opened.handle, PLUGIN_MANIFEST_MAX_BYTES);
      const parsed: unknown = JSON.parse(bytes.toString("utf8"));
      const version = parsed && typeof parsed === "object"
        ? (parsed as { version?: unknown }).version
        : undefined;
      if (typeof version === "string" && version.trim().length > 0) return version.trim().slice(0, 200);
    } catch {
      // A manifest that is missing, unreadable, or not JSON is simply not an answer. The
      // import itself is unaffected: the file it read is still exactly the file it read.
    } finally {
      await opened.handle.close();
    }
    // The nearest manifest is the one that owns this file. If it had no usable version, a
    // grandparent plugin's version would be a different plugin's number on this document.
    return null;
  }
  return null;
}

/**
 * The git worktree root above the file, when one can be found.
 *
 * By walking up for a `.git` entry rather than shelling out to `git`: this runs once per import
 * and once per persona on every drift check, and a subprocess per row would make a badge cost
 * more than the read it is reporting on. `.git` as a FILE counts - that is a worktree or a
 * submodule, which is still the checkout this document came from.
 */
export async function readSourceRepo(filePath: string): Promise<string | null> {
  for (const dir of ancestors(path.dirname(filePath))) {
    const marker = await stat(path.join(dir, ".git")).catch(() => null);
    if (marker !== null) return dir;
  }
  return null;
}

/**
 * Read a source document and everything provenance records about where it came from.
 *
 * One function so import and re-import cannot disagree about what provenance means. `now` is
 * injected for the same reason every other write in this codebase injects it: a test asserting
 * a stored instant should not have to race the clock.
 */
export async function readImportedSource(
  requestedPath: string,
  now: number,
): Promise<{ source: PersonaSource; provenance: PersonaProvenance }> {
  const source = await readPersonaSource(requestedPath);
  const [pluginVersion, sourceRepo] = await Promise.all([
    readPluginVersion(source.sourcePath),
    readSourceRepo(source.sourcePath),
  ]);
  return {
    source,
    provenance: {
      sourcePath: source.sourcePath,
      sourceRepo,
      pluginVersion,
      contentSha256: source.contentSha256,
      importedAt: now,
    },
  };
}

/**
 * The hash of what the path holds NOW, or null when it holds nothing readable.
 *
 * The drift half of the pair above, and it swallows every refusal on purpose: a drift check is
 * a question about state, not a request that can fail. "The file is gone", "it is a directory
 * now", "it grew past the ceiling" and "it stopped being UTF-8" are all the same answer to the
 * operator - this Persona's upstream cannot be compared - and `personaUpstreamState` turns that
 * null into `missing`.
 */
export async function readPersonaSourceHash(sourcePath: string): Promise<string | null> {
  const source = await readPersonaSource(sourcePath).catch(() => null);
  return source === null ? null : source.contentSha256;
}
