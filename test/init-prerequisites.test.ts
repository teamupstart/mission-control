import assert from "node:assert/strict";
import test from "node:test";
import {
  archPrerequisiteMessage,
  chromiumPrerequisiteMessage,
  ghPrerequisiteMessage,
  gitPrerequisiteMessage,
  MIN_NODE_MAJOR,
  nodeMajor,
  nodePrerequisiteMessage,
  REQUIRED_ARCH,
  xcodeToolsPrerequisiteMessage,
} from "../scripts/init-prerequisites.mjs";
import { nativeBuildTarget } from "../scripts/build-keep-awake-native.mjs";

test("init prerequisite checks accept supported Node versions", () => {
  assert.equal(nodeMajor("v24.0.0"), 24);
  assert.equal(nodePrerequisiteMessage("24.0.0"), null);
  assert.equal(nodePrerequisiteMessage("26.6.0"), null);
});

test("init prerequisite checks give the Node installation fix", () => {
  assert.equal(nodeMajor("not-node"), null);
  assert.equal(
    nodePrerequisiteMessage("23.11.0"),
    `Mission Control requires Node.js ${MIN_NODE_MAJOR} or newer (found 23.11.0). Install Node.js ${MIN_NODE_MAJOR}+ and rerun \`make init\`.`,
  );
});

test("init prerequisite checks give the Playwright installation fix", () => {
  assert.equal(
    chromiumPrerequisiteMessage(),
    'Playwright Chromium is required for end-to-end tests. Run `npx playwright install chromium`, then rerun `make init ARGS="--with-e2e"`.',
  );
});

test("the install refuses a non-arm64 host rather than warning", () => {
  assert.equal(archPrerequisiteMessage(REQUIRED_ARCH), null);
  assert.equal(
    archPrerequisiteMessage("x64"),
    `Mission Control packages for Apple Silicon only (found x64). Install it on an ${REQUIRED_ARCH} Mac.`,
  );
  assert.match(String(archPrerequisiteMessage("")), /unknown architecture/);
});

test("the install prerequisite checks give the git installation fix", () => {
  assert.equal(gitPrerequisiteMessage(true), null);
  assert.match(String(gitPrerequisiteMessage(false)), /xcode-select --install/);
});

test("the installer and the running app describe a broken gh identically", () => {
  // Same two sentences as `preflight` in src/server/task-sources/github-issues.ts, so a person
  // whose gh is not usable reads one wording whichever surface tells them.
  assert.equal(ghPrerequisiteMessage({ installed: true, authenticated: true }), null);
  assert.equal(
    ghPrerequisiteMessage({ installed: false, authenticated: false }),
    "the gh CLI is not installed - install it and run `gh auth login`",
  );
  assert.equal(
    ghPrerequisiteMessage({ installed: true, authenticated: false }),
    "gh is not authenticated - run `gh auth login`",
  );
});

test("a missing Xcode command line toolchain is refused before the build, by name", () => {
  // git via Homebrew needs no command line tools, so `gitPrerequisiteMessage` passing says
  // nothing about whether node-gyp can run. This is the check that does.
  assert.equal(
    xcodeToolsPrerequisiteMessage({ platform: "darwin", installed: true }),
    null,
  );
  const missing = String(xcodeToolsPrerequisiteMessage({ platform: "darwin", installed: false }));
  assert.match(missing, /xcode-select --install/);
  assert.match(missing, /node-gyp/);
});

test("the Xcode toolchain is asked for only where a native build actually happens", () => {
  // `nativeBuildTarget` skips every non-Darwin platform, so there is nothing to be missing.
  assert.equal(nativeBuildTarget("linux", "x64").kind, "skip");
  assert.equal(
    xcodeToolsPrerequisiteMessage({ platform: "linux", installed: false }),
    null,
  );
});
