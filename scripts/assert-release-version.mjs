#!/usr/bin/env node
// Prove a release tag, `package.json`, and `package-lock.json` all name the same version.
//
// The updater compares the running app's `package.json` version against a release TAG, so the
// two have to be the same number. Nothing enforced that before: a tag pushed by hand, or a
// Release Please pull request merged after a manual version edit, would produce a release the
// updater either never offers or offers forever. This turns that into a failed check.
//
// The lockfile is included because it carries the version twice - top level and
// `packages[""]` - and a bump that misses either leaves `npm ci` installing a tree whose
// manifest disagrees with the artifact built from it.
//
// Usage: node scripts/assert-release-version.mjs [<tag>]
//   <tag>  the release tag, e.g. v1.2.3. Defaults to GITHUB_REF_NAME.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The version a `vX.Y.Z` tag names, or `null` when the tag is not one. */
export function versionFromTag(tag) {
  const match = /^v(\d+\.\d+\.\d+)$/.exec(String(tag ?? "").trim());
  return match?.[1] ?? null;
}

/**
 * Why this tag must not produce a release artifact, or `null` when everything agrees.
 *
 * Pure so every mismatch shape is a test rather than a release rehearsal.
 */
export function releaseVersionProblem({ tag, packageVersion, lockVersion, lockPackageVersion }) {
  if (!tag) {
    return "no release tag was given, and GITHUB_REF_NAME is unset - pass the tag as the first argument";
  }
  const version = versionFromTag(tag);
  if (!version) return `${tag} is not a vX.Y.Z release tag`;
  if (packageVersion !== version) {
    return `tag ${tag} names version ${version} but package.json is ${packageVersion}`;
  }
  if (lockVersion !== version) {
    return `tag ${tag} names version ${version} but package-lock.json is ${lockVersion}`;
  }
  if (lockPackageVersion !== version) {
    return `tag ${tag} names version ${version} but package-lock.json packages[""] is ${lockPackageVersion}`;
  }
  return null;
}

/** Read the three versions out of a repository checkout. */
export function readVersions(repoRoot) {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8"));
  return {
    packageVersion: pkg.version,
    lockVersion: lock.version,
    lockPackageVersion: lock.packages?.[""]?.version,
  };
}

export function assertReleaseVersion({ tag, repoRoot }) {
  const problem = releaseVersionProblem({ tag, ...readVersions(repoRoot) });
  if (problem) {
    console.error(`release version mismatch: ${problem}`);
    return 1;
  }
  console.log(`release version ${tag} matches package.json and package-lock.json`);
  return 0;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = assertReleaseVersion({
    tag: process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "",
    repoRoot: join(dirname(fileURLToPath(import.meta.url)), ".."),
  });
}
