import { spawn, execFile } from "node:child_process";
import { closeSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { oid, unavailable } from "./format.ts";
import { checkedObjectSize, looseMatches, openObjectRoot, pinPacks, readLoose } from "./object-source.ts";
import { expansionExceeded } from "./path-budget.ts";

const env = {
  PATH: "/usr/bin:/bin",
  LC_ALL: "C",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_NO_LAZY_FETCH: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
};
const flags = [
  "--no-replace-objects",
  "--no-optional-locks",
  "-c",
  "protocol.allow=never",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "submodule.recurse=false",
  "-c",
  "core.hooksPath=/dev/null",
];
export type CheckoutDirectories = { root: string; admin: string; common: string };
function checkoutEnvironment(configRead: boolean, directories?: CheckoutDirectories) {
  // Query effective checkout settings through Git's config reader only. All commands that
  // inspect the index and object database run with system and global configuration disabled.
  return {
    ...env,
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    ...(directories && { GIT_DIR: directories.admin, GIT_COMMON_DIR: directories.common, GIT_WORK_TREE: directories.root }),
    ...(configRead
      ? {
          GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
          GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
        }
      : {}),
  };
}
export async function checkoutGit(
  executable: string,
  cwd: string,
  args: string[],
  signal: AbortSignal,
  missing = false,
  directories?: CheckoutDirectories,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...flags, ...args],
      { cwd, env: checkoutEnvironment(args[0] === "config", directories), signal, timeout: 30_000, maxBuffer: 128 << 20, encoding: "buffer" },
      (error, stdout) => {
        if (missing && Number(error?.code) === 1) resolve(Buffer.alloc(0));
        else if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

/** Consume NUL-delimited Git output with backpressure and stop Git on the first refused path. */
export async function checkoutRecords(executable: string, directories: CheckoutDirectories, args: string[], signal: AbortSignal,
  maxRecordBytes: number, accept: (record: Buffer) => void) {
  const child = spawn(executable, [...flags, ...args], {
    cwd: directories.root, signal, env: checkoutEnvironment(false, directories), timeout: 30_000, stdio: ["ignore", "pipe", "ignore"],
  });
  const finished = new Promise<Error | number | null>(done => {
    child.once("error", done);
    child.once("close", done);
  });
  let parts: Buffer[] = [], size = 0;
  try {
    for await (const chunk of child.stdout) {
      for (let start = 0; start < chunk.length;) {
        const nul = chunk.indexOf(0, start);
        const part = chunk.subarray(start, nul < 0 ? chunk.length : nul);
        size += part.length;
        if (size > maxRecordBytes) expansionExceeded();
        if (nul < 0) { parts.push(part); break; }
        accept(parts.length ? Buffer.concat([...parts, part], size) : part);
        parts = [];
        size = 0;
        start = nul + 1;
      }
    }
    const status = await finished;
    signal.throwIfAborted();
    if (status instanceof Error) throw status;
    if (status !== 0 || size) unavailable();
  } finally {
    child.kill();
    await finished;
  }
}

/** One persistent batch process reads only literal object ids. No source config or refs
 * are accessible to the process, so a partial clone cannot invoke its remote helper. */
export async function openObjectReader(
  executable: string,
  wrapper: string,
  commonDirectory: number,
  sha256: boolean,
  captureSignal: AbortSignal,
) {
  const signal = AbortSignal.any([captureSignal, AbortSignal.timeout(10 * 60_000)]);
  await mkdir(join(wrapper, "refs"), { recursive: true });
  await mkdir(join(wrapper, "objects"));
  await writeFile(join(wrapper, "HEAD"), "ref: refs/heads/unborn\n");
  if (sha256)
    await writeFile(
      join(wrapper, "config"),
      "[core]\nrepositoryformatversion = 1\nbare = true\n[extensions]\nobjectFormat = sha256\n",
    );
  const root = openObjectRoot(commonDirectory);
  const start = async () => {
    const packs = await pinPacks(root, wrapper, signal);
    try {
      return spawn(executable, [...flags, "--git-dir", wrapper, "cat-file", "--batch-command"], {
        cwd: wrapper, env, signal, stdio: ["pipe", "pipe", "ignore", ...packs],
      });
    } finally { for (const fd of packs) closeSync(fd); }
  };
  const child = await start().catch(error => { closeSync(root); throw error; });
  // The variable-length tail carries pack handles. The first two slots are always pipes.
  const stdin = child.stdin!, stdout = child.stdout!;
  child.on("error", () => stdout.destroy());
  stdin.on("error", () => stdout.destroy());
  const iterator = stdout[Symbol.asyncIterator]();
  let rest = Buffer.alloc(0);
  async function fill() {
    if (!rest.length) {
      const chunk = await iterator.next();
      if (chunk.done) unavailable();
      rest = chunk.value;
    }
  }
  async function query(command: "info" | "contents", id: string) {
    signal.throwIfAborted();
    stdin.write(`${command} ${id}\n`);
    let header = "";
    for (;;) {
      await fill();
      const nl = rest.indexOf(10);
      const end = nl < 0 ? rest.length : nl;
      header += rest.subarray(0, end).toString("ascii");
      rest = rest.subarray(end + 1);
      if (header.length > 150) unavailable();
      if (nl >= 0) break;
    }
    return header;
  }
  async function readHeader(command: "info" | "contents", id: string, type: string) {
    const [got, kind, length] = (await query(command, id)).split(" ");
    const size = Number(length);
    if (got !== id || kind !== type || !Number.isSafeInteger(size) || size < 0) unavailable();
    return size;
  }
  return {
    async resolvePrefix(prefix: string) {
      const matches = new Set(await looseMatches(root, prefix, sha256 ? 64 : 40));
      const header = await query("info", prefix);
      if (header !== prefix + " missing") {
        const id = oid.parse(header.split(" ")[0]);
        if (!id.startsWith(prefix)) unavailable();
        matches.add(id);
      }
      if (matches.size !== 1) return unavailable();
      return [...matches][0]!;
    },
    async get(id: string, type: string, info = false) {
      oid.parse(id);
      const loose = await readLoose(root, id, type, info, signal);
      if (loose) return loose;
      const size = await readHeader("info", id, type);
      if (info) return { size, data: Buffer.alloc(0) };
      checkedObjectSize(size);
      if (await readHeader("contents", id, type) !== size) unavailable();
      const data = Buffer.allocUnsafe(size);
      for (let offset = 0; offset < size;) {
        await fill();
        const n = rest.copy(data, offset);
        offset += n;
        rest = rest.subarray(n);
      }
      await fill();
      if (rest[0] !== 10) unavailable();
      rest = rest.subarray(1);
      return { size, data };
    },
    close() {
      closeSync(root);
      stdin.end();
      child.kill();
    },
  };
}
