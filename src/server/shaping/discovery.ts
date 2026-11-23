import { createHash } from "node:crypto";
import { constants, promises as fsp, type Stats } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  describeShapingIssue,
  SHAPING_LIMITS,
  ShaperManifestSchema,
  type DiscoveredShaper,
  type ShaperManifest,
  type ShapingConfig,
  type ShapingFolderStatus,
} from "@shared/shaping.ts";
import { STATE_DIR } from "../config.ts";
import { getShapingConfig } from "./index.ts";

/**
 * The shapers folder: `shapers/<id>/shaper.json` under the state home, the only place a shaper is
 * discovered (D4). A shaper found here is enabled as soon as it is discovered (D4a), so this file
 * is where everything a folder must satisfy before it can run is decided.
 *
 * There is no watcher. The folder is read when asked: at daemon start, when Settings opens, at
 * the start of every shaping run and every dry run. Every scan reads and hashes every manifest,
 * so a replaced file is noticed whatever its size or timestamps; only parsing is skipped when a
 * manifest's bytes hash the same as last time. The ownership checks run on every scan, because
 * replacing a program beside a manifest does not change the manifest's hash.
 *
 * Mission Control never creates the folder and never writes into it. A repository's own files
 * never register a shaper: nothing outside this folder is read.
 */

/** At most this many folders are read, in name order. The rest are reported as ignored. */
export const SHAPER_FOLDER_ENTRIES = 32;
/** The manifest's file name inside each shaper's folder. */
export const SHAPER_MANIFEST = "shaper.json";

/** The folder for a state home. */
export function shapersFolder(home: string = STATE_DIR): string {
  return join(home, "shapers");
}

export interface ShaperFolderScan {
  shapers: DiscoveredShaper[];
  folder: ShapingFolderStatus;
}

export interface DiscoverOptions {
  /** The state home. The daemon's own by default; a test passes its temporary one. */
  home?: string;
  /** The config whose registered ids shadow the folder's. Read from the store by default. */
  config?: { readonly shapers: readonly Pick<ShapingConfig["shapers"][number], "id">[] };
  /** The daemon's user id. `process.getuid()` by default; a test can model another owner. */
  uid?: number | null;
}

type Parsed = { ok: true; manifest: ShaperManifest } | { ok: false; problem: string };

/**
 * Parsed manifests from the latest scan, keyed by the SHA-256 of their bytes. Replaced by each
 * scan, so it holds at most one scan's worth of entries.
 */
let parsedByHash = new Map<string, Parsed>();

/** The folder's shapers, as `scanShaperFolder` reports them. */
export async function discoverShapers(options: DiscoverOptions = {}): Promise<DiscoveredShaper[]> {
  return (await scanShaperFolder(options)).shapers;
}

/** Read the folder once: every entry's state, and whether entries beyond the bound were ignored. */
export async function scanShaperFolder(options: DiscoverOptions = {}): Promise<ShaperFolderScan> {
  const root = shapersFolder(options.home);
  const uid = options.uid !== undefined ? options.uid : (typeof process.getuid === "function" ? process.getuid() : null);
  let names: string[];
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    // A folder or a link to one. A stray file such as `.DS_Store` is not an entry, nor is
    // anything hidden.
    names = entries.filter((entry) => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink()))
      .map((entry) => entry.name)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  } catch {
    // A missing folder, or one that is not a directory, is an empty result. Never created here.
    return { shapers: [], folder: { path: root, ignored: 0 } };
  }
  const registered = new Set((options.config ?? getShapingConfig()).shapers.map((entry) => entry.id));
  const read = names.slice(0, SHAPER_FOLDER_ENTRIES);
  const next = new Map<string, Parsed>();
  const shapers = await Promise.all(read.map((name) => scanEntry(root, name, uid, registered, next)));
  parsedByHash = next;
  return { shapers, folder: { path: root, ignored: names.length - read.length } };
}

/** Log what the folder holds, once, at daemon start. Only called with the flag on. */
export async function announceShaperFolder(): Promise<void> {
  try {
    const { shapers, folder } = await scanShaperFolder();
    if (shapers.length === 0) return;
    const ready = shapers.filter((entry) => entry.state === "ok").map((entry) => entry.id);
    const blocked = shapers.filter((entry) => entry.state !== "ok").map((entry) => `${entry.id} (${entry.state})`);
    console.log(`[shaping] ${folder.path}: ${ready.length} ready${ready.length ? ` (${ready.join(", ")})` : ""}`
      + `${blocked.length ? `, not run: ${blocked.join(", ")}` : ""}`
      + `${folder.ignored ? `, ${folder.ignored} more ignored beyond the first ${SHAPER_FOLDER_ENTRIES}` : ""}.`);
  } catch (error) {
    console.warn("[shaping] could not read the shapers folder:", error);
  }
}

function sentence(text: string): string {
  return text.slice(0, SHAPING_LIMITS.reasonChars);
}

/** Why `stats` may not carry the operator's authority, or null when it may. */
function ownershipProblem(stats: Stats, what: string, uid: number | null): string | null {
  if (uid === null) return `${what} cannot be checked for ownership on this platform.`;
  if (stats.uid !== uid) return `${what} belongs to another user. It must belong to the user Mission Control runs as.`;
  if ((stats.mode & 0o022) !== 0) return `${what} is writable by its group or by other users. Remove that write permission.`;
  return null;
}

async function scanEntry(
  root: string,
  name: string,
  uid: number | null,
  registered: ReadonlySet<string>,
  cache: Map<string, Parsed>,
): Promise<DiscoveredShaper> {
  const entryPath = join(root, name);
  let path = entryPath;
  let sha256: string | null = null;
  let shaper: ShaperManifest | null = null;
  const report = (state: DiscoveredShaper["state"], problem: string | null): DiscoveredShaper => ({
    id: name.slice(0, 256), path, state, problem: problem === null ? null : sentence(problem), sha256, shaper,
  });
  const invalid = (problem: string) => report("invalid", problem);
  const refused = (problem: string) => report("refused", problem);

  // The folder: a directory, or a link to one that the operator made.
  let link: Stats;
  try { link = await fsp.lstat(entryPath); } catch { return invalid("The folder could not be read."); }
  if (link.isSymbolicLink()) {
    if (uid !== null && link.uid !== uid) return refused("The link to this folder belongs to another user. It must belong to the user Mission Control runs as.");
  }
  let folder: string;
  let stats: Stats;
  try {
    folder = await fsp.realpath(entryPath);
    stats = await fsp.stat(folder);
  } catch {
    return invalid("The link does not lead to a folder.");
  }
  // Every later check, and the `./` command at call time, resolves against the folder checked here.
  path = folder;
  if (!stats.isDirectory()) return invalid("This entry is not a folder.");
  const folderProblem = ownershipProblem(stats, "The folder", uid);
  if (folderProblem) return refused(folderProblem);

  // The manifest: a regular file inside the folder itself, opened without following a link and
  // without waiting on a pipe, then checked through the descriptor that is read.
  let bytes: Buffer;
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(join(folder, SHAPER_MANIFEST), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return invalid(`The folder has no ${SHAPER_MANIFEST}.`);
    if (code === "ELOOP") return invalid(`Its ${SHAPER_MANIFEST} is a symbolic link, not a regular file.`);
    return invalid(`Its ${SHAPER_MANIFEST} could not be opened.`);
  }
  try {
    const file = await handle.stat();
    if (!file.isFile()) return invalid(`Its ${SHAPER_MANIFEST} is not a regular file.`);
    const fileProblem = ownershipProblem(file, `Its ${SHAPER_MANIFEST}`, uid);
    if (fileProblem) return refused(fileProblem);
    const cap = SHAPING_LIMITS.entryJsonBytes;
    if (file.size > cap) return invalid(`Its ${SHAPER_MANIFEST} is ${file.size} bytes, over the ${cap / 1024} KiB limit.`);
    // One byte past the cap, so a file that grew after the stat is still caught.
    const buffer = Buffer.alloc(cap + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > cap) return invalid(`Its ${SHAPER_MANIFEST} is over the ${cap / 1024} KiB limit.`);
    bytes = buffer.subarray(0, length);
  } catch {
    return invalid(`Its ${SHAPER_MANIFEST} could not be read.`);
  } finally {
    await handle.close().catch(() => undefined);
  }

  sha256 = createHash("sha256").update(bytes).digest("hex");
  const parsed = cache.get(sha256) ?? parsedByHash.get(sha256) ?? parseManifest(bytes);
  cache.set(sha256, parsed);
  if (!parsed.ok) return invalid(parsed.problem);
  if (parsed.manifest.id !== name) {
    return invalid(`Its id "${parsed.manifest.id}" is not its folder's name. Rename the folder to "${parsed.manifest.id}" or change the id.`);
  }
  shaper = parsed.manifest;

  for (const command of folderCommands(parsed.manifest)) {
    const problem = await commandProblem(folder, command, uid);
    if (problem) return report(problem.state, problem.text);
  }
  if (registered.has(name)) {
    return report("shadowed", `A registered shaper has the id "${name}", so it runs instead and this one does not.`);
  }
  return report("ok", null);
}

function parseManifest(bytes: Buffer): Parsed {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, problem: `Its ${SHAPER_MANIFEST} is not UTF-8 text.` };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // Never the parser's message: it quotes the text around the error, which may be a credential.
    return { ok: false, problem: `Its ${SHAPER_MANIFEST} is not valid JSON.` };
  }
  const result = ShaperManifestSchema.safeParse(json);
  if (!result.success) return { ok: false, problem: describeShapingIssue(result.error) };
  return { ok: true, manifest: result.data };
}

/** Every `./` program a manifest runs: a `command` transport's, or a local MCP server's. */
function folderCommands(manifest: ShaperManifest): string[] {
  const transport = manifest.transport;
  const command = transport.type === "command" ? transport.command
    : transport.type === "mcp" && transport.server.type === "stdio" ? transport.server.command
    : null;
  return command?.startsWith("./") ? [command] : [];
}

/**
 * Why a `./` program may not run: it must resolve inside the folder, and it and every directory
 * between the folder and it must pass the folder's own ownership check.
 */
async function commandProblem(
  folder: string,
  command: string,
  uid: number | null,
): Promise<{ state: "invalid" | "refused"; text: string } | null> {
  let target: string;
  try {
    target = await fsp.realpath(resolve(folder, command));
  } catch {
    return { state: "invalid", text: `"${command}" was not found in the shaper's folder.` };
  }
  if (!target.startsWith(folder + sep)) return { state: "invalid", text: `"${command}" resolves outside the shaper's folder.` };
  const parts = target.slice(folder.length + 1).split(sep);
  let at = folder;
  for (const [index, part] of parts.entries()) {
    at = join(at, part);
    let stats: Stats;
    try { stats = await fsp.stat(at); } catch { return { state: "invalid", text: `"${command}" could not be read.` }; }
    const last = index === parts.length - 1;
    if (last && !stats.isFile()) return { state: "invalid", text: `"${command}" is not a file.` };
    const what = last ? `The program "${command}"` : `The folder "${parts.slice(0, index + 1).join("/")}" that holds "${command}"`;
    const problem = ownershipProblem(stats, what, uid);
    if (problem) return { state: "refused", text: problem };
  }
  return null;
}
