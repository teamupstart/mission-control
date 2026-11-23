import { execFile } from "node:child_process";
import {
  realpath,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Only closed reader commands reach Git. Never load the artifact's Git configuration. */
export async function repositoryGit(
  executable: string,
  directory: string,
  args: string[],
  signal: AbortSignal,
  timeout: number,
  maxBuffer: number,
): Promise<Buffer> {
  signal.throwIfAborted();
  const root = await realpath(directory);
  for (const path of [
    "objects/info/alternates",
    "objects/info/http-alternates",
    "commondir",
    "info/grafts",
  ]) {
    try {
      await lstat(join(root, path));
      throw new Error("Unsafe object view");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  // A private bare wrapper prevents local includes, worktree paths, mailmaps, hooks,
  // promisor remotes and user diff/filter configuration from becoming ambient authority.
  const wrapper = await mkdtemp(join(tmpdir(), "repository-git-"));
  try {
    await Promise.all([
      mkdir(join(wrapper, "objects")),
      mkdir(join(wrapper, "refs")),
      writeFile(join(wrapper, "HEAD"), "ref: refs/heads/unborn\n"),
    ]);
    try {
      const shallow = await readFile(join(root, "shallow"), "utf8");
      if (!/^(?:[a-f0-9]{40}(?:[a-f0-9]{24})?\n)+$/.test(shallow))
        throw Error("Invalid shallow view");
      await writeFile(join(wrapper, "shallow"), shallow);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // SHA-256 views require an explicit format; infer it from the trusted view's object ids.
    if (
      args.find((arg) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(arg))
        ?.length === 64
    )
      await writeFile(
        join(wrapper, "config"),
        "[core]\nrepositoryformatversion = 1\nbare = true\n[extensions]\nobjectformat = sha256\n",
      );
    return await new Promise((resolve, reject) => {
      execFile(
        executable,
        [
          "--no-optional-locks",
          "--literal-pathspecs",
          "--no-replace-objects",
          "-c",
          "core.bare=true",
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.attributesFile=/dev/null",
          "-c",
          "diff.external=",
          "-c",
          "core.pager=cat",
          "-c",
          "credential.helper=",
          "-c",
          "protocol.allow=never",
          "-c",
          "core.quotePath=false",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "mailmap.file=/dev/null",
          "-c",
          "mailmap.blob=",
          "--git-dir",
          wrapper,
          ...args,
        ],
        {
          cwd: wrapper,
          env: {
            PATH: "/usr/bin:/bin",
            HOME: wrapper,
            GIT_OBJECT_DIRECTORY: join(root, "objects"),
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_SYSTEM: "/dev/null",
            GIT_CONFIG_COUNT: "0",
            GIT_NO_LAZY_FETCH: "1",
            GIT_TERMINAL_PROMPT: "0",
            GIT_ATTR_NOSYSTEM: "1",
            GIT_OPTIONAL_LOCKS: "0",
            LC_ALL: "C",
          },
          encoding: "buffer",
          signal,
          timeout,
          maxBuffer,
          windowsHide: true,
        },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
  } finally {
    await rm(wrapper, { recursive: true, force: true });
  }
}
