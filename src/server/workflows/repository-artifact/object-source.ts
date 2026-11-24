import { closeSync, constants, createReadStream, fstatSync } from "node:fs";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { createInflate } from "node:zlib";
import { nativePlanFiles } from "../../plans/native.ts";
import { MAX_CAPTURE_OBJECT_BYTES, unavailable } from "./format.ts";

const directory = constants.O_RDONLY | constants.O_DIRECTORY;

function optionalEntry(parent: number, name: string, flags: number) {
  try {
    return nativePlanFiles().openPlanEntry(parent, name, flags);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// Each lookup is relative to a held directory, with O_NOFOLLOW on every component.
export function openObjectRoot(commonDirectory: number) {
  const fd = nativePlanFiles().openPlanEntry(commonDirectory, "objects", directory);
  try {
    const info = optionalEntry(fd, "info", directory);
    if (info !== null) {
      try {
        for (const name of ["alternates", "http-alternates"]) {
          const alternate = optionalEntry(info, name, constants.O_RDONLY);
          if (alternate !== null) { closeSync(alternate); unavailable(); }
        }
      } finally { closeSync(info); }
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

// Git can resolve deltas using only these inherited regular-file descriptors. It
// never opens a source pathname or consults the source's info directory.
export async function pinPacks(root: number, wrapper: string, signal: AbortSignal) {
  const handles: number[] = [];
  const pack = optionalEntry(root, "pack", directory);
  if (pack === null) return handles;
  try {
    const names = await nativePlanFiles().readPlanDirectoryEntries(pack, 4097, 30_000);
    if (names.length > 4096) unavailable();
    const target = join(wrapper, "objects", "pack");
    await mkdir(target);
    for (const { name, directory: isDirectory } of names) {
      if (isDirectory || !name.endsWith(".idx")) continue;
      signal.throwIfAborted();
      if (handles.length >= 512) unavailable();
      for (const file of [name, name.slice(0, -4) + ".pack"]) {
        const fd = nativePlanFiles().openPlanEntry(pack, file, constants.O_RDONLY);
        handles.push(fd);
        if (!fstatSync(fd).isFile()) unavailable();
        // Child descriptors start immediately after stdin, stdout and stderr.
        await symlink("/dev/fd/" + (handles.length + 2), join(target, file));
      }
    }
    return handles;
  } catch (error) {
    for (const fd of handles) closeSync(fd);
    throw error;
  } finally { closeSync(pack); }
}

export async function looseMatches(root: number, prefix: string, width: number) {
  const fanout = optionalEntry(root, prefix.slice(0, 2), directory);
  if (fanout === null) return [];
  try {
    const names = await nativePlanFiles().readPlanDirectoryEntries(fanout, 200_001, 30_000);
    if (names.length > 200_000) unavailable();
    return names.filter(e => !e.directory && e.name.length === width - 2 && e.name.startsWith(prefix.slice(2)) &&
      /^[a-f0-9]+$/.test(e.name)).map(e => prefix.slice(0, 2) + e.name);
  } finally { closeSync(fanout); }
}

export function checkedObjectSize(size: number) {
  if (size > MAX_CAPTURE_OBJECT_BYTES)
    throw Object.assign(new Error("Git object exceeds capture limit"), { code: "git_object_too_large" });
  return size;
}

export async function readLoose(root: number, id: string, type: string, info: boolean, signal: AbortSignal) {
  const fanout = optionalEntry(root, id.slice(0, 2), directory);
  if (fanout === null) return null;
  let fd;
  try { fd = optionalEntry(fanout, id.slice(2), constants.O_RDONLY); }
  finally { closeSync(fanout); }
  if (fd === null) return null;
  let source;
  try {
    if (!fstatSync(fd).isFile()) unavailable();
    source = createReadStream("", { fd, signal });
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  const inflate = createInflate();
  source.on("error", error => inflate.destroy(error));
  source.pipe(inflate);
  try {
    let header = "", data: Buffer | undefined, offset = 0;
    for await (const chunk of inflate as AsyncIterable<Buffer>) {
      signal.throwIfAborted();
      let start = 0;
      if (!data) {
        const nul = chunk.indexOf(0);
        const end = nul < 0 ? chunk.length : nul;
        if (header.length + end > 64) unavailable();
        header += chunk.toString("latin1", 0, end);
        if (nul < 0) continue;
        const size = Number(header.slice(type.length + 1));
        if (!Number.isSafeInteger(size) || size < 0 || header !== type + " " + size) unavailable();
        if (info) return { size, data: Buffer.alloc(0) };
        data = Buffer.allocUnsafe(checkedObjectSize(size));
        start = nul + 1;
      }
      if (chunk.length - start > data.length - offset) unavailable();
      offset += chunk.copy(data, offset, start);
    }
    if (!data || offset !== data.length) return unavailable();
    return { size: data.length, data };
  } finally {
    source.destroy();
    inflate.destroy();
  }
}
