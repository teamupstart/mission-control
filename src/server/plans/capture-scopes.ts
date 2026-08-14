import { readFile } from "node:fs/promises";
import { ARCHIVE_TEXT_LIMITS } from "@shared/archives.ts";
import { PLAN_PAGE_FILENAME, PLAN_ROOT, PLAN_SOURCE_FILENAME } from "@shared/plans.ts";
import type { ArchiveCaptureScope } from "../archives/capture-store.ts";
import { resolveCheckoutFile } from "../archives/checkout.ts";
import type { ResolvedRoot } from "../archives/plan.ts";
import { changedPathsSince } from "../diff.ts";

/**
 * Which plan directories a task actually wrote, and how the question is answered safely.
 *
 * This is the hard part of capturing a plan, and it is hard for a reason that does not apply
 * to a scout. A scout's report is at ONE convention - `docs/reports/<slug>/report.html` - so
 * recovery can enumerate the convention and find it. A plan's is at `docs/plans/<name>/` with
 * `<name>` chosen by whoever wrote it, in a repository that routinely holds many plan
 * directories that have nothing to do with this task: this one holds 76. Enumerating the
 * convention here would archive other people's work on every single plan task.
 *
 * The task's own DIFF is the answer, and it is the answer for two reasons rather than one.
 * It is exact - it names the directories this task wrote and no others - and it is
 * SERVER-DERIVED: it comes from git in a checkout the daemon provisioned, so an agent cannot
 * nominate what gets archived by writing a path into a message. The route this replaced did
 * exactly that, and a capture an agent can aim is a capture that can be aimed at somebody
 * else's files.
 *
 * A directory has to clear one more test than "the diff touched it": it has to hold a
 * `plan.md`. That is the plan's source of truth, so a directory without one is not a plan
 * this build can preserve, and requiring it keeps a task that only edited a stray file under
 * `docs/plans/` from minting an archive with nothing in it.
 */

/** One plan directory a task wrote, with the display title the plan gives itself. */
export interface PlanCaptureScope extends ArchiveCaptureScope {
  /** The plan's own first heading, or null when it has none. */
  title: string | null;
}

export interface PlanCaptureDiscovery {
  /** Every plan directory this task's diff touched, ordered by slot then directory. */
  scopes: PlanCaptureScope[];
  /**
   * Checkouts whose changed paths could not be read at all, by slot.
   *
   * Reported rather than swallowed, and never guessed around. A checkout that cannot answer
   * "what did this task change" is one whose plan directories are unknowable, and the only
   * safe fallback - capturing every `docs/plans/*` in the tree - is precisely the thing this
   * module exists to prevent. So the capture is recorded as unavailable and the caller lets
   * the teardown proceed: an archive holding somebody else's plan is worse than a missing
   * archive, and unlike a scout's report a plan's own files are committed and survive in the
   * pull request regardless.
   */
  unreadable: Array<{ slot: string; reason: string }>;
}

/** How much of a plan's markdown is read looking for its heading. */
const TITLE_SCAN_BYTES = 64 * 1024;

/**
 * Every plan directory the task that owns these checkouts wrote.
 *
 * Each root is asked independently, so one broken checkout costs its own plans rather than
 * every plan the task produced.
 */
export async function discoverPlanCaptureScopes(
  roots: readonly ResolvedRoot[],
): Promise<PlanCaptureDiscovery> {
  const scopes: PlanCaptureScope[] = [];
  const unreadable: Array<{ slot: string; reason: string }> = [];

  for (const root of roots) {
    if (!root.realRoot) continue;
    const changed = await changedPathsSince(root.realRoot);
    if (!changed.ok) {
      unreadable.push({ slot: root.slot, reason: changed.reason });
      continue;
    }
    const directories = new Set<string>();
    for (const path of changed.paths) {
      const directory = planDirectoryOf(path);
      if (directory) directories.add(directory);
    }
    for (const directory of [...directories].sort()) {
      // Resolved through the same defences every captured file goes through - no absolute
      // path, no escape, no symlinked component - because "the diff named it" says the agent
      // wrote something there, not that the path resolves to a file inside this checkout.
      const source = await resolveCheckoutFile(root.realRoot, `${directory}/${PLAN_SOURCE_FILENAME}`);
      if (!source.ok) continue;
      scopes.push({
        slot: root.slot,
        directory,
        title: await planTitle(source.path),
      });
    }
  }

  return { scopes, unreadable };
}

/**
 * The plan directory a checkout-relative path belongs to, or null.
 *
 * Exactly one segment under `docs/plans/`, and a FILE directly under it is not one:
 * `docs/plans/migrate-electron.md` is a loose document this repository actually holds, and
 * reading it as a directory would name a path that is not there.
 */
export function planDirectoryOf(checkoutPath: string): string | null {
  const prefix = `${PLAN_ROOT}/`;
  if (!checkoutPath.startsWith(prefix)) return null;
  const rest = checkoutPath.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const name = rest.slice(0, slash);
  if (name === "." || name === "..") return null;
  return `${prefix}${name}`;
}

/** The page a plan directory is expected to render to. */
export function planPagePath(directory: string): string {
  return `${directory}/${PLAN_PAGE_FILENAME}`;
}

/**
 * A plan's own first heading, read from its markdown.
 *
 * The title on the archive matters more here than it does for a scout. A scout's episode
 * produces one bundle, so the task's title identifies it; a plan task can produce several,
 * and two bundles sharing one task title would be indistinguishable in a catalog. The plan
 * names itself in its first heading, so that is what the bundle is called.
 *
 * Bounded and best-effort: an unreadable or heading-less plan falls back to the task's title
 * rather than failing a capture over a display string.
 */
async function planTitle(sourcePath: string): Promise<string | null> {
  const handle = await readFile(sourcePath, { encoding: "utf8" }).catch(() => null);
  if (handle === null) return null;
  const heading = handle.slice(0, TITLE_SCAN_BYTES).match(/^#[ \t]+(.+?)[ \t]*$/m);
  const title = heading?.[1]?.trim();
  return title ? title.slice(0, ARCHIVE_TEXT_LIMITS.title) : null;
}
