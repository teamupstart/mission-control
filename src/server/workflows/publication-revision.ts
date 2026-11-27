import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
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
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const checkoutFacts = () => git(checkout, ["rev-parse", "--path-format=absolute", "--show-toplevel",
      "--absolute-git-dir", "--git-common-dir", "--git-path", "index", "--git-path", "shallow", "HEAD"]);
    const facts = checkoutFacts();
    const fields = decoder.decode(facts).trimEnd().split("\n");
    const [root, admin, common, index, shallow, head] = fields;
    if (fields.length !== 6 || !root || !admin || !common || !index || !shallow ||
        !head || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) return null;
    const inventory = git(root, ["ls-files", "-v", "--stage", "--others", "--exclude-standard", "-z"]);
    const digest = createHash("sha256").update(facts).update(inventory);
    const recordStat = (file: string) => {
      const stat = lstatSync(file, { bigint: true, throwIfNoEntry: false });
      digest.update(JSON.stringify([file, stat
        ? [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)
        : null]));
      return stat;
    };
    const paths = new Set(retained.map(item => item.path));
    const records = decoder.decode(inventory).split("\0");
    for (const record of records) {
      if (!record) continue;
      paths.add(record.startsWith("? ") ? record.slice(2) : record.slice(record.indexOf("\t") + 1));
    }
    const metadata = new Set([root, join(root, ".git"), admin, common, index, shallow,
      join(common, "config"), join(admin, "config.worktree"),
      join(common, "info", "attributes"), join(common, "info", "exclude")]);
    for (const path of paths) {
      if (performance.now() >= deadline) return null;
      const file = join(root, path);
      for (let parent = dirname(file); !metadata.has(parent); parent = dirname(parent)) {
        if (dirname(parent) === parent) return null;
        metadata.add(parent);
      }
      const stat = recordStat(file);
      // A gitlink's HEAD can stay fixed while files inside it change. Only reuse a
      // clean nested checkout. An uninitialized submodule would resolve to its parent.
      if (stat?.isDirectory()) {
        if (git(file, ["rev-parse", "--show-prefix"]).toString().trim()
          || git(file, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]).length) return null;
        digest.update(git(file, ["rev-parse", "HEAD"]));
      }
    }
    for (const file of metadata) {
      if (performance.now() >= deadline) return null;
      recordStat(file);
    }
    return checkoutFacts().equals(facts) && performance.now() < deadline ? digest.digest("hex") : null;
  } catch {
    return null;
  }
}
