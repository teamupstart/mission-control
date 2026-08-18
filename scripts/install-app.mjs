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
//    `--from-origin` installs the fork and records the fork in the receipt.
// 2. The release lookup passes the repository explicitly. Without it the CLI infers the
//    repository from whichever checkout it runs in, so the same tag name would resolve to
//    fork-controlled code while the receipt still named the canonical repository. Every
//    release query goes through GH_ARGS, and this file names the binary exactly once.
//
// The candidate release is chosen by an explicitly FILTERED query, never by asking for "the
// latest" and filtering afterwards. Both this script and the updater resolve a release tag; if
// they disagreed, a fresh install and an update from identical repository state would land on
// different versions.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stateDir } from "../src/shared/harness-runtime.mjs";
import { CANONICAL_REPO } from "../src/shared/install-receipt-schema.mjs";
import { receiptPath, writeReceipt } from "../src/shared/install-receipt.mjs";
import {
  archPrerequisiteMessage,
  ghPrerequisiteMessage,
  gitPrerequisiteMessage,
  nodePrerequisiteMessage,
} from "./init-prerequisites.mjs";

/** The bundle name `electron-builder.yml` produces, and the one installed. */
export const APP_BUNDLE_NAME = "Mission Control.app";

/** Where a Mac keeps its applications. Overridable only to verify an install safely. */
export const DEFAULT_APPS_DIR = "/Applications";

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
    { transport: "ssh", re: /^ssh:\/\/(?:[^@/]+@)?[^/]+\/(.+?)(?:\.git)?\/?$/ },
    { transport: "ssh", re: /^(?:[^@\s/]+@)[^:\s]+:(.+?)(?:\.git)?\/?$/ },
    { transport: "https", re: /^https?:\/\/(?:[^@/]+@)?[^/]+\/(.+?)(?:\.git)?\/?$/ },
  ];
  for (const { transport, re } of patterns) {
    const match = re.exec(trimmed);
    const slug = match?.[1];
    if (slug && /^[\w.-]+\/[\w.-]+$/.test(slug)) return { slug, transport };
  }
  return null;
}

/** The URL to clone `repo` from, keeping the caller's transport. */
export function canonicalRemoteUrl(transport, repo = CANONICAL_REPO) {
  return transport === "ssh"
    ? `ssh://git@github.com/${repo}.git`
    : `https://github.com/${repo}.git`;
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
export function resolveInstallRepo({ originSlug, fromOrigin = false }) {
  if (originSlug === CANONICAL_REPO) return { repo: CANONICAL_REPO, problem: null };
  if (!originSlug) {
    return {
      repo: null,
      problem: "this checkout has no usable `origin` remote, so there is no transport to clone with. Run this from a git clone of the repository.",
    };
  }
  if (fromOrigin) return { repo: originSlug, problem: null };
  return { repo: null, problem: originMismatchMessage(originSlug) };
}

/**
 * The newest stable release tag, or `null` when the repository has published none.
 *
 * Drafts and prereleases are excluded by the QUERY. Asking for the latest release and
 * rejecting it afterwards cannot recover: once a prerelease has been selected, there is no way
 * back to the newest stable release, and every stable install silently stops updating with no
 * error raised anywhere.
 */
export function newestStableReleaseTag({ repo = CANONICAL_REPO, run }) {
  const result = run(GH_BIN, GH_ARGS.releaseList(repo));
  if (result.status !== 0) return null;
  try {
    const releases = JSON.parse(result.stdout || "[]");
    const tag = Array.isArray(releases) ? releases[0]?.tagName : null;
    return typeof tag === "string" && tag.length > 0 ? tag : null;
  } catch {
    return null;
  }
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

/** The app's user-facing version out of a packaged `Info.plist`. */
export function plistVersion(text) {
  const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/.exec(
    String(text ?? ""),
  );
  return match?.[1]?.trim() || null;
}

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
    fromOrigin: options.fromOrigin,
  });
  if (repoProblem) fail(repoProblem);
  ok(repo === CANONICAL_REPO ? `${repo} (canonical)` : `${repo} (--from-origin)`);

  // 3. Updater-owned clone ---------------------------------------------------------------
  heading("Updater-owned clone");
  const clone = join(stateDir(), SOURCE_CLONE_DIR_NAME);
  const remoteUrl = canonicalRemoteUrl(origin?.transport ?? "https", repo);
  if (existsSync(clone)) {
    const cloneOrigin = parseRemote(
      capture("git", ["-C", clone, "remote", "get-url", "origin"]).stdout.trim(),
    );
    if (!cloneOrigin) {
      fail(`${clone} exists but is not a git clone. Move or remove it yourself, then rerun; this script will not delete it.`);
    } else if (cloneOrigin.slug !== repo) {
      fail(`${clone} is a clone of ${cloneOrigin.slug}, not ${repo}. Move or remove it yourself, then rerun; this script will not delete it.`);
    }
    ok(`clone present at ${clone}`);
    run("git", ["-C", clone, "fetch", "--tags", "--prune", "origin"]);
  } else {
    doing(`cloning ${remoteUrl} into ${clone}`);
    run("git", ["clone", remoteUrl, clone]);
  }

  // 4. Target ref ------------------------------------------------------------------------
  heading("Target ref");
  const releaseTag = newestStableReleaseTag({ repo, run: capture });
  const headRef = capture("git", ["-C", clone, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).stdout.trim();
  const defaultBranchRef = headRef || "origin/main";
  const { ref, source } = resolveTargetRef({
    requestedRef: options.ref,
    releaseTag,
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
  if (dryRun) {
    doing(`[dry-run] would replace ${appPath}`);
  } else {
    rmSync(appPath, { recursive: true, force: true });
    // `cp -R` rather than `fs.cpSync`, matching the `install-app` recipe this replaces: the
    // bundle carries framework symlinks, and this is the copy that is known to preserve them.
    run("cp", ["-R", packagedApp, options.appsDir]);
    ok(`installed ${appPath}`);
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
