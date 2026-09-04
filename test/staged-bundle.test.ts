// The token three processes use to agree that a staged bundle is still the staged bundle.
//
// The app pins it when the build is verified, the detached helper forwards it, and the install
// script checks it in the instant before the swap. One formula, because a disagreement between
// any two of them would either install a bundle nobody verified or refuse one that is fine.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stagedBundleRevision, stagedRevisionProblem } from "../src/shared/staged-bundle.mjs";

test("a bundle's revision follows the directory, not its contents' names", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mission-staged-revision-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bundle = join(root, "Mission Control.app");
  mkdirSync(join(bundle, "Contents"), { recursive: true });
  writeFileSync(join(bundle, "Contents", "Info.plist"), "<plist/>", "utf8");

  const first = stagedBundleRevision(statSync(bundle));
  assert.match(String(first), /^\d+-\d+(\.\d+)?$/);
  // Reading it again changes nothing: a bundle left alone keeps its identity, which is what
  // makes a deferred update installable minutes later without rebuilding.
  assert.equal(stagedBundleRevision(statSync(bundle)), first);

  // A rebuild is a new directory at the same path - the shape `npm run package` produces - and
  // that has to read as a different bundle even when the version inside it is identical.
  rmSync(bundle, { recursive: true, force: true });
  mkdirSync(join(bundle, "Contents"), { recursive: true });
  writeFileSync(join(bundle, "Contents", "Info.plist"), "<plist/>", "utf8");
  assert.notEqual(stagedBundleRevision(statSync(bundle)), first);

  // Nothing at the path at all.
  assert.equal(stagedBundleRevision(statSync(join(root, "Gone.app"), { throwIfNoEntry: false })), null);
  assert.equal(stagedBundleRevision(null), null);
  assert.equal(stagedBundleRevision(undefined), null);
  // A stat-shaped object missing what identifies it is refused rather than stringified.
  assert.equal(stagedBundleRevision({} as never), null);
});

test("a bundle is refused when it is not the one that was pinned", () => {
  assert.equal(stagedRevisionProblem({ expected: "11-22", found: "11-22" }), null);
  assert.match(
    String(stagedRevisionProblem({ expected: "11-22", found: "11-23" })),
    /replaced after it was prepared/,
  );
  assert.match(
    String(stagedRevisionProblem({ expected: "11-22", found: null })),
    /could not be identified/,
  );
  // No pin means nobody claimed this bundle: an install driven by hand, or a handoff from an app
  // that predates the pin. Both must still work, so there is nothing to compare and nothing to
  // refuse - the same latitude the version check gives a ref that names no version.
  assert.equal(stagedRevisionProblem({ expected: null, found: "11-22" }), null);
  assert.equal(stagedRevisionProblem({ expected: undefined, found: null }), null);
});
