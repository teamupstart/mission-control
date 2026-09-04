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
