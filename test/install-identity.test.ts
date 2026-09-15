import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_BUNDLE_NAME,
  bundleIdentityProblem,
  classifyInstallIdentity,
  identityUpdateBlock,
  systemAppPath,
  userAppPath,
  type IdentityInputs,
} from "../src/main/install-identity.ts";
import type { InstallReceipt } from "../src/shared/install-receipt-schema.mjs";
import { CANONICAL_REPO } from "../src/shared/install-receipt-schema.mjs";

const HOME = "/Users/someone";
const SYSTEM_APP = systemAppPath();
const USER_APP = userAppPath(HOME);
const COMMIT = "a".repeat(40);
const OTHER_COMMIT = "b".repeat(40);

function receipt(over: Partial<InstallReceipt> = {}): InstallReceipt {
  return {
    schema: 1,
    repo: CANONICAL_REPO,
    releaseTag: "v1.2.3",
    installedVersion: "1.2.3",
    installedCommit: COMMIT,
    sourceClone: "/Users/someone/.mission-control/app-src",
    appPath: USER_APP,
    installedAt: "2026-09-14T00:00:00.000Z",
    ...over,
  };
}

function classify(over: Partial<IdentityInputs> = {}) {
  return classifyInstallIdentity({
    runningBundle: USER_APP,
    runningCommit: COMMIT,
    receipt: receipt(),
    home: HOME,
    exists: () => true,
    bundleCommit: () => COMMIT,
    bundleVersion: () => "1.2.3",
    ...over,
  });
}

test("the app this receipt describes runs, and updates, exactly as before", () => {
  const identity = classify();
  assert.equal(identity.state, "managed");
  assert.equal(identityUpdateBlock(identity), null);
  // The system location is still an entirely ordinary place for a managed install to be.
  const system = classify({ runningBundle: SYSTEM_APP, receipt: receipt({ appPath: SYSTEM_APP }) });
  assert.equal(system.state, "managed");
  assert.equal(identityUpdateBlock(system), null);
  assert.equal(APP_BUNDLE_NAME, "Mission Control.app");
  assert.equal(SYSTEM_APP, "/Applications/Mission Control.app");
  assert.equal(USER_APP, "/Users/someone/Applications/Mission Control.app");
});

test("an app with no receipt is unmanaged, which is what it always was", () => {
  const identity = classify({ receipt: null });
  assert.equal(identity.state, "unmanaged");
  // The updater already reports "not installed with the managed install command" for this, and
  // this classification must not add a second, competing reason for the same state.
  assert.equal(identityUpdateBlock(identity), null);
});

test("a legacy receipt without an embedded commit is compared by version, not invalidated", () => {
  // `installedCommit` is optional and absent on every install made before it existed. Demanding
  // it would disable updates for exactly the historical installs this change has to keep working.
  const legacy = receipt({ installedCommit: undefined });
  assert.equal(bundleIdentityProblem(legacy, null, "1.2.3"), null);
  assert.equal(classify({ receipt: legacy, runningCommit: null }).state, "managed");
  assert.match(
    String(bundleIdentityProblem(legacy, null, "9.9.9")),
    /reports version 9\.9\.9 but the install receipt records 1\.2\.3/,
  );
  // With a commit recorded, the commit is what decides: a version match is not evidence that
  // this is the build that was installed.
  assert.match(String(bundleIdentityProblem(receipt(), OTHER_COMMIT, "1.2.3")), /bbbbbbb/);
  assert.match(String(bundleIdentityProblem(receipt(), null, "1.2.3")), /does not carry a source commit/);
});

test("a build swapped in at the receipt's own path runs without the updater", () => {
  // A developer install over a managed one, or a half-finished update. Redirecting would mean
  // opening this same bundle again, so the only safe answer is to keep running with updates off.
  const identity = classify({ runningCommit: OTHER_COMMIT, bundleCommit: () => OTHER_COMMIT });
  assert.equal(identity.state, "mismatched");
  assert.match(identityUpdateBlock(identity) ?? "", /Updates are disabled/);
  assert.match(identityUpdateBlock(identity) ?? "", /managed install command/);
});

test("the retained system copy hands a launch over to this account's personal app", () => {
  const identity = classify({ runningBundle: SYSTEM_APP });
  assert.equal(identity.state, "redirect");
  assert.equal(identity.state === "redirect" ? identity.target : null, USER_APP);
  // The source copy must not update anything either. If the hand-over fails it keeps running,
  // and it is emphatically not the bundle an update should swap.
  assert.match(identityUpdateBlock(identity) ?? "", /installed at .*Applications\/Mission Control\.app/);
});

test("only the exact system bundle may redirect, and only to the canonical personal one", () => {
  // Some third location holding a receipt for the personal app is a mismatch, not a launcher.
  const elsewhere = classify({ runningBundle: "/opt/Mission Control.app" });
  assert.equal(elsewhere.state, "mismatched");
  assert.match(elsewhere.state === "mismatched" ? elsewhere.reason : "", /\/opt\/Mission Control\.app/);

  // The receipt is a file in the state directory. Following it to an arbitrary path would make
  // it a way to have Mission Control open any bundle at all, so the destination is pinned to
  // this account's own canonical personal bundle and nothing else.
  const arbitrary = classify({
    runningBundle: SYSTEM_APP,
    receipt: receipt({ appPath: "/tmp/Anything.app" }),
  });
  assert.equal(arbitrary.state, "mismatched");
  assert.match(
    arbitrary.state === "mismatched" ? arbitrary.reason : "",
    /not this account's Mission Control/,
  );

  // Another account's personal app is somebody else's install, not a redirect target.
  const otherAccount = classify({
    runningBundle: SYSTEM_APP,
    receipt: receipt({ appPath: userAppPath("/Users/someone-else") }),
  });
  assert.equal(otherAccount.state, "mismatched");
});

test("a redirect target that is missing or is not the app in the receipt is refused", () => {
  const missing = classify({ runningBundle: SYSTEM_APP, exists: () => false });
  assert.equal(missing.state, "mismatched");
  assert.match(missing.state === "mismatched" ? missing.reason : "", /nothing is there/);
  assert.match(missing.state === "mismatched" ? missing.reason : "", /managed install command/);

  // Present, but not the build the receipt committed. Never adopted on the strength of sitting
  // at the right path.
  const impostor = classify({
    runningBundle: SYSTEM_APP,
    bundleCommit: () => OTHER_COMMIT,
    bundleVersion: () => "9.9.9",
  });
  assert.equal(impostor.state, "mismatched");
  assert.match(impostor.state === "mismatched" ? impostor.reason : "", /is not the app the install receipt describes/);
});

test("an untrusted repository disables the redirect as well as the update", () => {
  const forked = classify({
    runningBundle: SYSTEM_APP,
    receipt: receipt({ repo: "someone-else/mission-control" }),
  });
  assert.equal(forked.state, "mismatched");
  assert.match(forked.state === "mismatched" ? forked.reason : "", /someone-else\/mission-control/);
});

test("a receipt pointing at the running bundle can never produce a launch loop", () => {
  // Unreachable today - the two paths are different constants - and refused anyway, because a
  // later change that made them equal would otherwise produce an app that opens itself forever.
  const identity = classifyInstallIdentity({
    runningBundle: SYSTEM_APP,
    runningCommit: OTHER_COMMIT,
    receipt: receipt({ appPath: SYSTEM_APP }),
    home: HOME,
    exists: () => true,
    bundleCommit: () => OTHER_COMMIT,
    bundleVersion: () => "1.2.3",
  });
  assert.notEqual(identity.state, "redirect");
});
