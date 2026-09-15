// Where a managed install puts the app, and which of those destinations anyone actually chose.
//
// Split out of `app-bundle-swap.mjs` on purpose. That module owns one thing the rest of the
// install must never widen: the exact `/Applications/Mission Control.app` an administrator
// prompt may write to. It used to own the default destination as well, under one constant, so
// moving the default would have moved the privilege boundary with it. The default now lives
// here and resolves from the signed-in account's home; the boundary stays where it was.
//
// Node builtins only, and no state-directory or receipt I/O: the install script reads the
// receipt and touches the filesystem, this module decides and validates. The predicates take
// the filesystem facts they judge rather than gathering them, so every case below - a file
// standing where the folder should be, a personal folder symlinked at `/Applications`,
// a directory owned by another account - is a plain unit test rather than a fixture tree.

import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { SYSTEM_APPS_DIR, directoryIsWritable } from "./app-bundle-swap.mjs";

export { SYSTEM_APPS_DIR };

/** The folder macOS reserves inside a home directory for that account's own applications. */
export const USER_APPS_DIR_NAME = "Applications";

/** The personal default: this account's own Applications folder. Plural, and never `~` literal. */
export function userAppsDir(home = homedir()) {
  return join(home, USER_APPS_DIR_NAME);
}

/**
 * The scope a destination implies when no receipt already describes it.
 *
 * `/Applications` deliberately classifies as `null` rather than `"system"`. Every update helper
 * ever shipped forwards the receipt's own directory as `--apps-dir`, so a run that lands there
 * is indistinguishable from a legacy install continuing - and `null`, meaning legacy, is exactly
 * what keeps such an install eligible for the automatic relocation that follows this change.
 * Only `--scope system` records system consent, because only `--scope system` is consent.
 */
export function classifyAppsDir(appsDir, home) {
  if (appsDir === userAppsDir(home)) return "user";
  if (appsDir === SYSTEM_APPS_DIR) return null;
  return "custom";
}

/**
 * Pick the destination and the scope to record with it.
 *
 * `scope` is the proposed `--scope`, `appsDir` the long-standing `--apps-dir` transport
 * override, and `receipt` whatever valid managed receipt this machine already has. Returns
 * `{ appsDir, installScope, problem }`; `installScope` is `null` when the install must leave
 * the receipt field absent, which is legacy rather than a preference.
 */
export function resolveInstallDestination({
  scope = null,
  appsDir = null,
  receipt = null,
  home = homedir(),
}) {
  const refuse = (problem) => ({ appsDir: null, installScope: null, problem });
  if (scope !== null && scope !== "user" && scope !== "system") {
    return refuse(`--scope must be user or system, not ${scope}`);
  }
  // Refused before any build, clone, or mutation: the two arguments name destinations
  // independently, and silently preferring one would install somewhere nobody asked for.
  if (scope !== null && appsDir !== null) {
    return refuse("--scope and --apps-dir cannot be combined - choose the scope or the directory");
  }
  if (scope === "system") {
    return { appsDir: SYSTEM_APPS_DIR, installScope: "system", problem: null };
  }
  if (scope === "user") {
    return { appsDir: userAppsDir(home), installScope: "user", problem: null };
  }

  const receiptDir = receiptAppsDir(receipt);
  if (appsDir !== null) {
    const chosen = resolve(appsDir);
    // An update of the install this receipt describes, whichever directory that is. Its
    // recorded policy survives verbatim, including the absence of one.
    if (receiptDir !== null && receiptDir === chosen) {
      return { appsDir: chosen, installScope: receiptScope(receipt), problem: null };
    }
    return { appsDir: chosen, installScope: classifyAppsDir(chosen, home), problem: null };
  }

  // A plain reinstall of an existing managed install stays where it already is. Relocation is
  // an update-time decision, not something a repeated `make install` performs behind someone.
  if (receiptDir !== null) {
    return { appsDir: receiptDir, installScope: receiptScope(receipt), problem: null };
  }
  return { appsDir: userAppsDir(home), installScope: "user", problem: null };
}

/** The directory an existing receipt's app sits in, or null when there is no usable receipt. */
export function receiptAppsDir(receipt) {
  const appPath = receipt?.appPath;
  if (typeof appPath !== "string" || !appPath.startsWith("/")) return null;
  const slash = appPath.lastIndexOf("/");
  const directory = slash <= 0 ? "/" : appPath.slice(0, slash);
  return directory;
}

function receiptScope(receipt) {
  const scope = receipt?.installScope;
  return scope === "user" || scope === "system" || scope === "custom" ? scope : null;
}

/**
 * Whether this install is allowed to create its destination directory.
 *
 * Only the canonical personal folder, and only because a first-time personal install would
 * otherwise fail on a Mac that has simply never needed one. Every other destination keeps the
 * long-standing rule that it must already exist: `cp -R app dir` creates `dir` AS the bundle
 * when `dir` is missing, so a mistyped `--apps-dir` would otherwise produce an app named after
 * the typo.
 */
export function mayCreateAppsDir({ appsDir, home = homedir() }) {
  return appsDir === userAppsDir(home);
}

/**
 * Why the app cannot be installed into this directory, or `null` when it can.
 *
 * `facts` are gathered by the caller so this stays a pure decision:
 *
 * - `exists` / `isDirectory`: what is at the path now.
 * - `resolvedPath`: the path with every symlink expanded, or `null` when it cannot be resolved.
 * - `realHome`: the home directory with symlinks expanded, which is what makes a resolved path
 *   comparable at all on a Mac where `/var` is `/private/var`.
 * - `ownedByUser`: whether the signed-in account owns the directory, or `null` when unknown.
 * - `writable`: whether this account can write and traverse it.
 */
export function installDirectoryProblem({
  appsDir,
  home = homedir(),
  exists,
  isDirectory,
  resolvedPath = appsDir,
  realHome = home,
  ownedByUser = null,
  writable = true,
}) {
  const personal = appsDir === userAppsDir(home);
  if (!exists) {
    // Created by the caller, not refused: a Mac that has never had a personal app has no
    // `~/Applications`, and requiring one by hand would be the whole first-run friction.
    if (personal) return null;
    return `${appsDir} does not exist - create it, or leave --apps-dir unset to install into ${userAppsDir(home)}`;
  }
  if (!isDirectory) {
    return personal
      ? `${appsDir} is not a directory - move whatever is there aside, then install again`
      : `${appsDir} is not a directory`;
  }
  if (personal) {
    // A personal destination that resolves somewhere else is refused rather than followed.
    // `~/Applications` symlinked at `/Applications` is the case that matters: it would turn
    // every "personal" install into a system install, silently, and hand the privileged path a
    // destination nobody opted into. Another account's folder resolves outside this home too.
    const permitted = new Set([appsDir, join(realHome, USER_APPS_DIR_NAME)]);
    if (resolvedPath === null) {
      return `${appsDir} could not be resolved - check it for a broken symlink, then install again`;
    }
    if (!permitted.has(resolvedPath)) {
      return `${appsDir} resolves to ${resolvedPath}, outside this account's home - install with --scope system or --apps-dir to choose that destination deliberately`;
    }
  }
  // Ownership is a PERSONAL-destination question and only that. `/Applications` is root-owned
  // on every Mac, and a shared or custom directory was named deliberately by whoever ran the
  // command, so refusing on owner there would refuse the ordinary case. Under this account's
  // own home, a folder somebody else owns is the anomaly worth stopping for.
  if (personal && ownedByUser === false) {
    return `${appsDir} is owned by another account - Mission Control will not take it over`;
  }
  // `/Applications` is the one destination where being unwritable is not the end of the story:
  // `replaceAppBundle` attempts the plain swap and, only when that proves it was needed, asks
  // for the one narrowly scoped administrator authorization this product raises. Refusing here
  // would cut that path off and break both `--scope system` and every managed install that has
  // always lived there. Everywhere else there is no elevation to fall back on, so an
  // unwritable destination is a dead end and says so before anything is copied.
  if (appsDir !== SYSTEM_APPS_DIR && !writable) {
    return `${appsDir} is not writable by this account - fix its permissions, or choose another destination with --apps-dir`;
  }
  return null;
}

/**
 * How the summary names the destination, so an operator can see which of the three they got.
 */
export function describeInstallScope(installScope) {
  if (installScope === "user") return "personal";
  if (installScope === "system") return "system";
  if (installScope === "custom") return "custom";
  return "existing";
}

/**
 * What is at a destination directory right now, in the shape `installDirectoryProblem` judges.
 *
 * Gathering and deciding are separate so the decision is a plain unit test rather than a
 * fixture tree: `scripts/install-destination.mjs` holds the rules, this holds the `stat` calls.
 *
 * `realpathSync` on both the destination and the home directory, because a resolved path is
 * only comparable against another resolved one - macOS serves `/var` as `/private/var`, and a
 * literal comparison would refuse a perfectly ordinary personal folder under a temp home while
 * happily accepting `~/Applications` symlinked at `/Applications`, which is the case that
 * actually matters.
 */
export function inspectInstallDirectory(appsDir, home = homedir()) {
  let exists = false;
  let isDirectory = false;
  let ownedByUser = null;
  try {
    const stats = statSync(appsDir);
    exists = true;
    isDirectory = stats.isDirectory();
    const uid = process.getuid?.();
    ownedByUser = typeof uid === "number" ? stats.uid === uid : null;
  } catch {
    // Absent, or unreadable through a parent. Both read as "not there" and are answered by
    // the rules rather than here.
  }
  let resolvedPath = null;
  if (exists) {
    try {
      resolvedPath = realpathSync(appsDir);
    } catch {
      resolvedPath = null;
    }
  }
  let realHome = home;
  try {
    realHome = realpathSync(home);
  } catch {
    // A home that cannot be resolved leaves the literal path as the comparison, which is
    // stricter rather than looser.
  }
  return {
    appsDir,
    home,
    exists,
    isDirectory,
    resolvedPath,
    realHome,
    ownedByUser,
    writable: exists ? directoryIsWritable(appsDir) : true,
  };
}

/**
 * The two hidden paths beside the destination that the swap uses.
 *
 * Both live in the SAME directory as the installed app, so the moves below are renames within
 * one filesystem - which is what makes them atomic and instant rather than a second full copy
 * that could half-succeed.
 */
