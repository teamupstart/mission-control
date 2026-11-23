import { spawn, execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MAX_CAPTURE_OBJECT_BYTES, oid, unavailable } from "./format.ts";
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
function checkoutEnvironment(configRead: boolean) {
  // Query the effective excludes file through Git's config reader only. All commands that
  // inspect the index and object database run with system and global configuration disabled.
  return {
    ...env,
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
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
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...flags, ...args],
      { cwd, env: checkoutEnvironment(args[0] === "config"), signal, timeout: 30_000, maxBuffer: 128 << 20, encoding: "buffer" },
      (error, stdout) => {
        if (missing && Number(error?.code) === 1) resolve(Buffer.alloc(0));
        else if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

/** Consume NUL-delimited Git output with backpressure and stop Git on the first refused path. */
export async function checkoutRecords(executable: string, cwd: string, args: string[], signal: AbortSignal,
  maxRecordBytes: number, accept: (record: Buffer) => void) {
  const child = spawn(executable, [...flags, ...args], {
    cwd, signal, env: checkoutEnvironment(false), timeout: 30_000, stdio: ["ignore", "pipe", "ignore"],
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
  objects: string,
  sha256: boolean,
  signal: AbortSignal,
) {
  await mkdir(join(wrapper, "refs"), { recursive: true });
  await mkdir(join(wrapper, "objects"));
  await writeFile(join(wrapper, "HEAD"), "ref: refs/heads/unborn\n");
  if (sha256)
    await writeFile(
      join(wrapper, "config"),
      "[core]\nrepositoryformatversion = 1\nbare = true\n[extensions]\nobjectFormat = sha256\n",
    );
  const child = spawn(executable, [...flags, "--git-dir", wrapper, "cat-file", "--batch-command"], {
    cwd: wrapper,
    env: { ...env, GIT_OBJECT_DIRECTORY: objects },
    signal,
    timeout: 10 * 60_000,
    stdio: ["pipe", "pipe", "ignore"],
  });
  child.on("error", () => child.stdout.destroy());
  child.stdin.on("error", () => child.stdout.destroy());
  const iterator = child.stdout[Symbol.asyncIterator]();
  let rest = Buffer.alloc(0);
  async function fill() {
    if (!rest.length) {
      const chunk = await iterator.next();
      if (chunk.done) unavailable();
      rest = chunk.value;
    }
  }
  async function readHeader(command: "info" | "contents", id: string, type: string) {
    signal.throwIfAborted();
    child.stdin.write(`${command} ${id}\n`);
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
    const [got, kind, length] = header.split(" ");
    const size = Number(length);
    if (got !== id || kind !== type || !Number.isSafeInteger(size) || size < 0) unavailable();
    return size;
  }
  return {
    async get(id: string, type: string, info = false) {
      oid.parse(id);
      const size = await readHeader("info", id, type);
      if (info) return { size, data: Buffer.alloc(0) };
      if (size > MAX_CAPTURE_OBJECT_BYTES)
        throw Object.assign(new Error("Git object exceeds capture limit"), { code: "git_object_too_large" });
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
      child.stdin.end();
      child.kill();
    },
  };
}
