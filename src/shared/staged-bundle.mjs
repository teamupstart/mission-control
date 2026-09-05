// What identifies a staged app bundle, for the three processes that have to agree about it.
//
// The app builds the bundle and remembers what it built. Minutes later a detached helper hands
// that path to the install script, which swaps it into `/Applications`. In between, the bundle
// sits in the updater-owned clone, which is shared: `npm run package` in that clone removes and
// recreates the directory, so a rebuild leaves a perfectly valid app at the same path. Version
// alone cannot tell that apart from the bundle that was verified - a rebuild at the same tag
// carries the same version - so the app pins the directory itself and every later reader checks
// the same token against it.
//
// Kept here because all three sides can reach it and none can reach each other's: the Electron
// main process imports it directly, `scripts/install-app.mjs` imports it from the clone it runs
// in, and the detached helper only ever forwards the token it was handed. No `node:` imports, so
// it stays browser-safe like everything else in `src/shared/`.

/**
 * The identity of the bundle directory now at a path, from its own stat.
 *
 * Inode AND modification time: a rebuild replaces the directory, which changes the inode, and
 * an in-place write to it changes the time. Taking the stat as an argument rather than reading
 * it keeps this module free of `node:` imports and lets each caller stat however it must.
 */
export function stagedBundleRevision(stats) {
  if (!stats) return null;
  const { ino, mtimeMs } = stats;
  if (typeof ino !== "number" || typeof mtimeMs !== "number") return null;
  return `${ino}-${mtimeMs}`;
}

/**
 * Why a staged bundle may not be installed, or `null` when it may.
 *
 * `expected` absent means nobody pinned this bundle - an install driven by hand, or a handoff
 * from an app that predates the pin - and there is then nothing to compare, which is the same
 * latitude the version check gives a ref that names no version.
 */
export function stagedRevisionProblem({ expected, found }) {
  if (!expected) return null;
  if (!found) {
    return "the staged app bundle could not be identified, so it cannot be checked against the one that was prepared";
  }
  if (found !== expected) {
    return "the staged app bundle was replaced after it was prepared, so this is not the build that was verified";
  }
  return null;
}

/**
 * Whether a finished staged build may be installed, and what to do instead when it may not.
 *
 * The whole decision in one place, because it is a rule about bundles rather than a step in a
 * sequence: given what the install script reported when it verified the build, and what is at
 * that path now, there are exactly three answers.
 *
 * - `installable` - the pin the script took still describes what is on disk. Carries that pin,
 *   because everything downstream compares against it: the app before it quits, and the install
 *   script in the instant before the swap.
 * - `unpinnable` - the script reported no identity at all, which means a clone checked out at a
 *   ref older than the running app. Deriving a pin here instead would pin whatever is on disk
 *   by now, so anything rebuilt in between would be installed as though it had been verified.
 *   There is no honest pin available, so the caller must fall back to the whole-install handoff.
 * - `replaced` - the bundle is no longer the one that was verified. Version and revision both
 *   have to match: a rebuild at the same tag carries the same version, and only the revision
 *   tells that apart from the build whose contents were checked.
 *
 * Deciding `replaced` here rather than at the restart is the point of settling it at all: a
 * caller that published "ready" and refused afterwards would spend a person's minutes, promise
 * them a version, and then send them back to rebuild.
 */
export function stagedBuildAcceptance({ staged, found }) {
  const reported = staged?.revision ?? null;
  if (reported === null) return { verdict: "unpinnable" };
  const present = found ?? { version: null, revision: null };
  if (present.version !== staged.version || present.revision !== reported) {
    return { verdict: "replaced" };
  }
  return { verdict: "installable", revision: reported };
}
