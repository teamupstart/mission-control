import { isolatedGitEnvironment } from "../git/worktree-tree.ts";
import { describeCommandFailure, run } from "../util/exec.ts";

/**
 * Git cleanliness excludes ignored source; filesystem-based Go checks do not. Inspect a
 * reused slot before reset or dependency setup can change its files or ignore rules. This
 * is deliberately conservative, including ignored generated/vendor Go source: neither its
 * name nor its ignore rule proves it belongs to the next check. Nothing is deleted.
 */
export async function inspectPooledCheckInputs(path: string): Promise<
  { ok: true } | { ok: false; category: "state" | "observation"; reason: string }
> {
  const result = await run("git", ["-C", path, "ls-files", "--others", "--ignored",
    "--exclude-standard", "-z", "--", "*.go"], {
    env: isolatedGitEnvironment(), timeoutMs: 15_000, maxBuffer: 1024 * 1024,
  });
  if (result.code !== 0 || result.outcomeUnknown || result.overflowed) {
    return { ok: false, category: "observation",
      reason: `Pool contamination inspection could not complete in ${path}: ${describeCommandFailure("git ls-files", result)}` };
  }
  const paths = result.stdout.split("\0").filter(Boolean);
  if (paths.length === 0) return { ok: true };
  // Bound the persisted diagnostic, and quote filenames so line breaks cannot forge entries.
  const listed = paths.slice(0, 8).map((entry) => JSON.stringify(entry).slice(0, 200)).join(", ");
  return { ok: false, category: "state",
    reason: `Pool contamination in ${path}: ${paths.length} ignored Go source file(s): ${listed}`
      + (paths.length > 8 ? ", ..." : "")
      + ". Check command did not run. Slot quarantined; files preserved in place. Inspect and preserve the artifacts before recovering or destroying the slot." };
}
