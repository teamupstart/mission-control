#!/usr/bin/env node
// Remove the private temp roots of test processes that died without cleaning up.
//
// Runs before every `npm test` and `npm run test:electron`, and on its own as
// `npm run test:sweep-temp`. Only roots whose owner is provably dead (pid and start time) and
// that have not changed for the threshold are removed; a live owner, a root with no marker, a
// symlink, and anything that does not resolve to itself under the temp dir are left alone.
// It also takes back the node-compile-cache the npm running it created there at startup.
// See docs/test-temp-dirs.md.
//
//   node scripts/sweep-test-temp.mjs [--dry-run] [--verbose] [--min-age-minutes N] [--tmp DIR]

import { parseArgs } from "node:util";
import { DEFAULT_SWEEP_MIN_AGE_MS, releaseNpmCompileCache, sweepTempRoots, systemTempDir } from "../test/temp-root.mjs";

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
    "min-age-minutes": { type: "string" },
    tmp: { type: "string" },
  },
});

const minutes = values["min-age-minutes"] ?? process.env.MISSION_TEST_TEMP_SWEEP_MIN_AGE_MINUTES;
const minAgeMs = minutes === undefined ? DEFAULT_SWEEP_MIN_AGE_MS : Number(minutes) * 60_000;
if (!Number.isFinite(minAgeMs) || minAgeMs < 0) {
  console.error(`sweep-test-temp: --min-age-minutes must be a non-negative number, got ${minutes}`);
  process.exit(2);
}

const tmp = values.tmp ?? systemTempDir();
const { removed, kept } = sweepTempRoots({ tmp, minAgeMs, dryRun: values["dry-run"] });
const verb = values["dry-run"] ? "would remove" : "removed";
if (removed.length > 0 || values.verbose) {
  console.log(`sweep-test-temp: ${verb} ${removed.length} dead test temp root(s) in ${tmp}; kept ${kept.length}`);
}
// npm's own startup cache, created in the temp dir before this script ran; see
// `releaseNpmCompileCache`. Not in a dry run.
const releasedCache = !values["dry-run"] && releaseNpmCompileCache({ tmp });
if (values.verbose) {
  if (releasedCache) console.log(`  removed the node-compile-cache this npm run created in ${tmp}`);
  for (const path of removed) console.log(`  ${verb} ${path}`);
  for (const { path, reason } of kept) console.log(`  kept ${path}: ${reason}`);
}
