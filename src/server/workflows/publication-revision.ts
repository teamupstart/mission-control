import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { locateExecutableSync } from "../executables/locator.ts";
import { isolatedGitEnvironment } from "../git/worktree-tree.ts";
export const PUBLICATION_REVISION_BUDGET_MS = 500;

/**
 * A short-lived revision for a publication probe. The full asynchronous evidence probe
 * establishes content equality. The claim checks that its inputs survived the wait using
 * Git's actual index and file inventory plus nanosecond file identities. An unreadable or
 * expensive checkout earns a fresh review. No checkout files or Git objects are written.
 */
export function publicationCheckoutRevision(checkout: string, retained: readonly { path: string }[],
  deadline = performance.now() + PUBLICATION_REVISION_BUDGET_MS): string | null {
  try {
    if (performance.now() >= deadline) return null;
    const executable = locateExecutableSync("git");
    if (!executable) return null;
    const env = isolatedGitEnvironment({ PATH: executable.env.PATH, GIT_OPTIONAL_LOCKS: "0" });
    const git = (cwd: string, args: string[]) => {
      const timeout = Math.ceil(deadline - performance.now());
      if (timeout <= 0) throw new Error("Publication revision timed out");
      return execFileSync(executable.path, ["-c", "core.untrackedCache=false", "-c", "core.fsmonitor=false", "-C", cwd, ...args], {
        env, stdio: ["ignore", "pipe", "pipe"], timeout, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024,
      });
    };
    const root = git(checkout, ["rev-parse", "--show-toplevel"]).toString("utf8").replace(/\r?\n$/, "");
    const digest = createHash("sha256").update(root).update("\0").update(git(root, ["rev-parse", "HEAD"]));
    const inventory = git(root, ["ls-files", "-t", "--stage", "--others", "--exclude-standard", "-z"]);
    digest.update(inventory);
    const paths = new Set(retained.map(item => item.path));
    const records = new TextDecoder("utf-8", { fatal: true }).decode(inventory).split("\0");
    for (const record of records) {
      if (!record) continue;
      paths.add(record.startsWith("? ") ? record.slice(2) : record.slice(record.indexOf("\t") + 1));
    }
    for (const path of paths) {
      if (performance.now() >= deadline) return null;
      const file = join(root, path);
      const stat = lstatSync(file, { bigint: true, throwIfNoEntry: false });
      digest.update(JSON.stringify([path, stat
        ? [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)
        : null]));
      // Git represents an embedded repository or submodule by its checked-out commit.
      if (stat?.isDirectory()) digest.update(git(file, ["rev-parse", "HEAD"]));
    }
    return performance.now() < deadline ? digest.digest("hex") : null;
  } catch {
    return null;
  }
}
