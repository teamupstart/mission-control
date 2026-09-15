import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appSourceCommit } from "../src/main/bundle-version.ts";
import { packagedSourceCommit } from "../scripts/install-app.mjs";
import { bundleSourceCommit } from "../scripts/apply-update.mjs";
import { isCommitSha, sourceCommitProblem } from "../src/shared/update-source.mjs";
import { validateReceipt } from "../src/shared/install-receipt-schema.mjs";

test("all source identity readers agree on packaged metadata and reject missing or malformed identity", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mission-source-identity-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const appRoot = join(dir, "Contents", "Resources", "app");
  mkdirSync(appRoot, { recursive: true });
  for (const value of [undefined, "main", "abcdef0", "a".repeat(40), "b".repeat(40)]) {
    writeFileSync(join(appRoot, "package.json"), JSON.stringify({ missionCommit: value }));
    const expected = isCommitSha(value) ? value : null;
    assert.equal(appSourceCommit(appRoot), expected);
    assert.equal(packagedSourceCommit(dir), expected);
    assert.equal(bundleSourceCommit(dir), expected);
  }
  assert.equal(sourceCommitProblem("a".repeat(40), "a".repeat(40)), null);
  assert.match(sourceCommitProblem("a".repeat(40), "b".repeat(40))!, /requested source commit/);
  assert.match(sourceCommitProblem("a".repeat(40), null)!, /requested source commit/);
  assert.equal(sourceCommitProblem("v1.2.3", null), null);
});

test("the real installer rejects the wrong same-version commit and records the exact installed SHA", {
  skip: process.platform !== "darwin" || process.arch !== "arm64",
}, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mission-alpha-install-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bundle = join(dir, "staged.app");
  const appRoot = join(bundle, "Contents", "Resources", "app");
  const apps = join(dir, "apps");
  const state = join(dir, "state");
  const repo = join(dir, "repo");
  for (const path of [appRoot, apps, state, repo]) mkdirSync(path, { recursive: true });
  writeFileSync(join(bundle, "Contents", "Info.plist"), "<plist><dict><key>CFBundleShortVersionString</key><string>1.2.3</string></dict></plist>");
  const sha = "a".repeat(40);
  writeFileSync(join(appRoot, "package.json"), JSON.stringify({ version: "1.2.3", missionCommit: sha }));
  for (const args of [["init", "-q", repo], ["-C", repo, "remote", "add", "origin", "https://github.com/teamupstart/mission-control.git"]]) {
    const git = spawnSync("git", args, { encoding: "utf8" });
    assert.equal(git.status, 0, git.stderr);
  }
  const install = (ref: string) => spawnSync(process.execPath, ["scripts/install-app.mjs", "--from-staged", bundle,
    "--ref", ref, "--apps-dir", apps], { encoding: "utf8", env: { ...process.env, GIT_DIR: join(repo, ".git"), MISSION_HOME: state } });
  const refused = install("b".repeat(40));
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /requested source commit/);
  assert.deepEqual(readdirSync(apps), []);
  const installed = install(sha);
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  const receipt = JSON.parse(readFileSync(join(state, "install-receipt.json"), "utf8"));
  assert.equal(receipt.installedCommit, sha);
  assert.equal(receipt.releaseTag, null);
  assert.equal(receipt.installedVersion, "1.2.3");
  assert.equal(validateReceipt(receipt), null);
  assert.equal(packagedSourceCommit(join(apps, "Mission Control.app")), sha);
  assert.match(validateReceipt({ ...receipt, installedCommit: "main" })!, /full commit SHA/);
  delete receipt.installedCommit;
  assert.equal(validateReceipt(receipt), null, "old receipts remain readable");
});
