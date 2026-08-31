#!/usr/bin/env node
// Release Please derives versions and changelog entries from Conventional Commit subjects.
// A subject it cannot parse is not an action failure: it is silently omitted, and a push made
// entirely of omitted subjects exits successfully without opening or updating a release pull
// request. Keep the grammar here aligned with the conventional-commits parser Release Please
// uses, then enforce it both before merge and again on the commits newly added to `main`.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ZERO_SHA = /^0{40}$/;
const CONVENTIONAL_SUBJECT = /^[a-z][a-z0-9_]*(?:\([\w$.\-*/ ]+\))?!?: \S.*$/;

/** Why Release Please cannot parse this subject, or `null` when it can. */
export function releaseCommitProblem(value) {
  const subject = String(value ?? "").trim();
  if (!subject) return "the subject is empty";
  if (/[\r\n]/.test(subject)) return "the subject contains more than one line";
  if (!CONVENTIONAL_SUBJECT.test(subject)) {
    return "expected <type>[optional scope][optional !]: <description>, for example `fix(release): reject unparseable commits`";
  }
  return null;
}

/**
 * Subjects newly added to the default branch by one push.
 *
 * First-parent history is deliberate. A squash contributes its one subject, a merge contributes
 * the merge subject Release Please associates with the pull request, and a rebase contributes
 * each rebased subject. Walking every parent of a merge would reject private branch history that
 * Release Please does not use as the merged pull request's release unit.
 */
export function firstParentSubjects({ repoRoot, baseSha, headSha = "HEAD" }) {
  const range = baseSha && !ZERO_SHA.test(baseSha) ? `${baseSha}..${headSha}` : headSha;
  const args = ["log", "--first-parent", "--format=%s"];
  if (!baseSha || ZERO_SHA.test(baseSha)) args.push("-1");
  args.push(range);
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);
}

/** Validate subjects and print a focused diagnostic suitable for a GitHub Actions log. */
export function assertReleaseCommits(subjects) {
  if (subjects.length === 0) {
    console.error("release input rejected: the push contains no first-parent commit subjects");
    return 1;
  }

  const failures = subjects.flatMap((subject) => {
    const problem = releaseCommitProblem(subject);
    return problem ? [`${JSON.stringify(subject)}: ${problem}`] : [];
  });
  if (failures.length > 0) {
    console.error(
      `release input rejected because Release Please would omit ${failures.length} commit subject${failures.length === 1 ? "" : "s"}:\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
    );
    return 1;
  }

  console.log(
    `release input accepted: ${subjects.length} Conventional Commit subject${subjects.length === 1 ? "" : "s"}`,
  );
  return 0;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const explicitSubject = process.env.RELEASE_COMMIT_SUBJECT;
  const subjects = explicitSubject
    ? [explicitSubject]
    : firstParentSubjects({
        repoRoot: resolve(fileURLToPath(new URL("..", import.meta.url))),
        baseSha: process.env.RELEASE_BASE_SHA ?? "",
        headSha: process.env.RELEASE_HEAD_SHA || "HEAD",
      });
  process.exitCode = assertReleaseCommits(subjects);
}
