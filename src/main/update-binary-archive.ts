import { createWriteStream } from "node:fs";
import { chmod, mkdir, realpath, symlink } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32 } from "node:zlib";
import { openPromise, type Entry } from "yauzl";

export const MAX_UNPACKED_BYTES = 8 * 1024 ** 3;
const APP = "Mission Control.app";
const hasControl = (value: string) => [...value].some(char => char.charCodeAt(0) < 32);

/** Two passes: validate the entire namespace before writing, then stream bounded
 * files. Links are created last, so no archive entry can write through a link. */
export async function extractBinaryArchive(archive: string, destination: string, signal: AbortSignal,
  limits = {bytes: MAX_UNPACKED_BYTES, entries: 200_000}, onInventory: (bytes: number) => void = () => {}): Promise<string> {
  const zip = await openPromise(archive, {lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true});
  const entries: {entry: Entry; name: string; kind: "directory" | "file" | "link"; mode: number; resource: boolean}[] = [];
  const namespace = new Map<string, string>();
  const spellings = new Map<string, string>();
  const key = (name: string) => name.normalize("NFD").toLowerCase();
  let bytes = 0;
  let pathBytes = 0;
  let metadataBytes = 0;
  let namespaceBytes = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      signal.throwIfAborted();
      const name = entry.fileName.replace(/\/$/, "");
      if (!name || name.length > 1024 || /[\\:]/.test(name) || hasControl(name) || name.split("/").length > 64 ||
          name.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Unsafe binary archive path");
      const resource = name === "__MACOSX" || (name === `__MACOSX/${APP}` || name.startsWith(`__MACOSX/${APP}/`));
      if (name !== APP && !name.startsWith(`${APP}/`) && !resource) throw new Error("Unexpected binary archive root");
      const mode = entry.externalFileAttributes >>> 16;
      const type = mode & 0o170000;
      const kind = type === 0o120000 ? "link" : entry.fileName.endsWith("/") ? "directory" : "file";
      if ((type && type !== 0o100000 && type !== 0o040000 && type !== 0o120000) ||
          (type === 0o040000 && kind !== "directory") || (type === 0o100000 && kind === "directory") ||
          entry.isEncrypted() || (kind === "directory" && entry.uncompressedSize !== 0)) throw new Error("Unsupported binary archive entry");
      if (resource && (kind === "link" || (kind === "file" && !posix.basename(name).startsWith("._")))) throw new Error("Unexpected archive resource fork");
      if (namespace.has(key(name))) throw new Error("Conflicting binary archive entries");
      namespace.set(key(name), kind);
      // APFS is commonly case-insensitive and normalizes Unicode. Implicit parent
      // directories must have the same spelling too, before any mkdir can merge them.
      for (let part = name; part !== "."; part = posix.dirname(part)) {
        const previous = spellings.get(key(part));
        if (previous && previous !== part) throw new Error("Conflicting binary archive path aliases");
        if (!previous) namespaceBytes += Buffer.byteLength(part) + Buffer.byteLength(key(part));
        if (namespaceBytes > 32 * 1024 ** 2 || spellings.size >= 400_000) throw new Error("Binary archive namespace exceeds its size limit");
        spellings.set(key(part), part);
      }
      bytes += entry.uncompressedSize;
      pathBytes += name.length;
      metadataBytes += Buffer.byteLength(entry.fileComment) + entry.extraFields.reduce((sum, field) => sum + field.data.length, 0);
      if (!Number.isSafeInteger(bytes) || bytes > limits.bytes || entries.length >= limits.entries || pathBytes > 16 * 1024 ** 2 ||
          metadataBytes > 16 * 1024 ** 2 ||
          (kind === "link" && entry.uncompressedSize > 4096)) throw new Error("Binary archive exceeds the unpacked size limit");
      entries.push({entry, name, kind, mode: mode & 0o777, resource});
    }
    if (!entries.some(e => e.name.startsWith(`${APP}/Contents/`))) throw new Error("The archive contains no app");
    for (const {name} of entries) {
      for (let parent = posix.dirname(name); parent !== "."; parent = posix.dirname(parent)) {
        const kind = namespace.get(key(parent));
        if (kind && kind !== "directory") throw new Error("An archive entry has a non-directory ancestor");
      }
    }
    onInventory(bytes);
    const links: {name: string; target: string}[] = [];
    for (const {entry, name, kind, mode, resource} of entries) {
      signal.throwIfAborted();
      const path = join(destination, name);
      if (kind === "directory") { if (!resource) await mkdir(path, {recursive: true, mode: 0o755}); continue; }
      const stream = await zip.openReadStreamPromise(entry);
      let count = 0;
      let checksum = 0;
      const chunks: Buffer[] = [];
      const bounded = new Transform({transform(chunk: Buffer, _encoding, done) {
        count += chunk.length;
        if (count > entry.uncompressedSize) return done(new Error("Binary archive expanded beyond its declared size"));
        checksum = crc32(chunk, checksum);
        done(null, chunk);
      }});
      if (kind === "link" || resource) {
        await pipeline(stream, bounded, async function (source) {
          for await (const chunk of source) if (!resource) chunks.push(Buffer.from(chunk));
        }, {signal});
      } else {
        await mkdir(dirname(path), {recursive: true, mode: 0o755});
        await pipeline(stream, bounded, createWriteStream(path, {flags: "wx", mode: mode || 0o644}), {signal});
      }
      if (count !== entry.uncompressedSize || checksum !== entry.crc32) throw new Error("Corrupt binary archive contents");
      if (kind === "link") {
        const target = Buffer.concat(chunks).toString("utf8");
        const resolved = posix.normalize(posix.join(posix.dirname(name), target));
        if (!target || target.includes("\\") || hasControl(target) || posix.isAbsolute(target) || !resolved.startsWith(`${APP}/`)) throw new Error("Escaping binary archive symlink");
        links.push({name, target});
      }
    }
    for (const {name, target} of links) { await mkdir(dirname(join(destination, name)), {recursive: true}); await symlink(target, join(destination, name)); }
    const app = await realpath(join(destination, APP));
    for (const {name} of links) {
      const target = await realpath(join(destination, name));
      if (!target.startsWith(`${app}/`)) throw new Error("Escaping or cyclic binary archive symlink");
    }
    for (const {name, kind, mode, resource} of [...entries].reverse()) {
      if (!resource && kind === "directory") await chmod(join(destination, name), mode || 0o755);
    }
    return app;
  } finally { zip.close(); }
}
