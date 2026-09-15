#!/usr/bin/env node
// Install THIS worktree's packaged build, for the person developing it.
//
// `make install` is the managed path: it builds from a clean updater-owned clone and writes the
// receipt the updater reads. This is deliberately not that. It installs the bundle `npm run
// package` just produced, writes no receipt, and therefore leaves the updater off - a
// work-in-progress build must never be mistaken for a release the app will try to update from.
//
// Two things changed here and both are about not losing a working app:
//
// 1. The destination is this account's own `~/Applications`, created when it is missing, the
//    same default the managed install now uses. `--apps-dir` still names somewhere else, and
//    that directory has to already exist.
// 2. The swap goes through `replaceAppBundle`, which stages a hidden sibling, renames the old
//    bundle aside, and only then renames the new one into place. The previous `rm -rf` followed
//    by `cp -R` deleted a working app BEFORE it knew whether the copy would succeed, so a full
//    disk or an interrupted copy left the account with no Mission Control at all.

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_BUNDLE_NAME, replaceAppBundle } from "./app-bundle-swap.mjs";
import {
  installDirectoryProblem,
  mayCreateAppsDir,
  userAppsDir,
} from "./install-destination.mjs";
import { inspectInstallDirectory, PACKAGED_APP_RELATIVE_PATH } from "./install-app.mjs";

export const USAGE = `Usage: node scripts/install-dev-app.mjs [--apps-dir <dir>]

Install this worktree's packaged build (${PACKAGED_APP_RELATIVE_PATH}).
Writes no install receipt, so the updater stays off for a work-in-progress build.

  --apps-dir <dir>   install into <dir> instead of ${userAppsDir()} (the directory must exist)`;

export function parseArgs(argv) {
  const options = { appsDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { options, help: true, problem: null };
    if (arg !== "--apps-dir") return { options, help: false, problem: `unknown argument: ${arg}` };
    const value = argv[i + 1];
    if (!value || value.startsWith("-")) {
      return { options, help: false, problem: "--apps-dir needs a value" };
    }
    options.appsDir = resolve(value);
    i += 1;
  }
  return { options, help: false, problem: null };
}

/**
 * The whole run, with the filesystem and the swap injected so a test can watch the ORDER.
 *
 * Order is the point of this function. The regression it pins is not "did it install" but "did
 * anything remove the installed app before a replacement existed", which is only visible as a
 * sequence of operations.
 */
export function installDevApp({
  appsDir = null,
  repoRoot,
  home = homedir(),
  exists = existsSync,
  makeDirectory = (path) => mkdirSync(path, { recursive: true, mode: 0o755 }),
  inspect = inspectInstallDirectory,
  swap = replaceAppBundle,
  pid = process.pid,
  log = (line) => console.log(line),
}) {
  const bundle = join(repoRoot, PACKAGED_APP_RELATIVE_PATH);
  if (!exists(bundle)) {
    return { problem: `there is no packaged app at ${bundle} - run \`make app\` first`, appPath: null };
  }
  const destination = appsDir ?? userAppsDir(home);
  const issue = installDirectoryProblem(inspect(destination, home));
  if (issue) return { problem: issue, appPath: null };
  if (!exists(destination) && mayCreateAppsDir({ appsDir: destination, home })) {
    makeDirectory(destination);
    log(`created ${destination}`);
  }
  const appPath = join(destination, APP_BUNDLE_NAME);
  const result = swap({ sourceBundle: bundle, appPath, appsDir: destination, pid });
  if (result.problem) return { problem: result.problem, appPath: null };
  for (const stray of result.stranded) {
    log(`! ${stray} is owned by another account and could not be removed`);
  }
  return { problem: null, appPath, elevated: result.elevated === true };
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
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const result = installDevApp({ appsDir: options.appsDir, repoRoot });
    if (result.problem) {
      console.error(`\x1b[31m✗\x1b[0m ${result.problem}`);
      process.exitCode = 1;
    } else {
      console.log(`installed ${result.appPath}${result.elevated ? " with administrator authorization" : ""}`);
      console.log("no install receipt was written, so the updater stays off for this build");
    }
  }
}
