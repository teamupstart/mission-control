#!/usr/bin/env node
// Install the Mission Control macOS app from source, into a clone only the updater ever
// touches, and record a receipt describing what was installed and from where.
//
// This is the documented user path (`make install`). `make app` and `make install-app` remain
// the developer path: they build and install THIS worktree and deliberately write no receipt,
// so the updater stays off for a work-in-progress build.
//
// Usage: node scripts/install-app.mjs [--ref <git-ref>] [--from-origin] [--dry-run]
//                                     [--apps-dir <dir>]
//   --ref <git-ref>   install that ref instead of the newest stable release
//   --from-origin     install this checkout's own origin rather than the canonical repository
//   --dry-run         print what each step would do, change nothing
//   --apps-dir <dir>  install into <dir> instead of /Applications (verification aid)
//
// Idempotent by construction: every step detects its own completion, so re-running with the
// same ref changes nothing except rebuilding.
//
// ## Two trust rules that are load-bearing rather than tidy
//
// 1. The clone is pinned to CANONICAL_REPO, and only the TRANSPORT comes from the caller's
//    origin (so an SSH clone keeps SSH and an HTTPS clone keeps HTTPS). A checkout whose
//    origin is a fork is refused rather than silently retargeted, in either direction:
//    `--from-origin` installs the fork and records the fork in the receipt. Every remote is
//    compared as HOST and slug, never slug alone - the owner and name of a repository are not
//    its identity, and an existing clone is about to be fetched and force-checked-out.
// 2. The release lookup passes the repository explicitly. Without it the CLI infers the
//    repository from whichever checkout it runs in, so the same tag name would resolve to
//    fork-controlled code while the receipt still named the canonical repository. Every
//    release query goes through GH_ARGS, and this file names the binary exactly once.
//
// The candidate release is chosen by an explicitly FILTERED query, never by asking for "the
// latest" and filtering afterwards. Both this script and the updater resolve a release tag; if
// they disagreed, a fresh install and an update from identical repository state would land on
// different versions.
//
// Keep this file's imports static. The detached updater runs it from the updater-owned clone,
// and checkout may rewrite this file on disk while its process is alive. Node loads the full
// static module graph before execution; a later dynamic import would break that safety property.

import { execFileSync, spawnSync } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_BUNDLE_NAME,
  DEFAULT_APPS_DIR,
  plistVersion,
  replaceAppBundle,
  stagingPaths,
  swapAppBundle,
} from "./app-bundle-swap.mjs";
import { stateDir } from "../src/shared/harness-runtime.mjs";
import {
  CANONICAL_REPO,
  isTrustedInstallRepo,
} from "../src/shared/install-receipt-schema.mjs";
import { receiptPath, writeReceipt } from "../src/shared/install-receipt.mjs";
import {
  archPrerequisiteMessage,
  ghPrerequisiteMessage,
  gitPrerequisiteMessage,
  nodePrerequisiteMessage,
  xcodeToolsPrerequisiteMessage,
} from "./init-prerequisites.mjs";

export { APP_BUNDLE_NAME, DEFAULT_APPS_DIR, plistVersion, stagingPaths, swapAppBundle };

/** The updater-owned clone, inside the existing state directory. */
export const SOURCE_CLONE_DIR_NAME = "app-src";

/** `electron-builder`'s `dir` target output - the bundle to install, not the dmg. */
export const PACKAGED_APP_RELATIVE_PATH = join("release", "mac-arm64", APP_BUNDLE_NAME);

const GH_BIN = "gh";

/**
 * Every argument list this script hands the GitHub CLI.
 *
 * A table rather than inline arrays so the repository pin is testable as the trust boundary
 * it is: a release query that lost `--repo` would still work everywhere except a fork, which
 * is precisely the case it exists to stop.
 */
export const GH_ARGS = {
  authStatus: () => ["auth", "status"],
  releaseList: (repo = CANONICAL_REPO) => [
    "release",
    "list",
    "--repo",
    repo,
    "--exclude-drafts",
    "--exclude-pre-releases",
    "--order",
    "desc",
    "--limit",
    "1",
    "--json",
    "tagName",
  ],
};

/** Parse a git remote URL into its repository slug and transport. */
export function parseRemote(url) {
  const trimmed = String(url ?? "").trim();
  const patterns = [
    { transport: "ssh", re: /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/ },
    { transport: "ssh", re: /^(?:[^@\s/]+@)([^:\s/]+):(.+?)(?:\.git)?\/?$/ },
    { transport: "https", re: /^https?:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/ },
  ];
  for (const { transport, re } of patterns) {
    const match = re.exec(trimmed);
    const host = match?.[1]?.toLowerCase();
    const slug = match?.[2];
    if (host && slug && /^[\w.-]+\/[\w.-]+$/.test(slug)) return { host, slug, transport };
  }
  return null;
}

/**
 * The only host a remote may name.
 *
 * The slug alone is not identity. `https://attacker.example/teamupstart/mission-control.git` carries
 * the canonical owner and name, so a check that compared only the slug would fetch and force
 * check out whatever that host served. Every remote this script trusts is compared as host AND
 * slug, and the releases it compares against are GitHub releases, so there is no second host to
 * support.
 */
export const REQUIRED_REMOTE_HOST = "github.com";

/**
 * Why a remote URL is not the repository it is supposed to be, or `null` when it is.
 *
 * Used for the caller's `origin` and for the updater-owned clone's `origin` alike, because both
 * are places a wrong host would be believed.
 */
export function remoteProblem({ url, repo }) {
  const remote = parseRemote(url);
  if (!remote) return `${url || "(empty)"} is not a git remote URL naming an owner/name repository`;
  if (remote.host !== REQUIRED_REMOTE_HOST) {
    return `${url} is hosted at ${remote.host}, not ${REQUIRED_REMOTE_HOST} - only ${REQUIRED_REMOTE_HOST} repositories are supported, because the releases this compares against are GitHub releases`;
  }
  if (
    remote.slug !== repo
    && !(repo === CANONICAL_REPO && isTrustedInstallRepo(remote.slug))
  ) {
    return `${url} is ${remote.slug}, not ${repo}`;
  }
  return null;
}

/** The URL to clone `repo` from, keeping the caller's transport. */
export function canonicalRemoteUrl(transport, repo = CANONICAL_REPO) {
  return transport === "ssh"
    ? `ssh://git@github.com/${repo}.git`
    : `https://github.com/${repo}.git`;
}

/**
 * Validate an updater-owned clone and plan the ordered git commands that make it current.
 *
 * A clone left by an install from the former canonical slug is trusted only through
 * `remoteProblem`'s exact GitHub-hosted alias rule. Rewrite that origin before fetching so a
 * successful migration no longer depends on GitHub continuing to redirect the former URL.
 */
export function existingCloneCommands({ url, repo, clone }) {
  const problem = remoteProblem({ url, repo });
  if (problem) return { problem, commands: [] };

  const remote = parseRemote(url);
  const commands = [];
  if (
    repo === CANONICAL_REPO
    && remote.slug !== CANONICAL_REPO
    && isTrustedInstallRepo(remote.slug)
  ) {
    commands.push([
      "git",
      ["-C", clone, "remote", "set-url", "origin", canonicalRemoteUrl(remote.transport)],
    ]);
  }
  commands.push(["git", ["-C", clone, "fetch", "--tags", "--prune", "origin"]]);
  return { problem: null, commands };
}

/**
 * The first directory in the updater-owned clone that this account cannot rewrite.
 *
 * Git replaces a tracked file by unlinking it from its parent directory. A prior `sudo make
 * install` can therefore leave an apparently readable clone whose root is owned by the person
 * but whose nested directories are owned by root. `git fetch` still works, then checkout dies at
 * the first file under one of those directories. Files themselves do not need to be writable -
 * Git object files are intentionally read-only, and a file in a writable directory can be
 * replaced safely - so this checks directories only.
 */
export function firstUnwritableCloneDirectory(root) {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    try {
      accessSync(directory, fsConstants.W_OK | fsConstants.X_OK);
    } catch {
      return directory;
    }
    let entries;
    try {
      entries = readdirSync(directory);
    } catch {
      return directory;
    }
    for (const entry of entries) {
      const path = join(directory, entry);
      try {
        if (lstatSync(path).isDirectory()) pending.push(path);
      } catch {
        return directory;
      }
    }
  }
  return null;
}

function commandFailure(result) {
  return String(result.stderr || result.stdout || `exit ${result.status ?? 1}`).trim();
}

/**
 * Replace the disposable updater clone without depending on permissions inside the old one.
 *
 * The fresh clone is complete before either rename. The old directory is renamed rather than
 * recursively removed first, because its unwritable descendants are the reason recovery is
 * running. If those descendants also prevent cleanup, the preserved path is returned for a
 * one-time manual cleanup instead of failing an otherwise healthy update.
 */
export function rebuildUpdaterOwnedClone({ clone, remoteUrl, pid, run, ops }) {
  const staged = `${clone}.incoming-${pid}`;
  const previous = `${clone}.unusable-${pid}`;
  try {
    ops.remove(staged);
    if (ops.exists(previous)) {
      return { problem: `the recovery path ${previous} already exists`, preserved: null };
    }
  } catch (error) {
    return {
      problem: `could not prepare a fresh updater clone: ${error instanceof Error ? error.message : String(error)}`,
      preserved: null,
    };
  }

  const cloned = run("git", ["clone", remoteUrl, staged]);
  if (cloned.status !== 0) {
    try { ops.remove(staged); } catch {}
    return { problem: `could not clone a fresh updater source: ${commandFailure(cloned)}`, preserved: null };
  }

  try {
    ops.move(clone, previous);
  } catch (error) {
    try { ops.remove(staged); } catch {}
    return {
      problem: `could not move the unusable updater clone aside: ${error instanceof Error ? error.message : String(error)}`,
      preserved: null,
    };
  }

  try {
    ops.move(staged, clone);
  } catch (error) {
    try { ops.move(previous, clone); } catch {}
    try { ops.remove(staged); } catch {}
    return {
      problem: `could not put the fresh updater clone in place: ${error instanceof Error ? error.message : String(error)}`,
      preserved: null,
    };
  }

  try {
    ops.remove(previous);
    return { problem: null, preserved: null };
  } catch {
    return { problem: null, preserved: previous };
  }
}

export function originMismatchMessage(originSlug) {
  return [
    `this checkout's origin is ${originSlug}, but only ${CANONICAL_REPO} is trusted, so the install stopped rather than quietly retargeting either way.`,
    `Run this from a ${CANONICAL_REPO} checkout, or pass --from-origin to install ${originSlug} - the receipt then records ${originSlug} and the updater stays off, because it trusts only ${CANONICAL_REPO}.`,
  ].join("\n");
}

/**
 * Which repository this install builds from, and the problem when that cannot be decided.
 *
 * The returned `repo` is what the receipt records, so `--from-origin` is visible to the
 * updater rather than being a flag that disappears after the install.
 */
export function resolveInstallRepo({ originSlug, originHost, fromOrigin = false }) {
  if (!originSlug) {
    return {
      repo: null,
      problem: "this checkout has no usable `origin` remote, so there is no transport to clone with. Run this from a git clone of the repository.",
    };
  }
  // Checked before the canonical comparison, and before `--from-origin` can wave anything
  // through: `canonicalRemoteUrl` always builds a github.com URL, so accepting another host
  // here would silently install a github.com repository of the same name instead of the one
  // the caller is standing in.
  if (originHost !== REQUIRED_REMOTE_HOST) {
    return {
      repo: null,
      problem: `this checkout's origin is hosted at ${originHost || "an unknown host"}, not ${REQUIRED_REMOTE_HOST}. Only ${REQUIRED_REMOTE_HOST} repositories can be installed, because the releases this compares against are GitHub releases.`,
    };
  }
  if (isTrustedInstallRepo(originSlug)) return { repo: CANONICAL_REPO, problem: null };
  if (fromOrigin) return { repo: originSlug, problem: null };
  return { repo: null, problem: originMismatchMessage(originSlug) };
}

/**
 * The newest stable release, as `{ tag, problem }`.
 *
 * Drafts and prereleases are excluded by the QUERY. Asking for the latest release and
 * rejecting it afterwards cannot recover: once a prerelease has been selected, there is no way
 * back to the newest stable release, and every stable install silently stops updating with no
 * error raised anywhere.
 *
 * A failed or unreadable query is a `problem`, NOT an empty list. They mean opposite things and
 * only one of them is safe to act on: "this repository has published no stable release yet"
 * legitimately falls back to the default branch tip, while "GitHub could not be asked" would
 * turn a transient outage into an install of unreleased code under a user who asked for a
 * release. `tag` and `problem` are never both set.
 */
export function newestStableRelease({ repo = CANONICAL_REPO, run }) {
  const result = run(GH_BIN, GH_ARGS.releaseList(repo));
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim().split("\n")[0];
    return {
      tag: null,
      problem: `could not list ${repo} releases (gh exited ${result.status})${detail ? `: ${detail}` : ""}`,
    };
  }
  let releases;
  try {
    releases = JSON.parse(result.stdout || "[]");
  } catch {
    return { tag: null, problem: `could not read the release list for ${repo}: gh returned output that is not JSON` };
  }
  if (!Array.isArray(releases)) {
    return { tag: null, problem: `could not read the release list for ${repo}: gh returned ${typeof releases}, not a list` };
  }
  if (releases.length === 0) return { tag: null, problem: null };
  const tag = releases[0]?.tagName;
  if (typeof tag !== "string" || tag.length === 0) {
    return { tag: null, problem: `could not read the release list for ${repo}: the newest release has no tagName` };
  }
  return { tag, problem: null };
}

/** `--ref` wins, then the newest stable release, then the default branch tip. */
export function resolveTargetRef({ requestedRef = null, releaseTag = null, defaultBranchRef }) {
  if (requestedRef) return { ref: requestedRef, source: "flag" };
  if (releaseTag) return { ref: releaseTag, source: "release" };
  return { ref: defaultBranchRef, source: "default-branch" };
}

/**
 * The receipt's `releaseTag`: the tag when a release was installed, `null` for an untagged
 * ref. An explicit `--ref` that names a version tag counts, because it is one.
 */
export function receiptReleaseTag({ ref, source }) {
  if (source === "release") return ref;
  return /^v\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(ref) ? ref : null;
}

/**
 * Why the app cannot be installed into this directory, or `null` when it can.
 *
 * `cp -R app dir` creates `dir` AS the bundle when `dir` does not exist, so a mistyped
 * `--apps-dir` would silently produce an app named after the typo. `/Applications` always
 * exists, which is exactly why this needs asserting rather than assuming.
 */
export function appsDirProblem({ appsDir, exists, isDirectory }) {
  if (!exists) return `${appsDir} does not exist - create it, or leave --apps-dir unset to install into ${DEFAULT_APPS_DIR}`;
  if (!isDirectory) return `${appsDir} is not a directory`;
  return null;
}

/**
 * The two hidden paths beside the destination that the swap uses.
 *
 * Both live in the SAME directory as the installed app, so the moves below are renames within
 * one filesystem - which is what makes them atomic and instant rather than a second full copy
 * that could half-succeed.
 */
export function packagedVersionProblem({ packagedVersion, sourceVersion }) {
  if (!packagedVersion) {
    return "could not read CFBundleShortVersionString from the packaged app's Info.plist";
  }
  if (packagedVersion !== sourceVersion) {
    return `the packaged app reports version ${packagedVersion} but the source tree is ${sourceVersion}, so the build did not come from the checked-out ref`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------

const USAGE = `Usage: node scripts/install-app.mjs [--ref <git-ref>] [--from-origin] [--dry-run] [--apps-dir <dir>]

  --ref <git-ref>   install that ref instead of the newest stable release
  --from-origin     install this checkout's own origin rather than ${CANONICAL_REPO}
  --dry-run         print what each step would do, change nothing
  --apps-dir <dir>  install into <dir> instead of ${DEFAULT_APPS_DIR}`;

export function parseArgs(argv) {
  const options = { ref: null, fromOrigin: false, dryRun: false, appsDir: DEFAULT_APPS_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--from-origin") options.fromOrigin = true;
    else if (arg === "--help" || arg === "-h") return { options, help: true, problem: null };
    else if (arg === "--ref" || arg === "--apps-dir") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        return { options, help: false, problem: `${arg} needs a value` };
      }
      if (arg === "--ref") options.ref = value;
      else options.appsDir = resolve(value);
      i += 1;
    } else return { options, help: false, problem: `unknown argument: ${arg}` };
  }
  return { options, help: false, problem: null };
}

let stepNo = 0;
function heading(title) {
  stepNo += 1;
  console.log(`\n\x1b[1m${stepNo}. ${title}\x1b[0m`);
}
const ok = (m) => console.log(`   \x1b[32m✓\x1b[0m ${m}`);
const doing = (m) => console.log(`   \x1b[36m→\x1b[0m ${m}`);
const warning = (m) => console.log(`   \x1b[33m!\x1b[0m ${m}`);

function fail(message) {
  console.error(`\n\x1b[31m✗\x1b[0m ${message}`);
  process.exit(1);
}

/** Run a command and capture its output. Never throws; reports status instead. */
function capture(command, args, opts = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...opts });
  return {
    status: result.error ? 127 : (result.status ?? 1),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? result.error.message : ""),
  };
}

function installApp(options) {
  const { dryRun } = options;
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

  /** Run a command for real, unless --dry-run, in which case just print it. */
  const run = (command, args, opts = {}) => {
    if (dryRun) {
      doing(`[dry-run] ${command} ${args.join(" ")}`);
      return;
    }
    try {
      execFileSync(command, args, { stdio: "inherit", ...opts });
    } catch (err) {
      fail(`\`${command} ${args.join(" ")}\` failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  console.log(`\x1b[1mMission Control · install\x1b[0m${dryRun ? "  (dry-run)" : ""}`);

  // 1. Prerequisites ---------------------------------------------------------------------
  heading("Prerequisites");
  const nodeProblem = nodePrerequisiteMessage(process.versions.node);
  if (nodeProblem) fail(nodeProblem);
  ok(`Node.js ${process.versions.node}`);

  const archProblem = archPrerequisiteMessage(process.arch);
  if (archProblem) fail(archProblem);
  ok(`architecture ${process.arch}`);

  const gitProblem = gitPrerequisiteMessage(capture("git", ["--version"]).status === 0);
  if (gitProblem) fail(gitProblem);
  ok("git available");

  // Asked here rather than discovered in step 6, where node-gyp's own text is buried in the
  // package output and `run()` reports only "`npm run package` failed".
  const xcodeProblem = xcodeToolsPrerequisiteMessage({
    platform: process.platform,
    installed: capture("xcode-select", ["-p"]).status === 0,
  });
  if (xcodeProblem) fail(xcodeProblem);
  ok("Xcode command line tools available");

  const ghVersion = capture(GH_BIN, ["--version"]);
  const ghAuth = ghVersion.status === 0 ? capture(GH_BIN, GH_ARGS.authStatus()) : null;
  const ghProblem = ghPrerequisiteMessage({
    installed: ghVersion.status === 0,
    authenticated: ghAuth?.status === 0,
  });
  if (ghProblem) fail(ghProblem);
  ok("gh authenticated");

  // 2. Repository to install -------------------------------------------------------------
  heading("Repository");
  const originUrl = capture("git", ["-C", repoRoot, "remote", "get-url", "origin"]).stdout.trim();
  const origin = parseRemote(originUrl);
  const { repo, problem: repoProblem } = resolveInstallRepo({
    originSlug: origin?.slug ?? null,
    originHost: origin?.host ?? null,
    fromOrigin: options.fromOrigin,
  });
  if (repoProblem) fail(repoProblem);
  ok(repo === CANONICAL_REPO ? `${repo} (canonical)` : `${repo} (--from-origin)`);

  // 3. Updater-owned clone ---------------------------------------------------------------
  heading("Updater-owned clone");
  const clone = join(stateDir(), SOURCE_CLONE_DIR_NAME);
  const remoteUrl = canonicalRemoteUrl(origin?.transport ?? "https", repo);
  if (existsSync(clone)) {
    // Host AND slug. This clone is about to be fetched and force-checked-out, so a remote that
    // merely carries the right owner/name - served from anywhere - is not the same repository.
    const cloneRemote = capture("git", ["-C", clone, "remote", "get-url", "origin"]).stdout.trim();
    const clonePlan = existingCloneCommands({ url: cloneRemote, repo, clone });
    if (clonePlan.problem) {
      fail(`${clone} is not a clone of ${repo}: ${clonePlan.problem}. Move or remove it yourself, then rerun; this script will not delete it.`);
    }
    const unwritable = firstUnwritableCloneDirectory(clone);
    if (unwritable) {
      doing(`${clone} contains a directory this account cannot update; rebuilding the updater-owned clone`);
      if (dryRun) {
        doing(`[dry-run] would replace ${clone} with a fresh clone from ${remoteUrl}`);
      } else {
        const rebuilt = rebuildUpdaterOwnedClone({
          clone,
          remoteUrl,
          pid: process.pid,
          run: capture,
          ops: {
            exists: existsSync,
            move: renameSync,
            remove: (path) => rmSync(path, { recursive: true, force: true }),
          },
        });
        if (rebuilt.problem) fail(rebuilt.problem);
        ok(`fresh updater-owned clone at ${clone}`);
        if (rebuilt.preserved) {
          warning(`the old privileged clone remains at ${rebuilt.preserved}; remove it later with an administrator account`);
        }
      }
    } else {
      ok(`clone present at ${clone}`);
      for (const [command, args] of clonePlan.commands) run(command, args);
    }
  } else {
    doing(`cloning ${remoteUrl} into ${clone}`);
    run("git", ["clone", remoteUrl, clone]);
  }

  // 4. Target ref ------------------------------------------------------------------------
  heading("Target ref");
  // Not asked at all when a ref was named: an explicit `--ref` install has no reason to fail on
  // a GitHub outage it does not depend on.
  const release = options.ref
    ? { tag: null, problem: null }
    : newestStableRelease({ repo, run: capture });
  // A lookup that FAILED is not an empty release list. Falling back to the default branch here
  // would install unreleased code because GitHub had a bad minute.
  if (release.problem) fail(`${release.problem}\n\nRetry, or pass --ref to install a specific ref without asking for releases.`);
  const headRef = capture("git", ["-C", clone, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).stdout.trim();
  const defaultBranchRef = headRef || "origin/main";
  const { ref, source } = resolveTargetRef({
    requestedRef: options.ref,
    releaseTag: release.tag,
    defaultBranchRef,
  });
  const sourceLabel = {
    flag: "requested with --ref",
    release: "newest stable release",
    "default-branch": "default branch tip (no release published yet)",
  }[source];
  ok(`${ref} (${sourceLabel})`);

  // 5. Checkout --------------------------------------------------------------------------
  heading("Checkout");
  // Forced, and correct here only because this clone belongs to the updater: nothing a person
  // edits ever lives in it.
  run("git", ["-C", clone, "checkout", "--force", ref]);
  if (!dryRun) {
    const dirty = capture("git", ["-C", clone, "status", "--porcelain"]).stdout.trim();
    if (dirty) fail(`${clone} is not clean after checking out ${ref}:\n${dirty}`);
    ok("clean checkout");
  }

  // 6. Build -----------------------------------------------------------------------------
  heading("Build");
  run("npm", ["ci"], { cwd: clone });
  run("npm", ["run", "package"], { cwd: clone });

  // 7. Verify ----------------------------------------------------------------------------
  heading("Verify");
  const packagedApp = join(clone, PACKAGED_APP_RELATIVE_PATH);
  let sourceVersion = "0.0.0";
  if (dryRun) {
    doing(`[dry-run] would verify ${packagedApp}`);
  } else {
    if (!existsSync(packagedApp)) fail(`the package step produced no app at ${packagedApp}`);
    sourceVersion = JSON.parse(readFileSync(join(clone, "package.json"), "utf8")).version;
    const packagedVersion = plistVersion(
      readFileSync(join(packagedApp, "Contents", "Info.plist"), "utf8"),
    );
    const problem = packagedVersionProblem({ packagedVersion, sourceVersion });
    if (problem) fail(problem);
    ok(`packaged version ${packagedVersion}`);
  }

  // 8. Install ---------------------------------------------------------------------------
  heading("Install");
  const appPath = join(options.appsDir, APP_BUNDLE_NAME);
  const appsDirIssue = appsDirProblem({
    appsDir: options.appsDir,
    exists: existsSync(options.appsDir),
    isDirectory: existsSync(options.appsDir) && statSync(options.appsDir).isDirectory(),
  });
  if (appsDirIssue) fail(appsDirIssue);
  if (dryRun) {
    doing(`[dry-run] would stage the new bundle beside ${appPath} and swap it in`);
  } else {
    const swap = replaceAppBundle({
      sourceBundle: packagedApp,
      appPath,
      appsDir: options.appsDir,
      pid: process.pid,
    });
    if (swap.problem) fail(swap.problem);
    for (const stray of swap.stranded) {
      // A bundle displaced by an earlier privileged install, which this account can rename but
      // not delete. Naming it is the only way anyone reclaims the space, and it is a hidden
      // sibling that Finder does not show.
      warning(`${stray} is owned by another account and could not be removed; delete it with an administrator account`);
    }
    ok(`installed ${appPath}${swap.elevated ? " with administrator authorization" : ""}`);
  }

  // 9. Receipt ---------------------------------------------------------------------------
  heading("Receipt");
  if (dryRun) {
    doing(`[dry-run] would write ${receiptPath()}`);
  } else {
    const written = writeReceipt({
      schema: 1,
      repo,
      releaseTag: receiptReleaseTag({ ref, source }),
      installedVersion: sourceVersion,
      sourceClone: clone,
      appPath,
      installedAt: new Date().toISOString(),
    });
    ok(`wrote ${written}`);
  }

  console.log("\n\x1b[1m─ summary ─\x1b[0m");
  if (dryRun) {
    console.log("(dry-run: nothing was changed)");
    return 0;
  }
  console.log(`\x1b[32mMission Control ${sourceVersion} installed.\x1b[0m`);
  console.log(`  app:    ${appPath}`);
  console.log(`  source: ${clone}  (the updater owns this clone; your own worktree is untouched)`);
  console.log("\nNext:");
  console.log(`  open "${appPath}"`);
  return 0;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const { options, help, problem } = parseArgs(process.argv.slice(2));
  if (help) {
    console.log(USAGE);
    process.exitCode = 0;
  } else if (problem) {
    console.error(`${problem}\n\n${USAGE}`);
    process.exitCode = 1;
  } else {
    process.exitCode = installApp(options);
  }
}
