import assert from "node:assert/strict";
import test from "node:test";
import {
  releaseVersionProblem,
  readVersions,
  versionFromTag,
} from "../scripts/assert-release-version.mjs";

const agreeing = { packageVersion: "1.2.3", lockVersion: "1.2.3", lockPackageVersion: "1.2.3" };

test("a vX.Y.Z tag names its version", () => {
  assert.equal(versionFromTag("v1.2.3"), "1.2.3");
  assert.equal(versionFromTag("v1.2.3-rc.1"), null);
  assert.equal(versionFromTag("1.2.3"), null);
  assert.equal(versionFromTag("mission-control-v1.2.3"), null);
  assert.equal(versionFromTag(""), null);
});

test("a tag that matches package.json and the lockfile is accepted", () => {
  assert.equal(releaseVersionProblem({ tag: "v1.2.3", ...agreeing }), null);
});

test("every disagreement is named, including the lockfile's second copy", () => {
  assert.match(
    String(releaseVersionProblem({ tag: "v1.2.4", ...agreeing })),
    /tag v1\.2\.4 names version 1\.2\.4 but package\.json is 1\.2\.3/,
  );
  assert.match(
    String(releaseVersionProblem({ tag: "v1.2.3", ...agreeing, lockVersion: "1.2.2" })),
    /package-lock\.json is 1\.2\.2/,
  );
  assert.match(
    String(releaseVersionProblem({ tag: "v1.2.3", ...agreeing, lockPackageVersion: "1.2.2" })),
    /package-lock\.json packages\[""\] is 1\.2\.2/,
  );
  assert.match(String(releaseVersionProblem({ tag: "v1.2", ...agreeing })), /not a vX\.Y\.Z/);
  assert.match(String(releaseVersionProblem({ tag: "", ...agreeing })), /no release tag was given/);
});

test("this repository's own versions agree with each other", () => {
  const versions = readVersions(new URL("..", import.meta.url).pathname);
  assert.equal(versions.packageVersion, versions.lockVersion);
  assert.equal(versions.packageVersion, versions.lockPackageVersion);
  assert.equal(releaseVersionProblem({ tag: `v${versions.packageVersion}`, ...versions }), null);
});
